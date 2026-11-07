// The CODEX daemon: owns the model, runs requests and background research, and serves interfaces over a Unix socket.
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, resolve } from 'node:path';

import { autoSize } from '../core/autoSize.js';
import { indexKnowledge, learnFromEpisodes, researchOneTopic, type BackgroundOptions, type ModelLock } from '../core/background.js';
import { consolidateKnowledge } from '../core/consolidation.js';
import { refreshEnvironment } from '../core/environment.js';
import { handleNextEvent } from '../core/events.js';
import {
    ACTION_RESOLUTIONS,
    EVENT_TRUSTS,
    KnowledgeStore,
    RESUMABLE_TASK_RUN_STATUSES,
    type ActionResolution,
    type EventTrust,
    type NewEvent,
    type TaskRun,
} from '../core/knowledge.js';
import { MAIL_CLASSES, type MailClass } from '../core/mailChecks.js';
import { ImapConnector } from '../core/imap.js';
import { MailConnector } from '../core/mail.js';
import { ModelCache } from '../core/model.js';
import { runNextJob, type BackgroundStep, type Job } from '../core/scheduler.js';
import { titleConversations } from '../core/titles.js';
import { backgroundModelKey, defaultSettingsPath, expandUser, saveSettings, validateSettings, type Settings } from '../core/settings.js';
import { executeTaskTree, RunStopped, savedRunOptions, type ExecuteTaskTreeOptions } from '../core/taskTree.js';
import { LineReader } from '../main/daemonBridge.js';
import { decodeMessage, encodeMessage } from '../shared/protocol.js';

// A separate background model is unloaded after this long without background work, to give its memory back.
export const BACKGROUND_MODEL_IDLE_SECONDS = 300;

// How long closing waits for interfaces to hang up before it drops them.
const CLOSE_GRACE_MILLISECONDS = 1000;

export class RunCancelled extends Error {
    constructor() {
        super('The run was cancelled.');
        this.name = 'RunCancelled';
    }
}

type Json = Record<string, unknown>;

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Json {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ============================================================================
// Locks and wakeups
// ============================================================================

// An async mutex: one holder at a time, the rest wait in the order they asked.
export class AsyncLock implements ModelLock {
    private held = false;
    private readonly waiters: Array<() => void> = [];

    get locked(): boolean {
        return this.held;
    }

    acquire(): Promise<void> {
        if (!this.held) {
            this.held = true;
            return Promise.resolve();
        }
        return new Promise((resolveWaiter) => this.waiters.push(resolveWaiter));
    }

    release(): void {
        const next = this.waiters.shift();
        if (next !== undefined) {
            next();
        } else {
            this.held = false;
        }
    }

    async withLock<T>(work: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await work();
        } finally {
            this.release();
        }
    }
}

// A flag the background loop sleeps on, waking early when someone sets it.
class Wakeup {
    private isSet = false;
    private waiter: (() => void) | null = null;

    set(): void {
        this.isSet = true;
        this.waiter?.();
    }

    clear(): void {
        this.isSet = false;
    }

    wait(seconds: number): Promise<void> {
        if (this.isSet) {
            return Promise.resolve();
        }
        return new Promise((resolveWait) => {
            const done = (): void => {
                clearTimeout(timer);
                this.waiter = null;
                resolveWait();
            };
            const timer = setTimeout(done, seconds * 1000);
            this.waiter = done;
        });
    }
}

// ============================================================================
// Connections and run state
// ============================================================================

// One connected interface; its requests are answered one at a time, in the order they came.
export class ClientConnection {
    closed = false;
    queue: Promise<void> = Promise.resolve();

    constructor(readonly socket: Socket) {}

    send(message: Json): void {
        if (this.closed || this.socket.destroyed || !this.socket.writable) {
            this.closed = true;
            return;
        }
        this.socket.write(encodeMessage(message), (error) => {
            if (error) {
                this.closed = true;
            }
        });
    }
}

class Clarification {
    readonly answered: Promise<string>;
    answer = '';
    private resolveAnswer!: (answer: string) => void;

    constructor(
        readonly id: number,
        readonly question: string,
    ) {
        this.answered = new Promise((resolveAnswer) => {
            this.resolveAnswer = resolveAnswer;
        });
    }

    give(answer: string): void {
        this.answer = answer;
        this.resolveAnswer(answer);
    }
}

export class ActiveRun {
    tree: unknown[] = [];
    progress: string[] = [];
    outputs: Record<string, string> = {};
    inputs: Record<string, { system: string; input: string }> = {};
    clarification: Clarification | null = null;
    readonly cancelRequested = new AbortController();

    constructor(
        readonly id: number,
        readonly prompt: string,
        readonly owner: ClientConnection | null,
    ) {}

    cancel(): void {
        if (!this.cancelRequested.signal.aborted) {
            this.cancelRequested.abort(new RunCancelled());
        }
    }

    get cancelled(): boolean {
        return this.cancelRequested.signal.aborted;
    }

    snapshot(): Json {
        return {
            run_id: this.id,
            prompt: this.prompt,
            tree: [...this.tree],
            progress: [...this.progress],
            outputs: { ...this.outputs },
            inputs: { ...this.inputs },
        };
    }
}

// ============================================================================
// Daemon
// ============================================================================

// The work the daemon hands to other modules, replaceable so tests can run without a model.
export type DaemonDependencies = {
    executeTaskTree: (userPrompt: string, options: ExecuteTaskTreeOptions) => Promise<string>;
    autoSize: typeof autoSize;
    researchOneTopic: BackgroundStep;
    indexKnowledge: BackgroundStep;
    learnFromEpisodes: BackgroundStep;
    consolidateKnowledge: BackgroundStep;
    titleConversations: BackgroundStep;
    pollConnectors: BackgroundStep;
    handleEvents: BackgroundStep;
    refreshEnvironment: (settings: Settings) => Promise<boolean>;
    // Seconds on a clock that only moves forward.
    monotonic: () => number;
};

const defaultMailConnector = new MailConnector();
const defaultImapConnector = new ImapConnector();

const DEFAULT_DEPENDENCIES: DaemonDependencies = {
    executeTaskTree,
    autoSize,
    researchOneTopic,
    indexKnowledge,
    learnFromEpisodes,
    consolidateKnowledge,
    titleConversations,
    pollConnectors: async (settings, options) => {
        const maildir = await defaultMailConnector.poll(settings, options);
        const imap = await defaultImapConnector.poll(settings, options);
        return maildir || imap;
    },
    handleEvents: (settings, options) => handleNextEvent(settings, options),
    refreshEnvironment: (settings) => refreshEnvironment(settings),
    monotonic: () => performance.now() / 1000,
};

type MethodHandler = (connection: ClientConnection | null, params: Json) => unknown;
type Method = { params: readonly string[]; handler: MethodHandler };

function text(value: unknown, name: string, fallback: string): string {
    if (value === undefined || value === null) {
        return fallback;
    }
    if (typeof value !== 'string') {
        throw new Error(`${name} must be a string.`);
    }
    return value;
}

function integer(value: unknown, name: string, fallback: number): number {
    if (value === undefined) {
        return fallback;
    }
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new Error(`${name} must be an integer.`);
    }
    return value;
}

function optionalInteger(value: unknown, name: string): number | null {
    return value === undefined || value === null ? null : integer(value, name, 0);
}

function settingsObject(value: unknown): Json {
    if (value === undefined || value === null) {
        return {};
    }
    if (!isObject(value)) {
        throw new Error('settings must be a JSON object.');
    }
    return value;
}

function eventTrust(value: unknown): EventTrust {
    const trust = text(value, 'trust', 'external');
    if (!(EVENT_TRUSTS as readonly string[]).includes(trust)) {
        throw new Error(`trust must be one of: ${EVENT_TRUSTS.join(', ')}.`);
    }
    return trust as EventTrust;
}

function actionResolution(value: unknown): ActionResolution {
    const resolution = text(value, 'resolution', '');
    if (!(ACTION_RESOLUTIONS as readonly string[]).includes(resolution)) {
        throw new Error(`resolution must be one of: ${ACTION_RESOLUTIONS.join(', ')}.`);
    }
    return resolution as ActionResolution;
}

function mailClass(value: unknown): MailClass {
    const chosen = text(value, 'mail_class', '');
    if (!(MAIL_CLASSES as readonly string[]).includes(chosen)) {
        throw new Error(`mail_class must be one of: ${MAIL_CLASSES.join(', ')}.`);
    }
    return chosen as MailClass;
}

function flag(value: unknown, fallback: boolean): boolean {
    return value === undefined ? fallback : Boolean(value);
}

export type HarnessDaemonOptions = {
    exitWhenUnusedSeconds?: number | null;
    dependencies?: Partial<DaemonDependencies>;
};

// Owns the model, runs requests and background research, and serves interfaces over a socket.
export class HarnessDaemon {
    settings: Settings;
    readonly settingsPath: string;
    readonly exitWhenUnusedSeconds: number | null;
    readonly modelLock = new AsyncLock();
    readonly modelCache = new ModelCache();
    // A background model other than the main one gets its own cache and lock, so neither evicts the other.
    readonly backgroundModelLock = new AsyncLock();
    readonly backgroundModelCache = new ModelCache();
    backgroundStatus = 'Idle';
    backgroundOutput = '';
    stopping = false;
    private readonly dependencies: DaemonDependencies;
    private readonly clients = new Set<ClientConnection>();
    private run: ActiveRun | null = null;
    private runTask: Promise<void> | null = null;
    private nextRunId = 1;
    private nextClarificationId = 1;
    private backgroundIdleSince: number | null = null;
    private readonly knowledgeStores = new Map<string, KnowledgeStore>();
    private readonly workerWakeup = new Wakeup();
    private backgroundRunRequested = false;
    private worker: Promise<void> | null = null;
    // True while suspended: the models are unloaded and no work starts.
    suspended = false;
    private server: Server | null = null;
    private socketPath: string | null = null;
    private unusedTimer: ReturnType<typeof setTimeout> | null = null;
    private closing: Promise<void> | null = null;
    private readonly stopped: Promise<void>;
    private resolveStopped!: () => void;
    private readonly methods: Map<string, Method>;

    constructor(settings: Record<string, unknown>, settingsPath: string | null = null, options: HarnessDaemonOptions = {}) {
        this.settings = validateSettings({ ...settings });
        this.exitWhenUnusedSeconds = options.exitWhenUnusedSeconds ?? null;
        this.settingsPath = settingsPath ? expandUser(settingsPath) : defaultSettingsPath();
        this.dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
        this.stopped = new Promise((resolveStopped) => {
            this.resolveStopped = resolveStopped;
        });
        const method = (params: readonly string[], handler: MethodHandler): Method => ({ params, handler });
        this.methods = new Map<string, Method>([
            ['status', method([], () => this.status())],
            ['get_settings', method([], () => this.getSettings())],
            ['apply_settings', method(['settings'], (_, params) => this.applySettings(settingsObject(params.settings)))],
            ['save_settings', method(['settings'], (_, params) => this.saveSettings(settingsObject(params.settings)))],
            [
                'auto_size',
                method(['model_path', 'gpu_layers', 'background_model_path', 'background_gpu_layers'], (_, params) =>
                    this.autoSize({
                        modelPath: text(params.model_path, 'model_path', ''),
                        gpuLayers: integer(params.gpu_layers, 'gpu_layers', -1),
                        backgroundModelPath: text(params.background_model_path, 'background_model_path', ''),
                        backgroundGpuLayers: integer(params.background_gpu_layers, 'background_gpu_layers', 0),
                    }),
                ),
            ],
            ['set_background_enabled', method(['enabled'], (_, params) => this.setBackgroundEnabled(flag(params.enabled, true)))],
            [
                'run',
                method(['prompt', 'settings', 'interactive'], (connection, params) =>
                    this.startRun(connection, text(params.prompt, 'prompt', ''), settingsObject(params.settings), flag(params.interactive, true)),
                ),
            ],
            ['cancel', method(['run_id'], (_, params) => this.cancelRun(optionalInteger(params.run_id, 'run_id')))],
            [
                'answer_clarification',
                method(['run_id', 'clarification_id', 'answer'], (_, params) =>
                    this.answerClarification(
                        integer(params.run_id, 'run_id', 0),
                        integer(params.clarification_id, 'clarification_id', 0),
                        text(params.answer, 'answer', ''),
                    ),
                ),
            ],
            [
                'queue_topic',
                method(['topic', 'priority'], (_, params) => this.queueTopic(text(params.topic, 'topic', ''), params.priority ?? 0)),
            ],
            [
                'post_event',
                method(['source', 'type', 'payload', 'dedupe_key', 'trust', 'priority'], (_, params) =>
                    this.postEvent({
                        source: text(params.source, 'source', ''),
                        type: text(params.type, 'type', ''),
                        payload: settingsObject(params.payload),
                        dedupeKey: text(params.dedupe_key, 'dedupe_key', ''),
                        trust: eventTrust(params.trust),
                        priority: integer(params.priority, 'priority', 0),
                    }),
                ),
            ],
            [
                'queue_request',
                method(['prompt'], (_, params) => this.queueRequest(text(params.prompt, 'prompt', ''))),
            ],
            ['events', method(['limit'], (_, params) => this.events(integer(params.limit, 'limit', 100)))],
            [
                'actions',
                method(['status', 'limit'], (_, params) =>
                    this.actions(params.status === undefined ? null : text(params.status, 'status', ''), integer(params.limit, 'limit', 100)),
                ),
            ],
            [
                'resolve_action',
                method(['action_id', 'resolution'], (_, params) =>
                    this.resolveAction(integer(params.action_id, 'action_id', 0), actionResolution(params.resolution)),
                ),
            ],
            [
                'mail_outcomes',
                method(['limit', 'since'], (_, params) =>
                    this.mailOutcomes(integer(params.limit, 'limit', 100), integer(params.since, 'since', 0)),
                ),
            ],
            ['sender_rules', method([], () => this.senderRules())],
            [
                'set_sender_rule',
                method(['pattern', 'mail_class'], (_, params) => this.setSenderRule(text(params.pattern, 'pattern', ''), mailClass(params.mail_class))),
            ],
            ['delete_sender_rule', method(['pattern'], (_, params) => this.deleteSenderRule(text(params.pattern, 'pattern', '')))],
            ['research_now', method([], () => this.researchNow())],
            ['queue_status', method([], () => this.queueStatus())],
            [
                'knowledge',
                method(['query'], (_, params) => this.knowledge(text(params.query, 'query', ''))),
            ],
            ['unfinished_runs', method([], () => this.unfinishedRuns())],
            [
                'resume_run',
                method(['run_id', 'interactive'], (connection, params) =>
                    this.resumeRun(connection, integer(params.run_id, 'run_id', 0), flag(params.interactive, true)),
                ),
            ],
            ['discard_run', method(['run_id'], (_, params) => this.discardRun(integer(params.run_id, 'run_id', 0)))],
            ['suspend', method([], () => this.suspend())],
            ['resume', method([], () => this.resume())],
            ['shutdown', method([], () => this.shutdown())],
        ]);
    }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    startBackgroundWorker(): void {
        // A daemon stopped mid-job leaves that job running, and nothing else would ever pick it up again.
        const store = this.knowledgeStore(this.getSettings().knowledge_db_path);
        store.requeueInterruptedJobs();
        store.requeueInterruptedEvents();
        this.worker = this.backgroundLoop();
    }

    async bind(socketPath: string): Promise<Server> {
        const path = resolve(socketPath);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        if (existsSync(path)) {
            if (await socketAnswers(path)) {
                throw new Error(`A CODEX daemon is already listening on ${path}.`);
            }
            rmSync(path, { force: true });
        }
        const server = createServer((socket) => this.serveClient(socket));
        await new Promise<void>((resolveListen, rejectListen) => {
            server.once('error', rejectListen);
            server.listen(path, () => {
                server.off('error', rejectListen);
                resolveListen();
            });
        });
        chmodSync(path, 0o600);
        this.server = server;
        this.socketPath = path;
        this.scheduleUnusedExit();
        return server;
    }

    // Resolves once shutdown is asked for, by a request, a signal, or no interface staying connected.
    serveForever(): Promise<void> {
        return this.stopped;
    }

    shutdown(): Json {
        this.stopping = true;
        this.workerWakeup.set();
        this.run?.cancel();
        this.resolveStopped();
        return {};
    }

    private scheduleUnusedExit(): void {
        if (this.exitWhenUnusedSeconds === null || this.clients.size > 0 || this.unusedTimer !== null || this.stopping) {
            return;
        }
        this.unusedTimer = setTimeout(() => this.exitIfUnused(), this.exitWhenUnusedSeconds * 1000);
    }

    private exitIfUnused(): void {
        this.unusedTimer = null;
        if (this.clients.size > 0) {
            return;
        }
        this.shutdown();
    }

    // Stops serving, waits for the run and the background loop to end, then unloads the models to free the GPU.
    close(): Promise<void> {
        this.closing ??= this.closeOnce();
        return this.closing;
    }

    private async closeOnce(): Promise<void> {
        this.shutdown();
        if (this.unusedTimer !== null) {
            clearTimeout(this.unusedTimer);
            this.unusedTimer = null;
        }
        const server = this.server;
        if (server !== null) {
            const closed = new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
            for (const client of this.clients) {
                client.socket.end();
            }
            await Promise.race([closed, new Promise((resolveGrace) => setTimeout(resolveGrace, CLOSE_GRACE_MILLISECONDS))]);
            for (const client of this.clients) {
                client.socket.destroy();
            }
            if (this.socketPath !== null) {
                rmSync(this.socketPath, { force: true });
            }
        }
        await this.runTask;
        await this.worker;
        await this.modelLock.withLock(() => this.modelCache.unload());
        await this.backgroundModelLock.withLock(() => this.backgroundModelCache.unload());
    }

    // ========================================================================
    // Connections and events
    // ========================================================================

    private serveClient(socket: Socket): void {
        const connection = new ClientConnection(socket);
        this.clients.add(connection);
        if (this.unusedTimer !== null) {
            clearTimeout(this.unusedTimer);
            this.unusedTimer = null;
        }
        const reader = new LineReader();
        socket.on('data', (chunk: Buffer) => {
            for (const line of reader.push(chunk)) {
                connection.queue = connection.queue.then(() => this.dispatch(connection, line));
            }
        });
        socket.on('error', () => undefined);
        socket.once('close', () => {
            connection.closed = true;
            this.clients.delete(connection);
            // A run belongs to the interface that started it, so it stops when that interface leaves.
            if (this.run !== null && this.run.owner === connection) {
                this.run.cancel();
            }
            this.scheduleUnusedExit();
        });
    }

    private async dispatch(connection: ClientConnection, line: string): Promise<void> {
        let message: Json;
        try {
            message = decodeMessage(line);
        } catch (error) {
            connection.send({ id: null, error: `Invalid message: ${errorText(error)}` });
            return;
        }
        const requestId = message.id ?? null;
        const name = message.method === undefined || message.method === null ? 'None' : String(message.method);
        const params = message.params ?? {};
        try {
            const method = this.methods.get(name);
            if (method === undefined) {
                throw new Error(`Unknown method: ${name}`);
            }
            if (!isObject(params)) {
                throw new Error('params must be a JSON object.');
            }
            const unexpected = Object.keys(params).find((key) => !method.params.includes(key));
            if (unexpected !== undefined) {
                throw new Error(`${name}() got an unexpected keyword argument '${unexpected}'`);
            }
            const result = await method.handler(connection, params);
            connection.send({ id: requestId, result: result ?? null });
        } catch (error) {
            connection.send({ id: requestId, error: errorText(error) });
        }
    }

    broadcast(event: string, data: Json = {}): void {
        for (const client of [...this.clients]) {
            client.send({ event, data });
        }
    }

    // ========================================================================
    // Settings and status
    // ========================================================================

    status(): Json {
        return {
            settings: this.getSettings(),
            settings_path: this.settingsPath,
            run: this.run !== null ? this.run.snapshot() : null,
            background: { status: this.backgroundStatus, output: this.backgroundOutput },
            suspended: this.suspended,
            unfinished_runs: this.unfinishedRuns(),
        };
    }

    getSettings(): Settings {
        return { ...this.settings };
    }

    applySettings(settings: Json = {}): Settings {
        const validated = validateSettings({ ...this.getSettings(), ...settings });
        this.settings = validated;
        this.workerWakeup.set();
        this.broadcast('settings.changed', { settings: validated });
        return validated;
    }

    saveSettings(settings: Json = {}): Json {
        const validated = this.applySettings(settings);
        const saved = saveSettings(this.settingsPath, validated);
        return { settings: saved, path: this.settingsPath };
    }

    // Suggest a context size and token limits for the models without applying them; a separate background model is sized on its own.
    async autoSize(
        options: { modelPath?: string; gpuLayers?: number; backgroundModelPath?: string; backgroundGpuLayers?: number } = {},
    ): Promise<Json> {
        const settings = this.getSettings();
        const modelPath = options.modelPath || settings.model_path;
        const gpuLayers = options.gpuLayers ?? -1;
        const backgroundGpuLayers = options.backgroundGpuLayers ?? 0;
        const loaded = this.modelCache.has(modelPath, settings.context_size, gpuLayers);
        const main = await this.dependencies.autoSize(modelPath, gpuLayers, loaded ? settings.context_size : null);
        const choice: Json = { ...main, background_context_size: 0 };
        const backgroundModelPath = (options.backgroundModelPath ?? '').trim();
        if (backgroundModelPath) {
            const [, loadedContext] = backgroundModelKey(settings);
            const backgroundLoaded = this.backgroundModelCache.has(backgroundModelPath, loadedContext, backgroundGpuLayers);
            const background = await this.dependencies.autoSize(backgroundModelPath, backgroundGpuLayers, backgroundLoaded ? loadedContext : null);
            choice.background_context_size = background.context_size;
            choice.background_max_tokens = background.background_max_tokens;
            choice.explanation = `${main.explanation}; background ${background.explanation}`;
        }
        return choice;
    }

    setBackgroundEnabled(enabled = true): Settings {
        return this.applySettings({ background_research_enabled: Boolean(enabled) });
    }

    // ========================================================================
    // Foreground run
    // ========================================================================

    startRun(connection: ClientConnection | null, prompt = '', settings: Json = {}, interactive = true): Json {
        const trimmed = prompt.trim();
        if (!trimmed) {
            throw new Error('The prompt cannot be empty.');
        }
        this.refuseWhileSuspended();
        const runSettings = validateSettings({ ...this.getSettings(), ...settings });
        return this.launchRun(connection, trimmed, runSettings, interactive, null);
    }

    // Carry on a task tree run that a crash, a restart, or a cancel left unfinished.
    resumeRun(connection: ClientConnection | null, runId = 0, interactive = true): Json {
        const saved = this.knowledgeStore(this.getSettings().knowledge_db_path).taskRun(runId);
        if (saved === null || saved.state === null || !(RESUMABLE_TASK_RUN_STATUSES as readonly string[]).includes(String(saved.status))) {
            throw new Error(`Task tree run ${runId} cannot be resumed.`);
        }
        return this.launchRun(connection, String(saved.prompt), null, interactive, saved);
    }

    discardRun(runId = 0): Json {
        this.knowledgeStore(this.getSettings().knowledge_db_path).setTaskRunStatus(runId, 'discarded');
        this.broadcast('runs.changed');
        return {};
    }

    unfinishedRuns(): Json[] {
        return this.knowledgeStore(this.getSettings().knowledge_db_path).unfinishedTaskRuns();
    }

    private launchRun(
        connection: ClientConnection | null,
        prompt: string,
        settings: Settings | null,
        interactive: boolean,
        saved: TaskRun | null,
    ): Json {
        this.refuseWhileSuspended();
        if (this.run !== null) {
            throw new Error('Another request is already running.');
        }
        const run = new ActiveRun(this.nextRunId, prompt, connection);
        this.nextRunId += 1;
        this.run = run;
        this.workerWakeup.set();
        this.broadcast('run.started', { run_id: run.id, prompt });
        this.runTask = this.executeRun(run, settings, interactive, saved);
        return { run_id: run.id };
    }

    cancelRun(runId: number | null = null): Json {
        const run = this.run;
        if (run === null || (runId !== null && run.id !== runId)) {
            return { cancelled: false };
        }
        run.cancel();
        return { cancelled: true };
    }

    answerClarification(runId = 0, clarificationId = 0, answer = ''): Json {
        const run = this.run;
        const clarification = run !== null && run.id === runId ? run.clarification : null;
        if (clarification === null || clarification.id !== clarificationId) {
            return { accepted: false };
        }
        clarification.give(answer);
        return { accepted: true };
    }

    // Run a request with these settings, or resume the saved task tree run under the options it started with.
    private async executeRun(run: ActiveRun, settings: Settings | null, interactive: boolean, saved: TaskRun | null): Promise<void> {
        const raiseIfCancelled = (): void => {
            if (run.cancelled || this.stopping) {
                throw new RunCancelled();
            }
        };
        const reportProgress = (label: string): void => {
            raiseIfCancelled();
            run.progress.push(label);
            this.broadcast('run.progress', { run_id: run.id, label });
        };
        const reportToken = (label: string, token: string): void => {
            raiseIfCancelled();
            run.outputs[label] = (run.outputs[label] ?? '') + token;
            this.broadcast('run.token', { run_id: run.id, label, token });
        };
        const reportInput = (label: string, system: string, input: string): void => {
            raiseIfCancelled();
            run.inputs[label] = { system, input };
            this.broadcast('run.input', { run_id: run.id, label, system, input });
        };
        const reportTree = (nodes: unknown[]): void => {
            raiseIfCancelled();
            run.tree = nodes;
            this.broadcast('run.tree', { run_id: run.id, nodes });
        };
        const askClarification = async (question: string): Promise<string> => {
            raiseIfCancelled();
            const clarification = new Clarification(this.nextClarificationId, question);
            this.nextClarificationId += 1;
            run.clarification = clarification;
            // Only the interface that started the run is asked.
            run.owner?.send({
                event: 'run.clarification',
                data: { run_id: run.id, clarification_id: clarification.id, question },
            });
            const signal = run.cancelRequested.signal;
            let onAbort = (): void => undefined;
            const cancelled = new Promise<never>((_, rejectCancelled) => {
                onAbort = () => rejectCancelled(new RunCancelled());
                signal.addEventListener('abort', onAbort, { once: true });
            });
            try {
                return await Promise.race([clarification.answered, cancelled]);
            } finally {
                signal.removeEventListener('abort', onAbort);
                run.clarification = null;
            }
        };

        const callbacks: ExecuteTaskTreeOptions = {
            showThinking: false,
            clarificationCallback: interactive ? askClarification : null,
            // A resumed run keeps the options it started with, but asks before acting as the current settings say.
            confirmActions: (settings ?? this.getSettings()).confirm_actions,
            progressCallback: reportProgress,
            stageOutputCallback: reportToken,
            stageInputCallback: reportInput,
            treeCallback: reportTree,
            modelCache: this.modelCache,
            signal: run.cancelRequested.signal,
            shouldStop: () => run.cancelled || this.stopping,
        };
        let event = 'run.finished';
        let data: Json = {};
        try {
            await this.modelLock.acquire();
            try {
                raiseIfCancelled();
                if (saved !== null) {
                    data.result = await this.dependencies.executeTaskTree(String(saved.prompt), {
                        ...savedRunOptions(saved.options),
                        ...callbacks,
                        resumeRunId: Number(saved.id),
                    });
                } else {
                    const runSettings = settings!;
                    data.result = await this.dependencies.executeTaskTree(run.prompt, {
                        modelPath: runSettings.model_path,
                        contextSize: runSettings.context_size,
                        gpuLayers: runSettings.gpu_layers,
                        maxTokens: runSettings.max_tokens,
                        temperature: runSettings.temperature,
                        filesystemRoot: runSettings.filesystem_root,
                        maxToolCalls: runSettings.max_tool_calls,
                        maxSearchResults: runSettings.max_search_results,
                        enableTestExecution: runSettings.enable_test_execution,
                        allowFileWrites: runSettings.allow_file_writes,
                        mcpServers: runSettings.mcp_servers,
                        knowledgeDbPath: runSettings.knowledge_db_path,
                        embeddingModelPath: runSettings.embedding_model_path,
                        maxPendingResearchJobs: runSettings.background_max_pending_jobs,
                        mode: runSettings.mode,
                        ...callbacks,
                        maxTaskDepth: runSettings.max_task_depth,
                        maxTaskNodes: runSettings.max_task_nodes,
                    });
                }
            } finally {
                this.modelLock.release();
            }
        } catch (error) {
            if (error instanceof RunCancelled || error instanceof RunStopped || run.cancelled) {
                event = 'run.cancelled';
            } else {
                event = 'run.failed';
                data = { message: errorText(error) };
            }
        }
        // The run is cleared first so a client may start the next one as soon as it hears this one ended.
        this.run = null;
        this.workerWakeup.set();
        this.broadcast(event, { run_id: run.id, ...data });
        // A run that ended, or stopped, changes the list of runs that can be resumed.
        this.broadcast('runs.changed');
    }

    // ========================================================================
    // Events and actions
    // ========================================================================

    postEvent(event: NewEvent): Json {
        const posted = this.knowledgeStore(this.getSettings().knowledge_db_path).enqueueEvent(event);
        if (!posted.duplicate) {
            this.workerWakeup.set();
            this.broadcast('events.changed');
        }
        return posted;
    }

    // Leaves a request for the assistant to work while idle; its answer waits in the Inbox.
    queueRequest(prompt: string): Json {
        const trimmed = prompt.trim();
        if (!trimmed) {
            throw new Error('A request needs a prompt.');
        }
        return this.postEvent({ source: 'user', type: 'user.request', trust: 'user', payload: { prompt: trimmed }, priority: 1 });
    }

    events(limit = 100): Json[] {
        return this.knowledgeStore(this.getSettings().knowledge_db_path).events(limit);
    }

    actions(status: string | null = null, limit = 100): Json[] {
        return this.knowledgeStore(this.getSettings().knowledge_db_path).actions(status, limit);
    }

    resolveAction(actionId: number, resolution: ActionResolution): Json {
        const settings = this.getSettings();
        const resolved = this.knowledgeStore(settings.knowledge_db_path).resolveAction(actionId, resolution, {
            senderRuleThreshold: settings.mail_rule_proposal_threshold,
        });
        if (resolved) {
            this.broadcast('actions.changed');
        }
        return { resolved };
    }

    // Recent mail outcomes and, per triage class, how often the user kept or dismissed what was shown.
    mailOutcomes(limit = 100, since = 0): Json {
        const store = this.knowledgeStore(this.getSettings().knowledge_db_path);
        return { outcomes: store.mailOutcomes(limit), summary: store.mailOutcomeSummary(since) };
    }

    senderRules(): Json[] {
        return this.knowledgeStore(this.getSettings().knowledge_db_path).senderRules();
    }

    setSenderRule(pattern: string, chosenClass: MailClass): Json {
        return this.knowledgeStore(this.getSettings().knowledge_db_path).setSenderRule(pattern, chosenClass, 'user');
    }

    deleteSenderRule(pattern: string): Json {
        return { deleted: this.knowledgeStore(this.getSettings().knowledge_db_path).deleteSenderRule(pattern) };
    }

    // ========================================================================
    // Background research
    // ========================================================================

    queueTopic(topic = '', priority: unknown = 0): Json {
        const name = topic.trim();
        if (!name) {
            throw new Error('Enter a topic to research.');
        }
        if (typeof priority !== 'number' || !Number.isInteger(priority)) {
            throw new Error('priority must be an integer.');
        }
        const settings = this.getSettings();
        const jobId = this.knowledgeStore(settings.knowledge_db_path).enqueueTopic(name, {
            priority,
            maxPending: settings.background_max_pending_jobs,
        });
        this.workerWakeup.set();
        this.broadcast('queue.changed');
        return { job_id: jobId };
    }

    researchNow(): Json {
        const jobs = this.queueStatus();
        if (!jobs.some((job) => job.status === 'pending')) {
            throw new Error('Queue a topic before starting research.');
        }
        this.backgroundRunRequested = true;
        this.workerWakeup.set();
        return {};
    }

    queueStatus(): Json[] {
        return this.knowledgeStore(this.getSettings().knowledge_db_path).queueStatus();
    }

    private setBackgroundStatus(message: string): void {
        if (message === this.backgroundStatus) {
            return;
        }
        this.backgroundStatus = message;
        if (message.startsWith('Searching:')) {
            this.backgroundOutput = '';
        }
        this.broadcast('background.status', { message });
    }

    private appendBackgroundToken(token: string): void {
        this.backgroundOutput += token;
        this.broadcast('background.token', { token });
    }

    private runIsActive(): boolean {
        return this.run !== null;
    }

    // Return the lock and cache background work uses, freeing a separate model it no longer needs.
    async backgroundModel(settings: Settings): Promise<[AsyncLock, ModelCache]> {
        const [path, contextSize, gpuLayers] = backgroundModelKey(settings);
        if (path === settings.model_path && contextSize === settings.context_size && gpuLayers === settings.gpu_layers) {
            await this.backgroundModelLock.withLock(() => this.backgroundModelCache.unload());
            return [this.modelLock, this.modelCache];
        }
        return [this.backgroundModelLock, this.backgroundModelCache];
    }

    async unloadIdleBackgroundModel(worked: boolean): Promise<void> {
        if (worked) {
            this.backgroundIdleSince = null;
            return;
        }
        const now = this.dependencies.monotonic();
        if (this.backgroundIdleSince === null) {
            this.backgroundIdleSince = now;
        } else if (now - this.backgroundIdleSince >= BACKGROUND_MODEL_IDLE_SECONDS) {
            const unloaded = await this.backgroundModelLock.withLock(() => this.backgroundModelCache.unload());
            if (unloaded) {
                this.setBackgroundStatus('Idle; background model unloaded');
            }
        }
    }

    // Connectors queue events and events are handled first, then titling conversations, queued research, indexing what it found, learning from past requests, and tidying.
    private backgroundJobs(): Job[] {
        const { pollConnectors, handleEvents, titleConversations, researchOneTopic, indexKnowledge, learnFromEpisodes, consolidateKnowledge } = this.dependencies;
        return [
            { name: 'poll_connectors', jobClass: 'reactive', step: pollConnectors },
            { name: 'handle_events', jobClass: 'reactive', step: handleEvents },
            { name: 'title', jobClass: 'maintenance', step: titleConversations },
            { name: 'research', jobClass: 'maintenance', step: researchOneTopic },
            { name: 'index', jobClass: 'maintenance', step: indexKnowledge },
            { name: 'learn', jobClass: 'maintenance', step: learnFromEpisodes },
            { name: 'consolidate', jobClass: 'maintenance', step: consolidateKnowledge },
        ];
    }

    private async backgroundLoop(): Promise<void> {
        while (!this.stopping) {
            const settings = this.getSettings();
            let worked = false;
            let waitSeconds: number;
            const manualRunRequested = this.backgroundRunRequested;
            if (this.suspended) {
                this.setBackgroundStatus('Suspended');
                waitSeconds = 1;
            } else if (!settings.background_research_enabled && !manualRunRequested) {
                this.setBackgroundStatus('Paused');
                waitSeconds = settings.background_poll_interval_seconds;
            } else if (this.runIsActive()) {
                this.setBackgroundStatus('Foreground prompt active');
                waitSeconds = 1;
            } else {
                if (manualRunRequested) {
                    this.backgroundRunRequested = false;
                }
                try {
                    this.knowledgeStore(settings.knowledge_db_path).enqueueDueTopics(
                        settings.background_refresh_interval_hours,
                        settings.background_max_pending_jobs,
                    );
                    const [modelLock, modelCache] = await this.backgroundModel(settings);
                    const workerOptions: BackgroundOptions = {
                        onProgress: (message) => this.setBackgroundStatus(message),
                        onToken: (token) => this.appendBackgroundToken(token),
                        shouldPause: () => this.runIsActive() || this.suspended || this.stopping,
                        modelLock,
                        modelCache,
                    };
                    // The machine probe needs no model, so it never takes the turn of the model work below.
                    const probed = await this.dependencies.refreshEnvironment(settings);
                    const jobName = await runNextJob(this.backgroundJobs(), settings, workerOptions);
                    worked = jobName !== null;
                    this.broadcast('queue.changed');
                    if (jobName === 'poll_connectors' || jobName === 'handle_events') {
                        this.broadcast('events.changed');
                        this.broadcast('actions.changed');
                    }
                    if (worked || probed) {
                        this.broadcast('knowledge.changed');
                        waitSeconds = 0.2;
                    } else {
                        this.setBackgroundStatus('Idle');
                        waitSeconds = settings.background_poll_interval_seconds;
                    }
                } catch (error) {
                    this.setBackgroundStatus(`Worker error: ${errorText(error)}`);
                    waitSeconds = settings.background_poll_interval_seconds;
                }
            }
            try {
                await this.unloadIdleBackgroundModel(worked);
            } catch (error) {
                this.setBackgroundStatus(`Worker error: ${errorText(error)}`);
            }
            await this.workerWakeup.wait(waitSeconds);
            this.workerWakeup.clear();
        }
    }

    // ========================================================================
    // Suspending
    // ========================================================================

    private refuseWhileSuspended(): void {
        if (this.suspended) {
            throw new Error('CODEX is suspended; resume it first.');
        }
    }

    async suspend(): Promise<Json> {
        await this.setSuspended(true);
        return { suspended: true };
    }

    async resume(): Promise<Json> {
        await this.setSuspended(false);
        return { suspended: false };
    }

    // Frees the GPU for another program, or takes work up again; a suspension stops the run and unloads every model.
    async setSuspended(suspended: boolean): Promise<void> {
        this.suspended = suspended;
        if (suspended) {
            this.run?.cancel();
            // Both locks come free once the stopped run and the paused background work let go of the model.
            await this.modelLock.withLock(() => this.modelCache.unload());
            await this.backgroundModelLock.withLock(() => this.backgroundModelCache.unload());
        }
        this.workerWakeup.set();
        this.broadcast('suspended.changed', { suspended });
    }

    // ========================================================================
    // Knowledge
    // ========================================================================

    // Everything the knowledge page's tree lists, plus the articles a search matched.
    knowledge(query = ''): Json {
        const store = this.knowledgeStore(this.getSettings().knowledge_db_path);
        const trimmed = query.trim();
        return {
            topics: store.topics(),
            // A negative limit is SQLite's "no limit": the tree shows every article and finding.
            sources: store.sources(null, { limit: -1 }),
            facts: store.facts({ limit: -1 }),
            graph: store.graph(),
            matches: trimmed ? store.search(trimmed) : [],
        };
    }

    private knowledgeStore(databasePath: string): KnowledgeStore {
        let store = this.knowledgeStores.get(databasePath);
        if (store === undefined) {
            store = new KnowledgeStore(databasePath);
            this.knowledgeStores.set(databasePath, store);
        }
        return store;
    }
}

// ============================================================================
// Socket checks
// ============================================================================

export function socketAnswers(path: string): Promise<boolean> {
    return new Promise((resolveProbe) => {
        const probe = createConnection(path);
        probe.once('connect', () => {
            probe.destroy();
            resolveProbe(true);
        });
        probe.once('error', () => {
            probe.destroy();
            resolveProbe(false);
        });
    });
}
