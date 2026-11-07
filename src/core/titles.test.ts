import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({ runStage: vi.fn() }));

vi.mock('./model.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./model.js')>()),
    runStage: fakes.runStage,
}));

import { BackgroundPaused } from './background.js';
import { KnowledgeStore } from './knowledge.js';
import type { ChatModel } from './model.js';
import { DEFAULT_SETTINGS, type Settings } from './settings.js';
import { fallbackTitle, isTitle, readTitle, titleConversations } from './titles.js';

// ============================================================================
// Helpers
// ============================================================================

let directory: string;
let settings: Settings;
let store: KnowledgeStore;
const llm = {} as ChatModel;

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'codex-titles-'));
    settings = { ...DEFAULT_SETTINGS, knowledge_db_path: join(directory, 'knowledge.db'), filesystem_root: directory };
    store = new KnowledgeStore(settings.knowledge_db_path);
    fakes.runStage.mockReset();
});

afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
});

function titleReply(name: string): string {
    return JSON.stringify({ reason: 'Because.', name });
}

function episodeTitles(): string[] {
    return store.episodes().map((episode) => episode.title);
}

// ============================================================================
// What a title is
// ============================================================================

describe('title rules', () => {
    it('accepts one to five words within forty characters', () => {
        expect(isTitle('SQLite FTS5')).toBe(true);
        expect(isTitle('')).toBe(false);
        expect(isTitle('one two three four five six')).toBe(false);
        expect(isTitle('Supercalifragilisticexpialidocious long words')).toBe(false);
    });

    it('reads the name from a reply and tidies its spaces', () => {
        expect(readTitle(titleReply('  Lisbon   forecast '))).toBe('Lisbon forecast');
        expect(readTitle('not json')).toBeNull();
        expect(readTitle('{"reason": "no name"}')).toBeNull();
    });

    it('falls back to the first words of the request', () => {
        expect(fallbackTitle('what is the weather in lisbon this weekend')).toBe('what is the weather in');
        expect(isTitle(fallbackTitle('Supercalifragilisticexpialidocious antidisestablishmentarianism words'))).toBe(true);
        expect(fallbackTitle('')).toBe('');
    });
});

// ============================================================================
// Titling conversations
// ============================================================================

describe('titling conversations', () => {
    it('titles the newest untitled episode, then reports nothing left', async () => {
        store.recordEpisode('how does fts5 in sqlite rank its results?', 'research', '', 'Done', 'answered');
        fakes.runStage.mockResolvedValue(titleReply('SQLite FTS5 ranking'));

        expect(await titleConversations(settings, { llm })).toBe(true);

        expect(fakes.runStage.mock.lastCall![2]).toContain('<untrusted-data>');
        expect(episodeTitles()).toEqual(['SQLite FTS5 ranking']);
        expect(await titleConversations(settings, { llm })).toBe(false);
    });

    it('titles an unfinished run before any episode', async () => {
        store.recordEpisode('Plan my week', 'answer', '', 'Done', 'answered');
        const runId = store.startTaskRun('Port the parser to Zig', {});
        fakes.runStage.mockResolvedValue(titleReply('Zig parser port'));

        await titleConversations(settings, { llm });

        expect(store.unfinishedTaskRuns().find((run) => run.id === runId)?.title).toBe('Zig parser port');
        expect(episodeTitles()).toEqual(['']);
    });

    it('uses the first words of the request when the title is too long or not from the request', async () => {
        store.recordEpisode('will it rain in lisbon this weekend', 'research', '', 'Done', 'answered');
        store.recordEpisode('Port the parser to Zig', 'action', '', 'Done', 'answered');
        fakes.runStage
            .mockResolvedValueOnce(titleReply('A long title that has far too many words'))
            .mockResolvedValueOnce(titleReply('Holiday weather'));

        await titleConversations(settings, { llm });
        await titleConversations(settings, { llm });

        expect(episodeTitles()).toEqual(['Port the parser to Zig', 'will it rain in lisbon']);
    });

    it('leaves the conversation untitled when foreground work pauses it', async () => {
        store.recordEpisode('Plan my week', 'answer', '', 'Done', 'answered');
        fakes.runStage.mockRejectedValue(new BackgroundPaused());

        expect(await titleConversations(settings, { llm })).toBe(true);

        expect(episodeTitles()).toEqual(['']);
    });
});
