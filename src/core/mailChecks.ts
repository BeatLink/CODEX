// Checks on mail work that do not rely on the model: who a draft goes to, its subject, what it states, and the sender rules.
import { unsupportedValues } from './checks.js';

// ============================================================================
// Classes and sender rules
// ============================================================================

// What triage decided for a message: drop it, show it, or show it and draft a reply.
export const MAIL_CLASSES = ['ignore', 'notify', 'reply'] as const;
export type MailClass = (typeof MAIL_CLASSES)[number];

export type SenderRule = { pattern: string; mail_class: MailClass };

const ADDRESS = /[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/g;

// List the lower-case email addresses written in a header or text, in order and without repeats.
export function addressesIn(text: string): string[] {
    return [...new Set((text.match(ADDRESS) ?? []).map((address) => address.toLowerCase()))];
}

// The first address in a From header, lower-cased, or an empty string.
export function senderAddress(from: string): string {
    return addressesIn(from)[0] ?? '';
}

// A rule pattern is a whole address or a bare domain; a leading @ or stray case is dropped.
export function normalizeRulePattern(pattern: string): string {
    const trimmed = pattern.trim().toLowerCase().replace(/^@/, '');
    const looksValid = trimmed.includes('@') ? addressesIn(trimmed)[0] === trimmed : /^[\w-]+(?:\.[\w-]+)+$/.test(trimmed);
    if (!looksValid) {
        throw new Error('A sender rule pattern is an email address or a domain such as example.org.');
    }
    return trimmed;
}

// The patterns that could match an address, the exact address first and then its domain.
export function senderPatterns(address: string): string[] {
    const at = address.lastIndexOf('@');
    return at < 0 ? [] : [address, address.slice(at + 1)];
}

// Pick the rule that decides for an address: a rule for the exact address beats one for its domain.
export function matchSenderRule<Rule extends SenderRule>(rules: Rule[], address: string): Rule | null {
    for (const pattern of senderPatterns(address)) {
        const rule = rules.find((candidate) => candidate.pattern === pattern);
        if (rule) {
            return rule;
        }
    }
    return null;
}

// The rule a past triage decision disagrees with, if today's rules would have classed that sender otherwise.
export function conflictingRule<Rule extends SenderRule>(rules: Rule[], address: string, mailClass: string): Rule | null {
    const rule = matchSenderRule(rules, address);
    return rule && rule.mail_class !== mailClass ? rule : null;
}

// ============================================================================
// Drafts
// ============================================================================

export type MailThread = { from: string; to: string; subject: string; date: string; body: string };

export type DraftCheck = { name: 'recipient' | 'subject' | 'ungrounded'; detail: string };

// Strip every leading Re:, Fwd: or Fw: and fold case and spaces, so subjects compare by what they say.
function plainSubject(subject: string): string {
    return subject
        .replace(/^(?:\s*(?:re|fwd?|aw)\s*:\s*)+/i, '')
        .split(/\s+/)
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
}

// The subject a reply to the thread carries.
export function replySubject(subject: string): string {
    return /^\s*re\s*:/i.test(subject) ? subject.trim() : `Re: ${subject.trim()}`;
}

// A draft's own To: or Subject: line, when the model wrote one at its top.
function headerLine(draft: string, name: string): string | null {
    const match = new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, 'im').exec(draft.split(/\n\s*\n/)[0] ?? '');
    return match ? match[1].trim() : null;
}

export function recipientProblem(recipient: string, thread: MailThread): string | null {
    const recipients = addressesIn(recipient);
    if (recipients.length === 0) {
        return `no recipient address in "${recipient}"`;
    }
    const participants = addressesIn(`${thread.from} ${thread.to}`);
    const unknown = recipients.filter((address) => !participants.includes(address));
    return unknown.length > 0 ? `${unknown.join(', ')} is not in the thread` : null;
}

export function subjectProblem(subject: string, thread: MailThread): string | null {
    return plainSubject(subject) === plainSubject(thread.subject) ? null : `subject "${subject}" does not match "${thread.subject}"`;
}

const TIME = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b/gi;
const AMOUNT = /[£$€]\s*\d+(?:[.,]\d+)*|\b\d+(?:[.,]\d+)*\s*(?:usd|eur|gbp|dollars?|euros?|pounds?)\b/gi;
const WEEKDAY = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;
const MONTH_DAY =
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gi;
const CAPITALISED_WORD = /\b[A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)*\b/g;
// Capitalised words a reply uses without naming anyone, so they never count as a name.
const COMMON_CAPITALISED = new Set(
    `
    i hi hello dear thanks thank best regards kind cheers sincerely yours warm many sorry yes no ok okay
    please let looking great sounds sure happy glad all the a an and or but if so see talk speak
    january february march april may june july august september october november december
    monday tuesday wednesday thursday friday saturday sunday today tomorrow tonight
    `.split(/\s+/).filter(Boolean),
);

function squeeze(text: string): string {
    return text.toLowerCase().replace(/\s+/g, '');
}

// Values of one kind in the draft whose written form appears nowhere in the thread.
function missingMatches(pattern: RegExp, draft: string, threadText: string): string[] {
    const known = squeeze(threadText);
    return [...new Set([...draft.matchAll(pattern)].map((match) => match[0].trim()))].filter((value) => !known.includes(squeeze(value)));
}

// Capitalised words inside a sentence, which are mostly names, that the thread never mentions.
function unknownNames(draft: string, threadText: string): string[] {
    const known = new Set((threadText.match(/[\p{L}'-]+/gu) ?? []).map((word) => word.toLowerCase()));
    const names: string[] = [];
    for (const match of draft.matchAll(CAPITALISED_WORD)) {
        const before = draft.slice(0, match.index).trimEnd();
        const startsSentence = before === '' || /[.!?:;\n]$/.test(before) || /\n\s*$/.test(draft.slice(0, match.index));
        const word = match[0];
        if (!startsSentence && !COMMON_CAPITALISED.has(word.toLowerCase()) && !known.has(word.toLowerCase())) {
            names.push(word);
        }
    }
    return [...new Set(names)];
}

// List dates, times, amounts and names the draft states that the thread never mentions.
export function ungroundedDraftValues(draft: string, thread: MailThread): string[] {
    const threadText = `${thread.from}\n${thread.to}\n${thread.subject}\n${thread.date}\n${thread.body}`;
    return [
        ...unsupportedValues(draft, threadText),
        ...missingMatches(MONTH_DAY, draft, threadText),
        ...missingMatches(WEEKDAY, draft, threadText),
        ...missingMatches(TIME, draft, threadText),
        ...missingMatches(AMOUNT, draft, threadText),
        ...unknownNames(draft, threadText),
    ].filter((value, index, all) => all.indexOf(value) === index);
}

// Run every draft check; a To: or Subject: line the model wrote is checked in place of the ones the harness sets.
export function draftChecks(draft: string, recipient: string, subject: string, thread: MailThread): DraftCheck[] {
    const checks: DraftCheck[] = [];
    const recipientIssue = recipientProblem(headerLine(draft, 'to') ?? recipient, thread);
    if (recipientIssue) {
        checks.push({ name: 'recipient', detail: recipientIssue });
    }
    const subjectIssue = subjectProblem(headerLine(draft, 'subject') ?? subject, thread);
    if (subjectIssue) {
        checks.push({ name: 'subject', detail: subjectIssue });
    }
    const body = draft.replace(/^\s*(?:to|subject)\s*:.*$/gim, '');
    const ungrounded = ungroundedDraftValues(body, thread);
    if (ungrounded.length > 0) {
        checks.push({ name: 'ungrounded', detail: `not in the email: ${ungrounded.join(', ')}` });
    }
    return checks;
}

// The note shown under a draft that failed a check, or an empty string.
export function checkNote(checks: DraftCheck[]): string {
    return checks.length === 0 ? '' : `Check: ${checks.map((check) => check.detail).join('; ')}.`;
}
