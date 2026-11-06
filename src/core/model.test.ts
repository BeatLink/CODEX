import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
    chatHistory,
    grammarSchema,
    isRepeating,
    ModelCache,
    REPEAT_WINDOW_CHARS,
    runStage,
    type ChatCompletion,
    type ChatCompletionRequest,
} from './model.js';

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

    it('refuses a reply that was stopped for repeating itself', async () => {
        const looping = replying({ content: "'One' rhymes with 'one'.", tool_calls: [], finish_reason: 'repetition' });

        await expect(runStage(looping, 'System', 'Input', { keepCutOff: true })).rejects.toThrow('kept repeating itself');
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

// ============================================================================
// Repetition
// ============================================================================

const TENS = ['Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy'];
const ONES = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

const PROSE =
    'The daemon keeps one model loaded and hands it to each run in turn, so a second request waits rather than ' +
    'loading another copy. Background research pauses while a request is active and picks up again once the window ' +
    'is idle. Settings changed in the Options page apply to the next run; the model is reloaded only when its path, ' +
    'context size or GPU layers change. Each task in the tree is decided, written and checked, and a task that fails ' +
    'its check is revised once before it is split into smaller parts. Results from earlier tasks are condensed when ' +
    'they no longer fit, keeping the newest ones whole. The knowledge store records every page a search reads, with ' +
    'the facts drawn from it and the date it was fetched, so a later question about the same topic can be answered ' +
    'without going back to the web. Pages older than the refresh interval are fetched again when a run needs them. ' +
    'Mail is read from the folders and accounts listed in the settings, and replies are drafted but never sent. ' +
    'When a run is cancelled, the tree is saved as it stands, and the Resume button carries on from the task that ' +
    'was in progress. Connected tools are offered only to tasks that act, and each call is shown for approval first.';

describe('isRepeating', () => {
    it('spots a reply listing the same sentence with only the number changed', () => {
        const looping = TENS.flatMap((tens) => ONES.map((ones) => `'${tens}-${ones}' rhymes with '${tens.toLowerCase()}-${ones}'. `)).join('');

        expect(isRepeating(looping)).toBe(true);
    });

    it('leaves prose, short replies and repetitive data alone', () => {
        const catalogue = readFileSync(new URL('../../evals/fake_catalogue.json', import.meta.url), 'utf-8');

        expect(PROSE.length).toBeGreaterThanOrEqual(REPEAT_WINDOW_CHARS);
        expect(isRepeating(PROSE)).toBe(false);
        expect(isRepeating('ha '.repeat(100))).toBe(false);
        for (let end = REPEAT_WINDOW_CHARS; end <= catalogue.length; end += 200) {
            expect(isRepeating(catalogue.slice(0, end))).toBe(false);
        }
    });
});
