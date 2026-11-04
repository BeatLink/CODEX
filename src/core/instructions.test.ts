import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_INSTRUCTIONS_CHARS, loadInstructions, projectInstructionsPath } from './instructions.js';

let base: string;
let config: string;
let root: string;
const savedConfigHome = process.env.XDG_CONFIG_HOME;

beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'codex-instructions-'));
    config = join(base, 'config');
    root = join(base, 'project');
    mkdirSync(join(config, 'codex'), { recursive: true });
    mkdirSync(root);
    process.env.XDG_CONFIG_HOME = config;
});

afterEach(() => {
    if (savedConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
    } else {
        process.env.XDG_CONFIG_HOME = savedConfigHome;
    }
    rmSync(base, { recursive: true, force: true });
});

describe('instructions', () => {
    it('puts the global instructions before the folder’s own', () => {
        writeFileSync(join(config, 'codex', 'CODEX.md'), 'Answer in British English.\n');
        writeFileSync(join(root, 'AGENTS.md'), 'Run the tests with make check.\n');

        expect(loadInstructions(root)).toBe('Answer in British English.\n\nRun the tests with make check.');
    });

    it('reads a folder’s CODEX file over its AGENTS file', () => {
        writeFileSync(join(root, 'CODEX.md'), 'Use tabs.');
        writeFileSync(join(root, 'AGENTS.md'), 'Use spaces.');

        expect(loadInstructions(root)).toBe('Use tabs.');
        expect(projectInstructionsPath(root)).toBe(join(root, 'CODEX.md'));
    });

    it('gives nothing without files and cuts long ones', () => {
        expect(loadInstructions(root)).toBe('');
        expect(projectInstructionsPath(root)).toBeNull();

        writeFileSync(join(root, 'CODEX.md'), 'x'.repeat(MAX_INSTRUCTIONS_CHARS + 100));

        expect(loadInstructions(root).length).toBeLessThan(MAX_INSTRUCTIONS_CHARS + 100);
    });

    it('skips a file that is not UTF-8 text', () => {
        writeFileSync(join(root, 'CODEX.md'), Buffer.from([0xff, 0xfe, 0x00]));

        expect(loadInstructions(root)).toBe('');
    });
});
