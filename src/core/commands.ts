// Slash commands: memory commands answered without the model, /init, and commands the user defines in files.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { INSTRUCTIONS_FILE_NAMES, configDirectory, projectInstructionsPath } from './instructions.js';
import { USER_MEMORY_KINDS } from './knowledge.js';
import { expandUser } from './settings.js';

// ============================================================================
// Memory commands
// ============================================================================

export const MEMORY_COMMANDS = ['/remember', '/forget', '/memories'] as const;

// "Why:" starts the reason a remembered statement holds.
const REASON = /\s*\bwhy:\s*/i;

export type UserMemory = {
    id: number;
    kind: string;
    statement: string;
    reason: string;
    origin: string;
    scope: string;
};

// The part of the knowledge store the memory commands use.
export type MemoryStore = {
    addUserMemory(kind: string, statement: string, options?: { reason?: string; origin?: string; scope?: string }): number;
    userMemories(options?: { limit?: number; scope?: string | null }): Array<Record<string, unknown>>;
    forgetUserMemory(memoryId: number): boolean;
};

// Return the prompt's leading word in lower case and the text after it.
function commandWord(userPrompt: string): [string, string] {
    const trimmed = userPrompt.trim();
    const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
    if (!match || !match[1].startsWith('/')) {
        return ['', userPrompt];
    }
    return [match[1].toLowerCase(), (match[2] ?? '').trim()];
}

export function isMemoryCommand(userPrompt: string): boolean {
    return (MEMORY_COMMANDS as readonly string[]).includes(commandWord(userPrompt)[0]);
}

// Carry out /remember, /forget, or /memories and return the reply to show.
export function runMemoryCommand(userPrompt: string, knowledgeStore: MemoryStore | null, scope: string): string {
    const [command, text] = commandWord(userPrompt);
    if (knowledgeStore === null) {
        return 'There is no knowledge store to keep memories in; set knowledge_db_path in the settings.';
    }
    if (command === '/remember') {
        return remember(knowledgeStore, text, scope);
    }
    if (command === '/forget') {
        return forget(knowledgeStore, text, scope);
    }
    return listMemories(knowledgeStore, scope);
}

function remember(knowledgeStore: MemoryStore, text: string, scope: string): string {
    const kinds = USER_MEMORY_KINDS.join(', ');
    const space = text.indexOf(' ');
    const firstWord = space === -1 ? text : text.slice(0, space);
    let kind = firstWord.toLowerCase().replace(/:+$/, '');
    if ((USER_MEMORY_KINDS as readonly string[]).includes(kind)) {
        text = space === -1 ? '' : text.slice(space + 1).trim();
    } else {
        kind = 'preference';
    }
    const reasonStart = REASON.exec(text);
    let statement = reasonStart ? text.slice(0, reasonStart.index) : text;
    const reason = reasonStart ? text.slice(reasonStart.index + reasonStart[0].length) : '';
    statement = statement.trim();
    if (!statement) {
        return `Say what to remember, for example: /remember preference Answer in British English. Why: I work in the UK. Kinds: ${kinds}.`;
    }
    // A project memory belongs to the folder it was stated in; everything else holds everywhere.
    const memoryScope = kind === 'project' ? scope : '';
    const memoryId = knowledgeStore.addUserMemory(kind, statement, { reason: reason.trim(), origin: 'user', scope: memoryScope });
    const where = memoryScope ? ' for this folder' : '';
    return `Remembered${where} as memory ${memoryId} (${kind}): ${statement}`;
}

function forget(knowledgeStore: MemoryStore, text: string, scope: string): string {
    if (!text) {
        return 'Say which memory to forget: its number from /memories, or words from it.';
    }
    const memories = knowledgeStore.userMemories({ limit: 10_000, scope }) as UserMemory[];
    let matches: UserMemory[];
    if (/^\d+$/.test(text)) {
        matches = memories.filter((memory) => memory.id === Number(text));
    } else {
        const words = text.toLowerCase().split(/\s+/).filter(Boolean);
        matches = memories.filter((memory) => words.every((word) => memory.statement.toLowerCase().includes(word)));
    }
    if (matches.length === 0) {
        return `No memory matches '${text}'. List them with /memories.`;
    }
    if (matches.length > 1) {
        // Deleting cannot be undone, so several matches are listed instead of all being forgotten.
        return 'Several memories match; forget one by its number:\n' + memoryLines(matches);
    }
    knowledgeStore.forgetUserMemory(matches[0].id);
    return `Forgot memory ${matches[0].id}: ${matches[0].statement}`;
}

function listMemories(knowledgeStore: MemoryStore, scope: string): string {
    const memories = knowledgeStore.userMemories({ limit: 10_000, scope }) as UserMemory[];
    if (memories.length === 0) {
        return 'No memories yet. Add one with /remember.';
    }
    return 'Memories for this folder, newest first:\n' + memoryLines(memories);
}

function memoryLines(memories: UserMemory[]): string {
    return memories
        .map(
            (memory) =>
                `${memory.id}. (${memory.kind}` +
                (memory.scope ? ', this folder' : '') +
                (memory.origin === 'learned' ? ', learned' : '') +
                `) ${memory.statement}` +
                (memory.reason ? ` Why: ${memory.reason}` : ''),
        )
        .join('\n');
}

// ============================================================================
// Commands the user defines
// ============================================================================

// A command name is one word, so a path such as /etc/hosts at the start of a prompt is never taken for one.
const COMMAND_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const FRONT_MATTER = /^---\s*\n([\s\S]*?)\n---\s*\n?/;
export const COMMAND_MODES = ['answer', 'draft', 'execute'] as const;

export class Command {
    constructor(
        public name: string,
        public description: string,
        public mode: string | null,
        public template: string,
        public path: string,
    ) {}
}

// Return where command files live, the folder's own last so they win over global ones of the same name.
export function commandDirectories(filesystemRoot: string): string[] {
    const root = resolve(expandUser(filesystemRoot));
    return [join(configDirectory(), 'commands'), join(root, '.codex', 'commands')];
}

function commandFiles(directory: string): string[] {
    try {
        if (!statSync(directory).isDirectory()) {
            return [];
        }
        return readdirSync(directory)
            .filter((name) => name.endsWith('.md'))
            .map((name) => join(directory, name))
            .sort();
    } catch {
        return [];
    }
}

export function loadCommands(filesystemRoot: string): Map<string, Command> {
    const commands = new Map<string, Command>();
    for (const directory of commandDirectories(filesystemRoot)) {
        for (const path of commandFiles(directory)) {
            const command = readCommand(path);
            if (command !== null) {
                commands.set(command.name, command);
            }
        }
    }
    return commands;
}

function readCommand(path: string): Command | null {
    const name = basename(path, '.md').toLowerCase();
    if (!COMMAND_NAME.test(name) || (MEMORY_COMMANDS as readonly string[]).includes(`/${name}`) || name === 'init') {
        return null;
    }
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
    } catch {
        return null;
    }
    const fields: Record<string, string> = {};
    const frontMatter = FRONT_MATTER.exec(text);
    if (frontMatter) {
        for (const line of frontMatter[1].split(/\r\n|\r|\n/)) {
            const separator = line.indexOf(':');
            if (separator !== -1) {
                fields[line.slice(0, separator).trim().toLowerCase()] = line
                    .slice(separator + 1)
                    .trim()
                    .replace(/^["']+|["']+$/g, '');
            }
        }
        text = text.slice(frontMatter[0].length);
    }
    let mode: string | null = (fields.mode ?? '').toLowerCase() || null;
    if (mode !== null && !(COMMAND_MODES as readonly string[]).includes(mode)) {
        mode = null;
    }
    return new Command(name, fields.description ?? '', mode, text.trim(), path);
}

// Put the command's arguments where $ARGUMENTS stands, or after the template when it has no such place.
function fillTemplate(template: string, argumentsText: string): string {
    if (template.includes('$ARGUMENTS')) {
        return template.split('$ARGUMENTS').join(argumentsText);
    }
    return argumentsText ? `${template}\n\n${argumentsText}`.trim() : template;
}

// ============================================================================
// /init
// ============================================================================

export const INIT_PROMPT =
    "Read this folder's README, build and package files, and test setup, then write a short" +
    ` ${INSTRUCTIONS_FILE_NAMES[0]} for it: how to build it, how to run its tests, how its files are` +
    ' laid out, and the rules anyone changing it must follow. Give each rule as one short, plain line' +
    ' under a few headings, and include only what the files show.';

function initPrompt(filesystemRoot: string, allowFileWrites: boolean, argumentsText: string): [string, string] {
    const existing = projectInstructionsPath(filesystemRoot);
    let prompt = INIT_PROMPT;
    if (existing !== null) {
        prompt += ` ${basename(existing)} already exists: read it, keep what is still right, and improve the rest.`;
    }
    let mode: string;
    if (allowFileWrites) {
        prompt += ` Write the result to ${INSTRUCTIONS_FILE_NAMES[0]} at the top of the folder and change no other file.`;
        mode = 'execute';
    } else {
        prompt += " Writing files is turned off, so reply with the file's full text only.";
        mode = 'draft';
    }
    return [mode, fillTemplate(prompt, argumentsText)];
}

// ============================================================================
// Expanding a prompt
// ============================================================================

// Return the mode a leading /init or user command picks, or null, and the prompt it expands to; other prompts come back unchanged.
export function expandCommand(userPrompt: string, filesystemRoot: string, allowFileWrites: boolean): [string | null, string] {
    const [word, argumentsText] = commandWord(userPrompt);
    const name = word.slice(1);
    if (name === 'init') {
        return initPrompt(filesystemRoot, allowFileWrites, argumentsText);
    }
    if (!COMMAND_NAME.test(name)) {
        return [null, userPrompt];
    }
    const command = loadCommands(filesystemRoot).get(name);
    if (command === undefined) {
        return [null, userPrompt];
    }
    return [command.mode, fillTemplate(command.template, argumentsText)];
}
