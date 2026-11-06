import { describe, expect, it } from 'vitest';

import { BOX_GAP, BOX_WIDTH, linkShown, separateRows, startingX, taskGraphElements, treeOrder } from './taskGraph.js';
import type { TaskNode } from './types.js';

function task(id: string, status = 'pending', depends_on: string[] = []): TaskNode {
    return { id, prompt: `Do\n  ${id}`, deliverable: `Result ${id}`, status, depends_on };
}

describe('task graph elements', () => {
    it('draws a line to each subtask and an arrow to each task that builds on another', () => {
        const tasks = [task('1', 'running'), task('1.1', 'done'), task('1.2', 'odd'), task('1.3', 'pending', ['1.1', '1.2', '9'])];

        const { nodes, links } = taskGraphElements(tasks);

        expect(nodes.map((node) => [node.id, node.parent, node.depth, node.status, node.prompt])).toEqual([
            ['1', null, 0, 'running', 'Do 1'],
            ['1.1', '1', 1, 'done', 'Do 1.1'],
            ['1.2', '1', 1, 'pending', 'Do 1.2'],
            ['1.3', '1', 1, 'pending', 'Do 1.3'],
        ]);
        expect(links.map((link) => link.id)).toEqual([
            'subtask:1>1.1',
            'subtask:1>1.2',
            'subtask:1>1.3',
            'dependency:1.1>1.3',
            'dependency:1.2>1.3',
        ]);
    });

    it('shows dependency arrows only for the tasks in focus', () => {
        const subtask = { id: 's', source: '1', target: '1.1', kind: 'subtask' as const };
        const dependency = { id: 'd', source: '1.1', target: '1.3', kind: 'dependency' as const };

        expect(linkShown(subtask, [null, null])).toBe(true);
        expect(linkShown(dependency, [null, null])).toBe(false);
        expect(linkShown(dependency, ['1.3', null])).toBe(true);
        expect(linkShown(dependency, [null, '1.1'])).toBe(true);
        expect(linkShown({ ...dependency, source: { id: '1.1' }, target: { id: '1.3' } }, ['1.3', null])).toBe(true);
    });
});

describe('task graph layout', () => {
    it('starts new tasks under their parent in task order', () => {
        expect([0, 1, 2].map((index) => startingX(100, index, 3))).toEqual([100 - BOX_WIDTH - BOX_GAP, 100, 100 + BOX_WIDTH + BOX_GAP]);
    });

    it('orders task numbers as the tree reads', () => {
        expect(['1.3.1', '1.10', '1.2.3', '1.9', '1'].sort(treeOrder)).toEqual(['1', '1.2.3', '1.3.1', '1.9', '1.10']);
    });

    it('puts a box back in tree order when it starts on the wrong side', () => {
        const nodes = [
            { id: '1.3.1', x: 0, fy: 200 },
            { id: '1.2.3', x: 50, fy: 200 },
        ];

        separateRows(nodes);

        expect(nodes[1].x).toBeLessThan(nodes[0].x);
    });

    it('pushes apart boxes that overlap in a row, in tree order, and leaves other rows alone', () => {
        const nodes = [
            { id: '1.2', x: 10, fy: 100 },
            { id: '1.1', x: 0, fy: 100 },
            { id: '1.1.1', x: 5, fy: 200 },
        ];

        separateRows(nodes);

        expect(nodes.map((node) => node.x)).toEqual([10 + (BOX_WIDTH + BOX_GAP - 10) / 2, -(BOX_WIDTH + BOX_GAP - 10) / 2, 5]);
    });
});
