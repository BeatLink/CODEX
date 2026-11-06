// A stdio MCP server with canned tools, so the agents eval can give a model many tools without real accounts.
// Run as: node fake_mcp_server.mjs <mail|calendar|notes|contacts|weather|todos>
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { readFileSync } from 'node:fs';

// Each server is a list of tools with a description, parameter names, and the canned reply.
const CATALOGUES = JSON.parse(readFileSync(new URL('./fake_catalogue.json', import.meta.url), 'utf-8'));


const tools = CATALOGUES[process.argv[2]];
if (!tools) {
    console.error(`unknown server '${process.argv[2]}'; use one of: ${Object.keys(CATALOGUES).join(', ')}`);
    process.exit(2);
}

const server = new Server({ name: process.argv[2], version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, parameters }) => ({
        name,
        description,
        inputSchema: { type: 'object', properties: Object.fromEntries(parameters.map((parameter) => [parameter, { type: 'string' }])), required: parameters },
    })),
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((candidate) => candidate.name === request.params.name);
    if (!tool) {
        return { content: [{ type: 'text', text: `Unknown tool ${request.params.name}` }], isError: true };
    }
    return { content: [{ type: 'text', text: tool.reply }] };
});
await server.connect(new StdioServerTransport());
