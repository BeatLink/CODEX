// Compare the bare model with the task tree on a fixed task set, scoring each answer with checks that use no model.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { getEmbedder, type TextEmbedder } from './embeddings.js';
import { KnowledgeStore, type SearchResult } from './knowledge.js';
import { LocalModel, runStage, type ChatCompletion, type ChatCompletionRequest, type ChatModel } from './model.js';
import { defaultSettingsPath, expandUser, loadSettings, validateSettings, type McpServerSettings, type Settings } from './settings.js';
import { STARTER_AGENTS_DIRECTORY } from './agents.js';
import { executeTaskTree, type AgentToolCall, type Delegation } from './taskTree.js';
import { CONNECTED_TOOL_PREFIX } from './toolStage.js';
import { PYTHON_COMMAND } from './tools.js';

export const EVALS_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'evals');
export const DEFAULT_TASKS_PATH = join(EVALS_DIRECTORY, 'tasks.json');
export const RECALL_TASKS_PATH = join(EVALS_DIRECTORY, 'recall_tasks.json');
export const DEFAULT_SEED_PATH = join(EVALS_DIRECTORY, 'seed.json');
export const AGENTS_TASKS_PATH = join(EVALS_DIRECTORY, 'agents_tasks.json');
export const AGENT_FILES_DIRECTORY = STARTER_AGENTS_DIRECTORY;
export const FAKE_SERVER_PATH = join(EVALS_DIRECTORY, 'fake_mcp_server.mjs');
const FAKE_CATALOGUE_PATH = join(EVALS_DIRECTORY, 'fake_catalogue.json');
export const FAKE_SERVERS = ['mail', 'calendar', 'notes', 'contacts', 'weather', 'todos'] as const;
// 'tree' sees every server's tools at once; 'agents' is the same tree with the shipped starter agents (share/agents/) to hand tasks to.
export const RUNNER_CHOICES = ['bare', 'tree', 'agents'] as const;
// Runners that recall from the knowledge store, and so get a seeded run beside the empty one.
export const STORE_RUNNERS: readonly string[] = ['tree'];
export const SEEDED_SUFFIX = '+store';
export const BARE_SYSTEM_PROMPT = "You are a helpful assistant. Answer the user's request.";
export const BARE_FILES_NOTE =
    "The files below are the whole project. To create or change a file, give its full new content as a line" +
    " 'File: <path>' followed by a fenced code block; files you leave out stay as they are.";
export const EVAL_MODES = ['auto', 'answer', 'draft', 'execute'] as const;
export const ANSWER_CHECK_TYPES = ['contains', 'contains_any', 'not_contains', 'regex', 'not_regex', 'max_words', 'min_words'] as const;
// These checks look at the task's files after the run instead of at the answer.
export const FILE_CHECK_TYPES = ['tests_pass', 'file_contains', 'file_unchanged'] as const;
export const CHECK_TYPES: readonly string[] = [...ANSWER_CHECK_TYPES, ...FILE_CHECK_TYPES];
export const TEST_TIMEOUT_SECONDS = 120;
const FILE_BLOCK = /^File:\s*`?([^`\n]+?)`?\s*\n```[^\n]*\n([\s\S]*?)^```/gm;

export type Check = { type: string; value?: unknown; values?: unknown; pattern?: unknown; path?: unknown };

// ============================================================================
// Python-style text
// ============================================================================

// Quote a string the way Python's repr does, so check descriptions read the same as before.
export function pythonRepr(text: string): string {
    const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
    let body = '';
    for (const character of text) {
        const code = character.codePointAt(0)!;
        if (character === '\\') body += '\\\\';
        else if (character === quote) body += `\\${quote}`;
        else if (character === '\n') body += '\\n';
        else if (character === '\r') body += '\\r';
        else if (character === '\t') body += '\\t';
        else if (code < 0x20 || code === 0x7f) body += `\\x${code.toString(16).padStart(2, '0')}`;
        else body += character;
    }
    return quote + body + quote;
}

// Turn Python-only regex syntax into its JavaScript form: \A and \Z become whole-text anchors and (?P<name> a named group.
export function translatePattern(pattern: string): string {
    let translated = '';
    let inClass = false;
    for (let index = 0; index < pattern.length; index += 1) {
        const character = pattern[index];
        if (character === '\\' && index + 1 < pattern.length) {
            const next = pattern[index + 1];
            if (!inClass && next === 'A') translated += '(?<![\\s\\S])';
            else if (!inClass && next === 'Z') translated += '(?![\\s\\S])';
            else translated += character + next;
            index += 1;
            continue;
        }
        if (inClass) {
            inClass = character !== ']';
        } else if (character === '[') {
            inClass = true;
            translated += character;
            if (pattern[index + 1] === '^') {
                translated += '^';
                index += 1;
            }
            // A ] right after [ or [^ is a literal in Python, while JavaScript would read an empty class.
            if (pattern[index + 1] === ']') {
                translated += '\\]';
                index += 1;
            }
            continue;
        } else if (pattern.startsWith('(?P<', index)) {
            translated += '(?<';
            index += 3;
            continue;
        } else if (pattern.startsWith('(?P=', index)) {
            const end = pattern.indexOf(')', index);
            if (end > 0) {
                translated += `\\k<${pattern.slice(index + 4, end)}>`;
                index = end;
                continue;
            }
        }
        translated += character;
    }
    return translated;
}

// Compile a check pattern as Python's re.IGNORECASE | re.MULTILINE would read it.
export function compilePattern(pattern: string): RegExp {
    return new RegExp(translatePattern(pattern), 'im');
}

// Write JSON as Python's json.dumps(indent=2) does: non-ASCII escaped, and the float fields keep their decimal point.
export function pythonJson(value: unknown, floatKeys: ReadonlySet<string>, indent = '', key = ''): string {
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity';
        return floatKeys.has(key) && Number.isInteger(value) ? `${value}.0` : String(value);
    }
    if (typeof value === 'string') {
        return JSON.stringify(value).replace(/[\u007f-￿]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
    }
    if (typeof value === 'boolean') return String(value);
    const inner = indent + '  ';
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        return `[\n${value.map((item) => inner + pythonJson(item, floatKeys, inner, key)).join(',\n')}\n${indent}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return `{\n${entries.map(([name, item]) => `${inner}${pythonJson(name, floatKeys)}: ${pythonJson(item, floatKeys, inner, name)}`).join(',\n')}\n${indent}}`;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isFile(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

function isDirectory(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ============================================================================
// Loading the task set
// ============================================================================

export class EvalTask {
    id: string;
    prompt: string;
    checks: Check[];
    mode: string;
    // The project the task works on, as relative path to content; the runners may change these files.
    files: Record<string, string>;
    // The canned MCP servers the task is given, from FAKE_SERVERS.
    servers: string[];
    // The servers whose tools a right answer needs, which scores tool choice; empty leaves it unscored.
    expect_servers: string[];

    constructor(fields: {
        id: string;
        prompt: string;
        checks: Check[];
        mode?: string;
        files?: Record<string, string>;
        servers?: string[];
        expect_servers?: string[];
    }) {
        this.id = fields.id;
        this.prompt = fields.prompt;
        this.checks = fields.checks;
        this.mode = fields.mode ?? 'auto';
        this.files = fields.files ?? {};
        this.servers = fields.servers ?? [];
        this.expect_servers = fields.expect_servers ?? [];
    }
}

// Read and validate the task set, a JSON list of tasks each with an id, a prompt, and checks.
export function loadTasks(tasksPath: string): EvalTask[] {
    const data: unknown = JSON.parse(readFileSync(tasksPath, 'utf-8'));
    if (!Array.isArray(data) || data.length === 0) {
        throw new Error('The task set must be a non-empty JSON list.');
    }
    const tasks: EvalTask[] = [];
    const seenIds = new Set<string>();
    for (const entry of data as Record<string, unknown>[]) {
        const task = new EvalTask({
            id: String(entry.id ?? '').trim(),
            prompt: String(entry.prompt ?? '').trim(),
            checks: (entry.checks ?? []) as Check[],
            mode: (entry.mode ?? 'auto') as string,
            files: (entry.files ?? {}) as Record<string, string>,
            servers: entry.servers === 'all' ? [...FAKE_SERVERS] : ((entry.servers ?? []) as string[]),
            expect_servers: (entry.expect_servers ?? []) as string[],
        });
        if (!task.id || seenIds.has(task.id)) {
            throw new Error(`Each task needs a unique id; got ${pythonRepr(task.id)}.`);
        }
        if (!task.prompt) {
            throw new Error(`Task ${task.id} has no prompt.`);
        }
        if (!Array.isArray(task.servers) || !task.servers.every((name) => (FAKE_SERVERS as readonly string[]).includes(name))) {
            throw new Error(`Task ${task.id}: 'servers' must be "all" or names from: ${FAKE_SERVERS.join(', ')}.`);
        }
        if (!Array.isArray(task.expect_servers) || !task.expect_servers.every((name) => task.servers.includes(name))) {
            throw new Error(`Task ${task.id}: 'expect_servers' must name servers the task is given.`);
        }
        if (!(EVAL_MODES as readonly string[]).includes(task.mode)) {
            throw new Error(`Task ${task.id} has mode ${typeof task.mode === 'string' ? pythonRepr(task.mode) : String(task.mode)}; use one of: ${EVAL_MODES.join(', ')}.`);
        }
        if (!isObject(task.files) || !Object.entries(task.files).every(([path, content]) => path.trim() && typeof content === 'string')) {
            throw new Error(`Task ${task.id}: 'files' must map relative paths to their text.`);
        }
        const hasFiles = Object.keys(task.files).length > 0;
        if (task.mode === 'execute' && !hasFiles) {
            throw new Error(`Task ${task.id} is in execute mode but has no files to work on.`);
        }
        if (!Array.isArray(task.checks) || task.checks.length === 0) {
            throw new Error(`Task ${task.id} has no checks.`);
        }
        for (const check of task.checks) {
            validateCheck(task.id, check);
            if ((FILE_CHECK_TYPES as readonly string[]).includes(check.type) && !hasFiles) {
                throw new Error(`Task ${task.id} has a ${check.type} check but no files.`);
            }
            if (check.type === 'file_unchanged' && !Object.hasOwn(task.files, check.path as string)) {
                throw new Error(`Task ${task.id}: file_unchanged names ${String(check.path)}, which is not one of its files.`);
            }
        }
        seenIds.add(task.id);
        tasks.push(task);
    }
    return tasks;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

export function validateCheck(taskId: string, check: unknown): asserts check is Check {
    if (!isObject(check) || !CHECK_TYPES.includes(check.type as string)) {
        throw new Error(`Task ${taskId} has a check whose type is not one of: ${CHECK_TYPES.join(', ')}.`);
    }
    const kind = check.type as string;
    if (kind === 'contains_any') {
        const values = check.values;
        if (!Array.isArray(values) || values.length === 0 || !values.every((value) => typeof value === 'string')) {
            throw new Error(`Task ${taskId}: a contains_any check needs a list of strings in 'values'.`);
        }
    } else if (kind === 'max_words' || kind === 'min_words') {
        if (typeof check.value !== 'number' || !Number.isInteger(check.value)) {
            throw new Error(`Task ${taskId}: a ${kind} check needs a whole number in 'value'.`);
        }
    } else if (kind === 'tests_pass') {
        return;
    } else if (kind === 'file_contains' || kind === 'file_unchanged') {
        if (typeof check.path !== 'string' || !check.path.trim()) {
            throw new Error(`Task ${taskId}: a ${kind} check needs a 'path'.`);
        }
        if (kind === 'file_contains' && !isNonEmptyString(check.value)) {
            throw new Error(`Task ${taskId}: a file_contains check needs a string in 'value'.`);
        }
    } else if (kind === 'regex' || kind === 'not_regex') {
        const pattern = check.pattern ?? '';
        if (typeof pattern !== 'string') {
            throw new Error(`Task ${taskId}: a ${kind} check has a bad pattern: first argument must be string or compiled pattern`);
        }
        try {
            compilePattern(pattern);
        } catch (error) {
            throw new Error(`Task ${taskId}: a ${kind} check has a bad pattern: ${errorText(error)}`);
        }
        if (!pattern) {
            throw new Error(`Task ${taskId}: a ${kind} check needs a 'pattern'.`);
        }
    } else if (!isNonEmptyString(check.value)) {
        throw new Error(`Task ${taskId}: a ${kind} check needs a string in 'value'.`);
    }
}

// ============================================================================
// Building a seeded knowledge store
// ============================================================================

type Seed = {
    topics?: Array<{ name: string; parent?: string | null }>;
    sources?: Array<SearchResult & { title: string; topic?: string | null }>;
    facts: Array<{ topic: string; statement: string; source_url?: string | null; confidence?: number }>;
    memories?: Array<{ store: string; statement: string; scope?: string }>;
};

function required<T>(value: T | undefined, name: string): T {
    if (value === undefined) {
        throw new Error(`'${name}'`);
    }
    return value;
}

// Fill a new knowledge store from a seed file of topics, sources, facts, and memories.
export async function buildSeedStore(seedPath: string, databasePath: string, embedder: TextEmbedder | null = null): Promise<void> {
    const seed = JSON.parse(readFileSync(seedPath, 'utf-8')) as Seed;
    if (!isObject(seed) || !Array.isArray(seed.facts) || seed.facts.length === 0) {
        throw new Error("The seed file must be a JSON object with a non-empty 'facts' list.");
    }
    const store = new KnowledgeStore(databasePath, embedder);
    for (const topic of seed.topics ?? []) {
        store.addTopic(required(topic.name, 'name'), { parent: topic.parent ?? null });
    }
    for (const source of seed.sources ?? []) {
        store.storeSearchResults(required(source.title, 'title'), [source], { topic: source.topic ?? null });
    }
    for (const fact of seed.facts) {
        store.addFact(required(fact.topic, 'topic'), required(fact.statement, 'statement'), fact.source_url ?? null, fact.confidence ?? 0.9);
    }
    for (const memory of seed.memories ?? []) {
        store.addMemory(required(memory.store, 'store'), required(memory.statement, 'statement'), { scope: memory.scope ?? '' });
    }
    // Facts and topics get their vectors now, as the background worker would give them later.
    if (store.embedder !== null) {
        const name = store.embedder.name;
        for (let items = store.itemsToEmbed(name, 64); items.length > 0; items = store.itemsToEmbed(name, 64)) {
            store.saveEmbeddings(name, items, await store.embedder.embedDocuments(items.map(([, , body]) => body)));
        }
    }
}

// ============================================================================
// Scoring an answer
// ============================================================================

function wordCount(text: string): number {
    return text.split(/\s+/).filter(Boolean).length;
}

// Score one check against the answer, or against the task's files in the workspace; text matches ignore case.
export async function checkPasses(answer: string, check: Check, task: EvalTask | null = null, workspace: string | null = null): Promise<boolean> {
    const kind = check.type;
    if ((FILE_CHECK_TYPES as readonly string[]).includes(kind)) {
        return fileCheckPasses(check, task!, workspace!);
    }
    const lowered = answer.toLowerCase();
    if (kind === 'contains') {
        return lowered.includes((check.value as string).toLowerCase());
    }
    if (kind === 'contains_any') {
        return (check.values as string[]).some((value) => lowered.includes(value.toLowerCase()));
    }
    if (kind === 'not_contains') {
        return !lowered.includes((check.value as string).toLowerCase());
    }
    if (kind === 'regex' || kind === 'not_regex') {
        const found = compilePattern(check.pattern as string).test(answer);
        return kind === 'regex' ? found : !found;
    }
    if (kind === 'max_words') {
        return wordCount(answer) <= (check.value as number);
    }
    return wordCount(answer) >= (check.value as number);
}

async function fileCheckPasses(check: Check, task: EvalTask, workspace: string): Promise<boolean> {
    if (check.type === 'tests_pass') {
        return runTests(workspace);
    }
    const path = join(workspace, check.path as string);
    if (!isFile(path)) {
        return false;
    }
    const content = new TextDecoder('utf-8').decode(readFileSync(path));
    if (check.type === 'file_unchanged') {
        return content === task.files[check.path as string];
    }
    return content.toLowerCase().includes((check.value as string).toLowerCase());
}

// Run unittest discovery the way the run_tests tool does, passing when every test passes.
export function runTests(workspace: string): Promise<boolean> {
    const startDirectory = isDirectory(join(workspace, 'tests')) ? join(workspace, 'tests') : workspace;
    return new Promise((resolveRun) => {
        const child = spawn(PYTHON_COMMAND, ['-m', 'unittest', 'discover', '-s', startDirectory], { cwd: workspace, stdio: 'ignore' });
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, TEST_TIMEOUT_SECONDS * 1000);
        child.on('error', () => {
            clearTimeout(timer);
            resolveRun(false);
        });
        child.on('close', (exitCode) => {
            clearTimeout(timer);
            resolveRun(!timedOut && exitCode === 0);
        });
    });
}

export function describeCheck(check: Check): string {
    const kind = check.type;
    if (kind === 'tests_pass') {
        return 'tests_pass';
    }
    if (kind === 'file_unchanged') {
        return `file_unchanged ${String(check.path)}`;
    }
    if (kind === 'file_contains') {
        return `file_contains ${String(check.path)} ${pythonRepr(check.value as string)}`;
    }
    if (kind === 'contains_any') {
        return `contains_any [${(check.values as string[]).map(pythonRepr).join(', ')}]`;
    }
    if (kind === 'regex' || kind === 'not_regex') {
        return `${kind} ${String(check.pattern)}`;
    }
    return typeof check.value === 'string' ? `${kind} ${pythonRepr(check.value)}` : `${kind} ${String(check.value)}`;
}

// ============================================================================
// Running one task on one runner
// ============================================================================

type CompletionWithUsage = ChatCompletion & { usage?: { completion_tokens?: number } };

// One tool call the model asked for, kept so a failing run shows which tools it reached.
export type RecordedToolCall = { name: string; arguments: string };

// Wrap the loaded model to count its calls and the tokens it generates, and record the tools it calls.
export class CountingModel implements ChatModel {
    calls = 0;
    completionTokens = 0;
    toolCalls: RecordedToolCall[] = [];

    constructor(
        private readonly llm: ChatModel,
        private readonly onToolCall: ((call: RecordedToolCall) => void) | null = null,
    ) {}

    async createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletion> {
        this.calls += 1;
        const response: CompletionWithUsage = await this.llm.createChatCompletion(request);
        for (const call of response.tool_calls ?? []) {
            const recorded = { name: call.function.name, arguments: call.function.arguments };
            this.toolCalls.push(recorded);
            this.onToolCall?.(recorded);
        }
        // A reply without a usage count is measured by tokenizing what it says.
        const usage = response.usage?.completion_tokens;
        if (typeof usage === 'number') {
            this.completionTokens += usage;
        } else if (this.llm.tokenize && response.content) {
            this.completionTokens += this.llm.tokenize(response.content).length;
        }
        return response;
    }

    tokenize(text: string): number[] {
        if (!this.llm.tokenize) {
            throw new Error('The model cannot tokenize text.');
        }
        return this.llm.tokenize(text);
    }

    async close(): Promise<void> {
        await this.llm.close?.();
    }
}

export class RunResult {
    task_id: string;
    runner: string;
    answer = '';
    error = '';
    checks_passed = 0;
    checks_total = 0;
    failed_checks: string[] = [];
    seconds = 0.0;
    model_calls = 0;
    completion_tokens = 0;
    tool_calls: RecordedToolCall[] = [];
    // Each hand-over to an agent, and each tool call the tool stage ran or refused with the agent that made it, in order.
    agents: Delegation[] = [];
    tool_sequence: AgentToolCall[] = [];
    // Whether the run reached a valid call on every server the task expects, or null when the task expects none.
    tool_choice: boolean | null = null;
    // Which round of a repeated eval this run belongs to, counting from 1.
    attempt = 1;

    constructor(fields: Partial<RunResult> & { task_id: string; runner: string }) {
        this.task_id = fields.task_id;
        this.runner = fields.runner;
        Object.assign(this, fields);
    }

    get passed(): boolean {
        return !this.error && this.checks_passed === this.checks_total;
    }

    // The result's fields in report order, followed by whether it passed.
    toJson(): Record<string, unknown> {
        return {
            task_id: this.task_id,
            runner: this.runner,
            answer: this.answer,
            error: this.error,
            checks_passed: this.checks_passed,
            checks_total: this.checks_total,
            failed_checks: this.failed_checks,
            seconds: this.seconds,
            model_calls: this.model_calls,
            completion_tokens: this.completion_tokens,
            tool_calls: this.tool_calls,
            agents: this.agents,
            tool_sequence: this.tool_sequence,
            tool_choice: this.tool_choice,
            attempt: this.attempt,
            passed: this.passed,
        };
    }
}

function roundTo(value: number, places: number): number {
    const scale = 10 ** places;
    return Math.round(value * scale) / scale;
}

// Longest tool-call arguments a streamed line shows.
const STREAMED_ARGUMENTS_CHARS = 160;

// Answer one task with one runner and score the answer, recording a failure as an error.
// onEvent, when given, hears each step and tool call as it happens, so a slow or looping run can be watched.
export async function runTask(
    task: EvalTask,
    runner: string,
    llm: ChatModel,
    settings: Settings,
    seedStore: string | null = null,
    attempt = 1,
    onEvent: ((line: string) => void) | null = null,
): Promise<RunResult> {
    const label = seedStore !== null ? runner + SEEDED_SUFFIX : runner;
    const result = new RunResult({ task_id: task.id, runner: label, checks_total: task.checks.length, attempt });
    const started = performance.now();
    const say =
        onEvent === null
            ? null
            : (text: string) => onEvent(`[${task.id} / ${label} #${attempt}] +${((performance.now() - started) / 1000).toFixed(1)}s ${text}`);
    const countingModel = new CountingModel(
        llm,
        say === null ? null : (call) => say(`tool ${call.name} ${call.arguments.slice(0, STREAMED_ARGUMENTS_CHARS)}`),
    );
    say?.('start');
    // Each run gets its own store, empty or a fresh copy of the seed, so no run sees what an earlier one stored.
    const scratchDirectory = mkdtempSync(join(tmpdir(), 'codex-eval-'));
    try {
        // The workspace is the filesystem root, so the knowledge store beside it stays out of the model's reach.
        const workspace = join(scratchDirectory, 'workspace');
        try {
            writeFiles(workspace, task.files);
            if (seedStore !== null) {
                await copyStore(seedStore, join(scratchDirectory, 'knowledge.sqlite3'));
            }
            result.answer = await answerWith(runner, task, countingModel, settings, scratchDirectory, {
                onStep: say === null ? undefined : (step) => say(`step ${step}`),
                onDelegation: (delegation) => {
                    result.agents.push(delegation);
                    say?.(`agent ${delegation.agent} (depth ${delegation.depth}, from ${delegation.parent ?? 'the top'})`);
                },
                onToolCall: (call) => result.tool_sequence.push(call),
            });
        } catch (error) {
            result.error = error instanceof Error ? `${error.name}: ${error.message}` : `Error: ${String(error)}`;
        }
        result.seconds = roundTo((performance.now() - started) / 1000, 2);
        result.model_calls = countingModel.calls;
        result.completion_tokens = countingModel.completionTokens;
        result.tool_calls = countingModel.toolCalls;
        result.tool_choice = toolChoice(task, result.tool_sequence);
        if (!result.error) {
            for (const check of task.checks) {
                if (await checkPasses(result.answer, check, task, workspace)) {
                    result.checks_passed += 1;
                } else {
                    result.failed_checks.push(describeCheck(check));
                }
            }
        }
    } finally {
        rmSync(scratchDirectory, { recursive: true, force: true });
    }
    return result;
}

// Say whether the calls reached a valid call on every server the task expects, or null when it expects none.
export function toolChoice(task: EvalTask, calls: AgentToolCall[]): boolean | null {
    if (task.expect_servers.length === 0) {
        return null;
    }
    return task.expect_servers.every((server) => calls.some((call) => call.valid && call.name.startsWith(`${CONNECTED_TOOL_PREFIX}${server}__`)));
}

// Write each file under the workspace, refusing a path that would land outside it.
export function writeFiles(workspace: string, files: Record<string, string>): void {
    mkdirSync(workspace, { recursive: true });
    const root = realpathSync(workspace);
    for (const [relativePath, content] of Object.entries(files)) {
        const path = resolve(root, relativePath);
        const fromRoot = relative(root, path);
        if (!fromRoot || fromRoot === '..' || fromRoot.startsWith('../') || isAbsolute(fromRoot)) {
            throw new Error(`File path ${pythonRepr(relativePath)} is outside the workspace.`);
        }
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content, 'utf-8');
    }
}

// Give the bare model the task's files inline, since it has no tools to read or write them.
export function barePrompt(task: EvalTask): string {
    const entries = Object.entries(task.files);
    if (entries.length === 0) {
        return task.prompt;
    }
    const listing = entries.map(([path, content]) => `File: ${path}\n\`\`\`\n${content}\n\`\`\``).join('\n\n');
    return `${task.prompt}\n\n${BARE_FILES_NOTE}\n\n${listing}`;
}

// Read the files a bare answer gives in full, each as a 'File: <path>' line and a fenced block.
export function fileBlocks(answer: string): Record<string, string> {
    const files: Record<string, string> = {};
    for (const match of answer.matchAll(FILE_BLOCK)) {
        files[match[1].trim()] = match[2];
    }
    return files;
}

// Copy a knowledge store with SQLite's backup, which also takes what its write-ahead log holds.
export async function copyStore(seedStore: string, destination: string): Promise<void> {
    if (!isFile(seedStore)) {
        throw new Error(`No knowledge store at ${seedStore}`);
    }
    const source = new DatabaseSync(seedStore);
    try {
        await backup(source, destination);
    } finally {
        source.close();
    }
}

// Describe the canned servers the way a user's settings would, each started from the same script.
export function fakeServers(names: string[]): McpServerSettings[] {
    const catalogue = JSON.parse(readFileSync(FAKE_CATALOGUE_PATH, 'utf-8')) as Record<string, Array<{ name: string }>>;
    return names.map((name) => ({
        name,
        enabled: true,
        transport: 'stdio',
        command: process.execPath,
        args: [FAKE_SERVER_PATH, name],
        env: {},
        allowed_tools: catalogue[name].map((tool) => tool.name),
    }));
}

// Copy the eval's agent files into the workspace folder the task tree reads agents from.
function copyAgentFiles(directory: string): void {
    mkdirSync(directory, { recursive: true });
    for (const name of readdirSync(AGENT_FILES_DIRECTORY).filter((file) => file.endsWith('.md'))) {
        copyFileSync(join(AGENT_FILES_DIRECTORY, name), join(directory, name));
    }
}

async function answerWith(
    runner: string,
    task: EvalTask,
    llm: ChatModel,
    settings: Settings,
    scratchDirectory: string,
    hooks: { onStep?: (label: string) => void; onDelegation?: (delegation: Delegation) => void; onToolCall?: (call: AgentToolCall) => void } = {},
): Promise<string> {
    const workspace = join(scratchDirectory, 'workspace');
    const hasFiles = Object.keys(task.files).length > 0;
    if (runner === 'bare') {
        const answer = await runStage(llm, BARE_SYSTEM_PROMPT, barePrompt(task), {
            maxTokens: settings.max_tokens,
            temperature: settings.temperature,
        });
        if (hasFiles) {
            writeFiles(workspace, fileBlocks(answer));
        }
        return answer;
    }
    if (runner === 'agents') {
        copyAgentFiles(join(workspace, '.codex', 'agents'));
    }
    return executeTaskTree(task.prompt, {
        contextSize: settings.context_size,
        maxTokens: settings.max_tokens,
        temperature: settings.temperature,
        // The workspace stands in for the filesystem, so no task reads or changes the user's own files.
        filesystemRoot: workspace,
        allowFileWrites: hasFiles,
        enableTestExecution: hasFiles,
        maxToolCalls: settings.max_tool_calls,
        maxSearchResults: settings.max_search_results,
        mcpServers: fakeServers(task.servers),
        knowledgeDbPath: join(scratchDirectory, 'knowledge.sqlite3'),
        embeddingModelPath: settings.embedding_model_path,
        llm,
        mode: task.mode,
        progressCallback: hooks.onStep ?? (() => undefined),
        delegationCallback: hooks.onDelegation,
        toolCallCallback: hooks.onToolCall,
        maxTaskDepth: settings.max_task_depth,
        maxTaskNodes: settings.max_task_nodes,
    });
}

// ============================================================================
// Running the whole set and reporting
// ============================================================================

// List each runner, followed by its seeded run when a seed store is given and it recalls from one.
export function runnerLabels(runners: string[], seedStore: string | null): string[] {
    const labels: string[] = [];
    for (const runner of runners) {
        labels.push(runner);
        if (seedStore !== null && STORE_RUNNERS.includes(runner)) {
            labels.push(runner + SEEDED_SUFFIX);
        }
    }
    return labels;
}

// Run every task on every runner, going through the whole set once per round.
export async function runEval(
    tasks: EvalTask[],
    runners: string[],
    llm: ChatModel,
    settings: Settings,
    options: { onResult?: (result: RunResult) => void; onEvent?: (line: string) => void; seedStore?: string | null; repeat?: number } = {},
): Promise<RunResult[]> {
    const seedStore = options.seedStore ?? null;
    const repeat = options.repeat ?? 1;
    const results: RunResult[] = [];
    // Each round covers the whole set, so a run stopped early still holds complete rounds.
    for (let attempt = 1; attempt <= repeat; attempt += 1) {
        for (const task of tasks) {
            for (const label of runnerLabels(runners, seedStore)) {
                const runner = label.endsWith(SEEDED_SUFFIX) ? label.slice(0, -SEEDED_SUFFIX.length) : label;
                const result = await runTask(task, runner, llm, settings, label !== runner ? seedStore : null, attempt, options.onEvent ?? null);
                results.push(result);
                options.onResult?.(result);
            }
        }
    }
    return results;
}

export type RunnerSummary = {
    tasks: number;
    tasks_passed: number;
    pass_rate: number;
    round_passes: number[];
    // pass^k: the distinct tasks, and those passed in every round they ran.
    distinct_tasks: number;
    tasks_passed_every_round: number;
    pass_every_round_rate: number;
    // Tool calls the tool stage saw, those naming an offered tool with valid arguments, and those that failed.
    tool_calls: number;
    valid_tool_calls: number;
    failed_tool_calls: number;
    // Runs of tasks that expect servers, and those that reached a valid call on each; the rate is null with none.
    tool_choice_runs: number;
    tool_choice_hits: number;
    tool_choice_accuracy: number | null;
    checks_passed: number;
    checks_total: number;
    errors: number;
    seconds: number;
    model_calls: number;
    completion_tokens: number;
};

function sum(values: number[]): number {
    return values.reduce((total, value) => total + value, 0);
}

// Total each runner's passed tasks, passed checks, errors, time, calls, and tokens, and its passes per round.
export function summarize(results: RunResult[], runners: string[]): Record<string, RunnerSummary> {
    const summary: Record<string, RunnerSummary> = {};
    for (const runner of runners) {
        const own = results.filter((result) => result.runner === runner);
        const rounds = [...new Set(own.map((result) => result.attempt))].sort((first, second) => first - second);
        const passed = own.filter((result) => result.passed).length;
        const everyRound = passEveryRound(own, runner);
        const calls = own.flatMap((result) => result.tool_sequence);
        const scored = own.filter((result) => result.tool_choice !== null);
        const hits = scored.filter((result) => result.tool_choice).length;
        summary[runner] = {
            tasks: own.length,
            tasks_passed: passed,
            pass_rate: own.length ? roundTo(passed / own.length, 3) : 0.0,
            round_passes: rounds.map((attempt) => own.filter((result) => result.passed && result.attempt === attempt).length),
            distinct_tasks: everyRound.tasks,
            tasks_passed_every_round: everyRound.passed,
            pass_every_round_rate: everyRound.rate,
            tool_calls: calls.length,
            valid_tool_calls: calls.filter((call) => call.valid).length,
            failed_tool_calls: calls.filter((call) => call.error).length,
            tool_choice_runs: scored.length,
            tool_choice_hits: hits,
            tool_choice_accuracy: scored.length ? roundTo(hits / scored.length, 3) : null,
            checks_passed: sum(own.map((result) => result.checks_passed)),
            checks_total: sum(own.map((result) => result.checks_total)),
            errors: own.filter((result) => result.error).length,
            seconds: roundTo(sum(own.map((result) => result.seconds)), 2),
            model_calls: sum(own.map((result) => result.model_calls)),
            completion_tokens: sum(own.map((result) => result.completion_tokens)),
        };
    }
    return summary;
}

function right(value: string | number, width: number): string {
    return String(value).padStart(width);
}

function left(value: string | number, width: number): string {
    return String(value).padEnd(width);
}

function percent(rate: number): string {
    return `${(rate * 100).toFixed(0)}%`;
}

export function formatSummary(summary: Record<string, RunnerSummary>): string {
    const repeated = Object.values(summary).some((totals) => totals.round_passes.length > 1);
    let header = `${left('runner', 14)} ${right('tasks', 9)} ${right('checks', 9)} ${right('errors', 6)} ${right('seconds', 9)} ${right('calls', 6)} ${right('tokens', 8)}`;
    if (repeated) {
        header += ` ${right('rate', 6)} ${right('pass^k', 11)}  per round`;
    }
    const lines = [header, '-'.repeat(header.length)];
    for (const [runner, totals] of Object.entries(summary)) {
        let line =
            `${left(runner, 14)} ${right(totals.tasks_passed, 4)}/${left(totals.tasks, 4)} ` +
            `${right(totals.checks_passed, 4)}/${left(totals.checks_total, 4)} ${right(totals.errors, 6)} ` +
            `${right(totals.seconds.toFixed(1), 9)} ${right(totals.model_calls, 6)} ${right(totals.completion_tokens, 8)}`;
        if (repeated) {
            const everyRound = `${totals.tasks_passed_every_round}/${totals.distinct_tasks} ${percent(totals.pass_every_round_rate)}`;
            line += ` ${right(percent(totals.pass_rate), 6)} ${right(everyRound, 11)}  ${totals.round_passes.join(' ')}`;
        }
        lines.push(line);
    }
    return lines.join('\n');
}

// Say per runner how many tool calls were valid and failed, and how often the expected servers were reached.
export function formatToolUse(summary: Record<string, RunnerSummary>): string {
    const lines: string[] = [];
    for (const [runner, totals] of Object.entries(summary)) {
        if (totals.tool_calls === 0 && totals.tool_choice_runs === 0) {
            continue;
        }
        let line = `${left(runner, 14)} ${totals.tool_calls} tool calls, ${totals.valid_tool_calls} valid, ${totals.failed_tool_calls} failed`;
        if (totals.tool_choice_accuracy !== null) {
            line += `; tool choice ${totals.tool_choice_hits}/${totals.tool_choice_runs} ${percent(totals.tool_choice_accuracy)}`;
        }
        lines.push(line);
    }
    return lines.join('\n');
}

// The fields of one run that pass counts need, which every saved result file has.
export type PassRecord = { task_id: string; runner: string; passed: boolean };

// Count, for each task and runner, the rounds it passed and the rounds it ran.
export function taskPassCounts(results: PassRecord[]): Record<string, Record<string, [number, number]>> {
    const counts: Record<string, Record<string, [number, number]>> = {};
    for (const result of results) {
        const byRunner = (counts[result.task_id] ??= {});
        const passedAndRun = (byRunner[result.runner] ??= [0, 0]);
        passedAndRun[0] += Number(result.passed);
        passedAndRun[1] += 1;
    }
    return counts;
}

// Count a runner's distinct tasks and those it passed in every round it ran them (pass^k).
export function passEveryRound(results: PassRecord[], runner: string): { tasks: number; passed: number; rate: number } {
    const counts = Object.values(taskPassCounts(results.filter((result) => result.runner === runner))).map((byRunner) => byRunner[runner]);
    const passed = counts.filter(([passedRounds, run]) => passedRounds === run).length;
    return { tasks: counts.length, passed, rate: counts.length ? roundTo(passed / counts.length, 3) : 0.0 };
}

// Show each task's passed and run rounds per runner, with a star where it passed every round.
export function formatTaskPasses(counts: Record<string, Record<string, [number, number]>>, runners: string[]): string {
    const width = Math.max(4, ...Object.keys(counts).map((taskId) => taskId.length));
    const header = `${left('task', width)} ${runners.map((runner) => right(runner, Math.max(8, runner.length))).join(' ')}`;
    const lines = [header, '-'.repeat(header.length)];
    for (const [taskId, byRunner] of Object.entries(counts)) {
        const cells = runners.map((runner) => {
            const passedAndRun = byRunner[runner];
            const cell = passedAndRun === undefined ? '-' : `${passedAndRun[0]}/${passedAndRun[1]}${passedAndRun[0] === passedAndRun[1] ? '*' : ' '}`;
            return right(cell, Math.max(8, runner.length));
        });
        lines.push(`${left(taskId, width)} ${cells.join(' ')}`);
    }
    lines.push('* passed every round');
    return lines.join('\n');
}

// List the tasks a runner passed in some rounds but not all, which a single run would misreport.
export function formatUnsteadyTasks(counts: Record<string, Record<string, [number, number]>>): string {
    const lines: string[] = [];
    for (const [taskId, byRunner] of Object.entries(counts)) {
        const unsteady = Object.entries(byRunner)
            .filter(([, [passed, run]]) => passed > 0 && passed < run)
            .map(([runner, [passed, run]]) => `${runner} ${passed}/${run}`);
        if (unsteady.length > 0) {
            lines.push(`  ${taskId}: ${unsteady.join(', ')}`);
        }
    }
    if (lines.length === 0) {
        return 'Every task passed in all rounds or in none.';
    }
    return 'Tasks that passed in only some rounds:\n' + lines.join('\n');
}

// Write seconds as Python prints a float, keeping one decimal place for a whole number.
function pythonFloat(value: number): string {
    return Number.isInteger(value) ? `${value}.0` : String(value);
}

export function formatResult(result: RunResult, showAttempt = false): string {
    let outcome: string;
    if (result.error) {
        outcome = `error: ${result.error}`;
    } else if (result.passed) {
        outcome = 'pass';
    } else {
        outcome = `fail (${result.failed_checks.join('; ')})`;
    }
    const roundNote = showAttempt ? ` #${result.attempt}` : '';
    return `[${result.task_id} / ${result.runner}${roundNote}] ${result.checks_passed}/${result.checks_total} in ${pythonFloat(result.seconds)}s: ${outcome}`;
}

// ============================================================================
// Comparing two result files
// ============================================================================

// One task on one runner in both result files, as passed and run rounds, or null where a file lacks it.
export type PairedRow = { task_id: string; runner: string; old: [number, number] | null; new: [number, number] | null; change: number | null };

// One runner's totals in both files, and how many tasks both ran got better or worse.
export type PairedTotals = {
    runner: string;
    old: { passed: number; runs: number; every_round: number; tasks: number } | null;
    new: { passed: number; runs: number; every_round: number; tasks: number } | null;
    better: number;
    worse: number;
    same: number;
};

// Read a saved --output file's runs, which every version of the file records with their task, runner and pass.
export function loadResultRecords(path: string): PassRecord[] {
    const data: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const results = isObject(data) ? data.results : undefined;
    if (!Array.isArray(results) || !results.every((result) => isObject(result) && typeof result.task_id === 'string' && typeof result.runner === 'string')) {
        throw new Error(`${path} is not an eval result file: it needs a 'results' list of runs with task_id and runner.`);
    }
    return results.map((result) => ({ task_id: result.task_id as string, runner: result.runner as string, passed: result.passed === true }));
}

function rate([passed, run]: [number, number]): number {
    return run ? passed / run : 0;
}

// Pair each task and runner across the two files, the biggest change first and those in only one file last.
export function compareResults(oldRecords: PassRecord[], newRecords: PassRecord[]): { rows: PairedRow[]; totals: PairedTotals[] } {
    const oldCounts = taskPassCounts(oldRecords);
    const newCounts = taskPassCounts(newRecords);
    const rows: PairedRow[] = [];
    for (const taskId of new Set([...Object.keys(oldCounts), ...Object.keys(newCounts)])) {
        for (const runner of new Set([...Object.keys(oldCounts[taskId] ?? {}), ...Object.keys(newCounts[taskId] ?? {})])) {
            const before = oldCounts[taskId]?.[runner] ?? null;
            const after = newCounts[taskId]?.[runner] ?? null;
            rows.push({ task_id: taskId, runner, old: before, new: after, change: before && after ? roundTo(rate(after) - rate(before), 3) : null });
        }
    }
    const weight = (row: PairedRow) => (row.change === null ? -1 : Math.abs(row.change));
    const ordered = rows.map((row, index) => ({ row, index })).sort((first, second) => weight(second.row) - weight(first.row) || first.index - second.index);
    const runners = [...new Set(rows.map((row) => row.runner))];
    const totalsOf = (records: PassRecord[], runner: string) => {
        const own = records.filter((record) => record.runner === runner);
        if (own.length === 0) {
            return null;
        }
        const everyRound = passEveryRound(own, runner);
        return { passed: own.filter((record) => record.passed).length, runs: own.length, every_round: everyRound.passed, tasks: everyRound.tasks };
    };
    const totals = runners.map((runner) => {
        const changes = rows.filter((row) => row.runner === runner && row.change !== null).map((row) => row.change!);
        return {
            runner,
            old: totalsOf(oldRecords, runner),
            new: totalsOf(newRecords, runner),
            better: changes.filter((change) => change > 0).length,
            worse: changes.filter((change) => change < 0).length,
            same: changes.filter((change) => change === 0).length,
        };
    });
    return { rows: ordered.map(({ row }) => row), totals };
}

export function formatComparison(comparison: { rows: PairedRow[]; totals: PairedTotals[] }, oldName: string, newName: string): string {
    const width = Math.max(4, ...comparison.rows.map((row) => row.task_id.length));
    const runnerWidth = Math.max(6, ...comparison.rows.map((row) => row.runner.length));
    const cell = (counts: [number, number] | null) => (counts === null ? '-' : `${counts[0]}/${counts[1]}`);
    const header = `${left('task', width)} ${left('runner', runnerWidth)} ${right('old', 6)} ${right('new', 6)} ${right('change', 7)}`;
    const lines = [`Paired per task, old: ${oldName}, new: ${newName}`, header, '-'.repeat(header.length)];
    for (const row of comparison.rows) {
        const change = row.change === null ? 'only one' : row.change === 0 ? '0' : `${row.change > 0 ? '+' : ''}${row.change.toFixed(2)}`;
        lines.push(`${left(row.task_id, width)} ${left(row.runner, runnerWidth)} ${right(cell(row.old), 6)} ${right(cell(row.new), 6)} ${right(change, 7)}`);
    }
    lines.push('');
    for (const totals of comparison.totals) {
        const side = (counts: PairedTotals['old']) =>
            counts === null ? 'none' : `pooled ${counts.passed}/${counts.runs} ${percent(counts.passed / counts.runs)}, pass^k ${counts.every_round}/${counts.tasks}`;
        lines.push(`${totals.runner}: old ${side(totals.old)}; new ${side(totals.new)}; tasks better ${totals.better}, worse ${totals.worse}, same ${totals.same}`);
    }
    return lines.join('\n');
}

// ============================================================================
// Command line
// ============================================================================

const PROGRAM = 'codex eval';
const USAGE =
    `usage: ${PROGRAM} [-h] [--tasks TASKS] [--settings SETTINGS] [--runners RUNNERS] [--only ONLY] [--output OUTPUT]\n` +
    '                  [--seed-store SEED_STORE] [--seed [SEED]] [--repeat REPEAT] [--model-path MODEL_PATH] [--stream]\n' +
    '                  [--compare OLD] [--against NEW]';
const VALUE_OPTIONS = ['tasks', 'settings', 'runners', 'only', 'output', 'seed-store', 'repeat', 'model-path', 'compare', 'against'] as const;

function helpText(): string {
    return [
        USAGE,
        '',
        'Compare the bare model with the task tree on a fixed task set.',
        '',
        'options:',
        '  -h, --help            show this help message and exit',
        '  --tasks TASKS         Path to the JSON task set (default: evals/tasks.json).',
        '  --settings SETTINGS   Path to the JSON settings file.',
        '  --runners RUNNERS     Comma-separated runners to compare, from: bare, tree, agents.',
        '  --only ONLY           Comma-separated task ids to run instead of the whole set.',
        '  --output OUTPUT       Write every answer and score to this JSON file.',
        '  --seed-store SEED_STORE',
        '                        Also run the task tree with a copy of this knowledge store, to measure what recall adds.',
        '  --seed [SEED]         Build the seed store from this seed file (evals/seed.json when no file is named) and answer the',
        '                        recall task set, unless --tasks names another.',
        '  --repeat REPEAT       Run the whole set this many times and report pass rates, since one run cannot tell a change from',
        '                        chance.',
        '  --model-path MODEL_PATH',
        '                        Path to a GGUF model (overrides settings.json).',
        '  --stream              Print each step and tool call of every run as it happens.',
        '  --compare OLD         After the run, pair each task with its passes in this earlier --output file.',
        '  --against NEW         With --compare, pair the two result files without running anything or loading the model.',
    ].join('\n');
}

export type EvalArguments = {
    tasks: string | null;
    settings: string;
    runners: string;
    only: string | null;
    output: string | null;
    seed_store: string | null;
    seed: string | null;
    repeat: number;
    model_path: string | null;
    stream: boolean;
    compare: string | null;
    against: string | null;
};

class UsageError extends Error {}
class HelpRequested extends Error {}

function looksLikeFlag(word: string): boolean {
    return word.startsWith('-') && word !== '-' && !/^-\d+(\.\d*)?$/.test(word);
}

export function parseEvalArguments(argv: string[]): EvalArguments {
    const values: EvalArguments = {
        tasks: null,
        settings: defaultSettingsPath(),
        runners: RUNNER_CHOICES.join(','),
        only: null,
        output: null,
        seed_store: null,
        seed: null,
        repeat: 1,
        model_path: null,
        stream: false,
        compare: null,
        against: null,
    };
    const unrecognized: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
        const word = argv[index];
        if (word === '-h' || word === '--help') {
            throw new HelpRequested(helpText());
        }
        if (!word.startsWith('--') || !looksLikeFlag(word)) {
            unrecognized.push(word);
            continue;
        }
        const equals = word.indexOf('=');
        const flag = equals >= 0 ? word.slice(2, equals) : word.slice(2);
        let text = equals >= 0 ? word.slice(equals + 1) : null;
        if (flag === 'seed') {
            // --seed alone names the shipped seed file.
            if (text === null && index + 1 < argv.length && !looksLikeFlag(argv[index + 1])) {
                text = argv[index + 1];
                index += 1;
            }
            values.seed = text ?? DEFAULT_SEED_PATH;
            continue;
        }
        if (flag === 'stream' && text === null) {
            values.stream = true;
            continue;
        }
        if (!(VALUE_OPTIONS as readonly string[]).includes(flag)) {
            unrecognized.push(word);
            continue;
        }
        if (text === null) {
            const next = argv[index + 1];
            if (next === undefined || looksLikeFlag(next)) {
                throw new UsageError(`argument --${flag}: expected one argument`);
            }
            text = next;
            index += 1;
        }
        if (flag === 'repeat') {
            if (!/^\s*[-+]?\d+\s*$/.test(text)) {
                throw new UsageError(`argument --repeat: invalid int value: '${text}'`);
            }
            values.repeat = Number.parseInt(text, 10);
        } else {
            (values as Record<string, unknown>)[flag.replaceAll('-', '_')] = text;
        }
    }
    if (unrecognized.length > 0) {
        throw new UsageError(`unrecognized arguments: ${unrecognized.join(' ')}`);
    }
    return values;
}

function usageFailure(message: string): number {
    console.error(`${USAGE}\n${PROGRAM}: error: ${message}`);
    return 2;
}

// Run the eval from command-line words, returning the exit status: 0 done, 1 bad input, 2 bad command line.
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
    let args: EvalArguments;
    try {
        args = parseEvalArguments(argv);
    } catch (error) {
        if (error instanceof HelpRequested) {
            console.log(error.message);
            return 0;
        }
        return usageFailure(errorText(error));
    }
    if (args.repeat < 1) {
        return usageFailure('--repeat takes a whole number of at least 1');
    }
    if (args.against !== null && args.compare === null) {
        return usageFailure('--against needs --compare to name the older file');
    }
    let oldRecords: PassRecord[] | null = null;
    try {
        oldRecords = args.compare !== null ? loadResultRecords(args.compare) : null;
        if (args.against !== null) {
            console.log(formatComparison(compareResults(oldRecords!, loadResultRecords(args.against)), args.compare!, args.against));
            return 0;
        }
    } catch (error) {
        console.error(`Error: ${errorText(error)}`);
        return 1;
    }

    const runners = args.runners.split(',').map((name) => name.trim()).filter(Boolean);
    const unknown = runners.filter((name) => !(RUNNER_CHOICES as readonly string[]).includes(name));
    if (runners.length === 0 || unknown.length > 0) {
        return usageFailure(`--runners takes names from: ${RUNNER_CHOICES.join(', ')}`);
    }
    if (args.seed && args.seed_store) {
        return usageFailure('--seed and --seed-store each name the seed store; pass one of them');
    }
    if (args.tasks === null) {
        args.tasks = args.seed ? RECALL_TASKS_PATH : DEFAULT_TASKS_PATH;
    }
    let settings: Settings;
    let tasks: EvalTask[];
    try {
        const loaded: Record<string, unknown> = { ...loadSettings(args.settings) };
        if (args.model_path) {
            loaded.model_path = args.model_path;
        }
        settings = validateSettings(loaded);
        tasks = loadTasks(args.tasks);
        if (args.seed_store) {
            args.seed_store = expandUser(args.seed_store);
        }
        if (args.seed && !isFile(args.seed)) {
            throw new Error(`No seed file at ${args.seed}`);
        }
        if (args.seed_store && !isFile(args.seed_store)) {
            throw new Error(`No knowledge store at ${args.seed_store}`);
        }
    } catch (error) {
        console.error(`Error: ${errorText(error)}`);
        return 1;
    }
    if (args.only) {
        const wanted = new Set(args.only.split(',').map((taskId) => taskId.trim()));
        const known = new Set(tasks.map((task) => task.id));
        const missing = [...wanted].filter((taskId) => !known.has(taskId)).sort();
        if (missing.length > 0) {
            console.error(`Error: no task with id ${missing.join(', ')}.`);
            return 1;
        }
        tasks = tasks.filter((task) => wanted.has(task.id));
    }

    console.log(`Loading model from ${settings.model_path}...`);
    let llm: ChatModel;
    try {
        llm = await LocalModel.load(settings.model_path, settings.context_size, settings.gpu_layers);
    } catch (error) {
        console.error(`Error: ${errorText(error)}`);
        return 1;
    }
    const seedDirectory = mkdtempSync(join(tmpdir(), 'codex-seed-'));
    try {
        if (args.seed) {
            args.seed_store = join(seedDirectory, 'seed.sqlite3');
            console.log(`Building the seed store from ${args.seed}...`);
            try {
                await buildSeedStore(args.seed, args.seed_store, getEmbedder(settings.embedding_model_path));
            } catch (error) {
                console.error(`Error: bad seed file: ${errorText(error)}`);
                return 1;
            }
        }
        return await runAndReport(args, tasks, runners, llm, settings, oldRecords);
    } finally {
        rmSync(seedDirectory, { recursive: true, force: true });
        await llm.close?.();
    }
}

const REPORT_FLOAT_KEYS = new Set(['seconds', 'pass_rate', 'pass_every_round_rate', 'tool_choice_accuracy']);

async function runAndReport(
    args: EvalArguments,
    tasks: EvalTask[],
    runners: string[],
    llm: ChatModel,
    settings: Settings,
    oldRecords: PassRecord[] | null,
): Promise<number> {
    const results = await runEval(tasks, runners, llm, settings, {
        onResult: (result) => console.log(formatResult(result, args.repeat > 1)),
        onEvent: args.stream ? (line) => console.log(line) : undefined,
        seedStore: args.seed_store,
        repeat: args.repeat,
    });
    const labels = runnerLabels(runners, args.seed_store);
    const summary = summarize(results, labels);
    const counts = taskPassCounts(results);
    console.log();
    console.log(formatSummary(summary));
    const toolUse = formatToolUse(summary);
    if (toolUse) {
        console.log();
        console.log(toolUse);
    }
    console.log();
    console.log(formatTaskPasses(counts, labels));
    if (args.repeat > 1) {
        console.log();
        console.log(formatUnsteadyTasks(counts));
    }
    if (oldRecords !== null) {
        console.log();
        console.log(formatComparison(compareResults(oldRecords, results), args.compare!, 'this run'));
    }
    if (args.output) {
        const report = {
            model_path: settings.model_path,
            tasks_path: args.tasks,
            seed: args.seed,
            seed_store: !args.seed ? args.seed_store : null,
            repeat: args.repeat,
            summary,
            task_passes: Object.fromEntries(
                Object.entries(counts).map(([taskId, byRunner]) => [
                    taskId,
                    Object.fromEntries(Object.entries(byRunner).map(([runner, [passed, run]]) => [runner, { passed, runs: run, every_round: passed === run }])),
                ]),
            ),
            results: results.map((result) => result.toJson()),
        };
        writeFileSync(args.output, pythonJson(report, REPORT_FLOAT_KEYS) + '\n', 'utf-8');
        console.log(`\nWrote ${args.output}`);
    }
    return 0;
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    process.exit(await main());
}
