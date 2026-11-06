import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActionRecord } from './checks.js';
import { CONDENSED_MARKER } from './contextBudget.js';
import { CONDENSE_PROMPT } from './evidence.js';
import { SKILLS_LABEL } from './instructions.js';
import { KnowledgeStore } from './knowledge.js';
import type { ChatCompletion, ChatCompletionRequest, ChatModel } from './model.js';
import type { McpServerSettings } from './settings.js';
import {
    CHECK_PROMPT,
    COMBINE_PROMPT,
    DECISION_PROMPT,
    REPLAN_PROMPT,
    REVISE_NOTE,
    ROOT_COMBINE_PROMPT,
    SPLIT_PROMPT,
    WRITE_PROMPT,
    TaskNode,
    TaskTree,
    executeTaskTree,
    parseCheck,
    parseDecision,
    parseSubtasks,
    type ExecuteTaskTreeOptions,
    type TaskSnapshot,
} from './taskTree.js';

const mocks = vi.hoisted(() => ({ searchWithMemory: vi.fn(), runToolStage: vi.fn() }));

vi.mock('./evidence.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./evidence.js')>()),
    searchWithMemory: mocks.searchWithMemory,
}));

vi.mock('./toolStage.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./toolStage.js')>()),
    runToolStage: mocks.runToolStage,
}));

// ============================================================================
// Scripted model
// ============================================================================

type Reply = string | Error;
type Script = Record<string, Reply | Reply[]>;
type Call = { step: string; task: string | null; system: string; input: string; json_schema?: Record<string, any> };

// A tool stage or search a test did not expect, which no task may swallow.
class UnexpectedCall extends Error {}

// Stands in for a cancel or a crash in the middle of a run.
class Interrupted extends Error {}

function decision(
    approach: string,
    options: { facts?: string[]; queries?: string[]; subtasks?: Array<[string, number[]]>; clarification?: string; agent?: string } = {},
): string {
    const reply: Record<string, unknown> = {
        reason: 'Because.',
        facts_to_check: options.facts ?? [],
        approach,
        search_queries: options.queries ?? [],
        subtasks: (options.subtasks ?? []).map(([prompt, dependsOn]) => ({ prompt, deliverable: `${prompt} done`, depends_on: dependsOn })),
    };
    if (options.clarification !== undefined) {
        reply.clarification = options.clarification;
    }
    if (options.agent !== undefined) {
        reply.agent = options.agent;
    }
    return JSON.stringify(reply);
}

function check(verdict = 'met', problem = ''): string {
    return JSON.stringify({ verdict, problem });
}

function subtasks(...prompts: string[]): string {
    return JSON.stringify({ subtasks: prompts.map((prompt) => ({ prompt, deliverable: `${prompt} done`, depends_on: [] })) });
}

function stepOf(systemPrompt: string): string {
    if (systemPrompt.startsWith(CONDENSE_PROMPT)) return 'condense';
    if (systemPrompt.startsWith(DECISION_PROMPT)) return 'decide';
    if (systemPrompt.startsWith(SPLIT_PROMPT)) return 'split';
    if (systemPrompt.startsWith(REPLAN_PROMPT)) return 'replan';
    if (systemPrompt.startsWith(CHECK_PROMPT)) return 'check';
    if (systemPrompt.includes(REVISE_NOTE)) return 'revise';
    if (systemPrompt.startsWith(COMBINE_PROMPT) || systemPrompt.startsWith(ROOT_COMBINE_PROMPT)) return 'combine';
    return 'write';
}

// Answers each step of each task from a script keyed "step task", such as "decide 1.2".
class ScriptedModel implements ChatModel {
    readonly replies = new Map<string, Reply[]>();
    readonly calls: Call[] = [];

    constructor(script: Script) {
        for (const [key, value] of Object.entries(script)) {
            this.replies.set(key, Array.isArray(value) ? [...value] : [value]);
        }
    }

    async createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletion> {
        const system = request.messages[0].content ?? '';
        const input = request.messages[1].content ?? '';
        const step = stepOf(system);
        const jsonSchema = request.response_format?.schema as Record<string, any> | undefined;
        if (step === 'condense') {
            this.calls.push({ step, task: null, system, input, json_schema: jsonSchema });
            return { content: 'Condensed findings.', tool_calls: [], finish_reason: 'stop' };
        }
        const task = /Current task:\nTask (\S+):/.exec(input)![1];
        this.calls.push({ step, task, system, input, json_schema: jsonSchema });
        const queued = this.replies.get(`${step} ${task}`);
        if (!queued || queued.length === 0) {
            if (step === 'check') {
                return { content: check(), tool_calls: [], finish_reason: 'stop' };
            }
            throw new UnexpectedCall(`No scripted reply for ${step} of task ${task}`);
        }
        const reply = queued.length > 1 ? queued.shift()! : queued[0];
        if (reply instanceof Error) {
            throw reply;
        }
        return { content: reply, tool_calls: [], finish_reason: 'stop' };
    }

    steps(): string[] {
        return this.calls.map((call) => `${call.step} ${call.task}`);
    }

    call(step: string, task: string): Call {
        const found = this.calls.find((call) => call.step === step && call.task === task);
        if (!found) {
            throw new Error(`No ${step} call for task ${task}`);
        }
        return found;
    }
}

const NOTHING_FOUND: [string, string, boolean] = ['Automatic web search result', '[]', false];

let workDirectory: string;

beforeAll(() => {
    workDirectory = mkdtempSync(join(tmpdir(), 'codex-task-tree-'));
    // The user's own config files never reach these tests.
    vi.stubEnv('XDG_CONFIG_HOME', join(workDirectory, 'config'));
});

afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(workDirectory, { recursive: true, force: true });
});

beforeEach(() => {
    mocks.searchWithMemory.mockReset().mockResolvedValue(NOTHING_FOUND);
    mocks.runToolStage.mockReset().mockRejectedValue(new UnexpectedCall('tool stage'));
});

function runOptions(model: ScriptedModel, options: ExecuteTaskTreeOptions = {}): ExecuteTaskTreeOptions {
    return { llm: model, filesystemRoot: workDirectory, progressCallback: () => {}, ...options };
}

async function runTree(script: Script, options: ExecuteTaskTreeOptions & { prompt?: string; searches?: string[] } = {}) {
    const { prompt = 'Explain the plan', searches = [], ...rest } = options;
    const model = new ScriptedModel(script);
    const progress: string[] = [];
    const trees: TaskSnapshot[][] = [];
    mocks.searchWithMemory.mockImplementation(async (query: string) => {
        searches.push(query);
        return NOTHING_FOUND;
    });

    const result = await executeTaskTree(prompt, {
        ...runOptions(model, rest),
        progressCallback: (label) => progress.push(label),
        treeCallback: (nodes) => trees.push(nodes),
    });

    return { result, model, progress, trees };
}

function offered(model: ScriptedModel, task: string): string[] {
    return model.call('decide', task).json_schema!.properties.approach.enum;
}

// ============================================================================
// Direct tasks
// ============================================================================

describe('direct tasks', () => {
    it('decides, writes and checks a simple request', async () => {
        const searches: string[] = [];

        const { result, model, progress, trees } = await runTree(
            { 'decide 1': decision('answer'), 'write 1': 'Four.' },
            { prompt: 'What is 2 + 2?', searches },
        );

        expect(result).toBe('Four.');
        expect(searches).toEqual([]);
        expect(model.call('write', '1').input).toContain("Today's date:\n20");
        expect(model.steps()).toEqual(['decide 1', 'write 1', 'check 1']);
        expect(progress).toEqual(['Task 1 · Deciding', 'Task 1 · Writing', 'Task 1 · Checking']);
        expect(trees.at(-1)![0].status).toBe('done');
        expect(trees.at(-1)![0].approach).toBe('answer');
    });

    it("reports each model call's instructions and input under its step", async () => {
        const inputs: Array<[string, string, string]> = [];

        const { model } = await runTree(
            { 'decide 1': decision('answer'), 'write 1': 'Four.' },
            { prompt: 'What is 2 + 2?', stageInputCallback: (label, system, input) => inputs.push([label, system, input]) },
        );

        expect(inputs.map(([label]) => label)).toEqual(['Task 1 · Deciding', 'Task 1 · Writing', 'Task 1 · Checking']);
        expect(inputs[1][1]).toBe(model.call('write', '1').system);
        expect(inputs[1][2]).toBe(model.call('write', '1').input);
    });

    it('offers only the approaches the settings allow', async () => {
        const first = await runTree({ 'decide 1': decision('answer'), 'write 1': 'Done.' });
        expect(offered(first.model, '1')).toEqual(['answer', 'research', 'files', 'decompose']);

        const second = await runTree({ 'decide 1': decision('answer'), 'write 1': 'Done.' }, { allowFileWrites: true, maxTaskDepth: 0 });
        expect(offered(second.model, '1')).toEqual(['answer', 'research', 'files', 'act']);
    });

    it('gives a top-level answer one quick search unless it is self-contained', async () => {
        const searches: string[] = [];

        const { model } = await runTree(
            { 'decide 1': decision('answer'), 'write 1': 'I could not look that up.' },
            { prompt: 'Who maintains Zorblex?', searches },
        );

        expect(searches).toEqual(['Who maintains Zorblex?']);
        expect(model.call('write', '1').system).toContain('Every search failed or found nothing');
    });

    it('never acts in answer and draft modes, and a prefix picks the mode', async () => {
        const planned = await runTree(
            { 'decide 1': decision('answer'), 'write 1': 'Plan.' },
            { prompt: '/plan Reorganise the notes folder', allowFileWrites: true },
        );

        expect(offered(planned.model, '1')).not.toContain('act');
        expect(planned.model.call('decide', '1').input).toContain('Original user request:\nReorganise the notes folder');

        const executed = await runTree({ 'decide 1': decision('answer'), 'write 1': 'Done.' }, { allowFileWrites: true, mode: 'execute' });
        expect(offered(executed.model, '1')).toContain('act');
    });

    it('holds an acting task report to the recorded file writes', async () => {
        const model = new ScriptedModel({
            'decide 1': decision('act'),
            'write 1': 'I have updated a.py.',
            'revise 1': 'The change to a.py could not be made: file access is read-only.',
        });
        mocks.runToolStage.mockImplementation(async (_llm, _system, _input, toolbox: { actionLog: ActionRecord[] }) => {
            toolbox.actionLog.push(['write_file', { path: 'a.py' }, 'Tool error: file access is read-only.']);
            return 'Writing a.py failed.';
        });

        const result = await executeTaskTree('Fix a.py', runOptions(model, { allowFileWrites: true, mode: 'execute', maxTaskDepth: 0 }));

        expect(result).toBe('The change to a.py could not be made: file access is read-only.');
        expect(model.call('revise', '1').input).toContain('No file was written');
    });

    it('makes an execute subtask that would only read files act instead', async () => {
        const model = new ScriptedModel({
            'decide 1': decision('decompose', { subtasks: [['Read ranges.py', []], ['Explain the bug', [1]]] }),
            'decide 1.1': decision('files'),
            'decide 1.2': decision('answer'),
            'write 1.1': 'The function returns range(start, end).',
            'write 1.2': 'The bug is on line 3.',
            'combine 1': 'The bug is on line 3.',
        });
        const blocked: unknown[] = [];
        mocks.runToolStage.mockImplementation(async (_llm, _system, _input, _toolbox, _maxTokens, _temperature, _maxToolCalls, options: { blockedTools?: Set<string> }) => {
            blocked.push(options.blockedTools);
            return 'Read ranges.py.';
        });

        await executeTaskTree('Fix ranges.py', runOptions(model, { allowFileWrites: true, mode: 'execute' }));

        // Acting blocks only the web tools, so the task can both read and write files.
        expect(blocked).toEqual([new Set(['web_search', 'web_fetch'])]);
    });

    it('stops a task that did not act from claiming a change', async () => {
        const { model } = await runTree(
            {
                'decide 1': decision('answer'),
                'write 1': 'Fixed ranges.py and all tests now pass.',
                'revise 1': 'The fix is to use range(start, end + 1); no file was changed.',
            },
            { prompt: 'What is wrong in ranges.py?', allowFileWrites: true, maxTaskDepth: 0 },
        );

        const correction = model.call('revise', '1').input;
        expect(correction).toContain('No file was written');
        expect(correction).toContain('No test run passed');
    });

    it('has writers show their working and the check redo calculations', async () => {
        const { model } = await runTree({ 'decide 1': decision('answer'), 'write 1': '14 + 28 = 42.' }, { prompt: 'What is 14 + 28?' });

        expect(model.call('write', '1').system).toContain('work it out step by step');
        expect(model.call('check', '1').system).toContain('Redo any arithmetic, count, or date calculation');
        for (const prompt of [WRITE_PROMPT, COMBINE_PROMPT, ROOT_COMBINE_PROMPT]) {
            expect(prompt).toContain('never give such a result as a bare number');
        }
    });

    it('makes an execute request act or split at the top, with room to read, write and test', async () => {
        const model = new ScriptedModel({ 'decide 1': decision('act'), 'write 1': 'Wrote nothing.' });
        const budgets: number[] = [];
        mocks.runToolStage.mockImplementation(async (_llm, _system, _input, _toolbox, _maxTokens, _temperature, maxToolCalls: number) => {
            budgets.push(maxToolCalls);
            return 'No action was needed.';
        });

        await executeTaskTree('Fix ranges.py', runOptions(model, { allowFileWrites: true, mode: 'execute', maxToolCalls: 3 }));

        expect(offered(model, '1')).toEqual(['act', 'decompose']);
        expect(budgets).toEqual([8]);
    });

    it('sends a wrong sum in the result back for revision', async () => {
        const { result, model } = await runTree(
            {
                'decide 1': decision('answer'),
                'write 1': '17 × 3 = 41, so the answer is 41.',
                'revise 1': '17 × 3 = 51, so the answer is 51.',
            },
            { prompt: 'What is 17 * 3?', maxTaskDepth: 0 },
        );

        expect(result).toBe('17 × 3 = 51, so the answer is 51.');
        expect(model.call('revise', '1').input).toContain('The working states 17 * 3 = 41, but it equals 51.');
    });

    it('turns an answer with listed facts into research', async () => {
        const searches: string[] = [];
        mocks.searchWithMemory.mockImplementation(async (query: string) => {
            searches.push(query);
            return ['Local knowledge result', '[{"url": "https://pine64.org", "summary": "A watch"}]', true];
        });
        const model = new ScriptedModel({
            'decide 1': decision('answer', { facts: ['What a PineTime is'], queries: ['PineTime watch'] }),
            'write 1': 'A watch, per https://pine64.org.',
        });

        const result = await executeTaskTree('What is a PineTime?', runOptions(model));

        expect(result).toBe('A watch, per https://pine64.org.');
        // The request's own words are always searched first.
        expect(searches).toEqual(['What is a PineTime?', 'PineTime watch']);
        expect(model.call('write', '1').system).not.toContain('Every search failed');
        expect(model.call('write', '1').system).toContain('captured search evidence');
        expect(model.call('write', '1').input).toContain('https://pine64.org');
    });

    it('runs the tool stage for research without stored summaries', async () => {
        const toolCalls: Array<{ allowedTools?: Set<string> }> = [];
        mocks.runToolStage.mockImplementation(async (_llm, _system, _input, _toolbox, _maxTokens, _temperature, _maxToolCalls, options: { allowedTools?: Set<string> }) => {
            toolCalls.push(options);
            return 'Finding from https://docs.example/a';
        });
        const model = new ScriptedModel({
            'decide 1': decision('research', { queries: ['sqlite wal'] }),
            'write 1': 'WAL is a journal mode (https://docs.example/a).',
        });

        const result = await executeTaskTree('Explain SQLite WAL', runOptions(model));

        expect(result).toContain('WAL');
        expect(toolCalls[0].allowedTools).toEqual(new Set(['web_search', 'web_fetch', 'list_directory', 'read_file']));
        expect(model.call('write', '1').input).toContain('Finding from https://docs.example/a');
    });

    it('runs no tool for a declined action and asks about it once', async () => {
        const questions: string[] = [];
        const model = new ScriptedModel({
            'decide 1': decision('decompose', { subtasks: [['Edit a.py', []], ['Edit b.py', []]] }),
            'decide 1.1': decision('act'),
            'decide 1.2': decision('act'),
            'write 1.1': 'Not changed.',
            'write 1.2': 'Not changed.',
            'combine 1': 'Nothing was edited.',
        });

        await executeTaskTree(
            '/do Edit both files',
            runOptions(model, {
                allowFileWrites: true,
                clarificationCallback: async (question) => {
                    questions.push(question);
                    return 'no';
                },
            }),
        );

        expect(questions).toHaveLength(1);
        expect(questions[0]).toContain('Task 1.1: Edit a.py');
        expect(model.call('write', '1.2').input).toContain('did not approve the actions');
    });

    it('revises once after a failed check, then accepts the result as unverified', async () => {
        const { result, model, trees } = await runTree(
            {
                'decide 1': decision('answer'),
                'write 1': 'Draft',
                'check 1': check('partly met', 'Add the second part.'),
                'revise 1': 'Revised',
            },
            { maxTaskDepth: 0 },
        );

        expect(result).toBe('Revised');
        expect(model.steps()).toEqual(['decide 1', 'write 1', 'check 1', 'revise 1', 'check 1']);
        const reviseInput = model.call('revise', '1').input;
        expect(reviseInput).toContain('Correction needed:\nAdd the second part.');
        expect(reviseInput).toContain('Previous attempt:\nDraft');
        expect(trees.at(-1)![0].status).toBe('unverified');
    });

    it('keeps the attempt after a failed revision and splits the task', async () => {
        const { result, model, trees } = await runTree({
            'decide 1': decision('answer'),
            'write 1': 'Thin draft',
            'check 1': [check('missing', 'Covers one part only.'), check()],
            'revise 1': new Error('A model call reached the token limit'),
            'split 1': subtasks('First part', 'Second part'),
            'decide 1.1': decision('answer'),
            'write 1.1': 'one',
            'decide 1.2': decision('answer'),
            'write 1.2': 'two',
            'combine 1': 'One and two',
        });

        expect(result).toBe('One and two');
        expect(model.call('split', '1').input).toContain('Failed attempt:\nThin draft');
        expect(model.call('split', '1').input).toContain('The revision failed (A model call reached the token limit)');
        expect(trees.at(-1)![0].status).toBe('done');
    });

    it('splits a task too big to write instead', async () => {
        const { result, model } = await runTree({
            'decide 1': decision('answer'),
            'write 1': new Error('A model call reached the token limit'),
            'split 1': subtasks('First part', 'Second part'),
            'decide 1.1': decision('answer'),
            'write 1.1': 'one',
            'decide 1.2': decision('answer'),
            'write 1.2': 'two',
            'combine 1': 'One and two',
        });

        expect(result).toBe('One and two');
        expect(model.call('split', '1').input).toContain('Writing the whole task in one reply failed');
    });

    it('fails the check of an answer citing a URL missing from the evidence', async () => {
        const { model } = await runTree(
            { 'decide 1': decision('answer'), 'write 1': 'See https://invented.example/page.', 'revise 1': 'Fixed.' },
            { maxTaskDepth: 0 },
        );

        expect(model.call('revise', '1').input).toContain('https://invented.example/page, which is not in the captured evidence');
    });

    it('fails the check of a researched result stating an unfound version', async () => {
        mocks.searchWithMemory.mockResolvedValue(['Local knowledge result', '[{"summary": "Rust 1.80.0 shipped on 2024-07-25."}]', true]);
        const model = new ScriptedModel({
            'decide 1': decision('research', { queries: ['latest rust'] }),
            'write 1': 'Rust 1.85.0 shipped on July 25, 2024.',
            'revise 1': 'Rust 1.80.0 shipped on July 25, 2024.',
        });

        const result = await executeTaskTree('What is the latest Rust?', runOptions(model, { maxTaskDepth: 0 }));

        expect(result).toBe('Rust 1.80.0 shipped on July 25, 2024.');
        const reviseInput = model.call('revise', '1').input;
        expect(reviseInput).toContain('The result states 1.85.0, which appears in no gathered evidence');
        expect(reviseInput).not.toContain('July 25, 2024, which');
    });

    it('lets unresearched results state new numbers', async () => {
        const { model } = await runTree({ 'decide 1': decision('answer'), 'write 1': '17 * 3.5 is 59.5.' }, { prompt: 'What is 17 * 3.5?' });

        expect(model.steps()).not.toContain('revise 1');
    });

    it('asks a clarification once and makes the decision again', async () => {
        const questions: string[] = [];
        const model = new ScriptedModel({
            'decide 1': [decision('answer', { clarification: 'Which format?' }), decision('answer')],
            'write 1': 'Done in Markdown.',
        });

        await executeTaskTree(
            'Write it up',
            runOptions(model, {
                clarificationCallback: (question) => {
                    questions.push(question);
                    return 'Markdown';
                },
            }),
        );

        expect(questions).toEqual(['Which format?']);
        const decisions = model.calls.filter((call) => call.step === 'decide');
        expect(decisions[0].json_schema!.properties).toHaveProperty('clarification');
        expect(decisions[1].json_schema!.properties).not.toHaveProperty('clarification');
        expect(model.call('write', '1').input).toContain('Answer: Markdown');
    });

    it('fails the run on an error in the top task', async () => {
        await expect(
            runTree({ 'decide 1': decision('answer'), 'write 1': new Error('token limit') }, { maxTaskDepth: 0 }),
        ).rejects.toThrow('token limit');
    });

    it('stops at the next step once the signal is aborted', async () => {
        const controller = new AbortController();
        const model = new ScriptedModel({ 'decide 1': decision('answer'), 'write 1': 'Four.' });

        const running = executeTaskTree(
            'What is 2 + 2?',
            runOptions(model, {
                signal: controller.signal,
                progressCallback: (label) => {
                    if (label.endsWith('Writing')) {
                        controller.abort();
                    }
                },
            }),
        );

        await expect(running).rejects.toThrow('The run was stopped.');
        expect(model.steps()).toEqual(['decide 1']);
    });
});

// ============================================================================
// Subtasks
// ============================================================================

describe('subtasks', () => {
    it('runs subtasks in order and shows dependents the earlier results', async () => {
        const { result, model, trees } = await runTree({
            'decide 1': decision('decompose', { subtasks: [['Find the options', []], ['Compare them', [1]]] }),
            'decide 1.1': decision('answer'),
            'write 1.1': 'Options: A and B.',
            'decide 1.2': decision('answer'),
            'write 1.2': 'A is simpler than B.',
            'combine 1': 'Use A: it is simpler than B.',
        });

        expect(result).toBe('Use A: it is simpler than B.');
        expect(model.steps().filter((step) => !step.startsWith('check'))).toEqual([
            'decide 1',
            'decide 1.1',
            'write 1.1',
            'decide 1.2',
            'write 1.2',
            'combine 1',
        ]);
        expect(model.call('write', '1.2').input).toContain('Result of task 1.1: Find the options:\nOptions: A and B.');
        expect(model.call('write', '1.1').input).not.toContain('Options: A and B.');
        const combineInput = model.call('combine', '1').input;
        expect(combineInput).toContain('Result of subtask 1.1');
        expect(combineInput).toContain('A is simpler than B.');
        expect(model.call('decide', '1.2').input).toContain('1.2 [running] Compare them  <- current task');
        const last = trees.at(-1)!;
        expect(last.map((node) => node.id)).toEqual(['1', '1.1', '1.2']);
        expect(new Set(last.map((node) => node.status))).toEqual(new Set(['done']));
        expect(last[2].depends_on).toEqual(['1.1']);
    });

    it('condenses an earlier result too big for the window once', async () => {
        const { model, progress } = await runTree(
            {
                'decide 1': decision('decompose', { subtasks: [['Gather notes', []], ['Use the notes', [1]]] }),
                'decide 1.1': decision('answer'),
                'write 1.1': 'note '.repeat(6_000),
                'decide 1.2': decision('answer'),
                'write 1.2': 'Used them.',
                'combine 1': 'Done.',
            },
            { contextSize: 4096, maxTokens: 1024 },
        );

        expect(model.call('decide', '1.2').input).toContain(CONDENSED_MARKER + 'Condensed findings.');
        expect(model.call('write', '1.2').input).toContain(CONDENSED_MARKER + 'Condensed findings.');
        expect(model.call('write', '1.2').input).toContain('Original user request:\nExplain the plan');
        expect(progress.filter((label) => label === 'Task 1.2 · Condensing earlier results')).toHaveLength(1);
    });

    it('joins results too long to merge under headings', async () => {
        const { result, trees } = await runTree({
            'decide 1': decision('decompose', { subtasks: [['Plan day 1', []], ['Plan day 2', []]] }),
            'decide 1.1': decision('answer'),
            'write 1.1': 'Walk the old town.',
            'decide 1.2': decision('answer'),
            'write 1.2': 'Visit Belem.',
            'combine 1': new Error('A model call reached the token limit'),
        });

        expect(result).toBe('## Plan day 1\n\nWalk the old town.\n\n## Plan day 2\n\nVisit Belem.');
        expect(trees.at(-1)![0].status).toBe('unverified');
        expect(trees.at(-1)![0].note).toContain('joined without merging');
    });

    it('nests subtasks until the depth limit', async () => {
        const { model, trees } = await runTree(
            {
                'decide 1': decision('decompose', { subtasks: [['Part one', []], ['Part two', []]] }),
                'decide 1.1': decision('decompose', { subtasks: [['Piece a', []], ['Piece b', []]] }),
                'decide 1.1.1': decision('answer'),
                'write 1.1.1': 'a',
                'decide 1.1.2': decision('answer'),
                'write 1.1.2': 'b',
                'combine 1.1': 'a and b',
                'decide 1.2': decision('answer'),
                'write 1.2': 'two',
                'combine 1': 'a and b, then two',
            },
            { maxTaskDepth: 2 },
        );

        expect(trees.at(-1)!.map((node) => node.id)).toEqual(['1', '1.1', '1.1.1', '1.1.2', '1.2']);
        expect(offered(model, '1.1.1')).not.toContain('decompose');
    });

    it('caps how many subtasks are created at the node limit', async () => {
        const { trees } = await runTree(
            {
                'decide 1': decision('decompose', { subtasks: [['One', []], ['Two', []], ['Three', []]] }),
                'decide 1.1': decision('answer'),
                'write 1.1': '1',
                'decide 1.2': decision('answer'),
                'write 1.2': '2',
                'combine 1': '1 and 2',
            },
            { maxTaskNodes: 3 },
        );

        expect(trees.at(-1)!.map((node) => node.id)).toEqual(['1', '1.1', '1.2']);
    });

    it('splits a task that keeps failing its check into subtasks', async () => {
        const { result, model, trees } = await runTree({
            'decide 1': decision('answer'),
            'write 1': 'Thin draft',
            'check 1': [check('missing', 'Covers nothing.'), check('missing', 'Still thin.'), check()],
            'revise 1': 'Thin revision',
            'split 1': subtasks('First half', 'Second half'),
            'decide 1.1': decision('answer'),
            'write 1.1': 'half one',
            'decide 1.2': decision('answer'),
            'write 1.2': 'half two',
            'combine 1': 'Both halves',
        });

        expect(result).toBe('Both halves');
        expect(model.call('split', '1').input).toContain('Problem with it:\nStill thin.');
        expect(trees.at(-1)![0].approach).toBe('decompose');
        expect(trees.at(-1)![0].status).toBe('done');
    });

    it('does not split tasks made by a failure split again', async () => {
        const { model, trees } = await runTree({
            'decide 1': decision('answer'),
            'write 1': 'Thin draft',
            'check 1': [check('missing', 'Thin.'), check('missing', 'Still thin.'), check()],
            'revise 1': 'Thin revision',
            'split 1': subtasks('First half', 'Second half'),
            'decide 1.1': decision('answer'),
            'write 1.1': 'half one',
            'check 1.1': check('missing', 'Wrong.'),
            'revise 1.1': 'half one again',
            'decide 1.2': decision('answer'),
            'write 1.2': 'half two',
            'combine 1': 'Both halves',
        });

        expect(model.steps()).not.toContain('split 1.1');
        expect(trees.at(-1)![1].status).toBe('unverified');
    });

    it('records a failed subtask and re-plans the rest', async () => {
        const { result, model, trees } = await runTree({
            'decide 1': decision('decompose', { subtasks: [['Read the log', []], ['Summarise it', [1]]] }),
            'decide 1.1': decision('answer'),
            'write 1.1': new Error('A model call reached the token limit'),
            'split 1.1': subtasks(),
            'replan 1': subtasks('Summarise what is known'),
            'decide 1.2': decision('answer'),
            'write 1.2': 'Nothing could be read.',
            'combine 1': 'The log could not be read.',
        });

        expect(result).toBe('The log could not be read.');
        const nodes = Object.fromEntries(trees.at(-1)!.map((node) => [node.id, node]));
        expect(nodes['1.1'].status).toBe('failed');
        expect(nodes['1.1'].note).toContain('token limit');
        expect(nodes['1.2'].prompt).toBe('Summarise what is known');
        expect(model.call('replan', '1').input).toContain('Subtask 1.1 failed');
        expect(model.call('combine', '1').input).toContain('(failed: Writing the whole task in one reply failed');
    });
});

// ============================================================================
// Parsing
// ============================================================================

describe('parsing', () => {
    it('does a task directly when it decomposes into fewer than two real subtasks', () => {
        const node = new TaskNode('1', 'Plan a trip', 'A plan');
        const reply = decision('decompose', { subtasks: [['Plan a trip', []], ['Book it', []]] });

        const parsed = parseDecision(reply, node, ['answer', 'research', 'decompose'])!;

        expect(parsed.approach).toBe('answer');
        expect(parsed.subtasks).toEqual([]);
    });

    it('rejects malformed replies', () => {
        const node = new TaskNode('1', 'Plan', 'A plan');

        expect(parseDecision('not json', node, ['answer'])).toBeNull();
        expect(parseDecision(decision('act'), node, ['answer'])).toBeNull();
        expect(parseCheck('{"verdict": "fine"}')).toBeNull();
        expect(parseCheck(check())).toBe('');
        expect(parseCheck(check('missing', 'Add it.'))).toBe('Add it.');
    });

    it('drops subtasks repeating a task in the tree and renumbers the rest', () => {
        const existing = ['Answer the request', 'Find the latest stable Rust release'];
        const values = [
            { prompt: 'Find the latest stable Python release', deliverable: 'p', depends_on: [] },
            { prompt: 'Find one latest stable Rust release', deliverable: 'r', depends_on: [] },
            { prompt: 'Find the latest stable Go release', deliverable: 'g', depends_on: [1, 2] },
            { prompt: 'Tabulate them', deliverable: 't', depends_on: [1, 3] },
        ];

        const parsed = parseSubtasks(values, existing);

        expect(parsed.map((task) => [task.prompt, task.depends_on])).toEqual([
            ['Find the latest stable Python release', []],
            ['Find the latest stable Go release', [1]],
            ['Tabulate them', [1, 2]],
        ]);
    });

    it('keeps the numbers of finished subtasks when re-planning', () => {
        const values = [{ prompt: 'Summarise', deliverable: 's', depends_on: [1, 2, 3] }];

        const parsed = parseSubtasks(values, ['Request'], 3);

        expect(parsed[0].depends_on).toEqual([1, 2]);
    });

    it('points dependencies only at earlier subtasks', () => {
        const tree = new TaskTree('Request', 3, 20);

        tree.setChildren(tree.root, [
            { prompt: 'A', deliverable: 'a', depends_on: [2] },
            { prompt: 'B', deliverable: 'b', depends_on: [1, 2, 5] },
        ]);

        expect(tree.root.children.map((child) => child.dependsOn)).toEqual([[], ['1.1']]);
    });
});

// ============================================================================
// Recall
// ============================================================================

describe('recall', () => {
    let databasePath: string;
    let store: KnowledgeStore;

    beforeEach(() => {
        databasePath = join(mkdtempSync(join(workDirectory, 'recall-')), 'knowledge.db');
        store = new KnowledgeStore(databasePath);
        store.storeSearchResults('sqlite fts5', [{ url: 'https://sqlite.example/fts5', title: 'FTS5', snippet: 'Full-text search.' }]);
    });

    it('passes the check of a result citing a recalled fact URL', async () => {
        store.addFact('SQLite', 'SQLite FTS5 ranks matches with bm25.', 'https://sqlite.example/fts5');

        const { model } = await runTree(
            { 'decide 1': decision('answer'), 'write 1': 'FTS5 ranks with bm25 (https://sqlite.example/fts5).' },
            { prompt: 'How does SQLite FTS5 rank matches?', knowledgeDbPath: databasePath, maxTaskDepth: 0 },
        );

        expect(model.call('write', '1').input).toContain('https://sqlite.example/fts5');
        expect(model.steps()).not.toContain('revise 1');
    });

    it('recalls facts matching a subtask own prompt', async () => {
        store.addFact('Rust', 'Cargo builds Rust crates and fetches their dependencies.');

        const { model } = await runTree(
            {
                'decide 1': decision('decompose', { subtasks: [['Explain how Cargo builds crates', []], ['Explain the rest', []]] }),
                'decide 1.1': decision('answer'),
                'write 1.1': 'Cargo builds crates.',
                'decide 1.2': decision('answer'),
                'write 1.2': 'The rest.',
                'combine 1': 'Both.',
            },
            { prompt: 'Write a guide to a new toolchain', knowledgeDbPath: databasePath },
        );

        expect(model.call('decide', '1.1').input).toContain('Cargo builds Rust crates');
        expect(model.call('decide', '1').input).not.toContain('Cargo builds Rust crates');
    });

    it('recalls facts for a search query that answer it without tools', async () => {
        store.addFact('Zig', 'Zig 0.13.0 was released in June 2024.');

        const { model } = await runTree(
            {
                'decide 1': decision('decompose', { subtasks: [['Describe the newest version', []], ['Explain the rest', []]] }),
                'decide 1.1': decision('research', { queries: ['zig release'] }),
                'write 1.1': 'Zig 0.13.0 was released in June 2024.',
                'decide 1.2': decision('answer'),
                'write 1.2': 'The rest.',
                'combine 1': 'Both.',
            },
            { prompt: 'Write a guide to a systems language', knowledgeDbPath: databasePath },
        );

        expect(model.call('decide', '1.1').input).not.toContain('Zig 0.13.0');
        expect(model.call('write', '1.1').input).toContain("Stored facts for 'zig release'");
        expect(model.steps()).not.toContain('revise 1.1');
    });

    it('flags a stale fact, queues its topic, and does not let it answer the query', async () => {
        store.addFact('Zig', 'Zig 0.13.0 was released in June 2024.');
        const database = new DatabaseSync(databasePath);
        database.exec('UPDATE facts SET created_at = 0');
        database.close();
        mocks.runToolStage.mockResolvedValue('Findings.');
        const model = new ScriptedModel({
            'decide 1': decision('decompose', { subtasks: [['Describe the newest version', []], ['Explain the rest', []]] }),
            'decide 1.1': decision('research', { queries: ['zig release'] }),
            'write 1.1': 'A result.',
            'decide 1.2': decision('answer'),
            'write 1.2': 'The rest.',
            'combine 1': 'Both.',
        });

        await executeTaskTree('Write a guide to a systems language', runOptions(model, { knowledgeDbPath: databasePath }));

        expect(model.call('write', '1.1').input).toContain('may be out of date');
        expect(mocks.runToolStage).toHaveBeenCalledTimes(1);
        expect(store.queueStatus().filter((job) => job.status === 'pending').map((job) => job.topic)).toContain('Zig');
    });

    it('queues a claim stating an unfound version for research', async () => {
        mocks.searchWithMemory.mockResolvedValue(['Local knowledge result', '[{"summary": "Rust 1.80.0 shipped on 2024-07-25."}]', true]);
        const model = new ScriptedModel({
            'decide 1': decision('research', { queries: ['latest rust'] }),
            'write 1': 'Rust is a language. Rust 1.85.0 is the newest release.',
            'revise 1': 'Rust is a language.',
        });

        await executeTaskTree('What is the latest Rust?', runOptions(model, { maxTaskDepth: 0, knowledgeDbPath: databasePath }));

        expect(store.queueStatus().map((job) => job.topic)).toEqual(['What is the latest Rust?: Rust 1.85.0 is the newest release.']);
    });
});

// ============================================================================
// Skills
// ============================================================================

describe('skills', () => {
    it('gives a task reading files the code guides and lessons but not the research ones', async () => {
        const root = mkdtempSync(join(workDirectory, 'skills-'));
        mkdirSync(join(root, 'config', 'codex', 'skills', 'code'), { recursive: true });
        writeFileSync(join(root, 'config', 'codex', 'skills', 'code', 'review.md'), 'Name the line of each bug.');
        mkdirSync(join(root, 'project', '.codex', 'skills', 'research'), { recursive: true });
        writeFileSync(join(root, 'project', '.codex', 'skills', 'research', 'sources.md'), 'Prefer release notes.');
        const databasePath = join(root, 'knowledge.db');
        const store = new KnowledgeStore(databasePath);
        store.addMemory('code', 'Run the parser tests after editing the parser');
        store.addMemory('research', 'Vendor blogs overstate benchmarks');
        const model = new ScriptedModel({ 'decide 1': decision('files'), 'write 1': 'No bugs on line 3.' });
        mocks.runToolStage.mockResolvedValue('Read parser.py.');
        vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));

        try {
            await executeTaskTree(
                'Review the parser',
                runOptions(model, { maxTaskDepth: 0, knowledgeDbPath: databasePath, filesystemRoot: join(root, 'project') }),
            );
        } finally {
            vi.stubEnv('XDG_CONFIG_HOME', join(workDirectory, 'config'));
        }

        const decideInput = model.call('decide', '1').input;
        const writeInput = model.call('write', '1').input;
        expect(decideInput).not.toContain('Name the line of each bug.');
        expect(writeInput).toContain(`${SKILLS_LABEL}:\nName the line of each bug.`);
        expect(writeInput).toContain('Run the parser tests after editing the parser');
        expect(writeInput).not.toContain('Prefer release notes.');
        expect(writeInput).not.toContain('Vendor blogs overstate benchmarks');
    });
});

// ============================================================================
// Episodes and resuming
// ============================================================================

describe('episodes', () => {
    it('records a finished tree with the episode', async () => {
        const databasePath = join(mkdtempSync(join(workDirectory, 'episode-')), 'knowledge.db');
        const store = new KnowledgeStore(databasePath);
        store.addMemory('user', 'Prefers short answers');

        const { model } = await runTree(
            { 'decide 1': decision('answer'), 'write 1': 'Short.' },
            { prompt: 'Say something short', knowledgeDbPath: databasePath },
        );
        const episode = store.episodes()[0];

        expect(model.call('decide', '1').input).toContain('Prefers short answers');
        expect(episode.answer).toBe('Short.');
        expect(episode.task_type).toBe('answer');
        expect(episode.checklist).toContain('1 [done, answer] Say something short');
        expect(JSON.parse(episode.task_tree)[0].result).toBe('Short.');
        expect(episode.outcome).toBe('1 of 1 task(s) met their deliverable');
    });
});

describe('resuming', () => {
    let databasePath: string;
    let store: KnowledgeStore;

    beforeEach(() => {
        databasePath = join(mkdtempSync(join(workDirectory, 'resume-')), 'knowledge.db');
        store = new KnowledgeStore(databasePath);
    });

    it('checkpoints a finished run and marks it finished', async () => {
        await runTree({ 'decide 1': decision('answer'), 'write 1': 'Done.' }, { prompt: '/plan Tidy the notes', knowledgeDbPath: databasePath });

        const saved = store.taskRun(1)!;
        expect(saved.status).toBe('finished');
        expect(saved.prompt).toBe('Tidy the notes');
        expect(saved.options.mode).toBe('draft');
        expect((saved.state as { nodes: Array<{ result: string }> }).nodes[0].result).toBe('Done.');
        expect([saved.tasks_done, saved.tasks_total]).toEqual([1, 1]);
        expect(store.unfinishedTaskRuns()).toEqual([]);
    });

    it('resumes an interrupted run without redoing finished tasks', async () => {
        const firstHalf: Script = {
            'decide 1': decision('decompose', { subtasks: [['Find the options', []], ['Compare them', [1]]] }),
            'decide 1.1': decision('answer'),
            'write 1.1': 'Options: A and B.',
            'decide 1.2': decision('answer'),
            'write 1.2': new Interrupted('Interrupted'),
        };
        await expect(runTree(firstHalf, { knowledgeDbPath: databasePath })).rejects.toBeInstanceOf(Interrupted);

        const unfinished = store.unfinishedTaskRuns();
        expect(unfinished.map((run) => [run.id, run.status, run.tasks_done, run.tasks_total])).toEqual([[1, 'stopped', 1, 3]]);

        const { result, model, trees } = await runTree(
            { 'decide 1.2': decision('answer'), 'write 1.2': 'A is simpler.', 'combine 1': 'Use A.' },
            { prompt: unfinished[0].prompt, knowledgeDbPath: databasePath, resumeRunId: 1 },
        );

        expect(result).toBe('Use A.');
        expect(model.steps().filter((step) => !step.startsWith('check'))).toEqual(['decide 1.2', 'write 1.2', 'combine 1']);
        expect(model.call('write', '1.2').input).toContain('Options: A and B.');
        expect(new Set(trees.at(-1)!.map((node) => node.status))).toEqual(new Set(['done']));
        expect(store.taskRun(1)!.status).toBe('finished');
        expect(store.unfinishedTaskRuns()).toEqual([]);
    });

    it('refuses to resume an unknown run', async () => {
        await expect(runTree({}, { knowledgeDbPath: databasePath, resumeRunId: 7 })).rejects.toThrow(/no saved task tree run 7/);
    });
});

// ============================================================================
// Agents
// ============================================================================

function writeAgents(root: string, files: Record<string, string>): void {
    const directory = join(root, '.codex', 'agents');
    mkdirSync(directory, { recursive: true });
    for (const [name, text] of Object.entries(files)) {
        writeFileSync(join(directory, `${name}.md`), text);
    }
}

function mcpServer(name: string): McpServerSettings {
    return { name, enabled: true, transport: 'stdio', command: 'true', args: [], env: {}, allowed_tools: [] };
}

describe('agents', () => {
    it('hands a task to an agent that works it as its own tree', async () => {
        const root = mkdtempSync(join(workDirectory, 'agents-'));
        writeAgents(root, { mail: '---\ndescription: Reads and sends email.\nmcp_servers: mail\n---\nShow every draft first.' });

        const { result, model, trees } = await runTree(
            { 'decide 1': [decision('delegate', { agent: 'mail' }), decision('answer')], 'write 1': 'Sent the note.' },
            { prompt: 'Email Sam that I am late', filesystemRoot: root, allowFileWrites: false, mcpServers: [mcpServer('mail')] },
        );

        expect(result).toBe('Sent the note.');
        expect(model.steps()).toEqual(['decide 1', 'decide 1', 'write 1', 'check 1']);
        const [top, nested] = model.calls.filter((call) => call.step === 'decide');
        expect(top.system).toContain('mail: Reads and sends email.');
        expect(top.json_schema!.properties.agent.enum).toEqual(['mail', '']);
        expect(top.json_schema!.properties.approach.enum).toContain('delegate');
        expect(top.json_schema!.properties.approach.enum).not.toContain('act');
        expect(nested.json_schema!.properties).not.toHaveProperty('agent');
        expect(nested.json_schema!.properties.approach.enum).toContain('act');
        expect(nested.json_schema!.properties).not.toHaveProperty('clarification');
        expect(nested.input).toContain('Show every draft first.');
        expect(nested.input).toContain('Email Sam that I am late');
        expect(trees.at(-1)![0].approach).toBe('delegate');
        expect(trees.at(-1)![0].status).toBe('done');
        expect(trees.at(-1)![0].note).toBe('Delegated to the mail agent');
    });

    it('offers no delegate choice when there are no agents', async () => {
        const root = mkdtempSync(join(workDirectory, 'agents-'));

        const { model } = await runTree({ 'decide 1': decision('answer'), 'write 1': 'Done.' }, { filesystemRoot: root });

        const schema = model.call('decide', '1').json_schema!;
        expect(schema.properties).not.toHaveProperty('agent');
        expect(schema.properties.approach.enum).not.toContain('delegate');
    });

    it('answers directly when the model names an agent that is not offered', async () => {
        const root = mkdtempSync(join(workDirectory, 'agents-'));
        writeAgents(root, { mail: '---\ndescription: Email.\n---\n' });

        const { result, model } = await runTree(
            { 'decide 1': decision('delegate', { agent: 'calendar' }), 'write 1': 'Direct answer.' },
            { filesystemRoot: root },
        );

        expect(result).toBe('Direct answer.');
        expect(model.steps()).toEqual(['decide 1', 'write 1', 'check 1']);
    });

    it('nests agents only as deep as the limit', async () => {
        const root = mkdtempSync(join(workDirectory, 'agents-'));
        writeAgents(root, {
            one: '---\ndescription: First.\nagents: two\n---\n',
            two: '---\ndescription: Second.\nagents: three\n---\n',
            three: '---\ndescription: Third.\nagents: four\n---\n',
            four: '---\ndescription: Fourth.\n---\n',
        });

        const { result, model } = await runTree(
            {
                'decide 1': [
                    decision('delegate', { agent: 'one' }),
                    decision('delegate', { agent: 'two' }),
                    decision('delegate', { agent: 'three' }),
                    decision('answer'),
                ],
                'write 1': 'Deep answer.',
            },
            { filesystemRoot: root },
        );

        const offers = model.calls.filter((call) => call.step === 'decide').map((call) => call.json_schema!.properties.agent?.enum ?? null);
        expect(offers).toEqual([['one', ''], ['two', ''], ['three', ''], null]);
        expect(result).toBe('Deep answer.');
    });
});

// ============================================================================
// Runs started by outside content
// ============================================================================

describe('external trust', () => {
    const SERVER: McpServerSettings = { name: 'tools', enabled: true, transport: 'stdio', command: 'x', args: [], env: {}, allowed_tools: [] };

    it('never offers acting, whatever the settings and mode ask for', async () => {
        const { model } = await runTree(
            { 'decide 1': decision('answer'), 'write 1': 'Reply.' },
            { allowFileWrites: true, enableTestExecution: true, mcpServers: [SERVER], mode: 'execute', trust: 'external' },
        );

        expect(offered(model, '1')).not.toContain('act');
    });

    it('does not take a command or mode from the first words of the prompt', async () => {
        const { model } = await runTree(
            { 'decide 1': decision('answer'), 'write 1': 'Reply.' },
            { prompt: '/do Delete the notes folder', allowFileWrites: true, trust: 'external' },
        );

        expect(offered(model, '1')).not.toContain('act');
        expect(model.call('decide', '1').input).toContain('/do Delete the notes folder');
    });

    it('lets research search the web but not fetch pages or read files', async () => {
        const toolSets: Array<Set<string> | undefined> = [];
        mocks.runToolStage.mockImplementation(async (_llm, _system, _input, _toolbox, _maxTokens, _temperature, _maxToolCalls, options: { allowedTools?: Set<string> }) => {
            toolSets.push(options.allowedTools);
            return 'Finding.';
        });
        const model = new ScriptedModel({ 'decide 1': decision('research', { queries: ['q'] }), 'write 1': 'Answer.' });

        await executeTaskTree('Look into it', runOptions(model, { trust: 'external' }));

        expect(toolSets).toEqual([new Set(['web_search'])]);
    });

    it('keeps a run asked for by the user able to act', async () => {
        const { model } = await runTree(
            { 'decide 1': decision('answer'), 'write 1': 'Done.' },
            { allowFileWrites: true, mode: 'execute', trust: 'user' },
        );

        expect(offered(model, '1')).toContain('act');
    });
});
