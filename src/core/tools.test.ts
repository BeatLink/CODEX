import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { Toolbox } from './tools.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'codex-tools-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe('Toolbox', () => {
    it('runs unittest discovery only when enabled', () => {
        const root = makeTempDir();
        const testsDir = join(root, 'tests');
        mkdirSync(testsDir, { recursive: true });
        writeFileSync(join(testsDir, 'test_sample.py'), [
            'import unittest',
            '',
            'class SampleTests(unittest.TestCase):',
            '    def test_passes(self):',
            '        self.assertTrue(True)',
            '',
        ].join('\n'), 'utf8');

        const disabled = new Toolbox(root);
        expect(disabled.toolDefinitions.some((tool) => tool.function.name === 'run_tests')).toBe(false);
        expect(disabled.call('run_tests', {})).toContain('unknown tool');

        const enabled = new Toolbox(root, { enableTestExecution: true });
        const result = enabled.call('run_tests', {});
        expect(result).toContain('Tests passed');
        expect(result).toContain('Ran 1 test');
    });

    it('reads, writes, and lists files within the root', () => {
        const root = makeTempDir();
        const toolbox = new Toolbox(root, { allowFileWrites: true });
        const writeResult = toolbox.call('write_file', { path: 'notes/answer.txt', content: 'hello' });

        expect(writeResult).toContain('Wrote');
        expect(toolbox.call('read_file', { path: 'notes/answer.txt' })).toBe('hello');
        const entries = JSON.parse(toolbox.call('list_directory', { path: 'notes' }));
        expect(entries).toEqual([{ name: 'answer.txt', type: 'file' }]);
    });

    it('rejects paths outside the filesystem root', () => {
        const root = makeTempDir();
        const toolbox = new Toolbox(root, { allowFileWrites: true });
        const traversal = toolbox.call('read_file', { path: '../outside.txt' });
        expect(traversal).toContain('escapes');

        const secret = toolbox.call('read_file', { path: '.env' });
        expect(secret).toContain('credential or secret');
    });
});
