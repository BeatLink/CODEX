// How the window shows a task tree: one row per task, and the details of the chosen one.
import type { TaskNode } from './types.js';

// Task tree runs report steps as "Task <number> · <step>", and each task's state shows as a short word.
export const TASK_STEP_PREFIX = 'Task ';
export const TASK_STATE_WORDS: Record<string, string> = {
    pending: 'WAIT',
    running: 'NOW ',
    done: 'DONE',
    unverified: 'WARN',
    failed: 'FAIL',
};
export const TASK_PROMPT_CHARS = 80;

// ============================================================================
// Tree rows
// ============================================================================

export type TaskRow = {
    id: string;
    state: string;
    status: string;
    depth: number;
    prompt: string;
};

function shortPrompt(prompt: string): string {
    const words = prompt.split(/\s+/).filter(Boolean).join(' ');
    return words.length > TASK_PROMPT_CHARS ? `${words.slice(0, TASK_PROMPT_CHARS - 1)}…` : words;
}

export function taskTreeRows(nodes: TaskNode[]): TaskRow[] {
    return nodes.map((node) => ({
        id: node.id,
        state: (TASK_STATE_WORDS[node.status] ?? 'WAIT').trim(),
        status: node.status in TASK_STATE_WORDS ? node.status : 'pending',
        depth: node.id.split('.').length - 1,
        prompt: shortPrompt(node.prompt),
    }));
}

// Writes each task as one line: its state, then its number and prompt, indented by depth.
export function taskTreeLines(nodes: TaskNode[]): string[] {
    return nodes.map((node) => {
        const indent = '  '.repeat(node.id.split('.').length - 1);
        return `${TASK_STATE_WORDS[node.status] ?? 'WAIT'}  ${indent}${node.id} ${shortPrompt(node.prompt)}`;
    });
}

// ============================================================================
// Task detail
// ============================================================================

// Describes one task: what it asks, what finished looks like, how it went, and its result.
export function taskDetailMarkdown(node: TaskNode): string {
    const state = node.status + (node.approach ? `, ${node.approach}` : '');
    const parts = [`### Task ${node.id}`, node.prompt, `**Deliverable:** ${node.deliverable}`, `**State:** ${state}`];
    if (node.depends_on && node.depends_on.length > 0) {
        parts.push(`**Builds on:** ${node.depends_on.join(', ')}`);
    }
    if (node.note) {
        parts.push(`**Note:** ${node.note}`);
    }
    parts.push(node.result || '_No result yet._');
    if (node.result_shortened) {
        parts.push('_The result is shortened here; the Steps tab has all of it._');
    }
    return parts.join('\n\n');
}
