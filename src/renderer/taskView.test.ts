import { describe, expect, it } from 'vitest';

import {
    stepName,
    stepTaskId,
    taskOutputMarkdown,
    taskSummaryMarkdown,
    taskTreeBranches,
    taskTreeLines,
    taskTreeRows,
    visibleTaskIds,
} from './taskView.js';
import type { TaskNode } from './types.js';

function node(id: string, status: string, prompt = 'Find the answer'): TaskNode {
    return { id, prompt, deliverable: 'A short answer', status };
}

describe('task tree rows', () => {
    it('writes each task with its state word, indented by depth', () => {
        const nodes = [node('1', 'done'), node('1.1', 'running'), node('1.1.1', 'mystery')];

        const lines = taskTreeLines(nodes);

        expect(lines).toEqual([
            'DONE  1 Find the answer',
            'NOW     1.1 Find the answer',
            'WAIT      1.1.1 Find the answer',
        ]);
    });

    it('squeezes whitespace and shortens a long prompt', () => {
        const rows = taskTreeRows([node('2', 'failed', `Look   up\n${'x'.repeat(100)}`)]);

        expect(rows[0].prompt).toHaveLength(80);
        expect(rows[0].prompt.startsWith('Look up x')).toBe(true);
        expect(rows[0].prompt.endsWith('…')).toBe(true);
        expect(rows[0]).toMatchObject({ id: '2', state: 'FAIL', status: 'failed', depth: 0 });
    });

    it('treats an unknown state as waiting', () => {
        const rows = taskTreeRows([node('1.2', 'odd')]);

        expect(rows[0]).toMatchObject({ state: 'WAIT', status: 'pending', depth: 1 });
    });
});

describe('task tree branches', () => {
    it('nests each task under its parent and keeps an orphan at the top', () => {
        const branches = taskTreeBranches([node('1', 'done'), node('1.1', 'done'), node('1.1.1', 'running'), node('1.2', 'pending'), node('3.1', 'pending')]);

        expect(branches.map((branch) => branch.id)).toEqual(['1', '3.1']);
        expect(branches[0].children.map((branch) => branch.id)).toEqual(['1.1', '1.2']);
        expect(branches[0].children[0].children.map((branch) => branch.id)).toEqual(['1.1.1']);
    });

    it('skips the rows inside a closed branch', () => {
        const branches = taskTreeBranches([node('1', 'done'), node('1.1', 'done'), node('1.1.1', 'running'), node('1.2', 'pending')]);

        expect(visibleTaskIds(branches, [])).toEqual(['1', '1.1', '1.1.1', '1.2']);
        expect(visibleTaskIds(branches, ['1.1'])).toEqual(['1', '1.1', '1.2']);
        expect(visibleTaskIds(branches, ['1'])).toEqual(['1']);
    });

    it('reads the task and the step from a step label', () => {
        expect(stepTaskId('Task 1.2 · Writing')).toBe('1.2');
        expect(stepName('Task 1.2 · Writing')).toBe('Writing');
    });
});

describe('task detail', () => {
    it('describes a task without an output yet', () => {
        const task = node('1', 'pending');

        expect(taskSummaryMarkdown(task)).toBe('### Task 1\n\nFind the answer\n\n**Deliverable:** A short answer\n\n**State:** pending');
        expect(taskOutputMarkdown(task)).toBe('_No output yet._');
    });

    it('adds the approach, what it builds on, its note, and a shortened output', () => {
        const task = {
            ...node('2', 'done'),
            approach: 'act',
            depends_on: ['1', '1.2'],
            note: 'Checked twice',
            result: 'All good',
            result_shortened: true,
        };

        expect(taskSummaryMarkdown(task).split('\n\n')).toEqual([
            '### Task 2',
            'Find the answer',
            '**Deliverable:** A short answer',
            '**State:** done, act',
            '**Builds on:** 1, 1.2',
            '**Note:** Checked twice',
        ]);
        expect(taskOutputMarkdown(task)).toBe('All good\n\n_The output is shortened here; the thinking above has all of it._');
    });
});
