import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { projectInstructionsPath } from './instructions.js';

export const MEMORY_COMMANDS = ['/remember', '/forget', '/memories'] as const;
export const COMMAND_MODES = ['answer', 'draft', 'execute'] as const;

export type Command = {
    name: string;
    description: string;
    mode: string | null;
    template: string;
    path: string;
};

export function commandWord(userPrompt: string): [string, string] {
    const trimmed = userPrompt.trim();
    const parts = trimmed.split(/\s+/);
    if (!parts.length || !parts[0].startsWith('/')) {
        return ['', trimmed];
    }
    return [parts[0].toLowerCase(), parts.slice(1).join(' ')];
}

export function isMemoryCommand(userPrompt: string): boolean {
    return MEMORY_COMMANDS.includes(commandWord(userPrompt)[0] as typeof MEMORY_COMMANDS[number]);
}

export function configDirectory(): string {
    const configHome = process.env.XDG_CONFIG_HOME;
    if (configHome) {
        return join(configHome, 'codex');
    }
    return join(homedir(), '.config', 'codex');
}

export function commandDirectories(filesystemRoot: string): string[] {
    const root = resolve(filesystemRoot);
    return [join(configDirectory(), 'commands'), join(root, '.codex', 'commands')];
}

export function loadCommands(filesystemRoot: string): Record<string, Command> {
    const commands: Record<string, Command> = {};
    for (const directory of commandDirectories(filesystemRoot)) {
        if (!existsSync(directory)) {
            continue;
        }

        const candidates = readdirSync(directory, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
            .map((entry) => join(directory, entry.name))
            .sort();

        for (const path of candidates) {
            const command = readCommand(path);
            if (command) {
                commands[command.name] = command;
            }
        }
    }
    return commands;
}

export function readCommand(path: string): Command | null {
    const name = path.split('/').pop()?.replace(/\.md$/i, '') ?? '';
    const safeName = name.toLowerCase();
    if (!safeName || !/^[a-z0-9][a-z0-9_-]*$/.test(safeName) || `/${safeName}` in MEMORY_COMMANDS || safeName === 'init') {
        return null;
    }

    try {
        let text = readFileSync(path, 'utf-8');
        const frontMatter = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(text);
        const fields: Record<string, string> = {};
        if (frontMatter) {
            for (const line of frontMatter[1].split(/\r?\n/)) {
                const idx = line.indexOf(':');
                if (idx < 0) {
                    continue;
                }
                const key = line.slice(0, idx).trim().toLowerCase();
                const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
                fields[key] = value;
            }
            text = text.slice(frontMatter[0].length);
        }

        let mode: string | null = (fields.mode ?? '').toLowerCase() || null;
        if (mode && !COMMAND_MODES.includes(mode as typeof COMMAND_MODES[number])) {
            mode = null;
        }

        return {
            name: safeName,
            description: fields.description ?? '',
            mode,
            template: text.trim(),
            path,
        };
    } catch {
        return null;
    }
}

export function fillTemplate(template: string, argumentsText: string): string {
    if (template.includes('$ARGUMENTS')) {
        return template.replace(/\$ARGUMENTS/g, argumentsText);
    }
    if (argumentsText) {
        return `${template}\n\n${argumentsText}`.trim();
    }
    return template;
}

export const INIT_PROMPT = [
    'Read this folder\'s README, build and package files, and test setup, then write a short',
    'CODEX.md for it: how to build it, how to run its tests, how its files are',
    'laid out, and the rules anyone changing it must follow. Give each rule as one short, plain line',
    'under a few headings, and include only what the files show.',
].join(' ');

export function initPrompt(filesystemRoot: string, allowFileWrites: boolean, argumentsText: string): [string, string] {
    const existing = projectInstructionsPath(filesystemRoot);
    let prompt = INIT_PROMPT;
    if (existing) {
        prompt += ` ${existing.split('/').pop()} already exists: read it, keep what is still right, and improve the rest.`;
    }
    if (allowFileWrites) {
        prompt += ` Write the result to CODEX.md at the top of the folder and change no other file.`;
        return ['execute', fillTemplate(prompt, argumentsText)];
    }
    prompt += ' Writing files is turned off, so reply with the file\'s full text only.';
    return ['draft', fillTemplate(prompt, argumentsText)];
}

export function expandCommand(userPrompt: string, filesystemRoot: string, allowFileWrites: boolean): [string | null, string] {
    const [commandWordValue, argumentsText] = commandWord(userPrompt);
    const name = commandWordValue.slice(1);
    if (name === 'init') {
        return initPrompt(filesystemRoot, allowFileWrites, argumentsText);
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
        return [null, userPrompt];
    }
    const command = loadCommands(filesystemRoot)[name];
    if (!command) {
        return [null, userPrompt];
    }
    return [command.mode, fillTemplate(command.template, argumentsText)];
}
