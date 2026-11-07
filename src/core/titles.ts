// Short titles for topics and conversations: what a title must be, the prompts that ask for one, and titling conversations in idle time.
import { BackgroundModel, BackgroundPaused, type BackgroundOptions } from './background.js';
import type { Section } from './contextBudget.js';
import { KnowledgeStore, MAX_TOPIC_NAME_CHARS, MAX_TOPIC_NAME_WORDS, casefold, comparisonTerms } from './knowledge.js';
import { prompt } from './prompts.js';
import type { Settings } from './settings.js';

// ============================================================================
// What a title is
// ============================================================================

export const MAX_TITLE_WORDS = MAX_TOPIC_NAME_WORDS;
export const MAX_TITLE_CHARS = MAX_TOPIC_NAME_CHARS;

function splitWords(text: string): string[] {
    return text.split(/\s+/).filter(Boolean);
}

export function collapseSpaces(text: string): string {
    return splitWords(text).join(' ');
}

export function isTitle(name: string): boolean {
    const length = Array.from(name).length;
    return length > 0 && length <= MAX_TITLE_CHARS && splitWords(name).length <= MAX_TITLE_WORDS;
}

// A title must share a word with the text it names, so it cannot come from somewhere else.
export function grounded(name: string, texts: string[]): boolean {
    const textTerms = comparisonTerms(texts.join(' '));
    return [...comparisonTerms(name)].some((term) => textTerms.has(term));
}

// Words that make a name about checking a claim rather than about a subject.
export const CLAIM_WORDS: ReadonlySet<string> = new Set(['claim', 'claims', 'verification', 'unverified', 'fact-checking', 'fact-check']);

export function isAboutAClaim(name: string): boolean {
    return splitWords(casefold(name).replaceAll(',', ' ')).some((word) => CLAIM_WORDS.has(word));
}

// Read the 'name' from a title reply, or null when the reply is not JSON with one.
export function readTitle(reply: string): string | null {
    let data: unknown;
    try {
        data = JSON.parse(reply);
    } catch {
        return null;
    }
    return typeof data === 'object' && data !== null && !Array.isArray(data) && 'name' in data
        ? collapseSpaces(String((data as Record<string, unknown>).name))
        : null;
}

// The first words of a request, cut to a title's length, for when the model gives no usable title.
export function fallbackTitle(prompt: string): string {
    const words = splitWords(prompt).slice(0, MAX_TITLE_WORDS);
    while (words.length > 1 && !isTitle(words.join(' '))) {
        words.pop();
    }
    return Array.from(words.join(' ')).slice(0, MAX_TITLE_CHARS).join('');
}

// ============================================================================
// Prompts
// ============================================================================

export const TITLE_SCHEMA = {
    type: 'object',
    properties: {
        reason: { type: 'string', maxLength: 300 },
        name: { type: 'string', maxLength: 80 },
    },
    required: ['reason', 'name'],
};

export const TOPIC_TITLE_PROMPT = prompt('topic-title', { MAX_TITLE_WORDS });

export const CONVERSATION_TITLE_PROMPT = prompt('conversation-title', { MAX_TITLE_WORDS });

// ============================================================================
// Titling conversations
// ============================================================================

// Long enough to show what a request is about, short enough to leave the reply room.
const REQUEST_CHARS = 1500;

// Give one untitled conversation a title, returning false when every conversation has one.
export async function titleConversations(settings: Settings, options: BackgroundOptions = {}): Promise<boolean> {
    const store = new KnowledgeStore(settings.knowledge_db_path);
    const conversation = store.nextConversationToTitle();
    if (conversation === null) {
        return false;
    }
    const report = options.onProgress ?? (() => {});
    const model = BackgroundModel.fromOptions(settings, options);
    const prompt = String(conversation.prompt);
    report('Titling a conversation');
    const sections: Section[] = [['Request to title', Array.from(prompt).slice(0, REQUEST_CHARS).join('')]];
    let title: string | null;
    try {
        title = readTitle(await model.run(CONVERSATION_TITLE_PROMPT, await model.fit(CONVERSATION_TITLE_PROMPT, sections, 1), TITLE_SCHEMA));
    } catch (error) {
        if (error instanceof BackgroundPaused) {
            report('Paused for foreground work');
            return true;
        }
        report(`Titling failed: ${error instanceof Error ? error.message : String(error)}`);
        title = null;
    }
    // A failed or unusable reply still leaves a title, so the conversation is not asked about on every idle pass.
    if (!title || !isTitle(title) || !grounded(title, [prompt])) {
        title = fallbackTitle(prompt) || 'Untitled request';
    }
    store.setConversationTitle(conversation.kind, conversation.id, title);
    report(`Titled a conversation ${title}`);
    return true;
}
