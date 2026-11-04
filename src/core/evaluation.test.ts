import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    CountingModel,
    DEFAULT_SEED_PATH,
    DEFAULT_TASKS_PATH,
    EVALS_DIRECTORY,
    EvalTask,
    RECALL_TASKS_PATH,
    buildSeedStore,
    checkPasses,
    compilePattern,
    formatSummary,
    formatUnsteadyTasks,
    loadTasks,
    main,
    runEval,
    runTask,
    summarize,
    taskPassCounts,
    type Check,
} from './evaluation.js';
import { KnowledgeStore } from './knowledge.js';
import { LocalModel, type ChatCompletion, type ChatCompletionRequest, type ChatModel } from './model.js';
import { DEFAULT_SETTINGS, type Settings } from './settings.js';
import { executeTaskTree, type ExecuteTaskTreeOptions } from './taskTree.js';

vi.mock('./taskTree.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./taskTree.js')>()), executeTaskTree: vi.fn() }));
vi.mock('./model.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('./model.js')>();
    return { ...original, LocalModel: { load: vi.fn() } };
});

const fakeTree = vi.mocked(executeTaskTree);
const loadModel = vi.mocked(LocalModel.load);
const SETTINGS = DEFAULT_SETTINGS as Settings;

// ============================================================================
// Helpers
// ============================================================================

// Answers every chat completion with the same reply and reports token usage.
class ReplyingModel implements ChatModel {
    constructor(public reply: string) {}

    async createChatCompletion(_request: ChatCompletionRequest): Promise<ChatCompletion> {
        return { content: this.reply, tool_calls: [], finish_reason: 'stop', usage: { completion_tokens: 7 } } as ChatCompletion;
    }
}

let directory: string;

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'codex-eval-test-'));
    fakeTree.mockReset();
    loadModel.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
});

function writeTasks(tasks: unknown): string {
    const path = join(directory, `tasks-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify(tasks), 'utf-8');
    return path;
}

function writeSettings(values: Record<string, unknown> = {}): string {
    const path = join(directory, 'settings.json');
    writeFileSync(path, JSON.stringify(values), 'utf-8');
    return path;
}

function writeSeedStore(): string {
    const path = join(directory, 'seed.sqlite3');
    const database = new DatabaseSync(path);
    database.exec('CREATE TABLE notes (text TEXT)');
    database.exec("INSERT INTO notes VALUES ('seeded')");
    database.close();
    return path;
}

const TASK = { id: 'sum', prompt: 'What is 2 + 2?', checks: [{ type: 'contains', value: '4' }] };

function sumTask(checks: Check[] = [{ type: 'contains', value: '4' }], mode = 'auto'): EvalTask {
    return new EvalTask({ id: 'sum', prompt: 'What is 2 + 2?', checks, mode });
}

// ============================================================================
// Loading tasks
// ============================================================================

describe('loadTasks', () => {
    it('loads the shipped task set', () => {
        const tasks = loadTasks(DEFAULT_TASKS_PATH);

        expect(tasks.length).toBeGreaterThan(0);
        expect(new Set(tasks.map((task) => task.id)).size).toBe(tasks.length);
    });

    it('loads the recall task set', () => {
        expect(loadTasks(RECALL_TASKS_PATH).length).toBeGreaterThan(0);
    });

    it('loads every shipped task set, compiling each pattern', () => {
        const names = readdirSync(EVALS_DIRECTORY).filter((name) => name.endsWith('_tasks.json') || name === 'tasks.json');

        const counts = names.map((name) => loadTasks(join(EVALS_DIRECTORY, name)).length);

        expect(names.length).toBe(4);
        expect(counts.every((count) => count > 0)).toBe(true);
    });

    it.each([
        [[TASK, TASK]],
        [[{ ...TASK, checks: [] }]],
        [[{ ...TASK, checks: [{ type: 'sounds_right' }] }]],
        [[{ ...TASK, checks: [{ type: 'regex', pattern: '(' }] }]],
        [[{ ...TASK, checks: [{ type: 'not_regex', pattern: '(' }] }]],
        [[{ ...TASK, checks: [{ type: 'max_words', value: 'ten' }] }]],
        [[{ ...TASK, mode: 'execute' }]],
    ])('rejects duplicate ids, bad checks and execute mode without files: %j', (tasks) => {
        const path = writeTasks(tasks);

        expect(() => loadTasks(path)).toThrow();
    });
});

// ============================================================================
// Seed store
// ============================================================================

describe('buildSeedStore', () => {
    it('builds a store from the shipped seed that recalls its facts, sources and user memory', async () => {
        const databasePath = join(directory, 'seed.sqlite3');

        await buildSeedStore(DEFAULT_SEED_PATH, databasePath);
        const store = new KnowledgeStore(databasePath);
        const recalled = await store.recall('What TCP port does the Kestrel ingest service listen on?');
        const sources = store.search('Kestrel ingest port');
        const topics = Object.fromEntries(store.topics().map((topic) => [topic.name, topic]));

        expect(recalled.facts.some((fact) => fact.statement.includes('7413'))).toBe(true);
        expect(recalled.user.some((memory) => String(memory.statement).includes('ISO 8601'))).toBe(true);
        expect(sources.some((source) => String(source.snippet).includes('7413'))).toBe(true);
        expect(topics['Kestrel ingest'].parent_id).toBe(topics['Halvorsen Lab'].id);
    });

    it('rejects a seed without facts', async () => {
        const seedPath = join(directory, 'seed.json');
        writeFileSync(seedPath, JSON.stringify({ topics: [] }), 'utf-8');

        await expect(buildSeedStore(seedPath, join(directory, 'seed.sqlite3'))).rejects.toThrow();
    });
});

// ============================================================================
// Checks
// ============================================================================

describe('checkPasses', () => {
    const answer = 'The answer is Carol.\n- red';

    it.each<[Check, boolean]>([
        [{ type: 'contains', value: 'carol' }, true],
        [{ type: 'contains_any', values: ['Bob', 'CAROL'] }, true],
        [{ type: 'not_contains', value: 'carol' }, false],
        [{ type: 'regex', pattern: '^- red$' }, true],
        [{ type: 'not_regex', pattern: '^- red$' }, false],
        [{ type: 'not_regex', pattern: 'carol\\s+is' }, true],
        [{ type: 'max_words', value: 5 }, false],
        [{ type: 'min_words', value: 5 }, true],
    ])('scores %j', async (check, expected) => {
        expect(await checkPasses(answer, check)).toBe(expected);
    });

    it('reads \\A and \\Z as the start and end of the whole answer', () => {
        const pattern = compilePattern('\\A\\s*(- [^\\n]+\\n){1}- [^\\n]+\\s*\\Z');

        expect(pattern.test('- one\n- two\n')).toBe(true);
        expect(pattern.test('Intro\n- one\n- two')).toBe(false);
        expect(pattern.test('- one\n- two\nAfter')).toBe(false);
        expect(compilePattern('\\AAlpha').test('Alpha')).toBe(true);
    });
});

// ============================================================================
// Running tasks
// ============================================================================

describe('runTask', () => {
    it('scores a bare answer and counts calls and tokens', async () => {
        const task = sumTask([
            { type: 'contains', value: '4' },
            { type: 'contains', value: 'five' },
        ]);

        const result = await runTask(task, 'bare', new ReplyingModel('It is 4.'), SETTINGS);

        expect(result.answer).toBe('It is 4.');
        expect([result.checks_passed, result.checks_total]).toEqual([1, 2]);
        expect(result.failed_checks).toEqual(["contains 'five'"]);
        expect(result.passed).toBe(false);
        expect([result.model_calls, result.completion_tokens]).toEqual([1, 7]);
    });

    it('gives the tree runner an empty store and a scratch root', async () => {
        let seen: ExecuteTaskTreeOptions = {};
        fakeTree.mockImplementation(async (_prompt, options = {}) => {
            seen = options;
            expect(existsSync(options.knowledgeDbPath!)).toBe(false);
            return '4';
        });

        const result = await runTask(sumTask(undefined, 'answer'), 'tree', new ReplyingModel(''), SETTINGS);

        expect(result.passed).toBe(true);
        expect(seen.mode).toBe('answer');
        expect(seen.mcpServers).toEqual([]);
        expect(dirname(seen.knowledgeDbPath!)).toBe(dirname(seen.filesystemRoot!));
        expect(seen.allowFileWrites).toBe(false);
        expect(seen.llm).toBeInstanceOf(CountingModel);
        expect(existsSync(seen.filesystemRoot!)).toBe(false);
    });

    it('answers a seeded run from a copy of the seed store', async () => {
        fakeTree.mockImplementation(async (_prompt, options = {}) => {
            const database = new DatabaseSync(options.knowledgeDbPath!);
            const text = (database.prepare('SELECT text FROM notes').get() as { text: string }).text;
            database.exec('DELETE FROM notes');
            database.close();
            return text;
        });
        const task = new EvalTask({ id: 'seed', prompt: 'What was stored?', checks: [{ type: 'contains', value: 'seeded' }] });
        const seedPath = writeSeedStore();

        const result = await runTask(task, 'tree', new ReplyingModel(''), SETTINGS, seedPath);
        const database = new DatabaseSync(seedPath);
        const remaining = (database.prepare('SELECT COUNT(*) AS count FROM notes').get() as { count: number }).count;
        database.close();

        expect(result.passed).toBe(true);
        expect(result.runner).toBe('tree+store');
        expect(remaining).toBe(1);
    });

    it('adds a seeded run for each runner that recalls', async () => {
        fakeTree.mockResolvedValue('4');
        const seedPath = writeSeedStore();

        const results = await runEval([sumTask()], ['bare', 'tree'], new ReplyingModel('4'), SETTINGS, { seedStore: seedPath });

        expect(results.map((result) => result.runner)).toEqual(['bare', 'tree', 'tree+store']);
    });

    it('records a failing run as an error that scores nothing', async () => {
        fakeTree.mockRejectedValue(new Error('token limit'));

        const result = await runTask(sumTask([{ type: 'not_contains', value: '5' }]), 'tree', new ReplyingModel(''), SETTINGS);

        expect(result.error).toBe('Error: token limit');
        expect(result.checks_passed).toBe(0);
        expect(result.passed).toBe(false);
    });

    it('totals each runner in the summary', async () => {
        const results = [
            await runTask(sumTask(), 'bare', new ReplyingModel('4'), SETTINGS),
            await runTask(sumTask(), 'bare', new ReplyingModel('3'), SETTINGS),
        ];

        const totals = summarize(results, ['bare']).bare;

        expect([totals.tasks, totals.tasks_passed, totals.checks_passed]).toEqual([2, 1, 1]);
        expect([totals.model_calls, totals.completion_tokens]).toEqual([2, 14]);
    });

    it('reports each round of a repeated eval and the tasks that passed only sometimes', async () => {
        const steady = new EvalTask({ id: 'steady', prompt: 'Say 4.', checks: [{ type: 'contains', value: '4' }] });
        const unsteady = new EvalTask({ id: 'unsteady', prompt: 'Say 5.', checks: [{ type: 'contains', value: '5' }] });
        class AlternatingModel extends ReplyingModel {
            callsMade = 0;
            override async createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletion> {
                this.callsMade += 1;
                this.reply = this.callsMade === 2 || this.callsMade === 4 ? '4 and 5' : '4';
                return super.createChatCompletion(request);
            }
        }

        const results = await runEval([steady, unsteady], ['bare'], new AlternatingModel(''), SETTINGS, { repeat: 3 });
        const totals = summarize(results, ['bare']).bare;
        const counts = taskPassCounts(results);

        expect(results.map((result) => result.attempt)).toEqual([1, 1, 2, 2, 3, 3]);
        expect(totals.round_passes).toEqual([2, 2, 1]);
        expect(totals.pass_rate).toBe(Math.round((5 / 6) * 1000) / 1000);
        expect(counts.unsteady.bare).toEqual([2, 3]);
        expect(formatUnsteadyTasks(counts)).toContain('unsteady: bare 2/3');
        expect(formatUnsteadyTasks(counts).replace('unsteady:', '')).not.toContain('steady:');
        expect(formatSummary(summarize(results, ['bare']))).toContain('per round');
    });
});

// ============================================================================
// Tasks with files
// ============================================================================

const RANGES_TASK = {
    id: 'fix',
    mode: 'execute',
    prompt: 'Fix ranges.py so the tests pass.',
    files: {
        'ranges.py': 'def inclusive_range(start, end):\n    return list(range(start, end))\n',
        'test_ranges.py':
            'import unittest\nfrom ranges import inclusive_range\n\n\n' +
            'class Tests(unittest.TestCase):\n' +
            '    def test_ends(self):\n        self.assertEqual(inclusive_range(1, 3), [1, 2, 3])\n',
    },
    checks: [
        { type: 'tests_pass' },
        { type: 'file_unchanged', path: 'test_ranges.py' },
        { type: 'file_contains', path: 'ranges.py', value: 'end + 1' },
    ],
};
const FIXED_RANGES = 'File: ranges.py\n```python\ndef inclusive_range(start, end):\n    return list(range(start, end + 1))\n```\n';

function rangesTask(): EvalTask {
    return loadTasks(writeTasks([RANGES_TASK]))[0];
}

describe('tasks with files', () => {
    it('fails every shipped execute task when nothing is changed', async () => {
        for (const task of loadTasks(join(EVALS_DIRECTORY, 'execute_tasks.json'))) {
            const result = await runTask(task, 'bare', new ReplyingModel('I changed nothing.'), SETTINGS);

            expect(task.mode, task.id).toBe('execute');
            expect(result.error, task.id).toBe('');
            expect(result.passed, task.id).toBe(false);
        }
    });

    it.each([
        [[{ ...TASK, checks: [{ type: 'tests_pass' }] }]],
        [[{ ...RANGES_TASK, checks: [{ type: 'file_unchanged', path: 'other.py' }] }]],
        [[{ ...RANGES_TASK, checks: [{ type: 'file_contains', path: 'ranges.py' }] }]],
        [[{ ...RANGES_TASK, files: { 'ranges.py': 3 } }]],
    ])('rejects file checks without files and paths the task does not have: %j', (tasks) => {
        const path = writeTasks(tasks);

        expect(() => loadTasks(path)).toThrow();
    });

    it('shows the bare runner the files and writes its file blocks back', async () => {
        const prompts: string[] = [];
        class FixingModel extends ReplyingModel {
            override async createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletion> {
                prompts.push(request.messages[1].content ?? '');
                return super.createChatCompletion(request);
            }
        }

        const result = await runTask(rangesTask(), 'bare', new FixingModel(FIXED_RANGES), SETTINGS);

        expect(prompts[0]).toContain('File: test_ranges.py');
        expect(result.failed_checks).toEqual([]);
        expect(result.passed).toBe(true);
    });

    it('records a bare file block outside the workspace as an error', async () => {
        const escaping = FIXED_RANGES.replace('File: ranges.py', 'File: ../ranges.py');

        const result = await runTask(rangesTask(), 'bare', new ReplyingModel(escaping), SETTINGS);

        expect(result.error).toContain('outside the workspace');
    });

    it('lets the tree runner write and test in a workspace holding the files', async () => {
        let seen: ExecuteTaskTreeOptions = {};
        let names: string[] = [];
        fakeTree.mockImplementation(async (_prompt, options = {}) => {
            seen = options;
            names = readdirSync(options.filesystemRoot!).sort();
            writeFileSync(join(options.filesystemRoot!, 'test_ranges.py'), 'changed', 'utf-8');
            return 'Done.';
        });

        const result = await runTask(rangesTask(), 'tree', new ReplyingModel(''), SETTINGS);

        expect(names).toEqual(['ranges.py', 'test_ranges.py']);
        expect(seen.allowFileWrites && seen.enableTestExecution).toBe(true);
        expect(seen.mode).toBe('execute');
        expect(result.failed_checks).toEqual(['tests_pass', 'file_unchanged test_ranges.py', "file_contains ranges.py 'end + 1'"]);
    });
});

// ============================================================================
// Command line
// ============================================================================

describe('main', () => {
    it('runs the chosen tasks and writes a report', async () => {
        loadModel.mockResolvedValue(new ReplyingModel('4') as unknown as LocalModel);
        const tasksPath = writeTasks([TASK, { ...TASK, id: 'other' }]);
        const outputPath = join(directory, 'report.json');

        const exitCode = await main(['--settings', writeSettings(), '--tasks', tasksPath, '--runners', 'bare', '--only', 'sum', '--output', outputPath]);
        const text = readFileSync(outputPath, 'utf-8');
        const report = JSON.parse(text);

        expect(exitCode).toBe(0);
        expect(report.results.map((result: { task_id: string }) => result.task_id)).toEqual(['sum']);
        expect(report.results[0].passed).toBe(true);
        expect(report.summary.bare.tasks_passed).toBe(1);
        expect(text).toContain('"pass_rate": 1.0');
    });

    it('runs each round of --repeat and reports passes per task', async () => {
        loadModel.mockResolvedValue(new ReplyingModel('4') as unknown as LocalModel);
        const settingsPath = writeSettings();
        const tasksPath = writeTasks([TASK]);
        const outputPath = join(directory, 'report.json');

        const exitCode = await main(['--settings', settingsPath, '--tasks', tasksPath, '--runners', 'bare', '--repeat', '2', '--output', outputPath]);
        const badRepeat = await main(['--settings', settingsPath, '--tasks', tasksPath, '--repeat', '0']);
        const report = JSON.parse(readFileSync(outputPath, 'utf-8'));

        expect(exitCode).toBe(0);
        expect(badRepeat).toBe(2);
        expect(loadModel).toHaveBeenCalledTimes(1);
        expect(report.repeat).toBe(2);
        expect(report.task_passes).toEqual({ sum: { bare: { passed: 2, runs: 2 } } });
        expect(report.summary.bare.round_passes).toEqual([1, 1]);
    });

    it('builds the seed store with --seed and answers the recall tasks with and without it', async () => {
        loadModel.mockResolvedValue(new ReplyingModel('') as unknown as LocalModel);
        fakeTree.mockResolvedValue('7413');
        const outputPath = join(directory, 'report.json');

        const exitCode = await main(['--settings', writeSettings({ embedding_model_path: '' }), '--seed', '--runners', 'tree', '--only', 'recall-port', '--output', outputPath]);
        const report = JSON.parse(readFileSync(outputPath, 'utf-8'));

        expect(exitCode).toBe(0);
        expect(report.tasks_path).toBe(RECALL_TASKS_PATH);
        expect(new Set(Object.keys(report.summary))).toEqual(new Set(['tree', 'tree+store']));
    });

    it('fails on an unknown task id, seed store or runner before loading the model', async () => {
        const settingsPath = writeSettings();
        const tasksPath = writeTasks([TASK]);

        const missingTask = await main(['--settings', settingsPath, '--tasks', tasksPath, '--only', 'missing']);
        const missingStore = await main(['--settings', settingsPath, '--tasks', tasksPath, '--seed-store', join(directory, 'none')]);
        const unknownRunner = await main(['--settings', settingsPath, '--tasks', tasksPath, '--runners', 'bare,magic']);

        expect(missingTask).toBe(1);
        expect(missingStore).toBe(1);
        expect(unknownRunner).toBe(2);
        expect(loadModel).not.toHaveBeenCalled();
    });
});
