import { describe, expect, it, vi } from 'vitest';

import type { ChatCompletion, ChatCompletionRequest, ChatModel, ToolDefinition } from './model.js';
import { ANSWER_NOW_CALL_NOTE, MODEL_WORDS_LABEL, REPEATED_CALL_NOTE, callIsValid, pythonJsonLength, runToolStage, textToolCalls, type ToolCallRecord } from './toolStage.js';
import { TOOL_RESULTS_LABEL } from './contextBudget.js';
import { TOOL_DEFINITIONS } from './tools.js';

// Records each call and answers it with the given output.
class FakeToolbox {
    readonly calls: Array<[string, unknown]> = [];

    constructor(
        private readonly answer: (name: string, argumentsGiven: Record<string, unknown>) => string = () => 'sample tool output',
        readonly toolDefinitions: ToolDefinition[] = TOOL_DEFINITIONS,
    ) {}

    async call(name: string, argumentsGiven: unknown): Promise<string> {
        this.calls.push([name, argumentsGiven]);
        return this.answer(name, argumentsGiven as Record<string, unknown>);
    }
}

// Replays one reply per call; a reply given as tokens is streamed through on_token.
class FakeModel implements ChatModel {
    readonly requests: ChatCompletionRequest[] = [];

    constructor(private readonly replies: Array<ChatCompletion | { tokens: string[] }>) {}

    async createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletion> {
        this.requests.push({ ...request, messages: structuredClone(request.messages) });
        const reply = this.replies.shift();
        if (reply === undefined) {
            throw new Error('No reply left.');
        }
        if ('tokens' in reply) {
            reply.tokens.forEach((token) => request.on_token?.(token));
            return { content: reply.tokens.join(''), tool_calls: [], finish_reason: 'stop' };
        }
        return reply;
    }
}

function toolCallReply(callId = 'call-1', name = 'read_file', argumentsGiven: Record<string, unknown> = { path: 'notes.txt' }): ChatCompletion {
    return { content: '', tool_calls: [{ id: callId, type: 'function', function: { name, arguments: JSON.stringify(argumentsGiven) } }], finish_reason: 'tool_calls' };
}

// A connected tool, named as the MCP toolbox names its tools.
const LIST_EVENTS: ToolDefinition = {
    type: 'function',
    function: { name: 'mcp__calendar__list_events', description: 'List calendar events', parameters: { type: 'object', properties: { day: { type: 'string' } } } },
};

function textReply(content: string): ChatCompletion {
    return { content, tool_calls: [], finish_reason: 'stop' };
}

// ============================================================================
// The stage
// ============================================================================

describe('tool stage', () => {
    it('summarizes a fetched page before it returns to the loop', async () => {
        const toolbox = new FakeToolbox((_name, given) =>
            JSON.stringify({ url: 'https://example.test/page', title: 'Page title', text: 'FULL PAGE CONTENT THAT MUST NOT ENTER THE MAIN LOOP', focus: given.focus }),
        );
        const model = new FakeModel([toolCallReply('call-1', 'web_fetch', { url: 'https://example.test/page', focus: 'the date' }), textReply('Research complete.')]);
        const summarized: Array<[string, string, string]> = [];

        const result = await runToolStage(model, 'Research only.', 'Find the publication date.', toolbox, 200, 0.1, 3, {
            allowedTools: new Set(['web_fetch']),
            pageSummarizer: async (pageJson, focus, requestContext) => {
                summarized.push([pageJson, focus, requestContext]);
                return 'Source URL: https://example.test/page\nRelevant date: 2026';
            },
        });

        expect(model.requests[0].tools?.map((tool) => tool.function.name)).toEqual(['web_fetch']);
        const returnedToModel = model.requests[1].messages.at(-1)?.content ?? '';
        expect(returnedToModel).toContain('Relevant date: 2026');
        expect(returnedToModel).not.toContain('FULL PAGE CONTENT');
        expect(summarized[0][1]).toBe('the date');
        expect(summarized[0][2]).toContain('Find the publication date');
        expect(result).toContain('Relevant date: 2026');
    });

    it('says when no summarizer can read a fetched page', async () => {
        const toolbox = new FakeToolbox(() => '{"url": "https://example.test/"}');
        const model = new FakeModel([toolCallReply('call-1', 'web_fetch', { url: 'https://example.test/' }), textReply('Done.')]);

        const result = await runToolStage(model, 'Research.', 'Read it.', toolbox, 200, 0.1, 3);

        expect(result).toContain('Tool error: webpage summarization is unavailable.');
    });

    it('does not offer blocked tools', async () => {
        const model = new FakeModel([textReply('No research tools available.')]);

        await runToolStage(model, 'Execute planned actions.', 'Update the requested file.', new FakeToolbox(), 200, 0.1, 3, {
            blockedTools: new Set(['web_search', 'web_fetch']),
        });

        const offered = new Set(model.requests[0].tools?.map((tool) => tool.function.name));
        expect(offered.has('web_search')).toBe(false);
        expect(offered.has('web_fetch')).toBe(false);
        expect(offered.has('write_file')).toBe(true);
    });

    it('refuses a call to a tool the stage does not allow', async () => {
        const toolbox = new FakeToolbox();
        const model = new FakeModel([toolCallReply('call-1', 'write_file', { path: 'a', content: 'b' }), textReply('Done.')]);

        const result = await runToolStage(model, 'Research.', 'Look.', toolbox, 200, 0.1, 3, { allowedTools: new Set(['read_file']) });

        expect(toolbox.calls).toEqual([]);
        expect(result).toContain("Tool error: tool 'write_file' is not allowed in this stage.");
    });

    it('streams the reply through the token callback', async () => {
        const toolbox = new FakeToolbox();
        const model = new FakeModel([toolCallReply(), { tokens: ['Here ', 'it is.'] }]);
        const streamed: string[] = [];

        const result = await runToolStage(model, 'Use tools when useful.', 'Read notes.txt.', toolbox, 200, 0.1, 3, {
            onToken: (token) => streamed.push(token),
        });

        expect(toolbox.calls).toEqual([['read_file', { path: 'notes.txt' }]]);
        expect(streamed).toEqual(['Here ', 'it is.']);
        expect(model.requests[0].on_token).toBeTypeOf('function');
        expect(result).toContain('Here it is.');
    });

    it('runs a tool and returns its fenced result to the model', async () => {
        const toolbox = new FakeToolbox();
        const model = new FakeModel([toolCallReply(), textReply('Here is the result.')]);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const result = await runToolStage(model, 'Use tools when useful.', 'Read notes.txt.', toolbox, 200, 0.1, 3);

        // A native call needs no text parsing, so nothing is reported.
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
        expect(toolbox.calls).toEqual([['read_file', { path: 'notes.txt' }]]);
        const last = model.requests[1].messages.at(-1);
        expect(last?.role).toBe('tool');
        expect(last?.tool_call_id).toBe('call-1');
        expect(last?.content).toBe('<untrusted-data>\nsample tool output\n</untrusted-data>');
        expect(model.requests[1].messages[2].tool_calls?.[0].function.name).toBe('read_file');
        expect(result).toContain('sample tool output');
    });

    it('runs a tool call written as Qwen XML text', async () => {
        const toolbox = new FakeToolbox();
        const written =
            'I will save it.\n<tool_call>\n<function=write_file>\n<parameter=path>\nanswer.txt\n</parameter>\n' +
            '<parameter=content>\n42\n</parameter>\n</function>\n</tool_call>';
        const model = new FakeModel([textReply(written), textReply('Saved answer.txt.')]);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const result = await runToolStage(model, 'Use tools when useful.', 'Save 42.', toolbox, 200, 0.1, 3);

        // A call read from text is reported, since native parsing should have caught it.
        expect(warn).toHaveBeenCalledWith('Tool calls arrived as text and were read by textToolCalls: write_file');
        warn.mockRestore();

        // A string parameter keeps its text even when it looks like a number.
        expect(toolbox.calls).toEqual([['write_file', { path: 'answer.txt', content: '42' }]]);
        const replayed = model.requests[1].messages[2];
        expect(replayed.content).toBe('I will save it.');
        expect(replayed.tool_calls?.[0].function.name).toBe('write_file');
        expect(result).toContain('Saved answer.txt.');
    });

    it('runs a tool call written as JSON text with typed arguments', async () => {
        const toolbox = new FakeToolbox();
        const written = '<tool_call>\n{"name": "web_search", "arguments": {"query": "sqlite wal", "max_results": 3}}\n</tool_call>';
        const model = new FakeModel([textReply(written), textReply('Found it.')]);

        await runToolStage(model, 'Use tools when useful.', 'Search.', toolbox, 200, 0.1, 3);

        expect(toolbox.calls).toEqual([['web_search', { query: 'sqlite wal', max_results: 3 }]]);
    });

    it('stops after the tool-call limit and keeps the results', async () => {
        const toolbox = new FakeToolbox();
        const model = new FakeModel([toolCallReply('call-1'), toolCallReply('call-2')]);

        const result = await runToolStage(model, 'Use tools when useful.', 'Read notes.txt.', toolbox, 200, 0.1, 1);

        expect(model.requests[1].tool_choice).toBe('none');
        expect(toolbox.calls).toHaveLength(1);
        expect(result).toContain('tool-call limit was reached');
        expect(result).toContain('sample tool output');
    });

    it('records each call in order with whether its arguments were valid and whether it failed', async () => {
        const toolbox = new FakeToolbox((_name, given) => (given.path ? 'sample tool output' : 'Tool error: no path given.'));
        const severalCalls: ChatCompletion = {
            content: '',
            tool_calls: [
                { id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"notes.txt"}' } },
                { id: 'call-2', type: 'function', function: { name: 'read_file', arguments: '{"file":"notes.txt"}' } },
                { id: 'call-3', type: 'function', function: { name: 'write_file', arguments: '{"path":"notes.txt","content":""}' } },
            ],
            finish_reason: 'tool_calls',
        };
        const model = new FakeModel([severalCalls, toolCallReply('call-4'), toolCallReply('call-5')]);
        const records: ToolCallRecord[] = [];

        await runToolStage(model, 'Use tools when useful.', 'Read notes.txt.', toolbox, 200, 0.1, 3, {
            allowedTools: new Set(['read_file']),
            onToolCall: (call) => records.push(call),
        });

        expect(records.map(({ name, valid, error }) => [name, valid, error])).toEqual([
            ['read_file', true, false],
            ['read_file', false, true],
            ['write_file', false, true],
            // A repeat of a call that worked, then a call made past the limit.
            ['read_file', true, false],
            ['read_file', true, true],
        ]);
        expect(records[1].arguments).toBe('{"file":"notes.txt"}');
    });

    it('checks arguments against the offered schema only', () => {
        expect(callIsValid('read_file', '{"path":"a.txt"}', TOOL_DEFINITIONS)).toBe(true);
        expect(callIsValid('read_file', '{"path":""}', TOOL_DEFINITIONS)).toBe(false);
        expect(callIsValid('read_file', 'not json', TOOL_DEFINITIONS)).toBe(false);
        expect(callIsValid('read_file', '["a.txt"]', TOOL_DEFINITIONS)).toBe(false);
        expect(callIsValid('mcp__calendar__list_events', '{}', TOOL_DEFINITIONS)).toBe(false);
        expect(callIsValid('mcp__calendar__list_events', '{"day":"monday"}', [LIST_EVENTS])).toBe(true);
    });

    it('answers a repeated call from the earlier result and counts it toward the limit', async () => {
        const toolbox = new FakeToolbox();
        const reordered: ChatCompletion = {
            content: '',
            tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'read_file', arguments: '{ "path" : "notes.txt" }' } }],
            finish_reason: 'tool_calls',
        };
        const model = new FakeModel([toolCallReply('call-1'), reordered, toolCallReply('call-3'), toolCallReply('call-4')]);

        const result = await runToolStage(model, 'Use tools when useful.', 'Read notes.txt.', toolbox, 200, 0.1, 3);

        expect(toolbox.calls).toHaveLength(1);
        const repeated = model.requests[2].messages.at(-1)?.content ?? '';
        expect(repeated).toContain(REPEATED_CALL_NOTE);
        expect(repeated).toContain('sample tool output');
        expect(model.requests[3].tool_choice).toBe('none');
        expect(result).toContain('tool-call limit was reached');
    });

    it('makes the model answer once a connected tool answered and it only repeats the call', async () => {
        const toolbox = new FakeToolbox(() => 'Dentist at 10:00', [...TOOL_DEFINITIONS, LIST_EVENTS]);
        const model = new FakeModel([
            toolCallReply('call-1', LIST_EVENTS.function.name, { day: 'today' }),
            toolCallReply('call-2', LIST_EVENTS.function.name, { day: 'today' }),
            textReply('The next meeting is the dentist at 10:00.'),
        ]);

        const result = await runToolStage(model, 'Act.', 'When is my next meeting?', toolbox, 200, 0.1, 8);

        expect(model.requests.map((request) => request.tool_choice)).toEqual(['auto', 'auto', 'none']);
        expect(toolbox.calls).toHaveLength(1);
        expect(result).toContain('The next meeting is the dentist at 10:00.');
    });

    it('makes the model answer after two rounds without a new tool once a connected tool answered', async () => {
        const toolbox = new FakeToolbox(() => 'No events', [...TOOL_DEFINITIONS, LIST_EVENTS]);
        const model = new FakeModel([
            toolCallReply('call-1', LIST_EVENTS.function.name, { day: 'monday' }),
            toolCallReply('call-2', LIST_EVENTS.function.name, { day: 'tuesday' }),
            toolCallReply('call-3', LIST_EVENTS.function.name, { day: 'wednesday' }),
            textReply('Nothing this week.'),
        ]);

        await runToolStage(model, 'Act.', 'Am I free this week?', toolbox, 200, 0.1, 8);

        expect(model.requests.map((request) => request.tool_choice)).toEqual(['auto', 'auto', 'auto', 'none']);
        expect(toolbox.calls).toHaveLength(3);
    });

    it('does not run a call written as text on a turn told to answer', async () => {
        const toolbox = new FakeToolbox(() => 'Dentist at 10:00', [...TOOL_DEFINITIONS, LIST_EVENTS]);
        const written = '<tool_call>\n{"name": "mcp__calendar__list_events", "arguments": {"day": "tomorrow"}}\n</tool_call>';
        const model = new FakeModel([
            toolCallReply('call-1', LIST_EVENTS.function.name, { day: 'today' }),
            toolCallReply('call-2', LIST_EVENTS.function.name, { day: 'today' }),
            textReply(written),
        ]);

        const result = await runToolStage(model, 'Act.', 'When is my next meeting?', toolbox, 200, 0.1, 8);

        expect(model.requests.map((request) => request.tool_choice)).toEqual(['auto', 'auto', 'none']);
        expect(toolbox.calls).toHaveLength(1);
        expect(result).toContain(ANSWER_NOW_CALL_NOTE);
        expect(result).toContain('Dentist at 10:00');
    });

    it('keeps tools open when only a built-in tool or a failed connected call answered', async () => {
        const builtIn = new FakeModel([toolCallReply('call-1'), toolCallReply('call-2'), textReply('Done.')]);
        await runToolStage(builtIn, 'Act.', 'Read notes.txt.', new FakeToolbox(), 200, 0.1, 8);

        const failing = new FakeToolbox(() => 'MCP tool error: calendar offline', [...TOOL_DEFINITIONS, LIST_EVENTS]);
        const failed = new FakeModel([
            toolCallReply('call-1', LIST_EVENTS.function.name, { day: 'today' }),
            toolCallReply('call-2', LIST_EVENTS.function.name, { day: 'today' }),
            textReply('The calendar is offline.'),
        ]);
        await runToolStage(failed, 'Act.', 'When is my next meeting?', failing, 200, 0.1, 8);

        expect(builtIn.requests.map((request) => request.tool_choice)).toEqual(['auto', 'auto', 'auto']);
        expect(failed.requests.map((request) => request.tool_choice)).toEqual(['auto', 'auto', 'auto']);
    });

    it('puts the tool results before the model\'s own words, and leaves them out when no tool ran', async () => {
        const toolbox = new FakeToolbox();
        const model = new FakeModel([toolCallReply('call-1'), textReply('The file holds notes.')]);

        const result = await runToolStage(model, 'Use tools when useful.', 'Read notes.txt.', toolbox, 200, 0.1, 3);

        expect(result.startsWith(TOOL_RESULTS_LABEL)).toBe(true);
        expect(result.indexOf('sample tool output')).toBeLessThan(result.indexOf(MODEL_WORDS_LABEL));
        expect(result.endsWith(`${MODEL_WORDS_LABEL}\nThe file holds notes.`)).toBe(true);

        const plain = await runToolStage(new FakeModel([textReply('No tools needed.')]), 'Use tools.', 'Hi.', new FakeToolbox(), 200, 0.1, 3);
        expect(plain).toBe('No tools needed.');
    });

    it('trims tool output to the context window', async () => {
        const toolbox = new FakeToolbox(() => 'z'.repeat(50_000));
        const model = new FakeModel([toolCallReply('call-1'), textReply('Done.')]);

        await runToolStage(model, 'Use tools when useful.', 'Read notes.txt.', toolbox, 1024, 0.1, 1, { contextSize: 2048 });

        const sent = model.requests[1];
        const sentChars = sent.messages.reduce((total, message) => total + pythonJsonLength(message), 0) + pythonJsonLength(sent.tools);
        expect(sentChars).toBeLessThanOrEqual((2048 - 1024) * 3);
    });

    it('reports bad arguments, a cut-off reply, an empty reply and a bad limit', async () => {
        const badArguments = new FakeModel([
            { content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{' } }], finish_reason: 'tool_calls' },
            textReply('Sorry.'),
        ]);

        expect(await runToolStage(badArguments, 'S.', 'U.', new FakeToolbox(), 200, 0.1, 3)).toContain('Tool error: invalid JSON arguments:');
        await expect(runToolStage(new FakeModel([{ content: 'x', tool_calls: [], finish_reason: 'length' }]), 'S.', 'U.', new FakeToolbox(), 200, 0.1, 3)).rejects.toThrow(
            /reached the token limit/,
        );
        await expect(runToolStage(new FakeModel([textReply('  ')]), 'S.', 'U.', new FakeToolbox(), 200, 0.1, 3)).rejects.toThrow('The model returned an empty tool-stage response.');
        await expect(runToolStage(new FakeModel([]), 'S.', 'U.', new FakeToolbox(), 200, 0.1, 11)).rejects.toThrow('max_tool_calls must be between 1 and 10.');
    });
});

// ============================================================================
// Text tool calls
// ============================================================================

describe('text tool calls', () => {
    it('reads untyped parameters as JSON when they parse and skips broken blocks', () => {
        const content = '<tool_call><function=unknown_tool><parameter=count>\n7\n</parameter><parameter=word>\nseven\n</parameter></function></tool_call><tool_call>{broken</tool_call>';

        const calls = textToolCalls(content, TOOL_DEFINITIONS);

        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual({ id: 'text-call-1', type: 'function', function: { name: 'unknown_tool', arguments: '{"count":7,"word":"seven"}' } });
        expect(textToolCalls(null, TOOL_DEFINITIONS)).toEqual([]);
        expect(textToolCalls('<tool_call>{"name": "read_file", "arguments": []}', TOOL_DEFINITIONS)[0].function.arguments).toBe('{}');
    });

    it("reads Spark's arg_key form, with or without arguments", () => {
        const content =
            '<tool_call>read_file<arg_key>path</arg_key><arg_value>mail.md</arg_value></tool_call>' +
            '<tool_call>unknown_tool\n<arg_key>count</arg_key>\n<arg_value>7</arg_value>\n</tool_call>' +
            '<tool_call>list_inbox</tool_call>';

        const calls = textToolCalls(content, TOOL_DEFINITIONS);

        expect(calls.map((call) => [call.function.name, call.function.arguments])).toEqual([
            ['read_file', '{"path":"mail.md"}'],
            ['unknown_tool', '{"count":7}'],
            ['list_inbox', '{}'],
        ]);
    });
});
