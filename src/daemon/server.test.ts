import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';

import { NodeDaemon } from './server.js';

describe('Node daemon protocol', () => {
    const sockets: string[] = [];

    afterEach(async () => {
        await Promise.all(
            sockets.splice(0).map(async (socketPath) => {
                try {
                    await rmSync(socketPath, { force: true, recursive: true });
                } catch {
                    // ignore cleanup failures
                }
            }),
        );
    });

    it('responds to status and shutdown requests over the JSON-line socket protocol', async () => {
        const socketPath = join(mkdtempSync(join(tmpdir(), 'codex-daemon-')), 'daemon.sock');
        sockets.push(socketPath);

        const daemon = new NodeDaemon(socketPath);
        await daemon.listen();

        const reply = await new Promise<string>((resolve, reject) => {
            const client = connect(socketPath, () => {
                client.write('{"id":"status-1","method":"status","params":{}}\n');
            });

            client.on('data', (chunk) => {
                resolve(String(chunk));
                client.end();
            });

            client.on('error', reject);
        });

        expect(reply).toContain('"id":"status-1"');
        expect(reply).toContain('"result"');

        const shutdownReply = await new Promise<string>((resolve, reject) => {
            const client2 = connect(socketPath, () => {
                client2.write('{"id":"shutdown-1","method":"shutdown","params":{}}\n');
            });

            client2.on('data', (chunk) => {
                resolve(String(chunk));
                client2.end();
            });

            client2.on('error', reject);
        });

        expect(shutdownReply).toContain('"id":"shutdown-1"');
        await daemon.close();
    });
});
