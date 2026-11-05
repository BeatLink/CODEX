// Score recall against fixed questions whose relevant stored facts are known, by words alone and by meaning too.
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { getEmbedder, type TextEmbedder } from './embeddings.js';
import { EVALS_DIRECTORY, buildSeedStore } from './evaluation.js';
import { KnowledgeStore } from './knowledge.js';
import { defaultSettingsPath, loadSettings } from './settings.js';

export const SEED_PATH = join(EVALS_DIRECTORY, 'recall_benchmark_seed.json');
export const QUESTIONS_PATH = join(EVALS_DIRECTORY, 'recall_benchmark.json');
export const QUESTION_KINDS = ['shared words', 'paraphrase', 'several facts', 'unrelated'] as const;

// Recall returns five facts by default, which is what a request sees.
export const RECALL_LIMIT = 5;

// ============================================================================
// Questions and results
// ============================================================================

export class Question {
    constructor(
        readonly id: string,
        readonly kind: string,
        readonly query: string,
        readonly expected: string[],
    ) {}
}

export class Answer {
    constructor(
        readonly question: Question,
        readonly recalled: string[],
        readonly seconds: number,
    ) {}

    get found(): string[] {
        return this.question.expected.filter((statement) => this.recalled.includes(statement));
    }

    // The position of the first expected fact among those recalled, counting from 1.
    get firstHitRank(): number | null {
        const index = this.recalled.findIndex((statement) => this.question.expected.includes(statement));
        return index >= 0 ? index + 1 : null;
    }

    get passed(): boolean {
        // An unrelated question passes only when nothing comes back; the rest need one expected fact.
        return this.question.expected.length === 0 ? this.recalled.length === 0 : this.found.length > 0;
    }
}

export class Score {
    constructor(
        readonly label: string,
        readonly answers: Answer[] = [],
    ) {}
}

export function loadQuestions(questionsPath: string): Question[] {
    const data: unknown = JSON.parse(readFileSync(questionsPath, 'utf-8'));
    if (!Array.isArray(data) || data.length === 0) {
        throw new Error('The question file must be a non-empty JSON list.');
    }
    const questions: Question[] = [];
    for (const item of data as unknown[]) {
        if (typeof item !== 'object' || item === null || Array.isArray(item) || !(QUESTION_KINDS as readonly unknown[]).includes((item as Record<string, unknown>).kind)) {
            throw new Error(`Each question needs a kind from: ${QUESTION_KINDS.join(', ')}.`);
        }
        const entry = item as Record<string, unknown>;
        if (!Array.isArray(entry.expected) || (entry.expected.length > 0) === (entry.kind === 'unrelated')) {
            throw new Error(`Question ${String(entry.id ?? 'None')} lists expected facts only when it is not unrelated.`);
        }
        questions.push(new Question(String(entry.id), entry.kind as string, String(entry.query), entry.expected.map((fact) => String(fact))));
    }
    return questions;
}

// ============================================================================
// Running
// ============================================================================

// Build a fresh store from the seed, then recall each question and record what came back.
export async function scoreRecall(seedPath: string, questions: Question[], embedder: TextEmbedder | null, label: string): Promise<Score> {
    const directory = mkdtempSync(join(tmpdir(), 'codex-recall-'));
    try {
        const databasePath = join(directory, 'seed.sqlite3');
        await buildSeedStore(seedPath, databasePath, embedder);
        const store = new KnowledgeStore(databasePath, embedder);
        const statements = new Set(store.facts({ limit: 10_000 }).map((fact) => fact.statement as string));
        const missing = questions.flatMap((question) => question.expected.filter((fact) => !statements.has(fact)));
        if (missing.length > 0) {
            throw new Error(`Expected facts missing from the seed: ${missing[0]}`);
        }
        const score = new Score(label);
        for (const question of questions) {
            const started = performance.now();
            const recalled = (await store.recall(question.query, { limit: RECALL_LIMIT, includeMemories: false })).facts;
            score.answers.push(new Answer(question, recalled.map((fact) => fact.statement), (performance.now() - started) / 1000));
        }
        return score;
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

export type RecallSummary = Record<string, string | number> & { label: string };

// Return the pass rate per question kind, the share of expected facts found, the mean reciprocal rank, and timing.
export function summarize(score: Score): RecallSummary {
    const summary: RecallSummary = { label: score.label };
    for (const kind of QUESTION_KINDS) {
        const answers = score.answers.filter((answer) => answer.question.kind === kind);
        if (answers.length > 0) {
            summary[kind] = answers.filter((answer) => answer.passed).length / answers.length;
        }
    }
    const relevant = score.answers.filter((answer) => answer.question.expected.length > 0);
    const total = (values: number[]) => values.reduce((sum, value) => sum + value, 0);
    summary['facts found'] = total(relevant.map((answer) => answer.found.length)) / total(relevant.map((answer) => answer.question.expected.length));
    summary['mean reciprocal rank'] = total(relevant.map((answer) => 1 / (answer.firstHitRank ?? Infinity))) / relevant.length;
    summary['mean seconds'] = total(score.answers.map((answer) => answer.seconds)) / score.answers.length;
    return summary;
}

export function formatTable(summaries: RecallSummary[]): string {
    const rows = [...QUESTION_KINDS, 'facts found', 'mean reciprocal rank', 'mean seconds'].filter((label) => label in summaries[0]);
    const width = Math.max(...rows.map((row) => row.length)) + 2;
    const lines = [' '.repeat(width) + summaries.map((summary) => summary.label.padStart(16)).join('')];
    for (const row of rows) {
        const cells = summaries
            .map((summary) => {
                const value = summary[row] as number;
                const text = row === 'mean reciprocal rank' || row === 'mean seconds' ? value.toFixed(2) : `${(value * 100).toFixed(0)}%`;
                return text.padStart(16);
            })
            .join('');
        lines.push(row.padEnd(width) + cells);
    }
    return lines.join('\n');
}

export function formatFailures(score: Score): string {
    const lines = [`Failed with ${score.label}:`];
    for (const answer of score.answers) {
        if (!answer.passed) {
            const got = answer.recalled.join('; ') || 'nothing';
            lines.push(`- ${answer.question.id} (${answer.question.kind}): got ${got}`);
        }
    }
    return lines.length > 1 ? lines.join('\n') : `No failures with ${score.label}.`;
}

// ============================================================================
// Command line
// ============================================================================

const PROGRAM = 'codex recall-benchmark';
const USAGE =
    `usage: ${PROGRAM} [-h] [--seed SEED] [--questions QUESTIONS] [--settings SETTINGS]\n` +
    '                              [--embedding-model-path EMBEDDING_MODEL_PATH] [--words-only] [--show-failures]';

function helpText(): string {
    return [
        USAGE,
        '',
        'Score recall on fixed questions with known relevant facts, by words alone and by meaning too.',
        '',
        'options:',
        '  -h, --help            show this help message and exit',
        '  --seed SEED           Seed file of made-up facts (default: evals/recall_benchmark_seed.json).',
        '  --questions QUESTIONS',
        '                        Question file (default: evals/recall_benchmark.json).',
        '  --settings SETTINGS   Settings file naming the embedding model.',
        '  --embedding-model-path EMBEDDING_MODEL_PATH',
        '                        Embedding GGUF model (overrides the settings file).',
        '  --words-only          Skip the run that recalls by meaning.',
        '  --show-failures       List what each failed question recalled.',
    ].join('\n');
}

export type RecallArguments = {
    seed: string;
    questions: string;
    settings: string;
    embedding_model_path: string | null;
    words_only: boolean;
    show_failures: boolean;
};

const VALUE_OPTIONS = ['seed', 'questions', 'settings', 'embedding-model-path'];
const FLAG_OPTIONS = ['words-only', 'show-failures'];

function looksLikeFlag(word: string): boolean {
    return word.startsWith('-') && word !== '-' && !/^-\d+(\.\d*)?$/.test(word);
}

// Read the command line, returning the values, or the help text, or a usage error message.
export function parseRecallArguments(argv: string[]): RecallArguments | { help: string } | { error: string } {
    const values: RecallArguments = {
        seed: SEED_PATH,
        questions: QUESTIONS_PATH,
        settings: defaultSettingsPath(),
        embedding_model_path: null,
        words_only: false,
        show_failures: false,
    };
    const unrecognized: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
        const word = argv[index];
        if (word === '-h' || word === '--help') {
            return { help: helpText() };
        }
        const equals = word.indexOf('=');
        const flag = word.startsWith('--') ? (equals >= 0 ? word.slice(2, equals) : word.slice(2)) : '';
        const inline = equals >= 0 ? word.slice(equals + 1) : null;
        if (FLAG_OPTIONS.includes(flag)) {
            if (inline !== null) {
                return { error: `argument --${flag}: ignored explicit argument '${inline}'` };
            }
            (values as Record<string, unknown>)[flag.replaceAll('-', '_')] = true;
        } else if (VALUE_OPTIONS.includes(flag)) {
            let text = inline;
            if (text === null) {
                const next = argv[index + 1];
                if (next === undefined || looksLikeFlag(next)) {
                    return { error: `argument --${flag}: expected one argument` };
                }
                text = next;
                index += 1;
            }
            (values as Record<string, unknown>)[flag.replaceAll('-', '_')] = text;
        } else {
            unrecognized.push(word);
        }
    }
    if (unrecognized.length > 0) {
        return { error: `unrecognized arguments: ${unrecognized.join(' ')}` };
    }
    return values;
}

// Run the benchmark from command-line words, returning the exit status: 0 done, 1 bad input, 2 bad command line.
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
    const parsed = parseRecallArguments(argv);
    if ('help' in parsed) {
        console.log(parsed.help);
        return 0;
    }
    if ('error' in parsed) {
        console.error(`${USAGE}\n${PROGRAM}: error: ${parsed.error}`);
        return 2;
    }
    const args = parsed;
    let questions: Question[];
    let embeddingModelPath: string;
    try {
        questions = loadQuestions(args.questions);
        embeddingModelPath = args.embedding_model_path || loadSettings(args.settings).embedding_model_path;
    } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
    }
    const runs: Array<[string, TextEmbedder | null]> = [['words only', null]];
    const embedder = args.words_only ? null : getEmbedder(embeddingModelPath);
    if (!args.words_only) {
        if (embedder === null) {
            console.error(`No embedding model at ${embeddingModelPath}; scoring words only.`);
        } else {
            runs.push(['with meaning', embedder]);
        }
    }
    try {
        const scores: Score[] = [];
        for (const [label, runEmbedder] of runs) {
            scores.push(await scoreRecall(args.seed, questions, runEmbedder, label));
        }
        console.log(formatTable(scores.map(summarize)));
        if (args.show_failures) {
            for (const score of scores) {
                console.log();
                console.log(formatFailures(score));
            }
        }
    } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
    } finally {
        await embedder?.close();
    }
    return 0;
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    process.exit(await main());
}
