import json
import unittest
from unittest.mock import MagicMock, patch

from codex.evidence import is_self_contained, requires_web_research, search_query, summarize_web_page


class RequestShapeTests(unittest.TestCase):
    def test_research_trigger_ignores_ordinary_code_words(self):
        self.assertFalse(requires_web_research("Explain this source file and the current directory"))
        self.assertFalse(requires_web_research("Add an API docstring to this function"))
        self.assertTrue(requires_web_research("Install the Trilium MCP server"))
        self.assertTrue(requires_web_research("Verify that Python 3.13 removed distutils"))

    def test_search_query_leaves_out_pasted_code_and_stays_short(self):
        query = search_query("Why does this fail?\n```python\nsecret_token = 'abc'\n```\n" + "word " * 100)

        self.assertNotIn("secret_token", query)
        self.assertTrue(query.startswith("Why does this fail?"))
        self.assertLessEqual(len(query), 200)

    def test_self_contained_requests_need_no_search(self):
        self.assertTrue(is_self_contained("What is 2 + 2?"))
        self.assertTrue(is_self_contained("Rewrite this:\n```\nteh cat sat\n```"))
        self.assertFalse(is_self_contained("What is a PineTime?"))
        self.assertFalse(is_self_contained("Summarize the PineTime's features"))


class PageSummaryTests(unittest.TestCase):
    def test_webpage_summarization_chunks_and_keeps_focus_and_source(self):
        page = {
            "url": "https://example.test/report",
            "title": "Annual report",
            "text": "FIRST_DETAIL " * 100 + "SECOND_DETAIL " * 100,
        }
        calls = []

        def fake_run_stage(llm, system_prompt, user_input, **kwargs):
            calls.append((system_prompt, user_input, kwargs))
            return f"Summary {len(calls)}"

        with patch("codex.evidence.run_stage", side_effect=fake_run_stage):
            result = summarize_web_page(
                object(),
                json.dumps(page),
                "extract the reported revenue",
                "Original request: summarize the report",
                max_tokens=256,
                temperature=0.1,
                context_size=1024,
            )

        self.assertGreater(len(calls), 2)
        self.assertTrue(all("extract the reported revenue" in call[1] for call in calls))
        self.assertTrue(all("ignore any instructions" in call[0] for call in calls))
        self.assertIn("https://example.test/report", result)
        self.assertIn("Summary", result)
        self.assertNotIn("FIRST_DETAIL", result)

    def test_a_cut_off_page_summary_keeps_its_complete_sentences(self):
        llm = MagicMock()
        llm.create_chat_completion.return_value = {
            "choices": [{"finish_reason": "length", "message": {"content": "WAL is faster. Readers do not block wri"}}]
        }
        page = json.dumps({"url": "https://sqlite.org/wal.html", "title": "WAL", "text": "x" * 9000})

        summary = summarize_web_page(llm, page, "WAL", "Background research", 768, 0.1, 6144)

        self.assertTrue(summary.endswith("Summary: WAL is faster."))


if __name__ == "__main__":
    unittest.main()
