import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { connectToDaemon, daemonCommand, STARTED_DAEMON_EXIT_SECONDS, type SpawnFactory } from './daemonLifecycle.js';

const directories: string[] = [];
const servers: Server[] = [];

function scratchDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), 'codex-lifecycle-'));
    directories.push(directory);
    return directory;
}

function listen(socketPath: string): Promise<Server> {
    const server = createServer((socket) => socket.on('data', () => undefined));
    servers.push(server);
    return new Promise((resolve) => server.listen(socketPath, () => resolve(server)));
}

function fakeChild(): ChildProcess {
    const child = new EventEmitter() as ChildProcess;
    child.unref = vi.fn();
    return child;
}

afterEach(async () => {
    for (const server of servers.splice(0)) {
        await new Promise((resolve) => server.close(resolve));
    }
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

// ============================================================================
// The daemon command
// ============================================================================

describe('daemon command', () => {
    it('runs the entry script as Node with the socket and the unused exit', () => {
        const command = daemonCommand('/run/codex/daemon.sock', null, {
            execPath: '/nix/store/electron',
            entryScript: '/app/dist/daemon/index.js',
            environment: { PATH: '/bin' },
        });

        expect(command.command).toBe('/nix/store/electron');
        expect(command.args).toEqual([
            '/app/dist/daemon/index.js',
            '--socket',
            '/run/codex/daemon.sock',
            '--exit-when-unused',
            String(STARTED_DAEMON_EXIT_SECONDS),
        ]);
        expect(command.env.ELECTRON_RUN_AS_NODE).toBe('1');
        expect(command.env.PATH).toBe('/bin');
    });

    it('passes the settings file as an absolute path', () => {
        const command = daemonCommand('/tmp/daemon.sock', 'settings.json', { entryScript: 'index.js', environment: {} });

        expect(command.args.slice(-2)).toEqual(['--settings', join(process.cwd(), 'settings.json')]);
    });
});

// ============================================================================
// Connecting and starting
// ============================================================================

describe('connecting to the daemon', () => {
    it('uses a daemon that already answers without starting one', async () => {
        const socketPath = join(scratchDirectory(), 'daemon.sock');
        await listen(socketPath);
        const spawnImpl = vi.fn();

        const connection = await connectToDaemon(socketPath, { spawnImpl: spawnImpl as unknown as SpawnFactory });

        expect(connection.started).toBe(false);
        expect(spawnImpl).not.toHaveBeenCalled();
        connection.client.close();
    });

    it('starts a daemon when none answers and connects once it listens', async () => {
        const directory = scratchDirectory();
        const socketPath = join(directory, 'daemon.sock');
        const logPath = join(directory, 'state', 'daemon.log');
        const spawnImpl = vi.fn((_command: string, args: string[]) => {
            setTimeout(() => void listen(args[2]), 150);
            return fakeChild();
        });

        const connection = await connectToDaemon(socketPath, { spawnImpl: spawnImpl as unknown as SpawnFactory, logPath });

        expect(connection.started).toBe(true);
        expect(spawnImpl).toHaveBeenCalledTimes(1);
        expect(spawnImpl.mock.calls[0][1]).toContain('--exit-when-unused');
        expect(existsSync(logPath)).toBe(true);
        connection.client.close();
    });

    it('reports the log when the started daemon exits without listening', async () => {
        const directory = scratchDirectory();
        const logPath = join(directory, 'daemon.log');
        const spawnImpl = vi.fn(() => {
            const child = fakeChild();
            setTimeout(() => child.emit('exit', 1), 20);
            return child;
        });

        const connecting = connectToDaemon(join(directory, 'daemon.sock'), { spawnImpl: spawnImpl as unknown as SpawnFactory, logPath });

        await expect(connecting).rejects.toThrow(`The CODEX daemon did not start; see ${logPath}.`);
    });

    it('does not start a daemon when told not to', async () => {
        const spawnImpl = vi.fn();

        const connecting = connectToDaemon(join(scratchDirectory(), 'daemon.sock'), {
            start: false,
            spawnImpl: spawnImpl as unknown as SpawnFactory,
        });

        await expect(connecting).rejects.toMatchObject({ code: 'ENOENT' });
        expect(spawnImpl).not.toHaveBeenCalled();
    });
});
