import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from '../core/settings.js';
import { connectToDaemon, DISCONNECTED_EVENT } from './client.js';
import { RunningDaemon } from './daemonHarness.js';
import { main } from './index.js';

describe('daemon client', () => {
    let directory: string;

    beforeEach(() => {
        directory = mkdtempSync('/tmp/cl-');
    });

    afterEach(() => {
        rmSync(directory, { recursive: true, force: true });
    });

    it('fails to connect without starting a daemon when start is false', async () => {
        const connecting = connectToDaemon({ socketPath: join(directory, 'none.sock'), start: false });

        await expect(connecting).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('reaches a running daemon and hears when it goes away', async () => {
        const daemon = await RunningDaemon.start({ ...DEFAULT_SETTINGS, knowledge_db_path: join(directory, 'knowledge.db') });
        const events: string[] = [];
        const client = await connectToDaemon({ socketPath: daemon.socketPath, start: false, onEvent: (event) => events.push(event) });

        const settings = await client.call<Record<string, unknown>>('get_settings');
        await daemon.stop();
        for (let attempt = 0; attempt < 100 && !events.includes(DISCONNECTED_EVENT); attempt += 1) {
            await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        }

        expect(settings.knowledge_db_path).toBe(join(directory, 'knowledge.db'));
        expect(events).toContain(DISCONNECTED_EVENT);
    });
});

describe('codex-daemon command', () => {
    it('refuses an unknown flag with a usage error', async () => {
        expect(await main(['--colour'])).toBe(2);
    });

    it('refuses a value for --exit-when-unused that is not a number', async () => {
        expect(await main(['--exit-when-unused', 'soon'])).toBe(2);
    });
});
