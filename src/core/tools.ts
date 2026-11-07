// The built-in tools a model may call: web search and fetch, files under one folder, and the folder's tests.
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { isAbsolute, join, resolve, sep } from 'node:path';

import type { ActionRecord } from './checks.js';
import { configDirectory, INSTRUCTIONS_FILE_NAMES } from './instructions.js';
import type { ToolDefinition } from './model.js';
import { expandUser } from './settings.js';

// ============================================================================
// Limits and definitions
// ============================================================================

export const MAX_FILE_BYTES = 100_000;
export const MAX_TOOL_OUTPUT_CHARS = 12_000;
export const MAX_WEB_PAGE_BYTES = 2_000_000;
export const MAX_WEB_PAGE_CHARS = 100_000;
export const MAX_DIRECTORY_ENTRIES = 100;
export const TEST_TIMEOUT_SECONDS = 120;
export const WEB_FETCH_TIMEOUT_SECONDS = 15;
export const MAX_REDIRECTS = 10;
export const SENSITIVE_NAMES = new Set(['.env', 'credentials', 'id_rsa', 'id_ed25519', 'private_key', 'secrets']);
export const SEARCH_URL = 'https://html.duckduckgo.com/html/';
// The tests are run with this interpreter, found on the PATH.
export const PYTHON_COMMAND = 'python3';

// The project folder that holds the harness's own agents, skills and instructions.
export const HARNESS_FOLDER = '.codex';
export const READ_ONLY_TOOL_NAMES =new Set(['web_search', 'web_fetch', 'list_directory', 'read_file']);
export const ACTION_TOOL_NAMES = new Set(['write_file', 'run_tests']);

export const TOOL_DEFINITIONS: ToolDefinition[] = [
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
            description:
                'Fetch a public webpage and summarize its contents for the request. Use a result URL and provide optional focus criteria for what to extract.',
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
                properties: { path: { type: 'string', description: "Path relative to the filesystem root; omit it or use '.' for the root itself." } },
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
];

export const RUN_TESTS_DEFINITION: ToolDefinition = {
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
};

// A wrong argument or refused request, reported to the model under this name.
export class ValueError extends Error {
    override name = 'ValueError';
}

// ============================================================================
// Reading HTML
// ============================================================================

const NAMED_ENTITIES: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…',
    mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•',
    middot: '·', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', deg: '°', times: '×', divide: '÷', minus: '−',
};

// Turn character references such as &amp; and &#8217; into the characters they name.
export function unescapeHtml(text: string): string {
    return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);?/g, (whole, name: string) => {
        if (name.startsWith('#')) {
            const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
            return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
        }
        return NAMED_ENTITIES[name] ?? NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    });
}

const BLOCK_TAGS = new Set(['article', 'br', 'div', 'footer', 'h1', 'h2', 'h3', 'h4', 'li', 'main', 'p', 'section', 'table', 'td', 'th', 'tr']);
const HIDDEN_TAGS = new Set(['script', 'style', 'noscript', 'svg']);
// The text inside these tags is read as it is, up to the closing tag.
const RAW_TEXT_TAGS = new Set(['script', 'style']);

// Collect a page's readable text and title, skipping scripts, styles and drawings.
class HtmlTextExtractor {
    private readonly textParts: string[] = [];
    private readonly titleParts: string[] = [];
    private hidden = 0;
    private inTitle = false;

    feed(html: string): void {
        const tag = /<(\/?)([A-Za-z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\?[^>]*>/g;
        let position = 0;
        for (let match = tag.exec(html); match !== null; match = tag.exec(html)) {
            this.data(html.slice(position, match.index));
            position = tag.lastIndex;
            if (match[2] === undefined) {
                continue;
            }
            const name = match[2].toLowerCase();
            if (match[1]) {
                this.endTag(name);
                continue;
            }
            this.startTag(name);
            if (match[3].trimEnd().endsWith('/')) {
                this.endTag(name);
            } else if (RAW_TEXT_TAGS.has(name)) {
                const close = new RegExp(`</${name}\\s*>`, 'ig');
                close.lastIndex = position;
                const end = close.exec(html);
                this.data(html.slice(position, end ? end.index : html.length), false);
                if (end) {
                    this.endTag(name);
                    position = close.lastIndex;
                } else {
                    position = html.length;
                }
                tag.lastIndex = position;
            }
        }
        this.data(html.slice(position));
    }

    private startTag(name: string): void {
        if (HIDDEN_TAGS.has(name)) {
            this.hidden += 1;
        }
        if (this.hidden) {
            return;
        }
        if (name === 'title') {
            this.inTitle = true;
        }
        if (BLOCK_TAGS.has(name)) {
            this.textParts.push('\n');
        }
    }

    private endTag(name: string): void {
        if (HIDDEN_TAGS.has(name) && this.hidden) {
            this.hidden -= 1;
        }
        if (this.hidden) {
            return;
        }
        if (name === 'title') {
            this.inTitle = false;
        }
        if (BLOCK_TAGS.has(name)) {
            this.textParts.push('\n');
        }
    }

    private data(raw: string, unescape = true): void {
        if (!raw || this.hidden) {
            return;
        }
        const text = unescape ? unescapeHtml(raw) : raw;
        if (this.inTitle) {
            this.titleParts.push(text);
        }
        this.textParts.push(text);
    }

    extracted(): { title: string; text: string } {
        const words = (text: string) => text.split(/\s+/).filter(Boolean).join(' ');
        const title = words(this.titleParts.join(' '));
        const lines = this.textParts.join('').split(/\r\n|\r|\n/).map(words);
        return { title: Array.from(title).slice(0, 500).join(''), text: lines.filter(Boolean).join('\n') };
    }
}

export function extractHtmlText(html: string): { title: string; text: string } {
    const extractor = new HtmlTextExtractor();
    extractor.feed(html);
    return extractor.extracted();
}

// ============================================================================
// Public addresses
// ============================================================================

const NON_PUBLIC_IPV4 = new BlockList();
for (const [network, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
    ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
    NON_PUBLIC_IPV4.addSubnet(network, prefix, 'ipv4');
}

const NON_PUBLIC_IPV6 = new BlockList();
for (const [network, prefix] of [
    ['::', 128], ['::1', 128], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
    ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) {
    NON_PUBLIC_IPV6.addSubnet(network, prefix, 'ipv6');
}

// Say whether an address is reachable on the public internet, reading an IPv4 address carried inside IPv6 as itself.
export function isPublicAddress(address: string): boolean {
    const family = isIP(address);
    if (family === 4) {
        return !NON_PUBLIC_IPV4.check(address, 'ipv4');
    }
    if (family !== 6) {
        return false;
    }
    const mapped = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(address);
    if (mapped) {
        return isPublicAddress(mapped[1]);
    }
    const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
    if (hexMapped) {
        const high = parseInt(hexMapped[1], 16);
        const low = parseInt(hexMapped[2], 16);
        return isPublicAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return !NON_PUBLIC_IPV6.check(address, 'ipv6');
}

export type HostResolver = (hostname: string) => Promise<string[]>;

async function systemResolver(hostname: string): Promise<string[]> {
    const results = await lookup(hostname, { all: true, verbatim: true });
    return results.map((result) => result.address);
}

// Check that a URL is plain HTTP or HTTPS whose host resolves only to public addresses, and return it without its fragment.
export async function validatePublicWebUrl(url: string, resolveHost: HostResolver = systemResolver): Promise<string> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new ValueError('url must be an absolute public HTTP or HTTPS URL.');
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
    if (!['http:', 'https:'].includes(parsed.protocol) || !hostname) {
        throw new ValueError('url must be an absolute public HTTP or HTTPS URL.');
    }
    if (parsed.username || parsed.password) {
        throw new ValueError('URLs with embedded credentials are not allowed.');
    }
    let addresses: string[];
    try {
        addresses = isIP(hostname) ? [hostname] : await resolveHost(hostname);
    } catch {
        throw new ValueError('the webpage host could not be resolved.');
    }
    if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
        throw new ValueError('webpage hosts must resolve only to public IP addresses.');
    }
    return `${parsed.protocol}//${parsed.host}${parsed.pathname || '/'}${parsed.search}`;
}

// ============================================================================
// Paths
// ============================================================================

function lstatOrNull(path: string): Stats | null {
    try {
        return lstatSync(path);
    } catch {
        return null;
    }
}

function statOrNull(path: string): Stats | null {
    try {
        return statSync(path);
    } catch {
        return null;
    }
}

// Resolve a path one part at a time, following each link that exists, and keep the missing rest as written.
export function resolvePath(path: string): string {
    const parts = resolve(path).split(sep).filter(Boolean);
    let current: string = sep;
    for (let index = 0; index < parts.length; index++) {
        const candidate = join(current, parts[index]);
        const stats = lstatOrNull(candidate);
        if (stats === null) {
            return resolve(candidate, ...parts.slice(index + 1));
        }
        current = stats.isSymbolicLink() ? realpathOrSelf(candidate) : candidate;
    }
    return current;
}

function realpathOrSelf(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

function suffix(name: string): string {
    const dot = name.lastIndexOf('.');
    return dot > 0 && dot < name.length - 1 ? name.slice(dot) : '';
}

// Say whether any part of a path looks like a credential or secret file.
export function isSensitivePath(path: string): boolean {
    for (const part of path.split(sep).filter(Boolean)) {
        const name = part.toLowerCase();
        if (SENSITIVE_NAMES.has(name) || name.startsWith('credentials.')) {
            return true;
        }
        if (name.startsWith('.env.') && name !== '.env.example') {
            return true;
        }
        if (['.pem', '.key', '.p12', '.pfx'].includes(suffix(name))) {
            return true;
        }
    }
    return false;
}

function rejectSensitivePath(path: string): void {
    if (isSensitivePath(path)) {
        throw new ValueError('access to likely credential or secret files is blocked.');
    }
}

// Say whether a path holds the harness's own configuration: the `.codex` folder, a standing-instructions
// file, or anything under the user's config folder. What is written there loads into every later call.
export function isHarnessPath(path: string): boolean {
    const parts = path.split(sep).filter(Boolean);
    if (parts.includes(HARNESS_FOLDER) || (INSTRUCTIONS_FILE_NAMES as readonly string[]).includes(parts[parts.length - 1] ?? '')) {
        return true;
    }
    const config = resolvePath(configDirectory());
    return path === config || path.startsWith(config + sep);
}

function rejectHarnessPath(path: string): void {
    if (isHarnessPath(path)) {
        throw new ValueError("writing the harness's own agents, skills, commands or instructions is blocked; edit them by hand.");
    }
}

function checkArguments(argumentsGiven: Record<string, unknown>, required: string[], optional: string[]): void {
    const keys = Object.keys(argumentsGiven);
    const missing = required.filter((key) => !keys.includes(key)).sort();
    const unknown = keys.filter((key) => !required.includes(key) && !optional.includes(key)).sort();
    if (missing.length > 0) {
        throw new ValueError(`missing argument(s): ${missing.join(', ')}.`);
    }
    if (unknown.length > 0) {
        throw new ValueError(`unknown argument(s): ${unknown.join(', ')}.`);
    }
}

// ============================================================================
// Toolbox
// ============================================================================

export type SearchResult = { title: string; url: string; snippet: string };
export type WebPage = { url: string; title: string; text: string; truncated: boolean };

export type ToolboxOptions = {
    maxSearchResults?: number;
    enableTestExecution?: boolean;
    allowFileWrites?: boolean;
    searchCallback?: ((query: string, results: SearchResult[]) => void) | null;
    // These replace the network for tests.
    fetch?: typeof fetch;
    resolveHost?: HostResolver;
};

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class Toolbox {
    readonly root: string;
    readonly maxSearchResults: number;
    readonly enableTestExecution: boolean;
    readonly allowFileWrites: boolean;
    readonly searchCallback: ((query: string, results: SearchResult[]) => void) | null;
    readonly usedTools = new Set<string>();
    readonly actionLog: ActionRecord[] = [];
    // Every path a file tool really opened, so what a run saw of the machine can be learned from it.
    readonly pathsSeen: string[] = [];
    readonly toolDefinitions: ToolDefinition[];
    private readonly fetchPage: typeof fetch;
    private readonly resolveHost: HostResolver;

    constructor(filesystemRoot: string, options: ToolboxOptions = {}) {
        this.root = resolvePath(expandUser(filesystemRoot));
        if (!statOrNull(this.root)?.isDirectory()) {
            throw new ValueError(`Filesystem root is not a directory: ${this.root}`);
        }
        const maxSearchResults = options.maxSearchResults ?? 5;
        if (typeof maxSearchResults !== 'number' || !Number.isInteger(maxSearchResults) || maxSearchResults < 1 || maxSearchResults > 10) {
            throw new ValueError('max_search_results must be between 1 and 10.');
        }
        const enableTestExecution = options.enableTestExecution ?? false;
        if (typeof enableTestExecution !== 'boolean') {
            throw new ValueError('enable_test_execution must be a boolean.');
        }
        const allowFileWrites = options.allowFileWrites ?? false;
        if (typeof allowFileWrites !== 'boolean') {
            throw new ValueError('allow_file_writes must be a boolean.');
        }
        this.maxSearchResults = maxSearchResults;
        this.enableTestExecution = enableTestExecution;
        this.allowFileWrites = allowFileWrites;
        this.searchCallback = options.searchCallback ?? null;
        this.fetchPage = options.fetch ?? globalThis.fetch;
        this.resolveHost = options.resolveHost ?? systemResolver;
        this.toolDefinitions = TOOL_DEFINITIONS.filter((definition) => allowFileWrites || READ_ONLY_TOOL_NAMES.has(definition.function.name));
        if (enableTestExecution) {
            this.toolDefinitions.push(RUN_TESTS_DEFINITION);
        }
    }

    async call(name: string, argumentsGiven: unknown): Promise<string> {
        const result = await this.callTool(name, argumentsGiven);
        if (ACTION_TOOL_NAMES.has(name)) {
            // A task that acts has its report checked against this record of what really changed.
            const recorded = isObject(argumentsGiven) ? Object.fromEntries(Object.entries(argumentsGiven).filter(([key]) => key !== 'content')) : {};
            this.actionLog.push([name, recorded, result]);
        }
        return result;
    }

    private async callTool(name: string, argumentsGiven: unknown): Promise<string> {
        if (!isObject(argumentsGiven)) {
            return 'Tool error: arguments must be a JSON object.';
        }
        const handlers: Record<string, (argumentsGiven: Record<string, unknown>) => Promise<unknown> | unknown> = {
            web_search: (given) => this.webSearch(given),
            web_fetch: (given) => this.webFetch(given),
            list_directory: (given) => this.listDirectory(given),
            read_file: (given) => this.readFile(given),
            write_file: (given) => this.writeFile(given),
        };
        let handler = Object.hasOwn(handlers, name) ? handlers[name] : undefined;
        if (name === 'write_file' && !this.allowFileWrites) {
            return 'Tool error: file access is read-only; writing files is disabled in the settings.';
        }
        if (name === 'run_tests' && this.enableTestExecution) {
            handler = (given) => this.runTests(given);
        }
        if (handler === undefined) {
            return `Tool error: unknown tool '${name}'.`;
        }
        let result: unknown;
        try {
            result = await handler(argumentsGiven);
        } catch (error) {
            const kind = error instanceof Error ? error.name : 'Error';
            const message = error instanceof Error ? error.message : String(error);
            return `Tool error: ${kind}: ${message}`.slice(0, MAX_TOOL_OUTPUT_CHARS);
        }
        const text = typeof result === 'string' ? result : JSON.stringify(result);
        if (!text.startsWith('Tool error:')) {
            this.usedTools.add(name);
            if (name === 'list_directory' || name === 'read_file' || name === 'write_file') {
                const path = this.resolveInsideRoot(argumentsGiven.path ?? '.');
                if (!this.pathsSeen.includes(path)) {
                    this.pathsSeen.push(path);
                }
            }
        }
        // Page JSON is already bounded by the fetch limits and must stay whole for the summarizer to parse it.
        if (name === 'web_fetch') {
            return text;
        }
        return text.slice(0, MAX_TOOL_OUTPUT_CHARS);
    }

    // ------------------------------------------------------------------------
    // Web
    // ------------------------------------------------------------------------

    private async webSearch(argumentsGiven: Record<string, unknown>): Promise<string> {
        checkArguments(argumentsGiven, ['query'], ['max_results']);
        const query = argumentsGiven.query;
        if (typeof query !== 'string' || !query.trim()) {
            throw new ValueError('query must be a non-empty string.');
        }
        const requested = argumentsGiven.max_results ?? this.maxSearchResults;
        if (typeof requested !== 'number' || !Number.isInteger(requested) || requested < 1 || requested > 10) {
            throw new ValueError('max_results must be an integer from 1 to 10.');
        }

        const results = await this.searchDuckDuckGo(query.trim(), Math.min(requested, this.maxSearchResults));
        const formatted = results.map((result) => ({ ...result, snippet: result.snippet.slice(0, 1500) }));
        this.searchCallback?.(query.trim(), formatted);
        return JSON.stringify(formatted);
    }

    // Ask DuckDuckGo's HTML page for results and read the titles, addresses and snippets from it.
    private async searchDuckDuckGo(query: string, maxResults: number): Promise<SearchResult[]> {
        const response = await this.fetchPage(SEARCH_URL, {
            method: 'POST',
            headers: {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'text/html',
            },
            body: new URLSearchParams({ q: query, kl: 'wt-wt' }).toString(),
            signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_SECONDS * 1000),
        });
        if (!response.ok) {
            throw new Error(`Web search failed: DuckDuckGo answered with HTTP ${response.status}.`);
        }
        return parseSearchResults(await response.text()).slice(0, maxResults);
    }

    private async webFetch(argumentsGiven: Record<string, unknown>): Promise<WebPage & { focus: string }> {
        checkArguments(argumentsGiven, ['url'], ['focus']);
        const url = argumentsGiven.url;
        const focus = argumentsGiven.focus ?? '';
        if (typeof url !== 'string' || !url.trim()) {
            throw new ValueError('url must be a non-empty HTTP or HTTPS URL.');
        }
        if (typeof focus !== 'string' || focus.length > 500) {
            throw new ValueError('focus must be a string of at most 500 characters.');
        }
        return { ...(await this.downloadWebPage(url.trim())), focus };
    }

    // Fetch a page, checking every address it redirects to, and keep its readable text within the limits.
    private async downloadWebPage(url: string): Promise<WebPage> {
        const signal = AbortSignal.timeout(WEB_FETCH_TIMEOUT_SECONDS * 1000);
        let current = await validatePublicWebUrl(url, this.resolveHost);
        let response: Response;
        for (let redirects = 0; ; redirects++) {
            response = await this.fetchPage(current, {
                headers: {
                    'User-Agent': 'CODEX/0.1 (+read-only research)',
                    Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
                    'Accept-Encoding': 'identity',
                },
                redirect: 'manual',
                signal,
            });
            const location = response.headers.get('location');
            if (![301, 302, 303, 307, 308].includes(response.status) || location === null) {
                break;
            }
            await response.body?.cancel();
            if (redirects >= MAX_REDIRECTS) {
                throw new Error('the webpage redirected too many times.');
            }
            current = await validatePublicWebUrl(new URL(location, current).href, this.resolveHost);
        }
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
        }

        const [mediaType, ...parameters] = (response.headers.get('content-type') ?? 'text/plain').split(';');
        const contentType = mediaType.trim().toLowerCase() || 'text/plain';
        if (!['text/html', 'application/xhtml+xml', 'text/plain'].includes(contentType)) {
            await response.body?.cancel();
            throw new ValueError(`unsupported webpage content type: ${contentType}.`);
        }
        const charsetParameter = parameters.map((parameter) => parameter.trim()).find((parameter) => parameter.toLowerCase().startsWith('charset='));
        const charset = charsetParameter ? charsetParameter.slice('charset='.length).replace(/^["']|["']$/g, '').toLowerCase() : 'utf-8';
        const raw = await readAtMost(response, MAX_WEB_PAGE_BYTES + 1);
        let truncated = raw.length > MAX_WEB_PAGE_BYTES;
        const pageContent = new TextDecoder(charset || 'utf-8').decode(raw.subarray(0, MAX_WEB_PAGE_BYTES));

        let title = '';
        let text = pageContent;
        if (contentType !== 'text/plain') {
            ({ title, text } = extractHtmlText(pageContent));
        }
        if (text.length > MAX_WEB_PAGE_CHARS) {
            text = text.slice(0, MAX_WEB_PAGE_CHARS);
            truncated = true;
        }
        if (truncated) {
            text += '\n[Page text truncated at the configured fetch limit.]';
        }
        return { url: current, title, text, truncated };
    }

    // ------------------------------------------------------------------------
    // Files
    // ------------------------------------------------------------------------

    private resolveInsideRoot(requestedPath: unknown): string {
        if (typeof requestedPath !== 'string') {
            throw new ValueError('path must be a string.');
        }
        // An absolute path is only accepted when it already points inside the root.
        const requested = expandUser(requestedPath.trim() || '.');
        const resolved = resolvePath(isAbsolute(requested) ? requested : join(this.root, requested));
        const inside = resolved === this.root || resolved.startsWith(this.root.endsWith(sep) ? this.root : this.root + sep);
        if (!inside) {
            throw new ValueError(`path escapes the configured filesystem root (${this.root}); use a path relative to it.`);
        }
        return resolved;
    }

    private listDirectory(argumentsGiven: Record<string, unknown>): string {
        checkArguments(argumentsGiven, [], ['path']);
        const directory = this.resolveInsideRoot(argumentsGiven.path ?? '.');
        rejectSensitivePath(directory);
        if (!statOrNull(directory)?.isDirectory()) {
            throw new ValueError('path is not a directory.');
        }
        const entries: Array<{ name: string; type: string }> = [];
        for (const name of readdirSync(directory).sort().slice(0, MAX_DIRECTORY_ENTRIES)) {
            const entry = join(directory, name);
            // The harness reads its own folder itself; listed, its agent and skill files pass for the user's notes.
            if (isSensitivePath(entry) || name === HARNESS_FOLDER) {
                continue;
            }
            const link = lstatOrNull(entry);
            const stats = statOrNull(entry);
            let type = 'other';
            if (link?.isSymbolicLink()) {
                type = 'symlink';
            } else if (stats?.isDirectory()) {
                type = 'directory';
            } else if (stats?.isFile()) {
                type = 'file';
            }
            entries.push({ name, type });
        }
        return JSON.stringify(entries);
    }

    private readFile(argumentsGiven: Record<string, unknown>): string {
        checkArguments(argumentsGiven, ['path'], []);
        const path = this.resolveInsideRoot(argumentsGiven.path);
        rejectSensitivePath(path);
        const stats = statOrNull(path);
        if (stats?.isDirectory()) {
            throw new ValueError('path is a directory; use list_directory to see its entries.');
        }
        if (!stats?.isFile()) {
            throw new ValueError('path is not a file.');
        }
        if (stats.size > MAX_FILE_BYTES) {
            throw new ValueError(`file exceeds the ${MAX_FILE_BYTES}-byte read limit.`);
        }
        const content = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
        if (content.length > MAX_TOOL_OUTPUT_CHARS) {
            return content.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n[Output truncated]';
        }
        return content;
    }

    private writeFile(argumentsGiven: Record<string, unknown>): string {
        checkArguments(argumentsGiven, ['path', 'content'], []);
        let path = this.resolveInsideRoot(argumentsGiven.path);
        rejectSensitivePath(path);
        rejectHarnessPath(path);
        if (statOrNull(path)?.isDirectory()) {
            throw new ValueError('path is a directory; give a file path to write.');
        }
        const content = argumentsGiven.content;
        if (typeof content !== 'string') {
            throw new ValueError('content must be a string.');
        }
        const size = Buffer.byteLength(content, 'utf-8');
        if (size > MAX_FILE_BYTES) {
            throw new ValueError(`file exceeds the ${MAX_FILE_BYTES}-byte write limit.`);
        }
        mkdirSync(resolve(path, '..'), { recursive: true });
        // The path is resolved again, so a link made among the new folders cannot lead outside the root.
        path = this.resolveInsideRoot(argumentsGiven.path);
        writeFileSync(path, content, 'utf-8');
        return `Wrote ${size} bytes to ${String(argumentsGiven.path)}.`;
    }

    // ------------------------------------------------------------------------
    // Tests
    // ------------------------------------------------------------------------

    private async runTests(argumentsGiven: Record<string, unknown>): Promise<string> {
        checkArguments(argumentsGiven, [], []);
        const testsFolder = join(this.root, 'tests');
        const startDirectory = statOrNull(testsFolder)?.isDirectory() ? testsFolder : this.root;
        const run = await runProcess(PYTHON_COMMAND, ['-m', 'unittest', 'discover', '-s', startDirectory], this.root, TEST_TIMEOUT_SECONDS * 1000);
        if (run.timedOut) {
            return `Tests timed out after ${TEST_TIMEOUT_SECONDS} seconds.\n${run.stdout}`.slice(0, MAX_TOOL_OUTPUT_CHARS);
        }
        const output = [run.stdout, run.stderr].filter(Boolean).join('\n');
        const status = run.exitCode === 0 ? 'passed' : `failed (exit ${run.exitCode})`;
        return `Tests ${status}.\n${output}`.slice(0, MAX_TOOL_OUTPUT_CHARS);
    }
}

// ============================================================================
// Helpers
// ============================================================================

// Read a response body, stopping once it holds more than the limit.
async function readAtMost(response: Response, limit: number): Promise<Uint8Array> {
    if (response.body === null) {
        return new Uint8Array();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < limit) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        chunks.push(value);
        size += value.length;
    }
    await reader.cancel();
    return Buffer.concat(chunks).subarray(0, limit);
}

type ProcessRun = { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean };

function runProcess(command: string, args: string[], cwd: string, timeoutMilliseconds: number): Promise<ProcessRun> {
    return new Promise((resolveRun, rejectRun) => {
        const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeoutMilliseconds);
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
        child.on('error', (error) => {
            clearTimeout(timer);
            rejectRun(error);
        });
        child.on('close', (exitCode) => {
            clearTimeout(timer);
            resolveRun({
                stdout: Buffer.concat(stdout).toString('utf-8'),
                stderr: Buffer.concat(stderr).toString('utf-8'),
                exitCode,
                timedOut,
            });
        });
    });
}

function attribute(attributes: string, name: string): string | null {
    const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attributes);
    return match ? unescapeHtml(match[1] ?? match[2] ?? match[3]) : null;
}

function plainText(html: string): string {
    return unescapeHtml(html.replace(/<[^>]*>/g, ''))
        .split(/\s+/)
        .filter(Boolean)
        .join(' ');
}

// Read the target address from a DuckDuckGo result link, which wraps it in a redirect.
function resultUrl(href: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(href, 'https://duckduckgo.com');
    } catch {
        return null;
    }
    if (parsed.hostname.endsWith('duckduckgo.com')) {
        const target = parsed.searchParams.get('uddg');
        // A link to DuckDuckGo itself without a target is an advert.
        return target && /^https?:\/\//.test(target) ? target : null;
    }
    return /^https?:$/.test(parsed.protocol) ? parsed.href : null;
}

// Read the results from DuckDuckGo's HTML page.
export function parseSearchResults(html: string): SearchResult[] {
    const results: SearchResult[] = [];
    let current: SearchResult | null = null;
    for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
        const classes = (attribute(match[1], 'class') ?? '').split(/\s+/);
        if (classes.includes('result__a')) {
            const url = resultUrl(attribute(match[1], 'href') ?? '');
            current = url ? { title: plainText(match[2]), url, snippet: '' } : null;
            if (current) {
                results.push(current);
            }
        } else if (classes.includes('result__snippet') && current && !current.snippet) {
            current.snippet = plainText(match[2]);
        }
    }
    return results;
}
