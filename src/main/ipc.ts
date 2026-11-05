// The IPC the window may use: daemon requests from a fixed list, daemon events, native dialogs, the clipboard, user commands, and launch at login.
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, OpenDialogOptions, SaveDialogOptions } from 'electron';

import { loadCommands } from '../core/commands.js';

export const CHANNELS = {
    connect: 'codex:connect',
    request: 'codex:request',
    event: 'codex:event',
    openDialog: 'codex:open-dialog',
    saveDialog: 'codex:save-dialog',
    copyText: 'codex:copy-text',
    listCommands: 'codex:list-commands',
    getAutostart: 'codex:get-autostart',
    setAutostart: 'codex:set-autostart',
} as const;

// The window hears this alongside the daemon's events when launch at login changes from the tray.
export const AUTOSTART_CHANGED_EVENT = 'autostart.changed';

// Shutdown is left out, since closing a window must never stop a daemon other interfaces share.
export const ALLOWED_METHODS = new Set([
    'status',
    'get_settings',
    'apply_settings',
    'save_settings',
    'auto_size',
    'set_background_enabled',
    'run',
    'cancel',
    'answer_clarification',
    'queue_topic',
    'research_now',
    'queue_status',
    'knowledge',
    'unfinished_runs',
    'resume_run',
    'discard_run',
]);

export type Envelope<T = unknown> = { ok: true; result: T } | { ok: false; error: string };

export type DaemonCaller = {
    call(method: string, params?: Record<string, unknown>): Promise<unknown>;
};

// ============================================================================
// Requests
// ============================================================================

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export async function wrap<T>(work: () => Promise<T> | T): Promise<Envelope<T>> {
    try {
        return { ok: true, result: await work() };
    } catch (error) {
        return { ok: false, error: errorText(error) };
    }
}

export async function handleRequest(caller: DaemonCaller | null, method: unknown, params: unknown): Promise<Envelope> {
    return wrap(async () => {
        if (typeof method !== 'string' || !ALLOWED_METHODS.has(method)) {
            throw new Error(`Unknown method: ${String(method)}`);
        }
        if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) {
            throw new Error('params must be a JSON object.');
        }
        if (caller === null) {
            throw new Error('Not connected to the daemon yet.');
        }
        return caller.call(method, (params as Record<string, unknown> | undefined) ?? {});
    });
}

export type CommandSummary = { name: string; description: string; mode: string | null };

// Lists the commands the user defined in files for this folder, for the prompt's suggestions.
export function listUserCommands(filesystemRoot: unknown): CommandSummary[] {
    if (typeof filesystemRoot !== 'string' || !filesystemRoot.trim()) {
        return [];
    }
    return [...loadCommands(filesystemRoot.trim()).values()]
        .map(({ name, description, mode }) => ({ name, description, mode }))
        .sort((first, second) => first.name.localeCompare(second.name));
}

// ============================================================================
// Dialog options
// ============================================================================

export type DialogRequest = {
    title?: string;
    defaultPath?: string;
    directory?: boolean;
    filters?: Array<{ name: string; extensions: string[] }>;
};

export function openDialogOptions(request: unknown): OpenDialogOptions {
    const given = (request && typeof request === 'object' ? request : {}) as DialogRequest;
    const options: OpenDialogOptions = {
        properties: [given.directory ? 'openDirectory' : 'openFile', 'showHiddenFiles'],
    };
    if (typeof given.title === 'string') options.title = given.title;
    if (typeof given.defaultPath === 'string' && given.defaultPath) options.defaultPath = given.defaultPath;
    if (Array.isArray(given.filters)) options.filters = given.filters;
    return options;
}

export function saveDialogOptions(request: unknown): SaveDialogOptions {
    const given = (request && typeof request === 'object' ? request : {}) as DialogRequest;
    const options: SaveDialogOptions = { properties: ['showHiddenFiles', 'showOverwriteConfirmation'] };
    if (typeof given.title === 'string') options.title = given.title;
    if (typeof given.defaultPath === 'string' && given.defaultPath) options.defaultPath = given.defaultPath;
    if (Array.isArray(given.filters)) options.filters = given.filters;
    return options;
}

// ============================================================================
// Registration
// ============================================================================

export type IpcDependencies = {
    ipcMain: IpcMain;
    window: () => BrowserWindow | null;
    caller: () => DaemonCaller | null;
    connection: () => Promise<{ socket_path: string; started: boolean }>;
    showOpenDialog: (window: BrowserWindow, options: OpenDialogOptions) => Promise<{ canceled: boolean; filePaths: string[] }>;
    showSaveDialog: (window: BrowserWindow, options: SaveDialogOptions) => Promise<{ canceled: boolean; filePath?: string }>;
    writeClipboard: (text: string) => void;
    autostart: { isEnabled: () => boolean; setEnabled: (enabled: boolean) => void };
    isTrustedSender: (event: IpcMainInvokeEvent) => boolean;
};

export function registerIpc(dependencies: IpcDependencies): void {
    const { ipcMain } = dependencies;
    const guarded = (work: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<Envelope> | Envelope) =>
        (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<Envelope> | Envelope =>
            dependencies.isTrustedSender(event) ? work(event, ...args) : { ok: false, error: 'Untrusted sender.' };

    ipcMain.handle(CHANNELS.connect, guarded(() => wrap(() => dependencies.connection())));
    ipcMain.handle(CHANNELS.request, guarded((_event, method, params) => handleRequest(dependencies.caller(), method, params)));
    ipcMain.handle(CHANNELS.openDialog, guarded((_event, request) => wrap(async () => {
        const window = dependencies.window();
        if (window === null) return null;
        const answer = await dependencies.showOpenDialog(window, openDialogOptions(request));
        return answer.canceled ? null : answer.filePaths[0] ?? null;
    })));
    ipcMain.handle(CHANNELS.saveDialog, guarded((_event, request) => wrap(async () => {
        const window = dependencies.window();
        if (window === null) return null;
        const answer = await dependencies.showSaveDialog(window, saveDialogOptions(request));
        return answer.canceled ? null : answer.filePath ?? null;
    })));
    ipcMain.handle(CHANNELS.copyText, guarded((_event, text) => wrap(() => {
        dependencies.writeClipboard(String(text ?? ''));
        return true;
    })));
    ipcMain.handle(CHANNELS.listCommands, guarded((_event, filesystemRoot) => wrap(() => listUserCommands(filesystemRoot))));
    ipcMain.handle(CHANNELS.getAutostart, guarded(() => wrap(() => dependencies.autostart.isEnabled())));
    ipcMain.handle(CHANNELS.setAutostart, guarded((_event, enabled) => wrap(() => {
        dependencies.autostart.setEnabled(Boolean(enabled));
        return dependencies.autostart.isEnabled();
    })));
}

// Passes one daemon event on to the window, if it is still open.
export function forwardEvent(window: BrowserWindow | null, event: string, data: Record<string, unknown>): void {
    if (window !== null && !window.isDestroyed()) {
        window.webContents.send(CHANNELS.event, { event, data });
    }
}
