import { describe, expect, it } from 'vitest';

import { type ActionRecord, actionReportProblems, calculationProblems, unbackedClaims, uncitedUrls, unsupportedValues } from './checks.js';

// ============================================================================
// Evidence
// ============================================================================

describe('evidence checks', () => {
    it('finds versions and dates missing from the evidence', () => {
        const evidence = '[{"snippet": "Python 3.13.0 was released on 2024-10-07.", "url": "https://docs.python.org/3.12/"}]';
        const answer =
            'Python 3.13.0 came out on October 7, 2024, after 3.12 and before 3.15.0, ' +
            'which shipped 9 October 2026. See https://example.test/v9.9.9.\n' +
            '```\npip install tool==1.2.3\n```';

        expect(unsupportedValues(answer, evidence)).toEqual(['3.15.0', '9 October 2026']);
    });

    it('ignores trailing punctuation and known sources in cited URLs', () => {
        const evidence = '[{"url": "https://docs.example/a"}]';
        const answer = 'Per https://docs.example/a, and https://other.example/b.';

        expect(uncitedUrls(answer, evidence)).toEqual(['https://other.example/b']);
    });
});

// ============================================================================
// Action reports
// ============================================================================

describe('action reports', () => {
    it('must match the written files and the test results', () => {
        const log: ActionRecord[] = [
            ['write_file', { path: 'src/parser.py' }, 'Wrote 10 bytes to src/parser.py.'],
            ['run_tests', {}, 'Tests failed (exit 1).\nTraceback'],
        ];

        expect(actionReportProblems('Updated parser.py; the tests failed.', log)).toEqual([]);
        const problems = actionReportProblems('Updated parser.py and all is well.', log);
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('Tests failed (exit 1)');
        expect(actionReportProblems('The tests failed.', log)[0]).toContain('src/parser.py');
    });

    it('must not claim a change when nothing was written', () => {
        const log: ActionRecord[] = [['write_file', { path: 'a.py' }, 'Tool error: file access is read-only.']];

        const problems = actionReportProblems('I have updated a.py.', log);

        expect(problems).toContain('No file was written, so the report must not say that anything was changed.');
        expect(problems.some((problem) => problem.includes('Writing a.py failed'))).toBe(true);
        expect(actionReportProblems('The change to a.py could not be made.', log)).toEqual([]);
    });

    it('needs a recorded action behind claimed changes and passing tests', () => {
        const report = 'Changed `ranges.py` to use `range(start, end + 1)`. Ran `test_ranges.py` and all tests now pass.';
        const log: ActionRecord[] = [
            ['write_file', { path: 'ranges.py' }, 'Wrote 80 bytes to ranges.py.'],
            ['run_tests', {}, 'Tests passed.\nOK'],
        ];
        const failedRun: ActionRecord[] = [log[0], ['run_tests', {}, 'Tests failed (exit 1).\nFAILED']];

        expect(unbackedClaims(report, [])).toHaveLength(2);
        expect(unbackedClaims(report, log)).toEqual([]);
        expect(unbackedClaims(report, failedRun)).toEqual(['No test run passed, so the report must not say that the tests pass.']);
        expect(unbackedClaims('The bug is that range excludes the end.', [])).toEqual([]);
        expect(unbackedClaims('Nothing was edited, and the tests did not pass.', [])).toEqual([]);
        expect(unbackedClaims('Wrote nothing.', [])).toEqual([]);
        expect(unbackedClaims('The test `test_default_timeout` in `test_app_settings.py` was run and passed.', [])).toHaveLength(1);
    });
});

// ============================================================================
// Calculations
// ============================================================================

describe('calculations', () => {
    it('finds a wrong sum in the working with its true value', () => {
        const working = '4.  Summing: 588.2 + 2,048 = 2,636.2.\n5.  Subtracting: 2,636.2 − 1,125 = 2,571.2.';

        expect(calculationProblems(working)).toEqual(['The working states 2,636.2 - 1,125 = 2,571.2, but it equals 1,511.2.']);
    });

    it('passes correct and rounded sums', () => {
        const working =
            '1. 17% of 3,460 is 588.2 (3,460 × 0.17 = 588.2).\n' +
            '2. 263 ÷ 84 = 3.13 hours, and 2000 × 1.068^7 ≈ 3,169.78.\n' +
            '3. 787 ÷ 60 = 13 hours and 7 minutes.';

        expect(calculationProblems(working)).toEqual([]);
        expect(calculationProblems('17 × 3 = 41, so 41.')).toEqual(['The working states 17 * 3 = 41, but it equals 51.']);
    });

    it('does not read times, dates, versions or code as sums', () => {
        const text = 'Start 09:47 + 13 hours = 22:47. Released 2026-03-14 = later. Python 3.9 = 3.10?\n```\nx = 1 + 1\nassert 2 + 2 == 5\n```';

        expect(calculationProblems(text)).toEqual([]);
    });

    it('finds a date given the wrong weekday', () => {
        expect(calculationProblems('It falls on Wednesday, 29 February 2032. 14 March 2026 is a Saturday.')).toEqual([
            'The result calls 29 February 2032 a Wednesday, but it is a Sunday.',
        ]);
    });

    it('works out powers, brackets and signs with the usual precedence', () => {
        expect(calculationProblems('-2^2 = -4 and (1 + 2) * 3 = 9 and 2^3^2 = 512.')).toEqual([]);
        expect(calculationProblems('10 / 0 = 5 and 07 + 1 = 9.')).toEqual([]);
        expect(calculationProblems('2 ^ 101 = 3.')).toEqual([]);
        expect(calculationProblems('1,000 * 3 = 2,000.')).toEqual(['The working states 1,000 * 3 = 2,000, but it equals 3,000.']);
    });
});
