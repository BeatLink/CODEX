import { describe, expect, it } from 'vitest';

import {
    applySizeChoice,
    autoSizeRequest,
    collectSettings,
    mcpServersFromJson,
    numberFields,
    settingsToForm,
    sizeChoiceMessage,
} from './settingsForm.js';
import type { Settings } from './types.js';

const settings = {
    model_path: './models/model.gguf',
    context_size: 4096,
    gpu_layers: -1,
    max_tokens: 2048,
    temperature: 0.1,
    filesystem_root: '.',
    allow_file_writes: false,
    max_tool_calls: 5,
    max_search_results: 5,
    enable_test_execution: false,
    confirm_actions: true,
    show_thinking: true,
    mode: 'auto',
    max_task_depth: 3,
    max_task_nodes: 20,
    mcp_servers: [],
    knowledge_db_path: '~/.local/share/codex/knowledge.sqlite3',
    embedding_model_path: './models/embedding.gguf',
    background_research_enabled: true,
    background_model_path: '',
    background_context_size: 0,
    background_gpu_layers: 0,
    background_poll_interval_seconds: 10,
    background_refresh_interval_hours: 168,
    background_max_tokens: 768,
    background_max_pending_jobs: 100,
    background_prune_after_days: 90,
    background_max_store_megabytes: 1024,
} as Settings;

describe('settings form', () => {
    it('reads back the same settings it was filled with', () => {
        const form = settingsToForm(settings);

        const collected = collectSettings(settings, form);

        expect(form.text.temperature).toBe('0.10');
        expect(form.mcp_servers).toBe('[]');
        expect(collected).toEqual(settings);
    });

    it('takes the edited values, the mode and the background switch', () => {
        const form = settingsToForm(settings);
        form.text.context_size = ' 8192 ';
        form.text.temperature = '0.7';
        form.switches.allow_file_writes = true;
        form.mode = 'draft';
        form.background_research_enabled = false;
        form.mcp_servers = '[{"name": "files", "command": "mcp-files"}]';

        const collected = collectSettings(settings, form);

        expect(collected).toMatchObject({
            context_size: 8192,
            temperature: 0.7,
            allow_file_writes: true,
            mode: 'draft',
            background_research_enabled: false,
            mcp_servers: [{ name: 'files', command: 'mcp-files' }],
        });
    });

    it('names the field that is not a whole number or out of range', () => {
        const form = settingsToForm(settings);

        expect(() => collectSettings(settings, { ...form, text: { ...form.text, max_tool_calls: '2.5' } })).toThrow('Max tool calls must be an integer.');
        expect(() => collectSettings(settings, { ...form, text: { ...form.text, max_task_depth: '7' } })).toThrow('Max task depth must be from 0 to 6.');
        expect(() => collectSettings(settings, { ...form, text: { ...form.text, temperature: 'warm' } })).toThrow('Temperature must be a number.');
        expect(() => collectSettings(settings, { ...form, text: { ...form.text, gpu_layers: '' } })).toThrow('GPU layers must be an integer.');
    });

    it('rejects an empty model path, an unknown mode and a broken MCP list', () => {
        const form = settingsToForm(settings);

        expect(() => collectSettings(settings, { ...form, text: { ...form.text, model_path: '  ' } })).toThrow('model_path must be a non-empty string.');
        expect(() => collectSettings(settings, { ...form, mode: 'fast' })).toThrow('mode must be one of: auto, answer, draft, execute.');
        expect(() => mcpServersFromJson('{"name": 1}')).toThrow('mcp_servers must be a list.');
        expect(() => mcpServersFromJson('[')).toThrow(/^MCP servers must be valid JSON: /);
        expect(mcpServersFromJson('  ')).toEqual([]);
    });

    it('covers every number setting the Python interfaces show', () => {
        const names = numberFields().map((field) => field.name);

        expect(names).toHaveLength(16);
        expect(names).toContain('background_context_size');
        expect(names).toContain('background_gpu_layers');
    });
});

describe('auto size', () => {
    it('asks about the models in the form and fills the four limits it suggests', () => {
        const form = settingsToForm({ ...settings, background_model_path: ' small.gguf ' });
        const choice = {
            context_size: 16384,
            max_tokens: 3072,
            background_max_tokens: 512,
            background_context_size: 8192,
            explanation: '6.0 GB free on the GPU',
        };

        const request = autoSizeRequest(form);
        const filled = applySizeChoice(form, choice);

        expect(request).toEqual({ model_path: './models/model.gguf', gpu_layers: -1, background_model_path: 'small.gguf', background_gpu_layers: 0 });
        expect(filled.text).toMatchObject({ context_size: '16384', max_tokens: '3072', background_max_tokens: '512', background_context_size: '8192' });
        expect(sizeChoiceMessage(choice)).toBe(
            '6.0 GB free on the GPU. Context 16384, max tokens 3072, background context 8192, background max tokens 512. Apply or save to use them.',
        );
    });
});
