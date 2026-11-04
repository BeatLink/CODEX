import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { MCPToolbox, functionName } from './mcpTools.js';
import type { ChatCompletion, ChatCompletionRequest, ChatModel } from './model.js';
import type { HttpServerSettings, StdioServerSettings } from './settings.js';
import { runToolStage } from './toolStage.js';
import { Toolbox } from './tools.js';

// ============================================================================
// Test servers
// ============================================================================

const TOOLS = [
    { name: 'lookup', description: 'Look up a document', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'delete_all', description: 'Not allowed', inputSchema: { type: 'object', properties: {} } },
];

// The stdio server writes its process number to a file, so a test can see that closing stopped it.
function stdioServerScript(): string {
    const sdk = (path: string) => JSON.stringify(import.meta.resolve(`@modelcontextprotocol/sdk/${path}`));
    return `
import { writeFileSync } from 'node:fs';
import { Server } from ${sdk('server/index.js')};
import { StdioServerTransport } from ${sdk('server/stdio.js')};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${sdk('types.js')};

writeFileSync(process.argv[2], String(process.pid));
const server = new Server({ name: 'docs', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ${JSON.stringify(TOOLS)} }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const query = request.params.arguments?.query;
    if (query === 'environment') {
        return { content: [{ type: 'text', text: JSON.stringify({ token: process.env.DOCS_TOKEN ?? null, leaked: 'UNRELATED_VARIABLE' in process.env }) }] };
    }
    if (query === 'broken') {
        return { isError: true, content: [{ type: 'text', text: 'no such document' }] };
    }
    if (query === 'picture') {
        return { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] };
    }
    return { content: [{ type: 'text', text: 'document result' }] };
});
await server.connect(new StdioServerTransport());
`;
}

let folder: string;
let scriptPath: string;
let httpServer: HttpServer;
let httpUrl: string;
const seenHeaders: IncomingHttpHeaders[] = [];

beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'codex-mcp-'));
    scriptPath = join(folder, 'server.mjs');
    writeFileSync(scriptPath, stdioServerScript());

    httpServer = createServer(async (request, response) => {
        seenHeaders.push(request.headers);
        const server = new Server({ name: 'trilium', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
        server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'document result' }] }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        response.on('close', () => void transport.close());
        await server.connect(transport);
        await transport.handleRequest(request, response);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    httpUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
    await new Promise((resolve) => httpServer.close(resolve));
    rmSync(folder, { recursive: true, force: true });
});

const savedVariables = { token: process.env.CODEX_TEST_TOKEN, unrelated: process.env.UNRELATED_VARIABLE };

afterEach(() => {
    for (const [name, value] of [
        ['CODEX_TEST_TOKEN', savedVariables.token],
        ['UNRELATED_VARIABLE', savedVariables.unrelated],
    ] as const) {
        if (value === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = value;
        }
    }
});

function stdioConfig(overrides: Partial<StdioServerSettings> = {}): StdioServerSettings {
    const pidFile = join(folder, `pid-${Math.random().toString(36).slice(2)}`);
    return {
        name: 'docs',
        enabled: true,
        transport: 'stdio',
        command: process.execPath,
        args: [scriptPath, pidFile],
        env: {},
        allowed_tools: ['lookup'],
        ...overrides,
    };
}

function isRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function stopped(pid: number): Promise<boolean> {
    for (let attempt = 0; attempt < 50 && isRunning(pid); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return !isRunning(pid);
}

// ============================================================================
// Toolbox
// ============================================================================

describe('mcp toolbox', () => {
    it('offers only the allowed tools, routes calls and stops the server on close', async () => {
        const config = stdioConfig();
        const toolbox = await new MCPToolbox([config]).open();

        try {
            expect(toolbox.toolDefinitions).toEqual([
                { type: 'function', function: { name: 'mcp__docs__lookup', description: 'Look up a document', parameters: TOOLS[0].inputSchema } },
            ]);
            expect(JSON.stringify(toolbox.toolDefinitions)).not.toContain('delete_all');
            expect(toolbox.handles('mcp__docs__lookup')).toBe(true);
            expect(await toolbox.call('mcp__docs__lookup', { query: 'quick start' })).toBe('document result');
            expect(await toolbox.call('mcp__docs__broken', {})).toBe("Tool error: unknown MCP tool 'mcp__docs__broken'.");
            expect(await toolbox.call('mcp__docs__lookup', { query: 'broken' })).toBe('MCP tool error: no such document');
            expect(await toolbox.call('mcp__docs__lookup', { query: 'picture' })).toBe('[Non-text MCP result omitted: image]');
        } finally {
            await toolbox.close();
        }

        const pid = Number(readFileSync(config.args[1], 'utf-8'));
        expect(await stopped(pid)).toBe(true);
        expect(toolbox.handles('mcp__docs__lookup')).toBe(false);
    });

    it('opens nothing for disabled servers', async () => {
        const toolbox = await new MCPToolbox([stdioConfig({ enabled: false, command: 'no-such-command' })]).open();

        expect(toolbox.toolDefinitions).toEqual([]);
        await toolbox.close();
    });

    it('fills placeholders from the environment and passes nothing else on', async () => {
        process.env.CODEX_TEST_TOKEN = 'test-value';
        process.env.UNRELATED_VARIABLE = 'must-not-leak';
        const toolbox = await new MCPToolbox([stdioConfig({ env: { DOCS_TOKEN: '${CODEX_TEST_TOKEN}' } })]).open();

        try {
            const seen = JSON.parse(await toolbox.call('mcp__docs__lookup', { query: 'environment' }));
            expect(seen).toEqual({ token: 'test-value', leaked: false });
        } finally {
            await toolbox.close();
        }
    });

    it('refuses a missing placeholder, a missing allowed tool and a server that will not start', async () => {
        delete process.env.CODEX_TEST_TOKEN;

        await expect(new MCPToolbox([stdioConfig({ env: { DOCS_TOKEN: '${CODEX_TEST_TOKEN}' } })]).open()).rejects.toThrow(
            "Environment variable 'CODEX_TEST_TOKEN' required by MCP server 'docs' is not set.",
        );
        await expect(new MCPToolbox([stdioConfig({ allowed_tools: ['lookup', 'search'] })]).open()).rejects.toThrow(
            "MCP server 'docs' does not provide allowed tool(s): search.",
        );
        await expect(new MCPToolbox([stdioConfig({ command: join(folder, 'no-such-command') })]).open()).rejects.toThrow(/^Failed to start an MCP server: /);
    });

    it('sends the resolved headers to an http server’s url', async () => {
        process.env.CODEX_TEST_TOKEN = 'test-value';
        seenHeaders.length = 0;
        const config: HttpServerSettings = {
            name: 'trilium',
            enabled: true,
            transport: 'http',
            url: httpUrl,
            headers: { Authorization: 'Bearer ${CODEX_TEST_TOKEN}' },
            allowed_tools: ['lookup'],
        };
        const toolbox = await new MCPToolbox([config]).open();

        try {
            expect(await toolbox.call('mcp__trilium__lookup', { query: 'notes' })).toBe('document result');
        } finally {
            await toolbox.close();
        }

        expect(seenHeaders.length).toBeGreaterThan(0);
        expect(seenHeaders.every((headers) => headers.authorization === 'Bearer test-value')).toBe(true);
    });

    it('names tools for the model within the length limit', () => {
        expect(functionName('my.server', 'look up')).toBe('mcp__my_server__look_up');
        expect(() => functionName('server', 'x'.repeat(60))).toThrow('exceeds the 64-character limit');
    });
});

// ============================================================================
// Tool stage
// ============================================================================

describe('tool stage with mcp', () => {
    it('dispatches calls to the mcp server', async () => {
        const requests: ChatCompletionRequest[] = [];
        const replies: ChatCompletion[] = [
            {
                content: '',
                tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'mcp__docs__lookup', arguments: JSON.stringify({ query: 'quick start' }) } }],
                finish_reason: 'tool_calls',
            },
            { content: 'The document says ...', tool_calls: [], finish_reason: 'stop' },
        ];
        const model: ChatModel = {
            async createChatCompletion(request) {
                requests.push({ ...request, messages: structuredClone(request.messages) });
                return replies.shift()!;
            },
        };
        const config = stdioConfig();

        const result = await runToolStage(model, 'Use tools when needed.', 'Search the docs.', new Toolbox('.'), 200, 0.1, 3, { mcpServers: [config] });

        expect(requests[1].messages.at(-1)?.content).toContain('document result');
        expect(requests[0].tools?.at(-1)?.function.name).toBe('mcp__docs__lookup');
        expect(result).toContain('document result');
        expect(await stopped(Number(readFileSync(config.args[1], 'utf-8')))).toBe(true);
    });
});
