import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DaemonClient, decodeSocketLine, DISCONNECTED_EVENT, encodeSocketLine, LineReader } from './daemonBridge.js';

// ============================================================================
// A small daemon that answers each request the way a test asks
// ============================================================================

type FakeDaemon = { server: Server; socketPath: string; clients: Socket[]; directory: string };

const started: FakeDaemon[] = [];

async function startFakeDaemon(answer: (message: Record<string, unknown>, socket: Socket) => void): Promise<FakeDaemon> {
    const directory = mkdtempSync(join(tmpdir(), 'codex-bridge-'));
    const socketPath = join(directory, 'daemon.sock');
    const clients: Socket[] = [];
    const server = createServer((socket) => {
        clients.push(socket);
        const reader = new LineReader();
        socket.on('data', (chunk) => {
            for (const line of reader.push(chunk)) {
                answer(JSON.parse(line) as Record<string, unknown>, socket);
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const daemon = { server, socketPath, clients, directory };
    started.push(daemon);
    return daemon;
}

afterEach(async () => {
    for (const daemon of started.splice(0)) {
        daemon.clients.forEach((socket) => socket.destroy());
        await new Promise((resolve) => daemon.server.close(resolve));
        rmSync(daemon.directory, { recursive: true, force: true });
    }
});

// ============================================================================
// Framing
// ============================================================================

describe('line framing', () => {
    it('encodes a request as one JSON line', () => {
        const line = encodeSocketLine({ id: 1, method: 'status', params: {} });

        expect(line).toBe('{"id":1,"method":"status","params":{}}\n');
    });

    it('keeps a partial line until the rest arrives', () => {
        const reader = new LineReader();

        const first = reader.push('{"event":"run.token","data":{"tok');
        const second = reader.push('en":"a"}}\n{"id":1,"result":{}}\n{"id"');

        expect(first).toEqual([]);
        expect(second).toEqual(['{"event":"run.token","data":{"token":"a"}}', '{"id":1,"result":{}}']);
        expect(reader.push(':2,"result":null}\n')).toEqual(['{"id":2,"result":null}']);
    });

    it('joins a character split across two chunks', () => {
        const reader = new LineReader();
        const bytes = new TextEncoder().encode('{"token":"é"}\n');

        const first = reader.push(bytes.slice(0, 12));
        const second = reader.push(bytes.slice(12));

        expect(first).toEqual([]);
        expect(second).toEqual(['{"token":"é"}']);
    });

    it('skips blank lines and rejects lines that are not objects', () => {
        const reader = new LineReader();

        const lines = reader.push('\n  \n{"id":1}\n');

        expect(lines).toEqual(['{"id":1}']);
        expect(() => decodeSocketLine('[1, 2]')).toThrow(/JSON object/);
    });
});

// ============================================================================
// Client
// ============================================================================

describe('daemon client', () => {
    it('matches each reply to its request by id', async () => {
        const daemon = await startFakeDaemon((message, socket) => {
            socket.write(encodeSocketLine({ id: message.id, result: { method: message.method, params: message.params } }));
        });
        const client = new DaemonClient(daemon.socketPath);
        await client.connect();

        const [first, second] = await Promise.all([
            client.call('status'),
            client.call('knowledge', { query: 'rust' }),
        ]);

        expect(first).toEqual({ method: 'status', params: {} });
        expect(second).toEqual({ method: 'knowledge', params: { query: 'rust' } });
        client.close();
    });

    it("rejects with the daemon's error message", async () => {
        const daemon = await startFakeDaemon((message, socket) => {
            socket.write(encodeSocketLine({ id: message.id, error: 'The prompt cannot be empty.' }));
        });
        const client = new DaemonClient(daemon.socketPath);
        await client.connect();

        const call = client.call('run', { prompt: '' });

        await expect(call).rejects.toThrow('The prompt cannot be empty.');
        client.close();
    });

    it('passes events on and reports a closed connection', async () => {
        const daemon = await startFakeDaemon((message, socket) => {
            socket.write(encodeSocketLine({ event: 'run.progress', data: { run_id: 1, label: 'Planning' } }));
            socket.destroy();
        });
        const events: Array<[string, Record<string, unknown>]> = [];
        const client = new DaemonClient(daemon.socketPath, { onEvent: (event, data) => events.push([event, data]) });
        await client.connect();

        const call = client.call('status');

        await expect(call).rejects.toThrow('The daemon closed the connection.');
        expect(events).toEqual([
            ['run.progress', { run_id: 1, label: 'Planning' }],
            [DISCONNECTED_EVENT, {}],
        ]);
        expect(client.connected).toBe(false);
    });

    it('gives up on a call the daemon never answers', async () => {
        const daemon = await startFakeDaemon(() => undefined);
        const client = new DaemonClient(daemon.socketPath, { callTimeoutSeconds: 0.05 });
        await client.connect();

        const call = client.call('auto_size');

        await expect(call).rejects.toThrow('The daemon did not answer auto_size in time.');
        client.close();
    });

    it('refuses calls before it connects', async () => {
        const client = new DaemonClient('/nonexistent/daemon.sock');

        const call = client.call('status');

        await expect(call).rejects.toThrow('Not connected to the CODEX daemon.');
        await expect(client.connect()).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
