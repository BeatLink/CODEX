import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { lastProbedAt, probeLocations, probeSoftware, refreshEnvironment } from './environment.js';
import { KnowledgeStore } from './knowledge.js';

let root: string;
let settings: { knowledge_db_path: string; filesystem_root: string; background_refresh_interval_hours: number };

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codex-environment-'));
    // The user's own config files never reach these tests.
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
    settings = {
        knowledge_db_path: join(root, 'knowledge.db'),
        filesystem_root: root,
        background_refresh_interval_hours: 24,
    };
});

afterEach(() => {
    lastProbedAt.clear();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
});

// ============================================================================
// Probes
// ============================================================================

describe('environment probes', () => {
    it('names the home and working folders among the locations', () => {
        const statements = probeLocations(root);

        expect(statements).toContain(`The user's home folder is ${homedir()}.`);
        expect(statements).toContain(`CODEX works in the folder ${realpathSync(root)}.`);
    });

    it('lists installed and missing commands among the software', async () => {
        vi.stubEnv('SHELL', '/bin/fish');

        const statements = await probeSoftware({ findCommand: (tool) => (tool === 'git' ? '/bin/git' : null) });

        expect(statements).toContain('These commands are installed: git.');
        expect(statements).toContain("The user's shell is /bin/fish.");
        expect(statements.some((statement) => statement.startsWith('These commands are not installed: python3'))).toBe(true);
    });
});

// ============================================================================
// Recording
// ============================================================================

describe('refreshing the environment', () => {
    it('probes once per interval and records probed memories', async () => {
        const probe = async () => ['git is installed.'];

        expect(await refreshEnvironment(settings, { probeSoftware: probe })).toBe(true);
        expect(await refreshEnvironment(settings, { probeSoftware: probe })).toBe(false);

        const memories = new KnowledgeStore(settings.knowledge_db_path).memories({ limit: 1000 });
        expect(memories.map((memory) => [memory.store, memory.statement, memory.origin])).toContainEqual(['software', 'git is installed.', 'probed']);
        expect(memories.some((memory) => memory.store === 'locations')).toBe(true);
    });
});
