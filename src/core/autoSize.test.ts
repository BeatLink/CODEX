import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { autoSize, chooseSizes, modelShape, readGgufMetadata, type ModelShape } from './autoSize.js';

// ============================================================================
// Helpers
// ============================================================================

const MIB = 1024 * 1024;

type Entry = [key: string, valueType: number, value: number | string | string[]];

function uint32(value: number): Buffer {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value);
    return buffer;
}

function uint64(value: number): Buffer {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(BigInt(value));
    return buffer;
}

function ggufString(text: string): Buffer {
    const data = Buffer.from(text, 'utf8');
    return Buffer.concat([uint64(data.length), data]);
}

function writeGguf(path: string, entries: Entry[]): void {
    const parts = [Buffer.from('GGUF'), uint32(3), uint64(0), uint64(entries.length)];
    for (const [key, valueType, value] of entries) {
        parts.push(ggufString(key), uint32(valueType));
        if (valueType === 8) {
            parts.push(ggufString(value as string));
        } else if (valueType === 9) {
            const items = value as string[];
            parts.push(uint32(8), uint64(items.length), ...items.map(ggufString));
        } else {
            parts.push(uint32(value as number));
        }
    }
    writeFileSync(path, Buffer.concat(parts));
}

function shape(name: string, trainedContext: number, fileBytes: number, bytesPerToken: number): ModelShape {
    return { name, trained_context: trainedContext, file_bytes: fileBytes, bytes_per_token: bytesPerToken };
}

let directory: string;

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'codex-auto-size-'));
});

afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
});

// ============================================================================
// Model shape
// ============================================================================

describe('model shape', () => {
    it('reads a hybrid attention shape and skips long arrays', () => {
        const path = join(directory, 'model.gguf');
        writeGguf(path, [
            ['general.architecture', 8, 'qwen35'],
            ['general.name', 8, 'Tiny'],
            ['tokenizer.ggml.tokens', 9, Array.from({ length: 2000 }, (_, index) => `t${index}`)],
            ['qwen35.block_count', 4, 32],
            ['qwen35.context_length', 4, 262144],
            ['qwen35.embedding_length', 4, 2560],
            ['qwen35.attention.head_count', 4, 16],
            ['qwen35.attention.head_count_kv', 4, 4],
            ['qwen35.attention.key_length', 4, 256],
            ['qwen35.attention.value_length', 4, 256],
            ['qwen35.full_attention_interval', 4, 4],
        ]);

        const metadata = readGgufMetadata(path);
        const found = modelShape(path);

        expect(metadata['tokenizer.ggml.tokens']).toBe(2000);
        expect(found.name).toBe('Tiny');
        expect(found.trained_context).toBe(262144);
        // Eight cached layers of four heads and 512 values at two bytes each, plus the 512-token attention scratch.
        expect(found.bytes_per_token).toBe(8 * 4 * 512 * 2 + 512 * 16 * 4);
    });

    it('rejects a file that is not GGUF', () => {
        const path = join(directory, 'model.bin');
        writeFileSync(path, 'nope');

        expect(() => modelShape(path)).toThrow('is not a GGUF model file');
    });
});

// ============================================================================
// Choosing sizes
// ============================================================================

describe('choosing sizes', () => {
    const tiny = shape('Tiny', 262144, 2187 * MIB, 64 * 1024);

    it('fits the context into free GPU memory', () => {
        const choice = chooseSizes(tiny, 4096 * MIB, 9000 * MIB, -1);

        expect(choice.context_size).toBe(21504);
        expect([choice.max_tokens, choice.background_max_tokens]).toEqual([5376, 2688]);
        expect(choice.explanation).toContain('GPU');
    });

    it('matches the contexts that ran on a 4 GB GPU', () => {
        // With a full window, the Q4_K_XL file runs at 6144 and aborts at 7168, and Q3_K_M runs at 15360.
        const q4KXl = shape('Qwen3.5-4B UD-Q4_K_XL', 262144, 2_912_109_728, 64 * 1024);
        const q3KM = shape('Qwen3.5-4B Q3_K_M', 262144, 2_293_388_448, 64 * 1024);

        expect(chooseSizes(q4KXl, 3760 * MIB, null, -1).context_size).toBe(6144);
        expect(chooseSizes(q3KM, 3760 * MIB, null, -1).context_size).toBe(15360);
    });

    it('counts the loaded model as free', () => {
        const busy = chooseSizes(tiny, 1078 * MIB, null, -1);
        const reclaimed = chooseSizes(tiny, 1078 * MIB, null, -1, 4096);

        expect(busy.context_size).toBe(2048);
        expect(busy.explanation).toContain('lower GPU layers');
        expect(reclaimed.context_size).toBeGreaterThan(8192);
    });

    it('caps the context on the CPU and at the trained length', () => {
        const short = shape('Short', 8192, 2187 * MIB, 64 * 1024);

        expect(chooseSizes(tiny, null, 64000 * MIB, -1).context_size).toBe(32768);
        expect(chooseSizes(short, null, 64000 * MIB, 0).context_size).toBe(8192);
    });
});

// ============================================================================
// The machine
// ============================================================================

describe('auto size', () => {
    let savedPath: string | undefined;

    beforeEach(() => {
        savedPath = process.env.PATH;
    });

    afterEach(() => {
        process.env.PATH = savedPath;
    });

    it('refuses when the GPU is present but unreadable', async () => {
        const modelPath = join(directory, 'model.gguf');
        writeGguf(modelPath, [['general.architecture', 8, 'tiny'], ['tiny.block_count', 4, 4]]);
        // A stand-in nvidia-smi that crashes is the only one on the search path.
        const fakeSmi = join(directory, 'nvidia-smi');
        writeFileSync(fakeSmi, '#!/bin/sh\nexit 1\n');
        chmodSync(fakeSmi, 0o755);
        process.env.PATH = directory;

        await expect(autoSize(modelPath, -1)).rejects.toThrow('GPU layers to 0');
        expect((await autoSize(modelPath, 0)).explanation).toContain('RAM');
    });
});
