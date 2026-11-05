import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentDefinition, claimedServers, loadAgents, parseAgent, serversFor, topLevelAgents } from './agents.js';

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codex-agents-'));
    // The user's own config files never reach these tests.
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
});

afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
});

function server(name: string): { name: string; enabled: boolean } {
    return { name, enabled: true };
}

// ============================================================================
// Reading an agent file
// ============================================================================

describe('parseAgent', () => {
    it('takes the fields from the front matter and the instructions from the body', () => {
        const agent = parseAgent('mail', '---\ndescription: Sends email.\nmcp_servers: [mail, smtp]\nagents:\n  - contacts\n---\nBe brief.\n')!;

        expect(agent.name).toBe('mail');
        expect(agent.description).toBe('Sends email.');
        expect(agent.mcpServers).toEqual(['mail', 'smtp']);
        expect(agent.agents).toEqual(['contacts']);
        expect(agent.instructions).toBe('Be brief.');
    });

    it('reads a single name or a comma-separated string as a list of names', () => {
        const agent = parseAgent('mail', '---\ndescription: Sends email.\nmcp_servers: mail\nagents: contacts, notes\n---\n')!;

        expect(agent.mcpServers).toEqual(['mail']);
        expect(agent.agents).toEqual(['contacts', 'notes']);
    });

    it('is not an agent when the front matter is not valid YAML', () => {
        expect(parseAgent('mail', '---\ndescription: [unclosed\n---\nBe brief.')).toBeNull();
        expect(parseAgent('mail', '---\n- just\n- a list\n---\nBe brief.')).toBeNull();
    });

    it('reads front matter values the way PyYAML safe_load does', () => {
        const agent = parseAgent('mail', '---\ndescription: yes\nagents: [y, on, 1e3, 1.0, 09, 0777, 2024-01-01, ~]\n---\n')!;

        expect(agent.description).toBe('True');
        expect(agent.agents).toEqual(['y', 'True', '1e3', '1.0', '09', '511', '2024-01-01', 'None']);
        expect(parseAgent('mail', '---\ndescription: !!python/object:os.system x\n---\n')).toBeNull();
        expect(parseAgent('mail', '---\ndescription: *missing\n---\n')).toBeNull();
    });

    it('is not an agent without a description', () => {
        expect(parseAgent('mail', 'Be brief.')).toBeNull();
        expect(parseAgent('mail', '---\nagents: contacts\n---\nBe brief.')).toBeNull();
    });
});

// ============================================================================
// Loading the agent folders
// ============================================================================

describe('loadAgents', () => {
    it("lets a folder's own agent replace the global one and drops unknown sub-agents", () => {
        const globalFolder = join(root, 'config', 'codex', 'agents');
        mkdirSync(globalFolder, { recursive: true });
        writeFileSync(join(globalFolder, 'mail.md'), '---\ndescription: Global mail.\nagents: ghost, mail, contacts\n---\n');
        writeFileSync(join(globalFolder, 'contacts.md'), '---\ndescription: Contacts.\n---\n');
        const ownFolder = join(root, 'project', '.codex', 'agents');
        mkdirSync(ownFolder, { recursive: true });
        writeFileSync(join(ownFolder, 'mail.md'), '---\ndescription: Own mail.\nagents: ghost, mail, contacts\n---\n');

        const agents = loadAgents(join(root, 'project'));

        expect(agents.get('mail')!.description).toBe('Own mail.');
        expect(agents.get('mail')!.agents).toEqual(['contacts']);
    });
});

// ============================================================================
// Who can be handed what
// ============================================================================

describe('agent scope', () => {
    let agents: Map<string, AgentDefinition>;

    beforeEach(() => {
        agents = new Map([
            ['assistant', parseAgent('assistant', '---\ndescription: Does everything.\nagents: mail\n---\n')!],
            ['mail', parseAgent('mail', '---\ndescription: Email.\nmcp_servers: mail\n---\n')!],
            ['notes', parseAgent('notes', '---\ndescription: Notes.\nmcp_servers: notes\n---\n')!],
        ]);
    });

    it('offers only the agents nobody lists at the top', () => {
        expect(topLevelAgents(agents)).toEqual(['assistant', 'notes']);
    });

    it('withholds a server an agent owns from everyone else', () => {
        const servers = [server('mail'), server('notes'), server('web')];

        expect(claimedServers(agents)).toEqual(new Set(['mail', 'notes']));
        expect(serversFor(null, agents, servers).map((given) => given.name)).toEqual(['web']);
        expect(serversFor(agents.get('mail')!, agents, servers).map((given) => given.name)).toEqual(['mail']);
    });
});
