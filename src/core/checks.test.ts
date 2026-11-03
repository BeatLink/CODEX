import { describe, expect, it } from 'vitest';

import {
    action_report_problems,
    calculation_problems,
    unbacked_claims,
    uncited_urls,
    unsupported_values,
} from './checks.js';

describe('checks', () => {
    it('tracks unsupported versions and dates', () => {
        const evidence = '[{"snippet": "Python 3.13.0 was released on 2024-10-07.", "url": "https://docs.python.org/3.12/"}]';
        const answer = 'Python 3.13.0 came out on October 7, 2024, after 3.12 and before 3.15.0, which shipped 9 October 2026. See https://example.test/v9.9.9.\n```\npip install tool==1.2.3\n```';

        expect(unsupported_values(answer, evidence)).toEqual(['3.15.0', '9 October 2026']);
    });

    it('ignores trailing punctuation on uncited URLs', () => {
        const evidence = '[{"url": "https://docs.example/a"}]';
        const answer = 'Per https://docs.example/a, and https://other.example/b.';
        expect(uncited_urls(answer, evidence)).toEqual(['https://other.example/b']);
    });

    it('checks action logs against reported changes', () => {
        const log = [
            ['write_file', { path: 'src/parser.py' }, 'Wrote 10 bytes to src/parser.py.'],
            ['run_tests', {}, 'Tests failed (exit 1).\nTraceback'],
        ] as any;

        expect(action_report_problems('Updated parser.py; the tests failed.', log)).toEqual([]);
        const problems = action_report_problems('Updated parser.py and all is well.', log);
        expect(problems.length).toBe(1);
        expect(problems[0]).toContain('Tests failed (exit 1)');
        expect(action_report_problems('The tests failed.', log)[0]).toContain('src/parser.py');
    });

    it('requires recorded actions for claimed changes and passing tests', () => {
        const report = 'Changed `ranges.py` to use `range(start, end + 1)`. Ran `test_ranges.py` and all tests now pass.';

        expect(unbacked_claims(report, []).length).toBe(2);
        const log = [
            ['write_file', { path: 'ranges.py' }, 'Wrote 80 bytes to ranges.py.'],
            ['run_tests', {}, 'Tests passed.\nOK'],
        ] as any;
        expect(unbacked_claims(report, log)).toEqual([]);

        const failedRun = [log[0], ['run_tests', {}, 'Tests failed (exit 1).\nFAILED']] as any;
        expect(unbacked_claims(report, failedRun)).toEqual([
            'No test run passed, so the report must not say that the tests pass.',
        ]);
        expect(unbacked_claims('The bug is that range excludes the end.', [])).toEqual([]);
        expect(unbacked_claims('Nothing was edited, and the tests did not pass.', [])).toEqual([]);
        expect(unbacked_claims('Wrote nothing.', [])).toEqual([]);

        const longClaim = 'The test `test_default_timeout` in `test_app_settings.py` was run and passed.';
        expect(unbacked_claims(longClaim, []).length).toBe(1);
    });

    it('finds arithmetic mistakes in working text', () => {
        const working = '4.  Summing: 588.2 + 2,048 = 2,636.2.\n5.  Subtracting: 2,636.2 − 1,125 = 2,571.2.';
        expect(calculation_problems(working)).toEqual([
            'The working states 2,636.2 - 1,125 = 2,571.2, but it equals 1,511.2.',
        ]);

        const correct = '1. 17% of 3,460 is 588.2 (3,460 × 0.17 = 588.2).\n2. 263 ÷ 84 = 3.13 hours, and 2000 × 1.068^7 ≈ 3,169.78.\n3. 787 ÷ 60 = 13 hours and 7 minutes.';
        expect(calculation_problems(correct)).toEqual([]);
        expect(calculation_problems('17 × 3 = 41, so 41.')).toEqual([
            'The working states 17 * 3 = 41, but it equals 51.',
        ]);
    });

    it('ignores times, dates, versions, and code blocks when checking arithmetic', () => {
        const text = 'Start 09:47 + 13 hours = 22:47. Released 2026-03-14 = later. Python 3.9 = 3.10?\n```\nx = 1 + 1\nassert 2 + 2 == 5\n```';
        expect(calculation_problems(text)).toEqual([]);
    });

    it('flags wrong weekdays for dated claims', () => {
        expect(calculation_problems('It falls on Wednesday, 29 February 2032. 14 March 2026 is a Saturday.')).toEqual([
            'The result calls 29 February 2032 a Wednesday, but it is a Sunday.',
        ]);
    });
});
