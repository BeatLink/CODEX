// Finds a running daemon, or starts one as Node from this binary when none answers on the socket.
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DaemonClient, DaemonError, type EventHandler } from './daemonBridge.js';
import { defaultLogPath } from './paths.js';

export const DAEMON_START_TIMEOUT_SECONDS = 30;
// A daemon an interface starts exits this long after its last interface disconnects.
export const STARTED_DAEMON_EXIT_SECONDS = 30;
const CONNECT_RETRY_MILLISECONDS = 100;

export type SpawnFactory = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

// ============================================================================
// Starting the daemon
// ============================================================================

export function daemonEntryScript(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../daemon/index.js');
}

export type DaemonCommand = {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
};

// Builds the command that runs the daemon; ELECTRON_RUN_AS_NODE makes Electron's binary behave as plain Node.
export function daemonCommand(
    socketPath: string,
    settingsPath: string | null,
    options: { execPath?: string; entryScript?: string; environment?: NodeJS.ProcessEnv } = {},
): DaemonCommand {
    const args = [
        options.entryScript ?? daemonEntryScript(),
        '--socket',
        socketPath,
        '--exit-when-unused',
        String(STARTED_DAEMON_EXIT_SECONDS),
    ];
    if (settingsPath !== null) {
        args.push('--settings', path.resolve(settingsPath));
    }
    const env = { ...(options.environment ?? process.env), ELECTRON_RUN_AS_NODE: '1', CODEX_SOCKET_PATH: socketPath };
    return { command: options.execPath ?? process.execPath, args, env };
}

// Starts the daemon in its own session with its output in the daemon log, so it outlives this window.
export function spawnDaemon(
    socketPath: string,
    settingsPath: string | null,
    spawnImpl: SpawnFactory = spawn,
    logPath: string = defaultLogPath(),
): ChildProcess {
    const { command, args, env } = daemonCommand(socketPath, settingsPath);
    mkdirSync(path.dirname(logPath), { recursive: true });
    const logFile = openSync(logPath, 'a');
    try {
        const child = spawnImpl(command, args, { env, stdio: ['ignore', logFile, logFile], detached: true });
        child.unref();
        return child;
    } finally {
        closeSync(logFile);
    }
}

// ============================================================================
// Connecting
// ============================================================================

function isAbsentDaemon(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === 'ENOENT' || code === 'ECONNREFUSED';
}

export type ConnectOptions = {
    settingsPath?: string | null;
    onEvent?: EventHandler | null;
    start?: boolean;
    spawnImpl?: SpawnFactory;
    logPath?: string;
    createClient?: (socketPath: string, onEvent: EventHandler | null) => DaemonClient;
    startTimeoutSeconds?: number;
};

export type Connection = {
    client: DaemonClient;
    started: boolean;
};

// Connects to a running daemon, starting one first when start is true and none answers.
export async function connectToDaemon(socketPath: string, options: ConnectOptions = {}): Promise<Connection> {
    const createClient = options.createClient ?? ((pathName, onEvent) => new DaemonClient(pathName, { onEvent }));
    const client = createClient(socketPath, options.onEvent ?? null);
    try {
        await client.connect();
        return { client, started: false };
    } catch (error) {
        if (!isAbsentDaemon(error) || options.start === false) {
            throw error;
        }
    }
    const logPath = options.logPath ?? defaultLogPath();
    const child = spawnDaemon(socketPath, options.settingsPath ?? null, options.spawnImpl ?? spawn, logPath);
    let exited = false;
    child.once('exit', () => {
        exited = true;
    });
    child.once('error', () => {
        exited = true;
    });
    const deadline = Date.now() + (options.startTimeoutSeconds ?? DAEMON_START_TIMEOUT_SECONDS) * 1000;
    while (Date.now() < deadline) {
        try {
            await client.connect();
            return { client, started: true };
        } catch (error) {
            if (!isAbsentDaemon(error) || exited) {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MILLISECONDS));
        }
    }
    throw new DaemonError(`The CODEX daemon did not start; see ${logPath}.`);
}
