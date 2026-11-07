import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PROMPTS_DIRECTORY, PROMPTS_OVERRIDE_VARIABLE, clearPromptCache, prompt, readPrompt } from './prompts.js';

describe('prompt bundle', () => {
    let variants: string;
    const saved = process.env[PROMPTS_OVERRIDE_VARIABLE];

    beforeEach(() => {
        variants = mkdtempSync(join(tmpdir(), 'codex-prompts-'));
        clearPromptCache();
    });

    afterEach(() => {
        if (saved === undefined) {
            delete process.env[PROMPTS_OVERRIDE_VARIABLE];
        } else {
            process.env[PROMPTS_OVERRIDE_VARIABLE] = saved;
        }
        clearPromptCache();
        rmSync(variants, { recursive: true, force: true });
    });

    it('reads a shipped prompt with one trailing newline removed and nothing else trimmed', () => {
        const file = readFileSync(join(PROMPTS_DIRECTORY, 'reroute-note.txt'), 'utf-8');
        expect(file.endsWith('\n')).toBe(true);
        expect(readPrompt('reroute-note')).toBe(file.slice(0, -1));
        expect(readPrompt('reroute-note').startsWith(' ')).toBe(true);
    });

    it('fills placeholders and refuses a missing or unused value', () => {
        expect(prompt('decision', { MIN_SUBTASKS: 2, MAX_SUBTASKS: 5 })).toContain(' 2 to 5 subtasks');
        expect(() => prompt('decision', { MIN_SUBTASKS: 2 })).toThrow('{{MAX_SUBTASKS}}');
        expect(() => prompt('routing', { MIN_SUBTASKS: 2 })).toThrow('no place for MIN_SUBTASKS');
    });

    it('takes a file from the override folder and falls back to the shipped one', () => {
        writeFileSync(join(variants, 'routing.txt'), 'A routing variant.\n');
        process.env[PROMPTS_OVERRIDE_VARIABLE] = variants;
        expect(prompt('routing')).toBe('A routing variant.');
        expect(prompt('check')).toBe(readFileSync(join(PROMPTS_DIRECTORY, 'check.txt'), 'utf-8').slice(0, -1));
    });

    it('throws with the file name when a prompt is missing', () => {
        expect(() => prompt('no-such-prompt')).toThrow(/Prompt file missing: .*no-such-prompt\.txt/);
    });

    it('ships only prompts that hold no stray placeholder syntax or trailing blank line', () => {
        for (const name of readdirSync(PROMPTS_DIRECTORY)) {
            const text = readFileSync(join(PROMPTS_DIRECTORY, name), 'utf-8');
            expect(name).toMatch(/^[a-z-]+\.txt$/);
            expect(text.endsWith('\n') && !text.endsWith('\n\n')).toBe(true);
            expect(text.replace(/\{\{[A-Z_]+\}\}/g, '')).not.toMatch(/\{\{|\}\}/);
        }
    });
});
