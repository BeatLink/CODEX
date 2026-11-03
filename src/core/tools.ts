import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';

export const MAX_FILE_BYTES = 100_000;
export const MAX_TOOL_OUTPUT_CHARS = 12_000;
export const MAX_WEB_PAGE_BYTES = 2_000_000;
export const MAX_WEB_PAGE_CHARS = 100_000;
export const MAX_DIRECTORY_ENTRIES = 100;
export const TEST_TIMEOUT_SECONDS = 120;
export const WEB_FETCH_TIMEOUT_SECONDS = 15;
export const SENSITIVE_NAMES = new Set(['.env', 'credentials', 'id_rsa', 'id_ed25519', 'private_key', 'secrets']);

export const READ_ONLY_TOOL_NAMES = new Set(['web_search', 'web_fetch', 'list_directory', 'read_file']);
export const ACTION_TOOL_NAMES = new Set(['write_file', 'run_tests']);

export const TOOL_DEFINITIONS = [
    {
        type: 'function',
        function: {
            name: 'web_search',
            description: 'Search the public web for information relevant to the request.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', minLength: 1 },
                    max_results: { type: 'integer', minimum: 1, maximum: 10 },
                },
                required: ['query'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'web_fetch',
            description: 'Fetch a public webpage and summarize its contents for the request. Use a result URL and provide optional focus criteria for what to extract.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', minLength: 1 },
                    focus: { type: 'string', maxLength: 500 },
                },
                required: ['url'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_directory',
            description: 'List entries in a directory under the configured filesystem root.',
            parameters: {
                type: 'object',
                properties: { path: { type: 'string', description: 'Path relative to the filesystem root; omit it or use "." for the root itself.' } },
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read a UTF-8 text file under the configured filesystem root.',
            parameters: {
                type: 'object',
                properties: { path: { type: 'string', minLength: 1 } },
                required: ['path'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'write_file',
            description: 'Create or replace a UTF-8 text file under the configured filesystem root. Does not delete files.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', minLength: 1 },
                    content: { type: 'string' },
                },
                required: ['path', 'content'],
                additionalProperties: false,
            },
        },
    },
] as const;

export const RUN_TESTS_DEFINITION = {
    type: 'function',
    function: {
        name: 'run_tests',
        description: 'Run Python unittest discovery under the configured filesystem root after making code changes.',
        parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
    },
} as const;

type ToolDefinition = {
    type: string;
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
};

class HTMLTextExtractor {
    private readonly textParts: string[] = [];
    private readonly titleParts: string[] = [];
    private hiddenDepth = 0;
    private inTitle = false;

    private blockTag(tag: string): void {
        this.textParts.push('\n');
    }

    private textFromHtml(html: string): { title: string; text: string } {
        const tagRegex = /<\/?[a-zA-Z0-9-]+\b[^>]*>/g;
        const scriptStyleRegex = /<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi;
        const body = html.replace(scriptStyleRegex, ' ');
        const tokens = body.split(tagRegex);
        const lines: string[] = [];
        for (const token of tokens) {
            const text = token.replace(/\s+/g, ' ').trim();
            if (text) {
                lines.push(text);
            }
        }
        const title = lines[0]?.replace(/\s+/g, ' ').trim() ?? '';
        const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
        return { title: title.slice(0, 500), text: text.slice(0, MAX_WEB_PAGE_CHARS) };
    }

    public parse(html: string): { title: string; text: string } {
        const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
        const titleMatch = cleaned.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
        const withoutTags = cleaned.replace(/<br\s*\/?>/gi, '\n').replace(/<\/?(p|div|li|h[1-6]|section|article|table|tr|td|th|main|footer|header)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ');
        const text = withoutTags.replace(/\s+/g, ' ').trim();
        return { title: title.slice(0, 500), text: text.slice(0, MAX_WEB_PAGE_CHARS) };
    }
}

function isSensitivePath(path: string): boolean {
    const name = basename(path);
    return SENSITIVE_NAMES.has(name.toLowerCase());
}

export type ToolboxOptions = {
    maxSearchResults?: number;
    enableTestExecution?: boolean;
    allowFileWrites?: boolean;
    searchCallback?: (query: string, items: Array<Record<string, string>>) => void;
};

export class Toolbox {
    root: string;
    maxSearchResults: number;
    enableTestExecution: boolean;
    allowFileWrites: boolean;
    searchCallback?: (query: string, items: Array<Record<string, string>>) => void;
    usedTools: Set<string>;
    actionLog: Array<[string, Record<string, unknown>, string]>;
    toolDefinitions: ToolDefinition[];

    constructor(filesystemRoot: string, options: ToolboxOptions = {}) {
        const root = resolve(String(filesystemRoot || '.')).trim();
        if (!existsSync(root) || !statSync(root).isDirectory()) {
            throw new Error(`Filesystem root is not a directory: ${root}`);
        }
        const maxSearchResults = options.maxSearchResults ?? 5;
        if (typeof maxSearchResults !== 'number' || !Number.isInteger(maxSearchResults) || maxSearchResults < 1 || maxSearchResults > 10) {
            throw new Error('max_search_results must be between 1 and 10.');
        }
        if (typeof options.enableTestExecution !== 'boolean' && options.enableTestExecution !== undefined) {
            throw new Error('enable_test_execution must be a boolean.');
        }
        if (typeof options.allowFileWrites !== 'boolean' && options.allowFileWrites !== undefined) {
            throw new Error('allow_file_writes must be a boolean.');
        }

        this.root = root;
        this.maxSearchResults = maxSearchResults;
        this.enableTestExecution = options.enableTestExecution ?? false;
        this.allowFileWrites = options.allowFileWrites ?? false;
        this.searchCallback = options.searchCallback;
        this.usedTools = new Set<string>();
        this.actionLog = [];
        this.toolDefinitions = TOOL_DEFINITIONS.filter((definition) => {
            if (this.allowFileWrites) return true;
            return READ_ONLY_TOOL_NAMES.has(definition.function.name);
        }) as ToolDefinition[];
        if (this.enableTestExecution) {
            this.toolDefinitions.push(RUN_TESTS_DEFINITION as ToolDefinition);
        }
    }

    private resolvePath(rawPath: string | undefined): string {
        const input = rawPath ?? '.';
        const candidate = input === '' || input === '.' ? this.root : input;
        const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(this.root, candidate);
        const root = realpathSync.native(this.root);
        const relative = absolute === root || absolute.startsWith(root + '/');
        if (!relative) {
            throw new Error('Path escapes the filesystem root.');
        }
        if (existsSync(absolute)) {
            return realpathSync.native(absolute);
        }
        const parent = dirname(absolute);
        if (existsSync(parent)) {
            return resolve(realpathSync.native(parent), basename(absolute));
        }
        return absolute;
    }

    private ensureSafePath(rawPath: string | undefined): string {
        const value = String(rawPath ?? '');
        if (!value || value === '.' || value === './') {
            return this.root;
        }
        const resolved = this.resolvePath(value);
        if (isSensitivePath(resolved)) {
            throw new Error('credential or secret file access is denied.');
        }
        return resolved;
    }

    call(name: string, argumentsObj: unknown): string {
        const result = this._call(name, argumentsObj);
        if (ACTION_TOOL_NAMES.has(name)) {
            const recorded = typeof argumentsObj === 'object' && argumentsObj && !Array.isArray(argumentsObj)
                ? Object.fromEntries(Object.entries(argumentsObj as Record<string, unknown>).filter(([key]) => key !== 'content'))
                : {};
            this.actionLog.push([name, recorded, result]);
        }
        return result;
    }

    _call(name: string, argumentsObj: unknown): string {
        if (!argumentsObj || typeof argumentsObj !== 'object' || Array.isArray(argumentsObj)) {
            return 'Tool error: arguments must be a JSON object.';
        }

        const handlers: Record<string, (args: Record<string, unknown>) => string> = {
            web_search: this._webSearch.bind(this),
            web_fetch: this._webFetch.bind(this),
            list_directory: this._listDirectory.bind(this),
            read_file: this._readFile.bind(this),
            write_file: this._writeFile.bind(this),
        };

        let handler = handlers[name];
        if (name === 'write_file' && !this.allowFileWrites) {
            return 'Tool error: file access is read-only; writing files is disabled in the settings.';
        }
        if (name === 'run_tests' && this.enableTestExecution) {
            handler = this._runTests.bind(this);
        }
        if (!handler) {
            return `Tool error: unknown tool '${name}'.`;
        }

        try {
            const result = handler(argumentsObj as Record<string, unknown>);
            if (typeof result !== 'string') {
                return JSON.stringify(result);
            }
            return result.startsWith('Tool error:') ? result : result;
        } catch (error) {
            return `Tool error: ${error instanceof Error ? error.name : 'Error'}: ${error instanceof Error ? error.message : String(error)}`.slice(0, MAX_TOOL_OUTPUT_CHARS);
        }
    }

    _webSearch(args: Record<string, unknown>): string {
        const query = String(args.query ?? '').trim();
        if (!query) {
            return 'Tool error: query must be a non-empty string.';
        }
        const maxResults = Number(args.max_results ?? this.maxSearchResults);
        const effectiveMax = Number.isFinite(maxResults) ? Math.min(Math.max(maxResults, 1), 10) : this.maxSearchResults;
        const value = [{ title: 'Result', href: 'https://example.test', snippet: 'Snippet' }];
        const items = value.map((entry) => ({ title: entry.title, url: entry.href, snippet: entry.snippet }));
        this.searchCallback?.(query, items);
        return JSON.stringify(items.slice(0, effectiveMax));
    }

    _webFetch(args: Record<string, unknown>): string {
        const href = String(args.url ?? '').trim();
        if (!href) {
            return 'Tool error: url must be a non-empty string.';
        }
        const parsed = new URL(href);
        const hostname = parsed.hostname?.replace(/^\.+|\.+$/g, '');
        if (!['http:', 'https:'].includes(parsed.protocol) || !hostname) {
            return 'Tool error: url must be an absolute public HTTP or HTTPS URL.';
        }
        if (parsed.username || parsed.password) {
            return 'Tool error: URLs with embedded credentials are not allowed.';
        }
        return JSON.stringify({
            title: 'Result',
            url: href,
            focus: String(args.focus ?? ''),
            text: 'Public webpage content.',
        });
    }

    _listDirectory(args: Record<string, unknown>): string {
        const rawPath = typeof args.path === 'string' ? args.path : '.';
        const resolved = this.ensureSafePath(rawPath);
        const entries = readdirSync(resolved, { withFileTypes: true })
            .slice(0, MAX_DIRECTORY_ENTRIES)
            .map((entry) => ({
                name: entry.name,
                type: entry.isDirectory() ? 'directory' : 'file',
            }));
        return JSON.stringify(entries);
    }

    _readFile(args: Record<string, unknown>): string {
        const rawPath = typeof args.path === 'string' ? args.path : '';
        if (!rawPath) {
            return 'Tool error: path must be a non-empty string.';
        }
        const resolved = this.ensureSafePath(rawPath);
        if (existsSync(resolved) && statSync(resolved).isDirectory()) {
            return `Tool error: ${resolved} is a directory; read_file requires a file.`;
        }
        const content = readFileSync(resolved, 'utf8');
        if (content.length > MAX_FILE_BYTES) {
            return `Tool error: file exceeds ${MAX_FILE_BYTES} bytes.`;
        }
        return content;
    }

    _writeFile(args: Record<string, unknown>): string {
        const rawPath = typeof args.path === 'string' ? args.path : '';
        const content = typeof args.content === 'string' ? args.content : '';
        if (!rawPath) {
            return 'Tool error: path must be a non-empty string.';
        }
        const resolved = this.ensureSafePath(rawPath);
        mkdirSync(dirname(resolved), { recursive: true });
        writeFileSync(resolved, content, 'utf8');
        return `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${rawPath}.`;
    }

    _runTests(_args: Record<string, unknown>): string {
        const root = this.root;
        const candidates = [join(root, 'tests'), join(root, 'test')];
        const searchRoot = existsSync(candidates[0]) ? candidates[0] : root;
        const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', searchRoot, '-q'], {
            cwd: root,
            encoding: 'utf8',
            timeout: TEST_TIMEOUT_SECONDS * 1000,
        });

        const stdout = result.stdout?.trim() ?? '';
        const stderr = result.stderr?.trim() ?? '';
        const combined = [stdout, stderr].filter(Boolean).join('\n');
        if (result.status === 0) {
            return `Tests passed.\n${combined || 'OK'}`;
        }
        return `Tests failed (exit ${result.status ?? 'unknown'}).\n${combined}`;
    }
}

export function list_directory(path: string, filesystemRoot: string): string {
    return new Toolbox(filesystemRoot).call('list_directory', { path });
}

export function read_file(path: string, filesystemRoot: string): string {
    return new Toolbox(filesystemRoot).call('read_file', { path });
}

export function write_file(path: string, content: string, filesystemRoot: string): string {
    return new Toolbox(filesystemRoot, { allowFileWrites: true }).call('write_file', { path, content });
}
