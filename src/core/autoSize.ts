// Pick a context size and reply limits that fit the model file and this machine's memory.
import { execFile } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, openSync, readSync, statSync } from 'node:fs';
import { freemem } from 'node:os';
import { delimiter, join, parse } from 'node:path';
import { promisify } from 'node:util';

import { expandUser } from './settings.js';

export const GGUF_MAGIC = 'GGUF';

// Byte size and reader for each GGUF scalar type code.
type ScalarFormat = { size: number; read: (buffer: Buffer, offset: number) => number | boolean };

export const GGUF_SCALAR_FORMATS: Readonly<Record<number, ScalarFormat>> = Object.freeze({
    0: { size: 1, read: (buffer, offset) => buffer.readUInt8(offset) },
    1: { size: 1, read: (buffer, offset) => buffer.readInt8(offset) },
    2: { size: 2, read: (buffer, offset) => buffer.readUInt16LE(offset) },
    3: { size: 2, read: (buffer, offset) => buffer.readInt16LE(offset) },
    4: { size: 4, read: (buffer, offset) => buffer.readUInt32LE(offset) },
    5: { size: 4, read: (buffer, offset) => buffer.readInt32LE(offset) },
    6: { size: 4, read: (buffer, offset) => buffer.readFloatLE(offset) },
    7: { size: 1, read: (buffer, offset) => buffer.readUInt8(offset) !== 0 },
    10: { size: 8, read: (buffer, offset) => Number(buffer.readBigUInt64LE(offset)) },
    11: { size: 8, read: (buffer, offset) => Number(buffer.readBigInt64LE(offset)) },
    12: { size: 8, read: (buffer, offset) => buffer.readDoubleLE(offset) },
});
export const GGUF_STRING = 8;
export const GGUF_ARRAY = 9;

// Tokens llama.cpp processes per batch, which sizes its attention scratch buffer.
export const BATCH_TOKENS = 512;

// Memory the runtime needs beyond the weights and the per-token cache, fitted to what a 4 GB GPU could hold.
export const FIXED_RESERVE_BYTES = 560 * 1024 * 1024;

// Small models lose track of long inputs and every stage re-reads its whole input, so stop here.
export const MAX_AUTO_CONTEXT = 32_768;
export const MIN_AUTO_CONTEXT = 2_048;
export const CONTEXT_STEP = 1_024;

// ============================================================================
// Reading the model file
// ============================================================================

export type GgufValue = string | number | boolean | GgufValue[];

// Reads a file front to back through a buffer, so a header with a large vocabulary is not read one value per system call.
class FileReader {
    private buffer = Buffer.alloc(0);
    private offset = 0;
    private position = 0;

    constructor(private readonly descriptor: number) {}

    read(size: number): Buffer {
        if (this.buffer.length - this.offset < size) {
            const chunk = Buffer.alloc(Math.max(size, 1 << 20));
            const rest = this.buffer.subarray(this.offset);
            rest.copy(chunk);
            const got = readSync(this.descriptor, chunk, rest.length, chunk.length - rest.length, this.position);
            this.position += got;
            this.buffer = chunk.subarray(0, rest.length + got);
            this.offset = 0;
        }
        if (this.buffer.length - this.offset < size) {
            throw new Error('The GGUF header ends early.');
        }
        const bytes = this.buffer.subarray(this.offset, this.offset + size);
        this.offset += size;
        return bytes;
    }

    scalar(valueType: number): number | boolean {
        const format = GGUF_SCALAR_FORMATS[valueType];
        return format.read(this.read(format.size), 0);
    }

    string(): string {
        return this.read(this.scalar(10) as number).toString('utf8');
    }
}

function readValue(reader: FileReader, valueType: number): GgufValue {
    if (valueType === GGUF_STRING) {
        return reader.string();
    }
    if (valueType === GGUF_ARRAY) {
        const itemType = reader.scalar(4) as number;
        const length = reader.scalar(10) as number;
        // Tokenizer vocabularies run to six figures; only short arrays such as per-layer counts are kept.
        if (length > 1024) {
            for (let index = 0; index < length; index++) {
                readValue(reader, itemType);
            }
            return length;
        }
        return Array.from({ length }, () => readValue(reader, itemType));
    }
    if (!(valueType in GGUF_SCALAR_FORMATS)) {
        throw new Error(`Unknown GGUF value type ${valueType}.`);
    }
    return reader.scalar(valueType);
}

// Read the GGUF header's key-value metadata, keeping only the length of long arrays.
export function readGgufMetadata(modelPath: string): Record<string, GgufValue> {
    const descriptor = openSync(expandUser(modelPath), 'r');
    try {
        const reader = new FileReader(descriptor);
        let magic: string;
        try {
            magic = reader.read(4).toString('latin1');
        } catch {
            magic = '';
        }
        if (magic !== GGUF_MAGIC) {
            throw new Error(`${modelPath} is not a GGUF model file.`);
        }
        reader.scalar(4);
        reader.scalar(10);
        const entryCount = reader.scalar(10) as number;
        const metadata: Record<string, GgufValue> = {};
        for (let index = 0; index < entryCount; index++) {
            const key = reader.string();
            metadata[key] = readValue(reader, reader.scalar(4) as number);
        }
        return metadata;
    } finally {
        closeSync(descriptor);
    }
}

// The model's size and how much memory each token of context costs: its key-value cache plus the attention scratch buffer.
export type ModelShape = {
    name: string;
    trained_context: number;
    file_bytes: number;
    bytes_per_token: number;
};

export function modelShape(modelPath: string): ModelShape {
    const metadata = readGgufMetadata(modelPath);
    const architecture = String(metadata['general.architecture'] ?? '');

    const number = (key: string, fallback = 0): number => {
        const value = metadata[`${architecture}.${key}`] ?? fallback;
        // Some models list a count per layer; the largest one bounds the cost.
        if (Array.isArray(value)) {
            return value.length > 0 ? Math.max(...value.map(Number)) : fallback;
        }
        return Math.trunc(Number(value || fallback));
    };

    const layers = number('block_count');
    const heads = number('attention.head_count', 1);
    const keyValueHeads = number('attention.head_count_kv', heads);
    const headSize = Math.floor(number('embedding_length') / Math.max(1, heads));
    const keySize = number('attention.key_length', headSize);
    const valueSize = number('attention.value_length', headSize);
    // Hybrid models keep a cache only on every n-th layer; the rest hold a fixed-size state.
    const interval = number('full_attention_interval', 1);
    const attentionLayers = Math.max(1, Math.floor(layers / Math.max(1, interval)));

    const cacheBytes = attentionLayers * keyValueHeads * (keySize + valueSize) * 2;
    const scratchBytes = BATCH_TOKENS * heads * 4;
    return {
        name: String(metadata['general.name'] || parse(modelPath).name),
        trained_context: number('context_length', MIN_AUTO_CONTEXT),
        file_bytes: statSync(expandUser(modelPath)).size,
        bytes_per_token: cacheBytes + scratchBytes,
    };
}

// ============================================================================
// Reading the machine
// ============================================================================

const runFile = promisify(execFile);

// Return the full path of a command on the search path, or null when there is none.
function findCommand(command: string): string | null {
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
        if (!directory) {
            continue;
        }
        const candidate = join(directory, command);
        try {
            accessSync(candidate, constants.X_OK);
            if (statSync(candidate).isFile()) {
                return candidate;
            }
        } catch {
            continue;
        }
    }
    return null;
}

// Return the free memory on the first NVIDIA GPU, or null when there is no GPU.
export async function freeGpuBytes(): Promise<number | null> {
    const gpuPresent = existsSync('/proc/driver/nvidia') || existsSync('/dev/nvidia0');
    const command = findCommand('nvidia-smi');
    if (command === null) {
        if (gpuPresent) {
            throw new Error('An NVIDIA GPU is present but nvidia-smi is missing, so its free memory is unknown.');
        }
        return null;
    }
    try {
        const { stdout } = await runFile(command, ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { timeout: 10_000 });
        const first = stdout.split(/\s+/).filter(Boolean)[0];
        if (first === undefined || !/^[+-]?\d+$/.test(first)) {
            throw new Error(`nvidia-smi printed no free memory: ${JSON.stringify(stdout.trim())}`);
        }
        return Number(first) * 1024 * 1024;
    } catch (error) {
        // Sizing for RAM instead would pick a context the GPU cannot hold.
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not read free GPU memory from nvidia-smi (${reason}); set GPU layers to 0 to size for RAM.`, { cause: error });
    }
}

// Return the memory the system could hand out now, which Node reads from MemAvailable on Linux.
export function availableRamBytes(): number | null {
    const available = freemem();
    return available > 0 ? available : null;
}

// ============================================================================
// Choosing the limits
// ============================================================================

export type SizeChoice = {
    context_size: number;
    max_tokens: number;
    background_max_tokens: number;
    explanation: string;
};

// Fit the largest sensible context into free memory, then split it between input and reply; a loaded context counts this model's own memory as free.
export function chooseSizes(
    shape: ModelShape,
    gpuFree: number | null,
    ramFree: number | null,
    gpuLayers: number,
    loadedContext: number | null = null,
): SizeChoice {
    const reclaimed = loadedContext ? shape.file_bytes + shape.bytes_per_token * loadedContext + FIXED_RESERVE_BYTES : 0;
    const onGpu = gpuLayers !== 0 && gpuFree !== null;
    const device = onGpu ? 'GPU' : 'RAM';
    let free = onGpu ? gpuFree : ramFree;
    if (free === null) {
        free = shape.file_bytes + shape.bytes_per_token * MIN_AUTO_CONTEXT + FIXED_RESERVE_BYTES;
    }
    free += reclaimed;

    const spare = free - shape.file_bytes - FIXED_RESERVE_BYTES;
    const fits = Math.floor(Math.max(0, spare) / shape.bytes_per_token);
    const limit = Math.min(fits, shape.trained_context, MAX_AUTO_CONTEXT);
    const contextSize = Math.max(MIN_AUTO_CONTEXT, Math.floor(limit / CONTEXT_STEP) * CONTEXT_STEP);

    // A quarter of the window for the reply leaves three quarters for the request and evidence.
    const maxTokens = Math.max(512, Math.min(8_192, Math.floor(contextSize / 4)));
    // Background calls hold the model lock, so their replies are kept shorter.
    const backgroundMaxTokens = Math.max(256, Math.min(4_096, Math.floor(contextSize / 8)));

    let explanation =
        `${shape.name}: ${(shape.file_bytes / 2 ** 30).toFixed(1)} GiB of weights,` +
        ` ${(shape.bytes_per_token / 1024).toFixed(0)} KiB per context token,` +
        ` ${(free / 2 ** 30).toFixed(1)} GiB free ${device}`;
    if (contextSize > fits) {
        explanation += onGpu
            ? '; even the smallest context may not fit, so lower GPU layers or close other GPU programs'
            : '; even the smallest context may not fit';
    }
    return { context_size: contextSize, max_tokens: maxTokens, background_max_tokens: backgroundMaxTokens, explanation };
}

export async function autoSize(modelPath: string, gpuLayers: number, loadedContext: number | null = null): Promise<SizeChoice> {
    const gpuFree = gpuLayers !== 0 ? await freeGpuBytes() : null;
    return chooseSizes(modelShape(modelPath), gpuFree, availableRamBytes(), gpuLayers, loadedContext);
}
