import { afterEach, describe, expect, it } from 'vitest';

import { buildRequest, decodeMessage, defaultLogPath, defaultSocketPath, encodeMessage, isSuccessfulResponse } from './protocol.js';

const saved = { runtime: process.env.XDG_RUNTIME_DIR, state: process.env.XDG_STATE_HOME };

afterEach(() => {
    for (const [name, value] of [
        ['XDG_RUNTIME_DIR', saved.runtime],
        ['XDG_STATE_HOME', saved.state],
    ] as const) {
        if (value === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = value;
        }
    }
});

describe('protocol', () => {
    it('builds a request envelope', () => {
        const request = buildRequest('status', { include_background: true });

        expect(request.method).toBe('status');
        expect(request.params).toEqual({ include_background: true });
        expect(request.id).toMatch(/^status-/);
    });

    it('tells a reply with a result from an error or an event', () => {
        expect(isSuccessfulResponse({ id: 'run-1', result: { ok: true } })).toBe(true);
        expect(isSuccessfulResponse({ id: 'run-1', error: 'nope' })).toBe(false);
        expect(isSuccessfulResponse({ event: 'run.started', data: {} })).toBe(false);
    });

    it('writes each message as one line and reads it back', () => {
        const encoded = encodeMessage({ id: '1', method: 'run', params: { prompt: 'café\nnext' } });

        expect(encoded.toString('utf-8').endsWith('\n')).toBe(true);
        expect(encoded.toString('utf-8').trimEnd()).not.toContain('\n');
        expect(decodeMessage(encoded)).toEqual({ id: '1', method: 'run', params: { prompt: 'café\nnext' } });
        expect(() => decodeMessage('[1, 2]')).toThrow('Each message must be a JSON object.');
    });

    it('puts the socket in the runtime folder and the log in the state folder', () => {
        process.env.XDG_RUNTIME_DIR = '/run/user/1000';
        process.env.XDG_STATE_HOME = '/home/someone/.state';

        expect(defaultSocketPath()).toBe('/run/user/1000/codex/daemon.sock');
        expect(defaultLogPath()).toBe('/home/someone/.state/codex/daemon.log');

        delete process.env.XDG_RUNTIME_DIR;
        expect(defaultSocketPath()).toMatch(/codex-\d+\/daemon\.sock$/);
    });
});
