import unittest

from smartharness.checks import action_report_problems, unbacked_claims, uncited_urls, unsupported_values


class EvidenceCheckTests(unittest.TestCase):
    def test_versions_and_dates_missing_from_the_evidence_are_unsupported(self):
        evidence = '[{"snippet": "Python 3.13.0 was released on 2024-10-07.", "url": "https://docs.python.org/3.12/"}]'
        answer = (
            "Python 3.13.0 came out on October 7, 2024, after 3.12 and before 3.15.0, "
            "which shipped 9 October 2026. See https://example.test/v9.9.9.\n"
            "```\npip install tool==1.2.3\n```"
        )

        self.assertEqual(unsupported_values(answer, evidence), ["3.15.0", "9 October 2026"])

    def test_uncited_urls_ignore_trailing_punctuation_and_known_sources(self):
        evidence = '[{"url": "https://docs.example/a"}]'
        answer = "Per https://docs.example/a, and https://other.example/b."

        self.assertEqual(uncited_urls(answer, evidence), ["https://other.example/b"])


class ActionReportTests(unittest.TestCase):
    def test_report_must_match_written_files_and_test_results(self):
        log = [
            ("write_file", {"path": "src/parser.py"}, "Wrote 10 bytes to src/parser.py."),
            ("run_tests", {}, "Tests failed (exit 1).\nTraceback"),
        ]

        self.assertEqual(action_report_problems("Updated parser.py; the tests failed.", log), [])
        problems = action_report_problems("Updated parser.py and all is well.", log)
        self.assertEqual(len(problems), 1)
        self.assertIn("Tests failed (exit 1)", problems[0])
        self.assertIn("src/parser.py", action_report_problems("The tests failed.", log)[0])

    def test_report_must_not_claim_a_change_when_nothing_was_written(self):
        log = [("write_file", {"path": "a.py"}, "Tool error: file access is read-only.")]

        problems = action_report_problems("I have updated a.py.", log)

        self.assertIn("No file was written, so the report must not say that anything was changed.", problems)
        self.assertTrue(any("Writing a.py failed" in problem for problem in problems))
        self.assertEqual(action_report_problems("The change to a.py could not be made.", log), [])

    def test_claimed_changes_and_passing_tests_need_a_recorded_action(self):
        report = "Changed `ranges.py` to use `range(start, end + 1)`. Ran `test_ranges.py` and all tests now pass."

        self.assertEqual(len(unbacked_claims(report, [])), 2)
        log = [
            ("write_file", {"path": "ranges.py"}, "Wrote 80 bytes to ranges.py."),
            ("run_tests", {}, "Tests passed.\nOK"),
        ]
        self.assertEqual(unbacked_claims(report, log), [])
        failed_run = [log[0], ("run_tests", {}, "Tests failed (exit 1).\nFAILED")]
        self.assertEqual(
            unbacked_claims(report, failed_run), ["No test run passed, so the report must not say that the tests pass."]
        )
        self.assertEqual(unbacked_claims("The bug is that range excludes the end.", []), [])
        self.assertEqual(unbacked_claims("Nothing was edited, and the tests did not pass.", []), [])
        self.assertEqual(unbacked_claims("Wrote nothing.", []), [])
        long_claim = "The test `test_default_timeout` in `test_app_settings.py` was run and passed."
        self.assertEqual(len(unbacked_claims(long_claim, [])), 1)


if __name__ == "__main__":
    unittest.main()
