import { app, BrowserWindow } from 'electron';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DaemonBridge } from './daemonBridge.js';
import { ensureDaemonRunning } from './daemonLifecycle.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const daemonPath = process.env.CODEX_SOCKET_PATH ?? '/tmp/codex-daemon.sock';

const daemonBridge = new DaemonBridge(daemonPath);
let daemonProcess: ChildProcess | null = null;

async function startDaemonIfNeeded(): Promise<void> {
    try {
        await daemonBridge.request('status');
        return;
    } catch {
        const result = await ensureDaemonRunning(daemonBridge, undefined, daemonPath);
        daemonProcess = result.process ?? null;

        if (result.started) {
            console.info(`CODEX Node daemon started on ${daemonPath}`);
            return;
        }

        console.warn(`CODEX daemon is not available on ${daemonPath}; continuing in compatibility mode.`);
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
    if (daemonProcess && !daemonProcess.killed) {
        daemonProcess.kill('SIGTERM');
    }
    await daemonBridge.close();
});
