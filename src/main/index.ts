import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DaemonBridge } from './daemonBridge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const daemonPath = process.env.CODEX_SOCKET_PATH ?? '/tmp/codex-daemon.sock';

const daemonBridge = new DaemonBridge(daemonPath);

async function startDaemonIfNeeded(): Promise<void> {
    try {
        await daemonBridge.request('status');
    } catch (error) {
        // The desktop shell intentionally leaves the Python daemon lifecycle in the backend process.
        // For the first Electron stage, the bridge only validates the protocol and socket path.
        console.warn('CODEX daemon is not yet running; the UI will still boot in compatibility mode.', error);
    }
}

async function createWindow(): Promise<void> {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 620,
        backgroundColor: '#0f172a',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    await win.loadFile(path.join(__dirname, '../renderer/index.html'));
    await startDaemonIfNeeded();
}

app.whenReady().then(async () => {
    await createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            void createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', async () => {
    await daemonBridge.close();
});
