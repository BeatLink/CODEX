import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakeModel = vi.hoisted(() => {
    const getEmbeddingFor = vi.fn(async (_text: string) => ({ vector: [3.0, 4.0] }));
    const createEmbeddingContext = vi.fn(async (_options: unknown) => ({ getEmbeddingFor, dispose: async () => undefined }));
    const loadGgufModel = vi.fn(async (_path: string, _gpuLayers: number) => ({
        llama: {},
        model: { createEmbeddingContext },
        release: () => undefined,
    }));
    return { getEmbeddingFor, createEmbeddingContext, loadGgufModel };
});

vi.mock('./model.js', () => ({ loadGgufModel: fakeModel.loadGgufModel }));

import { EMBEDDING_CONTEXT_SIZE, EMBEDDING_THREADS, Embedder, QUERY_INSTRUCTION, normalize, pack, type TextEmbedder } from './embeddings.js';
import { KnowledgeStore, fuseRankings } from './knowledge.js';


// ============================================================================
// Fake embedder
// ============================================================================

// Words that mean the same thing share a dimension, so the fake model understands paraphrases.
const CONCEPTS: Record<string, number> = {
    fastapi: 0, api: 0, web: 0,
    endpoints: 1, handlers: 1, requests: 1,
    async: 2, blocking: 2, event: 2, loop: 2,
    cargo: 3, crates: 3, rust: 3,
    bm25: 4, ranking: 4, fts5: 4, search: 4,
};

class FakeEmbedder implements TextEmbedder {
    readonly name = 'fake.gguf';
    readonly documents: string[] = [];

    constructor(private readonly fail = false) {}

    vector(text: string): number[] {
        const vector = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        for (const word of text.toLowerCase().match(/\w+/g) ?? []) {
            const known = word in CONCEPTS;
            vector[known ? CONCEPTS[word] : 5] += known ? 1.0 : 0.1;
        }
        return normalize(vector);
    }

    async embedDocuments(texts: string[]): Promise<number[][]> {
        this.documents.push(...texts);
        return texts.map((text) => this.vector(text));
    }

    async embedQuery(text: string): Promise<number[]> {
        if (this.fail) {
            throw new Error('model will not load');
        }
        return this.vector(text);
    }
}

// ============================================================================
// Retrieval by meaning
// ============================================================================

describe('embedding retrieval', () => {
    let directory: string;
    let databasePath: string;
    let embedder: FakeEmbedder;
    let store: KnowledgeStore;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), 'codex-embeddings-'));
        databasePath = join(directory, 'knowledge.db');
        embedder = new FakeEmbedder();
        store = new KnowledgeStore(databasePath, embedder);
    });

    afterEach(() => {
        rmSync(directory, { recursive: true, force: true });
    });

    async function indexEverything(): Promise<void> {
        const items = store.itemsToEmbed(embedder.name, 100);
        store.saveEmbeddings(embedder.name, items, await embedder.embedDocuments(items.map(([, , body]) => body)));
    }

    it('keeps the embedder when sqlite-vec loads', () => {
        expect(store.embedder).toBe(embedder);
    });

    it('finds a fact sharing no words with the request by meaning', async () => {
        store.addFact('Web frameworks', 'FastAPI runs async endpoints on the event loop.');
        store.addFact('Rust', 'Cargo builds crates.');
        await indexEverything();

        const recalled = await store.recall("How do I keep my web API's request handlers from blocking?");

        expect(recalled.facts.map((fact) => fact.statement)).toEqual(['FastAPI runs async endpoints on the event loop.']);
    });

    it('stays lexical without a working model', async () => {
        store.addFact('Rust', 'Cargo builds crates.');
        await indexEverything();
        const failingStore = new KnowledgeStore(databasePath, new FakeEmbedder(true));

        expect((await failingStore.recall('cargo crates')).facts.map((fact) => fact.statement)).toEqual(['Cargo builds crates.']);
        expect((await failingStore.recall('How do I package a library?')).facts).toEqual([]);
    });

    it('enters a branch by meaning when no topic is named', async () => {
        store.addTopic('Full-text search');
        store.setTopicSummary('Full-text search', 'fts5 bm25 ranking search');
        store.addFact('Full-text search', 'Tokenizers split text into words.');
        await indexEverything();

        const recalled = await store.recall('Which ranking does sqlite search use?');

        expect(recalled.facts.map((fact) => fact.statement)).toContain('Tokenizers split text into words.');
    });

    it('embeds again only new or changed items', async () => {
        store.addFact('Rust', 'Cargo builds crates.');
        await indexEverything();
        expect(store.itemsToEmbed(embedder.name, 100)).toEqual([]);

        store.setTopicSummary('Rust', 'A systems language.');

        expect(store.itemsToEmbed(embedder.name, 100).map(([kind, , body]) => [kind, body])).toEqual([['topic', 'Rust: A systems language.']]);
        expect(store.itemsToEmbed('another.gguf', 100)).toHaveLength(2);
    });

    it('leaves no vectors behind for merged facts and topics', async () => {
        const first = store.addFact('Rust', 'Cargo builds crates.');
        const second = store.addFact('Rust', 'Cargo builds Rust crates.');
        store.addFact('Rust language', 'Rust has no garbage collector.');
        await indexEverything();

        store.mergeFacts(first, second);
        const topicIds = Object.fromEntries(store.topics().map((topic) => [topic.name, topic.id]));
        store.mergeTopics(topicIds['Rust'], topicIds['Rust language']);

        const database = new DatabaseSync(databasePath);
        const vectors = database.prepare('SELECT kind, COUNT(*) AS count FROM embeddings GROUP BY kind').all();
        database.close();
        expect(Object.fromEntries(vectors.map((row) => [row.kind, row.count]))).toEqual({ fact: 2, topic: 1 });
    });

    it('compares facts worded differently but alike in meaning', async () => {
        store.addFact('Web frameworks', 'FastAPI endpoints use async.');
        store.addFact('Web frameworks', 'Web API handlers never block the event loop.');
        store.addFact('Rust', 'Web API handlers never block the event loop in Rust.');
        expect(store.nextUncheckedPair('fact')).toBeNull();
        await indexEverything();

        const [first, second] = store.nextUncheckedPair('fact')!;

        expect(new Set([first.statement, second.statement])).toEqual(
            new Set(['FastAPI endpoints use async.', 'Web API handlers never block the event loop.']),
        );
        store.recordCheck('fact', first.id, second.id, 'different');
        expect(store.nextUncheckedPair('fact')).toBeNull();
    });

    it('fuses rankings so an item high in either comes first', () => {
        expect(fuseRankings([1, 2, 3], [3, 4])).toEqual([3, 1, 2, 4]);
    });
});

// ============================================================================
// Embedder
// ============================================================================

describe('Embedder', () => {
    beforeEach(() => {
        fakeModel.loadGgufModel.mockClear();
        fakeModel.createEmbeddingContext.mockClear();
        fakeModel.getEmbeddingFor.mockClear();
    });

    it('loads the model on the CPU with a small context and few threads', async () => {
        const embedder = new Embedder('embedding.gguf');

        await embedder.embedDocuments(['cargo']);

        expect(fakeModel.loadGgufModel.mock.calls[0][1]).toBe(0);
        expect(fakeModel.createEmbeddingContext).toHaveBeenCalledWith({ contextSize: EMBEDDING_CONTEXT_SIZE, threads: EMBEDDING_THREADS });
        expect(embedder.name).toBe('embedding.gguf');
    });

    it('embeds a repeated query once', async () => {
        const embedder = new Embedder('unused.gguf');

        expect(await embedder.embedQuery('cargo')).toEqual([0.6, 0.8]);
        expect(await embedder.embedQuery('cargo')).toEqual([0.6, 0.8]);

        expect(fakeModel.getEmbeddingFor).toHaveBeenCalledTimes(1);
        expect(fakeModel.getEmbeddingFor).toHaveBeenCalledWith(QUERY_INSTRUCTION + 'cargo');
        expect(fakeModel.loadGgufModel).toHaveBeenCalledTimes(1);
    });

    it('packs a vector as little-endian float32', () => {
        expect(Array.from(pack([1.0, -2.5]))).toEqual([0, 0, 128, 63, 0, 0, 32, 192]);
    });
});
