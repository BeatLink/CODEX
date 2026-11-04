import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    DEFAULT_SETTINGS,
    backgroundModelKey,
    defaultSettingsPath,
    loadSettings,
    mcpServersFromJson,
    mcpServersToJson,
    validateSettings,
} from './settings.js';

const folders: string[] = [];

function temporaryFolder(): string {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'codex-settings-')));
    folders.push(folder);
    return folder;
}

function withServers(servers: unknown[]): Record<string, unknown> {
    return { ...DEFAULT_SETTINGS, mcp_servers: servers };
}

afterEach(() => {
    for (const folder of folders.splice(0)) {
        rmSync(folder, { recursive: true, force: true });
    }
});

// ============================================================================
// Settings
// ============================================================================

describe('settings', () => {
    it('shows thinking by default and needs a boolean for it', () => {
        expect(DEFAULT_SETTINGS.show_thinking).toBe(true);

        expect(() => validateSettings({ ...DEFAULT_SETTINGS, show_thinking: 'yes' })).toThrow(/show_thinking/);
    });

    it('uses the auto mode by default and needs a known mode', () => {
        expect(DEFAULT_SETTINGS.mode).toBe('auto');

        expect(() => validateSettings({ ...DEFAULT_SETTINGS, mode: 'chat' })).toThrow(/mode/);
    });

    it('checks the task tree limits', () => {
        expect(() => validateSettings({ ...DEFAULT_SETTINGS, max_task_depth: 7 })).toThrow(/max_task_depth/);
        expect(() => validateSettings({ ...DEFAULT_SETTINGS, max_task_nodes: 0 })).toThrow(/max_task_nodes/);
    });

    it('loads a settings file that still names a runner without it', () => {
        const path = join(temporaryFolder(), 'settings.json');
        writeFileSync(path, '{"runner": "pipeline", "mode": "draft"}', 'utf-8');

        const loaded = loadSettings(path);

        expect(loaded).not.toHaveProperty('runner');
        expect(loaded.mode).toBe('draft');
    });

    it('refuses unknown settings and broken JSON in a file', () => {
        const folder = temporaryFolder();
        const unknown = join(folder, 'unknown.json');
        const broken = join(folder, 'broken.json');
        writeFileSync(unknown, '{"colour": "blue"}', 'utf-8');
        writeFileSync(broken, '{', 'utf-8');

        expect(() => loadSettings(unknown)).toThrow('Unknown setting(s): colour');
        expect(() => loadSettings(broken)).toThrow(/Invalid JSON in settings file/);
        expect(() => loadSettings(join(folder, 'missing.json'))).toThrow(/ENOENT/);
    });

    it('needs booleans for test runs and file writes, which are off by default', () => {
        expect(DEFAULT_SETTINGS.allow_file_writes).toBe(false);

        expect(() => validateSettings({ ...DEFAULT_SETTINGS, enable_test_execution: 'yes' })).toThrow(/enable_test_execution/);
        expect(() => validateSettings({ ...DEFAULT_SETTINGS, allow_file_writes: 'yes' })).toThrow(/allow_file_writes/);
    });

    it('bounds the background settings', () => {
        expect(() => validateSettings({ ...DEFAULT_SETTINGS, background_poll_interval_seconds: 0 })).toThrow(/background_poll_interval_seconds/);
        expect(() => validateSettings({ ...DEFAULT_SETTINGS, background_research_enabled: 'yes' })).toThrow(/background_research_enabled/);
    });

    it('runs background work on the main model unless another is set', () => {
        const settings = validateSettings({ ...DEFAULT_SETTINGS });
        expect(backgroundModelKey(settings)).toEqual([settings.model_path, settings.context_size, settings.gpu_layers]);

        const other = validateSettings({ ...DEFAULT_SETTINGS, background_model_path: ' ./models/big.gguf ' });
        expect(backgroundModelKey(other)).toEqual(['./models/big.gguf', other.context_size, 0]);
        other.background_context_size = 8192;
        expect(backgroundModelKey(other)).toEqual(['./models/big.gguf', 8192, 0]);

        expect(() => validateSettings({ ...DEFAULT_SETTINGS, background_model_path: null })).toThrow(/background_model_path/);
        expect(() => validateSettings({ ...DEFAULT_SETTINGS, background_gpu_layers: -2 })).toThrow(/background_gpu_layers/);
        expect(() => validateSettings({ ...DEFAULT_SETTINGS, background_context_size: -1 })).toThrow(/background_context_size/);
    });

    it('falls back to the user config file', () => {
        const folder = temporaryFolder();
        const userPath = join(folder, 'config', 'settings.json');
        const previous = process.cwd();
        process.chdir(folder);

        try {
            const options = { bundledPath: join(folder, 'missing.json'), userPath };
            expect(defaultSettingsPath(options)).toBe(userPath);
            writeFileSync('settings.json', '{}', 'utf-8');
            expect(defaultSettingsPath(options)).toBe(join(folder, 'settings.json'));
        } finally {
            process.chdir(previous);
        }
    });
});

// ============================================================================
// MCP servers
// ============================================================================

describe('mcp servers', () => {
    it('defaults to stdio and enabled', () => {
        const validated = validateSettings(
            withServers([{ name: 'local_docs', command: 'uvx', args: ['example-mcp-server'], allowed_tools: ['search_docs'] }]),
        );

        expect(validated.mcp_servers[0].transport).toBe('stdio');
        expect(validated.mcp_servers[0].enabled).toBe(true);
    });

    it('refuses an unsupported transport', () => {
        const servers = [{ name: 'remote', transport: 'sse', url: 'http://127.0.0.1:8000/sse', allowed_tools: ['search'] }];

        expect(() => validateSettings(withServers(servers))).toThrow(/unsupported transport/);
    });

    it('takes a url and headers for an http server', () => {
        const servers = [
            {
                name: 'trilium',
                transport: 'http',
                url: 'http://127.0.0.1:37840/mcp',
                headers: { Authorization: 'Bearer ${TRILIUM_ETAPI_TOKEN}' },
                allowed_tools: ['search_notes'],
            },
        ];

        const validated = validateSettings(withServers(servers)).mcp_servers[0];

        expect(validated).toMatchObject({ url: 'http://127.0.0.1:37840/mcp' });
        expect(validated).not.toHaveProperty('command');
    });

    it('refuses stdio fields, bad urls and bad header names on an http server', () => {
        const cases: Array<[Record<string, unknown>, RegExp]> = [
            [{ url: 'http://127.0.0.1/mcp', command: 'server' }, /cannot set: command/],
            [{ url: 'file:///tmp/socket' }, /url must be/],
            [{ url: 'http://127.0.0.1/mcp', headers: { 'Bad Header': 'x' } }, /header name/],
        ];

        for (const [server, message] of cases) {
            const servers = [{ name: 'remote', transport: 'http', allowed_tools: ['search'], ...server }];
            expect(() => validateSettings(withServers(servers))).toThrow(message);
        }
    });

    it('needs an enabled server to allow at least one tool', () => {
        const servers = [{ name: 'empty', command: 'server', allowed_tools: [] }];

        expect(() => validateSettings(withServers(servers))).toThrow(/at least one tool/);
    });

    it('reads edited JSON back and checks it', () => {
        const servers = [{ name: 'docs', transport: 'stdio', command: 'docs-mcp-server', allowed_tools: ['search_docs'] }];

        const readBack = mcpServersFromJson(mcpServersToJson(servers as never));

        expect(readBack[0].allowed_tools).toEqual(['search_docs']);
        expect(mcpServersFromJson('  ')).toEqual([]);
        expect(() => mcpServersFromJson('[{')).toThrow(/valid JSON/);
    });
});
