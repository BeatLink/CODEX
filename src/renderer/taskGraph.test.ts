import { describe, expect, it } from 'vitest';

import {
    BOX_GAP,
    BOX_WIDTH,
    linkShown,
    ROW_GAP,
    separateRows,
    STEP_ROW_OFFSET,
    STEP_WIDTH,
    startingX,
    taskGraphElements,
    treeOrder,
} from './taskGraph.js';
import type { StepRecord, TaskNode } from './types.js';

function task(id: string, status = 'pending', depends_on: string[] = [], steps: StepRecord[] = []): TaskNode {
    return { id, prompt: `Do\n  ${id}`, deliverable: `Result ${id}`, status, depends_on, steps };
}

function step(name: string, status = 'done', error = ''): StepRecord {
    return { name, status, started_at: 10, ended_at: status === 'running' ? null : 12.5, error };
}

describe('task graph elements', () => {
    it('draws a line to each subtask and an arrow to each task that builds on another', () => {
        const tasks = [task('1', 'running'), task('1.1', 'done'), task('1.2', 'odd'), task('1.3', 'pending', ['1.1', '1.2', '9'])];

        const { nodes, links } = taskGraphElements(tasks);

        expect(nodes.map((node) => [node.id, node.kind, node.anchor, node.row, node.status, node.tooltip])).toEqual([
            ['1', 'task', null, 0, 'running', 'Do 1'],
            ['1.1', 'task', '1', ROW_GAP, 'done', 'Do 1.1'],
            ['1.2', 'task', '1', ROW_GAP, 'pending', 'Do 1.2'],
            ['1.3', 'task', '1', ROW_GAP, 'pending', 'Do 1.3'],
        ]);
        expect(links.map((link) => link.id)).toEqual([
            'subtask:1>1.1',
            'subtask:1>1.2',
            'subtask:1>1.3',
            'dependency:1.1>1.3',
            'dependency:1.2>1.3',
        ]);
    });

    it("chains each task's steps below it and hangs subtasks from the step that planned them", () => {
        const tasks = [
            task('1', 'running', [], [step('Deciding'), step('Planning subtasks'), step('Combining', 'running')]),
            task('1.1', 'failed', [], [step('Deciding'), step('Writing', 'failed', 'kept repeating')]),
        ];

        const { nodes, links } = taskGraphElements(tasks);

        expect(nodes.filter((node) => node.kind === 'step').map((node) => [node.id, node.taskId, node.row, node.status, node.tooltip])).toEqual([
            ['1:0', '1', STEP_ROW_OFFSET, 'done', 'Deciding (done, 2.5 s)'],
            ['1:1', '1', STEP_ROW_OFFSET, 'done', 'Planning subtasks (done, 2.5 s)'],
            ['1:2', '1', STEP_ROW_OFFSET, 'running', 'Combining (running)'],
            ['1.1:0', '1.1', ROW_GAP + STEP_ROW_OFFSET, 'done', 'Deciding (done, 2.5 s)'],
            ['1.1:1', '1.1', ROW_GAP + STEP_ROW_OFFSET, 'failed', 'Writing (failed, 2.5 s): kept repeating'],
        ]);
        expect(links.map((link) => link.id)).toEqual([
            'step:1>1:0',
            'step:1:0>1:1',
            'step:1:1>1:2',
            'step:1.1>1.1:0',
            'step:1.1:0>1.1:1',
            'subtask:1:1>1.1',
        ]);
    });

    it('shows dependency arrows only for the tasks in focus', () => {
        const subtask = { id: 's', source: '1', target: '1.1', kind: 'subtask' as const };
        const chain = { id: 'c', source: '1', target: '1:0', kind: 'step' as const };
        const dependency = { id: 'd', source: '1.1', target: '1.3', kind: 'dependency' as const };

        expect(linkShown(subtask, [null, null])).toBe(true);
        expect(linkShown(chain, [null, null])).toBe(true);
        expect(linkShown(dependency, [null, null])).toBe(false);
        expect(linkShown(dependency, ['1.3', null])).toBe(true);
        expect(linkShown(dependency, [null, '1.1'])).toBe(true);
        expect(linkShown({ ...dependency, source: { id: '1.1' }, target: { id: '1.3' } }, ['1.3', null])).toBe(true);
    });
});

describe('task graph layout', () => {
    it('starts new nodes under their anchor in order', () => {
        expect([0, 1, 2].map((index) => startingX(100, index, 3))).toEqual([100 - BOX_WIDTH - BOX_GAP, 100, 100 + BOX_WIDTH + BOX_GAP]);
        expect(startingX(0, 1, 2, STEP_WIDTH)).toBe((STEP_WIDTH + BOX_GAP) / 2);
    });

    it('orders tasks and steps as the tree reads', () => {
        expect(['1.3.1', '1.10', '1.2.3', '1.9', '1'].sort(treeOrder)).toEqual(['1', '1.2.3', '1.3.1', '1.9', '1.10']);
        expect(['1.2:10', '1.3:0', '1.2:2'].sort(treeOrder)).toEqual(['1.2:2', '1.2:10', '1.3:0']);
    });

    it('pushes apart boxes that overlap in a row, by their widths, and leaves other rows alone', () => {
        const nodes = [
            { id: '1.2', x: 10, fy: 100 },
            { id: '1.1', x: 0, fy: 100 },
            { id: '1:0', x: 0, fy: 62, width: STEP_WIDTH },
            { id: '1:1', x: 0, fy: 62, width: STEP_WIDTH },
            { id: '1.1.1', x: 5, fy: 200 },
        ];

        separateRows(nodes);

        expect(nodes[0].x - nodes[1].x).toBe(BOX_WIDTH + BOX_GAP);
        expect(nodes[3].x - nodes[2].x).toBe(STEP_WIDTH + BOX_GAP);
        expect(nodes[4].x).toBe(5);
    });

    it('puts a box back in tree order when it starts on the wrong side', () => {
        const nodes = [
            { id: '1.3.1', x: 0, fy: 200 },
            { id: '1.2.3', x: 50, fy: 200 },
        ];

        separateRows(nodes);

        expect(nodes[1].x).toBeLessThan(nodes[0].x);
    });
});
