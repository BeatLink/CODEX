// The settings file: its defaults, where it lives, and the checks every value must pass.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================================
// Defaults
// ============================================================================

export const DEFAULT_MODEL_PATH = './models/model.gguf';
export const CONTEXT_SIZE = 6144;
export const MAX_TOKENS = 2048;
export const TEMPERATURE = 0.1;
export const MODE_CHOICES = ['auto', 'answer', 'draft', 'execute'] as const;
// Settings that no longer do anything, which a settings file may still hold and loading drops.
export const RETIRED_SETTINGS = ['runner'] as const;
export const MAX_TASK_DEPTH = 3;
export const MAX_TASK_NODES = 20;
export const DEFAULT_SETTINGS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'settings.json');
export const USER_SETTINGS_PATH = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'codex', 'settings.json');
export const DEFAULT_KNOWLEDGE_DB_PATH = '~/.local/share/codex/knowledge.sqlite3';
export const DEFAULT_EMBEDDING_MODEL_PATH = './models/embedding.gguf';

export type Mode = (typeof MODE_CHOICES)[number];

export type StdioServerSettings = {
    name: string;
    enabled: boolean;
    transport: 'stdio';
    command: string;
    args: string[];
    env: Record<string, string>;
    allowed_tools: string[];
};

export type HttpServerSettings = {
    name: string;
    enabled: boolean;
    transport: 'http';
    url: string;
    headers: Record<string, string>;
    allowed_tools: string[];
};

export type McpServerSettings = StdioServerSettings | HttpServerSettings;

// An IMAP mailbox read over TLS; the password comes from running password_command, so settings never hold it.
export type ImapAccount = {
    name: string;
    host: string;
    port: number;
    username: string;
    password_command: string[];
    folder: string;
};

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
    mcp_servers: McpServerSettings[];
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
    mail_maildir_paths: string[];
    mail_max_age_days: number;
    mail_imap_accounts: ImapAccount[];
    mail_draft_replies: boolean;
    mail_rule_proposal_threshold: number;
};

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
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
    // In an interactive run, the user approves a run's file changes, test runs, and MCP calls before they happen.
    confirm_actions: true,
    show_thinking: true,
    mode: 'auto',
    max_task_depth: MAX_TASK_DEPTH,
    max_task_nodes: MAX_TASK_NODES,
    mcp_servers: [],
    knowledge_db_path: DEFAULT_KNOWLEDGE_DB_PATH,
    // Facts and topics are found by meaning with this model; an empty or missing file keeps search lexical.
    embedding_model_path: DEFAULT_EMBEDDING_MODEL_PATH,
    background_research_enabled: true,
    // An empty path runs background work on the main model; a context size of 0 uses the main one.
    background_model_path: '',
    background_context_size: 0,
    background_gpu_layers: 0,
    background_poll_interval_seconds: 10,
    background_refresh_interval_hours: 168,
    background_max_tokens: 512,
    background_max_pending_jobs: 100,
    background_prune_after_days: 90,
    background_max_store_megabytes: 1024,
    // Maildir folders whose new/ messages become events; none are read until one is listed.
    mail_maildir_paths: [],
    mail_max_age_days: 7,
    mail_imap_accounts: [],
    // A message that needs an answer gets a drafted reply, which the model works as a task tree; it is never sent.
    mail_draft_replies: true,
    // Dismissing this many messages in a row from one sender proposes a rule to ignore it; 0 never proposes one.
    mail_rule_proposal_threshold: 3,
} satisfies Settings);

// ============================================================================
// Paths
// ============================================================================

// Turn a leading ~ into the home folder, as a shell would.
export function expandUser(path: string): string {
    if (path === '~') {
        return homedir();
    }
    if (path.startsWith('~/')) {
        return join(homedir(), path.slice(2));
    }
    return path;
}

function isFile(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

// Pick the settings file: one in the working folder, then the one beside the program, then the user's own.
export function defaultSettingsPath(options: { bundledPath?: string; userPath?: string } = {}): string {
    const localSettingsPath = join(process.cwd(), 'settings.json');
    for (const path of [localSettingsPath, options.bundledPath ?? DEFAULT_SETTINGS_PATH]) {
        if (isFile(path)) {
            return path;
        }
    }
    return options.userPath ?? USER_SETTINGS_PATH;
}

// ============================================================================
// Loading and saving
// ============================================================================

export function loadSettings(settingsPath: string): Settings {
    let text: string;
    try {
        text = readFileSync(settingsPath, 'utf-8');
    } catch (error) {
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
        if (missing && [resolve(DEFAULT_SETTINGS_PATH), resolve(USER_SETTINGS_PATH)].includes(resolve(settingsPath))) {
            return structuredClone(DEFAULT_SETTINGS) as Settings;
        }
        throw error;
    }
    let settings: unknown;
    try {
        settings = JSON.parse(text);
    } catch (error) {
        throw new Error(`Invalid JSON in settings file: ${(error as Error).message}`);
    }
    if (!isObject(settings)) {
        throw new Error('The settings file must contain a JSON object.');
    }

    const kept = Object.fromEntries(Object.entries(settings).filter(([key]) => !(RETIRED_SETTINGS as readonly string[]).includes(key)));
    const unknownKeys = Object.keys(kept).filter((key) => !(key in DEFAULT_SETTINGS));
    if (unknownKeys.length > 0) {
        throw new Error(`Unknown setting(s): ${unknownKeys.sort().join(', ')}`);
    }
    return validateSettings({ ...structuredClone(DEFAULT_SETTINGS), ...kept });
}

export function saveSettings(settingsPath: string, values: Record<string, unknown>): Settings {
    const validated = validateSettings(values);
    const path = expandUser(settingsPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`, 'utf-8');
    return validated;
}

// ============================================================================
// Checks
// ============================================================================

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value);
}

// Check every setting and return a copy with paths trimmed and the MCP servers filled in.
export function validateSettings(input: Record<string, unknown>): Settings {
    const values: Record<string, unknown> = { ...input };
    const modelPath = values.model_path;
    if (typeof modelPath !== 'string' || !modelPath.trim()) {
        throw new Error('model_path must be a non-empty string.');
    }
    for (const name of ['context_size', 'max_tokens']) {
        const value = values[name];
        if (!isInteger(value) || value <= 0) {
            throw new Error(`${name} must be a positive integer.`);
        }
    }
    if (!isInteger(values.gpu_layers) || values.gpu_layers < -1) {
        throw new Error('gpu_layers must be -1 or a non-negative integer.');
    }
    if (typeof values.temperature !== 'number' || Number.isNaN(values.temperature) || values.temperature < 0) {
        throw new Error('temperature must be a non-negative number.');
    }
    if (typeof values.filesystem_root !== 'string' || !values.filesystem_root.trim()) {
        throw new Error('filesystem_root must be a non-empty path string.');
    }
    for (const name of ['allow_file_writes', 'enable_test_execution', 'confirm_actions', 'show_thinking']) {
        if (typeof values[name] !== 'boolean') {
            throw new Error(`${name} must be a boolean.`);
        }
    }
    if (!(MODE_CHOICES as readonly unknown[]).includes(values.mode)) {
        throw new Error(`mode must be one of: ${MODE_CHOICES.join(', ')}.`);
    }
    if (typeof values.knowledge_db_path !== 'string' || !values.knowledge_db_path.trim()) {
        throw new Error('knowledge_db_path must be a non-empty path string.');
    }
    if (typeof values.embedding_model_path !== 'string') {
        throw new Error('embedding_model_path must be a path string, or empty to search by words only.');
    }
    values.embedding_model_path = values.embedding_model_path.trim();
    if (typeof values.background_research_enabled !== 'boolean') {
        throw new Error('background_research_enabled must be a boolean.');
    }
    if (typeof values.background_model_path !== 'string') {
        throw new Error('background_model_path must be a path string, or empty to use model_path.');
    }
    values.background_model_path = values.background_model_path.trim();
    if (!isInteger(values.background_gpu_layers) || values.background_gpu_layers < -1) {
        throw new Error('background_gpu_layers must be -1 or a non-negative integer.');
    }
    if (!Array.isArray(values.mail_maildir_paths) || values.mail_maildir_paths.some((path) => typeof path !== 'string' || !path.trim())) {
        throw new Error('mail_maildir_paths must be a list of folder path strings.');
    }
    values.mail_maildir_paths = values.mail_maildir_paths.map((path: string) => path.trim());
    values.mail_imap_accounts = validateImapAccounts(values.mail_imap_accounts);
    if (typeof values.mail_draft_replies !== 'boolean') {
        throw new Error('mail_draft_replies must be a boolean.');
    }
    const ranges: Array<[string, number, number]> = [
        ['max_task_depth', 0, 6],
        ['max_task_nodes', 1, 60],
        ['background_context_size', 0, 1048576],
        ['background_poll_interval_seconds', 1, 3600],
        ['background_refresh_interval_hours', 1, 8760],
        ['background_max_tokens', 32, 4096],
        ['background_max_pending_jobs', 1, 1000],
        ['background_prune_after_days', 1, 3650],
        ['background_max_store_megabytes', 16, 1048576],
        ['mail_max_age_days', 1, 365],
        ['mail_rule_proposal_threshold', 0, 100],
    ];
    for (const [name, minimum, maximum] of ranges) {
        const value = values[name];
        if (!isInteger(value) || value < minimum || value > maximum) {
            throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
        }
    }
    for (const name of ['max_tool_calls', 'max_search_results']) {
        const value = values[name];
        if (!isInteger(value) || value < 1 || value > 10) {
            throw new Error(`${name} must be an integer from 1 to 10.`);
        }
    }
    values.mcp_servers = validateMcpServers(values.mcp_servers);
    return values as Settings;
}

// Return the model path, context size and GPU layers that background work loads.
export function backgroundModelKey(settings: Settings): [string, number, number] {
    if (!settings.background_model_path) {
        return [settings.model_path, settings.context_size, settings.gpu_layers];
    }
    return [settings.background_model_path, settings.background_context_size || settings.context_size, settings.background_gpu_layers];
}

// ============================================================================
// MCP servers
// ============================================================================

export function mcpServersToJson(servers: McpServerSettings[]): string {
    return JSON.stringify(servers, null, 2);
}

// Read the MCP server list an interface lets the user edit as JSON.
export function mcpServersFromJson(text: string): McpServerSettings[] {
    let servers: unknown;
    try {
        servers = JSON.parse(text.trim() || '[]');
    } catch (error) {
        throw new Error(`MCP servers must be valid JSON: ${(error as Error).message}`);
    }
    return validateMcpServers(servers);
}

const ALLOWED_IMAP_FIELDS = new Set(['name', 'host', 'port', 'username', 'password_command', 'folder']);

export function validateImapAccounts(accounts: unknown): ImapAccount[] {
    if (!Array.isArray(accounts)) {
        throw new Error('mail_imap_accounts must be a list.');
    }
    const seenNames = new Set<string>();
    return accounts.map((account: unknown, index): ImapAccount => {
        const where = `mail_imap_accounts[${index}]`;
        if (!isObject(account)) {
            throw new Error(`${where} must be an object.`);
        }
        const unknownFields = Object.keys(account).filter((key) => !ALLOWED_IMAP_FIELDS.has(key));
        if (unknownFields.length > 0) {
            throw new Error(`Unknown field(s) in ${where}: ${unknownFields.sort().join(', ')}`);
        }
        const { name, host, username } = account;
        if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
            throw new Error(`${where}.name must be 1-32 letters, numbers, '_' or '-'.`);
        }
        if (seenNames.has(name)) {
            throw new Error(`IMAP account names must be unique: ${name}.`);
        }
        seenNames.add(name);
        if (typeof host !== 'string' || !/^[A-Za-z0-9.-]+$/.test(host.trim())) {
            throw new Error(`${where}.host must be a host name.`);
        }
        if (typeof username !== 'string' || !username.trim()) {
            throw new Error(`${where}.username must be a non-empty string.`);
        }
        const port = account.port ?? 993;
        if (!isInteger(port) || port < 1 || port > 65535) {
            throw new Error(`${where}.port must be an integer from 1 to 65535.`);
        }
        const command = account.password_command;
        if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== 'string' || !part)) {
            throw new Error(`${where}.password_command must be a program and its arguments, such as ["pass", "show", "mail"].`);
        }
        const folder = account.folder ?? 'INBOX';
        if (typeof folder !== 'string' || !/^[^\r\n"\\]+$/.test(folder)) {
            throw new Error(`${where}.folder must be a mailbox name.`);
        }
        return { name, host: host.trim(), port, username: username.trim(), password_command: command as string[], folder };
    });
}

const ALLOWED_SERVER_FIELDS = new Set(['name', 'enabled', 'transport', 'command', 'args', 'env', 'url', 'headers', 'allowed_tools']);
const TRANSPORT_FIELDS: Record<string, string[]> = {
    stdio: ['command', 'args', 'env'],
    http: ['url', 'headers'],
};

export function validateMcpServers(servers: unknown): McpServerSettings[] {
    if (!Array.isArray(servers)) {
        throw new Error('mcp_servers must be a list.');
    }

    const validated: McpServerSettings[] = [];
    const seenNames = new Set<string>();
    servers.forEach((server: unknown, index) => {
        if (!isObject(server)) {
            throw new Error(`mcp_servers[${index}] must be an object.`);
        }
        const unknownFields = Object.keys(server).filter((key) => !ALLOWED_SERVER_FIELDS.has(key));
        if (unknownFields.length > 0) {
            throw new Error(`Unknown field(s) in mcp_servers[${index}]: ${unknownFields.sort().join(', ')}`);
        }

        const name = server.name;
        if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
            throw new Error(`mcp_servers[${index}].name must be 1-32 letters, numbers, '_' or '-'.`);
        }
        if (seenNames.has(name)) {
            throw new Error(`MCP server names must be unique: ${name}.`);
        }
        seenNames.add(name);

        const enabled = server.enabled ?? true;
        if (typeof enabled !== 'boolean') {
            throw new Error(`MCP server '${name}' enabled must be a boolean.`);
        }
        const transport = server.transport ?? 'stdio';
        if (typeof transport !== 'string' || !(transport in TRANSPORT_FIELDS)) {
            throw new Error(`MCP server '${name}' uses unsupported transport '${String(transport)}'.`);
        }
        const otherFields = Object.entries(TRANSPORT_FIELDS)
            .filter(([kind]) => kind !== transport)
            .flatMap(([, fields]) => fields)
            .filter((field) => field in server);
        if (otherFields.length > 0) {
            throw new Error(`MCP server '${name}' uses ${transport} transport and cannot set: ${otherFields.sort().join(', ')}.`);
        }

        const allowedTools = server.allowed_tools ?? [];
        if (
            !Array.isArray(allowedTools) ||
            allowedTools.some((tool) => typeof tool !== 'string' || !tool) ||
            allowedTools.length !== new Set(allowedTools).size
        ) {
            throw new Error(`MCP server '${name}' allowed_tools must be a unique list of names.`);
        }
        if (enabled && allowedTools.length === 0) {
            throw new Error(`MCP server '${name}' must allow at least one tool when enabled.`);
        }

        if (transport === 'http') {
            validated.push({ name, enabled, transport, ...validateHttpConnection(name, server), allowed_tools: allowedTools as string[] });
        } else {
            validated.push({ name, enabled, transport: 'stdio', ...validateStdioConnection(name, server), allowed_tools: allowedTools as string[] });
        }
    });
    return validated;
}

function validateStdioConnection(name: string, server: Record<string, unknown>): { command: string; args: string[]; env: Record<string, string> } {
    const command = server.command;
    if (typeof command !== 'string' || !command.trim()) {
        throw new Error(`MCP server '${name}' command must be a non-empty string.`);
    }
    const args = server.args ?? [];
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
        throw new Error(`MCP server '${name}' args must be a list of strings.`);
    }
    const env = server.env ?? {};
    if (!isObject(env)) {
        throw new Error(`MCP server '${name}' env must be an object of strings.`);
    }
    for (const [key, value] of Object.entries(env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            throw new Error(`MCP server '${name}' has an invalid environment variable name.`);
        }
        if (typeof value !== 'string') {
            throw new Error(`MCP server '${name}' environment values must be strings.`);
        }
    }
    return { command, args: args as string[], env: env as Record<string, string> };
}

function validateHttpConnection(name: string, server: Record<string, unknown>): { url: string; headers: Record<string, string> } {
    const url = server.url;
    if (typeof url !== 'string' || !/^https?:\/\/[^\s/]+(\/\S*)?$/.test(url)) {
        throw new Error(`MCP server '${name}' url must be an http:// or https:// address.`);
    }
    const headers = server.headers ?? {};
    if (!isObject(headers)) {
        throw new Error(`MCP server '${name}' headers must be an object of strings.`);
    }
    for (const [key, value] of Object.entries(headers)) {
        if (!/^[A-Za-z0-9-]+$/.test(key)) {
            throw new Error(`MCP server '${name}' has an invalid header name.`);
        }
        if (typeof value !== 'string') {
            throw new Error(`MCP server '${name}' header values must be strings.`);
        }
    }
    return { url, headers: headers as Record<string, string> };
}
