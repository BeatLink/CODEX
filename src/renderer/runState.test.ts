import { describe, expect, it } from 'vitest';

import {
    APPROVAL_QUESTION,
    applyStatus,
    approvalPlan,
    beginRun,
    chooseTask,
    choosePhase,
    chosenTask,
    clarificationAnswered,
    clearWorkbench,
    DISCONNECTED_EVENT,
    FINAL_WAITING_TEXT,
    initialState,
    reduceEvent,
    unfinishedRunText,
    type WorkbenchState,
} from './runState.js';
import type { Settings, Status, TaskNode } from './types.js';

const settings = { mode: 'auto', model_path: 'm.gguf', filesystem_root: '.', allow_file_writes: false, background_research_enabled: true, mcp_servers: [] } as Settings;

function node(id: string, status = 'pending', extra: Partial<TaskNode> = {}): TaskNode {
    return { id, prompt: `Do ${id}`, deliverable: `Result ${id}`, status, ...extra };
}

function events(state: WorkbenchState, ...steps: Array<[string, Record<string, unknown>]>): WorkbenchState {
    return steps.reduce((current, [event, data]) => reduceEvent(current, event, data).state, state);
}

// ============================================================================
// Runs
// ============================================================================

describe('a run from start to finish', () => {
    it('streams steps under a heading per step and ends on the final answer', () => {
        const running = beginRun(initialState(), 1);

        const finished = events(
            running,
            ['run.progress', { run_id: 1, label: 'Loading model' }],
            ['run.tree', { run_id: 1, nodes: [node('1', 'running')] }],
            ['run.progress', { run_id: 1, label: 'Task 1 · research' }],
            ['run.token', { run_id: 1, label: 'Task 1 · research', token: 'Look' }],
            ['run.token', { run_id: 1, label: 'Task 1 · research', token: 'ing' }],
            ['run.token', { run_id: 1, label: 'Planning', token: 'ignored' }],
            ['run.token', { run_id: 1, label: 'Task 1 · answer', token: 'Done' }],
            ['run.finished', { run_id: 1, result: '# Answer' }],
        );

        expect(finished.steps).toEqual([
            { label: 'Task 1 · research', text: 'Looking' },
            { label: 'Task 1 · answer', text: 'Done' },
        ]);
        expect(finished.running).toBe(false);
        expect(finished.finalText).toBe('# Answer');
        expect(finished.lastAnswer).toBe('# Answer');
        expect(finished.phase).toBe('final');
        expect(finished.status).toBe('Complete');
    });

    it('shows the loading step in plain words and follows task steps until the user picks a page', () => {
        const running = beginRun(initialState(), 1);

        const loading = events(running, ['run.progress', { label: 'Loading model' }]);
        const following = events(loading, ['run.progress', { label: 'Task 1 · plan' }]);
        const picked = choosePhase(following, 'final');
        const stillOnFinal = events(picked, ['run.progress', { label: 'Task 2 · plan' }]);

        expect(loading.status).toBe('Loading local model...');
        expect(following.phase).toBe('steps');
        expect(stillOnFinal.phase).toBe('final');
        expect(stillOnFinal.status).toBe('Task 2 · plan');
    });

    it("shows a picked task's details as the tree changes", () => {
        const running = events(beginRun(initialState(), 1), ['run.tree', { nodes: [node('1'), node('1.1')] }]);

        const picked = chooseTask(running, '1.1');
        const updated = events(picked, ['run.tree', { nodes: [node('1'), node('1.1', 'done', { result: 'Found it' })] }]);

        expect(picked.phase).toBe('task');
        expect(picked.followSteps).toBe(false);
        expect(chosenTask(updated)?.result).toBe('Found it');
    });

    it('follows a run another interface starts, but not one this window already began', () => {
        const idle = initialState();

        const watching = events(idle, ['run.started', { run_id: 7, prompt: 'x' }]);
        const ours = { ...beginRun(idle, 3), steps: [{ label: 'Task 1 · a', text: 'kept' }] };
        const unchanged = events(ours, ['run.started', { run_id: 3, prompt: 'x' }]);

        expect(watching.running).toBe(true);
        expect(watching.runId).toBe(7);
        expect(unchanged.steps).toHaveLength(1);
    });

    it('reports a failed and a cancelled run on the final page', () => {
        const running = beginRun(initialState(), 1);

        const failed = reduceEvent(running, 'run.failed', { run_id: 1, message: 'No model file' });
        const cancelled = events(running, ['run.cancelled', { run_id: 1 }]);

        expect(failed.state.finalText).toBe('**Run failed**\n\nNo model file');
        expect(failed.state.status).toBe('Run failed');
        expect(failed.effects).toEqual([{ kind: 'notify', message: 'No model file', error: true }]);
        expect(cancelled.finalText).toBe('_Run cancelled._');
        expect(cancelled.status).toBe('Cancelled');
    });

    it('fails the run and marks the daemon unavailable when the connection drops', () => {
        const running = beginRun(initialState(), 1);

        const dropped = reduceEvent(running, DISCONNECTED_EVENT, {});

        expect(dropped.state.running).toBe(false);
        expect(dropped.state.connection).toBe('unavailable');
        expect(dropped.state.status).toBe('Daemon unavailable');
        expect(dropped.effects.map((effect) => effect.kind)).toEqual(['notify', 'notify']);
    });

    it('clears only when no run is going', () => {
        const finished = events(beginRun(initialState(), 1), ['run.finished', { result: 'answer' }]);

        const cleared = clearWorkbench(finished);
        const running = beginRun(initialState(), 2);

        expect(cleared.finalText).toBe(FINAL_WAITING_TEXT);
        expect(cleared.lastAnswer).toBe('');
        expect(cleared.status).toBe('Ready');
        expect(clearWorkbench(running)).toBe(running);
    });
});

// ============================================================================
// Status, background and lists
// ============================================================================

describe('daemon status and other events', () => {
    it("picks up a run in progress from the daemon's status", () => {
        const status: Status = {
            settings,
            settings_path: '/home/u/settings.json',
            run: {
                run_id: 5,
                prompt: 'Write it',
                tree: [node('1', 'running')],
                progress: ['Loading model', 'Task 1 · draft'],
                outputs: { 'Task 1 · draft': 'Hello', Planning: 'hidden' },
            },
            background: { status: 'Foreground prompt active', output: 'old notes' },
            unfinished_runs: [],
        };

        const { state, effects } = applyStatus(initialState(), status);

        expect(state.connection).toBe('connected');
        expect(state.running).toBe(true);
        expect(state.runId).toBe(5);
        expect(state.nodes).toHaveLength(1);
        expect(state.steps).toEqual([{ label: 'Task 1 · draft', text: 'Hello' }]);
        expect(state.phase).toBe('steps');
        expect(state.backgroundOutput).toBe('old notes');
        expect(effects.map((effect) => effect.kind)).toEqual(['show_settings', 'refresh_knowledge', 'refresh_queue']);
    });

    it('starts the background output afresh with each search', () => {
        const writing = events(initialState(), ['background.token', { token: 'a' }], ['background.token', { token: 'b' }]);

        const searching = events(writing, ['background.status', { message: 'Searching: rust' }]);

        expect(writing.backgroundOutput).toBe('ab');
        expect(searching.backgroundOutput).toBe('');
        expect(searching.backgroundStatus).toBe('Searching: rust');
    });

    it('asks for fresh lists when the daemon says they changed', () => {
        const kinds = ['queue.changed', 'runs.changed', 'knowledge.changed'].map(
            (event) => reduceEvent(initialState(), event, {}).effects[0].kind,
        );

        expect(kinds).toEqual(['refresh_queue', 'refresh_unfinished', 'refresh_knowledge']);
    });

    it('keeps the settings another interface applied', () => {
        const changed = events(initialState(), ['settings.changed', { settings: { ...settings, background_research_enabled: false } }]);

        expect(changed.settings?.background_research_enabled).toBe(false);
    });

    it('offers the newest unfinished run with a shortened prompt', () => {
        const prompt = 'word '.repeat(30);
        const state = { ...initialState(), unfinishedRuns: [{ id: 2, prompt, status: 'stopped', tasks_done: 1, tasks_total: 4 }] };

        const text = unfinishedRunText(state);

        expect(text).toBe(`Unfinished: ${prompt.trim().slice(0, 80)}… (1 of 4 tasks done)`);
        expect(unfinishedRunText({ ...state, running: true })).toBeNull();
    });
});

// ============================================================================
// Clarifications and approvals
// ============================================================================

describe('clarifications and approvals', () => {
    it('queues questions and tells an approval apart from a clarification', () => {
        const question = `${APPROVAL_QUESTION}\n\nTask 1: Edit the README`;

        const asked = events(
            beginRun(initialState(), 1),
            ['run.clarification', { run_id: 1, clarification_id: 1, question: 'Which folder?' }],
            ['run.clarification', { run_id: 1, clarification_id: 2, question }],
        );

        expect(asked.clarifications.map((item) => item.approval)).toEqual([false, true]);
        expect(approvalPlan(question)).toBe('Task 1: Edit the README');
        expect(clarificationAnswered(asked, 1).clarifications.map((item) => item.clarification_id)).toEqual([2]);
    });

    it('drops open questions when the run ends', () => {
        const asked = events(beginRun(initialState(), 1), ['run.clarification', { run_id: 1, clarification_id: 1, question: 'Why?' }]);

        const ended = events(asked, ['run.cancelled', { run_id: 1 }]);

        expect(ended.clarifications).toEqual([]);
    });
});
