// Events that need real work are worked as task trees: a drafted reply to an email, or a request the user left for later.
import { BackgroundPaused } from './background.js';
import { untrustedBlock } from './contextBudget.js';
import type { EventContext, EventHandler, EventOutcome } from './events.js';
import type { EventRecord } from './knowledge.js';
import { checkNote, draftChecks, replySubject, senderAddress, type MailThread } from './mailChecks.js';
import { prompt } from './prompts.js';
import { backgroundModelKey } from './settings.js';
import { RunStopped } from './taskTree.js';

// Longest prompt text or draft kept; the mail is written by anyone, and the tree's answer is shown to the user.
const MAX_MAIL_PROMPT_CHARS = 4000;
const MAX_DRAFT_CHARS = 4000;
const MAX_TITLE_CHARS = 120;

export const DRAFT_PROMPT = prompt('draft');

function field(payload: Record<string, unknown>, name: string): string {
    const value = payload[name];
    return typeof value === 'string' ? value : '';
}

function clip(text: string, maximum: number): string {
    const collapsed = text.split(/\s+/).filter(Boolean).join(' ');
    return collapsed.length > maximum ? `${collapsed.slice(0, maximum - 1)}…` : collapsed;
}

// Work a prompt as a task tree on the background model, holding the model for the whole run.
// A run that foreground work stops is deferred, and a run for outside content may only research and write.
export async function runEventTree(prompt: string, trust: 'user' | 'external', { settings, options, runTree }: EventContext): Promise<string> {
    const [modelPath, contextSize, gpuLayers] = backgroundModelKey(settings);
    if (options.shouldPause?.()) {
        throw new BackgroundPaused();
    }
    await options.modelLock?.acquire();
    try {
        return await runTree(prompt, {
            modelPath,
            contextSize,
            gpuLayers,
            maxTokens: settings.max_tokens,
            temperature: settings.temperature,
            filesystemRoot: settings.filesystem_root,
            maxToolCalls: settings.max_tool_calls,
            maxSearchResults: settings.max_search_results,
            knowledgeDbPath: settings.knowledge_db_path,
            embeddingModelPath: settings.embedding_model_path,
            maxPendingResearchJobs: settings.background_max_pending_jobs,
            maxTaskDepth: settings.max_task_depth,
            maxTaskNodes: settings.max_task_nodes,
            // Nobody is there to approve a change, so an event's run never makes one, whoever wrote the event.
            allowFileWrites: false,
            enableTestExecution: false,
            mcpServers: [],
            mode: 'answer',
            confirmActions: true,
            trust,
            llm: options.llm ?? null,
            modelCache: options.modelCache ?? null,
            progressCallback: options.onProgress ?? undefined,
            shouldStop: options.shouldPause ?? undefined,
        });
    } catch (error) {
        if (error instanceof RunStopped) {
            throw new BackgroundPaused();
        }
        throw error;
    } finally {
        options.modelLock?.release();
    }
}

// An email that needs an answer gets a reply drafted from what the owner's notes know; the draft is only proposed.
// A draft that fails a non-model check is still proposed, with a note saying what to check.
export const draftReplyHandler: EventHandler = async (event: EventRecord, context: EventContext): Promise<EventOutcome> => {
    const { payload } = event;
    const thread: MailThread = {
        from: field(payload, 'from'),
        to: field(payload, 'to'),
        subject: field(payload, 'subject'),
        date: field(payload, 'date'),
        body: field(payload, 'body').slice(0, MAX_MAIL_PROMPT_CHARS),
    };
    const mail = `From: ${thread.from}\nSubject: ${thread.subject}\nDate: ${thread.date}\n\n${thread.body}`;
    // External: the sender wrote this prompt's content, so the run is held to research and writing.
    const written = await runEventTree(`${DRAFT_PROMPT}\n\nEmail:\n${untrustedBlock(mail)}`, 'external', context);
    const answer = clip(written, MAX_DRAFT_CHARS);
    if (!answer) {
        return { status: 'ignored', detail: 'The model wrote no draft.' };
    }
    const recipient = senderAddress(thread.from) || thread.from;
    const subject = replySubject(thread.subject);
    const checks = draftChecks(written, recipient, subject, thread);
    const note = checkNote(checks);
    const title = clip(`Reply to ${thread.from || 'sender'}: ${thread.subject || '(no subject)'}`, MAX_TITLE_CHARS);
    const actionId = context.store.addAction({
        eventId: event.id,
        kind: 'draft',
        title,
        body: note ? `${answer}\n\n${note}` : answer,
        payload: { message_id: field(payload, 'message_id'), source: event.source, file: field(payload, 'file'), to: recipient, subject },
    });
    const outcomeId = payload.mail_outcome_id;
    if (typeof outcomeId === 'number' && Number.isInteger(outcomeId)) {
        context.store.recordMailDraft(outcomeId, actionId, answer, checks.map((check) => check.name));
    }
    return { status: 'done', detail: `Proposed action ${actionId}` };
};

// A request the user left for the assistant to work while idle; the answer waits in the Inbox.
export const userRequestHandler: EventHandler = async (event, context): Promise<EventOutcome> => {
    const prompt = field(event.payload, 'prompt').trim();
    if (!prompt) {
        return { status: 'ignored', detail: 'A user request needs a prompt.' };
    }
    // Asked by the user, so it may use the web and local files; it still cannot change anything unattended.
    const answer = clip(await runEventTree(prompt, event.trust, context), MAX_DRAFT_CHARS);
    if (!answer) {
        return { status: 'ignored', detail: 'The model gave no answer.' };
    }
    const actionId = context.store.addAction({ eventId: event.id, kind: 'result', title: clip(prompt, MAX_TITLE_CHARS), body: answer });
    return { status: 'done', detail: `Proposed action ${actionId}` };
};
