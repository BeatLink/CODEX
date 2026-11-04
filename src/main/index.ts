// The Electron main process: opens the window, connects it to the daemon, and passes requests and events between them.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, screen, shell, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DISCONNECTED_EVENT, type DaemonClient } from './daemonBridge.js';
import { connectToDaemon } from './daemonLifecycle.js';
import { forwardEvent, registerIpc } from './ipc.js';
import { launchOptions } from './paths.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererPage = path.join(here, '../renderer/index.html');
const preloadScript = path.join(here, 'preload.cjs');
const options = launchOptions(process.argv);

let mainWindow: BrowserWindow | null = null;
let client: DaemonClient | null = null;
let connection: Promise<{ socket_path: string; started: boolean }> | null = null;

// ============================================================================
// Daemon connection
// ============================================================================

// Connects once per app; a daemon this starts exits by itself once no interface uses it.
function connectOnce(): Promise<{ socket_path: string; started: boolean }> {
    if (connection === null) {
        connection = connectToDaemon(options.socketPath, {
            settingsPath: options.settingsPath,
            onEvent: (event, data) => {
                forwardEvent(mainWindow, event, data);
                if (event === DISCONNECTED_EVENT) {
                    client = null;
                }
            },
        }).then((result) => {
            client = result.client;
            return { socket_path: options.socketPath, started: result.started };
        });
        connection.catch(() => {
            connection = null;
        });
    }
    return connection;
}

// ============================================================================
// Window
// ============================================================================

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
    const url = event.senderFrame?.url ?? '';
    return url.split('#')[0] === pathToFileURL(rendererPage).href;
}

function createWindow(): BrowserWindow {
    const area = screen.getPrimaryDisplay().workAreaSize;
    const window = new BrowserWindow({
        title: 'CODEX',
        width: Math.min(1280, area.width),
        height: Math.min(800, area.height),
        minWidth: 900,
        minHeight: 560,
        show: false,
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b1220' : '#f1f5f9',
        webPreferences: {
            preload: preloadScript,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: true,
        },
    });
    window.once('ready-to-show', () => window.show());
    // Links open in the system browser, and the window never leaves its own page.
    window.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//.test(url)) {
            void shell.openExternal(url);
        }
        return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
        if (url.split('#')[0] !== pathToFileURL(rendererPage).href) {
            event.preventDefault();
            if (/^https?:\/\//.test(url)) {
                void shell.openExternal(url);
            }
        }
    });
    window.on('closed', () => {
        if (mainWindow === window) {
            mainWindow = null;
        }
    });
    void window.loadFile(rendererPage);
    return window;
}

function applicationMenu(): Menu {
    return Menu.buildFromTemplate([
        {
            label: 'CODEX',
            submenu: [
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' },
                { type: 'separator' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { role: 'resetZoom' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'quit' },
            ],
        },
    ]);
}

// ============================================================================
// App lifecycle
// ============================================================================

nativeTheme.themeSource = 'system';

registerIpc({
    ipcMain,
    window: () => mainWindow,
    caller: () => client,
    connection: connectOnce,
    showOpenDialog: (window, dialogOptions) => dialog.showOpenDialog(window, dialogOptions),
    showSaveDialog: (window, dialogOptions) => dialog.showSaveDialog(window, dialogOptions),
    writeClipboard: (text) => clipboard.writeText(text),
    isTrustedSender,
});

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow !== null) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    void app.whenReady().then(() => {
        Menu.setApplicationMenu(applicationMenu());
        mainWindow = createWindow();
        void connectOnce().catch(() => undefined);
        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                mainWindow = createWindow();
            }
        });
    });
}

app.on('window-all-closed', () => {
    app.quit();
});

// Only the connection closes; the daemon keeps serving other interfaces, and one this window started exits when unused.
app.on('before-quit', () => {
    if (client !== null) {
        client.onEvent = null;
        client.close();
    }
});
