import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
    runStage: vi.fn(),
    loadModel: vi.fn(),
    toolCall: vi.fn(),
    summarizeWebPage: vi.fn(),
    getEmbedder: vi.fn(),
}));

vi.mock('./model.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./model.js')>()),
    runStage: fakes.runStage,
    LocalModel: { load: fakes.loadModel },
}));

vi.mock('./tools.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./tools.js')>()),
    Toolbox: class {
        call(name: string, argumentsGiven: Record<string, unknown>): Promise<string> {
            return fakes.toolCall(name, argumentsGiven);
        }
    },
}));

vi.mock('./evidence.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./evidence.js')>()),
    summarizeWebPage: fakes.summarizeWebPage,
}));

vi.mock('./embeddings.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./embeddings.js')>()),
    getEmbedder: fakes.getEmbedder,
}));

import {
    completeSentences,
    groundedFacts,
    groundedSummary,
    indexKnowledge,
    learnFromEpisodes,
    parseOverview,
    researchOneTopic,
    type Source,
} from './background.js';
import { normalize, type TextEmbedder } from './embeddings.js';
import { KnowledgeStore } from './knowledge.js';
import type { ChatModel, ModelCache } from './model.js';
import { DEFAULT_SETTINGS, type Settings } from './settings.js';

// ============================================================================
// Helpers
// ============================================================================

const realEvidence = await vi.importActual<typeof import('./evidence.js')>('./evidence.js');
const realEmbeddings = await vi.importActual<typeof import('./embeddings.js')>('./embeddings.js');

let directory: string;
let settings: Settings;
let store: KnowledgeStore;
const llm = {} as ChatModel;

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'codex-background-'));
    settings = { ...DEFAULT_SETTINGS, knowledge_db_path: join(directory, 'knowledge.db'), filesystem_root: directory };
    store = new KnowledgeStore(settings.knowledge_db_path);
    fakes.runStage.mockReset();
    fakes.loadModel.mockReset();
    fakes.toolCall.mockReset();
    // Page summaries run as they really do unless a test says otherwise.
    fakes.summarizeWebPage.mockReset().mockImplementation(realEvidence.summarizeWebPage);
    fakes.getEmbedder.mockReset().mockImplementation(realEmbeddings.getEmbedder);
});

afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
});

function queryOne(sql: string): Record<string, unknown> {
    const database = new DatabaseSync(settings.knowledge_db_path);
    try {
        return database.prepare(sql).get() as Record<string, unknown>;
    } finally {
        database.close();
    }
}

// Replies to the model calls in order, failing a test that makes more calls than it expects.
function replyWith(...replies: string[]): void {
    const answers = [...replies];
    fakes.runStage.mockImplementation(async () => {
        if (answers.length === 0) {
            throw new Error('No reply left for this model call.');
        }
        return answers.shift()!;
    });
}

function searchReturns(results: Array<Record<string, string>>): void {
    fakes.toolCall.mockResolvedValue(JSON.stringify(results));
}

// ============================================================================
// Background research
// ============================================================================

describe('background research', () => {
    it('saves search evidence, a summary and the job status', async () => {
        store.enqueueTopic('SQLite FTS5');
        searchReturns([{ title: 'SQLite FTS5', url: 'https://example.test/fts', snippet: 'Full text search.' }]);
        const progress: string[] = [];
        const streamed: string[] = [];
        fakes.runStage.mockImplementation(async (_llm, _system, _input, options: { onToken: (token: string) => void }) => {
            options.onToken('Summary');
            return 'SQLite includes full-text search. https://example.test/fts';
        });

        const worked = await researchOneTopic(settings, {
            onProgress: (message) => progress.push(message),
            onToken: (token) => streamed.push(token),
            llm,
        });

        expect(worked).toBe(true);
        expect(streamed.length).toBeGreaterThan(0);
        expect(new Set(streamed)).toEqual(new Set(['Summary']));
        expect(progress).toContain('Extracting facts');
        expect(store.queueStatus()[0].status).toBe('done');
        expect(store.search('full text search')[0].summary).toBe('SQLite includes full-text search. https://example.test/fts');
    });

    it('loads its model through the shared cache', async () => {
        store.enqueueTopic('SQLite FTS5');
        searchReturns([{ title: 'SQLite FTS5', url: 'https://example.test/fts', snippet: 'Full text search.' }]);
        const cache = { get: vi.fn(async () => 'shared model') };
        fakes.runStage.mockResolvedValue('Summary');

        await researchOneTopic(settings, { modelCache: cache as unknown as ModelCache });

        expect(fakes.loadModel).not.toHaveBeenCalled();
        expect(fakes.runStage.mock.lastCall![0]).toBe('shared model');
        expect(cache.get.mock.lastCall).toEqual([settings.model_path, settings.context_size, settings.gpu_layers]);

        settings = { ...settings, background_model_path: 'big.gguf', background_context_size: 8192, background_gpu_layers: 0 };
        store.enqueueTopic('SQLite WAL');
        await researchOneTopic(settings, { modelCache: cache as unknown as ModelCache });

        expect(cache.get.mock.lastCall).toEqual(['big.gguf', 8192, 0]);
    });

    it('does not load a model when the queue is empty', async () => {
        expect(await researchOneTopic(settings)).toBe(false);

        expect(fakes.loadModel).not.toHaveBeenCalled();
    });

    it('defers the current topic when foreground work arrives', async () => {
        store.enqueueTopic('SQLite');
        searchReturns([{ title: 'SQLite', url: 'https://example.test/sqlite', snippet: 'Database.' }]);
        let active = false;
        fakes.runStage.mockImplementation(async (_llm, _system, _input, options: { onToken: (token: string) => void }) => {
            active = true;
            options.onToken('partial');
            return 'unreachable';
        });

        const worked = await researchOneTopic(settings, { shouldPause: () => active, llm });

        expect(worked).toBe(true);
        expect(store.queueStatus()[0].status).toBe('pending');
        expect(store.search('database')).toEqual([]);
    });
});

// ============================================================================
// Extraction
// ============================================================================

describe('extraction', () => {
    it('stores page summaries, facts and relationships and leaves placement to consolidation', async () => {
        store.enqueueTopic('SQLite FTS5');
        fakes.toolCall.mockImplementation(async (name: string, argumentsGiven: Record<string, unknown>) => {
            if (name === 'web_search') {
                return JSON.stringify([{ title: 'FTS5', url: 'https://example.test/fts', snippet: 'Full text.' }]);
            }
            return JSON.stringify({ url: argumentsGiven.url, title: 'FTS5', text: 'FTS5 is an SQLite module.' });
        });
        fakes.summarizeWebPage.mockResolvedValue('FTS5 is an SQLite module.');
        replyWith(
            JSON.stringify({ facts: [{ statement: 'FTS5 is an SQLite module.', source: 1, confidence: 'high' }] }),
            JSON.stringify({ facts: [{ statement: 'FTS5 is fast.', source: 99, confidence: 'low' }] }),
            JSON.stringify({
                summary: 'FTS5 adds full-text search to SQLite.',
                relationships: [{ subject: 'FTS5', relation: 'extends', object: 'SQLite', source: 2 }],
            }),
        );

        expect(await researchOneTopic(settings, { llm })).toBe(true);

        const calls = fakes.runStage.mock.calls;
        expect(fakes.summarizeWebPage).toHaveBeenCalledTimes(1);
        expect(calls[0][2]).toContain('FTS5 is an SQLite module.');
        expect(calls[0][2]).not.toContain('Full text.');
        expect(calls[1][2]).toContain('Full text.');
        for (const call of calls.slice(0, 3)) {
            expect(call[3].jsonSchema).toBeTruthy();
        }
        const facts = Object.fromEntries(store.facts().map((fact) => [fact.statement, fact]));
        expect(facts['FTS5 is an SQLite module.'].confidence).toBe(0.9);
        expect(facts['FTS5 is an SQLite module.'].source_url).toBe('https://example.test/fts');
        expect(facts['FTS5 is fast.'].source_url).toBeNull();
        expect(store.graph().map((edge) => [edge.source, edge.relation, edge.target])).toContainEqual(['FTS5', 'extends', 'SQLite']);
        const topics = Object.fromEntries(store.topics().map((topic) => [topic.name, topic]));
        expect(topics['SQLite FTS5'].parent).toBeNull();
        expect(queryOne("SELECT summary FROM topics WHERE name = 'SQLite FTS5'").summary).toBe('FTS5 adds full-text search to SQLite.');
        expect(store.sources()[0].summary).toBe('FTS5 is an SQLite module.');
        expect(store.queueStatus()[0].status).toBe('done');
    });

    it('reads the same page under a second address once and reads the next page instead', async () => {
        store.enqueueTopic('SQLite WAL');
        const pages: Record<string, string> = {
            'https://sqlite.org/wal.html': 'WAL is a journal mode.',
            'https://sqlite.org/wal.html?source=post_page-----2c7f': 'WAL  is a journal\nmode.',
            'https://example.test/wal': 'WAL lets readers run beside a writer.',
        };
        fakes.toolCall.mockImplementation(async (name: string, argumentsGiven: Record<string, unknown>) => {
            if (name === 'web_search') {
                return JSON.stringify(Object.keys(pages).map((url) => ({ title: 'WAL', url, snippet: 'WAL.' })));
            }
            const url = String(argumentsGiven.url);
            return JSON.stringify({ url, title: 'WAL', text: pages[url] });
        });
        fakes.summarizeWebPage.mockResolvedValue('Summary.');
        fakes.runStage.mockResolvedValue(JSON.stringify({ facts: [] }));

        await researchOneTopic(settings, { llm });

        expect(fakes.summarizeWebPage).toHaveBeenCalledTimes(2);
        expect(fakes.summarizeWebPage.mock.calls[1][1]).not.toContain('post_page');

        const overview = parseOverview(
            JSON.stringify({
                summary: '',
                relationships: [
                    { subject: 'SQLite WAL', relation: 'implemented_in', object: 'SQLite', source: 1 },
                    { subject: 'sqlite wal', relation: 'implemented_in', object: 'SQLite', source: 2 },
                    { subject: 'SQLite WAL', relation: 'described_by', object: 'sqlite.org', source: 1 },
                ],
            }),
            new Map([[1, 'https://sqlite.org/wal.html'], [2, 'https://example.test/wal']]),
        );
        expect(overview.relationships.map((relationship) => relationship.slice(0, 3))).toEqual([
            ['SQLite WAL', 'implemented_in', 'SQLite'],
            ['SQLite WAL', 'described_by', 'sqlite.org'],
        ]);
    });

    it('says in the job error that the search failed', async () => {
        store.enqueueTopic('SQLite WAL');
        fakes.toolCall.mockResolvedValue('Tool error: RatelimitException: 202 Ratelimit');

        await researchOneTopic(settings, { llm });

        expect(store.queueStatus()[0].status).toBe('failed');
        expect(store.queueStatus()[0].error).toContain('Web search failed: RatelimitException');
    });

    it('drops the last sentence of a cut-off snippet and never keeps a fact that ends cut off', () => {
        const sources: Source[] = [{ number: 1, url: 'https://sqlite.org/wal.html', text: 'WAL is faster. WAL provides more concurrency.' }];

        const kept = groundedFacts(
            [['WAL is faster.', 'https://sqlite.org/wal.html', 0.9], ['WAL provides more ...', 'https://sqlite.org/wal.html', 0.9]],
            sources,
        );

        expect(completeSentences('WAL is faster. WAL provides more ...')).toBe('WAL is faster.');
        expect(completeSentences('WAL provides more …')).toBe('WAL provides more');
        expect(completeSentences('WAL is faster.')).toBe('WAL is faster.');
        expect(kept).toEqual([['WAL is faster.', 'https://sqlite.org/wal.html', 0.9]]);
    });

    it('drops summary sentences stating values no source has', () => {
        const sources: Source[] = [{ number: 1, url: 'https://example.test/phone', text: 'The PinePhone has a 5.95 inch screen.' }];

        const summary = groundedSummary('The PinePhone has a 5.95 inch screen. It has a 5.7-inch touchscreen.', sources);

        expect(summary).toBe('The PinePhone has a 5.95 inch screen.');
    });

    it('checks extracted facts against the sources', () => {
        const sources: Source[] = [
            { number: 1, url: 'https://example.test/zig', text: 'Zig 0.13.0 was released on 2024-06-07 with a new build system.' },
            { number: 2, url: 'https://example.test/news', text: 'News: Zig ships releases twice a year.' },
        ];

        const facts = groundedFacts([
            ['Zig 0.13.0 was released on June 7, 2024.', 'https://example.test/zig', 0.9],
            ['Zig 0.14.0 was released in 2025.', 'https://example.test/zig', 0.9],
            ['Zig 0.13.0 has a new build system.', 'https://example.test/news', 0.9],
            ['Zig ships releases twice a year.', null, 0.6],
            ['Rust compiles quickly with incremental caching.', 'https://example.test/zig', 0.9],
        ], sources);

        expect(facts).toEqual([
            ['Zig 0.13.0 was released on June 7, 2024.', 'https://example.test/zig', 0.9],
            ['Zig 0.13.0 has a new build system.', 'https://example.test/news', 0.3],
            ['Zig ships releases twice a year.', null, 0.3],
            ['Rust compiles quickly with incremental caching.', 'https://example.test/zig', 0.3],
        ]);
    });
});

// ============================================================================
// Learning from past requests
// ============================================================================

describe('learning from past requests', () => {
    it('turns past requests into memories', async () => {
        store.recordEpisode('Write my Rust CLI in clap', 'action', '1. Use clap', 'Done', 'answered');
        store.addFact('Rust', 'Rust is a systems language.');
        fakes.runStage.mockResolvedValue(JSON.stringify({
            memories: [{ store: 'project', statement: 'Is building a Rust CLI with clap.' }],
            research_topics: ['clap argument parsing', 'Rust'],
        }));

        expect(await learnFromEpisodes(settings, { llm })).toBe(true);

        expect(fakes.runStage.mock.lastCall![2]).toContain('Write my Rust CLI in clap');
        expect(store.memories().map((memory) => [memory.store, memory.statement])).toEqual([['project', 'Is building a Rust CLI with clap.']]);
        expect(store.queueStatus().map((job) => job.topic)).toEqual(['clap argument parsing']);
        expect(store.episodes({ unprocessedOnly: true })).toEqual([]);
        expect(await learnFromEpisodes(settings, { llm })).toBe(false);
    });

    it('keeps a project memory to the folder its requests came from', async () => {
        store.recordEpisode('Plan my week', 'answer', '', 'Done', 'answered', { scope: '/home' });
        store.recordEpisode('Port the parser to Zig', 'action', '', 'Done', 'answered', { scope: '/work/parser' });
        fakes.runStage.mockResolvedValue(JSON.stringify({
            memories: [
                { store: 'project', statement: 'Is porting a parser to Zig.' },
                { store: 'user', statement: 'Likes Zig.', reason: 'Asked for Zig' },
            ],
            research_topics: [],
        }));

        await learnFromEpisodes(settings, { llm });

        expect(fakes.runStage).toHaveBeenCalledTimes(1);
        expect(Object.fromEntries(store.memories().map((memory) => [memory.statement, [memory.scope, memory.reason]]))).toEqual({
            'Is porting a parser to Zig.': ['/work/parser', ''],
            'Likes Zig.': ['', 'Asked for Zig'],
        });
        expect(store.episodes({ unprocessedOnly: true })).toHaveLength(1);
    });

    it('keeps only the locations and software the requests showed', async () => {
        const checklist = 'Paths the tools opened:\n- /Storage/Backups/nightly\n\nActions taken:\n- run_tests {}: pytest 8.3 passed';
        store.recordEpisode('Check my backups', 'files', checklist, 'Done', 'answered');
        fakes.runStage.mockResolvedValue(JSON.stringify({
            memories: [
                { store: 'locations', statement: 'Nightly backups are in /Storage/Backups/nightly.' },
                { store: 'locations', statement: 'Backups are mirrored to /mnt/offsite.' },
                { store: 'software', statement: 'pytest is installed.' },
                { store: 'software', statement: 'Borg is installed.' },
                { store: 'research', statement: 'Check the backup log before the docs.' },
            ],
            research_topics: [],
        }));

        await learnFromEpisodes(settings, { llm });

        expect(store.memories().map((memory) => [memory.store, memory.statement]).sort()).toEqual([
            ['locations', 'Nightly backups are in /Storage/Backups/nightly.'],
            ['research', 'Check the backup log before the docs.'],
            ['software', 'pytest is installed.'],
        ]);
    });
});

// ============================================================================
// Indexing for search by meaning
// ============================================================================

class FakeEmbedder implements TextEmbedder {
    readonly name = 'fake.gguf';
    readonly documents: string[] = [];

    async embedDocuments(texts: string[]): Promise<number[][]> {
        this.documents.push(...texts);
        return texts.map((text) => normalize([text.length, 1, 0, 0, 0, 0]));
    }

    async embedQuery(text: string): Promise<number[]> {
        return normalize([text.length, 1, 0, 0, 0, 0]);
    }
}

describe('indexing knowledge', () => {
    it('indexes one batch per pass', async () => {
        const embedder = new FakeEmbedder();
        const indexedStore = new KnowledgeStore(settings.knowledge_db_path, embedder);
        for (let number = 0; number < 10; number++) {
            indexedStore.addFact('Rust', `Cargo fact ${number}.`);
        }
        fakes.getEmbedder.mockReturnValue(embedder);
        settings = { ...settings, embedding_model_path: 'fake.gguf' };

        let passes = 0;
        while (await indexKnowledge(settings)) {
            passes += 1;
        }

        expect(passes).toBe(2);
        expect(embedder.documents).toHaveLength(11);
        expect(indexedStore.itemsToEmbed(embedder.name, 100)).toEqual([]);
    });

    it('does nothing without an embedding model', async () => {
        settings = { ...settings, embedding_model_path: '' };
        store.addFact('Rust', 'Cargo builds crates.');

        expect(await indexKnowledge(settings)).toBe(false);
    });
});
