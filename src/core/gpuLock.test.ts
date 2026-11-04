import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { GpuLock, LOCK_PATH_VARIABLE, lockPath } from './gpuLock.js';

const previous = process.env[LOCK_PATH_VARIABLE];

function freshLock(): string {
    const path = join(mkdtempSync(join(tmpdir(), 'codex-gpu-')), 'gpu.lock');
    process.env[LOCK_PATH_VARIABLE] = path;
    return path;
}

function isFree(path: string): boolean {
    return spawnSync('flock', ['--exclusive', '--nonblock', path, 'true']).status === 0;
}

afterEach(() => {
    if (previous === undefined) {
        delete process.env[LOCK_PATH_VARIABLE];
    } else {
        process.env[LOCK_PATH_VARIABLE] = previous;
    }
});

describe('GpuLock', () => {
    it('holds the lock until every holder in the process releases it', async () => {
        const path = freshLock();
        const lock = new GpuLock();

        await lock.acquire();
        await lock.acquire();
        expect(isFree(path)).toBe(false);

        lock.release();
        expect(isFree(path)).toBe(false);

        lock.release();
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(isFree(path)).toBe(true);
    });

    it('waits for another program and gives up after the timeout', async () => {
        const path = freshLock();
        const other = spawn('flock', ['--exclusive', path, 'sleep', '5']);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const waits: string[] = [];

        await expect(new GpuLock().acquire((message) => waits.push(message), 1)).rejects.toThrow('stayed in use');

        expect(waits).toEqual(['Waiting for the GPU, which another program is using']);
        other.kill();
    });

    it('turns off when the variable is set empty', () => {
        process.env[LOCK_PATH_VARIABLE] = '';

        expect(lockPath()).toBeNull();
    });
});
