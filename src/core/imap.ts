// Read new mail from IMAP mailboxes over TLS as events, without ever storing the password.
import { execFile } from 'node:child_process';
import type { Duplex } from 'node:stream';
import { connect } from 'node:tls';
import { promisify } from 'node:util';
import type { BackgroundOptions } from './background.js';
import { KnowledgeStore } from './knowledge.js';
import { MAIL_FILES_PER_POLL, MAX_MAIL_BYTES, parseMail } from './mail.js';
import type { ImapAccount, Settings } from './settings.js';

const run = promisify(execFile);

// A mailbox is asked for mail no more often than this, so an idle assistant does not hammer the server.
export const IMAP_POLL_SECONDS = 120;
const IMAP_TIMEOUT_MILLISECONDS = 30_000;
const PASSWORD_TIMEOUT_MILLISECONDS = 10_000;
const MAX_PASSWORD_CHARS = 1024;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ============================================================================
// The protocol
// ============================================================================

type Reply = { line: string; literals: Buffer[] };

class ImapError extends Error {}

// A quoted IMAP string; the characters that could end it or start a new command are refused.
function quoted(value: string): string {
    if (/[\r\n\0]/.test(value)) {
        throw new ImapError('An IMAP value held a line break.');
    }
    return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

// Talks to one server: sends tagged commands and returns the untagged replies, with their literals, that came before the answer.
export class ImapSession {
    private buffer = Buffer.alloc(0);
    private waiting: (() => void) | null = null;
    private failure: Error | null = null;
    private tag = 0;

    constructor(private readonly socket: Duplex) {
        socket.on('data', (chunk: Buffer) => {
            this.buffer = Buffer.concat([this.buffer, chunk]);
            this.wake();
        });
        const fail = (error: Error): void => {
            this.failure = error;
            this.wake();
        };
        socket.on('error', fail);
        socket.on('close', () => fail(new ImapError('The server closed the connection.')));
        // A plain test socket has no timeout; a TLS one does.
        (socket as { setTimeout?: (milliseconds: number, callback: () => void) => void }).setTimeout?.(IMAP_TIMEOUT_MILLISECONDS, () =>
            fail(new ImapError('The server stopped answering.')),
        );
    }

    private wake(): void {
        const resume = this.waiting;
        this.waiting = null;
        resume?.();
    }

    private async more(): Promise<void> {
        if (this.failure) {
            throw this.failure;
        }
        await new Promise<void>((resolve) => {
            this.waiting = resolve;
        });
        if (this.failure && this.buffer.length === 0) {
            throw this.failure;
        }
    }

    // Reads one reply: a line, with any {n} literal it announces and the line's rest after each.
    private async readReply(): Promise<Reply> {
        const literals: Buffer[] = [];
        let line = '';
        for (;;) {
            let end = this.buffer.indexOf('\r\n');
            while (end < 0) {
                await this.more();
                end = this.buffer.indexOf('\r\n');
            }
            const part = this.buffer.subarray(0, end).toString('utf8');
            this.buffer = this.buffer.subarray(end + 2);
            line += part;
            const announced = /\{(\d+)\}$/.exec(part);
            if (!announced) {
                return { line, literals };
            }
            const size = Number(announced[1]);
            if (size > MAX_MAIL_BYTES * 2) {
                throw new ImapError('The server sent a message that is too large.');
            }
            while (this.buffer.length < size) {
                await this.more();
            }
            literals.push(Buffer.from(this.buffer.subarray(0, size)));
            this.buffer = this.buffer.subarray(size);
        }
    }

    async greeting(): Promise<void> {
        const { line } = await this.readReply();
        if (!/^\* (OK|PREAUTH)/i.test(line)) {
            throw new ImapError('The server did not greet us.');
        }
    }

    async command(text: string, secret = false): Promise<Reply[]> {
        const tag = `a${++this.tag}`;
        this.socket.write(`${tag} ${text}\r\n`);
        const replies: Reply[] = [];
        for (;;) {
            const reply = await this.readReply();
            if (reply.line.startsWith(`${tag} `)) {
                if (!/^\S+ OK/i.test(reply.line)) {
                    // A refused login line is never copied into the message, as it can echo what was sent.
                    throw new ImapError(secret ? 'The server refused the login.' : `The server refused a command: ${reply.line.slice(0, 120)}`);
                }
                return replies;
            }
            replies.push(reply);
        }
    }

    close(): void {
        this.socket.destroy();
    }
}

// ============================================================================
// Connecting
// ============================================================================

export type OpenSocket = (account: ImapAccount) => Promise<Duplex>;

const openTls: OpenSocket = (account) =>
    new Promise((resolve, reject) => {
        const socket = connect({ host: account.host, port: account.port, servername: account.host }, () => resolve(socket));
        socket.once('error', reject);
    });

export type PasswordReader = (command: string[]) => Promise<string>;

// Run the account's password command and take its first line; the program, not settings, holds the secret.
const readPassword: PasswordReader = async ([program, ...args]) => {
    const { stdout } = await run(program, args, { timeout: PASSWORD_TIMEOUT_MILLISECONDS, maxBuffer: MAX_PASSWORD_CHARS * 4, encoding: 'utf8' });
    const password = stdout.split('\n')[0].replace(/\r$/, '');
    if (!password || password.length > MAX_PASSWORD_CHARS) {
        throw new ImapError('The password command gave no usable password.');
    }
    return password;
};

function imapDate(milliseconds: number): string {
    const date = new Date(milliseconds);
    return `${date.getUTCDate()}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

// ============================================================================
// Polling
// ============================================================================

export class ImapConnector {
    private readonly lastPolled = new Map<string, number>();

    constructor(
        private readonly open: OpenSocket = openTls,
        private readonly password: PasswordReader = readPassword,
        private readonly clock: () => number = Date.now,
    ) {}

    async poll(settings: Settings, options: BackgroundOptions = {}): Promise<boolean> {
        const report = options.onProgress ?? (() => {});
        const store = settings.mail_imap_accounts.length > 0 ? new KnowledgeStore(settings.knowledge_db_path) : null;
        let posted = 0;
        for (const account of settings.mail_imap_accounts) {
            const now = this.clock();
            const last = this.lastPolled.get(account.name);
            if (last !== undefined && now - last < IMAP_POLL_SECONDS * 1000) {
                continue;
            }
            // A failure is waited out like a success, so a down server is not retried on every pass.
            this.lastPolled.set(account.name, now);
            try {
                posted += await this.pollAccount(store!, account, settings);
            } catch (error) {
                report(`Mail account ${account.name}: ${error instanceof Error ? error.message : 'the poll failed'}`);
            }
        }
        return posted > 0;
    }

    private async pollAccount(store: KnowledgeStore, account: ImapAccount, settings: Settings): Promise<number> {
        const session = new ImapSession(await this.open(account));
        try {
            await session.greeting();
            await session.command(`LOGIN ${quoted(account.username)} ${quoted(await this.password(account.password_command))}`, true);
            // EXAMINE opens the mailbox read-only, and BODY.PEEK leaves messages unread, so polling changes nothing on the server.
            const opened = await session.command(`EXAMINE ${quoted(account.folder)}`);
            const validity = opened.map((reply) => /\[UIDVALIDITY (\d+)\]/i.exec(reply.line)?.[1]).find(Boolean) ?? '0';
            const since = imapDate(this.clock() - settings.mail_max_age_days * 86_400_000);
            const found = await session.command(`UID SEARCH SINCE ${since}`);
            const uids = found
                .flatMap((reply) => (/^\* SEARCH ?(.*)$/i.exec(reply.line)?.[1] ?? '').split(' '))
                .filter((uid) => /^\d+$/.test(uid))
                .map(Number)
                .sort((first, second) => first - second);
            const source = `imap:${account.name}/${account.folder}`;
            const known = new Set(store.knownEventKeys(source, uids.map((uid) => `${validity}:${uid}`)));
            let posted = 0;
            for (const uid of uids) {
                const key = `${validity}:${uid}`;
                if (known.has(key)) {
                    continue;
                }
                if (posted >= MAIL_FILES_PER_POLL) {
                    break;
                }
                const replies = await session.command(`UID FETCH ${uid} (BODY.PEEK[]<0.${MAX_MAIL_BYTES}>)`);
                const raw = replies.flatMap((reply) => reply.literals)[0];
                if (!raw) {
                    continue;
                }
                try {
                    const mail = parseMail(raw.toString('utf8'));
                    posted += store.enqueueEvent({ source, type: 'email.received', dedupeKey: key, payload: { ...mail, file: key } }).duplicate ? 0 : 1;
                } catch (error) {
                    if (error instanceof Error && error.message.includes('queue is full')) {
                        break;
                    }
                }
            }
            await session.command('LOGOUT').catch(() => []);
            return posted;
        } finally {
            session.close();
        }
    }
}
