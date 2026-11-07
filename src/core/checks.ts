// Checks on a written result that do not rely on the model.

// ============================================================================
// Patterns
// ============================================================================

export const CODE_BLOCK = /```[\s\S]*?(?:```|$)/g;
const URL_PATTERN = /https?:\/\/[^\s<>()[\]"'`]+/g;
const FAILURE_WORD = /\b(fail\w*|error\w*|unable|blocked|timed out|could not|couldn't|did not|didn't|was not|wasn't)\b/i;
// Phrases such as "was updated", "I changed", or a sentence opening "Fixed", which a report must not use when no file was written.
const CLAIMED_CHANGE =
    /(?:\b(?:i|i've|i have|has been|have been|was|were)\s+(?:now\s+)?|(?:^|[.!?]\s+)\s*(?:[-*]\s+)?)(?:wrote|written|updated|changed|created|modified|edited|renamed|fixed|added)\b/gim;
// Phrases such as "all tests now pass", which a report must not use unless a test run passed.
const CLAIMED_PASSING_TESTS = /\btests?\b(?:[^.!?\n]|\.(?=\w)){0,80}\b(?:pass|passes|passed|passing|succeed\w*)\b/gi;
const NEGATION = /\b(?:no|not|nothing|none|never|without)\b|n't\b/i;
const SENTENCE_MARKS = ['. ', '!', '?', '\n'];

export type ActionRecord = [name: string, arguments: Record<string, unknown>, result: string];

// Find where sub last starts so that it ends at or before end, or -1.
function lastIndexBefore(text: string, sub: string, end: number): number {
    const from = end - sub.length;
    return from < 0 ? -1 : text.lastIndexOf(sub, from);
}

// Say whether the report makes the claim in a sentence that does not negate it, as "nothing was edited" does.
function claims(pattern: RegExp, report: string): boolean {
    for (const match of report.matchAll(pattern)) {
        const start = match.index;
        const end = start + match[0].length;
        const sentenceStart = Math.max(...SENTENCE_MARKS.map((mark) => lastIndexBefore(report, mark, start))) + 1;
        const ends = SENTENCE_MARKS.map((mark) => report.indexOf(mark, end)).filter((index) => index !== -1);
        const sentenceEnd = ends.length > 0 ? Math.min(...ends) : report.length;
        if (!NEGATION.test(report.slice(sentenceStart, sentenceEnd))) {
            return true;
        }
    }
    return false;
}

// ============================================================================
// Evidence
// ============================================================================

// List URLs the answer cites that appear nowhere in the captured evidence.
export function uncitedUrls(answer: string, evidence: string): string[] {
    const urls = new Set((answer.match(URL_PATTERN) ?? []).map((url) => url.replace(/[.,;:!?]+$/, '')));
    return [...urls].filter((url) => !evidence.includes(url));
}

const VERSION = /(?<![\w.])v?(\d+(?:\.\d+)+)(?![\w.]*\d)/g;
const MONTH_NAMES: string[][] = [
    ['january', 'jan'],
    ['february', 'feb'],
    ['march', 'mar'],
    ['april', 'apr'],
    ['may'],
    ['june', 'jun'],
    ['july', 'jul'],
    ['august', 'aug'],
    ['september', 'sep', 'sept'],
    ['october', 'oct'],
    ['november', 'nov'],
    ['december', 'dec'],
];
const MONTHS = new Map<string, number>(MONTH_NAMES.flatMap((names, index) => names.map((name) => [name, index + 1] as [string, number])));
const MONTH = `(${[...MONTHS.keys()].sort((first, second) => second.length - first.length).join('|')})\\.?`;
type DateField = 'year' | 'month' | 'day';
const DATE_FORMATS: Array<[RegExp, DateField[]]> = [
    // 2026-10-09
    [/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, ['year', 'month', 'day']],
    // October 9, 2026
    [new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'), ['month', 'day', 'year']],
    // 9 October 2026
    [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH},?\\s+(\\d{4})\\b`, 'gi'), ['day', 'month', 'year']],
];

type FoundDate = { written: string; index: number; year: number; month: number; day: number };

// Find the calendar dates written in text, in any of the usual forms.
function findDates(text: string): FoundDate[] {
    const found: FoundDate[] = [];
    for (const [pattern, fields] of DATE_FORMATS) {
        for (const match of text.matchAll(pattern)) {
            const parts = Object.fromEntries(fields.map((field, index) => [field, match[index + 1]])) as Record<DateField, string>;
            const month = /^\d+$/.test(parts.month) ? Number(parts.month) : MONTHS.get(parts.month.toLowerCase())!;
            found.push({ written: match[0], index: match.index, year: Number(parts.year), month, day: Number(parts.day) });
        }
    }
    return found;
}

function dateKey(date: FoundDate): string {
    return `${date.year}-${date.month}-${date.day}`;
}

// List version numbers and dates the answer states that appear nowhere in the evidence, since a small model fills gaps with plausible numbers.
export function unsupportedValues(answer: string, evidence: string): string[] {
    const prose = answer.replace(CODE_BLOCK, ' ').replace(URL_PATTERN, ' ');
    const knownVersions = new Set([...evidence.matchAll(VERSION)].map((match) => match[1]));
    const knownDates = new Set(findDates(evidence).map(dateKey));
    const values = [...prose.matchAll(VERSION)].map((match) => match[1]).filter((version) => !knownVersions.has(version));
    values.push(...findDates(prose).filter((date) => !knownDates.has(dateKey(date))).map((date) => date.written));
    return [...new Set(values)];
}

// ============================================================================
// Action reports
// ============================================================================

function fileName(path: string): string {
    const parts = path.split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : '';
}

// List the places where the report disagrees with what the file and test tools really did.
export function actionReportProblems(report: string, actionLog: ActionRecord[]): string[] {
    const folded = report.toLowerCase();
    const mentionsFailure = FAILURE_WORD.test(report);
    const problems: string[] = [];
    for (const [name, argumentsGiven, result] of actionLog) {
        const failed = ['Tool error', 'Tests failed', 'Tests timed out'].some((prefix) => result.startsWith(prefix));
        const firstLine = result.split(/\r\n|\r|\n/)[0];
        if (name === 'write_file') {
            const path = String(argumentsGiven.path ?? '');
            if (!path) {
                continue;
            }
            if (!folded.includes(fileName(path).toLowerCase())) {
                const outcome = failed ? 'failed' : 'was made';
                problems.push(`The change to ${path} ${outcome}, but the report does not mention it.`);
            } else if (failed && !mentionsFailure) {
                problems.push(`Writing ${path} failed (${result.slice(0, 200)}); say plainly that this change was not made.`);
            }
        } else if (name === 'run_tests') {
            if (failed && !mentionsFailure) {
                problems.push(`The test run did not pass (${firstLine}); the report must say so.`);
            } else if (!folded.includes('test')) {
                problems.push(`The tests were run (${firstLine}); the report must give the result.`);
            }
        }
    }
    return [...problems, ...unbackedClaims(report, actionLog)];
}

// List the changes and passing tests a report claims that no recorded action backs up.
export function unbackedClaims(report: string, actionLog: ActionRecord[]): string[] {
    const problems: string[] = [];
    const wroteAFile = actionLog.some(([name, , result]) => name === 'write_file' && !result.startsWith('Tool error'));
    if (!wroteAFile && claims(CLAIMED_CHANGE, report)) {
        problems.push('No file was written, so the report must not say that anything was changed.');
    }
    const testsPassed = actionLog.some(([name, , result]) => name === 'run_tests' && result.startsWith('Tests passed'));
    if (!testsPassed && claims(CLAIMED_PASSING_TESTS, report)) {
        problems.push('No test run passed, so the report must not say that the tests pass.');
    }
    return problems;
}

// ============================================================================
// Working out a sum
// ============================================================================

class NotASum extends Error {}

type Token = { kind: 'number'; value: number } | { kind: 'operator'; value: string };

// Split a sum into numbers, operators and brackets, refusing anything else.
function tokenize(text: string): Token[] {
    const tokens: Token[] = [];
    const pattern = /\s*(?:(\d+\.\d*|\.\d+|\d+)|(\*\*|[-+*/()]))/y;
    let position = 0;
    while (position < text.length) {
        pattern.lastIndex = position;
        const match = pattern.exec(text);
        if (match === null) {
            if (text.slice(position).trim() === '') {
                break;
            }
            throw new NotASum('The text is not a sum.');
        }
        if (match[1] !== undefined) {
            // A whole number may not start with a zero, as in 07, unless it is all zeros.
            if (/^0\d/.test(match[1]) && !match[1].includes('.') && /[1-9]/.test(match[1])) {
                throw new NotASum('A number may not start with a zero.');
            }
            tokens.push({ kind: 'number', value: Number(match[1]) });
        } else {
            tokens.push({ kind: 'operator', value: match[2] });
        }
        position = pattern.lastIndex;
    }
    return tokens;
}

// Work out a sum of numbers only, with the usual precedence, refusing huge powers and division by zero.
function evaluate(text: string): number {
    const tokens = tokenize(text);
    let position = 0;
    const peek = (): Token | undefined => tokens[position];
    const isOperator = (value: string): boolean => {
        const token = peek();
        return token !== undefined && token.kind === 'operator' && token.value === value;
    };

    const sum = (): number => {
        let value = product();
        while (isOperator('+') || isOperator('-')) {
            const operator = (tokens[position++] as { value: string }).value;
            const right = product();
            value = operator === '+' ? value + right : value - right;
        }
        return value;
    };
    const product = (): number => {
        let value = unary();
        while (isOperator('*') || isOperator('/')) {
            const operator = (tokens[position++] as { value: string }).value;
            const right = unary();
            if (operator === '/' && right === 0) {
                throw new NotASum('Division by zero.');
            }
            value = operator === '*' ? value * right : value / right;
        }
        return value;
    };
    const unary = (): number => {
        if (isOperator('-')) {
            position++;
            return -unary();
        }
        if (isOperator('+')) {
            position++;
            return unary();
        }
        return power();
    };
    const power = (): number => {
        const base = primary();
        if (!isOperator('**')) {
            return base;
        }
        position++;
        const exponent = unary();
        if (Math.abs(exponent) > 100 || Math.abs(base) > 1e6) {
            throw new NotASum('The power is too large to work out.');
        }
        if (base === 0 && exponent < 0) {
            throw new NotASum('Division by zero.');
        }
        return base ** exponent;
    };
    const primary = (): number => {
        const token = tokens[position++];
        if (token === undefined) {
            throw new NotASum('The sum ends early.');
        }
        if (token.kind === 'number') {
            return token.value;
        }
        if (token.value === '(') {
            const value = sum();
            if (!isOperator(')')) {
                throw new NotASum('A bracket is not closed.');
            }
            position++;
            return value;
        }
        throw new NotASum('Only numbers and arithmetic operators can be worked out.');
    };

    // A sum that starts with a space is refused, as the original parser does.
    if (/^\s/.test(text)) {
        throw new NotASum('The sum starts with a space.');
    }
    const value = sum();
    if (position !== tokens.length) {
        throw new NotASum('Something follows the sum.');
    }
    if (!Number.isFinite(value)) {
        throw new NotASum('The result is too large to work out.');
    }
    return value;
}

// ============================================================================
// Recomputing calculations
// ============================================================================

const EQUALS_SIGNS = '=≈';
// Characters a written-out sum may hold: digits, operators, brackets, grouping commas, and currency signs.
const EQUATION_CHARACTERS = new Set('0123456789.,()+-*/^ £$€');
const OPERATOR_BETWEEN_NUMBERS = /[\d)]\s*[-+*/^]\s*[\d(]/;
const CLAIMED_NUMBER = /^\s*[£$€]?\s*(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\d,])|-?\d+(?:\.\d+)?)/;
const GROUPING_COMMA = /(?<=\d),(?=\d{3}(?!\d))/g;
const LOOKS_LIKE_A_DATE = /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}\/\d{2,4}/;
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const WEEKDAY_BEFORE = new RegExp(`\\b(${WEEKDAYS.join('|')})\\s*,?\\s*(?:the\\s+)?$`, 'i');
const WEEKDAY_AFTER = new RegExp(
    `^\\s*,?\\s*(?:is|was|will be|would be|falls on|fell on|lands on)\\s+(?:a\\s+|on\\s+a\\s+)?(${WEEKDAYS.join('|')})\\b`,
    'i',
);

// Write the usual typographic operators as the plain ones.
function normalizedArithmetic(text: string): string {
    const plain = text.replace(/[−–]/g, '-').replace(/[×·]/g, '*').replace(/÷/g, '/');
    return plain.replace(/(?<=\d)\s*[xX]\s*(?=\d)/g, ' * ');
}

function count(text: string, character: string): number {
    return text.split(character).length - 1;
}

// Find the written-out sum that ends where the text ends, and work it out, or return null.
function sumBefore(text: string): [string, number] | null {
    let start = text.length;
    while (start > 0 && EQUATION_CHARACTERS.has(text[start - 1])) {
        start -= 1;
    }
    const words = text.slice(start).split(/\s+/).filter(Boolean);
    // Leading words such as a list number or an opening bracket are dropped until what is left reads as a sum.
    for (let first = 0; first < words.length; first++) {
        let written = words.slice(first).join(' ').trim();
        while (written.startsWith('(') && count(written, '(') > count(written, ')')) {
            written = written.slice(1).trim();
        }
        if (!OPERATOR_BETWEEN_NUMBERS.test(written) || LOOKS_LIKE_A_DATE.test(written)) {
            continue;
        }
        const plain = written.replace(/[£$€]/g, '').replace(GROUPING_COMMA, '');
        if (plain.includes(',')) {
            continue;
        }
        try {
            return [written, evaluate(plain.replaceAll('^', '**'))];
        } catch (error) {
            if (error instanceof NotASum) {
                continue;
            }
            throw error;
        }
    }
    return null;
}

// Read the number written just after an equals sign, or return null when it is not a plain number.
function claimedNumber(text: string): [string, number] | null {
    const match = CLAIMED_NUMBER.exec(text);
    if (match === null) {
        return null;
    }
    const written = match[1];
    const end = match[0].length;
    const following = text.slice(end, end + 1);
    // A time, a fraction, a percentage, or a version number is not the plain result of a sum.
    if (following && (':/%'.includes(following) || (following === '.' && /^\d$/.test(text.slice(end + 1, end + 2))))) {
        return null;
    }
    return [written, Number(written.replaceAll(',', ''))];
}

// Return the weekday of a date, Monday first, or null when the date does not exist.
function weekdayOf(year: number, month: number, day: number): number | null {
    if (year < 1 || month < 1 || month > 12 || day < 1) {
        return null;
    }
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        return null;
    }
    return (date.getUTCDay() + 6) % 7;
}

function capitalize(word: string): string {
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

// List the dates the text names with the wrong day of the week.
function weekdayProblems(text: string): string[] {
    const problems: string[] = [];
    for (const date of findDates(text)) {
        const weekday = weekdayOf(date.year, date.month, date.day);
        if (weekday === null) {
            continue;
        }
        const end = date.index + date.written.length;
        const named = WEEKDAY_BEFORE.exec(text.slice(Math.max(0, date.index - 20), date.index)) ?? WEEKDAY_AFTER.exec(text.slice(end, end + 30));
        if (named && named[1].toLowerCase() !== WEEKDAYS[weekday]) {
            problems.push(`The result calls ${date.written} a ${capitalize(named[1])}, but it is a ${capitalize(WEEKDAYS[weekday])}.`);
        }
    }
    return problems;
}

// Write a number with thousands commas.
function grouped(digits: string): string {
    const negative = digits.startsWith('-');
    const [whole, fraction] = (negative ? digits.slice(1) : digits).split('.');
    const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (negative ? '-' : '') + withCommas + (fraction !== undefined ? `.${fraction}` : '');
}

// List the written-out sums whose stated result is wrong, and the dates given the wrong weekday.
export function calculationProblems(text: string): string[] {
    const prose = normalizedArithmetic(text.replace(CODE_BLOCK, ' '));
    const problems: string[] = [];
    for (let index = 0; index < prose.length; index++) {
        const sign = prose[index];
        if (!EQUALS_SIGNS.includes(sign)) {
            continue;
        }
        const workedOut = sumBefore(prose.slice(0, index));
        const claimed = claimedNumber(prose.slice(index + 1));
        if (workedOut === null || claimed === null) {
            continue;
        }
        const [writtenSum, value] = workedOut;
        const [writtenResult, stated] = claimed;
        const decimals = (writtenResult.split('.')[1] ?? '').length;
        // A stated result may round the true value to the decimals it shows, and "≈" allows one more unit.
        const allowed = 10 ** -decimals * (sign === '≈' ? 1 : 0.5) + 1e-9;
        // A whole-number result of a division is read as the quotient, as in "787 / 60 = 13 hours and 7 minutes".
        const quotient = writtenSum.includes('/') && decimals === 0 && stated === Math.trunc(value);
        if (Math.abs(value - stated) > allowed && !quotient) {
            const exact = Number.isInteger(value)
                ? grouped(String(Math.trunc(value)))
                : grouped(value.toFixed(Math.max(decimals, 2))).replace(/0+$/, '').replace(/\.$/, '');
            problems.push(`The working states ${writtenSum} ${sign} ${writtenResult}, but it equals ${exact}.`);
        }
    }
    return [...problems, ...weekdayProblems(prose)];
}

// ============================================================================
// Coverage
// ============================================================================

// Words that ask for every listed item to be handled: "classify", "categorize", "go through", "list all", or "each" or "every" before an item word.
const COVERAGE_REQUEST =
    /\b(?:classif(?:y|ies|ied|ying)|categori[sz](?:e|es|ed|ing)|go(?:es|ing)? through|list (?:all|every)|(?:each|every)\s+(?:one\s+of\s+the\s+|of\s+the\s+)?(?:\w+\s+)?(?:files?|entr(?:y|ies)|items?|(?:sub-?)?folders?|(?:sub-?)?director(?:y|ies)|documents?|e-?mails?|messages?|notes?|photos?|images?|events?|contacts?|results?))\b/i;
// Words that ask for the folders inside a folder to be gone through too.
const SUBFOLDER_REQUEST = /\b(?:sub-?folders?|sub-?director(?:y|ies)|recursive(?:ly)?|nested folders?)\b/i;
// Fields of a connected tool's result item that name it, in the order they are tried.
const ITEM_NAME_FIELDS = ['name', 'title', 'filename', 'file_name', 'subject'];
// A longer item name is rarely copied word for word into an answer, so it is not held to coverage.
const MAX_ITEM_NAME_CHARS = 80;
const MAX_NAMED_MISSES = 15;

export type ListedEntry = { name: string; folder: boolean };

// What one listing tool call returned: the folder or call it lists, and its entries.
export type Listing = { tool: string; path: string; entries: ListedEntry[] };

// What a task's gather step listed, and whether it used up its tool calls or had a result cut to fit.
export type GatheredListings = { listings: Listing[]; limitReached: boolean; resultsCut: boolean };

export type Coverage = { items: number; missing: string[]; unentered: string[] };

export function asksForCoverage(request: string): boolean {
    return COVERAGE_REQUEST.test(request);
}

export function asksForSubfolders(request: string): boolean {
    return SUBFOLDER_REQUEST.test(request);
}

// Write a folder path one way, relative to the root, so listings of the same folder match.
export function normalFolder(path: string, root = ''): string {
    let plain = path.trim().replaceAll('\\', '/');
    if (root && (plain === root || plain.startsWith(`${root.replace(/\/$/, '')}/`))) {
        plain = plain.slice(root.replace(/\/$/, '').length);
    }
    const parts: string[] = [];
    for (const part of plain.split('/')) {
        if (part === '..') {
            parts.pop();
        } else if (part && part !== '.') {
            parts.push(part);
        }
    }
    return parts.length > 0 ? parts.join('/') : '.';
}

export function joinFolder(folder: string, name: string): string {
    return folder === '.' ? name : `${folder}/${name}`;
}

// Say whether a path is the folder itself or lies inside it.
export function insideFolder(path: string, folder: string): boolean {
    return folder === '.' || path === folder || path.startsWith(`${folder}/`);
}

function itemName(item: unknown): string {
    if (typeof item === 'string') {
        return item;
    }
    if (typeof item !== 'object' || item === null) {
        return '';
    }
    const record = item as Record<string, unknown>;
    const field = ITEM_NAME_FIELDS.find((key) => typeof record[key] === 'string' && record[key]);
    return field === undefined ? '' : (record[field] as string);
}

// Read the entries a listing tool returned, or null for any other call or a result that is not a list.
export function parseListing(tool: string, rawArguments: string, result: string, root = ''): Listing | null {
    let data: unknown;
    let argumentsGiven: Record<string, unknown> = {};
    try {
        data = JSON.parse(result);
        const parsed: unknown = JSON.parse(rawArguments || '{}');
        if (typeof parsed === 'object' && parsed !== null) {
            argumentsGiven = parsed as Record<string, unknown>;
        }
    } catch {
        return null;
    }
    if (tool === 'list_directory') {
        if (!Array.isArray(data)) {
            return null;
        }
        const entries = data
            .filter((entry): entry is { name: string; type?: string } => typeof entry?.name === 'string')
            .map((entry) => ({ name: entry.name, folder: entry.type === 'directory' }));
        return { tool, path: normalFolder(String(argumentsGiven.path ?? '.'), root), entries };
    }
    // A connected tool counts as a listing when its name says it lists or searches and it returned a list.
    const toolName = tool.split('__').at(-1) ?? '';
    if (!tool.startsWith('mcp__') || !/list|search|find|query/i.test(toolName)) {
        return null;
    }
    let items: unknown = data;
    if (!Array.isArray(items) && typeof items === 'object' && items !== null) {
        const arrays = Object.values(items).filter(Array.isArray);
        items = arrays.length === 1 ? arrays[0] : null;
    }
    if (!Array.isArray(items)) {
        return null;
    }
    const entries = items
        .map(itemName)
        .filter((name) => name && name.length <= MAX_ITEM_NAME_CHARS)
        .map((name) => ({ name, folder: false }));
    return entries.length > 0 ? { tool, path: `${tool} ${JSON.stringify(argumentsGiven)}`, entries } : null;
}

// Fold case, spacing and markdown escapes, so a name written as "my\_file" still matches.
function folded(text: string): string {
    return text
        .replace(/\\([_*`[\]()#])/g, '$1')
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

// Compare the items the tools listed with the names in the answer; with subfolders asked for, also find folders never listed.
export function coverage(answer: string, listings: Listing[], subfolders: boolean): Coverage {
    const text = folded(answer);
    const listed = new Set(listings.filter((listing) => listing.tool === 'list_directory').map((listing) => listing.path));
    const items = new Map<string, string>();
    const unentered = new Set<string>();
    for (const listing of listings) {
        const isFolder = listing.tool === 'list_directory';
        for (const entry of listing.entries) {
            const path = isFolder ? joinFolder(listing.path, entry.name) : entry.name;
            if (!entry.folder) {
                items.set(path, entry.name);
            } else if (subfolders && !listed.has(path)) {
                unentered.add(path);
            }
        }
    }
    const missing = [...items].filter(([, name]) => !text.includes(folded(name))).map(([path]) => path);
    return { items: items.size, missing, unentered: [...unentered] };
}

function named(paths: string[]): string {
    const shown = paths.slice(0, MAX_NAMED_MISSES).join(', ');
    return paths.length > MAX_NAMED_MISSES ? `${shown} and ${paths.length - MAX_NAMED_MISSES} more` : shown;
}

// Say which listed items the answer leaves out and which subfolders were never gone through.
export function coverageProblems(found: Coverage | null): string[] {
    if (found === null) {
        return [];
    }
    const problems: string[] = [];
    if (found.missing.length > 0) {
        problems.push(`The tools listed ${found.items} items, but the result leaves out ${found.missing.length}: ${named(found.missing)}.`);
    }
    if (found.unentered.length > 0) {
        problems.push(`The request covers subfolders, but these were listed and never gone through: ${named(found.unentered)}.`);
    }
    return problems;
}
