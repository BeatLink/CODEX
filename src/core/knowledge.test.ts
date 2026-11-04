import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeStore, MIGRATIONS } from './knowledge.js';


// ============================================================================
// Helpers
// ============================================================================

let directory: string;

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'codex-knowledge-'));
});

afterEach(() => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
});

function withDatabase<T>(path: string, work: (database: DatabaseSync) => T): T {
    const database = new DatabaseSync(path);
    try {
        return work(database);
    } finally {
        database.close();
    }
}

function scalar(database: DatabaseSync, sql: string): any {
    return Object.values(database.prepare(sql).get()!)[0];
}

// Moves the clock the store reads by a number of seconds.
function shiftClock(seconds: number): void {
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + seconds * 1000);
}

function liveMegabytes(path: string): number {
    return withDatabase(path, (database) => {
        const used = scalar(database, 'PRAGMA page_count') - scalar(database, 'PRAGMA freelist_count');
        return (used * scalar(database, 'PRAGMA page_size')) / (1024 * 1024);
    });
}

// ============================================================================
// Knowledge store
// ============================================================================

describe('KnowledgeStore', () => {
    let store: KnowledgeStore;

    beforeEach(() => {
        store = new KnowledgeStore(join(directory, 'nested', 'knowledge.db'));
    });

    it('persists topics, sources and graph relationships', () => {
        store.addTopic('Python', { parent: 'Software' });
        store.storeSearchResults(
            'python sqlite',
            [{ title: 'SQLite docs', url: 'https://example.test/sqlite', snippet: 'Python database' }],
            { topic: 'Python', summary: 'SQLite is a database.' },
        );

        const results = store.search('python database');

        expect(results[0].topic).toBe('Python');
        expect(results[0].summary).toBe('SQLite is a database.');
        expect(store.graph().some((edge) => edge.relation === 'contains')).toBe(true);
        expect(store.graph().some((edge) => edge.relation === 'supported_by')).toBe(true);
        expect(store.topics()).toHaveLength(2);
    });

    it('does not retrieve expired sources', () => {
        store.storeSearchResults('old result', [{ title: 'Old', url: 'https://example.test/old', snippet: 'stale evidence' }], {
            ttlSeconds: 0,
        });

        shiftClock(1);

        expect(store.search('stale evidence')).toEqual([]);
    });

    it('lets an entity relationship reference its evidence source', () => {
        store.storeSearchResults(
            'tool relationship',
            [{ title: 'Integration notes', url: 'https://example.test/tool', snippet: 'Tool A uses Tool B.' }],
            { topic: 'Integrations' },
        );

        store.addRelationship('Tool A', 'uses', 'Tool B', 'https://example.test/tool');

        const relationship = store.graph().find((edge) => edge.source === 'Tool A')!;
        expect([relationship.relation, relationship.target]).toEqual(['uses', 'Tool B']);
        expect(relationship.evidence_url).toBe('https://example.test/tool');
    });

    it('refuses a relationship citing an unknown source and stores nothing of it', () => {
        expect(() => store.addRelationship('Tool A', 'uses', 'Tool B', 'https://example.test/missing')).toThrow(
            'source_url must refer to a stored source.',
        );

        expect(store.graph()).toEqual([]);
    });

    it('deduplicates pending jobs and orders them by priority', () => {
        const lowPriority = store.enqueueTopic('Low', { priority: 1 });
        const highPriority = store.enqueueTopic('High', { priority: 5 });
        expect(store.enqueueTopic('High', { priority: 5 })).toBe(highPriority);

        const job = store.claimJob()!;

        expect(job.id).toBe(highPriority);
        expect(job.id).not.toBe(lowPriority);
        store.finishJob(job.id);
        expect(store.queueStatus()[0].status).toBe('done');
    });

    it('queues stale source topics for refresh', () => {
        store.storeSearchResults('stale topic', [{ title: 'Topic', url: 'https://example.test/topic', snippet: 'Research source.' }], {
            topic: 'Topic',
        });

        shiftClock(7200);
        const queued = store.enqueueDueTopics(1);

        expect(queued).toBe(1);
        expect(store.queueStatus()[0].status).toBe('pending');
    });

    it('refreshes often used topics in half the time', async () => {
        for (const name of ['Used', 'Unused']) {
            store.storeSearchResults(name, [{ title: name, url: `https://example.test/${name}`, snippet: `${name} source.` }], {
                topic: name,
            });
        }
        store.addFact('Used', 'Used topics come back often.');
        shiftClock(10);
        for (let count = 0; count < 5; count += 1) {
            await store.recall('used topics come back often');
        }
        vi.restoreAllMocks();

        shiftClock(2400);
        const queued = store.enqueueDueTopics(1);

        expect(queued).toBe(1);
        expect(store.queueStatus().map((job) => job.topic)).toEqual(['Used']);
    });

    it('hard limits the pending job count', () => {
        const firstId = store.enqueueTopic('First', { maxPending: 1 });

        expect(store.enqueueTopic('First', { maxPending: 1 })).toBe(firstId);
        expect(() => store.enqueueTopic('Second', { maxPending: 1 })).toThrow(/queue is full/);
        expect(store.queueStatus()).toHaveLength(1);
    });

    it('keeps a topic parent and priority when updated without them', () => {
        store.addTopic('Python', { parent: 'Software', priority: 4 });
        store.storeSearchResults('python', [{ title: 'Python', url: 'https://example.test/python', snippet: 'Python' }], {
            topic: 'Python',
        });

        const python = store.topics().find((topic) => topic.name === 'Python')!;

        expect([python.parent, python.priority]).toEqual(['Software', 4]);
    });

    it('stores the summary once on the topic', () => {
        store.storeSearchResults(
            'sqlite',
            [
                { title: 'One', url: 'https://example.test/one', snippet: 'SQLite one' },
                { title: 'Two', url: 'https://example.test/two', snippet: 'SQLite two' },
            ],
            { topic: 'SQLite', summary: 'Topic summary.' },
        );

        expect(store.sources().every((source) => source.summary === '')).toBe(true);
        expect(store.search('sqlite').every((result) => result.summary === 'Topic summary.')).toBe(true);
    });

    it('keeps the highest confidence and the source of a repeated fact', () => {
        store.storeSearchResults('fts', [{ title: 'FTS', url: 'https://example.test/fts', snippet: 'FTS5' }], { topic: 'SQLite' });
        store.addFact('SQLite', 'SQLite ships  FTS5.', 'https://example.test/fts', 0.9);
        store.addFact('SQLite', 'SQLite ships FTS5.', null, 0.4);

        const facts = store.facts();

        expect(facts).toHaveLength(1);
        expect(facts[0].confidence).toBe(0.9);
        expect(facts[0].source_url).toBe('https://example.test/fts');
    });

    it('recalls user memory, facts and episodes and counts their use', async () => {
        store.addUserMemory('preference', 'Prefers Python examples');
        store.addFact('SQLite', 'SQLite FTS5 supports bm25 ranking.', null, 0.8);
        store.addFact('Rust', 'Cargo builds crates.', null, 0.8);
        store.recordEpisode('Explain SQLite FTS5 ranking', 'reasoning', '1. Explain ranking', 'Answer', 'answered');

        const recalled = await store.recall('How does SQLite FTS5 ranking work?');

        expect(recalled.user.map((memory) => memory.statement)).toEqual(['Prefers Python examples']);
        expect(recalled.facts.map((fact) => fact.statement)).toEqual(['SQLite FTS5 supports bm25 ranking.']);
        expect(recalled.episodes[0].prompt).toBe('Explain SQLite FTS5 ranking');
        const useCounts = Object.fromEntries(store.facts().map((fact) => [fact.topic, fact.use_count]));
        expect(useCounts).toEqual({ SQLite: 1, Rust: 0 });
    });

    it('recalls for a long request a fact sharing three of its terms', async () => {
        store.addUserMemory('preference', 'Prefers Python examples');
        store.addFact('FastAPI', 'FastAPI runs async def endpoints on the event loop.');
        store.addFact('FastAPI', 'FastAPI is a Python web framework.');

        const recalled = await store.recall(
            'I am building a web service with FastAPI and Postgres; how should I structure' +
                ' async endpoints and database sessions so they do not block?',
            { includeUser: false },
        );

        expect(recalled.user).toEqual([]);
        // The other fact comes from the named topic's branch, after the one matching the request itself.
        expect(recalled.facts.map((fact) => fact.statement)).toEqual([
            'FastAPI runs async def endpoints on the event loop.',
            'FastAPI is a Python web framework.',
        ]);
    });

    it('recalls a fact whose source has expired as stale', async () => {
        store.storeSearchResults('zig', [{ url: 'https://zig.example/', title: 'Zig', snippet: 'Zig.' }]);
        store.addFact('Zig', 'Zig 0.13.0 is the newest Zig release.', 'https://zig.example/');
        store.addFact('Zig', 'Zig releases ship a new Zig build system.');
        withDatabase(store.path, (database) => database.exec('UPDATE sources SET expires_at = 0'));

        const recalled = await store.recall('newest zig release build');

        const facts = Object.fromEntries(recalled.facts.map((fact) => [fact.statement, fact]));
        expect(facts['Zig 0.13.0 is the newest Zig release.'].stale).toBe(true);
        expect(facts['Zig releases ship a new Zig build system.'].stale).toBe(false);
        expect(facts['Zig releases ship a new Zig build system.'].retrieved_at).not.toBeNull();
    });

    it('recalls the relationships of entities a fact names', async () => {
        store.storeSearchResults('fts5', [{ url: 'https://example.test/fts', title: 'FTS5', snippet: 'FTS5.' }]);
        store.addFact('SQLite', 'FTS5 supports bm25 ranking.');
        store.storeSearchResults('fts5 docs', [{ url: 'https://example.test/docs', title: 'FTS5', snippet: 'FTS5.' }]);
        store.addRelationship('FTS5', 'extends', 'SQLite', 'https://example.test/fts');
        store.addRelationship('FTS5', 'extends', 'SQLite', 'https://example.test/docs');
        store.addRelationship('Cargo', 'builds', 'Rust');
        store.addRelationship('FTS', 'precedes', 'FTS4');

        const relationships = (await store.recall('FTS5 bm25 ranking')).relationships;

        expect(relationships).toEqual([
            { subject: 'FTS5', relation: 'extends', object: 'SQLite', source_url: 'https://example.test/docs' },
        ]);
    });

    it('fills recall up from the branch of the topic the query names', async () => {
        store.addTopic('FastAPI', { parent: 'Python web frameworks' });
        store.addTopic('FastAPI dependencies', { parent: 'FastAPI' });
        store.addFact('FastAPI', 'It is built on Starlette and Pydantic.', null, 0.6);
        store.addFact('FastAPI dependencies', 'Depends() injects shared resources.', null, 0.9);
        store.addFact('Python web frameworks', 'Django ships an admin site.', null, 0.9);
        store.addFact('Rust', 'Cargo builds crates.', null, 0.9);

        const recalled = await store.recall('How should I lay out a FastAPI app?');

        expect(recalled.facts.map((fact) => fact.statement)).toEqual([
            'Depends() injects shared resources.',
            'It is built on Starlette and Pydantic.',
        ]);
    });

    it('gives a recalled fact its chain of parent summaries', async () => {
        store.addTopic('SQLite', { parent: 'Databases' });
        store.addTopic('SQLite FTS5', { parent: 'SQLite' });
        store.setTopicSummary('Databases', 'Ways to store data.');
        store.setTopicSummary('SQLite', 'An embedded database.');
        store.addFact('SQLite FTS5', 'FTS5 supports bm25 ranking.');

        const fact = (await store.recall('FTS5 bm25 ranking')).facts[0];

        expect(fact.topic_path).toEqual([
            { name: 'Databases', summary: 'Ways to store data.' },
            { name: 'SQLite', summary: 'An embedded database.' },
        ]);
    });

    it('recalls a new user memory beside often used ones', async () => {
        for (let number = 0; number < 12; number += 1) {
            store.addUserMemory('preference', `Likes style number ${number}`);
        }
        for (let count = 0; count < 3; count += 1) {
            await store.recall('anything at all');
        }
        store.addUserMemory('preference', 'Wants answers in British English');

        const recalled = (await store.recall('anything at all')).user.map((memory) => memory.statement);

        expect(recalled).toHaveLength(10);
        expect(recalled[0]).toBe('Wants answers in British English');
    });

    it('puts user memories sharing the request words first', async () => {
        store.addUserMemory('preference', 'Uses Rust for command line tools');
        store.addUserMemory('preference', 'Prefers short answers');

        const recalled = (await store.recall('Write a Rust command line parser')).user;

        expect(recalled[0].statement).toBe('Uses Rust for command line tools');
    });

    it('recalls a project memory only in its project', async () => {
        store.addUserMemory('project', 'Is porting the parser to Zig', { scope: '/work/parser' });
        store.addUserMemory('preference', 'Prefers short answers');

        const here = (await store.recall('next step', { scope: '/work/parser' })).user.map((memory) => memory.statement);
        const elsewhere = (await store.recall('next step', { scope: '/work/other' })).user.map((memory) => memory.statement);

        expect([...here].sort()).toEqual(['Is porting the parser to Zig', 'Prefers short answers']);
        expect(elsewhere).toEqual(['Prefers short answers']);
    });

    it('keeps a stated memory stated, with its reason, when it is learned again', () => {
        store.addUserMemory('reference', 'Docs live at https://example.test/docs', { reason: 'Moved there', origin: 'user' });
        store.addUserMemory('reference', 'Docs live at https://example.test/docs');

        const [memory] = store.userMemories();

        expect([memory.origin, memory.reason]).toEqual(['user', 'Moved there']);
    });

    it('forgets a user memory for good', () => {
        const memoryId = store.addUserMemory('preference', 'Prefers tabs');

        expect(store.forgetUserMemory(memoryId)).toBe(true);
        expect(store.forgetUserMemory(memoryId)).toBe(false);
        expect(store.userMemories()).toEqual([]);
    });

    it('rejects unknown user memory kinds', () => {
        expect(() => store.addUserMemory('secret', 'anything')).toThrow(/kind must be one of/);
    });

    it('marks episodes processed', () => {
        const episodeId = store.recordEpisode('Prompt', 'direct', '', 'Answer', 'answered');

        store.markEpisodeProcessed(episodeId);

        expect(store.episodes({ unprocessedOnly: true })).toEqual([]);
        expect(store.episodes()).toHaveLength(1);
    });

    it('puts jobs a stopped worker left running back in the queue', () => {
        store.enqueueTopic('SQLite');
        store.claimJob();
        store.enqueueTopic('PinePhone');
        store.claimJob();
        store.enqueueTopic('PinePhone');

        expect(store.requeueInterruptedJobs()).toBe(1);

        const jobs = store.queueStatus().map((job) => [job.topic, job.status]).sort();
        expect(jobs).toEqual([
            ['PinePhone', 'pending'],
            ['SQLite', 'pending'],
        ]);
    });

    it('saves and reads back a task run checkpoint', () => {
        const runId = store.startTaskRun('Prompt', { mode: 'tree' });

        store.saveTaskRun(runId, { nodes: ['é'] }, 1, 3);
        store.setTaskRunStatus(runId, 'stopped');

        const run = store.taskRun(runId)!;
        expect([run.options, run.state, run.status, run.tasks_done, run.tasks_total]).toEqual([
            { mode: 'tree' },
            { nodes: ['é'] },
            'stopped',
            1,
            3,
        ]);
        expect(store.unfinishedTaskRuns().map((unfinished) => unfinished.id)).toEqual([runId]);
        expect(() => store.setTaskRunStatus(runId, 'lost')).toThrow('Unknown task run status: lost');
    });

    it('stores timestamps as float seconds since the epoch', () => {
        const before = Date.now() / 1000;

        store.addFact('Kestrel', 'Kestrel ingest listens on port 7413.');

        const createdAt = store.facts()[0].created_at;
        expect(createdAt).toBeGreaterThanOrEqual(before - 1);
        expect(createdAt).toBeLessThan(before + 60);
    });
});

// ============================================================================
// Size cap
// ============================================================================

describe('KnowledgeStore size cap', () => {
    let path: string;
    let store: KnowledgeStore;

    beforeEach(() => {
        path = join(directory, 'knowledge.db');
        store = new KnowledgeStore(path);
    });

    it('evicts processed episodes before any fact or user memory', () => {
        store.addFact('Kestrel', 'Kestrel ingest listens on port 7413.');
        store.addUserMemory('preference', 'Prefers ISO dates.');
        for (let number = 0; number < 60; number += 1) {
            const episodeId = store.recordEpisode(`Request ${number}`, 'answer', '', 'Done.', 'answered', { taskTree: 'x'.repeat(40_000) });
            store.markEpisodeProcessed(episodeId);
        }
        expect(liveMegabytes(path)).toBeGreaterThan(1);

        const changes = store.tidy(90, 100, 1);

        expect(liveMegabytes(path)).toBeLessThanOrEqual(0.9);
        expect(changes['items evicted to fit the size cap']).toBeGreaterThan(0);
        expect(store.episodes({ limit: 100 }).length).toBeLessThan(60);
        expect(store.facts().map((fact) => fact.statement)).toEqual(['Kestrel ingest listens on port 7413.']);
        expect(store.userMemories().map((memory) => memory.statement)).toEqual(['Prefers ISO dates.']);
    });

    it('evicts the least used facts first, with their search entries', async () => {
        // The used fact is the oldest, so only its use can keep it.
        store.addFact('Kestrel', 'Kestrel ingest listens on port 7413.');
        await store.recall('Kestrel ingest port');
        const filler = Array.from({ length: 60 }, (_, number) => `word${number}`).join(' ');
        for (let number = 0; number < 1500; number += 1) {
            store.addFact('Filler', `Unused fact ${number}: ${filler}`);
        }
        expect(liveMegabytes(path)).toBeGreaterThan(1);

        store.tidy(90, 100, 1);

        const statements = store.facts({ limit: 5000 }).map((fact) => fact.statement);
        expect(statements.length).toBeLessThan(1501);
        expect(statements).toContain('Kestrel ingest listens on port 7413.');
        const indexed = withDatabase(path, (database) => scalar(database, "SELECT COUNT(*) FROM memory_search WHERE kind = 'fact'"));
        expect(indexed).toBe(statements.length);
    }, 60_000);

    it('leaves a store under its cap alone', () => {
        store.addFact('Kestrel', 'Kestrel ingest listens on port 7413.');

        const changes = store.tidy(90, 100, 1);

        expect(changes).not.toHaveProperty('items evicted to fit the size cap');
        expect(store.facts()).toHaveLength(1);
    });
});

// ============================================================================
// Migrations
// ============================================================================

// Writes a database at an earlier schema version holding one row in each table that version has.
function buildOldStore(path: string, version: number): void {
    const now = Date.now() / 1000;
    withDatabase(path, (database) => {
        const run = (sql: string, ...parameters: Array<string | number>) => database.prepare(sql).run(...parameters);
        database.exec(MIGRATIONS[0]);
        run("INSERT INTO topics(id, name) VALUES (1, 'Kestrel')");
        run(
            'INSERT INTO sources(id, url, title, snippet, topic_id, retrieved_at, expires_at) ' +
                "VALUES (1, 'https://wiki.example/ingest', 'Kestrel ingest', 'Kestrel ingest listens on port 7413.', 1, ?, ?)",
            now, now + 3600,
        );
        run(
            'INSERT INTO knowledge_search(rowid, title, body, url) VALUES ' +
                "(1, 'Kestrel ingest', 'Kestrel ingest listens on port 7413.', 'https://wiki.example/ingest')",
        );
        run('INSERT INTO research_queue(topic_id, requested_at) VALUES (1, ?)', now);
        run("INSERT INTO graph_nodes(id, kind, label) VALUES (1, 'topic', 'Kestrel'), (2, 'source', 'https://wiki.example/ingest')");
        run("INSERT INTO graph_edges(source_node_id, relation, target_node_id, source_id) VALUES (1, 'supported_by', 2, 1)");
        for (let nextVersion = 2; nextVersion <= version; nextVersion += 1) {
            database.exec(MIGRATIONS[nextVersion - 1]);
            if (nextVersion === 2) {
                run(
                    'INSERT INTO facts(id, topic_id, statement, source_id, created_at) ' +
                        "VALUES (1, 1, 'Kestrel ingest listens on port 7413.', 1, ?)",
                    now,
                );
                run("INSERT INTO memory_search(body, kind, item_id) VALUES ('Kestrel ingest listens on port 7413.', 'fact', 1)");
                run("INSERT INTO user_memory(kind, statement, created_at) VALUES ('preference', 'Prefers ISO dates.', ?)", now);
                run("INSERT INTO episodes(prompt, task_type, created_at) VALUES ('What port?', 'answer', ?)", now);
            }
        }
        database.exec(`PRAGMA user_version = ${version}`);
    });
}

function countRows(database: DatabaseSync, table: string): number {
    return Number(scalar(database, `SELECT COUNT(*) FROM ${table}`));
}

describe('KnowledgeStore migrations', () => {
    it('moves summaries onto topics from a version one database', () => {
        const path = join(directory, 'knowledge.db');
        withDatabase(path, (database) => {
            database.exec(MIGRATIONS[0]);
            database.exec("INSERT INTO topics(id, name) VALUES (1, 'SQLite')");
            database
                .prepare(
                    'INSERT INTO sources(id, url, title, snippet, summary, topic_id, retrieved_at, expires_at) ' +
                        "VALUES (1, 'https://example.test/a', 'A', 'SQLite snippet', 'Old summary', 1, ?, ?)",
                )
                .run(Date.now() / 1000, Date.now() / 1000 + 3600);
            database.exec('PRAGMA user_version = 1');
        });

        const store = new KnowledgeStore(path);

        withDatabase(path, (database) => {
            expect(scalar(database, 'PRAGMA user_version')).toBe(MIGRATIONS.length);
            expect(scalar(database, 'SELECT summary FROM topics')).toBe('Old summary');
            expect(scalar(database, 'SELECT summary FROM sources')).toBe('');
        });
        expect(store.search('sqlite snippet')[0].summary).toBe('Old summary');
    });

    for (let startVersion = 1; startVersion < MIGRATIONS.length; startVersion += 1) {
        it(`migrates a version ${startVersion} database without losing rows`, async () => {
            const tables = ['topics', 'sources', 'research_queue', 'graph_nodes', 'graph_edges', 'facts', 'user_memory', 'episodes'];
            const path = join(directory, 'knowledge.db');
            buildOldStore(path, startVersion);
            const before = withDatabase(path, (database) => {
                const existing = new Set(
                    database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
                );
                return Object.fromEntries(tables.filter((table) => existing.has(table)).map((table) => [table, countRows(database, table)]));
            });

            const store = new KnowledgeStore(path);

            withDatabase(path, (database) => {
                expect(scalar(database, 'PRAGMA user_version')).toBe(MIGRATIONS.length);
                expect(Object.fromEntries(Object.keys(before).map((table) => [table, countRows(database, table)]))).toEqual(before);
            });
            expect(store.search('Kestrel ingest')[0].url).toBe('https://wiki.example/ingest');
            if (startVersion >= 2) {
                const statements = (await store.recall('Kestrel ingest port')).facts.map((fact) => fact.statement);
                expect(statements).toContain('Kestrel ingest listens on port 7413.');
                expect(store.userMemories().map((memory) => memory.statement)).toEqual(['Prefers ISO dates.']);
                expect(store.episodes()).toHaveLength(1);
            }
            store.addFact('Kestrel', 'Kestrel ingest is written in Rust.');
            expect(store.facts()).toHaveLength(startVersion >= 2 ? 2 : 1);
        });
    }

    it('refuses a newer schema', () => {
        const path = join(directory, 'knowledge.db');
        withDatabase(path, (database) => database.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`));

        expect(() => new KnowledgeStore(path)).toThrow(/newer than this application/);
    });
});
