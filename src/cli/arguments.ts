// A small command-line parser that reads flags the way the Python argparse interfaces do, with matching help and errors.

// ============================================================================
// Option specs
// ============================================================================

export type OptionKind = 'string' | 'int' | 'float' | 'flag' | 'negatable';

export type OptionSpec = {
    // The long flag without its dashes, such as "context-size".
    name: string;
    kind: OptionKind;
    help?: string;
    metavar?: string;
    choices?: readonly string[];
    default?: string | number | boolean | null;
};

export type ParserSpec = {
    program: string;
    description: string;
    options: OptionSpec[];
    // The name and help of a positional that takes every leftover word, or null for none.
    positional?: { name: string; help: string } | null;
};

export type ParsedArguments = {
    values: Record<string, string | number | boolean | null>;
    positionals: string[];
};

// Raised for a bad command line; the caller prints the usage and the message and exits with status 2.
export class UsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UsageError';
    }
}

// Raised when --help is given; its message is the help text to print before exiting with status 0.
export class HelpRequested extends Error {
    constructor(readonly text: string) {
        super(text);
        this.name = 'HelpRequested';
    }
}

// ============================================================================
// Help text
// ============================================================================

function valueName(option: OptionSpec): string {
    if (option.choices) {
        return `{${option.choices.join(',')}}`;
    }
    return option.metavar ?? option.name.toUpperCase().replaceAll('-', '_');
}

function optionUsage(option: OptionSpec): string {
    if (option.kind === 'flag') {
        return `--${option.name}`;
    }
    if (option.kind === 'negatable') {
        return `--${option.name} | --no-${option.name}`;
    }
    return `--${option.name} ${valueName(option)}`;
}

export function usageText(spec: ParserSpec): string {
    const parts = ['[-h]', ...spec.options.map((option) => `[${optionUsage(option)}]`)];
    if (spec.positional) {
        parts.push(`[${spec.positional.name} ...]`);
    }
    return `usage: ${spec.program} ${parts.join(' ')}`;
}

export function helpText(spec: ParserSpec): string {
    const lines = [usageText(spec), '', spec.description, ''];
    if (spec.positional) {
        lines.push('positional arguments:', `  ${spec.positional.name.padEnd(22)}${spec.positional.help}`, '');
    }
    lines.push('options:', `  ${'-h, --help'.padEnd(22)}show this help message and exit`);
    for (const option of spec.options) {
        const flag = optionUsage(option);
        lines.push(option.help ? `  ${flag.padEnd(22)}${flag.length >= 22 ? `\n  ${' '.repeat(22)}` : ''}${option.help}` : `  ${flag}`);
    }
    return lines.join('\n');
}

// ============================================================================
// Parsing
// ============================================================================

function convert(option: OptionSpec, text: string): string | number {
    if (option.kind === 'int') {
        if (!/^\s*[-+]?\d+\s*$/.test(text)) {
            throw new UsageError(`argument --${option.name}: invalid int value: '${text}'`);
        }
        return Number.parseInt(text, 10);
    }
    if (option.kind === 'float') {
        const value = Number(text);
        if (!text.trim() || Number.isNaN(value)) {
            throw new UsageError(`argument --${option.name}: invalid float value: '${text}'`);
        }
        return value;
    }
    if (option.choices && !option.choices.includes(text)) {
        const choices = option.choices.map((choice) => `'${choice}'`).join(', ');
        throw new UsageError(`argument --${option.name}: invalid choice: '${text}' (choose from ${choices})`);
    }
    return text;
}

// A word starting with a dash is a flag, unless it reads as a negative number.
function looksLikeFlag(word: string): boolean {
    return word.startsWith('-') && word !== '-' && !/^-\d+(\.\d*)?$/.test(word);
}

export function parseArguments(spec: ParserSpec, argv: string[]): ParsedArguments {
    const values: ParsedArguments['values'] = {};
    for (const option of spec.options) {
        values[option.name] = option.default ?? (option.kind === 'flag' ? false : null);
    }
    const positionals: string[] = [];
    const unrecognized: string[] = [];
    let onlyPositionals = false;
    for (let index = 0; index < argv.length; index += 1) {
        const word = argv[index];
        if (onlyPositionals || !looksLikeFlag(word)) {
            positionals.push(word);
            continue;
        }
        if (word === '--') {
            onlyPositionals = true;
            continue;
        }
        if (word === '-h' || word === '--help') {
            throw new HelpRequested(helpText(spec));
        }
        const equals = word.indexOf('=');
        const flag = equals >= 0 ? word.slice(2, equals) : word.slice(2);
        const inline = equals >= 0 ? word.slice(equals + 1) : null;
        const negated = spec.options.find((option) => option.kind === 'negatable' && `no-${option.name}` === flag);
        const option = negated ?? spec.options.find((candidate) => candidate.name === flag);
        if (!word.startsWith('--') || option === undefined) {
            unrecognized.push(word);
            continue;
        }
        if (option.kind === 'flag' || option.kind === 'negatable') {
            if (inline !== null) {
                throw new UsageError(`argument ${optionUsage(option)}: ignored explicit argument '${inline}'`);
            }
            values[option.name] = negated === undefined;
            continue;
        }
        let text = inline;
        if (text === null) {
            const next = argv[index + 1];
            if (next === undefined || looksLikeFlag(next)) {
                throw new UsageError(`argument --${option.name}: expected one argument`);
            }
            text = next;
            index += 1;
        }
        values[option.name] = convert(option, text);
    }
    if (!spec.positional && positionals.length > 0) {
        unrecognized.push(...positionals);
    }
    if (unrecognized.length > 0) {
        throw new UsageError(`unrecognized arguments: ${unrecognized.join(' ')}`);
    }
    return { values, positionals };
}
