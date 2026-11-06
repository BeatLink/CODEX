import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KnowledgeStore } from './knowledge.js';
import { MAIL_FILES_PER_POLL, MAX_MAIL_BODY_CHARS, MailConnector, decodeHeader, htmlToText, parseMail } from './mail.js';
import { DEFAULT_SETTINGS, type Settings } from './settings.js';

// ============================================================================
// Parsing
// ============================================================================

const PLAIN = [
    'From: Alice Example <alice@example.test>',
    'To: me@example.test',
    'Subject: Lunch on Friday?',
    'Date: Mon, 2 Nov 2026 09:00:00 +0000',
    'Message-ID: <abc@example.test>',
    '',
    'Are you free for lunch on Friday?',
    '',
].join('\r\n');

describe('parseMail', () => {
    it('reads the headers and body of a plain message', () => {
        expect(parseMail(PLAIN)).toEqual({
            from: 'Alice Example <alice@example.test>',
            to: 'me@example.test',
            subject: 'Lunch on Friday?',
            date: 'Mon, 2 Nov 2026 09:00:00 +0000',
            message_id: '<abc@example.test>',
            bulk: '',
            body: 'Are you free for lunch on Friday?',
        });
    });

    it('unfolds long headers and decodes encoded words', () => {
        const raw = 'Subject: =?UTF-8?B?Q2Fmw6k=?=\r\n =?UTF-8?Q?_au_lait?=\r\nFrom: x@example.test\r\n\r\nHi';

        expect(parseMail(raw).subject).toBe('Café au lait');
        expect(decodeHeader('=?ISO-8859-1?Q?Ren=E9?=')).toBe('René');
    });

    it('prefers the plain part of a multipart message and decodes quoted-printable', () => {
        const raw = [
            'From: a@example.test',
            'Content-Type: multipart/alternative; boundary="sep"',
            '',
            '--sep',
            'Content-Type: text/html; charset=utf-8',
            '',
            '<p>HTML version</p>',
            '--sep',
            'Content-Type: text/plain; charset=utf-8',
            'Content-Transfer-Encoding: quoted-printable',
            '',
            'Caf=C3=A9 plan=',
            ' continues',
            '--sep--',
            '',
        ].join('\n');

        expect(parseMail(raw).body).toBe('Café plan continues');
    });

    it('falls back to HTML text, decodes base64, and skips attachments', () => {
        const raw = [
            'Content-Type: multipart/mixed; boundary=b1',
            '',
            '--b1',
            'Content-Type: application/pdf',
            'Content-Disposition: attachment; filename=a.pdf',
            '',
            'JVBERi0=',
            '--b1',
            'Content-Type: text/html',
            'Content-Transfer-Encoding: base64',
            '',
            Buffer.from('<style>p{}</style><p>Tom &amp; Jerry</p>').toString('base64'),
            '--b1--',
        ].join('\n');

        expect(parseMail(raw).body).toBe('Tom & Jerry');
        expect(htmlToText('a<br>b')).toBe('a\nb');
    });

    it('cuts a long body', () => {
        expect(parseMail(`Subject: x\n\n${'word '.repeat(5000)}`).body).toHaveLength(MAX_MAIL_BODY_CHARS);
    });

    it.each([
        ['List-Unsubscribe: <mailto:u@example.test>', 'mailing list'],
        ['Precedence: bulk', 'bulk precedence'],
        ['Auto-Submitted: auto-generated', 'automatic message'],
    ])('marks %s as bulk', (header, reason) => {
        expect(parseMail(`From: a@example.test\n${header}\n\nHi`).bulk).toBe(reason);
    });

    it('marks no-reply senders as bulk and ordinary and Auto-Submitted: no mail as personal', () => {
        expect(parseMail('From: Shop <no-reply@shop.test>\n\nHi').bulk).toBe('automated sender');
        expect(parseMail('From: a@example.test\nAuto-Submitted: no\n\nHi').bulk).toBe('');
    });
});

// ============================================================================
// The Maildir connector
// ============================================================================

describe('MailConnector', () => {
    let directory: string;
    let settings: Settings;
    let store: KnowledgeStore;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), 'codex-mail-'));
        mkdirSync(join(directory, 'Inbox', 'new'), { recursive: true });
        settings = {
            ...DEFAULT_SETTINGS,
            knowledge_db_path: join(directory, 'knowledge.db'),
            mail_maildir_paths: [join(directory, 'Inbox')],
        };
        store = new KnowledgeStore(settings.knowledge_db_path);
    });

    afterEach(() => {
        rmSync(directory, { recursive: true, force: true });
    });

    function deliver(name: string, raw = PLAIN): string {
        const path = join(directory, 'Inbox', 'new', name);
        writeFileSync(path, raw);
        return path;
    }

    it('queues each new message once as an external email event', async () => {
        deliver('1700000000.a.host:2,');
        const connector = new MailConnector();

        expect(await connector.poll(settings)).toBe(true);
        expect(await connector.poll(settings)).toBe(false);

        expect(store.claimEvent()).toMatchObject({
            type: 'email.received',
            trust: 'external',
            dedupe_key: '1700000000.a.host',
            payload: { subject: 'Lunch on Friday?', file: '1700000000.a.host:2,' },
        });
        expect(store.claimEvent()).toBeNull();
    });

    it('does not queue a message again after a new connector starts or a client renames it', async () => {
        const path = deliver('1700000000.a.host');
        await new MailConnector().poll(settings);
        rmSync(path);
        deliver('1700000000.a.host:2,S');

        expect(await new MailConnector().poll(settings)).toBe(false);
        expect(store.events()).toHaveLength(1);
    });

    it('leaves out messages older than the age limit and does nothing without folders', async () => {
        const old = deliver('old.host');
        const longAgo = new Date(Date.now() - 30 * 86_400_000);
        utimesSync(old, longAgo, longAgo);
        const connector = new MailConnector();

        expect(await connector.poll(settings)).toBe(false);
        expect(await connector.poll({ ...settings, mail_maildir_paths: [] })).toBe(false);
        expect(store.events()).toEqual([]);
    });

    it('queues a limited number per poll and the rest on the next', async () => {
        for (let index = 0; index < MAIL_FILES_PER_POLL + 3; index += 1) {
            deliver(`17000000${String(index).padStart(2, '0')}.host`);
        }
        const connector = new MailConnector();

        await connector.poll(settings);
        expect(store.events(100)).toHaveLength(MAIL_FILES_PER_POLL);
        await connector.poll(settings);
        expect(store.events(100)).toHaveLength(MAIL_FILES_PER_POLL + 3);
    });

    it('ignores a folder that does not exist', async () => {
        expect(await new MailConnector().poll({ ...settings, mail_maildir_paths: [join(directory, 'Missing')] })).toBe(false);
    });
});
