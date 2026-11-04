import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KnowledgeStore } from '../core/knowledge.js';
import { DEFAULT_SETTINGS, type Settings } from '../core/settings.js';
import type { ExecuteTaskTreeOptions } from '../core/taskTree.js';
import { DaemonClient } from '../daemon/client.js';
import { RunningDaemon } from '../daemon/daemonHarness.js';
import { main, type CliEnvironment } from './index.js';

type TaskTreeCall = [string, ExecuteTaskTreeOptions];

function defaults(): Settings {
    return structuredClone(DEFAULT_SETTINGS) as Settings;
}

// A terminal that records what the command prints, with no daemon running unless a test gives one.
function fakeEnvironment(overrides: Partial<CliEnvironment> = {}): CliEnvironment & { printed: string[]; errors: string[] } {
    const printed: string[] = [];
    const errors: string[] = [];
    return {
        loadSettings: () => defaults(),
        executeTaskTree: vi.fn(async () => 'answer'),
        connectToDaemon: async () => {
            throw Object.assign(new Error('no daemon'), { code: 'ENOENT' });
        },
        stdinIsTTY: false,
        stdoutIsTTY: false,
        print: (text) => printed.push(text),
        write: (text) => printed.push(text),
        printError: (text) => errors.push(text),
        readStdin: async () => '',
        ask: async () => '',
        variables: {},
        ...overrides,
        printed,
        errors,
    };
}

function firstCall(executeTaskTree: CliEnvironment['executeTaskTree']): TaskTreeCall {
    return vi.mocked(executeTaskTree).mock.calls[0] as TaskTreeCall;
}

describe('codex command', () => {
    let directory: string;

    beforeEach(() => {
        process.env.CODEX_GPU_LOCK = '';
        directory = mkdtempSync(join(tmpdir(), 'codex-cli-'));
    });

    afterEach(() => {
        rmSync(directory, { recursive: true, force: true });
    });

    it('takes show_thinking from the settings unless the command line overrides it', async () => {
        for (const [argumentsGiven, expected] of [
            [['prompt'], true],
            [['--no-show-thinking', 'prompt'], false],
        ] as const) {
            const io = fakeEnvironment();

            expect(await main([...argumentsGiven], io)).toBe(0);

            expect(firstCall(io.executeTaskTree)[1].showThinking).toBe(expected);
        }
    });

    it('lets the mode option override the setting', async () => {
        const io = fakeEnvironment();

        expect(await main(['--mode', 'draft', 'prompt'], io)).toBe(0);

        expect(firstCall(io.executeTaskTree)[1].mode).toBe('draft');
    });

    it('refuses a mode that is not one of the choices', async () => {
        const io = fakeEnvironment();

        expect(await main(['--mode', 'dream', 'prompt'], io)).toBe(2);

        expect(io.errors.join('\n')).toContain("argument --mode: invalid choice: 'dream'");
    });

    it('runs the task tree with its limits and prints the result', async () => {
        const io = fakeEnvironment({
            loadSettings: () => ({ ...defaults(), max_task_nodes: 9 }),
            executeTaskTree: vi.fn(async () => 'tree answer'),
        });

        expect(await main(['--gpu-layers', '-1', 'prompt'], io)).toBe(0);

        expect(io.printed.at(-1)).toBe('tree answer');
        const options = firstCall(io.executeTaskTree)[1];
        expect(options.maxTaskNodes).toBe(9);
        expect(options.maxTaskDepth).toBe(DEFAULT_SETTINGS.max_task_depth);
        expect(options.gpuLayers).toBe(-1);
        expect(options.clarificationCallback).toBeNull();
    });

    it('reads the prompt from standard input when none is given', async () => {
        const io = fakeEnvironment({ readStdin: async () => '  piped prompt \n' });

        expect(await main([], io)).toBe(0);

        expect(firstCall(io.executeTaskTree)[0]).toBe('piped prompt');
    });

    it('fails with a usage error when no prompt arrives at all', async () => {
        const io = fakeEnvironment();

        expect(await main([], io)).toBe(2);

        expect(io.errors.join('\n')).toContain('provide a prompt as an argument or through standard input');
    });

    it('resumes the newest unfinished tree run', async () => {
        const settings = { ...defaults(), knowledge_db_path: join(directory, 'knowledge.db') };
        const store = new KnowledgeStore(settings.knowledge_db_path);
        const runId = store.startTaskRun('Plan the trip', { max_task_depth: 2, mode: 'draft' });
        store.saveTaskRun(runId, { nodes: [] }, 1, 3);
        const io = fakeEnvironment({ loadSettings: () => settings, executeTaskTree: vi.fn(async () => 'Trip planned.') });

        expect(await main(['--resume'], io)).toBe(0);

        expect(io.printed).toContain('Resuming: Plan the trip (1 of 3 tasks done)');
        expect(io.printed.at(-1)).toBe('Trip planned.');
        const [prompt, options] = firstCall(io.executeTaskTree);
        expect(prompt).toBe('Plan the trip');
        expect(options.resumeRunId).toBe(runId);
        expect(options.mode).toBe('draft');
        expect(options.maxTaskDepth).toBe(2);
    });

    it('says so when there is no unfinished run to resume', async () => {
        const settings = { ...defaults(), knowledge_db_path: join(directory, 'knowledge.db') };
        const io = fakeEnvironment({ loadSettings: () => settings });

        expect(await main(['--resume'], io)).toBe(1);

        expect(io.errors.join('')).toContain('no unfinished task tree run');
    });

    it('explains that the terminal interface is not available', async () => {
        const io = fakeEnvironment();

        expect(await main(['tui', 'draft', 'a', 'plan'], io)).toBe(1);
        expect(await main(['--tui'], io)).toBe(1);

        expect(io.errors.every((line) => line.includes('terminal interface'))).toBe(true);
        expect(io.executeTaskTree).not.toHaveBeenCalled();
    });

    it('reports settings that fail to load', async () => {
        const io = fakeEnvironment({
            loadSettings: () => {
                throw new Error('Unknown setting(s): colour');
            },
        });

        expect(await main(['prompt'], io)).toBe(1);

        expect(io.errors).toEqual(['Error loading settings: Unknown setting(s): colour']);
    });

    it('runs a prompt on a running daemon with resolved paths', async () => {
        const daemonTaskTree = vi.fn(async () => 'daemon answer');
        const daemon = await RunningDaemon.start(
            { ...defaults(), knowledge_db_path: join(directory, 'knowledge.db') },
            { dependencies: { executeTaskTree: daemonTaskTree } },
        );
        let startAsked: boolean | null = null;
        const io = fakeEnvironment({
            connectToDaemon: async ({ onEvent, start }) => {
                startAsked = start;
                const client = new DaemonClient(daemon.socketPath, { onEvent });
                await client.connect();
                return client;
            },
        });

        try {
            expect(await main(['--max-tokens', '512', 'prompt'], io)).toBe(0);
        } finally {
            await daemon.stop();
        }

        expect(startAsked).toBe(false);
        expect(io.executeTaskTree).not.toHaveBeenCalled();
        expect(io.printed.at(-1)).toBe('daemon answer');
        const options = firstCall(daemonTaskTree as CliEnvironment['executeTaskTree'])[1];
        expect(options.maxTokens).toBe(512);
        expect(options.filesystemRoot).toBe(process.cwd());
        expect(options.clarificationCallback).toBeNull();
    });
});
