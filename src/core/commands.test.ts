import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { expandCommand, loadCommands } from './commands.js';

describe('commands', () => {
    it('loads project command files ahead of global ones and expands templates', () => {
        const root = mkdtempSync(join(tmpdir(), 'codex-commands-'));
        const configRoot = join(root, 'config');
        const projectRoot = join(root, 'project');
        const configDir = join(configRoot, 'codex', 'commands');
        const projectDir = join(projectRoot, '.codex', 'commands');

        try {
            mkdirSync(configDir, { recursive: true });
            mkdirSync(projectDir, { recursive: true });
            process.env.XDG_CONFIG_HOME = configRoot;

            writeFileSync(join(configDir, 'summary.md'), 'Summarize globally.', 'utf-8');
            writeFileSync(join(projectDir, 'summary.md'), 'Summarize this folder.', 'utf-8');

            const commands = loadCommands(projectRoot);
            expect(commands.summary?.mode).toBeNull();
            expect(expandCommand('/summary briefly', projectRoot, false)).toEqual([null, 'Summarize this folder.\n\nbriefly']);
        } finally {
            delete process.env.XDG_CONFIG_HOME;
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('handles init and unknown commands without touching the model', () => {
        const root = mkdtempSync(join(tmpdir(), 'codex-init-'));
        try {
            mkdirSync(join(root, '.codex', 'commands'), { recursive: true });
            expect(expandCommand('/init', root, true)[0]).toBe('execute');
            expect(expandCommand('/init', root, false)[0]).toBe('draft');
            expect(expandCommand('/nothing here', root, false)).toEqual([null, '/nothing here']);
            expect(expandCommand('/etc/hosts is wrong', root, false)).toEqual([null, '/etc/hosts is wrong']);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
