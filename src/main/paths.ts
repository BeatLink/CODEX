// Where the daemon's socket and log live, the same places the Python interfaces use.
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

// ============================================================================
// Socket and log paths
// ============================================================================

export function defaultSocketPath(environment: NodeJS.ProcessEnv = process.env): string {
    const runtimeDirectory = environment.XDG_RUNTIME_DIR;
    if (runtimeDirectory) {
        return join(runtimeDirectory, 'codex', 'daemon.sock');
    }
    return join(tmpdir(), `codex-${userInfo().uid}`, 'daemon.sock');
}

export function defaultLogPath(environment: NodeJS.ProcessEnv = process.env): string {
    const stateDirectory = environment.XDG_STATE_HOME || join(homedir(), '.local', 'state');
    return join(stateDirectory, 'codex', 'daemon.log');
}

// ============================================================================
// Command line
// ============================================================================

export type LaunchOptions = {
    socketPath: string;
    settingsPath: string | null;
    // Starts in the system tray without opening the window, as the login autostart entry does.
    startInTray: boolean;
};

// Reads --socket, --settings and --background from the app's arguments, falling back to CODEX_SOCKET_PATH and the default socket.
export function launchOptions(argv: string[], environment: NodeJS.ProcessEnv = process.env): LaunchOptions {
    const valueOf = (flag: string): string | null => {
        for (let index = 0; index < argv.length; index += 1) {
            if (argv[index] === flag && index + 1 < argv.length) {
                return argv[index + 1];
            }
            if (argv[index].startsWith(`${flag}=`)) {
                return argv[index].slice(flag.length + 1);
            }
        }
        return null;
    };
    return {
        socketPath: valueOf('--socket') ?? environment.CODEX_SOCKET_PATH ?? defaultSocketPath(environment),
        settingsPath: valueOf('--settings'),
        startInTray: argv.includes('--background'),
    };
}
