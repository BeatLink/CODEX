import { describe, expect, it } from 'vitest';

import { buildRequest, isSuccessfulResponse, type DaemonRequest } from './protocol.js';

describe('protocol helpers', () => {
    it('builds a daemon request envelope', () => {
        const request = buildRequest('status', { include_background: true });

        expect(request.method).toBe('status');
        expect(request.params).toEqual({ include_background: true });
        expect(request.id).toMatch(/^status-/);
    });

    it('detects successful backend responses', () => {
        const success: DaemonRequest = {
            id: 'run-1',
            method: 'run',
            params: { prompt: 'draft a plan' },
        };

        expect(isSuccessfulResponse({ id: 'run-1', result: { ok: true } })).toBe(true);
        expect(isSuccessfulResponse({ id: 'run-1', error: 'nope' })).toBe(false);
        expect(isSuccessfulResponse({ event: 'run.started', data: success })).toBe(false);
    });
});
