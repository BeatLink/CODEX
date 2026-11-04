// How the interfaces show a task tree: one line per task, and the details of the chosen one.

// ============================================================================
// Task lines
// ============================================================================

// Task tree runs report steps as "Task <number> · <step>", and interfaces show each task's state in a short word.
export const TASK_STEP_PREFIX = 'Task ';
export const TASK_STATE_WORDS: Record<string, string> = { pending: 'WAIT', running: 'NOW ', done: 'DONE', unverified: 'WARN', failed: 'FAIL' };
export const TASK_PROMPT_CHARS = 80;

export type TaskViewNode = {
    id: string;
    prompt: string;
    status: string;
    deliverable?: string;
    approach?: string | null;
    depends_on?: string[] | null;
    note?: string | null;
    result?: string | null;
    result_shortened?: boolean | null;
};

// Write each task as one line: its state, then its number and prompt, indented by depth.
export function taskTreeLines(nodes: TaskViewNode[]): string[] {
    return nodes.map((node) => {
        let prompt = node.prompt.split(/\s+/).filter(Boolean).join(' ');
        const characters = Array.from(prompt);
        if (characters.length > TASK_PROMPT_CHARS) {
            prompt = characters.slice(0, TASK_PROMPT_CHARS - 1).join('') + '…';
        }
        const indent = '  '.repeat(node.id.split('.').length - 1);
        return `${TASK_STATE_WORDS[node.status] ?? 'WAIT'}  ${indent}${node.id} ${prompt}`;
    });
}

// ============================================================================
// Task details
// ============================================================================

// Describe one task: what it asks, what finished looks like, how it went, and its result.
export function taskDetailMarkdown(node: TaskViewNode): string {
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
