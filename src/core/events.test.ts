import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BackgroundPaused } from './background.js';
import { handleNextEvent, type EventHandler } from './events.js';
import { KnowledgeStore, MAX_EVENT_PAYLOAD_CHARS } from './knowledge.js';
import { runNextJob, type Job } from './scheduler.js';
import { DEFAULT_SETTINGS, type Settings } from './settings.js';

// ============================================================================
// Helpers
// ============================================================================

let directory: string;
let settings: Settings;
let store: KnowledgeStore;

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'codex-events-'));
    settings = { ...DEFAULT_SETTINGS, knowledge_db_path: join(directory, 'knowledge.db') };
    store = new KnowledgeStore(settings.knowledge_db_path);
});

afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
});

function eventStatuses(): string[] {
    return store.events().map((event) => String(event.status));
}

// ============================================================================
// The event queue
// ============================================================================

describe('event queue', () => {
    it('hands out the most important event first, oldest first among equals', () => {
        const first = store.enqueueEvent({ source: 'mail', type: 'email.received' }).id;
        const urgent = store.enqueueEvent({ source: 'mail', type: 'email.received', priority: 5 }).id;
        const second = store.enqueueEvent({ source: 'mail', type: 'email.received' }).id;

        expect([store.claimEvent()?.id, store.claimEvent()?.id, store.claimEvent()?.id, store.claimEvent()]).toEqual([urgent, first, second, null]);
    });

    it('queues an event with a known dedupe key only once per source', () => {
        const first = store.enqueueEvent({ source: 'mail', type: 'email.received', dedupeKey: 'message-1' });
        const again = store.enqueueEvent({ source: 'mail', type: 'email.received', dedupeKey: 'message-1' });
        const otherSource = store.enqueueEvent({ source: 'calendar', type: 'event.soon', dedupeKey: 'message-1' });

        expect(again).toEqual({ id: first.id, duplicate: true });
        expect(otherSource.duplicate).toBe(false);
        expect(store.events()).toHaveLength(2);
    });

    it('refuses events without a source or type, with an unknown trust, or too big', () => {
        expect(() => store.enqueueEvent({ source: ' ', type: 'x' })).toThrow('source and a type');
        expect(() => store.enqueueEvent({ source: 'mail', type: 'x', trust: 'friend' as never })).toThrow('trust must be one of');
        const payload = { text: 'a'.repeat(MAX_EVENT_PAYLOAD_CHARS) };
        expect(() => store.enqueueEvent({ source: 'mail', type: 'x', payload })).toThrow('payload is over');
    });

    it('stops queueing at the pending limit', () => {
        store.enqueueEvent({ source: 'mail', type: 'x' }, { maxPending: 1 });

        expect(() => store.enqueueEvent({ source: 'mail', type: 'x' }, { maxPending: 1 })).toThrow('queue is full');
    });

    it('treats events as external unless told otherwise, and returns the payload parsed', () => {
        store.enqueueEvent({ source: 'mail', type: 'email.received', payload: { subject: 'Hello' } });

        expect(store.claimEvent()).toMatchObject({ trust: 'external', payload: { subject: 'Hello' } });
    });

    it('puts back events a stopped daemon left running', () => {
        store.enqueueEvent({ source: 'mail', type: 'x' });
        store.claimEvent();

        expect(store.requeueInterruptedEvents()).toBe(1);
        expect(eventStatuses()).toEqual(['pending']);
    });
});

// ============================================================================
// Actions
// ============================================================================

describe('actions', () => {
    it('lists proposed actions and resolves each once', () => {
        const actionId = store.addAction({ kind: 'notify', title: 'Call the bank' });

        expect(store.actions('proposed').map((action) => action.id)).toEqual([actionId]);
        expect(store.resolveAction(actionId, 'approved')).toBe(true);
        expect(store.resolveAction(actionId, 'rejected')).toBe(false);
        expect(store.resolveAction(actionId, 'done')).toBe(true);
        expect(store.actions('proposed')).toEqual([]);
        expect(store.actions()[0].status).toBe('done');
    });

    it('refuses an action without a title', () => {
        expect(() => store.addAction({ kind: 'notify', title: ' ' })).toThrow('kind and a title');
    });
});

// ============================================================================
// Handling events
// ============================================================================

describe('handleNextEvent', () => {
    it('returns false with nothing queued', async () => {
        expect(await handleNextEvent(settings)).toBe(false);
    });

    it('turns a notify event into a proposed action', async () => {
        const { id } = store.enqueueEvent({ source: 'timer', type: 'notify', payload: { title: 'Stand up', body: 'Stretch' } });

        expect(await handleNextEvent(settings)).toBe(true);

        expect(eventStatuses()).toEqual(['done']);
        expect(store.actions()).toMatchObject([{ event_id: id, kind: 'notify', title: 'Stand up', body: 'Stretch', status: 'proposed' }]);
    });

    it('ignores a notify event without a title and an event no handler wants', async () => {
        store.enqueueEvent({ source: 'timer', type: 'notify' });
        store.enqueueEvent({ source: 'mail', type: 'email.received' });

        await handleNextEvent(settings);
        await handleNextEvent(settings);

        expect(eventStatuses()).toEqual(['ignored', 'ignored']);
        expect(store.actions()).toEqual([]);
    });

    it('records a failing handler and moves on', async () => {
        const failing: EventHandler = async () => {
            throw new Error('boom');
        };
        store.enqueueEvent({ source: 'mail', type: 'x' });

        expect(await handleNextEvent(settings, {}, new Map([['x', failing]]))).toBe(true);

        expect(store.events()[0]).toMatchObject({ status: 'failed', error: 'boom' });
    });

    it('puts the event back when foreground work pauses the handler', async () => {
        const paused: EventHandler = async () => {
            throw new BackgroundPaused();
        };
        store.enqueueEvent({ source: 'mail', type: 'x' });

        await handleNextEvent(settings, {}, new Map([['x', paused]]));

        expect(eventStatuses()).toEqual(['pending']);
    });

    it('pauses before the handler runs when a run is already active', async () => {
        let ran = false;
        const handler: EventHandler = async () => {
            ran = true;
            return { status: 'done', detail: '' };
        };
        store.enqueueEvent({ source: 'mail', type: 'x' });

        await handleNextEvent(settings, { shouldPause: () => true }, new Map([['x', handler]]));

        expect(ran).toBe(false);
        expect(eventStatuses()).toEqual(['pending']);
    });
});

// ============================================================================
// The job list
// ============================================================================

describe('runNextJob', () => {
    function job(name: string, jobClass: Job['jobClass'], works: boolean, calls: string[]): Job {
        return {
            name,
            jobClass,
            step: async () => {
                calls.push(name);
                return works;
            },
        };
    }

    it('tries reactive jobs before maintenance ones whatever the list order', async () => {
        const calls: string[] = [];
        const jobs = [job('research', 'maintenance', true, calls), job('events', 'reactive', true, calls)];

        expect(await runNextJob(jobs, settings, {})).toBe('events');
        expect(calls).toEqual(['events']);
    });

    it('falls through to the next job that has work, and returns null when none has', async () => {
        const calls: string[] = [];
        const jobs = [job('events', 'reactive', false, calls), job('research', 'maintenance', false, calls), job('learn', 'maintenance', true, calls)];

        expect(await runNextJob(jobs, settings, {})).toBe('learn');
        expect(await runNextJob(jobs.slice(0, 2), settings, {})).toBeNull();
    });
});
