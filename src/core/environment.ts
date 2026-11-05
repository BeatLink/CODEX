// Probes the machine for the environment memory stores: where things are and what software is installed or running.
// Every probe is a plain reading of the system, never a model call, so what it records is always what the machine shows.
import { execFile } from 'node:child_process';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { homedir, machine, release, type } from 'node:os';
import { delimiter, join } from 'node:path';

import { KnowledgeStore, casefold } from './knowledge.js';
import { expandUser, type Settings } from './settings.js';
import { resolvePath } from './tools.js';

// ============================================================================
// Limits
// ============================================================================

// Filesystems that are views of the kernel or memory rather than places files are kept.
const VIRTUAL_FILESYSTEMS = new Set(
    (
        'autofs binfmt_misc bpf cgroup cgroup2 configfs debugfs devpts devtmpfs efivarfs fusectl hugetlbfs' +
        ' mqueue nsfs overlay proc pstore ramfs rpc_pipefs securityfs squashfs sysfs tmpfs tracefs'
    ).split(' '),
);
const SYSTEM_PATHS = ['/proc', '/sys', '/dev', '/run', '/nix/store', '/boot'];
// Mount points deeper than this are usually bind mounts of single settings, not places worth remembering.
export const MAX_MOUNT_DEPTH = 2;
export const MAX_MOUNTS = 12;
export const MAX_SERVICES = 25;
export const SERVICES_PER_STATEMENT = 8;

// Tools a request is likely to need, checked on PATH.
export const COMMON_TOOLS = [
    'git', 'python3', 'pip', 'uv', 'nix', 'node', 'npm', 'cargo', 'rustc', 'go', 'gcc', 'make', 'cmake',
    'docker', 'podman', 'systemctl', 'flatpak', 'sqlite3', 'curl', 'rg', 'jq', 'ffmpeg',
] as const;
export const SERVICE_TIMEOUT_SECONDS = 5;

export type FindCommand = (command: string) => string | null;

// ============================================================================
// Reading the machine
// ============================================================================

// Returns the full path of a command on the search path, or null when there is none.
export function findCommand(command: string): string | null {
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
        if (!directory) {
            continue;
        }
        const candidate = join(directory, command);
        try {
            accessSync(candidate, constants.X_OK);
            if (statSync(candidate).isFile()) {
                return candidate;
            }
        } catch {
            continue;
        }
    }
    return null;
}

function isDirectory(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

function readText(path: string): string | null {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
    } catch {
        return null;
    }
}

// Writes a path the way a Python Path does: no repeated or trailing slashes and no single-dot parts.
function cleanPath(path: string): string {
    const absolute = path.startsWith('/');
    const parts = path.split('/').filter((part) => part && part !== '.');
    return (absolute ? '/' : '') + parts.join('/') || '.';
}

// Splits on runs of whitespace at most this many times, keeping the rest of the line as the last field.
function splitFields(line: string, maxSplit: number): string[] {
    const fields: string[] = [];
    let rest = line.trimStart();
    while (rest && fields.length < maxSplit) {
        const match = /^(\S+)(\s+|$)/.exec(rest)!;
        fields.push(match[1]);
        rest = rest.slice(match[0].length);
    }
    if (rest) {
        fields.push(rest);
    }
    return fields;
}

// ============================================================================
// Locations
// ============================================================================

// Returns the desktop's named folders, such as Documents and Downloads, from its user-dirs file.
function userDirectories(): string[] {
    const home = homedir();
    const text = readText(join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'user-dirs.dirs'));
    if (text === null) {
        return [];
    }
    const statements: string[] = [];
    for (const line of text.split(/\r\n|\r|\n/)) {
        const separator = line.indexOf('=');
        if (separator === -1) {
            continue;
        }
        const name = line.slice(0, separator);
        if (!name.startsWith('XDG_') || !name.endsWith('_DIR')) {
            continue;
        }
        const folder = cleanPath(line.slice(separator + 1).trim().replace(/^"+|"+$/g, '').replaceAll('$HOME', home));
        if (isDirectory(folder) && folder !== cleanPath(home)) {
            const label = name.slice('XDG_'.length, -'_DIR'.length).replace('PUBLICSHARE', 'public share');
            statements.push(`The user's ${casefold(label)} folder is ${folder}.`);
        }
    }
    return statements;
}

function mountedFilesystems(): string[] {
    const text = readText('/proc/mounts');
    if (text === null) {
        return [];
    }
    const statements: string[] = [];
    for (const line of text.split(/\r\n|\r|\n/)) {
        const fields = line.split(/\s+/).filter(Boolean);
        if (fields.length < 3) {
            continue;
        }
        const mountPoint = fields[1].replaceAll('\\040', ' ');
        const filesystem = fields[2];
        if (VIRTUAL_FILESYSTEMS.has(filesystem) || SYSTEM_PATHS.some((prefix) => mountPoint.startsWith(prefix))) {
            continue;
        }
        if (cleanPath(mountPoint).split('/').filter(Boolean).length > MAX_MOUNT_DEPTH || !isDirectory(mountPoint)) {
            continue;
        }
        statements.push(`${mountPoint} is a mounted ${filesystem} filesystem.`);
    }
    return [...new Set(statements)].slice(0, MAX_MOUNTS);
}

export function probeLocations(filesystemRoot: string): string[] {
    const root = resolvePath(expandUser(filesystemRoot));
    const statements = [`The user's home folder is ${homedir()}.`, `CODEX works in the folder ${root}.`];
    statements.push(...userDirectories());
    statements.push(...mountedFilesystems());
    return statements;
}

// ============================================================================
// Software
// ============================================================================

function operatingSystem(): string {
    const text = readText('/etc/os-release');
    for (const line of text === null ? [] : text.split(/\r\n|\r|\n/)) {
        if (line.startsWith('PRETTY_NAME=')) {
            return line.slice(line.indexOf('=') + 1).trim().replace(/^"+|"+$/g, '');
        }
    }
    return type();
}

function commandOutput(command: string, args: string[]): Promise<string | null> {
    return new Promise((done) => {
        execFile(command, args, { encoding: 'utf8', timeout: SERVICE_TIMEOUT_SECONDS * 1000 }, (error, stdout) => {
            // A command that ran and exited with an error still says what it found; one that never ran or timed out says nothing.
            if (error && (typeof error.code !== 'number' || error.killed)) {
                done(null);
                return;
            }
            done(stdout);
        });
    });
}

// Returns the running systemd services as 'name (description)', or nothing when systemd is not there.
async function runningServices(user: boolean, find: FindCommand): Promise<string[]> {
    if (find('systemctl') === null) {
        return [];
    }
    const args = [...(user ? ['--user'] : []), 'list-units', '--type=service', '--state=running', '--no-legend', '--plain'];
    const output = await commandOutput('systemctl', args);
    if (output === null) {
        return [];
    }
    const services: string[] = [];
    for (const line of output.split(/\r\n|\r|\n/)) {
        const fields = splitFields(line, 4);
        // Per-connection D-Bus units come and go with every program, so they say nothing lasting.
        if (fields.length < 4 || fields[0].startsWith('dbus-')) {
            continue;
        }
        const name = fields[0].endsWith('.service') ? fields[0].slice(0, -'.service'.length) : fields[0];
        const description = fields.length > 4 && fields[4] !== fields[0] ? fields[4] : '';
        services.push(description ? `${name} (${description})` : name);
    }
    return services.slice(0, MAX_SERVICES);
}

export async function probeSoftware(options: { findCommand?: FindCommand } = {}): Promise<string[]> {
    const find = options.findCommand ?? findCommand;
    const statements = [
        `The operating system is ${operatingSystem()}, kernel ${release()}, on ${machine()}.`,
        `Node.js ${process.versions.node} runs CODEX from ${process.execPath}.`,
    ];
    const shell = process.env.SHELL;
    if (shell) {
        statements.push(`The user's shell is ${shell}.`);
    }
    const desktop = process.env.XDG_CURRENT_DESKTOP;
    if (desktop) {
        statements.push(`The desktop is ${desktop}.`);
    }
    const installed = COMMON_TOOLS.filter((tool) => find(tool));
    if (installed.length > 0) {
        statements.push(`These commands are installed: ${installed.join(', ')}.`);
    }
    const missing = COMMON_TOOLS.filter((tool) => !installed.includes(tool));
    if (missing.length > 0) {
        statements.push(`These commands are not installed: ${missing.join(', ')}.`);
    }
    for (const [user, owner] of [[false, 'system'], [true, 'user']] as const) {
        const services = await runningServices(user, find);
        // A memory holds 500 characters, so a long list is split rather than cut off.
        for (let start = 0; start < services.length; start += SERVICES_PER_STATEMENT) {
            statements.push(`Running ${owner} services: ${services.slice(start, start + SERVICES_PER_STATEMENT).join(', ')}.`);
        }
    }
    return statements;
}

// ============================================================================
// Recording
// ============================================================================

// When each knowledge store was last probed; a daemon that starts again probes once more, which is cheap.
export const lastProbedAt = new Map<string, number>();

// Probes the machine again once the last probe is older than the refresh interval, and says whether it did.
export async function refreshEnvironment(
    settings: Pick<Settings, 'knowledge_db_path' | 'background_refresh_interval_hours' | 'filesystem_root'>,
    options: { probeSoftware?: () => Promise<string[]> } = {},
): Promise<boolean> {
    const database = String(settings.knowledge_db_path);
    const interval = settings.background_refresh_interval_hours * 3600;
    if (Date.now() / 1000 - (lastProbedAt.get(database) ?? 0) < interval) {
        return false;
    }
    lastProbedAt.set(database, Date.now() / 1000);
    const store = new KnowledgeStore(database);
    store.replaceProbedMemories('locations', probeLocations(settings.filesystem_root));
    store.replaceProbedMemories('software', await (options.probeSoftware ?? probeSoftware)());
    return true;
}
