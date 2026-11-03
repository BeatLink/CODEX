import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const INSTRUCTIONS_FILE_NAMES = ['CODEX.md', 'AGENTS.md'] as const;
export const MAX_INSTRUCTIONS_CHARS = 4000;
export const INSTRUCTIONS_LABEL = 'Standing instructions from the user';

export function configDirectory(): string {
    const configHome = process.env.XDG_CONFIG_HOME;
    if (configHome) {
        return join(configHome, 'codex');
    }
    return join(homedir(), '.config', 'codex');
}

export function globalInstructionsPath(): string {
    return join(configDirectory(), INSTRUCTIONS_FILE_NAMES[0]);
}

export function projectInstructionsPath(filesystemRoot: string): string | null {
    const root = resolve(filesystemRoot);
    for (const name of INSTRUCTIONS_FILE_NAMES) {
        const candidate = join(root, name);
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}

export function loadInstructions(filesystemRoot: string): string {
    const paths = [globalInstructionsPath(), projectInstructionsPath(filesystemRoot)];
    const parts: string[] = [];

    for (const path of [...new Set(paths.filter((value): value is string => value !== null))]) {
        try {
            const text = readFileSync(path, 'utf-8').trim();
            if (text) {
                parts.push(text);
            }
        } catch {
            // Ignore unreadable or missing instruction files.
        }
    }

    let instructions = parts.join('\n\n');
    if (instructions.length > MAX_INSTRUCTIONS_CHARS) {
        instructions = instructions.slice(0, MAX_INSTRUCTIONS_CHARS) + '\n[Cut: the instructions are longer than the limit.]';
    }
    return instructions;
}
