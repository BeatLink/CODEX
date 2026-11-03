import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEFAULT_MODEL_PATH = './models/model.gguf';
export const CONTEXT_SIZE = 4096;
export const MAX_TOKENS = 2048;
export const TEMPERATURE = 0.1;
export const MODE_CHOICES = ['auto', 'answer', 'draft', 'execute'] as const;
export const RETIRED_SETTINGS = ['runner'] as const;
export const MAX_TASK_DEPTH = 3;
export const MAX_TASK_NODES = 20;
export const DEFAULT_SETTINGS_PATH = join(process.cwd(), 'settings.json');
export const USER_SETTINGS_PATH = join(homedir(), '.config', 'codex', 'settings.json');
export const DEFAULT_KNOWLEDGE_DB_PATH = '~/.local/share/codex/knowledge.sqlite3';
export const DEFAULT_EMBEDDING_MODEL_PATH = './models/embedding.gguf';

export type Mode = typeof MODE_CHOICES[number];
export type McpTransport = 'stdio' | 'http';

export type Settings = {
    model_path: string;
    context_size: number;
    gpu_layers: number;
    max_tokens: number;
    temperature: number;
    filesystem_root: string;
    allow_file_writes: boolean;
    max_tool_calls: number;
    max_search_results: number;
    enable_test_execution: boolean;
    confirm_actions: boolean;
    show_thinking: boolean;
    mode: Mode;
    max_task_depth: number;
    max_task_nodes: number;
    mcp_servers: Array<Record<string, unknown>>;
    knowledge_db_path: string;
    embedding_model_path: string;
    background_research_enabled: boolean;
    background_model_path: string;
    background_context_size: number;
    background_gpu_layers: number;
    background_poll_interval_seconds: number;
    background_refresh_interval_hours: number;
    background_max_tokens: number;
    background_max_pending_jobs: number;
    background_prune_after_days: number;
    background_max_store_megabytes: number;
};

export const DEFAULT_SETTINGS: Settings = {
    model_path: DEFAULT_MODEL_PATH,
    context_size: CONTEXT_SIZE,
    gpu_layers: -1,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    filesystem_root: '.',
    allow_file_writes: false,
    max_tool_calls: 5,
    max_search_results: 5,
    enable_test_execution: false,
    confirm_actions: true,
    show_thinking: true,
    mode: 'auto',
    max_task_depth: MAX_TASK_DEPTH,
    max_task_nodes: MAX_TASK_NODES,
    mcp_servers: [],
    knowledge_db_path: DEFAULT_KNOWLEDGE_DB_PATH,
    embedding_model_path: DEFAULT_EMBEDDING_MODEL_PATH,
    background_research_enabled: true,
    background_model_path: '',
    background_context_size: 0,
    background_gpu_layers: 0,
    background_poll_interval_seconds: 10,
    background_refresh_interval_hours: 168,
    background_max_tokens: 512,
    background_max_pending_jobs: 100,
    background_prune_after_days: 90,
    background_max_store_megabytes: 1024,
};

export function default_settings_path(): string {
    const local = join(process.cwd(), 'settings.json');
    const candidates = [local, DEFAULT_SETTINGS_PATH, USER_SETTINGS_PATH];
    for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
    }
    return USER_SETTINGS_PATH;
}

function asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Expected an object.');
    }
    return value as Record<string, unknown>;
}

export function load_settings(settings_path: string | Record<string, unknown>): Settings {
    if (typeof settings_path === 'string' || settings_path instanceof String) {
        const filePath = String(settings_path);
        if (!existsSync(filePath)) {
            if (filePath === DEFAULT_SETTINGS_PATH || filePath === USER_SETTINGS_PATH) {
                return { ...DEFAULT_SETTINGS };
            }
            throw new Error(`Settings file not found: ${filePath}`);
        }
        const text = readFileSync(filePath, 'utf8');
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch (error) {
            throw new Error(`Invalid JSON in settings file: ${(error as Error).message}`);
        }
        return validate_settings(asRecord(parsed));
    }

    return validate_settings({ ...DEFAULT_SETTINGS, ...asRecord(settings_path) });
}

export function save_settings(settings_path: string, values: Partial<Settings>): Settings {
    const validated = validate_settings({ ...DEFAULT_SETTINGS, ...values });
    const target = settings_path;
    mkdirSync(target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '.', { recursive: true });
    writeFileSync(target, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    return validated;
}

export function validate_settings(values: Record<string, unknown>): Settings {
    const merged = { ...DEFAULT_SETTINGS, ...values } as Record<string, unknown>;
    for (const key of RETIRED_SETTINGS) {
        delete (merged as any)[key];
    }

    const unknown = Object.keys(merged).filter((key) => !(key in DEFAULT_SETTINGS));
    if (unknown.length > 0) {
        throw new Error(`Unknown setting(s): ${unknown.sort().join(', ')}`);
    }

    const result: Record<string, unknown> = { ...DEFAULT_SETTINGS, ...merged };

    if (typeof result.model_path !== 'string' || !String(result.model_path).trim()) {
        throw new Error('model_path must be a non-empty string.');
    }
    for (const name of ['context_size', 'max_tokens']) {
        const value = result[name];
        if (typeof value === 'boolean' || !Number.isInteger(value) || Number(value) <= 0) {
            throw new Error(`${name} must be a positive integer.`);
        }
    }
    if (typeof result.gpu_layers !== 'number' || Number.isNaN(result.gpu_layers) || result.gpu_layers < -1 || !Number.isInteger(result.gpu_layers)) {
        throw new Error('gpu_layers must be -1 or a non-negative integer.');
    }
    if (typeof result.temperature !== 'number' || result.temperature < 0 || Number.isNaN(result.temperature)) {
        throw new Error('temperature must be a non-negative number.');
    }
    if (typeof result.filesystem_root !== 'string' || !String(result.filesystem_root).trim()) {
        throw new Error('filesystem_root must be a non-empty path string.');
    }
    if (typeof result.allow_file_writes !== 'boolean') {
        throw new Error('allow_file_writes must be a boolean.');
    }
    if (typeof result.enable_test_execution !== 'boolean') {
        throw new Error('enable_test_execution must be a boolean.');
    }
    if (typeof result.confirm_actions !== 'boolean') {
        throw new Error('confirm_actions must be a boolean.');
    }
    if (typeof result.show_thinking !== 'boolean') {
        throw new Error('show_thinking must be a boolean.');
    }
    if (!MODE_CHOICES.includes(String(result.mode) as Mode)) {
        throw new Error(`mode must be one of: ${MODE_CHOICES.join(', ')}.`);
    }
    if (typeof result.knowledge_db_path !== 'string' || !String(result.knowledge_db_path).trim()) {
        throw new Error('knowledge_db_path must be a non-empty path string.');
    }
    if (typeof result.embedding_model_path !== 'string') {
        throw new Error('embedding_model_path must be a path string, or empty to search by words only.');
    }
    result.embedding_model_path = String(result.embedding_model_path).trim();
    if (typeof result.background_research_enabled !== 'boolean') {
        throw new Error('background_research_enabled must be a boolean.');
    }
    if (typeof result.background_model_path !== 'string') {
        throw new Error('background_model_path must be a path string, or empty to use model_path.');
    }
    result.background_model_path = String(result.background_model_path).trim();
    if (typeof result.background_gpu_layers !== 'number' || Number.isNaN(result.background_gpu_layers) || result.background_gpu_layers < -1 || !Number.isInteger(result.background_gpu_layers)) {
        throw new Error('background_gpu_layers must be -1 or a non-negative integer.');
    }
    for (const [name, minimum, maximum] of [
        ['max_task_depth', 0, 6],
        ['max_task_nodes', 1, 60],
        ['background_context_size', 0, 1048576],
        ['background_poll_interval_seconds', 1, 3600],
        ['background_refresh_interval_hours', 1, 8760],
        ['background_max_tokens', 32, 4096],
        ['background_max_pending_jobs', 1, 1000],
        ['background_prune_after_days', 1, 3650],
        ['background_max_store_megabytes', 16, 1048576],
    ] as const) {
        const value = result[name];
        if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
            throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
        }
    }
    for (const name of ['max_tool_calls', 'max_search_results']) {
        const value = result[name];
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10) {
            throw new Error(`${name} must be an integer from 1 to 10.`);
        }
    }

    result.temperature = Number(result.temperature);
    result.mcp_servers = validate_mcp_servers(result.mcp_servers);
    return result as Settings;
}

export function background_model_key(settings: Settings): [string, number, number] {
    if (!settings.background_model_path) {
        return [settings.model_path, settings.context_size, settings.gpu_layers];
    }
    return [settings.background_model_path, settings.background_context_size || settings.context_size, settings.background_gpu_layers];
}

export function mcp_servers_to_json(servers: Array<Record<string, unknown>>): string {
    return JSON.stringify(servers, null, 2);
}

export function mcp_servers_from_json(text: string): Array<Record<string, unknown>> {
    const trimmed = text.trim();
    if (!trimmed) return [];
    try {
        const parsed = JSON.parse(trimmed);
        return validate_mcp_servers(parsed);
    } catch (error) {
        throw new Error(`MCP servers must be valid JSON: ${(error as Error).message}`);
    }
}

export function validate_mcp_servers(servers: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(servers)) {
        throw new Error('mcp_servers must be a list.');
    }

    const validated: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    const allowedFields = new Set(['name', 'enabled', 'transport', 'command', 'args', 'env', 'url', 'headers', 'allowed_tools']);
    const transportFields: Record<string, Set<string>> = {
        stdio: new Set(['command', 'args', 'env']),
        http: new Set(['url', 'headers']),
    };

    for (let index = 0; index < servers.length; index += 1) {
        const server = servers[index];
        if (!server || typeof server !== 'object' || Array.isArray(server)) {
            throw new Error(`mcp_servers[${index}] must be an object.`);
        }
        const record = server as Record<string, unknown>;
        const unknownFields = Object.keys(record).filter((key) => !allowedFields.has(key));
        if (unknownFields.length > 0) {
            throw new Error(`Unknown field(s) in mcp_servers[${index}]: ${unknownFields.sort().join(', ')}`);
        }

        const name = typeof record.name === 'string' ? record.name : '';
        if (!name) {
            throw new Error(`mcp_servers[${index}] must have a name.`);
        }
        if (seen.has(name)) {
            throw new Error(`Duplicate MCP server name: ${name}`);
        }
        seen.add(name);

        const transport = (typeof record.transport === 'string' ? record.transport : null) ?? 'stdio';
        if (transport !== 'stdio' && transport !== 'http') {
            throw new Error(`Unsupported transport: ${transport}`);
        }

        const validatedServer: Record<string, unknown> = {
            name,
            enabled: typeof record.enabled === 'boolean' ? record.enabled : true,
            transport,
        };

        if (transport === 'stdio') {
            if (typeof record.command !== 'string' || !record.command.trim()) {
                throw new Error(`mcp_servers[${index}] requires a command for stdio transport.`);
            }
            validatedServer.command = record.command;
            if (record.args !== undefined) {
                if (!Array.isArray(record.args) || record.args.some((arg) => typeof arg !== 'string')) {
                    throw new Error(`mcp_servers[${index}].args must be an array of strings.`);
                }
                validatedServer.args = record.args;
            }
            if (record.env !== undefined) {
                if (!record.env || typeof record.env !== 'object' || Array.isArray(record.env)) {
                    throw new Error(`mcp_servers[${index}].env must be an object.`);
                }
                validatedServer.env = record.env;
            }
            if (record.url !== undefined) {
                throw new Error(`mcp_servers[${index}] cannot set: url`);
            }
        } else {
            if (typeof record.url !== 'string' || !/^https?:\/\//.test(record.url)) {
                throw new Error(`mcp_servers[${index}] url must be a valid http URL.`);
            }
            validatedServer.url = record.url;
            if (record.command !== undefined) throw new Error(`mcp_servers[${index}] cannot set: command`);
            if (record.args !== undefined) throw new Error(`mcp_servers[${index}] cannot set: args`);
            if (record.headers !== undefined) {
                if (!record.headers || typeof record.headers !== 'object' || Array.isArray(record.headers)) {
                    throw new Error(`mcp_servers[${index}].headers must be an object.`);
                }
                const badHeader = Object.keys(record.headers as Record<string, unknown>).find((header) => !/^[A-Za-z0-9-]+$/.test(header));
                if (badHeader) {
                    throw new Error(`mcp_servers[${index}] header name is invalid: ${badHeader}`);
                }
                validatedServer.headers = record.headers;
            }
        }

        const allowedTools = Array.isArray(record.allowed_tools) ? record.allowed_tools : [];
        if (!allowedTools.length) {
            throw new Error('mcp_servers entries must include at least one tool in allowed_tools.');
        }
        if (!allowedTools.every((tool) => typeof tool === 'string' && tool.trim())) {
            throw new Error('allowed_tools must contain non-empty strings.');
        }
        validatedServer.allowed_tools = allowedTools;
        validated.push(validatedServer);
    }
    return validated;
}
