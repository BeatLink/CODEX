import { describe, expect, it } from 'vitest';

import { chooseItem, menuTemplate, nameHasOwnerArguments, parseNameHasOwner, SUSPENDED_TEXT, trayItems, trayTooltip, type MenuItem } from './tray.js';

function sampleItems(chosen: string[]): MenuItem[] {
    return [
        { label: 'Show', action: () => chosen.push('show') },
        { label: null },
        { label: 'Research', action: () => chosen.push('research'), checked: true },
        { label: 'Status', action: null },
    ];
}

describe('tray menu', () => {
    it('lists each entry with its kind and state', () => {
        const template = menuTemplate(sampleItems([]));

        expect(template.map((entry) => entry.id)).toEqual(['1', undefined, '3', '4']);
        expect(template[0].label).toBe('Show');
        expect(template[1]).toEqual({ type: 'separator' });
        expect(template[2]).toMatchObject({ type: 'checkbox', checked: true, enabled: true });
        expect(template[3].enabled).toBe(false);
    });

    it('runs the chosen entry’s action and ignores unknown ones', () => {
        const chosen: string[] = [];
        const items = sampleItems(chosen);

        chooseItem(items, 3);
        chooseItem(items, 4);
        chooseItem(items, 99);
        menuTemplate(items)[0].click!({} as never, undefined, {} as never);

        expect(chosen).toEqual(['research', 'show']);
    });

    it('offers show or hide, research, launch at login and quit, with the suspension when there is one', () => {
        const actions = { toggleWindow: () => undefined, toggleResearch: () => undefined, toggleAutostart: () => undefined, quit: () => undefined };

        const shown = trayItems({ showing: true, suspended: false, researching: true, launchAtLogin: false }, actions);
        const hidden = trayItems({ showing: false, suspended: true, researching: false, launchAtLogin: true }, actions);

        expect(shown.map((item) => item.label)).toEqual(['Hide CODEX', null, 'Background research', 'Launch at login', null, 'Quit']);
        expect(shown.map((item) => item.checked)).toEqual([undefined, undefined, true, false, undefined, undefined]);
        expect(hidden.map((item) => item.label)).toEqual(['Show CODEX', SUSPENDED_TEXT, null, 'Background research', 'Launch at login', null, 'Quit']);
        expect(hidden[1].action).toBeNull();
        expect(hidden.map((item) => item.checked)).toEqual([undefined, undefined, undefined, false, true, undefined, undefined]);
        expect(trayTooltip(true)).toBe(SUSPENDED_TEXT);
        expect(trayTooltip(false)).toBe('CODEX');
    });

    it('reads whether the tray host owns its bus name', () => {
        expect(parseNameHasOwner('b true\n')).toBe(true);
        expect(parseNameHasOwner('b false\n')).toBe(false);
        expect(nameHasOwnerArguments({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/bus' })[0]).toBe('--address=unix:path=/run/bus');
        expect(nameHasOwnerArguments({}).slice(0, 2)).toEqual(['--user', 'call']);
        expect(nameHasOwnerArguments({}).at(-1)).toBe('org.kde.StatusNotifierWatcher');
    });
});
