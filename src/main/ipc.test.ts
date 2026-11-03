import { describe, expect, it } from 'vitest';

import { normalizeStatusResponse } from './ipc.js';

describe('status IPC normalization', () => {
    it('accepts a ready daemon payload', () => {
        expect(normalizeStatusResponse({ ready: true, model: 'Qwen3.5-4B' })).toEqual({
            ready: true,
            model: 'Qwen3.5-4B',
        });
    });

    it('rejects empty daemon payloads', () => {
        expect(() => normalizeStatusResponse({})).toThrow(/status/i);
    });
});
