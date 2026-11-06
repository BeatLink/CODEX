// Read mail from Maildir folders: parse each new message and queue it as an email.received event.
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { BackgroundOptions } from './background.js';
import { KnowledgeStore } from './knowledge.js';
import { expandUser, type Settings } from './settings.js';

// ============================================================================
// Limits
// ============================================================================

// Bytes read from a message file; the rest is attachments and long quoted history.
export const MAX_MAIL_BYTES = 256 * 1024;

// Characters of body text kept on the event.
export const MAX_MAIL_BODY_CHARS = 4000;

// New messages queued per poll, so a full folder is worked through over several polls.
export const MAIL_FILES_PER_POLL = 25;

const MAX_MIME_DEPTH = 4;
const MAX_HEADER_CHARS = 300;
const KEY_LOOKUP_CHUNK = 400;

// ============================================================================
// Parsing
// ============================================================================

export type ParsedMail = {
    from: string;
    to: string;
    subject: string;
    date: string;
    message_id: string;
    // Why the message looks automated, or an empty string for mail that looks personal.
    bulk: string;
    body: string;
};

type Headers = Map<string, string>;

function splitMessage(raw: string): [head: string, body: string] {
    const match = /\r?\n\r?\n/.exec(raw);
    return match === null ? [raw, ''] : [raw.slice(0, match.index), raw.slice(match.index + match[0].length)];
}

function parseHeaders(head: string): Headers {
    const headers: Headers = new Map();
    const lines = head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/);
    for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon <= 0) {
            continue;
        }
        const name = line.slice(0, colon).trim().toLowerCase();
        if (!headers.has(name)) {
            headers.set(name, line.slice(colon + 1).trim());
        }
    }
    return headers;
}

function decodeBytes(bytes: Buffer, charset: string): string {
    try {
        return new TextDecoder(charset || 'utf-8').decode(bytes);
    } catch {
        return bytes.toString('utf-8');
    }
}

function decodeQuotedPrintable(text: string): Buffer {
    const joined = text.replace(/=\r?\n/g, '');
    const bytes: number[] = [];
    for (let index = 0; index < joined.length; index += 1) {
        const hex = joined.slice(index + 1, index + 3);
        if (joined[index] === '=' && /^[0-9a-fA-F]{2}$/.test(hex)) {
            bytes.push(parseInt(hex, 16));
            index += 2;
        } else {
            bytes.push(...Buffer.from(joined[index], 'latin1'));
        }
    }
    return Buffer.from(bytes);
}

// Decode the =?charset?encoding?text?= words a header may hold.
export function decodeHeader(value: string): string {
    const words = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;
    const decoded = value.replace(/(\?=)\s+(?==\?)/g, '$1').replace(words, (_match, charset: string, encoding: string, text: string) => {
        const bytes = encoding.toLowerCase() === 'b' ? Buffer.from(text, 'base64') : decodeQuotedPrintable(text.replace(/_/g, ' '));
        return decodeBytes(bytes, charset);
    });
    return decoded.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_HEADER_CHARS);
}

function decodeBody(body: string, headers: Headers): string {
    const charset = /charset="?([^";\s]+)/i.exec(headers.get('content-type') ?? '')?.[1] ?? 'utf-8';
    const encoding = (headers.get('content-transfer-encoding') ?? '').toLowerCase();
    if (encoding === 'base64') {
        return decodeBytes(Buffer.from(body, 'base64'), charset);
    }
    if (encoding === 'quoted-printable') {
        return decodeBytes(decodeQuotedPrintable(body), charset);
    }
    return decodeBytes(Buffer.from(body, 'latin1'), charset);
}

const HTML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function htmlToText(html: string): string {
    return html
        .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)\b[^>]*>/gi, '\n')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&(#\d+|[a-z]+);/gi, (match, name: string) =>
            name.startsWith('#') ? String.fromCodePoint(Number(name.slice(1)) || 32) : (HTML_ENTITIES[name.toLowerCase()] ?? match),
        );
}

function tidyText(text: string): string {
    return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// The first text part of a message, preferring plain text over HTML and skipping attachments.
function findText(head: string, body: string, depth: number): string {
    const headers = parseHeaders(head);
    const contentType = (headers.get('content-type') ?? 'text/plain').toLowerCase();
    if ((headers.get('content-disposition') ?? '').toLowerCase().startsWith('attachment')) {
        return '';
    }
    if (contentType.startsWith('multipart/')) {
        const boundary = /boundary="?([^";\s]+)/i.exec(headers.get('content-type') ?? '')?.[1];
        if (!boundary || depth >= MAX_MIME_DEPTH) {
            return '';
        }
        const parts = body.split(`--${boundary}`).slice(1).filter((part) => !part.startsWith('--'));
        const texts = parts.map((part) => {
            const [partHead, partBody] = splitMessage(part.replace(/^\r?\n/, ''));
            return [partHead, findText(partHead, partBody, depth + 1)] as const;
        });
        const plain = texts.find(([partHead, text]) => text && !/text\/html/i.test(partHead));
        return (plain ?? texts.find(([, text]) => text))?.[1] ?? '';
    }
    if (contentType.startsWith('text/html')) {
        return htmlToText(decodeBody(body, headers));
    }
    return contentType.startsWith('text/') ? decodeBody(body, headers) : '';
}

const AUTOMATED_SENDER = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|bounce[sd]?)([+._-][^@]*)?@/i;

// Say why a message looks automated, from the headers and sender that mail systems set on bulk mail.
export function bulkReason(headers: Headers, sender: string): string {
    const autoSubmitted = (headers.get('auto-submitted') ?? '').toLowerCase();
    if (autoSubmitted && autoSubmitted !== 'no') {
        return 'automatic message';
    }
    if (/^(bulk|list|junk)$/i.test(headers.get('precedence') ?? '')) {
        return 'bulk precedence';
    }
    if (headers.has('list-unsubscribe') || headers.has('list-id')) {
        return 'mailing list';
    }
    if (AUTOMATED_SENDER.test(/<([^>]+)>/.exec(sender)?.[1] ?? sender)) {
        return 'automated sender';
    }
    return '';
}

export function parseMail(raw: string): ParsedMail {
    const [head, body] = splitMessage(raw);
    const headers = parseHeaders(head);
    const from = decodeHeader(headers.get('from') ?? '');
    return {
        from,
        to: decodeHeader(headers.get('to') ?? ''),
        subject: decodeHeader(headers.get('subject') ?? ''),
        date: decodeHeader(headers.get('date') ?? ''),
        message_id: decodeHeader(headers.get('message-id') ?? ''),
        bulk: bulkReason(headers, from),
        body: tidyText(findText(head, body, 0)).slice(0, MAX_MAIL_BODY_CHARS),
    };
}

// ============================================================================
// Maildir connector
// ============================================================================

function readStart(path: string): string {
    const descriptor = openSync(path, 'r');
    try {
        const buffer = Buffer.alloc(MAX_MAIL_BYTES);
        const length = readSync(descriptor, buffer, 0, MAX_MAIL_BYTES, 0);
        return buffer.subarray(0, length).toString('latin1');
    } finally {
        closeSync(descriptor);
    }
}

// A Maildir file name without the flags a mail client adds after the colon.
function uniqueName(fileName: string): string {
    const colon = fileName.indexOf(':');
    return colon < 0 ? fileName : fileName.slice(0, colon);
}

// Watches the new/ folder of each configured Maildir and queues every recent message once.
export class MailConnector {
    // Files too old or unreadable, remembered so each poll does not look at them again.
    private readonly skipped = new Set<string>();

    async poll(settings: Settings, _options: BackgroundOptions = {}): Promise<boolean> {
        if (settings.mail_maildir_paths.length === 0) {
            return false;
        }
        const store = new KnowledgeStore(settings.knowledge_db_path);
        let posted = 0;
        for (const given of settings.mail_maildir_paths) {
            posted += this.pollFolder(store, expandUser(given), settings);
        }
        return posted > 0;
    }

    private pollFolder(store: KnowledgeStore, folder: string, settings: Settings): number {
        const source = `maildir:${folder}`;
        let names: string[];
        try {
            names = readdirSync(join(folder, 'new')).filter((name) => !name.startsWith('.')).sort();
        } catch {
            return 0;
        }
        const keyed = names.map((name) => [name, uniqueName(name)] as const).filter(([name]) => !this.skipped.has(`${source}/${name}`));
        const known = new Set<string>();
        for (let start = 0; start < keyed.length; start += KEY_LOOKUP_CHUNK) {
            const keys = keyed.slice(start, start + KEY_LOOKUP_CHUNK).map(([, key]) => key);
            store.knownEventKeys(source, keys).forEach((key) => known.add(key));
        }
        const oldest = Date.now() - settings.mail_max_age_days * 86_400_000;
        let posted = 0;
        for (const [name, key] of keyed) {
            if (posted >= MAIL_FILES_PER_POLL) {
                break;
            }
            if (known.has(key)) {
                continue;
            }
            const path = join(folder, 'new', name);
            try {
                const stats = statSync(path);
                if (!stats.isFile() || stats.mtimeMs < oldest) {
                    this.skipped.add(`${source}/${name}`);
                    continue;
                }
                const mail = parseMail(readStart(path));
                const result = store.enqueueEvent({ source, type: 'email.received', dedupeKey: key, payload: { ...mail, file: name } });
                posted += result.duplicate ? 0 : 1;
            } catch (error) {
                // A full queue ends this poll; any other failure skips just this file.
                if (error instanceof Error && error.message.includes('queue is full')) {
                    return posted;
                }
                this.skipped.add(`${source}/${name}`);
            }
        }
        return posted;
    }
}
