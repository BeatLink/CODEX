import { describe, expect, it } from 'vitest';

import {
    checkNote,
    conflictingRule,
    draftChecks,
    matchSenderRule,
    normalizeRulePattern,
    recipientProblem,
    replySubject,
    senderAddress,
    subjectProblem,
    ungroundedDraftValues,
    type MailThread,
    type SenderRule,
} from './mailChecks.js';

// ============================================================================
// Sender rules
// ============================================================================

describe('sender rules', () => {
    const rules: SenderRule[] = [
        { pattern: 'example.test', mail_class: 'ignore' },
        { pattern: 'alice@example.test', mail_class: 'reply' },
    ];

    it('reads the address out of a From header', () => {
        expect(senderAddress('Alice Example <Alice@Example.test>')).toBe('alice@example.test');
        expect(senderAddress('nobody')).toBe('');
    });

    it('prefers a rule for the exact address over one for its domain', () => {
        expect(matchSenderRule(rules, 'alice@example.test')?.mail_class).toBe('reply');
        expect(matchSenderRule(rules, 'bob@example.test')?.mail_class).toBe('ignore');
        expect(matchSenderRule(rules, 'bob@other.test')).toBeNull();
    });

    it('matches a domain only as a whole, not a subdomain', () => {
        expect(matchSenderRule(rules, 'carol@mail.example.test')).toBeNull();
    });

    it('names the rule a past decision disagrees with', () => {
        expect(conflictingRule(rules, 'bob@example.test', 'notify')?.pattern).toBe('example.test');
        expect(conflictingRule(rules, 'bob@example.test', 'ignore')).toBeNull();
        expect(conflictingRule(rules, 'bob@other.test', 'notify')).toBeNull();
    });

    it('accepts an address or a domain as a pattern and refuses anything else', () => {
        expect(normalizeRulePattern(' @Example.TEST ')).toBe('example.test');
        expect(normalizeRulePattern('Alice@Example.test')).toBe('alice@example.test');
        expect(() => normalizeRulePattern('alice')).toThrow('email address or a domain');
        expect(() => normalizeRulePattern('%@example.test OR 1')).toThrow('email address or a domain');
    });
});

// ============================================================================
// Drafts
// ============================================================================

const THREAD: MailThread = {
    from: 'Alice Example <alice@example.test>',
    to: 'owner@example.test, Bob <bob@example.test>',
    subject: 'Lunch on Friday?',
    date: 'Mon, 2 Nov 2026 09:00:00 +0000',
    body: 'Are you free for lunch on Friday at 12:30? Bob is coming too. It is £15 a head.',
};

describe('the recipient check', () => {
    it('passes the sender or another participant', () => {
        expect(recipientProblem('alice@example.test', THREAD)).toBeNull();
        expect(recipientProblem('Bob <bob@example.test>', THREAD)).toBeNull();
    });

    it('fails an address that is not in the thread, or no address', () => {
        expect(recipientProblem('mallory@example.test', THREAD)).toContain('mallory@example.test is not in the thread');
        expect(recipientProblem('Alice', THREAD)).toContain('no recipient address');
    });
});

describe('the subject check', () => {
    it('passes the same subject or a Re: of it', () => {
        expect(subjectProblem('Re: Lunch on Friday?', THREAD)).toBeNull();
        expect(subjectProblem('RE:  lunch on friday?', THREAD)).toBeNull();
        expect(replySubject('Re: Lunch')).toBe('Re: Lunch');
        expect(replySubject('Lunch')).toBe('Re: Lunch');
    });

    it('fails a different subject', () => {
        expect(subjectProblem('Re: Dinner on Saturday', THREAD)).toContain('does not match');
    });
});

describe('the grounding check', () => {
    it('passes a draft that only repeats what the thread says', () => {
        const draft = 'Hi Alice,\n\nFriday at 12:30 works for me, and £15 is fine. Happy to see Bob too.\n\nBest,\nSam';

        expect(ungroundedDraftValues(draft, THREAD)).toEqual([]);
    });

    it('lists a date, time, amount and name the thread never mentions', () => {
        const draft = 'Hi Alice, could we move it to Saturday 3 December at 1pm? I can bring $20, and Carol will join.';

        expect(ungroundedDraftValues(draft, THREAD)).toEqual(expect.arrayContaining(['3 December', 'Saturday', '1pm', '$20', 'Carol']));
    });
});

describe('all draft checks', () => {
    it('finds nothing in a good draft', () => {
        const checks = draftChecks('Friday at 12:30 works for me.', 'alice@example.test', 'Re: Lunch on Friday?', THREAD);

        expect(checks).toEqual([]);
        expect(checkNote(checks)).toBe('');
    });

    it('checks the To: and Subject: lines the model wrote in place of the ones given', () => {
        const draft = 'To: mallory@example.test\nSubject: Re: Invoice\n\nSee you Friday.';

        const checks = draftChecks(draft, 'alice@example.test', 'Re: Lunch on Friday?', THREAD);

        expect(checks.map((check) => check.name)).toEqual(['recipient', 'subject']);
        expect(checkNote(checks)).toMatch(/^Check: mallory@example\.test is not in the thread; subject/);
    });
});
