import unittest

from smartharness.context_budget import (
    CONDENSED_MARKER,
    TRIMMED_MARKER,
    condense_sections,
    fit_sections,
    fit_sections_to_tokens,
    render_sections,
    token_counter,
)


class WordTokenModel:
    """Counts one token per word, so a test can predict the measured size."""

    def tokenize(self, text, add_bos=True, special=False):
        return text.decode("utf-8").split()


class ContextBudgetTests(unittest.TestCase):
    def test_pinned_request_is_kept_while_later_sections_are_trimmed(self):
        sections = [("Request", "keep " * 50), ("Draft", "x" * 2_000), ("Plan", "y" * 2_000)]

        fitted = fit_sections(sections, 1_500, pinned=1)

        self.assertEqual(fitted[0], sections[0])
        self.assertTrue(fitted[1][1].endswith(TRIMMED_MARKER))
        self.assertLessEqual(len(render_sections(fitted)), 1_500)

    def test_pinned_request_is_trimmed_only_when_it_alone_overflows(self):
        fitted = fit_sections([("Request", "r" * 5_000), ("Draft", "d" * 100)], 1_000, pinned=1)

        self.assertTrue(fitted[0][1].endswith(TRIMMED_MARKER))

    def test_fitting_measures_with_the_model_tokenizer(self):
        count_tokens = token_counter(WordTokenModel())
        sections = [("Request", "short request"), ("Evidence", "word " * 1_000)]

        fitted = fit_sections_to_tokens(sections, 300, count_tokens, pinned=1)

        self.assertLessEqual(count_tokens(render_sections(fitted)), 300)
        self.assertEqual(fitted[0], sections[0])

    def test_the_largest_unpinned_section_is_summarized_before_anything_is_trimmed(self):
        count_tokens = token_counter(WordTokenModel())
        sections = [("Request", "word " * 200), ("Notes", "note " * 50), ("Evidence", "fact " * 400)]
        calls = []

        def summarize(heading, text, reply_tokens):
            calls.append((heading, reply_tokens))
            return "short summary"

        fitted = condense_sections(sections, 400, count_tokens, summarize, pinned=1)

        self.assertEqual(calls, [("Evidence", 147)])
        self.assertEqual(fitted[0], sections[0])
        self.assertEqual(fitted[1], sections[1])
        self.assertEqual(fitted[2], ("Evidence", CONDENSED_MARKER + "short summary"))

    def test_trimming_is_the_fallback_when_summaries_do_not_help(self):
        count_tokens = token_counter(WordTokenModel())
        sections = [("Request", "keep me"), ("Evidence", "fact " * 1_000)]

        def failing_summarize(heading, text, reply_tokens):
            raise RuntimeError("token limit")

        fitted = condense_sections(sections, 300, count_tokens, failing_summarize, pinned=1)

        self.assertLessEqual(count_tokens(render_sections(fitted)), 300)
        self.assertEqual(fitted[0], sections[0])
        self.assertTrue(fitted[1][1].endswith(TRIMMED_MARKER))

    def test_models_without_a_tokenizer_fall_back_to_an_estimate(self):
        self.assertEqual(token_counter(object())("abcdefg"), 3)


if __name__ == "__main__":
    unittest.main()
