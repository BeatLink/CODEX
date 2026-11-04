// Read the standing instructions the user writes for every request.
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { expandUser } from './settings.js';

// ============================================================================
// Where the user's files live
// ============================================================================

// A folder's instructions file; the first of these names found in the folder is read.
export const INSTRUCTIONS_FILE_NAMES = ['CODEX.md', 'AGENTS.md'] as const;

// Instructions go into every model call, so they are kept short enough to leave room for the work itself.
export const MAX_INSTRUCTIONS_CHARS = 4000;

export const INSTRUCTIONS_LABEL = 'Standing instructions from the user';

export function configDirectory(): string {
    return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'codex');
}

export function globalInstructionsPath(): string {
    return join(configDirectory(), INSTRUCTIONS_FILE_NAMES[0]);
}

// Return the folder's instructions file, or null when it has none.
export function projectInstructionsPath(filesystemRoot: string): string | null {
    const root = resolve(expandUser(filesystemRoot));
    for (const name of INSTRUCTIONS_FILE_NAMES) {
        const path = join(root, name);
        try {
            if (statSync(path).isFile()) {
                return path;
            }
        } catch {
            // A missing file means the next name is tried.
        }
    }
    return null;
}

// ============================================================================
// Reading the instructions
// ============================================================================

// Return the global instructions, then the folder's own, or an empty string when there are none.
export function loadInstructions(filesystemRoot: string): string {
    const paths = [globalInstructionsPath(), projectInstructionsPath(filesystemRoot)];
    const parts: string[] = [];
    for (const path of new Set(paths.filter((path): path is string => path !== null))) {
        let text: string;
        try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)).trim();
        } catch {
            continue;
        }
        if (text) {
            parts.push(text);
        }
    }
    let instructions = parts.join('\n\n');
    if (instructions.length > MAX_INSTRUCTIONS_CHARS) {
        instructions = instructions.slice(0, MAX_INSTRUCTIONS_CHARS) + '\n[Cut: the instructions are longer than the limit.]';
    }
    return instructions;
}
