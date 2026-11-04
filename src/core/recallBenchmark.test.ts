import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Answer, QUESTIONS_PATH, Question, SEED_PATH, Score, loadQuestions, scoreRecall, summarize } from './recallBenchmark.js';

let directory: string;

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'codex-recall-test-'));
});

afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
});

function writeQuestions(questions: unknown): string {
    const path = join(directory, 'questions.json');
    writeFileSync(path, JSON.stringify(questions), 'utf-8');
    return path;
}

describe('recall benchmark', () => {
    it('scores the shipped questions by words alone', async () => {
        const score = await scoreRecall(SEED_PATH, loadQuestions(QUESTIONS_PATH), null, 'words only');

        const summary = summarize(score);

        expect(summary['shared words']).toBe(1.0);
        expect(summary.unrelated).toBe(1.0);
        expect(summary.paraphrase).toBeLessThan(0.5);
    });

    it('counts hits, coverage and rank', () => {
        const question = new Question('q', 'several facts', 'query', ['A.', 'B.']);
        const unrelated = new Question('u', 'unrelated', 'other', []);
        const score = new Score('test', [new Answer(question, ['C.', 'A.'], 0.5), new Answer(unrelated, ['C.'], 0.5)]);

        const summary = summarize(score);

        expect(summary['several facts']).toBe(1.0);
        expect(summary.unrelated).toBe(0.0);
        expect(summary['facts found']).toBe(0.5);
        expect(summary['mean reciprocal rank']).toBe(0.5);
    });

    it('rejects a question expecting a fact not in the seed', async () => {
        const path = writeQuestions([{ id: 'x', kind: 'paraphrase', query: 'q', expected: ['Not seeded.'] }]);

        await expect(scoreRecall(SEED_PATH, loadQuestions(path), null, 'words only')).rejects.toThrow('missing from the seed');
    });

    it('does not let unrelated questions list expected facts', () => {
        const path = writeQuestions([{ id: 'x', kind: 'unrelated', query: 'q', expected: ['A.'] }]);

        expect(() => loadQuestions(path)).toThrow('only when it is not unrelated');
    });
});
