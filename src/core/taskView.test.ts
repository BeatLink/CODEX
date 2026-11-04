import { describe, expect, it } from 'vitest';

import { TASK_PROMPT_CHARS, taskDetailMarkdown, taskTreeLines } from './taskView.js';

describe('task lines', () => {
    it('shows each task with its state word, indented by depth', () => {
        const nodes = [
            { id: '1', prompt: 'Plan  the\nport', status: 'done' },
            { id: '1.2', prompt: 'Write the tests', status: 'running' },
            { id: '1.2.1', prompt: 'Odd state', status: 'mystery' },
        ];

        expect(taskTreeLines(nodes)).toEqual(['DONE  1 Plan the port', 'NOW     1.2 Write the tests', 'WAIT      1.2.1 Odd state']);
    });

    it('shortens a long prompt with an ellipsis', () => {
        const [line] = taskTreeLines([{ id: '1', prompt: 'x'.repeat(200), status: 'failed' }]);

        expect(line).toBe(`FAIL  1 ${'x'.repeat(TASK_PROMPT_CHARS - 1)}…`);
    });
});

describe('task details', () => {
    it('lists what the task asks, how it went and its result', () => {
        const markdown = taskDetailMarkdown({
            id: '2',
            prompt: 'Check the dates.',
            deliverable: 'A list of dates.',
            status: 'unverified',
            approach: 'research',
            depends_on: ['1', '1.1'],
            note: 'One source only.',
            result: 'The dates.',
            result_shortened: true,
        });

        expect(markdown).toBe(
            [
                '### Task 2',
                'Check the dates.',
                '**Deliverable:** A list of dates.',
                '**State:** unverified, research',
                '**Builds on:** 1, 1.1',
                '**Note:** One source only.',
                'The dates.',
                '_The result is shortened here; the Steps tab has all of it._',
            ].join('\n\n'),
        );
    });

    it('says when there is no result yet', () => {
        const markdown = taskDetailMarkdown({ id: '3', prompt: 'Later.', deliverable: 'Text.', status: 'pending' });

        expect(markdown).toBe('### Task 3\n\nLater.\n\n**Deliverable:** Text.\n\n**State:** pending\n\n_No result yet._');
    });
});
