import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({ runStage: vi.fn() }));

vi.mock('./model.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./model.js')>()),
    runStage: fakes.runStage,
}));

import type { BackgroundOptions } from './background.js';
import { NEW_PARENT, TOP_LEVEL, consolidateKnowledge } from './consolidation.js';
import { KnowledgeStore } from './knowledge.js';
import type { ChatModel } from './model.js';
import { DEFAULT_SETTINGS, type Settings } from './settings.js';

// ============================================================================
// Helpers
// ============================================================================

let directory: string;
let settings: Settings;
let store: KnowledgeStore;
const llm = {} as ChatModel;

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'codex-consolidation-'));
    settings = { ...DEFAULT_SETTINGS, knowledge_db_path: join(directory, 'knowledge.db'), filesystem_root: directory };
    store = new KnowledgeStore(settings.knowledge_db_path);
    fakes.runStage.mockReset();
});

afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
});

function verdict(choice: string, key = 'verdict'): string {
    return JSON.stringify({ reason: 'Because.', [key]: choice });
}

function execute(sql: string, ...parameters: SQLInputValue[]): Array<Record<string, unknown>> {
    const database = new DatabaseSync(settings.knowledge_db_path);
    try {
        const statement = database.prepare(sql);
        if (/^\s*select/i.test(sql)) {
            return statement.all(...parameters) as Array<Record<string, unknown>>;
        }
        statement.run(...parameters);
        return [];
    } finally {
        database.close();
    }
}

// Run one consolidation pass with the model giving these replies, returning the pass result and the calls.
async function consolidate(replies: string[] = [], options: BackgroundOptions = {}): Promise<[boolean, any[][]]> {
    const answers = [...replies];
    fakes.runStage.mockImplementation(async () => {
        if (answers.length === 0) {
            throw new Error('No reply left for this model call.');
        }
        return answers.shift()!;
    });
    const worked = await consolidateKnowledge(settings, { llm, ...options });
    return [worked, fakes.runStage.mock.calls];
}

function placeEveryTopic(): void {
    execute('UPDATE topics SET placed_at = ?', Date.now() / 1000);
}

// Record that a topic's name was already checked, so a test can start at a later step.
function markTitled(name: string): void {
    const topicId = store.addTopic(name);
    store.recordCheck('title', topicId, topicId, name);
}

function topicNames(): Record<string, string | null> {
    return Object.fromEntries(store.topics().map((topic) => [topic.name, topic.parent]));
}

function edges(): string[][] {
    return store.graph().map((edge) => [edge.source, edge.relation, edge.target]);
}

// ============================================================================
// Tidying without the model
// ============================================================================

describe('tidying', () => {
    it('merges topics named with the same words into the one with more facts', () => {
        store.addFact('Python packaging', 'Wheels are built distributions.', null, 0.9);
        store.addFact('packaging Python', 'Wheels are built distributions!', null, 0.6);
        store.addFact('packaging Python', 'Sdists hold source code.', null, 0.6);

        const changes = store.tidy(90);
        store.tidy(90);

        expect(changes['topics merged']).toBe(1);
        expect(Object.keys(topicNames())).toEqual(['packaging Python']);
        const facts = Object.fromEntries(store.facts().map((fact) => [fact.statement, fact]));
        expect(new Set(Object.keys(facts))).toEqual(new Set(['Wheels are built distributions.', 'Sdists hold source code.']));
        expect(facts['Wheels are built distributions.'].confidence).toBe(0.9);
    });

    it('queues empty topics for research once', () => {
        store.addTopic('Empty');
        const failedJob = store.enqueueTopic('Failed');
        store.claimJob();
        store.finishJob(failedJob, 'No results');
        store.enqueueTopic('Queued');

        expect(store.tidy(90)).toEqual({ 'empty topics queued for research': 1 });
        expect(store.tidy(90)).toEqual({});
        expect(new Set(Object.keys(topicNames()))).toEqual(new Set(['Empty', 'Queued', 'Failed']));
        const pending = new Set(store.queueStatus().filter((job) => job.status === 'pending').map((job) => job.topic));
        expect(pending).toEqual(new Set(['Empty', 'Queued']));
    });

    it('leaves empty topics waiting while the queue is full', () => {
        store.addTopic('Empty');
        store.enqueueTopic('Queued');

        expect(store.tidy(90, 1)).toEqual({});
    });

    it('prunes old unused low-confidence facts and brings them back when found again', () => {
        store.addFact('SQLite', 'SQLite is small.', null, 0.3);
        store.addFact('SQLite', 'SQLite is public domain.', null, 0.9);
        execute('UPDATE facts SET created_at = ?', Date.now() / 1000 - 100 * 86400);

        expect(store.tidy(90)).toEqual({ 'facts pruned': 1 });
        const statuses = Object.fromEntries(store.facts().map((fact) => [fact.statement, fact.status]));
        expect(statuses).toEqual({ 'SQLite is small.': 'pruned', 'SQLite is public domain.': 'active' });

        store.addFact('SQLite', 'SQLite is small.', null, 0.3);
        expect(new Set(store.facts().map((fact) => fact.status))).toEqual(new Set(['active']));
    });

    it('breaks a parent loop', () => {
        store.addTopic('Databases', { parent: 'SQLite' });
        store.addTopic('SQLite', { parent: 'Databases' });
        store.addFact('SQLite', 'SQLite is small.');
        store.addFact('Databases', 'Databases hold data.');

        expect(store.tidy(90)).toEqual({ 'parent loops broken': 1 });
        expect([
            { Databases: null, SQLite: 'Databases' },
            { Databases: 'SQLite', SQLite: null },
        ]).toContainEqual(topicNames());
    });
});

// ============================================================================
// Naming topics
// ============================================================================

// Store a search under a topic named after its query, as a request does, with one fact.
function searchTopic(query: string, fact: string): void {
    store.storeSearchResults(query, [{ title: 'FTS5', url: `https://example.test/${query.length}`, snippet: fact }], { topic: query });
    store.addFact(query, fact);
}

function storeSearch(query: string, title: string, url: string, snippet: string, topic: string, summary?: string): void {
    store.storeSearchResults(query, [{ title, url, snippet }], { topic, summary });
}

describe('naming topics', () => {
    it('renames a topic named after its search query once', async () => {
        searchTopic('how do i use fts5 in sqlite', 'FTS5 adds full-text search to SQLite.');
        store.addTopic('SQLite', { priority: 1 });
        store.adoptTopic(store.addTopic('SQLite'), store.addTopic('how do i use fts5 in sqlite'));
        placeEveryTopic();

        const [worked, calls] = await consolidate([JSON.stringify({ reason: 'It is about FTS5.', name: 'SQLite FTS5' })]);

        expect(worked).toBe(true);
        expect(calls[0][2]).toContain('FTS5 adds full-text search to SQLite.');
        expect(topicNames()).toEqual({ SQLite: null, 'SQLite FTS5': 'SQLite' });
        expect(edges()).toContainEqual(['SQLite', 'contains', 'SQLite FTS5']);
        expect(store.graph().map((edge) => edge.target)).not.toContain('how do i use fts5 in sqlite');
        expect(store.nextTopicToName()).toBeNull();
    });

    it('places a renamed topic and its subtopics again', async () => {
        searchTopic('what is the pinephone', 'The PinePhone is a Linux phone.');
        store.addTopic('PinePhone screen', { parent: 'what is the pinephone' });
        store.addFact('PinePhone screen', 'The PinePhone screen is 5.95 inches.');
        store.addFact('SQLite', 'SQLite is small.');
        placeEveryTopic();

        await consolidate([JSON.stringify({ reason: 'It is about the PinePhone.', name: 'PinePhone' })]);

        const unplaced = new Set(execute('SELECT name FROM topics WHERE placed_at IS NULL').map((row) => row.name));
        expect(unplaced).toEqual(new Set(['PinePhone', 'PinePhone screen']));
    });

    it('merges a query topic given an existing name into that topic', async () => {
        store.addFact('SQLite FTS5', 'FTS5 supports ranking.');
        searchTopic('fts5 full text search sqlite', 'FTS5 adds full-text search to SQLite.');
        placeEveryTopic();

        await consolidate([JSON.stringify({ reason: 'Same subject.', name: 'sqlite fts5' })]);

        expect(Object.keys(topicNames())).toEqual(['SQLite FTS5']);
        expect(store.facts()).toHaveLength(2);
    });

    it('keeps the topic for an unreadable or query-like name and does not ask again', async () => {
        searchTopic('fts5 sqlite', 'FTS5 adds full-text search to SQLite.');
        placeEveryTopic();

        await consolidate([JSON.stringify({ reason: 'Long.', name: 'how to use the full text search module of the sqlite database' })]);

        expect(Object.keys(topicNames())).toEqual(['fts5 sqlite']);
        expect(store.nextTopicToName()).toBeNull();
    });

    it('renames a long name even when no search used it', async () => {
        store.addFact('Notes on the PinePhone smartphone made by Pine64', 'The PinePhone runs Linux.');
        placeEveryTopic();

        await consolidate([JSON.stringify({ reason: 'It is about the PinePhone.', name: 'PinePhone' })]);

        expect(Object.keys(topicNames())).toEqual(['PinePhone']);
    });

    it('removes a topic that names no subject and holds no facts', async () => {
        const sentence = 'Therefore the claim should be omitted.';
        store.storeSearchResults(sentence, [{ title: 'Fact checks', url: 'https://example.test/check', snippet: 'Checks.' }], { topic: sentence, summary: 'Fact checking.' });
        store.addFact('SQLite', 'SQLite is small.');
        placeEveryTopic();

        await consolidate([JSON.stringify({ reason: 'No subject is named.', name: '' })]);

        expect(Object.keys(topicNames())).toEqual(['SQLite']);
        expect(store.sources()).toHaveLength(1);
    });

    it('lifts the subtopics of a topic that names no subject into its place', async () => {
        const sentence = 'Regarding the screen size mentioned before, it could not be verified.';
        store.addTopic('PineTime');
        store.addTopic(sentence, { parent: 'PineTime' });
        store.addTopic('Screen notes', { parent: sentence });
        store.addFact('Screen notes', 'Screens are measured diagonally.');
        store.addFact('PineTime', 'The PineTime is a smartwatch.');
        store.setTopicSummary(sentence, 'Fact checking.');
        placeEveryTopic();

        await consolidate([JSON.stringify({ reason: 'No subject is named.', name: '' })]);

        expect(topicNames()).toEqual({ PineTime: null, 'Screen notes': 'PineTime' });
    });

    it('counts a title sharing no word with the current name as no subject', async () => {
        const sentence = 'It features a 5.7-inch touchscreen and a 13-megapixel rear camera.';
        storeSearch(sentence, 'Scanner', 'https://example.test/scan', 'A rugged scanner.', sentence, 'A rugged handheld scanner.');
        store.addFact('SQLite', 'SQLite is small.');
        placeEveryTopic();

        await consolidate([JSON.stringify({ reason: 'The sources describe a scanner.', name: 'Honeywell ScanPal EDA52' })]);

        expect(Object.keys(topicNames())).toEqual(['SQLite']);
        expect(store.queueStatus()).toEqual([]);
    });

    it('never removes a topic already called by a title as naming no subject', async () => {
        storeSearch('PineTime distinction', 'Watch', 'https://example.test/watch', 'A watch.', 'PineTime distinction', 'A smartwatch.');
        placeEveryTopic();

        await consolidate([JSON.stringify({ reason: 'Unclear.', name: '' })]);

        expect(Object.keys(topicNames())).toEqual(['PineTime distinction']);
    });

    it('lists existing topics sharing a word in the naming call', async () => {
        const query = 'can you search the internet for information about the pinetime smartwatch';
        storeSearch(query, 'Watch', 'https://example.test/watch', 'A watch.', query);
        store.addFact('pinetime', 'The PineTime is a smartwatch.');
        store.addFact('SQLite', 'SQLite is small.');
        placeEveryTopic();

        const [, calls] = await consolidate([JSON.stringify({ reason: 'It asks about the PineTime.', name: 'pinetime' })]);

        expect(calls[0][2]).toContain('Existing topics:\npinetime');
        expect(calls[0][2]).not.toContain('SQLite');
        expect(new Set(Object.keys(topicNames()))).toEqual(new Set(['pinetime', 'SQLite']));
    });

    it('checks a topic named under older rules again and removes it when it names no subject', async () => {
        const sentence = '* **Hardware**: It features a 5.7-inch touchscreen and a 13-megapixel rear camera.';
        storeSearch(sentence, 'Scanner', 'https://example.test/scan', 'A scanner.', sentence, 'A rugged scanner.');
        const topicId = store.addTopic(sentence);
        store.recordCheck('name', topicId, topicId, 'Honeywell ScanPal EDA52');
        store.renameTopic(topicId, 'Honeywell ScanPal EDA52');
        placeEveryTopic();

        const [worked, calls] = await consolidate([JSON.stringify({ reason: 'No product is named.', name: '' })]);

        expect(worked).toBe(true);
        expect(calls[0][2]).toContain('Searches that found it:\n- * **Hardware**');
        expect(topicNames()).toEqual({});
    });

    it('counts a kept name sharing no word with its searches as no subject', async () => {
        const sentence = '* **Hardware**: It features a 5.7-inch touchscreen and a 13-megapixel rear camera.';
        storeSearch(sentence, 'Scanner', 'https://example.test/scan', 'A scanner.', sentence, 'A rugged scanner.');
        store.renameTopic(store.addTopic(sentence), 'Honeywell ScanPal EDA52');
        placeEveryTopic();

        await consolidate([JSON.stringify({ reason: 'It already reads as a title.', name: 'Honeywell ScanPal EDA52' })]);

        expect(topicNames()).toEqual({});
    });

    it('counts a title about checking a claim as no subject', async () => {
        const sentence = 'Therefore, the claim about the 5.7-inch screen should be omitted as unverified.';
        storeSearch(sentence, 'Checks', 'https://example.test/check', 'Checks.', sentence, 'Fact checking.');
        store.renameTopic(store.addTopic(sentence), '5.7 inch screen verification');
        placeEveryTopic();

        await consolidate([JSON.stringify({ reason: 'It is about a screen claim.', name: '5.7-inch screen claim' })]);

        expect(topicNames()).toEqual({});
    });

    it('keeps a grounded title found by a sentence when the model finds no subject', async () => {
        const query = 'can you search the internet for information about the pinetime smartwatch';
        storeSearch(query, 'Watch', 'https://example.test/watch', 'A watch.', 'pinetime');
        placeEveryTopic();

        await consolidate([JSON.stringify({ reason: 'Unclear.', name: '' })]);

        expect(Object.keys(topicNames())).toEqual(['pinetime']);
    });

    it('researches and places afresh a researched topic that keeps its name', async () => {
        storeSearch('PinePhone', 'Phone', 'https://example.test/phone', 'A phone.', 'PinePhone', 'Sources say nothing.');
        placeEveryTopic();

        await consolidate([JSON.stringify({ reason: 'It already reads as a title.', name: 'PinePhone' })]);

        expect(store.queueStatus().map((job) => job.topic)).toEqual(['PinePhone']);
        expect(store.nextTopicToPlace(Date.now() / 1000)!.name).toBe('PinePhone');
    });

    it('lets a title take its words from the search that found the topic', async () => {
        storeSearch('what is the pinephone', 'Phone', 'https://example.test/phone', 'A phone.', 'Phone notes', 'A Linux phone.');
        placeEveryTopic();

        await consolidate([JSON.stringify({ reason: 'The search names the PinePhone.', name: 'PinePhone' })]);

        expect(Object.keys(topicNames())).toEqual(['PinePhone']);
    });

    it('still names a query topic with no summary or facts', async () => {
        const query = 'can you search the internet for information about the pinetime smartwatch';
        storeSearch(query, 'Watch', 'https://example.test/watch', 'A watch.', query);
        placeEveryTopic();

        await consolidate([JSON.stringify({ reason: 'It asks about the PineTime.', name: 'PineTime' })]);

        expect(Object.keys(topicNames())).toEqual(['PineTime']);
    });

    it('researches a renamed topic with no facts under its new name', async () => {
        const query = 'what is the pinephone';
        storeSearch(query, 'Phone', 'https://example.test/phone', 'A phone.', query, 'A Linux phone.');
        placeEveryTopic();

        await consolidate([JSON.stringify({ reason: 'It is about the PinePhone.', name: 'PinePhone' })]);

        expect(store.queueStatus().map((job) => job.topic)).toEqual(['PinePhone']);
    });
});

// ============================================================================
// Comparing pairs
// ============================================================================

describe('comparing pairs', () => {
    it('merges topics naming one subject into the better supported one', async () => {
        store.addFact('SQLite FTS5', 'FTS5 adds full-text search.');
        store.addFact('SQLite FTS5', 'FTS5 supports ranking.');
        store.addFact('FTS5', 'FTS5 is a virtual table module.');
        store.enqueueTopic('FTS5');
        placeEveryTopic();

        const [worked, calls] = await consolidate([verdict('same subject')]);

        expect(worked).toBe(true);
        expect(calls[0][2]).toContain('SQLite FTS5');
        expect(Object.keys(topicNames())).toEqual(['SQLite FTS5']);
        expect(store.facts()).toHaveLength(3);
        expect(store.queueStatus().map((job) => job.topic)).toEqual(['SQLite FTS5']);
    });

    it('lets a broader topic adopt a top-level one and rewrite its summary', async () => {
        store.addFact('SQLite', 'SQLite is an embedded database.');
        store.addFact('SQLite FTS5', 'FTS5 adds full-text search.');
        store.setTopicSummary('SQLite FTS5', 'Full-text search for SQLite.');
        placeEveryTopic();

        const [worked] = await consolidate([verdict('first is broader'), JSON.stringify({ summary: 'SQLite overview.' })]);

        expect(worked).toBe(true);
        expect(topicNames()['SQLite FTS5']).toBe('SQLite');
        expect(store.childSummaries('SQLite')).toEqual([['SQLite FTS5', 'Full-text search for SQLite.']]);
        expect(edges()).toContainEqual(['SQLite', 'contains', 'SQLite FTS5']);
    });

    it('compares each pair once', async () => {
        store.addFact('SQLite', 'SQLite is an embedded database.');
        store.addFact('SQLite FTS5', 'FTS5 adds full-text search.');
        placeEveryTopic();

        await consolidate([verdict('different')]);
        fakes.runStage.mockClear();
        const [worked, calls] = await consolidate();

        expect(worked).toBe(false);
        expect(calls).toEqual([]);
    });

    it('sets aside the weaker of two contradicting facts and queues research', async () => {
        store.addFact('SQLite', 'SQLite 3.0 was released in 2004.', null, 0.9);
        store.addFact('SQLite', 'SQLite 3.0 was released in 2005.', null, 0.3);
        placeEveryTopic();

        const [worked] = await consolidate([verdict('contradict')]);

        expect(worked).toBe(true);
        const statuses = Object.fromEntries(store.facts().map((fact) => [fact.statement, fact.status]));
        expect(statuses['SQLite 3.0 was released in 2004.']).toBe('active');
        expect(statuses['SQLite 3.0 was released in 2005.']).toBe('disputed');
        expect(store.queueStatus()[0].topic).toBe('SQLite');
    });

    it('merges matching facts', async () => {
        store.addFact('SQLite', 'SQLite stores each database in one file.', null, 0.6);
        store.addFact('SQLite', 'SQLite stores the whole database in one file.', null, 0.9);
        placeEveryTopic();

        await consolidate([verdict('same')]);

        expect(store.facts().map((fact) => [fact.statement, fact.confidence])).toEqual([['SQLite stores the whole database in one file.', 0.9]]);
    });

    it('lets a newer user memory supersede a contradicting older one', async () => {
        store.addUserMemory('preference', 'Prefers Python for scripting tasks.');
        store.addUserMemory('preference', 'Prefers Rust for scripting tasks.');

        const [worked, calls] = await consolidate([verdict('contradict')]);

        expect(worked).toBe(true);
        expect(calls[0][2].indexOf('Python')).toBeLessThan(calls[0][2].indexOf('Rust'));
        expect(store.userMemories().map((memory) => memory.statement)).toEqual(['Prefers Rust for scripting tasks.']);
    });

    it('keeps a stated user memory over a newer learned one it contradicts', async () => {
        store.addUserMemory('preference', 'Prefers Python for scripting tasks.', { origin: 'user' });
        store.addUserMemory('preference', 'Prefers Rust for scripting tasks.');

        await consolidate([verdict('contradict')]);

        expect(store.userMemories().map((memory) => memory.statement)).toEqual(['Prefers Python for scripting tasks.']);
    });

    it('leaves the pair to compare later when foreground work arrives', async () => {
        store.addFact('SQLite', 'SQLite is an embedded database.');
        store.addFact('SQLite FTS5', 'FTS5 adds full-text search.');
        placeEveryTopic();
        let active = false;
        fakes.runStage.mockImplementation(async (_llm, _system, _input, options: { onToken: (token: string) => void }) => {
            active = true;
            options.onToken('partial');
            return verdict('same subject');
        });

        const worked = await consolidateKnowledge(settings, { shouldPause: () => active, llm });

        expect(worked).toBe(true);
        expect(new Set(Object.keys(topicNames()))).toEqual(new Set(['SQLite', 'SQLite FTS5']));
        expect(store.nextUncheckedPair('topic')).not.toBeNull();
    });

    it('changes nothing on an unreadable reply and does not ask again', async () => {
        store.addFact('SQLite', 'SQLite is an embedded database.');
        store.addFact('SQLite FTS5', 'FTS5 adds full-text search.');
        placeEveryTopic();

        await consolidate(['not json']);

        expect(new Set(Object.keys(topicNames()))).toEqual(new Set(['SQLite', 'SQLite FTS5']));
        expect(store.nextUncheckedPair('topic')).toBeNull();
    });
});

// ============================================================================
// Placing topics
// ============================================================================

function parentChoices(call: any[]): string[] {
    return call[3].jsonSchema.properties.parent.enum;
}

describe('placing topics', () => {
    it('moves a topic under the parent the model picks', async () => {
        store.addFact('Databases', 'Databases hold data.');
        store.setTopicSummary('Databases', 'Systems that store data.');
        store.addFact('Notes', 'Notes are written down.');
        store.addFact('Web frameworks', 'Frameworks serve pages.');
        store.addFact('PostgreSQL', 'PostgreSQL is a relational database.');
        store.addTopic('PostgreSQL', { parent: 'Web frameworks' });
        placeEveryTopic();
        execute("UPDATE topics SET placed_at = NULL WHERE name = 'PostgreSQL'");

        const [worked, calls] = await consolidate([
            verdict('Databases', 'parent'),
            verdict('second is broader'),
            JSON.stringify({ summary: 'Databases overview.' }),
        ]);

        expect(worked).toBe(true);
        // Notes has no summary, so nothing tells the model what it covers.
        expect(new Set(parentChoices(calls[0]))).toEqual(new Set([TOP_LEVEL, 'Databases', 'Web frameworks']));
        expect(topicNames().PostgreSQL).toBe('Databases');
        expect(edges()).not.toContainEqual(['Web frameworks', 'contains', 'PostgreSQL']);
    });

    it('keeps the own summary of a researched parent when a topic moves under it', async () => {
        storeSearch('pinephone', 'Phone', 'https://example.test/phone', 'A phone.', 'PinePhone', 'A Linux phone made by Pine64.');
        store.addFact('Owner forums', 'The community meets on Matrix.');
        store.setTopicSummary('Owner forums', 'Where PinePhone owners talk.');
        store.addFact('PinePhone', 'The PinePhone runs Linux.');
        placeEveryTopic();
        execute("UPDATE topics SET placed_at = NULL WHERE name = 'Owner forums'");
        execute(
            "INSERT INTO consolidation_checks VALUES ('title', (SELECT id FROM topics WHERE name = 'PinePhone'), " +
                "(SELECT id FROM topics WHERE name = 'PinePhone'), 'PinePhone', 0)",
        );

        const [worked, calls] = await consolidate([verdict('PinePhone', 'parent'), verdict('second is broader')]);

        expect(worked).toBe(true);
        expect(calls).toHaveLength(2);
        expect(topicNames()['Owner forums']).toBe('PinePhone');
        expect(execute("SELECT summary FROM topics WHERE name = 'PinePhone'")[0].summary).toBe('A Linux phone made by Pine64.');
    });

    it('lets a researched topic name a new parent made where it sits', async () => {
        store.addFact('Hardware', 'Hardware is physical computing equipment.');
        store.setTopicSummary('Hardware', 'Physical computing equipment.');
        store.addFact('PineTime', 'The PineTime is a smartwatch made by Pine64.');
        storeSearch('pinephone linux phone', 'Phone', 'https://example.test/phone', 'A phone.', 'PinePhone', 'A Linux phone made by Pine64.');
        store.addTopic('PinePhone', { parent: 'Hardware' });
        markTitled('PinePhone');
        placeEveryTopic();
        execute("UPDATE topics SET placed_at = NULL WHERE name = 'PinePhone'");

        const placement = JSON.stringify({ reason: 'Both are Pine64 devices.', parent: NEW_PARENT, new_parent: 'Pine64' });
        const [worked, calls] = await consolidate([
            placement,
            JSON.stringify({ summary: 'Pine64 makes the PinePhone.' }),
            JSON.stringify({ summary: 'Hardware.' }),
        ]);

        expect(worked).toBe(true);
        expect(parentChoices(calls[0])).toContain(NEW_PARENT);
        expect(topicNames()).toEqual({ Hardware: null, Pine64: 'Hardware', PinePhone: 'Pine64', PineTime: null });
        expect(store.childSummaries('Hardware')).toEqual([['Pine64', 'Pine64 makes the PinePhone.']]);
    });

    it('never lets a topic that was never researched name a new parent', async () => {
        store.addFact('Hardware', 'Hardware is physical computing equipment.');
        store.setTopicSummary('Hardware', 'Physical computing equipment.');
        store.addTopic('Pine64', { parent: 'PineTime' });
        store.addFact('Pine64', 'Pine64 makes single-board computers.');
        store.addFact('PineTime', 'The PineTime is a smartwatch.');
        placeEveryTopic();
        execute("UPDATE topics SET placed_at = NULL WHERE name = 'Pine64'");

        const [worked, calls] = await consolidate([
            verdict('Hardware', 'parent'),
            verdict('second is broader'),
            JSON.stringify({ summary: 'Hardware.' }),
            JSON.stringify({ summary: 'PineTime.' }),
        ]);

        expect(worked).toBe(true);
        expect(parentChoices(calls[0])).not.toContain(NEW_PARENT);
        expect(topicNames().Pine64).toBe('Hardware');
    });

    it('does not offer as a parent a topic whose name holds every word of this one and more', () => {
        for (const name of ['PinePhone', 'PinePhone community', 'Pine64']) {
            store.addFact(name, `${name} is real.`);
            store.setTopicSummary(name, `About ${name}.`);
        }

        const candidates = store.placementCandidates(store.addTopic('PinePhone'));

        expect(new Set(candidates.map((candidate) => candidate.name))).toEqual(new Set(['Pine64']));
    });

    it('leaves the topic where it is when the pair check does not confirm the parent as broader', async () => {
        store.addFact('PineTime', 'The PineTime is a smartwatch.');
        store.setTopicSummary('PineTime', 'A smartwatch.');
        store.addFact('Hardware', 'Hardware is physical equipment.');
        store.setTopicSummary('Hardware', 'Physical computing equipment.');
        placeEveryTopic();
        execute("UPDATE topics SET placed_at = NULL WHERE name = 'Hardware'");

        const [worked, calls] = await consolidate([verdict('PineTime', 'parent'), verdict('first is broader')]);

        expect(worked).toBe(true);
        expect(calls[1][2]).toContain('First topic: Hardware');
        expect(topicNames()).toEqual({ PineTime: null, Hardware: null });
    });

    it('places a grouping topic by a summary rebuilt from its subtopics', async () => {
        store.addTopic('PinePhone', { parent: 'Hardware' });
        store.setTopicSummary('PinePhone', 'A Linux phone.');
        store.addFact('PinePhone', 'The PinePhone runs Linux.');
        store.setTopicSummary('Hardware', 'A stale summary about a 5.7-inch screen.');
        store.addFact('Computing', 'Computing covers hardware and software.');
        store.setTopicSummary('Computing', 'Hardware and software.');
        placeEveryTopic();
        execute("UPDATE topics SET placed_at = NULL WHERE name = 'Hardware'");

        const [worked, calls] = await consolidate([
            JSON.stringify({ summary: 'Physical devices such as the PinePhone.' }),
            verdict(TOP_LEVEL, 'parent'),
        ]);

        expect(worked).toBe(true);
        expect(calls[1][2]).toContain('Physical devices such as the PinePhone.');
        expect(calls[1][2]).not.toContain('stale');
    });

    it('never offers a topic its own subtopics as a parent', async () => {
        store.addFact('Databases', 'Databases hold data.');
        store.addFact('SQLite', 'SQLite is small.');
        store.addTopic('SQLite', { parent: 'Databases' });
        placeEveryTopic();
        execute("UPDATE topics SET placed_at = NULL WHERE name = 'Databases'");

        const [worked, calls] = await consolidate();

        expect(worked).toBe(true);
        expect(calls).toEqual([]);
        expect(topicNames().Databases).toBeNull();
    });
});
