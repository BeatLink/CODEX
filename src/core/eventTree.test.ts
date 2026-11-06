import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackgroundPaused, type BackgroundOptions } from './background.js';
import { UNTRUSTED_OPEN } from './contextBudget.js';
import { handleNextEvent, type TreeRunner } from './events.js';
import { KnowledgeStore } from './knowledge.js';
import type { ChatModel } from './model.js';
import { DEFAULT_SETTINGS, type Settings } from './settings.js';
import { RunStopped } from './taskTree.js';

// ============================================================================
// Helpers
// ============================================================================

let directory: string;
let settings: Settings;
let store: KnowledgeStore;
const options: BackgroundOptions = { llm: {} as ChatModel };

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'codex-event-tree-'));
    settings = { ...DEFAULT_SETTINGS, knowledge_db_path: join(directory, 'knowledge.db') };
    store = new KnowledgeStore(settings.knowledge_db_path);
});

afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
});

function mailDraft(): void {
    store.enqueueEvent({
        source: 'maildir:/mail',
        type: 'email.draft',
        payload: { from: 'Alice <alice@example.test>', subject: 'Lunch?', body: 'Free on Friday?', message_id: '<1@example.test>' },
    });
}

// ============================================================================
// Drafting a reply
// ============================================================================

describe('drafting a reply', () => {
    it('works the mail as an outside-trust task tree and proposes the draft', async () => {
        mailDraft();
        const runTree = vi.fn<TreeRunner>().mockResolvedValue('Friday works for me.\n\nBest');

        await handleNextEvent(settings, options, undefined, runTree);

        const [prompt, treeOptions] = runTree.mock.calls[0];
        expect(prompt).toContain(UNTRUSTED_OPEN);
        expect(prompt).toContain('Free on Friday?');
        expect(treeOptions).toMatchObject({ trust: 'external', mode: 'answer', allowFileWrites: false, enableTestExecution: false, mcpServers: [] });
        const [action] = store.actions('proposed');
        expect(action).toMatchObject({ kind: 'draft', title: 'Reply to Alice <alice@example.test>: Lunch?', body: 'Friday works for me. Best' });
        expect(store.events()[0].status).toBe('done');
    });

    it('holds the model for the whole run and releases it when the run fails', async () => {
        mailDraft();
        const lock = { acquire: vi.fn(async () => {}), release: vi.fn() };
        const runTree = vi.fn<TreeRunner>().mockRejectedValue(new Error('boom'));

        await handleNextEvent(settings, { ...options, modelLock: lock }, undefined, runTree);

        expect(lock.acquire).toHaveBeenCalledOnce();
        expect(lock.release).toHaveBeenCalledOnce();
        expect(store.events()[0]).toMatchObject({ status: 'failed', error: 'boom' });
    });

    it('requeues the event when foreground work stops the run', async () => {
        mailDraft();
        const runTree = vi.fn<TreeRunner>().mockRejectedValue(new RunStopped());

        await handleNextEvent(settings, options, undefined, runTree);

        expect(store.events()[0].status).toBe('pending');
        expect(store.actions()).toEqual([]);
    });

    it('does not start while background work is paused', async () => {
        mailDraft();
        const runTree = vi.fn<TreeRunner>();

        await handleNextEvent(settings, { ...options, shouldPause: () => true }, undefined, runTree);

        expect(runTree).not.toHaveBeenCalled();
        expect(store.events()[0].status).toBe('pending');
        expect(BackgroundPaused).toBeDefined();
    });

    it('ignores a draft the model left empty', async () => {
        mailDraft();

        await handleNextEvent(settings, options, undefined, async () => '   ');

        expect(store.events()[0].status).toBe('ignored');
        expect(store.actions()).toEqual([]);
    });
});

// ============================================================================
// A request left for later
// ============================================================================

describe('a request left for later', () => {
    it('answers as the user but never changes anything, and files the result', async () => {
        store.enqueueEvent({ source: 'user', type: 'user.request', trust: 'user', payload: { prompt: 'Summarise what I know about WAL' } });
        const runTree = vi.fn<TreeRunner>().mockResolvedValue('WAL is a journal mode.');

        await handleNextEvent(settings, options, undefined, runTree);

        const [prompt, treeOptions] = runTree.mock.calls[0];
        expect(prompt).toBe('Summarise what I know about WAL');
        expect(treeOptions).toMatchObject({ trust: 'user', mode: 'answer', allowFileWrites: false, enableTestExecution: false, mcpServers: [] });
        expect(store.actions('proposed')[0]).toMatchObject({ kind: 'result', title: 'Summarise what I know about WAL', body: 'WAL is a journal mode.' });
    });

    it('ignores a request without a prompt', async () => {
        store.enqueueEvent({ source: 'user', type: 'user.request', trust: 'user', payload: {} });
        const runTree = vi.fn<TreeRunner>();

        await handleNextEvent(settings, options, undefined, runTree);

        expect(runTree).not.toHaveBeenCalled();
        expect(store.events()[0].status).toBe('ignored');
    });
});
