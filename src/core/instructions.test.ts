import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadInstructions, projectInstructionsPath } from './instructions.js';

describe('instructions', () => {
    it('loads the global and project instructions in order', () => {
        const root = mkdtempSync(join(tmpdir(), 'codex-instructions-'));
        const configRoot = join(root, 'config');
        const configDir = join(configRoot, 'codex');
        const projectDir = join(root, 'project');

        try {
            mkdirSync(configDir, { recursive: true });
            mkdirSync(projectDir, { recursive: true });
            process.env.XDG_CONFIG_HOME = configRoot;
            writeFileSync(join(configDir, 'CODEX.md'), 'global instruction\n', 'utf-8');
            writeFileSync(join(projectDir, 'CODEX.md'), 'project instruction', 'utf-8');

            const result = loadInstructions(projectDir);
            expect(result).toBe('global instruction\n\nproject instruction');
        } finally {
            delete process.env.XDG_CONFIG_HOME;
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('returns the first project instructions file when present', () => {
        const root = mkdtempSync(join(tmpdir(), 'codex-project-instructions-'));
        try {
            writeFileSync(join(root, 'AGENTS.md'), 'agent style', 'utf-8');
            expect(projectInstructionsPath(root)).toBe(join(root, 'AGENTS.md'));
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
