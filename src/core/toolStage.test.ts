import { describe, expect, it } from 'vitest';

import { runToolStage, textToolCalls } from './toolStage.js';

describe('toolStage', () => {
    it('parses XML and JSON tool calls from assistant text', () => {
        const xml = '<tool_call>\n<function=lookup>\n<parameter=term>\nalpha\n</parameter>\n</function>\n</tool_call>';
        const json = '{"name": "lookup", "arguments": {"term": "beta"}}';

        const xmlParsed = textToolCalls(xml, [
            { function: { name: 'lookup', parameters: { type: 'object', properties: { term: { type: 'string' } } } } },
        ]);
        const jsonParsed = textToolCalls(json, [
            { function: { name: 'lookup', parameters: { type: 'object', properties: { term: { type: 'string' } } } } },
        ]);

        expect(xmlParsed).toHaveLength(1);
        expect(jsonParsed).toHaveLength(1);
        expect(xmlParsed[0].function.name).toBe('lookup');
        expect(jsonParsed[0].function.name).toBe('lookup');
    });

    it('runs tool calls and returns the final model response', async () => {
        const calls: string[] = [];
        const llm = {
            createChatCompletion: (request: Record<string, unknown>) => {
                if (calls.length === 0) {
                    calls.push('first');
                    return {
                        choices: [{
                            finish_reason: null,
                            message: {
                                tool_calls: [{
                                    id: 'call-1',
                                    type: 'function',
                                    function: { name: 'lookup', arguments: '{"term":"alpha"}' },
                                }],
                            },
                        }],
                    };
                }
                return {
                    choices: [{
                        finish_reason: 'stop',
                        message: { content: 'Done.' },
                    }],
                };
            },
        };

        const toolbox = {
            call: (name: string, args: Record<string, unknown>) => {
                if (name === 'lookup') {
                    return `Looked up ${String((args as { term?: string }).term ?? '')}`;
                }
                return `Tool ${name} ran`;
            },
            toolDefinitions: [{ function: { name: 'lookup', parameters: { type: 'object', properties: { term: { type: 'string' } } } } }],
        };

        const result = await runToolStage(llm as any, 'system', 'query', toolbox as any, 64, 0.2, 2);
        expect(result).toContain('Done');
        expect(result).toContain('Looked up alpha');
    });
});
