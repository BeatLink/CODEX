// The tray icon's menu and the check for a tray host, kept apart from Electron so they can be tested.
import { execFile } from 'node:child_process';

import type { MenuItemConstructorOptions } from 'electron';

export const TRAY_TITLE = 'CODEX';
export const SUSPENDED_TEXT = 'Suspended';
// A start in the tray waits this long for a tray to appear before it shows the window instead, so it is never unreachable.
export const TRAY_WAIT_SECONDS = 15;
// How often the app checks that a tray host is still there to hold the icon.
export const TRAY_HOST_POLL_SECONDS = 5;
export const WATCHER_NAME = 'org.kde.StatusNotifierWatcher';

// ============================================================================
// Menu model
// ============================================================================

// One menu entry; no label makes a separator, and a checked value of true or false makes it a check box.
export type MenuItem = {
    label: string | null;
    action?: (() => void) | null;
    checked?: boolean | null;
    enabled?: boolean;
};

export type TrayState = {
    showing: boolean;
    suspended: boolean;
    researching: boolean;
    launchAtLogin: boolean;
    // Proposed actions waiting for the user.
    inbox: number;
};

export type TrayActions = {
    toggleWindow: () => void;
    showInbox: () => void;
    toggleResearch: () => void;
    toggleAutostart: () => void;
    restartDaemon: () => void;
    quit: () => void;
};

export function trayItems(state: TrayState, actions: TrayActions): MenuItem[] {
    const items: MenuItem[] = [{ label: state.showing ? 'Hide CODEX' : 'Show CODEX', action: actions.toggleWindow }];
    if (state.suspended) {
        items.push({ label: SUSPENDED_TEXT, action: null });
    }
    if (state.inbox > 0) {
        items.push({ label: `Inbox (${state.inbox})`, action: actions.showInbox });
    }
    items.push(
        { label: null },
        { label: 'Background research', action: actions.toggleResearch, checked: state.researching },
        { label: 'Launch at login', action: actions.toggleAutostart, checked: state.launchAtLogin },
        { label: null },
        { label: 'Restart daemon', action: actions.restartDaemon },
        { label: 'Quit', action: actions.quit },
    );
    return items;
}

export function trayTooltip(suspended: boolean, inbox = 0): string {
    const state = suspended ? SUSPENDED_TEXT : TRAY_TITLE;
    return inbox > 0 ? `${state} · ${inbox} in the inbox` : state;
}

// Turns the entries into an Electron menu template; an entry without an action is shown greyed out.
export function menuTemplate(items: MenuItem[]): MenuItemConstructorOptions[] {
    return items.map((item, index): MenuItemConstructorOptions => {
        if (item.label === null) {
            return { type: 'separator' };
        }
        const entry: MenuItemConstructorOptions = {
            id: String(index + 1),
            label: item.label,
            enabled: (item.enabled ?? true) && item.action !== undefined && item.action !== null,
            click: () => chooseItem(items, index + 1),
        };
        if (item.checked !== undefined && item.checked !== null) {
            entry.type = 'checkbox';
            entry.checked = item.checked;
        }
        return entry;
    });
}

// Runs the action of the entry with this id, counting from 1, and ignores ids that name no entry.
export function chooseItem(items: MenuItem[], identifier: number): void {
    if (identifier >= 1 && identifier <= items.length) {
        items[identifier - 1].action?.();
    }
}

// ============================================================================
// Tray host
// ============================================================================

// Reads busctl's answer to NameHasOwner, which looks like "b true".
export function parseNameHasOwner(output: string): boolean {
    return output.trim() === 'b true';
}

// The busctl arguments that ask the session bus whether the tray host's watcher owns its name.
export function nameHasOwnerArguments(environment: NodeJS.ProcessEnv = process.env): string[] {
    // Busctl's --user means the systemd user bus, so the session bus's own address goes first when there is one.
    const bus = environment.DBUS_SESSION_BUS_ADDRESS ? [`--address=${environment.DBUS_SESSION_BUS_ADDRESS}`] : ['--user'];
    return [...bus, 'call', 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner', 's', WATCHER_NAME];
}

// Resolves whether a StatusNotifier host is running on the session bus; when it cannot be asked, the answer is no.
export function trayHostRunning(environment: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    const args = nameHasOwnerArguments(environment);
    return new Promise((resolveRunning) => {
        execFile('busctl', args, { encoding: 'utf8', timeout: 3000 }, (error, stdout) => {
            resolveRunning(error === null && parseNameHasOwner(String(stdout)));
        });
    });
}
