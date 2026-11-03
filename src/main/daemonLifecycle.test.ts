import { describe, expect, it, vi } from 'vitest';

import { ensureDaemonRunning } from './daemonLifecycle.js';

describe('daemon lifecycle', () => {
    it('starts the node daemon when the status probe fails', async () => {
        let attempts = 0;
        const probe = {
            async request(method: string): Promise<unknown> {
                if (method === 'status') {
                    attempts += 1;
                    if (attempts === 1) {
                        throw new Error('daemon not running');
                    }
                    return { ready: true };
                }
                return {};
            },
        };

        const spawnImpl = vi.fn(() => ({
            pid: 4321,
            exitCode: null,
            stderr: { on: vi.fn() },
        }));

        const result = await ensureDaemonRunning(probe as any, spawnImpl as any);

        expect(result.started).toBe(true);
        expect(result.pid).toBe(4321);
        expect(spawnImpl).toHaveBeenCalledTimes(1);
    });
});
