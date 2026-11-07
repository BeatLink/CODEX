// Read the model's prompts from the bundle shipped in share/prompts/, one file per prompt.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The shipped prompts; they change only with the code, through the eval, and are not a settings file.
export const PROMPTS_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'share', 'prompts');
// A folder of prompt variants for an eval run: a file there replaces the shipped one of the same name.
export const PROMPTS_OVERRIDE_VARIABLE = 'CODEX_PROMPTS_DIR';
export const PROMPT_EXTENSION = '.txt';
// Values are written into a prompt where it says {{NAME}}, so a number the code also enforces is stated once.
const PLACEHOLDER = /\{\{([A-Z_]+)\}\}/g;

const cache = new Map<string, string>();

// Where the prompt's text comes from: the override folder when it has the file, otherwise the bundle.
export function promptPath(name: string): string {
    const override = process.env[PROMPTS_OVERRIDE_VARIABLE];
    if (override) {
        const candidate = join(override, name + PROMPT_EXTENSION);
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    return join(PROMPTS_DIRECTORY, name + PROMPT_EXTENSION);
}

// A prompt is its file's text with one trailing newline removed; nothing else is trimmed, so a note
// that begins with a space to follow the sentence before it keeps that space.
export function readPrompt(name: string): string {
    let text = cache.get(name);
    if (text === undefined) {
        const path = promptPath(name);
        if (!existsSync(path)) {
            throw new Error(`Prompt file missing: ${path}`);
        }
        text = readFileSync(path, 'utf-8').replace(/\n$/, '');
        cache.set(name, text);
    }
    return text;
}

// A prompt from the bundle with its placeholders filled; a placeholder without a value, or a value
// the prompt has no place for, is an error, so a renamed placeholder cannot slip through unfilled.
export function prompt(name: string, values: Record<string, string | number> = {}): string {
    const unused = new Set(Object.keys(values));
    const text = readPrompt(name).replace(PLACEHOLDER, (_, key: string) => {
        if (!(key in values)) {
            throw new Error(`Prompt ${name} has no value for {{${key}}}`);
        }
        unused.delete(key);
        return String(values[key]);
    });
    if (unused.size > 0) {
        throw new Error(`Prompt ${name} has no place for ${[...unused].join(', ')}`);
    }
    return text;
}

// Forget the prompts read so far, so a changed override folder takes effect.
export function clearPromptCache(): void {
    cache.clear();
}
