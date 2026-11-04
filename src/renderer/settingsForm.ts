// The Options form: which settings it shows, how its text turns back into settings, and where Auto size puts its numbers.
import type { Settings, SizeChoice } from './types.js';

export const MODE_CHOICES = ['auto', 'answer', 'draft', 'execute'] as const;
export const MODE_NAMES: Record<string, string> = {
    auto: 'Auto mode',
    answer: 'Answer mode',
    draft: 'Draft mode',
    execute: 'Execute mode',
};

export type NumberField = { label: string; name: string; lowest: number; highest: number; step: number; digits: number };
export type PathField = { label: string; name: string; kind: 'model' | 'directory' | 'database' };
export type SwitchField = { label: string; name: string };
export type FieldGroup = { heading: string; numbers?: NumberField[]; paths?: PathField[]; switches?: SwitchField[]; after?: NumberField[] };

const number = (label: string, name: string, lowest: number, highest: number, step: number, digits = 0): NumberField => ({
    label, name, lowest, highest, step, digits,
});

// ============================================================================
// Fields
// ============================================================================

export const FIELD_GROUPS: FieldGroup[] = [
    {
        heading: 'Model',
        paths: [{ label: 'GGUF model path', name: 'model_path', kind: 'model' }],
        numbers: [
            number('Context size', 'context_size', 1, 1048576, 256),
            number('GPU layers', 'gpu_layers', -1, 1000, 1),
            number('Max tokens', 'max_tokens', 1, 1048576, 64),
            number('Temperature', 'temperature', 0, 5, 0.05, 2),
        ],
    },
    {
        heading: 'Folder access',
        paths: [{ label: 'Filesystem root', name: 'filesystem_root', kind: 'directory' }],
        switches: [
            { label: 'Allow the model to create and replace files', name: 'allow_file_writes' },
            { label: 'Allow the model to run project tests', name: 'enable_test_execution' },
            { label: 'Ask before the model changes files, runs tests, or calls MCP tools', name: 'confirm_actions' },
        ],
    },
    {
        heading: 'Task tree',
        numbers: [number('Max task depth', 'max_task_depth', 0, 6, 1), number('Max tasks', 'max_task_nodes', 1, 60, 1)],
    },
    {
        heading: 'Tool limits',
        numbers: [number('Max tool calls', 'max_tool_calls', 1, 10, 1), number('Max search results', 'max_search_results', 1, 10, 1)],
    },
    {
        heading: 'Background research',
        numbers: [
            number('Poll seconds', 'background_poll_interval_seconds', 1, 3600, 1),
            number('Refresh hours', 'background_refresh_interval_hours', 1, 8760, 1),
            number('Max tokens', 'background_max_tokens', 32, 4096, 32),
            number('Queue cap', 'background_max_pending_jobs', 1, 1000, 1),
            number('Prune after days', 'background_prune_after_days', 1, 3650, 1),
            number('Store cap MB', 'background_max_store_megabytes', 16, 1048576, 16),
        ],
        paths: [
            { label: 'SQLite database', name: 'knowledge_db_path', kind: 'database' },
            { label: 'Embedding GGUF model (empty searches by words only)', name: 'embedding_model_path', kind: 'model' },
            { label: 'Background GGUF model (empty uses the main model)', name: 'background_model_path', kind: 'model' },
        ],
        after: [
            number('Context size (0 uses the main one)', 'background_context_size', 0, 1048576, 256),
            number('GPU layers', 'background_gpu_layers', -1, 1000, 1),
        ],
    },
];

export const MCP_SERVERS_HINT = 'A JSON list of servers; see the README for the fields each one needs.';

export function numberFields(): NumberField[] {
    return FIELD_GROUPS.flatMap((group) => [...(group.numbers ?? []), ...(group.after ?? [])]);
}

export function pathFields(): PathField[] {
    return FIELD_GROUPS.flatMap((group) => group.paths ?? []);
}

export function switchFields(): SwitchField[] {
    return FIELD_GROUPS.flatMap((group) => group.switches ?? []);
}

// ============================================================================
// Form values
// ============================================================================

// What the form holds: text for paths, numbers and the MCP list, booleans for switches.
export type FormValues = {
    text: Record<string, string>;
    switches: Record<string, boolean>;
    mcp_servers: string;
    mode: string;
    background_research_enabled: boolean;
};

export function mcpServersToJson(servers: unknown): string {
    return JSON.stringify(servers ?? [], null, 2);
}

// Reads the MCP server list the user edits as JSON; the daemon checks each server's fields.
export function mcpServersFromJson(text: string): unknown[] {
    let servers: unknown;
    try {
        servers = JSON.parse(text.trim() || '[]');
    } catch (error) {
        throw new Error(`MCP servers must be valid JSON: ${(error as Error).message}`);
    }
    if (!Array.isArray(servers)) {
        throw new Error('mcp_servers must be a list.');
    }
    return servers;
}

export function settingsToForm(settings: Settings): FormValues {
    const text: Record<string, string> = {};
    for (const field of pathFields()) {
        text[field.name] = String(settings[field.name] ?? '');
    }
    for (const field of numberFields()) {
        const value = Number(settings[field.name] ?? 0);
        text[field.name] = field.digits ? value.toFixed(field.digits) : String(value);
    }
    const switches: Record<string, boolean> = {};
    for (const field of switchFields()) {
        switches[field.name] = Boolean(settings[field.name]);
    }
    return {
        text,
        switches,
        mcp_servers: mcpServersToJson(settings.mcp_servers),
        mode: settings.mode,
        background_research_enabled: Boolean(settings.background_research_enabled),
    };
}

export function parseNumberField(field: NumberField, raw: string): number {
    const trimmed = raw.trim();
    const value = Number(trimmed);
    if (!trimmed || !Number.isFinite(value)) {
        throw new Error(`${field.label} must be ${field.digits ? 'a number' : 'an integer'}.`);
    }
    if (!field.digits && !Number.isInteger(value)) {
        throw new Error(`${field.label} must be an integer.`);
    }
    if (value < field.lowest || value > field.highest) {
        throw new Error(`${field.label} must be from ${field.lowest} to ${field.highest}.`);
    }
    return value;
}

// Turns the form back into settings on top of the current ones; the daemon validates the whole set when they are applied.
export function collectSettings(current: Settings, form: FormValues): Settings {
    const settings: Settings = { ...current };
    for (const field of pathFields()) {
        settings[field.name] = form.text[field.name] ?? '';
    }
    for (const field of numberFields()) {
        settings[field.name] = parseNumberField(field, form.text[field.name] ?? '');
    }
    for (const field of switchFields()) {
        settings[field.name] = Boolean(form.switches[field.name]);
    }
    if (!String(settings.model_path).trim()) {
        throw new Error('model_path must be a non-empty string.');
    }
    if (!(MODE_CHOICES as readonly string[]).includes(form.mode)) {
        throw new Error(`mode must be one of: ${MODE_CHOICES.join(', ')}.`);
    }
    settings.mode = form.mode;
    settings.background_research_enabled = form.background_research_enabled;
    settings.mcp_servers = mcpServersFromJson(form.mcp_servers);
    return settings;
}

// ============================================================================
// Auto size
// ============================================================================

export const AUTO_SIZE_FIELDS = ['context_size', 'max_tokens', 'background_max_tokens', 'background_context_size'] as const;

export function autoSizeRequest(form: FormValues): Record<string, unknown> {
    const fields = Object.fromEntries(numberFields().map((field) => [field.name, field]));
    return {
        model_path: (form.text.model_path ?? '').trim(),
        gpu_layers: parseNumberField(fields.gpu_layers, form.text.gpu_layers ?? ''),
        background_model_path: (form.text.background_model_path ?? '').trim(),
        background_gpu_layers: parseNumberField(fields.background_gpu_layers, form.text.background_gpu_layers ?? ''),
    };
}

// Fills the context and token limits Auto size suggested, ready to apply or save.
export function applySizeChoice(form: FormValues, choice: SizeChoice): FormValues {
    const text = { ...form.text };
    for (const name of AUTO_SIZE_FIELDS) {
        text[name] = String(choice[name]);
    }
    return { ...form, text };
}

export function sizeChoiceMessage(choice: SizeChoice): string {
    return (
        `${choice.explanation}. Context ${choice.context_size}, max tokens ${choice.max_tokens},` +
        ` background context ${choice.background_context_size},` +
        ` background max tokens ${choice.background_max_tokens}. Apply or save to use them.`
    );
}
