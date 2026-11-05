import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { desktopEntryText, disable, enable, entryPath, findOnPath, isEnabled, launchCommand } from './autostart.js';

describe('autostart', () => {
    let directory: string;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), 'codex-autostart-'));
    });

    afterEach(() => {
        rmSync(directory, { recursive: true, force: true });
    });

    it('writes an entry that starts in the tray, and removing it twice is fine', () => {
        const bin = join(directory, 'bin');
        mkdirSync(bin);
        writeFileSync(join(bin, 'codex-gui'), '#!/bin/sh\n');
        chmodSync(join(bin, 'codex-gui'), 0o755);
        const environment = { XDG_CONFIG_HOME: directory, PATH: bin };
        expect(isEnabled({ environment })).toBe(false);

        enable({ environment });

        const entry = readFileSync(join(directory, 'autostart', 'org.codex.CODEX.desktop'), 'utf8');
        expect(entry).toContain(`Exec=${bin}/codex-gui --background\n`);
        expect(isEnabled({ environment })).toBe(true);

        disable({ environment });
        disable({ environment });

        expect(isEnabled({ environment })).toBe(false);
    });

    it('keeps the entry under the config folder, defaulting to ~/.config', () => {
        expect(entryPath({ XDG_CONFIG_HOME: '/config' })).toBe('/config/autostart/org.codex.CODEX.desktop');
        expect(entryPath({})).toMatch(/\/\.config\/autostart\/org\.codex\.CODEX\.desktop$/);
    });

    it('falls back to the running app, quoting paths with spaces', () => {
        expect(findOnPath('codex-gui', { PATH: directory })).toBeNull();

        const command = launchCommand(null, ['/opt/electron', '/home/me/My Apps/main.js']);

        expect(command).toBe('/opt/electron "/home/me/My Apps/main.js" --background');
    });

    it('describes a hidden-terminal application entry', () => {
        expect(desktopEntryText('codex-gui --background')).toBe(
            '[Desktop Entry]\n' +
                'Type=Application\n' +
                'Name=CODEX\n' +
                'Comment=Local LLM harness, started in the system tray\n' +
                'Exec=codex-gui --background\n' +
                'Icon=applications-science\n' +
                'Terminal=false\n' +
                'X-GNOME-Autostart-enabled=true\n',
        );
    });
});
