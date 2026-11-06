import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IMAP_POLL_SECONDS, ImapConnector } from './imap.js';
import { KnowledgeStore } from './knowledge.js';
import { DEFAULT_SETTINGS, type ImapAccount, type Settings } from './settings.js';

// ============================================================================
// A fake server
// ============================================================================

const MESSAGES: Record<number, string> = {
    7: 'From: Alice <alice@example.test>\r\nSubject: Lunch?\r\nDate: Tue, 3 Nov 2026 10:00:00 +0000\r\nMessage-ID: <7@example.test>\r\n\r\nFree on Friday?\r\n',
    9: 'From: Bob <bob@example.test>\r\nSubject: Report\r\nMessage-ID: <9@example.test>\r\n\r\nSee attached.\r\n',
};

type Server_ = { server: Server; port: number; commands: string[] };

// Answers LOGIN, EXAMINE, UID SEARCH, UID FETCH and LOGOUT; the password it wants is "right".
async function startServer(): Promise<Server_> {
    const commands: string[] = [];
    const server = createServer((socket: Socket) => {
        socket.write('* OK ready\r\n');
        let pending = '';
        socket.on('data', (chunk) => {
            pending += chunk.toString('utf8');
            let end: number;
            while ((end = pending.indexOf('\r\n')) >= 0) {
                const line = pending.slice(0, end);
                pending = pending.slice(end + 2);
                commands.push(line);
                const [tag, ...rest] = line.split(' ');
                const command = rest.join(' ');
                if (command.startsWith('LOGIN')) {
                    socket.write(command.includes('"right"') ? `${tag} OK logged in\r\n` : `${tag} NO [AUTHENTICATIONFAILED] bad password right\r\n`);
                } else if (command.startsWith('EXAMINE')) {
                    socket.write(`* 2 EXISTS\r\n* OK [UIDVALIDITY 42] ok\r\n${tag} OK [READ-ONLY] done\r\n`);
                } else if (command.startsWith('UID SEARCH')) {
                    socket.write(`* SEARCH 7 9\r\n${tag} OK done\r\n`);
                } else if (command.startsWith('UID FETCH')) {
                    const uid = Number(/UID FETCH (\d+)/.exec(command)![1]);
                    const body = MESSAGES[uid];
                    socket.write(`* 1 FETCH (UID ${uid} BODY[]<0> {${Buffer.byteLength(body)}}\r\n${body})\r\n${tag} OK done\r\n`);
                } else if (command.startsWith('LOGOUT')) {
                    socket.write(`* BYE\r\n${tag} OK bye\r\n`);
                    socket.end();
                }
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, port: (server.address() as { port: number }).port, commands };
}

// ============================================================================
// Helpers
// ============================================================================

let directory: string;
let settings: Settings;
let store: KnowledgeStore;
let fake: Server_;
let now: number;

function account(overrides: Partial<ImapAccount> = {}): ImapAccount {
    return { name: 'home', host: '127.0.0.1', port: fake.port, username: 'me', password_command: ['pass', 'show', 'mail'], folder: 'INBOX', ...overrides };
}

function connector(password = 'right'): ImapConnector {
    return new ImapConnector(
        async (target) => connect(target.port, target.host),
        async () => password,
        () => now,
    );
}

beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'codex-imap-'));
    fake = await startServer();
    now = Date.parse('2026-11-05T12:00:00Z');
    settings = { ...DEFAULT_SETTINGS, knowledge_db_path: join(directory, 'knowledge.db'), mail_imap_accounts: [account()] };
    store = new KnowledgeStore(settings.knowledge_db_path);
});

afterEach(async () => {
    await new Promise((resolve) => fake.server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
});

// ============================================================================
// Polling
// ============================================================================

describe('IMAP polling', () => {
    it('posts each new message once, read-only, with a key from the mailbox and uid', async () => {
        const imap = connector();

        expect(await imap.poll(settings)).toBe(true);

        const events = store.events().reverse();
        expect(events.map((event) => [event.source, event.type, event.dedupe_key, event.trust])).toEqual([
            ['imap:home/INBOX', 'email.received', '42:7', 'external'],
            ['imap:home/INBOX', 'email.received', '42:9', 'external'],
        ]);
        expect(fake.commands.some((line) => /EXAMINE/.test(line))).toBe(true);
        expect(fake.commands.some((line) => /SELECT|STORE|EXPUNGE/.test(line))).toBe(false);
        expect(fake.commands.filter((line) => /FETCH/.test(line)).every((line) => line.includes('BODY.PEEK'))).toBe(true);
    });

    it('reads the message text into the event payload', async () => {
        await connector().poll(settings);

        const first = store.claimEvent()!;
        expect(first.payload).toMatchObject({ from: expect.stringContaining('alice@example.test'), subject: 'Lunch?', message_id: '<7@example.test>' });
        expect(String(first.payload.body)).toContain('Free on Friday?');
    });

    it('does not post a message it already posted, and waits between polls', async () => {
        const imap = connector();
        await imap.poll(settings);
        const commandsAfterFirst = fake.commands.length;

        expect(await imap.poll(settings)).toBe(false);
        expect(fake.commands).toHaveLength(commandsAfterFirst);

        now += (IMAP_POLL_SECONDS + 1) * 1000;
        expect(await imap.poll(settings)).toBe(false);
        expect(fake.commands.length).toBeGreaterThan(commandsAfterFirst);
        expect(store.events()).toHaveLength(2);
    });

    it('reports a refused login without the password or the server line, and waits before trying again', async () => {
        const messages: string[] = [];
        const imap = connector('wrong');

        expect(await imap.poll(settings, { onProgress: (message) => messages.push(message) })).toBe(false);

        expect(messages).toEqual(['Mail account home: The server refused the login.']);
        expect(messages.join()).not.toContain('wrong');
        expect(store.events()).toEqual([]);
        await imap.poll(settings, { onProgress: (message) => messages.push(message) });
        expect(messages).toHaveLength(1);
    });

    it('does nothing without accounts', async () => {
        expect(await connector().poll({ ...settings, mail_imap_accounts: [] })).toBe(false);
        expect(fake.commands).toEqual([]);
    });
});
