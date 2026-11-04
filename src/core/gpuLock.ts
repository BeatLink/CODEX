// Share the GPU with other programs through one lock file, so two model loads never crash each other.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, readdirSync, readlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// llama.cpp aborts the whole process when the GPU runs out of memory, so every GPU load takes this lock.
export const LOCK_PATH_VARIABLE = 'CODEX_GPU_LOCK';

// How long a load waits for another program to free the GPU before it gives up.
export const WAIT_TIMEOUT_SECONDS = 1800;

// Return the lock file, or null when the variable is set empty to turn the lock off.
export function lockPath(): string | null {
    const configured = process.env[LOCK_PATH_VARIABLE];
    if (configured !== undefined) {
        return configured.trim() ? resolve(configured) : null;
    }
    const runtimeDirectory = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`;
    return join(runtimeDirectory, 'codex-gpu.lock');
}

// Tell whether this process inherited a descriptor for the lock file, as `flock FILE command` passes one.
export function inheritsLock(path: string): boolean {
    try {
        return readdirSync('/proc/self/fd').some((name) => {
            try {
                return readlinkSync(`/proc/self/fd/${name}`) === path;
            } catch {
                return false;
            }
        });
    } catch {
        return false;
    }
}

// A child `flock` process holds the lock, so it is let go even when this process dies.
function holdLock(path: string, timeoutSeconds: number): Promise<ChildProcess> {
    return new Promise((resolveHolder, rejectHolder) => {
        const holder = spawn('flock', ['--exclusive', '--timeout', String(timeoutSeconds), path, '--command', 'echo held; exec cat'], {
            stdio: ['pipe', 'pipe', 'ignore'],
        });
        holder.once('error', rejectHolder);
        holder.once('exit', (code) => {
            rejectHolder(new Error(`The GPU stayed in use by another program for ${timeoutSeconds} seconds (${path}), exit code ${code}.`));
        });
        holder.stdout!.once('data', () => {
            holder.removeAllListeners('exit');
            resolveHolder(holder);
        });
    });
}

// ============================================================================
// Lock
// ============================================================================

// One process's hold on the shared lock, counted so several of its models can share one hold.
export class GpuLock {
    private holders = 0;
    private holder: ChildProcess | null = null;
    private taking: Promise<void> | null = null;

    async acquire(onWait?: (message: string) => void, timeoutSeconds = WAIT_TIMEOUT_SECONDS): Promise<void> {
        this.holders += 1;
        if (this.holders > 1) {
            await this.taking;
            return;
        }
        this.taking = this.take(onWait, timeoutSeconds);
        try {
            await this.taking;
        } catch (error) {
            this.holders -= 1;
            throw error;
        }
    }

    release(): void {
        if (this.holders === 0) {
            return;
        }
        this.holders -= 1;
        if (this.holders === 0 && this.holder !== null) {
            this.holder.stdin!.end();
            this.holder = null;
        }
    }

    private async take(onWait: ((message: string) => void) | undefined, timeoutSeconds: number): Promise<void> {
        const path = lockPath();
        // The program that started this one keeps the lock it passed down.
        if (path === null || inheritsLock(path)) {
            return;
        }
        mkdirSync(dirname(path), { recursive: true });
        const free = spawnSync('flock', ['--exclusive', '--nonblock', path, 'true']).status === 0;
        if (!free) {
            onWait?.('Waiting for the GPU, which another program is using');
        }
        this.holder = await holdLock(path, timeoutSeconds);
    }
}

export const GPU_LOCK = new GpuLock();
