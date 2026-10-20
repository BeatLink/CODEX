import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from smartharness.tools import Toolbox


class ToolboxTests(unittest.TestCase):
    def test_run_tests_is_opt_in_and_bounded_to_unittest_discovery(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            tests = root / "tests"
            tests.mkdir()
            (tests / "test_sample.py").write_text(
                "import unittest\n\n"
                "class SampleTests(unittest.TestCase):\n"
                "    def test_passes(self):\n"
                "        self.assertTrue(True)\n",
                encoding="utf-8",
            )

            disabled = Toolbox(root)
            self.assertNotIn(
                "run_tests",
                {tool["function"]["name"] for tool in disabled.tool_definitions},
            )
            self.assertIn("unknown tool", disabled.call("run_tests", {}))

            enabled = Toolbox(root, enable_test_execution=True)
            result = enabled.call("run_tests", {})

        self.assertIn("Tests passed", result)
        self.assertIn("Ran 1 test", result)

    def test_limits_must_be_integers(self):
        with self.assertRaisesRegex(ValueError, "max_search_results"):
            Toolbox(".", max_search_results=True)

    def test_filesystem_tools_read_write_and_list_within_root(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            toolbox = Toolbox(temp_dir)
            write_result = toolbox.call(
                "write_file", {"path": "notes/answer.txt", "content": "hello"}
            )

            self.assertIn("Wrote", write_result)
            self.assertEqual(
                toolbox.call("read_file", {"path": "notes/answer.txt"}), "hello"
            )
            entries = json.loads(
                toolbox.call("list_directory", {"path": "notes"})
            )
            self.assertEqual(entries, [{"name": "answer.txt", "type": "file"}])

    def test_filesystem_tools_reject_paths_outside_root(self):
        with tempfile.TemporaryDirectory() as temp_dir, tempfile.TemporaryDirectory() as outside:
            root = Path(temp_dir)
            toolbox = Toolbox(root)
            traversal = toolbox.call("read_file", {"path": "../outside.txt"})
            self.assertIn("escapes", traversal)

            outside_link = root / "outside-link"
            outside_link.symlink_to(Path(outside), target_is_directory=True)
            symlink = toolbox.call(
                "write_file",
                {"path": "outside-link/unsafe.txt", "content": "blocked"},
            )
            self.assertIn("escapes", symlink)
            self.assertFalse((Path(outside) / "unsafe.txt").exists())

            secret = toolbox.call("read_file", {"path": ".env"})
            self.assertIn("credential or secret", secret)

    def test_search_results_are_bounded_by_settings(self):
        observed = {}
        persisted = []

        class FakeDDGS:
            def text(self, query, max_results):
                observed["query"] = query
                observed["max_results"] = max_results
                return [{"title": "Result", "href": "https://example.test", "body": "Snippet"}]

        fake_module = types.SimpleNamespace(DDGS=FakeDDGS)
        with patch.dict(sys.modules, {"ddgs": fake_module}):
            results = Toolbox(
                ".",
                max_search_results=2,
                search_callback=lambda query, items: persisted.append((query, items)),
            ).call(
                "web_search", {"query": "local models", "max_results": 8}
            )

        self.assertEqual(json.loads(results)[0]["title"], "Result")
        self.assertEqual(observed, {"query": "local models", "max_results": 2})
        self.assertEqual(persisted[0][0], "local models")
        self.assertEqual(persisted[0][1][0]["snippet"], "Snippet")


if __name__ == "__main__":
    unittest.main()
