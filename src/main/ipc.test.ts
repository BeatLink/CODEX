import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ALLOWED_METHODS, CHANNELS, handleRequest, listUserCommands, openDialogOptions, registerIpc, saveDialogOptions, type IpcDependencies } from './ipc.js';

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

// ============================================================================
// Daemon requests
// ============================================================================

describe('daemon requests from the window', () => {
    it('passes an allowed method and its params to the daemon', async () => {
        const caller = { call: vi.fn(async () => ({ run_id: 4 })) };

        const envelope = await handleRequest(caller, 'run', { prompt: 'hello' });

        expect(envelope).toEqual({ ok: true, result: { run_id: 4 } });
        expect(caller.call).toHaveBeenCalledWith('run', { prompt: 'hello' });
    });

    it('never lets the window shut the daemon down', async () => {
        const caller = { call: vi.fn() };

        const envelope = await handleRequest(caller, 'shutdown', {});

        expect(ALLOWED_METHODS.has('shutdown')).toBe(false);
        expect(envelope).toEqual({ ok: false, error: 'Unknown method: shutdown' });
        expect(caller.call).not.toHaveBeenCalled();
    });

    it('lets the window list and resolve actions but not post events', () => {
        expect(ALLOWED_METHODS.has('actions')).toBe(true);
        expect(ALLOWED_METHODS.has('resolve_action')).toBe(true);
        expect(ALLOWED_METHODS.has('post_event')).toBe(false);
        expect(ALLOWED_METHODS.has('queue_request')).toBe(true);
    });

    it('rejects params that are not an object', async () => {
        const envelope = await handleRequest({ call: vi.fn() }, 'status', [1]);

        expect(envelope).toEqual({ ok: false, error: 'params must be a JSON object.' });
    });

    it('reports a missing connection and daemon errors as text', async () => {
        const failing = { call: vi.fn(async () => Promise.reject(new Error('Another request is already running.'))) };

        const disconnected = await handleRequest(null, 'status', {});
        const refused = await handleRequest(failing, 'run', { prompt: 'x' });

        expect(disconnected).toEqual({ ok: false, error: 'Not connected to the daemon yet.' });
        expect(refused).toEqual({ ok: false, error: 'Another request is already running.' });
    });
});

// ============================================================================
// Dialogs and commands
// ============================================================================

describe('native dialog options', () => {
    it('opens a folder or a file with the given filters', () => {
        const folder = openDialogOptions({ directory: true, title: 'Filesystem root' });
        const model = openDialogOptions({ filters: [{ name: 'GGUF model', extensions: ['gguf'] }], defaultPath: '/models' });

        expect(folder.properties).toContain('openDirectory');
        expect(folder.title).toBe('Filesystem root');
        expect(model.properties).toContain('openFile');
        expect(model.filters).toEqual([{ name: 'GGUF model', extensions: ['gguf'] }]);
        expect(model.defaultPath).toBe('/models');
    });

    it('ignores options of the wrong type', () => {
        const options = saveDialogOptions({ title: 3, defaultPath: '' });

        expect(options.title).toBeUndefined();
        expect(options.defaultPath).toBeUndefined();
    });
});

describe('user commands', () => {
    it("lists the folder's own commands by name with their mode", () => {
        const root = mkdtempSync(join(tmpdir(), 'codex-commands-'));
        directories.push(root);
        mkdirSync(join(root, '.codex', 'commands'), { recursive: true });
        writeFileSync(join(root, '.codex', 'commands', 'review.md'), '---\ndescription: Review a file\nmode: answer\n---\nReview $ARGUMENTS');

        const commands = listUserCommands(root);

        expect(commands).toContainEqual({ name: 'review', description: 'Review a file', mode: 'answer' });
        expect(listUserCommands('')).toEqual([]);
    });
});

describe('launch at login', () => {
    it('reads and sets the autostart entry for a trusted window only', async () => {
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        let enabled = false;
        let trusted = true;
        registerIpc({
            ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
            autostart: { isEnabled: () => enabled, setEnabled: (value: boolean) => (enabled = value) },
            isTrustedSender: () => trusted,
        } as unknown as IpcDependencies);

        const turnedOn = await handlers.get(CHANNELS.setAutostart)!({}, true);
        const read = await handlers.get(CHANNELS.getAutostart)!({});
        trusted = false;
        const refused = await handlers.get(CHANNELS.setAutostart)!({}, false);

        expect(turnedOn).toEqual({ ok: true, result: true });
        expect(read).toEqual({ ok: true, result: true });
        expect(refused).toEqual({ ok: false, error: 'Untrusted sender.' });
        expect(enabled).toBe(true);
    });
});
