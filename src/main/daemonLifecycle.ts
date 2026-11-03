import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type DaemonProbe = {
    request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
};

export type SpawnFactory = (...args: any[]) => ChildProcess;

export function daemonEntryScript(): string {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    return path.resolve(__dirname, '../daemon/index.js');
}

export function startNodeDaemon(socketPath: string | undefined, spawnImpl: SpawnFactory = spawn): ChildProcess {
    const env = { ...process.env };
    if (socketPath) {
        env.CODEX_SOCKET_PATH = socketPath;
    }

    return spawnImpl(process.execPath, [daemonEntryScript()], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

export async function ensureDaemonRunning(
    probe: DaemonProbe,
    spawnImpl: SpawnFactory = spawn,
    socketPath?: string,
): Promise<{ started: boolean; pid?: number; process?: ChildProcess }> {
    try {
        await probe.request('status');
        return { started: false };
    } catch {
        const child = startNodeDaemon(socketPath, spawnImpl);

        for (let attempt = 0; attempt < 25; attempt += 1) {
            try {
                await probe.request('status');
                return { started: true, pid: child.pid ?? undefined, process: child };
            } catch {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        }

        if (child.exitCode !== null) {
            throw new Error(`CODEX daemon exited before responding to status checks: ${child.exitCode}`);
        }

        return { started: true, pid: child.pid ?? undefined, process: child };
    }
}
