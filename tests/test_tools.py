import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from codex.tools import Toolbox


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
            toolbox = Toolbox(temp_dir, allow_file_writes=True)
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

    def test_file_access_is_read_only_by_default(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            toolbox = Toolbox(temp_dir)
            result = toolbox.call("write_file", {"path": "notes.txt", "content": "hello"})

            self.assertIn("read-only", result)
            self.assertFalse((Path(temp_dir) / "notes.txt").exists())
            self.assertNotIn(
                "write_file",
                {tool["function"]["name"] for tool in toolbox.tool_definitions},
            )

    def test_file_writes_and_test_runs_are_logged_without_file_content(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            toolbox = Toolbox(temp_dir)
            toolbox.call("write_file", {"path": "notes.txt", "content": "hello"})
            toolbox.call("read_file", {"path": "notes.txt"})

            self.assertEqual(len(toolbox.action_log), 1)
            name, arguments, result = toolbox.action_log[0]
            self.assertEqual((name, arguments), ("write_file", {"path": "notes.txt"}))
            self.assertIn("read-only", result)

    def test_root_and_absolute_paths_inside_root_are_accepted(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "readme.txt").write_text("hi", encoding="utf-8")
            toolbox = Toolbox(root)

            for path in ("", ".", "./", str(root)):
                entries = json.loads(toolbox.call("list_directory", {"path": path}))
                self.assertEqual(entries, [{"name": "readme.txt", "type": "file"}])
            self.assertEqual(
                toolbox.call("read_file", {"path": str(root / "readme.txt")}), "hi"
            )
            self.assertIn("list_directory", toolbox.call("read_file", {"path": "."}))
            self.assertIn("escapes", toolbox.call("read_file", {"path": "/etc/hostname"}))

    def test_filesystem_tools_reject_paths_outside_root(self):
        with tempfile.TemporaryDirectory() as temp_dir, tempfile.TemporaryDirectory() as outside:
            root = Path(temp_dir)
            toolbox = Toolbox(root, allow_file_writes=True)
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

    def test_web_fetch_extracts_readable_html_with_page_focus(self):
        class FakeHeaders:
            def get_content_type(self):
                return "text/html"

            def get_content_charset(self):
                return "utf-8"

        class FakeResponse:
            headers = FakeHeaders()

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return None

            def geturl(self):
                return "https://example.test/article"

            def read(self, limit):
                return (
                    b"<html><head><title>Research title</title>"
                    b"<style>hidden style</style></head><body>"
                    b"<main><p>Relevant page content.</p>"
                    b"<script>hidden script</script></main></body></html>"
                )

        class FakeOpener:
            def open(self, request, timeout):
                self.request = request
                self.timeout = timeout
                return FakeResponse()

        opener = FakeOpener()
        with (
            patch(
                "codex.tools.socket.getaddrinfo",
                return_value=[(2, 1, 6, "", ("93.184.216.34", 443))],
            ),
            patch("codex.tools.build_opener", return_value=opener),
        ):
            result = Toolbox(".").call(
                "web_fetch",
                {"url": "https://example.test/article", "focus": "dates and findings"},
            )

        page = json.loads(result)
        self.assertEqual(page["title"], "Research title")
        self.assertEqual(page["focus"], "dates and findings")
        self.assertIn("Relevant page content.", page["text"])
        self.assertNotIn("hidden style", page["text"])
        self.assertNotIn("hidden script", page["text"])
        self.assertEqual(opener.timeout, 15)

    def test_web_fetch_rejects_private_hosts(self):
        with patch(
            "codex.tools.socket.getaddrinfo",
            return_value=[(2, 1, 6, "", ("127.0.0.1", 443))],
        ):
            result = Toolbox(".").call(
                "web_fetch", {"url": "https://example.test/private"}
            )

        self.assertIn("public IP addresses", result)


if __name__ == "__main__":
    unittest.main()
