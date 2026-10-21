import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from daemon_harness import RunningDaemon

from smartharness.knowledge import KnowledgeStore
from smartharness.settings import DEFAULT_SETTINGS
from smartharness.stages import STAGE_LABELS

try:
    import gi

    gi.require_version("Gdk", "4.0")
    gi.require_version("Gtk", "4.0")
    from gi.repository import Gdk, Gio, GLib, Gtk

    from smartharness.gtk_app import LINK_TAG_PREFIX, SmartHarnessWindow, add_markdown_tags, render_markdown

    # init_check reports success even without a display, so the display itself is checked.
    DISPLAY_AVAILABLE = Gtk.init_check() and Gdk.Display.get_default() is not None
except (ImportError, ValueError):
    DISPLAY_AVAILABLE = False


def wait_until(condition, timeout=5):
    deadline = time.monotonic() + timeout
    context = GLib.MainContext.default()
    while time.monotonic() < deadline:
        while context.pending():
            context.iteration(False)
        if condition():
            return
        time.sleep(0.01)
    raise AssertionError("condition was not met in time")


@unittest.skipUnless(DISPLAY_AVAILABLE, "GTK 4 needs a display")
class MarkdownTests(unittest.TestCase):
    def test_markdown_is_shown_with_styles_instead_of_markers(self):
        buffer = Gtk.TextBuffer()
        add_markdown_tags(buffer)

        render_markdown(buffer, "# Title\n\nUse **bold** and `code`.\n\n- item\n\n```\nx = 1\n```")

        text = buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), False)
        self.assertEqual(text, "Title\n\nUse bold and code.\n\n• item\n\nx = 1\n")
        bold_start = buffer.get_iter_at_offset(text.index("bold"))
        self.assertIn("bold", [tag.props.name for tag in bold_start.get_tags()])


    def test_web_links_carry_their_url_and_other_links_stay_text(self):
        buffer = Gtk.TextBuffer()
        add_markdown_tags(buffer)

        render_markdown(buffer, "See [guide](https://example.test/guide) and [secret](file:///etc/passwd).")

        text = buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), False)
        self.assertEqual(text, "See guide and secret (file:///etc/passwd).\n")
        guide_tags = [tag.props.name for tag in buffer.get_iter_at_offset(text.index("guide")).get_tags()]
        self.assertEqual(guide_tags, [LINK_TAG_PREFIX + "https://example.test/guide"])
        self.assertEqual(buffer.get_iter_at_offset(text.index("secret")).get_tags(), [])


@unittest.skipUnless(DISPLAY_AVAILABLE, "GTK 4 needs a display")
class WindowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # An application registers on the session bus once, so every test shares it.
        cls.application = Gtk.Application(
            application_id="org.smartharness.Tests", flags=Gio.ApplicationFlags.NON_UNIQUE
        )
        cls.application.register(None)

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.settings = DEFAULT_SETTINGS.copy()
        self.settings["knowledge_db_path"] = str(Path(directory.name) / "knowledge.db")
        self.settings["background_research_enabled"] = False
        # Most tests drive the eight-stage view, so the window starts in pipeline mode.
        self.settings["runner"] = "pipeline"
        self.daemon = RunningDaemon(self.settings)
        self.addCleanup(self.daemon.stop)
        self.window = SmartHarnessWindow(self.application, self.settings, client=self.daemon.client())
        self.addCleanup(self.window.destroy)
        wait_until(lambda: self.window.status.get_label() == "Ready")

    def test_run_shows_stage_progress_and_the_final_answer(self):
        def routed_pipeline(prompt, **kwargs):
            kwargs["progress_callback"](STAGE_LABELS[0])
            kwargs["stage_output_callback"](STAGE_LABELS[0], "Phase output")
            kwargs["progress_callback"]("Skipped: " + STAGE_LABELS[1])
            return "# Done"

        self.window.prompt.get_buffer().set_text("Draft a plan")
        with patch("smartharness.daemon.execute_pipeline", side_effect=routed_pipeline):
            self.window.run_button.emit("clicked")
            wait_until(lambda: self.window.status.get_label() == "Complete")

        self.assertEqual(self.window._last_answer, "# Done")
        self.assertEqual(self.window.final_output.text, "Done\n")
        self.assertEqual(self.window.stage_outputs[0].text, "Phase output")
        self.assertEqual(self.window.stage_states[1].get_label(), "SKIP")
        self.assertEqual(self.window.phase_pages.get_visible_child_name(), "final")
        self.assertTrue(self.window.copy_button.get_sensitive())

    def test_selected_mode_is_passed_to_the_run_and_shown_in_the_status(self):
        statuses = []

        def routed_pipeline(prompt, **kwargs):
            kwargs["progress_callback"]("Mode: " + kwargs["mode"])
            kwargs["progress_callback"](STAGE_LABELS[2])
            return "Done"

        def record_status(*_arguments):
            statuses.append(self.window.status.get_label())

        self.window.status.connect("notify::label", record_status)
        self.window.mode_dropdown.set_selected(3)
        self.window.prompt.get_buffer().set_text("Fix the parser")
        with patch("smartharness.daemon.execute_pipeline", side_effect=routed_pipeline):
            self.window.run_button.emit("clicked")
            wait_until(lambda: self.window.status.get_label() == "Complete")

        self.assertIn("Execute mode · Stage 3 of 8", statuses)

    def test_tree_run_shows_the_task_tree_and_each_step(self):
        def fake_task_tree(prompt, **kwargs):
            kwargs["tree_callback"]([
                {"id": "1", "prompt": "Compare two designs", "status": "done"},
                {
                    "id": "1.1", "prompt": "Describe design A", "status": "unverified", "approach": "answer",
                    "deliverable": "A paragraph on A", "depends_on": [], "note": "", "result": "Design A is simple.",
                },
            ])
            kwargs["progress_callback"]("Task 1.1 · Writing")
            kwargs["stage_output_callback"]("Task 1.1 · Writing", "Design A is simple.")
            return "Pick A."

        self.window.tree_switch.set_active(True)
        self.window.prompt.get_buffer().set_text("Compare two designs")
        with patch("smartharness.daemon.execute_task_tree", side_effect=fake_task_tree):
            self.window.run_button.emit("clicked")
            wait_until(lambda: self.window.status.get_label() == "Complete")

        rows = {row.page_name: row for row in self.window._phase_rows()}
        self.assertFalse(rows["phase-1"].get_visible())
        self.assertTrue(rows["steps"].get_visible())
        self.assertEqual(
            [row.get_child().get_label() for row in self.window._task_rows()],
            ["DONE  1 Compare two designs", "WARN    1.1 Describe design A"],
        )
        self.window.task_list.select_row(self.window._task_rows()[1])
        self.assertEqual(self.window.phase_pages.get_visible_child_name(), "task")
        self.assertIn("Task 1.1", self.window.task_detail.text)
        self.assertIn("Deliverable: A paragraph on A", self.window.task_detail.text)
        self.assertIn("State: unverified, answer", self.window.task_detail.text)
        self.assertIn("Design A is simple.", self.window.task_detail.text)
        self.window.task_list.select_row(self.window._task_rows()[1])
        self.window._show_task_tree(self.window._task_nodes)
        self.assertEqual(self.window.task_list.get_selected_row().task_id, "1.1")
        self.assertEqual(self.window.steps_output.text, "▸ Task 1.1 · Writing\n\nDesign A is simple.")
        self.assertEqual(self.window._last_answer, "Pick A.")

    def test_an_unfinished_tree_run_can_be_resumed_or_discarded(self):
        store = KnowledgeStore(self.settings["knowledge_db_path"])
        for prompt in ("Plan the trip", "Sort the photos"):
            run_id = store.start_task_run(prompt, {"mode": "auto"})
            store.save_task_run(run_id, {"nodes": []}, 2, 5)
            store.set_task_run_status(run_id, "stopped")
        self.window._call_daemon("status", self.window._show_daemon_status)
        wait_until(lambda: self.window.resume_bar.get_visible())
        self.assertIn("Sort the photos (2 of 5 tasks done)", self.window.resume_label.get_label())

        self.window.discard_button.emit("clicked")
        wait_until(lambda: "Plan the trip" in self.window.resume_label.get_label())
        with patch("smartharness.daemon.execute_task_tree", return_value="Trip planned.") as task_tree:
            self.window.resume_button.emit("clicked")
            wait_until(lambda: self.window.status.get_label() == "Complete")

        self.assertEqual(self.window._last_answer, "Trip planned.")
        self.assertEqual(task_tree.call_args.kwargs["resume_run_id"], 1)
        self.assertEqual(self.window._prompt_text(), "Plan the trip")

    def test_failed_run_marks_the_failing_stage(self):
        def failing_pipeline(prompt, **kwargs):
            kwargs["progress_callback"](STAGE_LABELS[3])
            raise RuntimeError("tool exploded")

        self.window.prompt.get_buffer().set_text("Draft a plan")
        with patch("smartharness.daemon.execute_pipeline", side_effect=failing_pipeline):
            self.window.run_button.emit("clicked")
            wait_until(lambda: self.window.status.get_label() == "Run failed")

        self.assertEqual(self.window.stage_states[3].get_label(), "FAIL")
        self.assertEqual(self.window.stage_states[2].get_label(), "DONE")
        self.assertTrue(self.window.run_button.get_sensitive())

    def test_auto_size_fills_the_context_and_token_fields(self):
        from smartharness.auto_size import SizeChoice

        with patch("smartharness.daemon.auto_size", return_value=SizeChoice(14336, 3584, 1792, "Tiny")):
            self.window._auto_size()
            wait_until(lambda: self.window.number_fields["context_size"].get_value_as_int() == 14336)

        self.assertEqual(self.window.number_fields["max_tokens"].get_value_as_int(), 3584)
        self.assertEqual(self.window.number_fields["background_max_tokens"].get_value_as_int(), 1792)
        self.assertEqual(self.window.number_fields["background_context_size"].get_value_as_int(), 0)

    def test_saving_options_writes_the_daemon_settings_file(self):
        self.window.number_fields["max_tool_calls"].set_value(7)
        self.window.switches["allow_file_writes"].set_active(True)
        self.window.mcp_servers.get_buffer().set_text(
            '[{"name": "docs", "transport": "stdio", "command": "docs-mcp-server", "allowed_tools": ["search_docs"]}]'
        )

        self.window._save_settings()
        settings_path = self.daemon.harness.settings_path
        wait_until(lambda: settings_path.exists() and '"max_tool_calls": 7' in settings_path.read_text())

        saved = settings_path.read_text()
        self.assertIn('"max_tool_calls": 7', saved)
        self.assertIn('"name": "docs"', saved)
        self.assertIn('"allow_file_writes": true', saved)


if __name__ == "__main__":
    unittest.main()
