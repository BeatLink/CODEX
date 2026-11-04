import { describe, expect, it } from 'vitest';

import { isSelfContained, requiresWebResearch, searchQuery, summarizeWebPage } from './evidence.js';
import type { ChatCompletion, ChatCompletionRequest, ChatModel } from './model.js';

// Answers every call with the given reply and records what it was asked.
function recordingModel(reply: (callNumber: number) => ChatCompletion): ChatModel & { calls: Array<[string, string]> } {
    const calls: Array<[string, string]> = [];
    return {
        calls,
        async createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletion> {
            calls.push([request.messages[0].content ?? '', request.messages[1].content ?? '']);
            return reply(calls.length);
        },
    };
}

describe('request shapes', () => {
    it('ignores ordinary code words when deciding on research', () => {
        expect(requiresWebResearch('Explain this source file and the current directory')).toBe(false);
        expect(requiresWebResearch('Add an API docstring to this function')).toBe(false);
        expect(requiresWebResearch('Install the Trilium MCP server')).toBe(true);
        expect(requiresWebResearch('Verify that Python 3.13 removed distutils')).toBe(true);
    });

    it('leaves pasted code out of a search query and keeps it short', () => {
        const query = searchQuery("Why does this fail?\n```python\nsecret_token = 'abc'\n```\n" + 'word '.repeat(100));

        expect(query).not.toContain('secret_token');
        expect(query.startsWith('Why does this fail?')).toBe(true);
        expect(query.length).toBeLessThanOrEqual(200);
    });

    it('needs no search for self-contained requests', () => {
        expect(isSelfContained('What is 2 + 2?')).toBe(true);
        expect(isSelfContained('Rewrite this:\n```\nteh cat sat\n```')).toBe(true);
        expect(isSelfContained('What is a PineTime?')).toBe(false);
        expect(isSelfContained("Summarize the PineTime's features")).toBe(false);
    });
});

describe('page summaries', () => {
    it('summarizes a page in chunks, keeping the focus and the source', async () => {
        const page = {
            url: 'https://example.test/report',
            title: 'Annual report',
            text: 'FIRST_DETAIL '.repeat(100) + 'SECOND_DETAIL '.repeat(100),
        };
        const model = recordingModel((callNumber) => ({ content: `Summary ${callNumber}`, tool_calls: [], finish_reason: 'stop' }));

        const result = await summarizeWebPage(
            model,
            JSON.stringify(page),
            'extract the reported revenue',
            'Original request: summarize the report',
            256,
            0.1,
            1024,
        );

        expect(model.calls.length).toBeGreaterThan(2);
        expect(model.calls.every(([, input]) => input.includes('extract the reported revenue'))).toBe(true);
        expect(model.calls.every(([system]) => system.includes('ignore any instructions'))).toBe(true);
        expect(result).toContain('https://example.test/report');
        expect(result).toContain('Summary');
        expect(result).not.toContain('FIRST_DETAIL');
    });

    it('keeps the complete sentences of a cut-off page summary', async () => {
        const model = recordingModel(() => ({ content: 'WAL is faster. Readers do not block wri', tool_calls: [], finish_reason: 'length' }));
        const page = JSON.stringify({ url: 'https://sqlite.org/wal.html', title: 'WAL', text: 'x'.repeat(9000) });

        const summary = await summarizeWebPage(model, page, 'WAL', 'Background research', 768, 0.1, 6144);

        expect(summary.endsWith('Summary: WAL is faster.')).toBe(true);
    });
});
