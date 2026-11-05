import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { defaultLogPath, defaultSocketPath, launchOptions } from './paths.js';

describe('daemon paths', () => {
    it('puts the socket in the runtime directory when there is one', () => {
        expect(defaultSocketPath({ XDG_RUNTIME_DIR: '/run/user/1000' })).toBe('/run/user/1000/codex/daemon.sock');
        expect(defaultSocketPath({})).toBe(join(tmpdir(), `codex-${userInfo().uid}`, 'daemon.sock'));
    });

    it('puts the log in the state directory', () => {
        expect(defaultLogPath({ XDG_STATE_HOME: '/state' })).toBe('/state/codex/daemon.log');
    });

    it('reads the socket, settings and tray start from the command line first', () => {
        const environment = { XDG_RUNTIME_DIR: '/run/user/1000', CODEX_SOCKET_PATH: '/from/env.sock' };

        const fromArguments = launchOptions(['electron', 'main.js', '--socket', '/tmp/a.sock', '--settings=s.json', '--background'], environment);
        const fromEnvironment = launchOptions(['electron', 'main.js'], environment);
        const fallback = launchOptions(['electron', 'main.js'], { XDG_RUNTIME_DIR: '/run/user/1000' });

        expect(fromArguments).toEqual({ socketPath: '/tmp/a.sock', settingsPath: 's.json', startInTray: true });
        expect(fromEnvironment).toEqual({ socketPath: '/from/env.sock', settingsPath: null, startInTray: false });
        expect(fallback.socketPath).toBe('/run/user/1000/codex/daemon.sock');
    });
});
