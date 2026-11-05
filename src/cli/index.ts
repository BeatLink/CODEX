#!/usr/bin/env node
// The one-shot codex command: answers a prompt on a running daemon, or in this process when none answers.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

import { KnowledgeStore } from '../core/knowledge.js';
import { ModelCache } from '../core/model.js';
import { defaultSettingsPath, expandUser, loadSettings, MODE_CHOICES, validateSettings, type Settings } from '../core/settings.js';
import { executeTaskTree, savedRunOptions, type ExecuteTaskTreeOptions } from '../core/taskTree.js';
import { connectToDaemon, DISCONNECTED_EVENT, type DaemonClient, type EventHandler } from '../daemon/client.js';
import { HelpRequested, parseArguments, usageText, UsageError, type ParserSpec } from './arguments.js';

export const PATH_SETTINGS = ['model_path', 'filesystem_root', 'knowledge_db_path', 'embedding_model_path'] as const;

// ============================================================================
// Surroundings
// ============================================================================

// Everything the command touches outside itself, so tests can stand in for the terminal, the daemon and the model.
export type CliEnvironment = {
    loadSettings: (settingsPath: string) => Settings;
    executeTaskTree: (userPrompt: string, options: ExecuteTaskTreeOptions) => Promise<string>;
    connectToDaemon: (options: { onEvent: EventHandler; start: boolean }) => Promise<DaemonClient>;
    stdinIsTTY: boolean;
    stdoutIsTTY: boolean;
    print: (text: string) => void;
    write: (text: string) => void;
    printError: (text: string) => void;
    readStdin: () => Promise<string>;
    ask: (question: string) => Promise<string>;
    variables: NodeJS.ProcessEnv;
};

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString('utf-8');
}

async function askOnTerminal(question: string): Promise<string> {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
        return await terminal.question(question);
    } finally {
        terminal.close();
    }
}

export function processEnvironment(): CliEnvironment {
    return {
        loadSettings,
        executeTaskTree,
        connectToDaemon: (options) => connectToDaemon(options),
        stdinIsTTY: Boolean(process.stdin.isTTY),
        stdoutIsTTY: Boolean(process.stdout.isTTY),
        print: (text) => console.log(text),
        write: (text) => process.stdout.write(text),
        printError: (text) => console.error(text),
        readStdin: () => readAll(process.stdin),
        ask: askOnTerminal,
        variables: process.env,
    };
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// ============================================================================
// Command line
// ============================================================================

function parserSpec(): ParserSpec {
    return {
        program: 'codex',
        description: 'Answer a request with a local model, working it as a tree of tasks.',
        positional: { name: 'prompt', help: 'Prompt text. Omit it to enter a prompt interactively.' },
        options: [
            { name: 'settings', kind: 'string', default: defaultSettingsPath(), help: 'Path to the JSON settings file.' },
            { name: 'model-path', kind: 'string', help: 'Path to a GGUF model (overrides settings.json and MODEL_PATH).' },
            { name: 'context-size', kind: 'int' },
            { name: 'gpu-layers', kind: 'int' },
            { name: 'max-tokens', kind: 'int' },
            { name: 'temperature', kind: 'float' },
            { name: 'enable-test-execution', kind: 'flag', help: 'Allow the model to run unittest discovery under filesystem_root.' },
            {
                name: 'allow-file-writes',
                kind: 'flag',
                help: 'Let the model create or replace files under filesystem_root (read-only by default).',
            },
            {
                name: 'mode',
                kind: 'string',
                choices: MODE_CHOICES,
                help: 'Answer a question, draft a piece of writing or a plan, or execute file changes; auto lets the model pick.',
            },
            {
                name: 'resume',
                kind: 'flag',
                help: 'Carry on the newest task tree run that a crash, restart, or cancel left unfinished.',
            },
            { name: 'show-thinking', kind: 'negatable', help: 'Stream generated text token by token for each step.' },
        ],
    };
}

// Subcommands that hand the rest of the command line to their own parser.
const SUBCOMMANDS: Record<string, () => Promise<{ main: (argv: string[]) => Promise<number> }>> = {
    eval: () => import('../core/evaluation.js'),
    'recall-benchmark': () => import('../core/recallBenchmark.js'),
};

// Suspend or resume the running daemon; with none running there is nothing to do, which is not a failure.
export async function setSuspended(suspended: boolean, io: CliEnvironment): Promise<number> {
    let client: DaemonClient;
    try {
        client = await io.connectToDaemon({ onEvent: () => undefined, start: false });
    } catch {
        return 0;
    }
    try {
        await client.call(suspended ? 'suspend' : 'resume');
    } catch (error) {
        io.printError(`Error: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
    } finally {
        client.close();
    }
    return 0;
}

export async function main(argv: string[] = process.argv.slice(2), io: CliEnvironment = processEnvironment()): Promise<number> {
    if (argv[0] === 'suspend' || argv[0] === 'resume') {
        return setSuspended(argv[0] === 'suspend', io);
    }
    if (argv.length > 0 && Object.hasOwn(SUBCOMMANDS, argv[0])) {
        return (await SUBCOMMANDS[argv[0]]()).main(argv.slice(1));
    }
    const spec = parserSpec();
    const usageFailure = (message: string): number => {
        io.printError(`${usageText(spec)}\n${spec.program}: error: ${message}`);
        return 2;
    };
    let parsed;
    try {
        parsed = parseArguments(spec, argv);
    } catch (error) {
        if (error instanceof HelpRequested) {
            io.print(error.text);
            return 0;
        }
        if (error instanceof UsageError) {
            return usageFailure(error.message);
        }
        throw error;
    }
    const values = parsed.values;

    let settings: Settings;
    try {
        settings = io.loadSettings(String(values.settings));
    } catch (error) {
        io.printError(`Error loading settings: ${errorText(error)}`);
        return 1;
    }

    const overrides: Record<string, unknown> = {};
    if (io.variables.MODEL_PATH) {
        overrides.model_path = io.variables.MODEL_PATH;
    }
    for (const name of ['model-path', 'context-size', 'gpu-layers', 'max-tokens', 'temperature']) {
        if (values[name] !== null) {
            overrides[name.replaceAll('-', '_')] = values[name];
        }
    }
    if (values['enable-test-execution']) {
        overrides.enable_test_execution = true;
    }
    if (values['allow-file-writes']) {
        overrides.allow_file_writes = true;
    }
    if (values['show-thinking'] !== null) {
        overrides.show_thinking = values['show-thinking'];
    }
    if (values.mode !== null) {
        overrides.mode = values.mode;
    }
    try {
        settings = validateSettings({ ...settings, ...overrides });
    } catch (error) {
        io.printError(`Error in settings: ${errorText(error)}`);
        return 1;
    }

    if (values.resume) {
        return resume(settings, io);
    }

    let prompt = parsed.positionals.join(' ').trim();
    if (!prompt && io.stdinIsTTY) {
        prompt = (await io.ask('Prompt: ')).trim();
    } else if (!prompt) {
        prompt = (await io.readStdin()).trim();
    }
    if (!prompt) {
        return usageFailure('provide a prompt as an argument or through standard input');
    }

    let result: string;
    try {
        const daemonResult = await runWithDaemon(prompt, settings, io.stdinIsTTY, io);
        if (daemonResult !== null) {
            result = daemonResult;
        } else {
            result = await runInProcess(io, prompt, {
                modelPath: settings.model_path,
                contextSize: settings.context_size,
                gpuLayers: settings.gpu_layers,
                maxTokens: settings.max_tokens,
                temperature: settings.temperature,
                filesystemRoot: settings.filesystem_root,
                maxToolCalls: settings.max_tool_calls,
                maxSearchResults: settings.max_search_results,
                enableTestExecution: settings.enable_test_execution,
                allowFileWrites: settings.allow_file_writes,
                mcpServers: settings.mcp_servers,
                knowledgeDbPath: settings.knowledge_db_path,
                embeddingModelPath: settings.embedding_model_path,
                maxPendingResearchJobs: settings.background_max_pending_jobs,
                mode: settings.mode,
                showThinking: settings.show_thinking,
                clarificationCallback: io.stdinIsTTY ? (question) => askClarification(io, question) : null,
                confirmActions: settings.confirm_actions,
                maxTaskDepth: settings.max_task_depth,
                maxTaskNodes: settings.max_task_nodes,
            });
        }
    } catch (error) {
        io.printError(`Error: ${errorText(error)}`);
        return 1;
    }

    printResult(io, result);
    return 0;
}

// ============================================================================
// Running
// ============================================================================

// Runs the request here with its own model cache, unloading the model afterwards so the GPU lock is let go.
async function runInProcess(io: CliEnvironment, prompt: string, options: ExecuteTaskTreeOptions): Promise<string> {
    const modelCache = new ModelCache();
    try {
        return await io.executeTaskTree(prompt, { ...options, modelCache });
    } finally {
        await modelCache.unload();
    }
}

function printResult(io: CliEnvironment, result: string): void {
    io.print('\n=== FINAL RESULT ===\n');
    io.print(result);
}

// Resume the newest unfinished task tree run, on a running daemon or in this process.
async function resume(settings: Settings, io: CliEnvironment): Promise<number> {
    let result: string;
    try {
        const store = new KnowledgeStore(expandUser(settings.knowledge_db_path));
        const unfinished = store.unfinishedTaskRuns({ limit: 1 });
        if (unfinished.length === 0) {
            io.printError('There is no unfinished task tree run to resume.');
            return 1;
        }
        const saved = store.taskRun(Number(unfinished[0].id))!;
        io.print(`Resuming: ${saved.prompt} (${saved.tasks_done} of ${saved.tasks_total} tasks done)`);
        const interactive = io.stdinIsTTY;
        const daemonResult = await runWithDaemon(String(saved.prompt), settings, interactive, io, Number(saved.id));
        result =
            daemonResult ??
            (await runInProcess(io, String(saved.prompt), {
                ...savedRunOptions(saved.options),
                showThinking: settings.show_thinking,
                clarificationCallback: interactive ? (question) => askClarification(io, question) : null,
                resumeRunId: Number(saved.id),
            }));
    } catch (error) {
        io.printError(`Error: ${errorText(error)}`);
        return 1;
    }
    printResult(io, result);
    return 0;
}

// Turn a path setting into an absolute one, following links as far as the path exists.
function resolvedPath(path: string): string {
    const absolute = resolve(expandUser(path));
    try {
        return realpathSync(absolute);
    } catch {
        return absolute;
    }
}

type QueuedEvent = [event: string, data: Record<string, unknown>];

// Events wait here until the command reads them, so none is missed while a reply is on its way.
class EventQueue {
    private readonly items: QueuedEvent[] = [];
    private waiter: (() => void) | null = null;

    put(event: string, data: Record<string, unknown>): void {
        this.items.push([event, data]);
        this.waiter?.();
        this.waiter = null;
    }

    async get(): Promise<QueuedEvent> {
        while (this.items.length === 0) {
            await new Promise<void>((resolveWait) => {
                this.waiter = resolveWait;
            });
        }
        return this.items.shift()!;
    }
}

// Run the prompt, or resume a saved run, on a daemon that is already running; null when none is.
export async function runWithDaemon(
    prompt: string,
    settings: Settings,
    interactive: boolean,
    io: CliEnvironment,
    resumeRunId: number | null = null,
): Promise<string | null> {
    const events = new EventQueue();
    let client: DaemonClient;
    try {
        client = await io.connectToDaemon({ onEvent: (event, data) => events.put(event, data), start: false });
    } catch {
        return null;
    }
    // The daemon may have started elsewhere, so paths are sent resolved from this directory.
    const sent: Record<string, unknown> = { ...settings };
    for (const name of PATH_SETTINGS) {
        // An empty path means a feature is off, so it stays empty.
        if (settings[name]) {
            sent[name] = resolvedPath(settings[name]);
        }
    }
    try {
        let runId: unknown;
        if (resumeRunId !== null) {
            runId = (await client.call<{ run_id: number }>('resume_run', { run_id: resumeRunId, interactive })).run_id;
        } else {
            runId = (await client.call<{ run_id: number }>('run', { prompt, settings: sent, interactive })).run_id;
        }
        for (;;) {
            const [event, data] = await events.get();
            if (event === DISCONNECTED_EVENT) {
                throw new Error('The daemon closed the connection.');
            }
            if (data.run_id !== runId) {
                continue;
            }
            if (event === 'run.progress' && settings.show_thinking) {
                io.write(`\n[${String(data.label)} result] `);
            } else if (event === 'run.progress') {
                io.print(`[${String(data.label)}]...`);
            } else if (event === 'run.token' && settings.show_thinking) {
                io.write(String(data.token));
            } else if (event === 'run.clarification') {
                const answer = await askClarification(io, String(data.question));
                await client.call('answer_clarification', {
                    run_id: runId,
                    clarification_id: data.clarification_id,
                    answer,
                });
            } else if (event === 'run.finished') {
                return String(data.result);
            } else if (event === 'run.failed') {
                throw new Error(String(data.message));
            } else if (event === 'run.cancelled') {
                throw new Error('The run was cancelled.');
            }
        }
    } finally {
        client.onEvent = null;
        client.close();
    }
}

async function askClarification(io: CliEnvironment, question: string): Promise<string> {
    const answer = await io.ask(`\nClarification needed: ${question}\nYour answer (press Enter to continue with an assumption): `);
    return answer.trim();
}

// ============================================================================
// Entry point
// ============================================================================

function isEntryPoint(): boolean {
    const script = process.argv[1];
    if (!script) {
        return false;
    }
    try {
        return import.meta.url === pathToFileURL(realpathSync(script)).href;
    } catch {
        return false;
    }
}

if (isEntryPoint()) {
    main().then(
        (code) => process.exit(code),
        (error: unknown) => {
            console.error(`Error: ${errorText(error)}`);
            process.exit(1);
        },
    );
}
