import { describe, expect, it } from 'vitest';

import { decodeSocketLine, encodeSocketLine, parseDaemonResult } from './daemonBridge.js';

describe('daemon bridge messages', () => {
    it('encodes a request as a single JSON line', () => {
        expect(encodeSocketLine({ id: 'status-1', method: 'status', params: { include_background: true } })).toBe(
            '{"id":"status-1","method":"status","params":{"include_background":true}}\n',
        );
    });

    it('decodes a run event from the daemon', () => {
        expect(decodeSocketLine('{"event":"run.started","data":{"run_id":3}}\n')).toEqual({
            event: 'run.started',
            data: { run_id: 3 },
        });
    });

    it('returns the successful payload for a daemon response', () => {
        expect(parseDaemonResult({ id: 'status-1', result: { ready: true } })).toEqual({ ready: true });
        expect(() => parseDaemonResult({ id: 'status-1', error: 'boom' })).toThrow(/boom/);
    });
});
