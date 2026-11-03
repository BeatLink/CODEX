const URL_RE = /https?:\/\/[^\s<>()\[\]"'`]+/g;
const FAILURE_WORD = /\b(fail\w*|error\w*|unable|blocked|timed out|could not|couldn't|did not|didn't|was not|wasn't)\b/gi;
const CLAIMED_CHANGE = /(\b(?:i|i've|i have|has been|have been|was|were)\s+(?:now\s+)?|(?:^|[.!?]\s+)\s*(?:[-*]\s+)?)\b(?:wrote|written|updated|changed|created|modified|edited|renamed|fixed|added)\b/gi;
const CLAIMED_PASSING_TESTS = /\btests?\b(?:[^.!?\n]|\.(?=\w)){0,80}\b(?:pass|passes|passed|passing|succeed\w*)\b/gi;
const NEGATION = /\b(?:no|not|nothing|none|never|without)\b|n't\b/gi;
const VERSION_RE = /(?<![\w.])v?(\d+(?:\.\d+)+)(?![\w.]*\d)/g;
const MONTHS: Record<string, number> = {
    january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5,
    june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9,
    october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
const MONTH_NAMES = Object.keys(MONTHS).join('|');
const DATE_TEXT_RE = new RegExp(`(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}\\s+(?:${MONTH_NAMES}),?\\s+\\d{4}|(?:${MONTH_NAMES})\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4})`, 'gi');

function parseDate(text: string): Date | null {
    const cleaned = text.trim();
    if (!cleaned) return null;

    const iso = cleaned.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));

    const dayMonthYear = cleaned.match(new RegExp(`^(\\d{1,2})\\s+(?:${MONTH_NAMES}),?\\s+(\\d{4})$`, 'i'));
    if (dayMonthYear) {
        const monthName = cleaned.match(new RegExp(`${MONTH_NAMES}`, 'i'))?.[0] ?? '';
        return new Date(Date.UTC(Number(dayMonthYear[2]), MONTHS[monthName.toLowerCase()] - 1, Number(dayMonthYear[1])));
    }

    const monthDayYear = cleaned.match(new RegExp(`^(?:${MONTH_NAMES})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})$`, 'i'));
    if (monthDayYear) {
        const monthName = cleaned.match(new RegExp(`${MONTH_NAMES}`, 'i'))?.[0] ?? '';
        return new Date(Date.UTC(Number(monthDayYear[2]), MONTHS[monthName.toLowerCase()] - 1, Number(monthDayYear[1])));
    }

    return null;
}

function formatNumber(value: number): string {
    const withCommas = new Intl.NumberFormat('en-US', { maximumFractionDigits: 10 }).format(value);
    return withCommas;
}

function normalizeMathText(value: string): string {
    return value
        .replace(/×/g, '*')
        .replace(/÷/g, '/')
        .replace(/−/g, '-')
        .replace(/–/g, '-')
        .replace(/,/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseNumericValue(value: string): number | null {
    const cleaned = value.replace(/[^0-9.\-]/g, '').trim();
    if (!cleaned || cleaned === '-' || cleaned === '.') return null;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
}

function computeExpression(expression: string): number | null {
    const expr = expression
        .replace(/×/g, '*')
        .replace(/÷/g, '/')
        .replace(/−/g, '-')
        .replace(/–/g, '-')
        .replace(/,/g, '')
        .replace(/[£$€]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!/[+\-*/^]/.test(expr)) return null;
    try {
        const result = Function(`"use strict"; return (${expr.replace(/\^/g, '**')});`)();
        return Number.isFinite(result) ? Number(result) : null;
    } catch {
        return null;
    }
}

function claimMatch(pattern: RegExp, report: string): boolean {
    for (const match of report.matchAll(pattern)) {
        const idx = match.index ?? 0;
        const from = Math.max(report.lastIndexOf('. ', idx), report.lastIndexOf('!', idx), report.lastIndexOf('?', idx), report.lastIndexOf('\n', idx)) + 1;
        const endMarker = ['. ', '!', '?', '\n'].find((marker) => report.indexOf(marker, idx + (match[0]?.length ?? 0)) !== -1);
        const end = endMarker ? report.indexOf(endMarker, idx + (match[0]?.length ?? 0)) : report.length;
        const sentence = report.slice(from, end);
        const negation = new RegExp(NEGATION.source, 'gi');
        if (!negation.test(sentence)) return true;
    }
    return false;
}

export function uncited_urls(answer: string, evidence: string): string[] {
    const urls = [...new Set((answer.match(URL_RE) ?? []).map((url) => url.replace(/[.,;:!?]+$/, '')))]
        .filter(Boolean);
    return urls.filter((url) => !evidence.includes(url));
}

export function unsupported_values(answer: string, evidence: string): string[] {
    const prose = answer.replace(URL_RE, ' ').replace(/```[\s\S]*?```/g, ' ');
    const knownVersions = new Set((evidence.match(VERSION_RE) ?? []).map((value) => value.replace(/^v/, '')));
    const knownDates = new Set<string>();

    for (const match of evidence.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) {
        const date = parseDate(match[0]);
        if (date) knownDates.add(date.toISOString().slice(0, 10));
    }
    for (const match of evidence.matchAll(DATE_TEXT_RE)) {
        const date = parseDate(match[0]);
        if (date) knownDates.add(date.toISOString().slice(0, 10));
    }

    const values: string[] = [];
    for (const match of prose.matchAll(VERSION_RE)) {
        const version = match[1];
        if (!knownVersions.has(version)) values.push(version);
    }
    for (const match of prose.matchAll(DATE_TEXT_RE)) {
        const value = match[0];
        const date = parseDate(value);
        if (date && !knownDates.has(date.toISOString().slice(0, 10))) values.push(value);
    }
    return [...new Set(values)];
}

export function unbacked_claims(report: string, action_log: Array<[string, Record<string, unknown>, string]>): string[] {
    const problems: string[] = [];
    const wroteAFile = action_log.some(([name, _args, result]) => name === 'write_file' && !String(result).startsWith('Tool error'));
    if (!wroteAFile && claimMatch(CLAIMED_CHANGE, report)) {
        problems.push('No file was written, so the report must not say that anything was changed.');
    }
    const testsPassed = action_log.some(([name, _args, result]) => name === 'run_tests' && String(result).startsWith('Tests passed'));
    if (!testsPassed && claimMatch(CLAIMED_PASSING_TESTS, report)) {
        problems.push('No test run passed, so the report must not say that the tests pass.');
    }
    return problems;
}

export function action_report_problems(report: string, action_log: Array<[string, Record<string, unknown>, string]>): string[] {
    const folded = report.toLowerCase();
    const mentionsFailure = FAILURE_WORD.test(report);
    const problems: string[] = [];

    for (const [name, argumentsObj, result] of action_log) {
        const failed = /^Tool error|^Tests failed|Tests timed out/.test(String(result));
        if (name === 'write_file') {
            const path = String((argumentsObj as Record<string, unknown>).path ?? '');
            if (!path) continue;
            const mentionsPath = folded.includes(path.toLowerCase()) || folded.includes(path.split('/').pop()?.toLowerCase() ?? '');
            if (!mentionsPath) {
                const outcome = failed ? 'failed' : 'was made';
                problems.push(`The change to ${path} ${outcome}, but the report does not mention it.`);
            } else if (failed && !mentionsFailure) {
                problems.push(`Writing ${path} failed (${String(result).slice(0, 200)}); say plainly that this change was not made.`);
            }
        } else if (name === 'run_tests') {
            if (failed && !mentionsFailure) {
                problems.push(`The test run did not pass (${String(result).split('\n')[0]}); the report must say so.`);
            } else if (!folded.includes('test')) {
                problems.push(`The tests were run (${String(result).split('\n')[0]}); the report must give the result.`);
            }
        }
    }

    return problems.concat(unbacked_claims(report, action_log));
}

const _EQUALS_SIGNS = '=≈';
const _EQUATION_CHARACTERS = new Set('0123456789.,()+-*/^ £$€'.split(''));
const _OPERATOR_BETWEEN_NUMBERS = /[\d)]\s*[-+*/^]\s*[\d(]/;
const _CLAIMED_NUMBER = /\s*[£$€]?\s*(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\d,])|-?\d+(?:\.\d+)?)/;
const _LOOKS_LIKE_A_DATE = /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}\/\d{2,4}/;
const _WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const _WEEKDAY_BEFORE = new RegExp(`\\b(${_WEEKDAYS.join('|')})\\s*,?\\s*(?:the\\s+)?$`, 'i');
const _WEEKDAY_AFTER = new RegExp(`^\\s*,?\\s*(?:is|was|will be|would be|falls on|fell on|lands on)\\s+(?:a\\s+|on\\s+a\\s+)?(${_WEEKDAYS.join('|')})\\b`, 'i');
const _DATE_FORMATS: Array<[RegExp, string[]]> = [
    [new RegExp(`\\b(\\d{4})-(\\d{1,2})-(\\d{1,2})\\b`, 'g'), ['year', 'month', 'day']],
    [new RegExp(`\\b(${MONTH_NAMES})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'), ['month', 'day', 'year']],
    [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES}),?\\s+(\\d{4})\\b`, 'gi'), ['day', 'month', 'year']],
];

function normalizeArithmetic(text: string): string {
    return text
        .replace(/−/g, '-')
        .replace(/–/g, '-')
        .replace(/×/g, '*')
        .replace(/·/g, '*')
        .replace(/÷/g, '/')
        .replace(/(\d)\s*[xX]\s*(?=\d)/g, '$1 * ')
        .replace(/\s+/g, ' ')
        .trim();
}

function evaluateExpression(expr: string): number | null {
    const normalized = expr
        .replace(/−/g, '-')
        .replace(/–/g, '-')
        .replace(/×/g, '*')
        .replace(/·/g, '*')
        .replace(/÷/g, '/')
        .replace(/,/g, '')
        .replace(/[£$€]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!/[+\-*/^]/.test(normalized)) return null;
    try {
        const result = Function(`"use strict"; return (${normalized.replace(/\^/g, '**')});`)();
        return Number.isFinite(result) ? Number(result) : null;
    } catch {
        return null;
    }
}

function sumBefore(text: string): [string, number] | null {
    let start = text.length;
    while (start > 0 && _EQUATION_CHARACTERS.has(text[start - 1])) {
        start -= 1;
    }
    const words = text.slice(start).split(/\s+/).filter(Boolean);

    for (let first = 0; first < words.length; first++) {
        let written = words.slice(first).join(' ').trim();
        while (written.startsWith('(') && (written.match(/\(/g)?.length ?? 0) > (written.match(/\)/g)?.length ?? 0)) {
            written = written.slice(1).trim();
        }
        if (!_OPERATOR_BETWEEN_NUMBERS.test(written) || _LOOKS_LIKE_A_DATE.test(written)) {
            continue;
        }

        let plain = written.replace(/(?<=\d),(?=\d{3}(?!\d))/g, '').replace(/[£$€]/g, '');
        if (plain.includes(',')) continue;
        const value = evaluateExpression(plain);
        if (value !== null) {
            return [written, value];
        }
    }
    return null;
}

function claimedNumber(text: string): [string, number] | null {
    const match = text.match(_CLAIMED_NUMBER);
    if (!match) return null;
    const written = match[1];
    const following = text.slice(match[0].length, match[0].length + 1);
    if (following && (following === ':' || following === '/' || following === '%' || (following === '.' && /\d/.test(text[match[0].length + 1] ?? '')))) {
        return null;
    }
    return [written, Number(written.replace(/,/g, ''))];
}

function formatExact(value: number, decimals: number): string {
    if (Number.isInteger(value)) {
        return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
    }
    return new Intl.NumberFormat('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: Math.max(decimals, 2),
    }).format(value).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function weekdayProblems(text: string): string[] {
    const problems: string[] = [];
    for (const [pattern, fields] of _DATE_FORMATS) {
        for (const match of text.matchAll(pattern)) {
            const parts = Object.fromEntries(fields.map((field, index) => [field, match[index + 1]]));
            const month = parts.month;
            let monthNumber: number | null = null;
            if (month && /^\d+$/.test(month)) {
                monthNumber = Number(month);
            } else if (month) {
                monthNumber = MONTHS[month.toLowerCase()];
            }
            if (monthNumber === null || !parts.year || !parts.day) continue;

            const day = new Date(Date.UTC(Number(parts.year), monthNumber - 1, Number(parts.day)));
            const actual = _WEEKDAYS[(day.getUTCDay() + 6) % 7];
            const before = text.slice(Math.max(0, match.index! - 20), match.index!);
            const after = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 30);
            const named = _WEEKDAY_BEFORE.exec(before) || _WEEKDAY_AFTER.exec(after);
            if (named && named[1].toLowerCase() !== actual) {
                const displayExpected = named[1].charAt(0).toUpperCase() + named[1].slice(1).toLowerCase();
                const displayActual = actual.charAt(0).toUpperCase() + actual.slice(1);
                problems.push(`The result calls ${match[0]} a ${displayExpected}, but it is a ${displayActual}.`);
            }
        }
    }
    return problems;
}

export function calculation_problems(text: string): string[] {
    const problems: string[] = [];
    const prose = normalizeArithmetic(text.replace(/```[\s\S]*?(?:```|$)/g, ' '));

    for (let index = 0; index < prose.length; index++) {
        const sign = prose[index];
        if (!_EQUALS_SIGNS.includes(sign)) continue;

        const workedOut = sumBefore(prose.slice(0, index));
        const claimed = claimedNumber(prose.slice(index + 1));
        if (workedOut === null || claimed === null) continue;

        const [writtenSum, value] = workedOut;
        const [writtenResult, stated] = claimed;
        const decimals = (writtenResult.split('.')[1] ?? '').length;
        const allowed = Math.pow(10, -decimals) * (sign === '≈' ? 1 : 0.5) + 1e-9;
        const quotient = writtenSum.includes('/') && decimals === 0 && stated === Math.trunc(value);

        if (Math.abs(value - stated) > allowed && !quotient) {
            const exact = formatExact(value, Math.max(decimals, 2));
            problems.push(`The working states ${writtenSum} ${sign} ${writtenResult}, but it equals ${exact}.`);
        }
    }

    return problems.concat(weekdayProblems(prose));
}
