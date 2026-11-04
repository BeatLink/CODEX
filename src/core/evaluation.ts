// Compare the bare model with the task tree on a fixed task set, scoring each answer with checks that use no model.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { getEmbedder, type TextEmbedder } from './embeddings.js';
import { KnowledgeStore, type SearchResult } from './knowledge.js';
import { LocalModel, runStage, type ChatCompletion, type ChatCompletionRequest, type ChatModel } from './model.js';
import { defaultSettingsPath, expandUser, loadSettings, validateSettings, type Settings } from './settings.js';
import { executeTaskTree } from './taskTree.js';
import { PYTHON_COMMAND } from './tools.js';

export const EVALS_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'evals');
export const DEFAULT_TASKS_PATH = join(EVALS_DIRECTORY, 'tasks.json');
export const RECALL_TASKS_PATH = join(EVALS_DIRECTORY, 'recall_tasks.json');
export const DEFAULT_SEED_PATH = join(EVALS_DIRECTORY, 'seed.json');
export const RUNNER_CHOICES = ['bare', 'tree'] as const;
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

    constructor(fields: { id: string; prompt: string; checks: Check[]; mode?: string; files?: Record<string, string> }) {
        this.id = fields.id;
        this.prompt = fields.prompt;
        this.checks = fields.checks;
        this.mode = fields.mode ?? 'auto';
        this.files = fields.files ?? {};
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
        });
        if (!task.id || seenIds.has(task.id)) {
            throw new Error(`Each task needs a unique id; got ${pythonRepr(task.id)}.`);
        }
        if (!task.prompt) {
            throw new Error(`Task ${task.id} has no prompt.`);
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
    user_memory?: Array<{ kind: string; statement: string }>;
};

function required<T>(value: T | undefined, name: string): T {
    if (value === undefined) {
        throw new Error(`'${name}'`);
    }
    return value;
}

// Fill a new knowledge store from a seed file of topics, sources, facts, and user memory.
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
    for (const memory of seed.user_memory ?? []) {
        store.addUserMemory(required(memory.kind, 'kind'), required(memory.statement, 'statement'));
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

// Wrap the loaded model to count its calls and the tokens it generates.
export class CountingModel implements ChatModel {
    calls = 0;
    completionTokens = 0;

    constructor(private readonly llm: ChatModel) {}

    async createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletion> {
        this.calls += 1;
        const response: CompletionWithUsage = await this.llm.createChatCompletion(request);
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
            attempt: this.attempt,
            passed: this.passed,
        };
    }
}

function roundTo(value: number, places: number): number {
    const scale = 10 ** places;
    return Math.round(value * scale) / scale;
}

// Answer one task with one runner and score the answer, recording a failure as an error.
export async function runTask(
    task: EvalTask,
    runner: string,
    llm: ChatModel,
    settings: Settings,
    seedStore: string | null = null,
    attempt = 1,
): Promise<RunResult> {
    const countingModel = new CountingModel(llm);
    const label = seedStore !== null ? runner + SEEDED_SUFFIX : runner;
    const result = new RunResult({ task_id: task.id, runner: label, checks_total: task.checks.length, attempt });
    const started = performance.now();
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
            result.answer = await answerWith(runner, task, countingModel, settings, scratchDirectory);
        } catch (error) {
            result.error = error instanceof Error ? `${error.name}: ${error.message}` : `Error: ${String(error)}`;
        }
        result.seconds = roundTo((performance.now() - started) / 1000, 2);
        result.model_calls = countingModel.calls;
        result.completion_tokens = countingModel.completionTokens;
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

async function answerWith(runner: string, task: EvalTask, llm: ChatModel, settings: Settings, scratchDirectory: string): Promise<string> {
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
        mcpServers: [],
        knowledgeDbPath: join(scratchDirectory, 'knowledge.sqlite3'),
        embeddingModelPath: settings.embedding_model_path,
        llm,
        mode: task.mode,
        progressCallback: () => undefined,
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
    options: { onResult?: (result: RunResult) => void; seedStore?: string | null; repeat?: number } = {},
): Promise<RunResult[]> {
    const seedStore = options.seedStore ?? null;
    const repeat = options.repeat ?? 1;
    const results: RunResult[] = [];
    // Each round covers the whole set, so a run stopped early still holds complete rounds.
    for (let attempt = 1; attempt <= repeat; attempt += 1) {
        for (const task of tasks) {
            for (const label of runnerLabels(runners, seedStore)) {
                const runner = label.endsWith(SEEDED_SUFFIX) ? label.slice(0, -SEEDED_SUFFIX.length) : label;
                const result = await runTask(task, runner, llm, settings, label !== runner ? seedStore : null, attempt);
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
        summary[runner] = {
            tasks: own.length,
            tasks_passed: passed,
            pass_rate: own.length ? roundTo(passed / own.length, 3) : 0.0,
            round_passes: rounds.map((attempt) => own.filter((result) => result.passed && result.attempt === attempt).length),
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

export function formatSummary(summary: Record<string, RunnerSummary>): string {
    const repeated = Object.values(summary).some((totals) => totals.round_passes.length > 1);
    let header = `${left('runner', 14)} ${right('tasks', 9)} ${right('checks', 9)} ${right('errors', 6)} ${right('seconds', 9)} ${right('calls', 6)} ${right('tokens', 8)}`;
    if (repeated) {
        header += ` ${right('rate', 6)}  per round`;
    }
    const lines = [header, '-'.repeat(header.length)];
    for (const [runner, totals] of Object.entries(summary)) {
        let line =
            `${left(runner, 14)} ${right(totals.tasks_passed, 4)}/${left(totals.tasks, 4)} ` +
            `${right(totals.checks_passed, 4)}/${left(totals.checks_total, 4)} ${right(totals.errors, 6)} ` +
            `${right(totals.seconds.toFixed(1), 9)} ${right(totals.model_calls, 6)} ${right(totals.completion_tokens, 8)}`;
        if (repeated) {
            line += ` ${right(`${(totals.pass_rate * 100).toFixed(0)}%`, 6)}  ${totals.round_passes.join(' ')}`;
        }
        lines.push(line);
    }
    return lines.join('\n');
}

// Count, for each task and runner, the rounds it passed and the rounds it ran.
export function taskPassCounts(results: RunResult[]): Record<string, Record<string, [number, number]>> {
    const counts: Record<string, Record<string, [number, number]>> = {};
    for (const result of results) {
        const byRunner = (counts[result.task_id] ??= {});
        const passedAndRun = (byRunner[result.runner] ??= [0, 0]);
        passedAndRun[0] += Number(result.passed);
        passedAndRun[1] += 1;
    }
    return counts;
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
// Command line
// ============================================================================

const PROGRAM = 'codex eval';
const USAGE =
    `usage: ${PROGRAM} [-h] [--tasks TASKS] [--settings SETTINGS] [--runners RUNNERS] [--only ONLY] [--output OUTPUT]\n` +
    '                  [--seed-store SEED_STORE] [--seed [SEED]] [--repeat REPEAT] [--model-path MODEL_PATH]';
const VALUE_OPTIONS = ['tasks', 'settings', 'runners', 'only', 'output', 'seed-store', 'repeat', 'model-path'] as const;

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
        '  --runners RUNNERS     Comma-separated runners to compare, from: bare, tree.',
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
        return await runAndReport(args, tasks, runners, llm, settings);
    } finally {
        rmSync(seedDirectory, { recursive: true, force: true });
        await llm.close?.();
    }
}

const REPORT_FLOAT_KEYS = new Set(['seconds', 'pass_rate']);

async function runAndReport(args: EvalArguments, tasks: EvalTask[], runners: string[], llm: ChatModel, settings: Settings): Promise<number> {
    const results = await runEval(tasks, runners, llm, settings, {
        onResult: (result) => console.log(formatResult(result, args.repeat > 1)),
        seedStore: args.seed_store,
        repeat: args.repeat,
    });
    const summary = summarize(results, runnerLabels(runners, args.seed_store));
    const counts = taskPassCounts(results);
    console.log();
    console.log(formatSummary(summary));
    if (args.repeat > 1) {
        console.log();
        console.log(formatUnsteadyTasks(counts));
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
                    Object.fromEntries(Object.entries(byRunner).map(([runner, [passed, run]]) => [runner, { passed, runs: run }])),
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
