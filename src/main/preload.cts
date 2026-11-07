// Gives the window a small API for the daemon, its events, native dialogs, the clipboard, user commands, launch at login and restarting the daemon.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

// These names match CHANNELS in ipc.ts; a sandboxed preload cannot load other files.
const CONNECT = 'codex:connect';
const REQUEST = 'codex:request';
const EVENT = 'codex:event';
const OPEN_DIALOG = 'codex:open-dialog';
const SAVE_DIALOG = 'codex:save-dialog';
const COPY_TEXT = 'codex:copy-text';
const LIST_COMMANDS = 'codex:list-commands';
const GET_AUTOSTART = 'codex:get-autostart';
const SET_AUTOSTART = 'codex:set-autostart';
const RESTART_DAEMON = 'codex:restart-daemon';

type Envelope = { ok: true; result: unknown } | { ok: false; error: string };
type DaemonEvent = { event: string; data: Record<string, unknown> };

// ============================================================================
// Calls
// ============================================================================

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const envelope = (await ipcRenderer.invoke(channel, ...args)) as Envelope;
    if (!envelope.ok) {
        throw new Error(envelope.error);
    }
    return envelope.result;
}

contextBridge.exposeInMainWorld('codex', {
    connect: () => invoke(CONNECT),
    request: (method: string, params: Record<string, unknown> = {}) => invoke(REQUEST, method, params),
    onEvent: (listener: (event: string, data: Record<string, unknown>) => void) => {
        const forward = (_event: IpcRendererEvent, message: DaemonEvent): void => listener(message.event, message.data);
        ipcRenderer.on(EVENT, forward);
        return () => {
            ipcRenderer.removeListener(EVENT, forward);
        };
    },
    openDialog: (options: Record<string, unknown> = {}) => invoke(OPEN_DIALOG, options),
    saveDialog: (options: Record<string, unknown> = {}) => invoke(SAVE_DIALOG, options),
    copyText: (text: string) => invoke(COPY_TEXT, text),
    listCommands: (filesystemRoot: string) => invoke(LIST_COMMANDS, filesystemRoot),
    getAutostart: () => invoke(GET_AUTOSTART),
    setAutostart: (enabled: boolean) => invoke(SET_AUTOSTART, enabled),
    restartDaemon: () => invoke(RESTART_DAEMON),
});
