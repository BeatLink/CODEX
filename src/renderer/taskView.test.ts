import { describe, expect, it } from 'vitest';

import { taskDetailMarkdown, taskTreeLines, taskTreeRows } from './taskView.js';
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

describe('task detail', () => {
    it('describes a task without a result yet', () => {
        const detail = taskDetailMarkdown(node('1', 'pending'));

        expect(detail).toBe('### Task 1\n\nFind the answer\n\n**Deliverable:** A short answer\n\n**State:** pending\n\n_No result yet._');
    });

    it('adds the approach, what it builds on, its note, and a shortened result', () => {
        const detail = taskDetailMarkdown({
            ...node('2', 'done'),
            approach: 'act',
            depends_on: ['1', '1.2'],
            note: 'Checked twice',
            result: 'All good',
            result_shortened: true,
        });

        expect(detail.split('\n\n')).toEqual([
            '### Task 2',
            'Find the answer',
            '**Deliverable:** A short answer',
            '**State:** done, act',
            '**Builds on:** 1, 1.2',
            '**Note:** Checked twice',
            'All good',
            '_The result is shortened here; the Steps tab has all of it._',
        ]);
    });
});
