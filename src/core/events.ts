// Handle the events queued in the knowledge store: each type has a handler that turns the event into actions for the user.
import { BackgroundPaused, type BackgroundOptions } from './background.js';
import { draftReplyHandler, userRequestHandler } from './eventTree.js';
import { KnowledgeStore, type EventRecord } from './knowledge.js';
import type { Settings } from './settings.js';
import { executeTaskTree, type ExecuteTaskTreeOptions } from './taskTree.js';
import { emailHandler } from './triage.js';

// ============================================================================
// Handlers
// ============================================================================

export type TreeRunner = (prompt: string, options: ExecuteTaskTreeOptions) => Promise<string>;

export type EventContext = {
    settings: Settings;
    store: KnowledgeStore;
    options: BackgroundOptions;
    // Works a prompt as a task tree; replaceable so tests need no model.
    runTree: TreeRunner;
};

export type EventOutcome = { status: 'done' | 'ignored'; detail: string };

export type EventHandler = (event: EventRecord, context: EventContext) => Promise<EventOutcome>;

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function textField(payload: Record<string, unknown>, name: string): string {
    const value = payload[name];
    return typeof value === 'string' ? value.trim() : '';
}

// A source that already knows what the user should see posts a notify event, and it becomes a notify action.
export const notifyHandler: EventHandler = async (event, { store }) => {
    const title = textField(event.payload, 'title');
    if (!title) {
        return { status: 'ignored', detail: 'A notify event needs a title.' };
    }
    const actionId = store.addAction({ eventId: event.id, kind: 'notify', title, body: textField(event.payload, 'body') });
    return { status: 'done', detail: `Proposed action ${actionId}` };
};

export const DEFAULT_EVENT_HANDLERS: ReadonlyMap<string, EventHandler> = new Map([
    ['notify', notifyHandler],
    ['email.received', emailHandler],
    ['email.draft', draftReplyHandler],
    ['user.request', userRequestHandler],
]);

// ============================================================================
// Working the queue
// ============================================================================

// Handle the next queued event, returning false when none is waiting.
export async function handleNextEvent(
    settings: Settings,
    options: BackgroundOptions = {},
    handlers: ReadonlyMap<string, EventHandler> = DEFAULT_EVENT_HANDLERS,
    runTree: TreeRunner = executeTaskTree,
): Promise<boolean> {
    const store = new KnowledgeStore(settings.knowledge_db_path);
    const event = store.claimEvent();
    if (event === null) {
        return false;
    }
    const report = options.onProgress ?? (() => {});
    const handler = handlers.get(event.type);
    if (!handler) {
        store.finishEvent(event.id, 'ignored', `No handler for ${event.type}`);
        return true;
    }
    try {
        report(`Handling ${event.type} from ${event.source}`);
        if (options.shouldPause?.()) {
            throw new BackgroundPaused();
        }
        const outcome = await handler(event, { settings, store, options, runTree });
        store.finishEvent(event.id, outcome.status, outcome.detail);
    } catch (error) {
        if (error instanceof BackgroundPaused) {
            store.deferEvent(event.id);
            report('Paused for foreground work');
            return true;
        }
        store.finishEvent(event.id, 'failed', errorText(error));
        report(`Event failed: ${errorText(error)}`);
    }
    return true;
}
