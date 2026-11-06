import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SizeChoice } from '../core/autoSize.js';
import { KnowledgeStore } from '../core/knowledge.js';
import { LocalModel } from '../core/model.js';
import { DEFAULT_SETTINGS, loadSettings, type Settings } from '../core/settings.js';
import type { ExecuteTaskTreeOptions } from '../core/taskTree.js';
import { DaemonError } from './client.js';
import { BACKGROUND_MODEL_IDLE_SECONDS, HarnessDaemon, type DaemonDependencies } from './daemon.js';
import { EventLog, RunningDaemon } from './daemonHarness.js';

type TaskTreeCall = [string, ExecuteTaskTreeOptions];

function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

describe('HarnessDaemon', () => {
    let directory: string;
    let settings: Settings;
    let settingsPath: string;
    const cleanups: Array<() => Promise<void> | void> = [];

    beforeEach(() => {
        process.env.CODEX_GPU_LOCK = '';
        directory = mkdtempSync(join(tmpdir(), 'codex-daemon-'));
        settings = structuredClone(DEFAULT_SETTINGS) as Settings;
        settings.knowledge_db_path = join(directory, 'knowledge.db');
        settings.background_research_enabled = false;
        settingsPath = join(directory, 'settings.json');
    });

    afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) {
            await cleanup();
        }
        vi.restoreAllMocks();
        rmSync(directory, { recursive: true, force: true });
    });

    async function start(dependencies: Partial<DaemonDependencies> = {}, startWorker = false): Promise<RunningDaemon> {
        const daemon = await RunningDaemon.start(settings, { settingsPath, startWorker, dependencies });
        cleanups.push(() => daemon.stop());
        return daemon;
    }

    it('streams a run’s progress and tokens, then its result', async () => {
        const executeTaskTree = vi.fn(async (prompt: string, options: ExecuteTaskTreeOptions) => {
            options.progressCallback!('Task 1 · Deciding');
            options.stageOutputCallback!('Task 1 · Deciding', 'token');
            return `Answer to ${prompt}`;
        });
        const daemon = await start({ executeTaskTree });
        const events = new EventLog();
        const client = await daemon.client(events.handler);

        const { run_id: runId } = await client.call<{ run_id: number }>('run', { prompt: 'Draft a plan', settings: { max_tokens: 512 } });
        const finished = await events.waitFor('run.finished');
        await events.waitFor('runs.changed');

        expect(finished).toEqual({ run_id: runId, result: 'Answer to Draft a plan' });
        expect(events.names()).toEqual(['run.started', 'run.progress', 'run.token', 'run.finished', 'runs.changed']);
        expect((executeTaskTree.mock.calls[0] as TaskTreeCall)[1].maxTokens).toBe(512);
        expect(daemon.harness.settings.max_tokens).toBe(DEFAULT_SETTINGS.max_tokens);
        expect((await client.call<Record<string, unknown>>('status')).run).toBeNull();
    });

    it('broadcasts the tree and keeps it for interfaces that connect later', async () => {
        const tree = [{ id: '1', prompt: 'Draft a plan', status: 'running' }];
        const lateStatus: unknown[] = [];
        let daemon!: RunningDaemon;
        const executeTaskTree = vi.fn(async (_prompt: string, options: ExecuteTaskTreeOptions) => {
            options.treeCallback!(tree as never);
            const late = await daemon.client();
            lateStatus.push((await late.call<Record<string, unknown>>('status')).run);
            return 'Tree answer';
        });
        daemon = await start({ executeTaskTree });
        const events = new EventLog();
        const client = await daemon.client(events.handler);

        await client.call('run', { prompt: 'Draft a plan', settings: { max_task_depth: 1 } });
        const finished = await events.waitFor('run.finished');

        expect(finished.result).toBe('Tree answer');
        expect((await events.waitFor('run.tree')).nodes).toEqual(tree);
        expect((executeTaskTree.mock.calls[0] as TaskTreeCall)[1].maxTaskDepth).toBe(1);
        expect((lateStatus[0] as Record<string, unknown>).tree).toEqual(tree);
    });

    it('lists an unfinished tree run, resumes it with its options, or discards it', async () => {
        const store = new KnowledgeStore(settings.knowledge_db_path);
        const options = { model_path: 'saved.gguf', max_task_depth: 2, mode: 'draft' };
        const stopped = store.startTaskRun('Plan the trip', options);
        store.saveTaskRun(stopped, { nodes: [] }, 1, 3);
        store.setTaskRunStatus(stopped, 'stopped');
        const done = store.startTaskRun('Done already', options);
        store.saveTaskRun(done, { nodes: [] }, 1, 1);
        store.setTaskRunStatus(done, 'finished');
        const executeTaskTree = vi.fn(async () => 'Resumed answer');
        const daemon = await start({ executeTaskTree });
        const events = new EventLog();
        const client = await daemon.client(events.handler);

        const listed = (await client.call<Record<string, unknown>>('status')).unfinished_runs as Array<Record<string, unknown>>;
        const unfinished = await client.call('unfinished_runs');
        const refused = client.call('resume_run', { run_id: done });
        await expect(refused).rejects.toThrow(DaemonError);
        await client.call('resume_run', { run_id: stopped });
        const finishedEvent = await events.waitFor('run.finished');
        await events.waitFor('runs.changed');

        expect(listed.map((run) => [run.id, run.tasks_done, run.tasks_total])).toEqual([[stopped, 1, 3]]);
        expect(unfinished).toEqual(listed);
        expect(finishedEvent.result).toBe('Resumed answer');
        expect((await events.waitFor('run.started')).prompt).toBe('Plan the trip');
        const [prompt, given] = executeTaskTree.mock.calls[0] as unknown as TaskTreeCall;
        expect(prompt).toBe('Plan the trip');
        expect(given.resumeRunId).toBe(stopped);
        expect(given.modelPath).toBe('saved.gguf');
        expect(given.mode).toBe('draft');

        await client.call('discard_run', { run_id: stopped });

        expect((await client.call<Record<string, unknown>>('status')).unfinished_runs).toEqual([]);
    });

    it('asks only the owner for a clarification and passes on the answer', async () => {
        const answers: string[] = [];
        const executeTaskTree = vi.fn(async (_prompt: string, options: ExecuteTaskTreeOptions) => {
            answers.push(await options.clarificationCallback!('Which format?'));
            return 'done';
        });
        const daemon = await start({ executeTaskTree });
        const ownerEvents = new EventLog();
        const watcherEvents = new EventLog();
        const owner = await daemon.client(ownerEvents.handler);
        await daemon.client(watcherEvents.handler);

        const { run_id: runId } = await owner.call<{ run_id: number }>('run', { prompt: 'Draft a plan' });
        const question = await ownerEvents.waitFor('run.clarification');
        await owner.call('answer_clarification', {
            run_id: runId,
            clarification_id: question.clarification_id,
            answer: 'Markdown',
        });
        await watcherEvents.waitFor('run.finished');

        expect(question.question).toBe('Which format?');
        expect(answers).toEqual(['Markdown']);
        expect(watcherEvents.names()).not.toContain('run.clarification');
    });

    it('suspending stops the run, unloads the models and refuses new runs', async () => {
        let started = false;
        const executeTaskTree = vi.fn(async (_prompt: string, options: ExecuteTaskTreeOptions): Promise<string> => {
            for (;;) {
                started = true;
                options.stageOutputCallback!('Task 1 · Researching', 'x');
                await sleep(10);
            }
        });
        const daemon = await start({ executeTaskTree });
        const events = new EventLog();
        const client = await daemon.client(events.handler);
        await client.call('run', { prompt: 'first' });
        for (let attempt = 0; attempt < 500 && !started; attempt += 1) {
            await sleep(10);
        }
        expect(started).toBe(true);
        const unloaded: string[] = [];
        vi.spyOn(daemon.harness.modelCache, 'unload').mockImplementation(async () => (unloaded.push('main'), true));
        vi.spyOn(daemon.harness.backgroundModelCache, 'unload').mockImplementation(async () => (unloaded.push('background'), true));

        expect(await client.call('suspend')).toEqual({ suspended: true });

        expect(await events.waitFor('suspended.changed')).toEqual({ suspended: true });
        await events.waitFor('run.cancelled');
        expect(unloaded).toEqual(['main', 'background']);
        expect((await client.call<Record<string, unknown>>('status')).suspended).toBe(true);
        await expect(client.call('run', { prompt: 'second' })).rejects.toThrow(/suspended/);

        expect(await client.call('resume')).toEqual({ suspended: false });

        expect((await client.call<Record<string, unknown>>('status')).suspended).toBe(false);
        expect(await client.call('run', { prompt: 'third' })).toHaveProperty('run_id');
        await client.call('cancel');
    });

    it('stops a run on cancel and when its owner leaves', async () => {
        let started = false;
        const executeTaskTree = vi.fn(async (_prompt: string, options: ExecuteTaskTreeOptions): Promise<string> => {
            for (;;) {
                started = true;
                options.stageOutputCallback!('Task 1 · Researching', 'x');
                await sleep(10);
            }
        });
        const waitUntilStarted = async (): Promise<void> => {
            for (let attempt = 0; attempt < 500 && !started; attempt += 1) {
                await sleep(10);
            }
            expect(started).toBe(true);
        };
        const daemon = await start({ executeTaskTree });
        const events = new EventLog();
        const client = await daemon.client(events.handler);

        await client.call('run', { prompt: 'first' });
        await waitUntilStarted();
        await expect(client.call('run', { prompt: 'second' })).rejects.toThrow(/already running/);
        expect((await client.call<Record<string, unknown>>('cancel')).cancelled).toBe(true);
        await events.waitFor('run.cancelled');

        started = false;
        const leaving = await daemon.client();
        await leaving.call('run', { prompt: 'third' });
        await waitUntilStarted();
        leaving.close();
        for (let attempt = 0; attempt < 100; attempt += 1) {
            if ((await client.call<Record<string, unknown>>('status')).run === null) {
                break;
            }
            await sleep(50);
        }

        expect((await client.call<Record<string, unknown>>('status')).run).toBeNull();
    });

    it('reports a failed run’s message', async () => {
        const executeTaskTree = vi.fn(async () => {
            throw new Error('tool exploded');
        });
        const daemon = await start({ executeTaskTree });
        const events = new EventLog();

        await (await daemon.client(events.handler)).call('run', { prompt: 'Draft a plan' });

        expect((await events.waitFor('run.failed')).message).toBe('tool exploded');
    });

    it('applies settings for every client and saves them', async () => {
        const daemon = await start();
        const events = new EventLog();
        await daemon.client(events.handler);
        const client = await daemon.client();

        const saved = await client.call<Record<string, unknown>>('save_settings', { settings: { max_tool_calls: 7 } });

        expect(saved.path).toBe(settingsPath);
        expect(loadSettings(settingsPath).max_tool_calls).toBe(7);
        expect(((await events.waitFor('settings.changed')).settings as Settings).max_tool_calls).toBe(7);
        await expect(client.call('apply_settings', { settings: { max_tool_calls: 50 } })).rejects.toThrow(/max_tool_calls/);
    });

    it('counts the loaded model when auto sizing and leaves the settings alone', async () => {
        const choice: SizeChoice = { context_size: 14336, max_tokens: 3584, background_max_tokens: 1792, explanation: 'Tiny' };
        const autoSize = vi.fn(async () => choice);
        const daemon = await start({ autoSize });
        const client = await daemon.client();
        vi.spyOn(daemon.harness.modelCache, 'has').mockReturnValue(true);

        const result = await client.call<Record<string, unknown>>('auto_size', { model_path: 'tiny.gguf', gpu_layers: -1 });

        expect(result.context_size).toBe(14336);
        expect(autoSize.mock.calls[0]).toEqual(['tiny.gguf', -1, settings.context_size]);
        expect((await client.call<Settings>('get_settings')).context_size).toBe(settings.context_size);
    });

    it('sizes a separate background model on its own', async () => {
        const choices: Record<string, SizeChoice> = {
            'tiny.gguf': { context_size: 6144, max_tokens: 1536, background_max_tokens: 768, explanation: 'Tiny' },
            'big.gguf': { context_size: 16384, max_tokens: 4096, background_max_tokens: 2048, explanation: 'Big' },
        };
        const autoSize = vi.fn(async (path: string) => choices[path]);
        const daemon = await start({ autoSize });
        const client = await daemon.client();

        const shared = await client.call<Record<string, unknown>>('auto_size', { model_path: 'tiny.gguf', gpu_layers: -1 });
        const separate = await client.call<Record<string, unknown>>('auto_size', {
            model_path: 'tiny.gguf',
            gpu_layers: -1,
            background_model_path: 'big.gguf',
            background_gpu_layers: 0,
        });

        expect([shared.background_context_size, shared.background_max_tokens]).toEqual([0, 768]);
        expect([separate.background_context_size, separate.background_max_tokens]).toEqual([16384, 2048]);
        expect(separate.context_size).toBe(6144);
        expect(separate.explanation).toBe('Tiny; background Big');
        expect(autoSize.mock.calls.at(-1)).toEqual(['big.gguf', 0, null]);
    });

    it('gives a separate background model its own cache and unloads it when idle', async () => {
        const clock = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(100 + BACKGROUND_MODEL_IDLE_SECONDS);
        const harness = new HarnessDaemon(settings, settingsPath, { dependencies: { monotonic: clock } });
        const fakeModel = { close: vi.fn(async () => undefined) } as unknown as LocalModel;
        vi.spyOn(LocalModel, 'load').mockResolvedValue(fakeModel);
        const current = harness.getSettings();

        expect(await harness.backgroundModel(current)).toEqual([harness.modelLock, harness.modelCache]);

        current.background_model_path = 'big.gguf';
        const [lock, cache] = await harness.backgroundModel(current);
        expect(lock).toBe(harness.backgroundModelLock);
        expect(cache).toBe(harness.backgroundModelCache);

        await cache.get('big.gguf', current.context_size, 0);
        await harness.unloadIdleBackgroundModel(false);
        expect(cache.has('big.gguf', current.context_size, 0)).toBe(true);
        await harness.unloadIdleBackgroundModel(false);
        expect(cache.has('big.gguf', current.context_size, 0)).toBe(false);
        expect(harness.backgroundStatus).toBe('Idle; background model unloaded');

        await cache.get('big.gguf', current.context_size, 0);
        current.background_model_path = '';
        await harness.backgroundModel(current);
        expect(cache.has('big.gguf', current.context_size, 0)).toBe(false);
    });

    it('researches a queued topic on request while idle research is paused', async () => {
        let researched = false;
        const researchOneTopic = vi.fn(async (given: Settings) => {
            new KnowledgeStore(given.knowledge_db_path).claimJob();
            researched = true;
            return true;
        });
        const idle = async (): Promise<boolean> => false;
        const daemon = await start(
            { researchOneTopic, indexKnowledge: idle, learnFromEpisodes: idle, consolidateKnowledge: idle },
            true,
        );
        const client = await daemon.client();

        await expect(client.call('research_now')).rejects.toThrow(/Queue a topic/);
        await client.call('queue_topic', { topic: 'Local model RAG', priority: 4 });
        expect((await client.call<Array<Record<string, unknown>>>('queue_status'))[0].topic).toBe('Local model RAG');
        await client.call('research_now');
        for (let attempt = 0; attempt < 500 && !researched; attempt += 1) {
            await sleep(10);
        }

        expect(researched).toBe(true);
    });

    it('handles a posted event in the background and lets the user resolve its action', async () => {
        settings.background_research_enabled = true;
        const idle = async (): Promise<boolean> => false;
        const daemon = await start({ researchOneTopic: idle, indexKnowledge: idle, learnFromEpisodes: idle, consolidateKnowledge: idle }, true);
        const events = new EventLog();
        const client = await daemon.client(events.handler);

        const posted = await client.call<{ id: number; duplicate: boolean }>('post_event', {
            source: 'timer',
            type: 'notify',
            payload: { title: 'Stand up' },
            dedupe_key: 'noon',
        });
        await events.waitFor('actions.changed');

        expect((await client.call<Array<Record<string, unknown>>>('events'))[0]).toMatchObject({ id: posted.id, status: 'done', trust: 'external' });
        const [action] = await client.call<Array<Record<string, unknown>>>('actions', { status: 'proposed' });
        expect(action).toMatchObject({ kind: 'notify', title: 'Stand up' });
        expect(await client.call('post_event', { source: 'timer', type: 'notify', dedupe_key: 'noon' })).toEqual({ id: posted.id, duplicate: true });
        expect(await client.call('resolve_action', { action_id: action.id, resolution: 'approved' })).toEqual({ resolved: true });
        expect(await client.call('actions', { status: 'proposed' })).toEqual([]);
    });

    it('rejects an event with an unknown trust and an unknown resolution', async () => {
        const client = await (await start()).client();

        await expect(client.call('post_event', { source: 'mail', type: 'x', trust: 'friend' })).rejects.toThrow('trust must be one of');
        await expect(client.call('resolve_action', { action_id: 1, resolution: 'maybe' })).rejects.toThrow('resolution must be one of');
    });

    it('rejects a priority that is not an integer', async () => {
        const client = await (await start()).client();

        await expect(client.call('queue_topic', { topic: 'Docker', priority: 1.5 })).rejects.toThrow('priority must be an integer.');
        await expect(client.call('queue_topic', { topic: ' ' })).rejects.toThrow('Enter a topic to research.');
    });

    it('returns topics, sources, graph and facts for the knowledge page', async () => {
        const store = new KnowledgeStore(settings.knowledge_db_path);
        store.storeSearchResults(
            'Docker builds',
            [{ title: 'Docker guide', url: 'https://example.test/docker', snippet: 'Multi-stage builds.' }],
            { topic: 'Docker' },
        );
        store.addFact('Docker', 'Multi-stage builds keep images small.', 'https://example.test/docker');
        const client = await (await start()).client();

        const knowledge = await client.call<Record<string, Array<Record<string, unknown>>>>('knowledge', { query: 'Docker builds' });
        const topicId = knowledge.topics[0].id;
        const chosen = await client.call<Record<string, Array<Record<string, unknown>>>>('knowledge', { topic_id: topicId });
        const other = await client.call<Record<string, Array<Record<string, unknown>>>>('knowledge', { topic_id: Number(topicId) + 100 });

        expect(knowledge.topics.map((topic) => topic.name)).toEqual(['Docker']);
        expect(knowledge.sources[0].url).toBe('https://example.test/docker');
        expect(knowledge.graph[0].relation).toBe('supported_by');
        expect(knowledge.facts.map((fact) => fact.statement)).toEqual(['Multi-stage builds keep images small.']);
        expect(chosen.facts).toHaveLength(1);
        expect(chosen.sources[0].url).toBe('https://example.test/docker');
        expect(other.facts).toEqual([]);
    });

    it('replaces a stale socket when binding but not a live one', async () => {
        const daemon = await start();
        const stalePath = join(daemon.directory, 'stale.sock');
        // A process killed while listening leaves its socket file behind with nobody answering.
        const holder = spawn(process.execPath, [
            '-e',
            `require('node:net').createServer().listen(${JSON.stringify(stalePath)}, () => console.log('up'))`,
        ]);
        await new Promise((resolveUp) => holder.stdout.once('data', resolveUp));
        const exited = new Promise((resolveExit) => holder.once('exit', resolveExit));
        holder.kill('SIGKILL');
        await exited;
        const replacement = new HarnessDaemon(settings);

        await expect(new HarnessDaemon(settings).bind(daemon.socketPath)).rejects.toThrow(/already listening/);
        expect(existsSync(stalePath)).toBe(true);
        await replacement.bind(stalePath);
        await replacement.close();

        expect(existsSync(stalePath)).toBe(false);
    });

    it('exits once no interface stays connected', async () => {
        const daemon = await RunningDaemon.start(settings, { settingsPath, exitWhenUnusedSeconds: 0.3 });
        cleanups.push(() => daemon.stop());
        const client = await daemon.client();
        await sleep(600);
        expect((await client.call<Record<string, unknown>>('status')).run).toBeNull();

        client.close();
        await Promise.race([daemon.serving, sleep(5000)]);

        expect(daemon.served).toBe(true);
        expect(daemon.harness.stopping).toBe(true);
    });

    it('answers an unknown method with an error', async () => {
        const client = await (await start()).client();

        await expect(client.call('explode')).rejects.toThrow(/Unknown method/);
    });

    it('answers an unexpected parameter with an error', async () => {
        const client = await (await start()).client();

        await expect(client.call('status', { verbose: true })).rejects.toThrow("status() got an unexpected keyword argument 'verbose'");
    });

    it('unloads both models when it closes', async () => {
        const harness = new HarnessDaemon(settings, settingsPath);
        const mainUnload = vi.spyOn(harness.modelCache, 'unload');
        const backgroundUnload = vi.spyOn(harness.backgroundModelCache, 'unload');

        await harness.close();

        expect(mainUnload).toHaveBeenCalled();
        expect(backgroundUnload).toHaveBeenCalled();
    });

    it('puts back jobs a stopped daemon left running when the worker starts', async () => {
        const store = new KnowledgeStore(settings.knowledge_db_path);
        store.enqueueTopic('Docker');
        store.claimJob();
        const idle = async (): Promise<boolean> => false;

        const daemon = await start({ researchOneTopic: idle, indexKnowledge: idle, learnFromEpisodes: idle, consolidateKnowledge: idle }, true);

        const jobs = await (await daemon.client()).call<Array<Record<string, unknown>>>('queue_status');
        expect(jobs.map((job) => job.status)).toEqual(['pending']);
    });
});
