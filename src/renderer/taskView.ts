// How the window shows a task tree: nested rows in the sidebar, and the details of the chosen task.
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
export const STEP_SEPARATOR = ' · ';

// ============================================================================
// Step labels
// ============================================================================

export function stepTaskId(label: string): string {
    return label.slice(TASK_STEP_PREFIX.length).split(STEP_SEPARATOR)[0];
}

export function stepName(label: string): string {
    const separator = label.indexOf(STEP_SEPARATOR);
    return separator < 0 ? label : label.slice(separator + STEP_SEPARATOR.length);
}

// Finds the step with this name that has this many steps of the same name before it, or -1.
export function findStepIndex(stepNames: string[], name: string, occurrence: number): number {
    let seen = 0;
    for (let index = 0; index < stepNames.length; index++) {
        if (stepNames[index] === name) {
            if (seen === occurrence) {
                return index;
            }
            seen++;
        }
    }
    return -1;
}

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

export type TaskBranch = TaskRow & { children: TaskBranch[] };

function parentId(id: string): string {
    return id.split('.').slice(0, -1).join('.');
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

// Nests each task under its parent; a task whose parent is missing sits at the top.
export function taskTreeBranches(nodes: TaskNode[]): TaskBranch[] {
    const branches = new Map<string, TaskBranch>();
    const top: TaskBranch[] = [];
    for (const row of taskTreeRows(nodes)) {
        const branch = { ...row, children: [] };
        branches.set(row.id, branch);
        const parent = branches.get(parentId(row.id));
        if (parent === undefined) {
            top.push(branch);
        } else {
            parent.children.push(branch);
        }
    }
    return top;
}

// Lists the tasks whose rows show, top to bottom, skipping those inside a closed branch.
export function visibleTaskIds(branches: TaskBranch[], collapsedTaskIds: string[]): string[] {
    return branches.flatMap((branch) => [
        branch.id,
        ...(collapsedTaskIds.includes(branch.id) ? [] : visibleTaskIds(branch.children, collapsedTaskIds)),
    ]);
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

// Describes one task: what it asks, what finished looks like, and how it went.
export function taskSummaryMarkdown(node: TaskNode): string {
    const state = node.status + (node.approach ? `, ${node.approach}` : '');
    const parts = [`### Task ${node.id}`, node.prompt, `**Deliverable:** ${node.deliverable}`, `**State:** ${state}`];
    if (node.depends_on && node.depends_on.length > 0) {
        parts.push(`**Builds on:** ${node.depends_on.join(', ')}`);
    }
    if (node.note) {
        parts.push(`**Note:** ${node.note}`);
    }
    return parts.join('\n\n');
}

export function taskOutputMarkdown(node: TaskNode): string {
    const result = node.result || '_No output yet._';
    return node.result_shortened ? `${result}\n\n_The output is shortened here; the thinking above has all of it._` : result;
}
