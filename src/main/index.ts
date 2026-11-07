// The Electron main process: opens the window and the tray icon, connects them to the daemon, and passes requests and events on.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, nativeTheme, screen, shell, Tray, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as autostart from './autostart.js';
import { DISCONNECTED_EVENT, type DaemonClient } from './daemonBridge.js';
import { connectToDaemon } from './daemonLifecycle.js';
import { freshActions, notificationBody, summarizeActions } from './inbox.js';
import { AUTOSTART_CHANGED_EVENT, forwardEvent, registerIpc, SHOW_INBOX_EVENT } from './ipc.js';
import { launchOptions } from './paths.js';
import { menuTemplate, TRAY_HOST_POLL_SECONDS, TRAY_WAIT_SECONDS, trayHostRunning, trayItems, trayTooltip } from './tray.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererPage = path.join(here, '../renderer/index.html');
const preloadScript = path.join(here, 'preload.cjs');
const trayIconPath = path.join(here, '../renderer/tray-icon.png');
const options = launchOptions(process.argv);
// Without codex-gui on the PATH or named by the package, launch at login runs this same Electron on this same script.
const autostartOptions = { fallback: [process.execPath, fileURLToPath(import.meta.url)] };

let mainWindow: BrowserWindow | null = null;
let client: DaemonClient | null = null;
let connection: Promise<{ socket_path: string; started: boolean }> | null = null;
let tray: Tray | null = null;
// True while a tray host shows the icon, so closing the window can hide it there instead of quitting.
let trayRegistered = false;
let quitting = false;
// What the tray menu shows of the daemon, kept up to date from its status and events.
let suspended = false;
let researching = false;
// Proposed actions waiting, and the newest one already announced, so only later ones raise a notification.
let inboxCount = 0;
let announcedUpTo = 0;
let inboxRead = false;
// True from asking the daemon to stop until it has gone, so its departure starts a fresh one.
let restarting = false;

// ============================================================================
// Daemon connection
// ============================================================================

// Connects once per connection, and again after the daemon goes away; a daemon this starts exits by itself once no interface uses it.
function connectOnce(): Promise<{ socket_path: string; started: boolean }> {
    if (connection === null) {
        connection = connectToDaemon(options.socketPath, {
            settingsPath: options.settingsPath,
            onEvent: (event, data) => {
                forwardEvent(mainWindow, event, data);
                if (event === DISCONNECTED_EVENT) {
                    client = null;
                    connection = null;
                    if (restarting) {
                        restarting = false;
                        void connectOnce().catch(() => undefined);
                    }
                } else if (event === 'settings.changed') {
                    researching = Boolean((data.settings as Record<string, unknown> | undefined)?.background_research_enabled);
                    refreshTray();
                } else if (event === 'suspended.changed') {
                    suspended = Boolean(data.suspended);
                    refreshTray();
                } else if (event === 'actions.changed' && client !== null) {
                    void readInbox(client);
                }
            },
        }).then((result) => {
            client = result.client;
            void readDaemonState(result.client);
            void readInbox(result.client);
            return { socket_path: options.socketPath, started: result.started };
        });
        connection.catch(() => {
            connection = null;
        });
    }
    return connection;
}

// Asks the daemon to stop and starts a fresh one once it has gone; with no daemon connected it only starts one.
function restartDaemon(): void {
    if (client === null) {
        void connectOnce().catch(() => undefined);
        return;
    }
    restarting = true;
    void client.call('shutdown').catch(() => undefined);
}

async function readDaemonState(connected: DaemonClient): Promise<void> {
    try {
        const status = await connected.call<{ settings: Record<string, unknown>; suspended?: boolean }>('status');
        researching = Boolean(status.settings.background_research_enabled);
        suspended = Boolean(status.suspended);
        refreshTray();
    } catch {
        // The tray keeps its last state until the next event.
    }
}

// Counts the proposed actions for the tray and announces the ones that arrived since the last look.
async function readInbox(connected: DaemonClient): Promise<void> {
    try {
        const actions = summarizeActions(await connected.call('actions', { status: 'proposed', limit: 100 }));
        inboxCount = actions.length;
        // The first look only sets the mark, so actions already waiting at startup are not announced.
        const { fresh, seenUpTo } = freshActions(inboxRead ? announcedUpTo : Math.max(0, ...actions.map((action) => action.id)), actions);
        announcedUpTo = seenUpTo;
        inboxRead = true;
        const body = notificationBody(fresh);
        if (body !== null && Notification.isSupported() && !(mainWindow?.isVisible() && mainWindow.isFocused())) {
            const notification = new Notification({ title: 'CODEX', body });
            notification.on('click', showInbox);
            notification.show();
        }
        refreshTray();
    } catch {
        // The tray keeps its last count until the next event.
    }
}

// ============================================================================
// Window
// ============================================================================

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
    const url = event.senderFrame?.url ?? '';
    return url.split('#')[0] === pathToFileURL(rendererPage).href;
}

function createWindow(showWhenReady = true): BrowserWindow {
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
    if (showWhenReady) {
        window.once('ready-to-show', () => window.show());
    }
    // While the tray holds the icon, closing hides the window there and keeps its link to the daemon alive.
    window.on('close', (event) => {
        if (!quitting && trayRegistered) {
            event.preventDefault();
            window.hide();
        }
    });
    window.on('show', refreshTray);
    window.on('hide', refreshTray);
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
        refreshTray();
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
                { label: 'Restart daemon', click: restartDaemon },
                { role: 'quit' },
            ],
        },
    ]);
}

function showWindow(): void {
    if (mainWindow === null) {
        mainWindow = createWindow();
        return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

// Shows the window on its Inbox page, waiting for a new window to load before it is told.
function showInbox(): void {
    const created = mainWindow === null;
    showWindow();
    if (created) {
        mainWindow?.webContents.once('did-finish-load', () => forwardEvent(mainWindow, SHOW_INBOX_EVENT, {}));
    } else {
        forwardEvent(mainWindow, SHOW_INBOX_EVENT, {});
    }
}

// ============================================================================
// Tray
// ============================================================================

function toggleWindow(): void {
    if (mainWindow !== null && mainWindow.isVisible() && mainWindow.isFocused()) {
        mainWindow.hide();
    } else {
        showWindow();
    }
    refreshTray();
}

function toggleResearch(): void {
    void client?.call('set_background_enabled', { enabled: !researching }).catch(() => undefined);
}

function setLaunchAtLogin(enabled: boolean): void {
    if (enabled) {
        autostart.enable(autostartOptions);
    } else {
        autostart.disable(autostartOptions);
    }
    forwardEvent(mainWindow, AUTOSTART_CHANGED_EVENT, { enabled: autostart.isEnabled(autostartOptions) });
    refreshTray();
}

function quitFromTray(): void {
    quitting = true;
    app.quit();
}

function refreshTray(): void {
    if (tray === null || tray.isDestroyed()) {
        return;
    }
    const items = trayItems(
        {
            showing: mainWindow !== null && mainWindow.isVisible(),
            suspended,
            researching,
            launchAtLogin: autostart.isEnabled(autostartOptions),
            inbox: inboxCount,
        },
        {
            toggleWindow,
            showInbox,
            toggleResearch,
            toggleAutostart: () => setLaunchAtLogin(!autostart.isEnabled(autostartOptions)),
            restartDaemon,
            quit: quitFromTray,
        },
    );
    tray.setContextMenu(Menu.buildFromTemplate(menuTemplate(items)));
    tray.setToolTip(trayTooltip(suspended, inboxCount));
}

// Notes whether a tray host holds the icon; losing it brings a hidden window back, so the app is never unreachable.
function setTrayRegistered(registered: boolean): void {
    trayRegistered = registered;
    if (!registered && mainWindow !== null && !mainWindow.isVisible()) {
        showWindow();
    }
}

function startTray(): void {
    try {
        tray = new Tray(nativeImage.createFromPath(trayIconPath));
    } catch {
        // Without a tray the window closes the app as usual.
        tray = null;
        return;
    }
    tray.on('click', toggleWindow);
    refreshTray();
    const checkHost = (): void => {
        void trayHostRunning().then((running) => {
            if (running !== trayRegistered) setTrayRegistered(running);
        });
    };
    checkHost();
    setInterval(checkHost, TRAY_HOST_POLL_SECONDS * 1000).unref();
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
    autostart: {
        isEnabled: () => autostart.isEnabled(autostartOptions),
        setEnabled: setLaunchAtLogin,
    },
    isTrustedSender,
});

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', showWindow);

    void app.whenReady().then(() => {
        Menu.setApplicationMenu(applicationMenu());
        autostart.refresh(autostartOptions);
        mainWindow = createWindow(!options.startInTray);
        startTray();
        if (options.startInTray) {
            // A start in the tray shows the window after all when no tray host turns up to hold the icon.
            setTimeout(() => {
                if (!trayRegistered && mainWindow !== null && !mainWindow.isVisible()) showWindow();
            }, TRAY_WAIT_SECONDS * 1000);
        }
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
    quitting = true;
    tray?.destroy();
    tray = null;
    if (client !== null) {
        client.onEvent = null;
        client.close();
    }
});
