import { describe, expect, it } from 'vitest';

import { chatHistory, grammarSchema, ModelCache, runStage, type ChatCompletion, type ChatCompletionRequest } from './model.js';

function replying(completion: ChatCompletion, streamed: string[] = []) {
    const requests: ChatCompletionRequest[] = [];
    return {
        requests,
        createChatCompletion: async (request: ChatCompletionRequest) => {
            requests.push(request);
            for (const token of streamed) {
                request.on_token?.(token);
            }
            return completion;
        },
    };
}

// ============================================================================
// One call
// ============================================================================

describe('runStage', () => {
    it('streams tokens to the callback and returns the whole reply', async () => {
        const llm = replying({ content: 'First second', tool_calls: [], finish_reason: 'stop' }, ['First ', 'second']);
        const streamed: string[] = [];

        const result = await runStage(llm, 'System', 'Input', { onToken: (token) => streamed.push(token) });

        expect(result).toBe('First second');
        expect(streamed).toEqual(['First ', 'second']);
        expect(llm.requests[0].messages.map((message) => message.role)).toEqual(['system', 'user']);
    });

    it('passes a schema as the response format', async () => {
        const llm = replying({ content: '{}', tool_calls: [], finish_reason: 'stop' });
        const schema = { type: 'object', properties: {} };

        await runStage(llm, 'System', 'Input', { jsonSchema: schema });

        expect(llm.requests[0].response_format).toEqual({ type: 'json_object', schema });
    });

    it('keeps a cut-off reply’s complete sentences only when asked', async () => {
        const cutOff = replying({ content: 'WAL is faster. Readers do not block wri', tool_calls: [], finish_reason: 'length' });
        await expect(runStage(cutOff, 'System', 'Input')).rejects.toThrow('token limit');
        await expect(runStage(cutOff, 'System', 'Input', { keepCutOff: true })).resolves.toBe('WAL is faster.');

        const noSentence = replying({ content: 'Readers do not block wri', tool_calls: [], finish_reason: 'length' });
        await expect(runStage(noSentence, 'System', 'Input', { keepCutOff: true })).rejects.toThrow('token limit');
    });

    it('refuses an empty reply', async () => {
        const llm = replying({ content: '  ', tool_calls: [], finish_reason: 'stop' });

        await expect(runStage(llm, 'System', 'Input')).rejects.toThrow('empty completion');
    });
});

// ============================================================================
// Conversions
// ============================================================================

describe('chatHistory', () => {
    it('pairs each tool call with the result that answered it', () => {
        const history = chatHistory([
            { role: 'system', content: 'S' },
            { role: 'user', content: 'U' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{"path":"x"}' } }] },
            { role: 'tool', tool_call_id: 'a', content: 'contents' },
        ]);

        expect(history).toEqual([
            { type: 'system', text: 'S' },
            { type: 'user', text: 'U' },
            { type: 'model', response: [{ type: 'functionCall', name: 'read_file', params: { path: 'x' }, result: 'contents' }] },
        ]);
    });
});

describe('grammarSchema', () => {
    it('drops keywords the grammar cannot express and requires every listed property', () => {
        const schema = {
            type: 'object',
            properties: { count: { type: 'integer', minimum: 0, maximum: 5 }, names: { type: 'array', items: { type: 'string', pattern: 'x' }, maxItems: 3 } },
        };

        expect(grammarSchema(schema)).toEqual({
            type: 'object',
            properties: { count: { type: 'integer' }, names: { type: 'array', items: { type: 'string' }, maxItems: 3 } },
            required: ['count', 'names'],
        });
    });
});

// ============================================================================
// Model cache
// ============================================================================

describe('ModelCache', () => {
    it('reports nothing loaded until a model is', async () => {
        const cache = new ModelCache();

        expect(cache.has('model.gguf', 4096, -1)).toBe(false);
        await expect(cache.unload()).resolves.toBe(false);
    });
});
