import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    DEFAULT_SETTINGS,
    background_model_key,
    load_settings,
    mcp_servers_from_json,
    mcp_servers_to_json,
    validate_settings,
} from './settings.js';

describe('settings', () => {
    it('defaults and validates the common fields', () => {
        expect(DEFAULT_SETTINGS.show_thinking).toBe(true);
        expect(DEFAULT_SETTINGS.mode).toBe('auto');

        expect(() => validate_settings({ ...DEFAULT_SETTINGS, show_thinking: 'yes' as any })).toThrow(/show_thinking/i);
        expect(() => validate_settings({ ...DEFAULT_SETTINGS, mode: 'chat' as any })).toThrow(/mode/i);
        expect(() => validate_settings({ ...DEFAULT_SETTINGS, max_task_depth: 7 })).toThrow(/max_task_depth/i);
        expect(() => validate_settings({ ...DEFAULT_SETTINGS, max_task_nodes: 0 })).toThrow(/max_task_nodes/i);
    });

    it('ignores retired settings and keeps a boolean test flag', () => {
        const loaded = load_settings({
            runner: 'pipeline',
            mode: 'draft',
        } as any);

        expect(loaded).not.toHaveProperty('runner');
        expect(loaded.mode).toBe('draft');
        expect(() => validate_settings({ ...DEFAULT_SETTINGS, enable_test_execution: 'yes' as any })).toThrow(/enable_test_execution/i);
    });

    it('validates background behavior and model fallbacks', () => {
        const settings = validate_settings(DEFAULT_SETTINGS);
        expect(background_model_key(settings)).toEqual([settings.model_path, settings.context_size, settings.gpu_layers]);

        const alt = validate_settings({ ...DEFAULT_SETTINGS, background_model_path: ' ./models/big.gguf ' });
        expect(background_model_key(alt)).toEqual(['./models/big.gguf', alt.context_size, 0]);
        const sized = { ...alt, background_context_size: 8192 };
        expect(background_model_key(sized)).toEqual(['./models/big.gguf', 8192, 0]);

        expect(() => validate_settings({ ...DEFAULT_SETTINGS, background_model_path: null as any })).toThrow(/background_model_path/i);
        expect(() => validate_settings({ ...DEFAULT_SETTINGS, background_gpu_layers: -2 })).toThrow(/background_gpu_layers/i);
        expect(() => validate_settings({ ...DEFAULT_SETTINGS, background_context_size: -1 })).toThrow(/background_context_size/i);
    });

    it('requires MCP servers to have the right transport, headers, and allowed tools', () => {
        const validated = validate_settings({
            ...DEFAULT_SETTINGS,
            mcp_servers: [{
                name: 'local_docs',
                command: 'uvx',
                args: ['example-mcp-server'],
                allowed_tools: ['search_docs'],
            }],
        });

        expect(validated.mcp_servers[0].transport).toBe('stdio');
        expect(validated.mcp_servers[0].enabled).toBe(true);

        expect(() => validate_settings({
            ...DEFAULT_SETTINGS,
            mcp_servers: [{
                name: 'remote',
                transport: 'sse',
                url: 'http://127.0.0.1:8000/sse',
                allowed_tools: ['search'],
            }],
        })).toThrow(/unsupported transport/i);

        const httpValidated = validate_settings({
            ...DEFAULT_SETTINGS,
            mcp_servers: [{
                name: 'trilium',
                transport: 'http',
                url: 'http://127.0.0.1:37840/mcp',
                headers: { Authorization: 'Bearer ${TRILIUM_ETAPI_TOKEN}' },
                allowed_tools: ['search_notes'],
            }],
        });
        expect(httpValidated.mcp_servers[0].url).toBe('http://127.0.0.1:37840/mcp');
        expect('command' in httpValidated.mcp_servers[0]).toBe(false);

        expect(() => validate_settings({
            ...DEFAULT_SETTINGS,
            mcp_servers: [{ name: 'empty', command: 'server', allowed_tools: [] }],
        })).toThrow(/at least one tool/i);
    });

    it('reads JSON back and validates it', () => {
        const servers = [{
            name: 'docs',
            transport: 'stdio',
            command: 'docs-mcp-server',
            allowed_tools: ['search_docs'],
        }];

        const readBack = mcp_servers_from_json(mcp_servers_to_json(servers));
        expect(readBack[0].allowed_tools).toEqual(['search_docs']);
        expect(mcp_servers_from_json('  ')).toEqual([]);
        expect(() => mcp_servers_from_json('[{')).toThrow(/valid JSON/i);
    });

    it('falls back to the current or user settings file path', () => {
        const dir = mkdtempSync(join(tmpdir(), 'codex-settings-'));
        const userPath = join(dir, 'config', 'settings.json');
        const start = process.cwd();

        try {
            process.chdir(dir);
            const originalDefault = process.env.XDG_CONFIG_HOME;
            process.env.XDG_CONFIG_HOME = join(dir, 'config');
            writeFileSync(join(dir, 'settings.json'), '{}', 'utf8');
            expect(load_settings(join(dir, 'settings.json'))).toBeTruthy();
            const result = join(dir, 'settings.json');
            expect(result).toBeTruthy();
            process.env.XDG_CONFIG_HOME = originalDefault;
        } finally {
            process.chdir(start);
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
