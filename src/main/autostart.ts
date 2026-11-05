// Starts the CODEX window in the tray when the user logs in, through an XDG autostart entry.
import { accessSync, constants, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

export const ENTRY_NAME = 'org.codex.CODEX.desktop';
export const BACKGROUND_FLAG = '--background';
export const LAUNCH_PROGRAM = 'codex-gui';
// The packaged codex-gui sets this to its own path, so the entry runs the wrapper even when it is not on the PATH.
export const LAUNCHER_VARIABLE = 'CODEX_GUI_COMMAND';
export const ICON_NAME = 'org.codex.CODEX';

// ============================================================================
// Paths
// ============================================================================

export function entryPath(environment: NodeJS.ProcessEnv = process.env): string {
    const base = environment.XDG_CONFIG_HOME || join(homedir(), '.config');
    return join(base, 'autostart', ENTRY_NAME);
}

// Finds an executable on the PATH, as a shell would.
export function findOnPath(program: string, environment: NodeJS.ProcessEnv = process.env): string | null {
    for (const directory of (environment.PATH ?? '').split(delimiter)) {
        if (!directory) continue;
        const candidate = join(directory, program);
        try {
            if (statSync(candidate).isFile()) {
                accessSync(candidate, constants.X_OK);
                return candidate;
            }
        } catch {
            // Not here, so the search goes on to the next directory.
        }
    }
    return null;
}

// Picks codex-gui from the PATH first, then the launcher the package names, so the entry gets the wrapper's environment.
export function findLauncher(environment: NodeJS.ProcessEnv = process.env): string | null {
    const onPath = findOnPath(LAUNCH_PROGRAM, environment);
    if (onPath !== null) return onPath;
    const named = environment[LAUNCHER_VARIABLE];
    if (!named) return null;
    try {
        accessSync(named, constants.X_OK);
        return named;
    } catch {
        return null;
    }
}

// ============================================================================
// Entry text
// ============================================================================

// Quotes an Exec argument the way desktop entries expect, leaving plain paths as they are.
function execArgument(argument: string): string {
    if (!/[\s"'\\`$<>~|&;*?#()]/.test(argument)) {
        return argument;
    }
    return `"${argument.replace(/[\\"`$]/g, (character) => `\\${character}`)}"`;
}

// The command on the PATH survives updates, where this process's own path may be a replaced store path.
export function launchCommand(foundProgram: string | null, fallback: readonly string[]): string {
    const program = foundProgram === null ? fallback.map(execArgument) : [execArgument(foundProgram)];
    return [...program, BACKGROUND_FLAG].join(' ');
}

export function desktopEntryText(command: string): string {
    return (
        '[Desktop Entry]\n' +
        'Type=Application\n' +
        'Name=CODEX\n' +
        'Comment=Local LLM harness, started in the system tray\n' +
        `Exec=${command}\n` +
        `Icon=${ICON_NAME}\n` +
        'Terminal=false\n' +
        'X-GNOME-Autostart-enabled=true\n'
    );
}

// ============================================================================
// Turning it on and off
// ============================================================================

export type AutostartOptions = {
    environment?: NodeJS.ProcessEnv;
    // The command that starts this app when codex-gui is not on the PATH.
    fallback?: readonly string[];
};

export function isEnabled(options: AutostartOptions = {}): boolean {
    return existsSync(entryPath(options.environment));
}

export function enable(options: AutostartOptions = {}): void {
    const environment = options.environment ?? process.env;
    const path = entryPath(environment);
    mkdirSync(dirname(path), { recursive: true });
    const command = launchCommand(findLauncher(environment), options.fallback ?? [process.execPath]);
    writeFileSync(path, desktopEntryText(command));
}

// Rewrites an existing entry for this install, so an update never leaves it pointing at a removed path.
export function refresh(options: AutostartOptions = {}): void {
    if (isEnabled(options)) enable(options);
}

export function disable(options: AutostartOptions = {}): void {
    rmSync(entryPath(options.environment), { force: true });
}
