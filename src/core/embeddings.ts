// Turns text into vectors with a small embedding model run on the CPU, so stored knowledge is found by meaning.

import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import type { LlamaEmbeddingContext } from 'node-llama-cpp';
import { loadGgufModel } from './model.js';

// ============================================================================
// Settings
// ============================================================================

// Qwen3 embedding models expect a task instruction before a query, and nothing before a document.
export const QUERY_INSTRUCTION = 'Instruct: Given a question, retrieve stored facts and topics that help answer it\nQuery:';

// Facts and topic summaries are short, so a small window keeps the model's memory use low.
export const EMBEDDING_CONTEXT_SIZE = 2048;

// Characters kept from one text, well inside the window.
export const MAX_TEXT_CHARS = 4000;

// Threads for the embedding model; a busy machine slows it far more with many threads than with few.
export const EMBEDDING_THREADS = 2;

// Query vectors kept, since one request looks up the same words for several of its tasks.
export const QUERY_CACHE_SIZE = 64;

// ============================================================================
// Embedder
// ============================================================================

// What the knowledge store needs from an embedding model, so tests can pass a fake one.
export interface TextEmbedder {
    readonly name: string;
    embedDocuments(texts: string[]): Promise<number[][]>;
    embedQuery(text: string): Promise<number[]>;
}

// One embedding model, loaded on first use and used by one caller at a time.
export class Embedder implements TextEmbedder {
    readonly modelPath: string;
    readonly name: string;
    private context: Promise<LlamaEmbeddingContext> | null = null;
    private queue: Promise<unknown> = Promise.resolve();
    private readonly queryCache = new Map<string, number[]>();

    constructor(modelPath: string) {
        this.modelPath = modelPath;
        this.name = basename(resolvedPath(modelPath));
    }

    async embedDocuments(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) {
            return [];
        }
        return this.inTurn(async () => {
            const context = await this.load();
            const vectors: number[][] = [];
            for (const text of texts) {
                vectors.push(normalize(Array.from((await context.getEmbeddingFor(firstChars(text, MAX_TEXT_CHARS))).vector)));
            }
            return vectors;
        });
    }

    async embedQuery(text: string): Promise<number[]> {
        const query = firstChars(text, MAX_TEXT_CHARS);
        return this.inTurn(async () => {
            const cached = this.queryCache.get(query);
            if (cached) {
                return cached;
            }
            if (this.queryCache.size >= QUERY_CACHE_SIZE) {
                this.queryCache.delete(this.queryCache.keys().next().value as string);
            }
            const context = await this.load();
            const vector = normalize(Array.from((await context.getEmbeddingFor(QUERY_INSTRUCTION + query)).vector));
            this.queryCache.set(query, vector);
            return vector;
        });
    }

    async close(): Promise<void> {
        await this.queue;
        if (this.context) {
            const context = await this.context.catch(() => null);
            this.context = null;
            await context?.dispose();
        }
    }

    private load(): Promise<LlamaEmbeddingContext> {
        if (!this.context) {
            // The GPU is left to the chat model; embedding a few short texts is quick on the CPU.
            this.context = loadGgufModel(this.modelPath, 0).then(({ model }) =>
                model.createEmbeddingContext({ contextSize: EMBEDDING_CONTEXT_SIZE, threads: EMBEDDING_THREADS }),
            );
            // A model that failed to load is tried again on the next call.
            this.context.catch(() => {
                this.context = null;
            });
        }
        return this.context;
    }

    private inTurn<T>(work: () => Promise<T>): Promise<T> {
        const turn = this.queue.then(work);
        this.queue = turn.catch(() => undefined);
        return turn;
    }
}

// ============================================================================
// Shared embedders
// ============================================================================

const embedders = new Map<string, Embedder>();

// Returns the shared embedder for a model file, or null when no file is configured or it is missing.
export function getEmbedder(modelPath: string): Embedder | null {
    if (!modelPath || !isFile(expandUser(modelPath))) {
        return null;
    }
    const path = resolvedPath(modelPath);
    let embedder = embedders.get(path);
    if (!embedder) {
        embedder = new Embedder(path);
        embedders.set(path, embedder);
    }
    return embedder;
}

// ============================================================================
// Vectors
// ============================================================================

export function normalize(vector: number[]): number[] {
    const length = Math.sqrt(vector.reduce((total, value) => total + value * value, 0)) || 1.0;
    return vector.map((value) => value / length);
}

// Stores a vector as the little-endian float32 blob sqlite-vec reads.
export function pack(vector: number[]): Uint8Array {
    const bytes = new Uint8Array(4 * vector.length);
    const view = new DataView(bytes.buffer);
    vector.forEach((value, index) => view.setFloat32(4 * index, value, true));
    return bytes;
}

// ============================================================================
// Helpers
// ============================================================================

function expandUser(path: string): string {
    return path === '~' || path.startsWith('~/') ? homedir() + path.slice(1) : path;
}

function resolvedPath(path: string): string {
    const absolute = resolve(expandUser(path));
    return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

function isFile(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

// Keeps the first characters of a text, counting each character once even outside the basic plane.
function firstChars(text: string, maximum: number): string {
    return text.length <= maximum ? text : Array.from(text).slice(0, maximum).join('');
}
