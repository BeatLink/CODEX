// Suggestions for the slash commands a prompt may start with; the daemon's run carries each one out.
import type { UserCommand } from './types.js';

export type CommandSuggestion = { name: string; usage: string; description: string };

// ============================================================================
// Built-in commands
// ============================================================================

export const BUILTIN_COMMANDS: CommandSuggestion[] = [
    {
        name: 'remember',
        usage: '/remember [kind] statement. Why: reason',
        description: 'Keep a memory without loading the model; kinds: preference, project, correction, reference',
    },
    { name: 'memories', usage: '/memories', description: 'List memories for this folder, newest first' },
    { name: 'forget', usage: '/forget number or words', description: 'Forget one memory by its number or words from it' },
    { name: 'init', usage: '/init [notes]', description: "Write this folder's CODEX.md from its files" },
    { name: 'answer', usage: '/answer request', description: 'Run this request in answer mode' },
    { name: 'draft', usage: '/draft request', description: 'Run this request in draft mode' },
    { name: 'plan', usage: '/plan request', description: 'Run this request in draft mode' },
    { name: 'do', usage: '/do request', description: 'Run this request in execute mode' },
    { name: 'execute', usage: '/execute request', description: 'Run this request in execute mode' },
];

// ============================================================================
// Matching
// ============================================================================

// Returns the commands the prompt's first word could still become, or none once a space follows it.
export function commandSuggestions(prompt: string, userCommands: UserCommand[]): CommandSuggestion[] {
    const leading = prompt.replace(/^\s+/, '');
    if (!leading.startsWith('/') || /\s/.test(leading)) {
        return [];
    }
    const typed = leading.slice(1).toLowerCase();
    const users = userCommands.map((command) => ({
        name: command.name,
        usage: `/${command.name} [arguments]`,
        description: (command.description || 'Your command') + (command.mode ? ` (${command.mode} mode)` : ''),
    }));
    return [...BUILTIN_COMMANDS, ...users].filter((command) => command.name.startsWith(typed));
}

// Puts the chosen command at the start of the prompt, ready for its arguments.
export function completeCommand(prompt: string, name: string): string {
    const rest = prompt.replace(/^\s*\/\S*/, '').replace(/^\s+/, '');
    return `/${name} ${rest}`;
}
