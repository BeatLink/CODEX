// Agents: named specialists a task can hand its work to, each with its own instructions, tools, and sub-agents.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { YAMLError, YAMLParseError, parseDocument, type CollectionTag, type ScalarTag } from 'yaml';

import { configDirectory } from './instructions.js';
import { expandUser } from './settings.js';

// ============================================================================
// Limits
// ============================================================================

// Each hand-over loses detail and can misroute, so agents nest only this deep.
export const MAX_AGENT_DEPTH = 3;

// An agent's instructions go into every call it makes, so they are cut like the user's own.
export const MAX_AGENT_INSTRUCTIONS_CHARS = 2000;

// ============================================================================
// Definitions
// ============================================================================

// One agent: what the parent reads to choose it, and what it works with once chosen.
export class AgentDefinition {
    constructor(
        public name: string,
        public description: string,
        public instructions = '',
        public mcpServers: string[] = [],
        public agents: string[] = [],
    ) {}
}

// The server settings fields the agents look at.
export type NamedServer = { name: string };

// Line breaks as Python's splitlines sees them.
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;

// Return where agent files live, the global folder first so a folder's own file replaces it.
export function agentDirectories(filesystemRoot: string): string[] {
    const root = resolve(expandUser(filesystemRoot));
    return [join(configDirectory(), 'agents'), join(root, '.codex', 'agents')];
}

// ============================================================================
// Front matter
// ============================================================================

// YAML 1.1 as PyYAML's safe_load reads it: only its words are booleans, 1e3 and 09 stay text, and dates stay text.
const PYYAML_TRUE = /^(?:yes|Yes|YES|true|True|TRUE|on|On|ON)$/;
const PYYAML_FALSE = /^(?:no|No|NO|false|False|FALSE|off|Off|OFF)$/;
const PYYAML_DECIMAL = /^[-+]?(?:0|[1-9][0-9_]*)$/;
const PYYAML_FLOAT = /^(?:[-+]?[0-9][0-9_]*\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9_]+(?:[eE][-+][0-9]+)?)$/;

type Tag = ScalarTag | CollectionTag;

function pyyamlTags(tags: Array<Tag | string>): Tag[] {
    const kept: Tag[] = [];
    for (const tag of tags) {
        if (typeof tag === 'string' || tag.tag === 'tag:yaml.org,2002:timestamp' || (tag.tag === 'tag:yaml.org,2002:float' && tag.format === 'EXP')) {
            continue;
        }
        const plain = !tag.format && tag.test && !String(tag.test).includes('inf');
        if (tag.tag === 'tag:yaml.org,2002:bool') {
            kept.push({ ...tag, test: String(tag.test).includes('rue') ? PYYAML_TRUE : PYYAML_FALSE } as ScalarTag);
        } else if (tag.tag === 'tag:yaml.org,2002:int' && plain) {
            kept.push({ ...tag, test: PYYAML_DECIMAL } as ScalarTag);
        } else if (tag.tag === 'tag:yaml.org,2002:float' && plain) {
            kept.push({ ...tag, test: PYYAML_FLOAT } as ScalarTag);
        } else {
            kept.push(tag);
        }
    }
    return kept;
}

// Writes a value the way Python's str does, so a YAML number or flag reads as Python would show it.
function pythonString(value: unknown, nested = false): string {
    if (value === null || value === undefined) {
        return 'None';
    }
    if (typeof value === 'boolean') {
        return value ? 'True' : 'False';
    }
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (typeof value === 'number') {
        if (Number.isNaN(value)) {
            return 'nan';
        }
        if (!Number.isFinite(value)) {
            return value > 0 ? 'inf' : '-inf';
        }
        return Number.isInteger(value) && Math.abs(value) < 1e16 ? `${value}.0` : String(value);
    }
    if (typeof value === 'string') {
        return nested ? `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'` : value;
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => pythonString(item, true)).join(', ')}]`;
    }
    if (value instanceof Map) {
        return `{${[...value].map(([key, item]) => `${pythonString(key, true)}: ${pythonString(item, true)}`).join(', ')}}`;
    }
    if (typeof value === 'object') {
        return `{${Object.entries(value).map(([key, item]) => `${pythonString(key, true)}: ${pythonString(item, true)}`).join(', ')}}`;
    }
    return String(value);
}

// Says whether Python would count a value as true.
function pythonTruthy(value: unknown): boolean {
    if (Array.isArray(value)) {
        return value.length > 0;
    }
    if (value instanceof Map || value instanceof Set) {
        return value.size > 0;
    }
    if (value !== null && typeof value === 'object') {
        return Object.keys(value).length > 0;
    }
    return Boolean(value) && value !== 0n;
}

// Reads front matter as PyYAML's safe_load does, throwing when it is not valid YAML.
export function loadFrontMatter(text: string): unknown {
    const document = parseDocument(text, {
        version: '1.1',
        customTags: (tags) => pyyamlTags(tags),
        intAsBigInt: true,
        merge: true,
        uniqueKeys: false,
    });
    // A tag safe_load does not know, such as one naming a Python object, is an error rather than a warning.
    const problem = document.errors[0] ?? document.warnings.find((warning) => warning.code === 'TAG_RESOLVE_FAILED');
    if (problem !== undefined) {
        throw problem;
    }
    try {
        return document.toJS();
    } catch (error) {
        // An alias to an anchor that was never set is a YAML error, as it is for safe_load.
        if (error instanceof ReferenceError) {
            throw new YAMLParseError([0, 0], 'BAD_ALIAS', error.message);
        }
        throw error;
    }
}

// Reads a YAML list of names, or a single name or comma-separated string.
function names(value: unknown): string[] {
    const items = Array.isArray(value) ? value : pythonString(pythonTruthy(value) ? value : '').split(',');
    return items.map((item) => pythonString(item).trim()).filter(Boolean);
}

// ============================================================================
// Reading agent files
// ============================================================================

// Read one agent file, or return null when it has no description to choose it by.
export function parseAgent(name: string, text: string): AgentDefinition | null {
    let fields: unknown = {};
    let body = text.trim();
    const lines = body.split(LINE_BREAK);
    if (body && lines[0].trim() === '---') {
        for (let index = 1; index < lines.length; index += 1) {
            if (lines[index].trim() === '---') {
                try {
                    fields = loadFrontMatter(lines.slice(1, index).join('\n'));
                } catch (error) {
                    if (error instanceof YAMLError) {
                        return null;
                    }
                    throw error;
                }
                body = lines.slice(index + 1).join('\n').trim();
                break;
            }
        }
    }
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
        return null;
    }
    const front = fields as Record<string, unknown>;
    const description = pythonTruthy(front.description) ? pythonString(front.description).trim() : '';
    if (!description) {
        return null;
    }
    return new AgentDefinition(
        name,
        description,
        body.slice(0, MAX_AGENT_INSTRUCTIONS_CHARS),
        names(front.mcp_servers),
        names(front.agents),
    );
}

function agentFiles(directory: string): string[] {
    try {
        if (!statSync(directory).isDirectory()) {
            return [];
        }
        return readdirSync(directory)
            .filter((name) => name.endsWith('.md'))
            .map((name) => join(directory, name))
            .sort();
    } catch {
        return [];
    }
}

// Return every agent by name; a sub-agent that does not exist is dropped from its parent's list.
export function loadAgents(filesystemRoot: string): Map<string, AgentDefinition> {
    const agents = new Map<string, AgentDefinition>();
    for (const directory of new Set(agentDirectories(filesystemRoot))) {
        for (const path of agentFiles(directory)) {
            let agent: AgentDefinition | null;
            try {
                agent = parseAgent(basename(path, '.md'), new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)));
            } catch {
                continue;
            }
            if (agent !== null) {
                agents.set(agent.name, agent);
            }
        }
    }
    for (const agent of agents.values()) {
        agent.agents = agent.agents.filter((name) => agents.has(name) && name !== agent.name);
    }
    return agents;
}

// ============================================================================
// Who can be handed what
// ============================================================================

// Return the agents no other agent lists, which the request's own tasks can hand work to.
export function topLevelAgents(agents: Map<string, AgentDefinition>): string[] {
    const listed = new Set([...agents.values()].flatMap((agent) => agent.agents));
    return [...agents.keys()].filter((name) => !listed.has(name));
}

// Return the MCP servers some agent owns, which no other run may use.
export function claimedServers(agents: Map<string, AgentDefinition>): Set<string> {
    return new Set([...agents.values()].flatMap((agent) => agent.mcpServers));
}

// Return the MCP servers a run may use: the agent's own, or those no agent owns at the top.
export function serversFor<Server extends NamedServer>(
    agent: AgentDefinition | null,
    agents: Map<string, AgentDefinition>,
    servers: Server[],
): Server[] {
    if (agent !== null) {
        return servers.filter((server) => agent.mcpServers.includes(server.name));
    }
    const claimed = claimedServers(agents);
    return servers.filter((server) => !claimed.has(server.name));
}
