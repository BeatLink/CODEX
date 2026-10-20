import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from textual.widgets import Button, Checkbox, Input, Markdown, TabbedContent, TabPane, TextArea, Tree

from smartharness.knowledge import KnowledgeStore
from smartharness.settings import DEFAULT_SETTINGS, load_settings
from smartharness.tui import STAGE_LABELS, SmartHarnessApp


class TuiTests(unittest.IsolatedAsyncioTestCase):
    async def test_app_mounts_prompt_pipeline_and_response_controls(self):
        app = SmartHarnessApp(DEFAULT_SETTINGS, initial_prompt="Draft a plan")

        async with app.run_test(size=(120, 42)):
            self.assertEqual(app.query_one("#prompt", TextArea).text, "Draft a plan")
            self.assertTrue(app.query_one("#model-path", TextArea).soft_wrap)
            self.assertEqual(len(app.query(".stage-row")), len(STAGE_LABELS))
            self.assertEqual(
                len(app.query_one("#phase-tabs").query(TabPane)), len(STAGE_LABELS) + 1
            )
            self.assertIsInstance(app.query_one("#request-pane", TabPane), TabPane)
            self.assertIsInstance(app.query_one("#output-pane", TabPane), TabPane)
            self.assertEqual(app.query_one("#workbench-tabs").active, "request-pane")
            self.assertTrue(app.query_one("#copy", Button).disabled)

            app._update_stage(STAGE_LABELS[2])
            self.assertEqual(app.query_one("#phase-tabs").active, "phase-3")
            self.assertIn("NOW", str(app.query_one("#stage-row-3").render()))
            app._finish_run("# Completed")

            self.assertFalse(app.query_one("#copy", Button).disabled)
            self.assertEqual(app._last_answer, "# Completed")
            self.assertEqual(app.query_one("#final-output", Markdown).id, "final-output")

    async def test_phase_output_scrolls_to_latest_content(self):
        app = SmartHarnessApp(DEFAULT_SETTINGS)

        async with app.run_test(size=(100, 30)) as pilot:
            await pilot.pause()
            app.query_one("#workbench-tabs", TabbedContent).active = "output-pane"
            app._update_stage(STAGE_LABELS[0])
            await pilot.pause()
            app._append_stage_output(
                STAGE_LABELS[0],
                "\n\n".join(f"Output line {index}" for index in range(100)),
            )
            app._flush_stage_output()
            await pilot.pause(0.5)

            app._append_stage_output(STAGE_LABELS[0], "\n\nOne more line")
            app._flush_stage_output()
            await pilot.pause(0.5)

            self.assertTrue(app._stage_output_buffers[0].endswith("One more line"))
            scroll = app.query_one("#stage-output-1", Markdown).parent
            self.assertGreater(scroll.max_scroll_y, 0)
            self.assertEqual(scroll.scroll_y, scroll.max_scroll_y)

    async def test_clear_resets_prompt_and_completed_answer(self):
        app = SmartHarnessApp(DEFAULT_SETTINGS, initial_prompt="Draft a plan")

        async with app.run_test(size=(120, 42)) as pilot:
            app._finish_run("Completed")
            await pilot.click("#clear")

            self.assertEqual(app.query_one("#prompt", TextArea).text, "")
            self.assertTrue(app.query_one("#copy", Button).disabled)
            self.assertEqual(app._last_answer, "")

    async def test_run_executes_in_worker_and_updates_stage_progress(self):
        app = SmartHarnessApp(DEFAULT_SETTINGS, initial_prompt="Draft a plan")

        def fake_execute_pipeline(prompt, **kwargs):
            self.assertEqual(prompt, "Draft a plan")
            kwargs["progress_callback"](STAGE_LABELS[0])
            kwargs["stage_output_callback"](STAGE_LABELS[0], "Phase output")
            return "Worker response"

        with patch("smartharness.tui.execute_pipeline", side_effect=fake_execute_pipeline):
            async with app.run_test(size=(120, 42)) as pilot:
                app._start_run()
                for _ in range(20):
                    await pilot.pause(0.05)
                    if not app._request_running:
                        break

                self.assertFalse(app._request_running)
                self.assertEqual(app._last_answer, "Worker response")
                self.assertFalse(app.query_one("#copy", Button).disabled)
                self.assertEqual(app._stage_output_buffers[0], "Phase output")
                self.assertEqual(app.query_one("#phase-tabs").active, "final")

    async def test_background_page_queues_topics_and_saves_worker_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = DEFAULT_SETTINGS.copy()
            settings["knowledge_db_path"] = str(Path(directory) / "knowledge.db")
            settings["background_research_enabled"] = False
            settings_path = Path(directory) / "settings.json"
            app = SmartHarnessApp(settings, settings_path=settings_path)

            with patch("smartharness.tui.research_one_topic", return_value=False) as research:
                async with app.run_test(size=(140, 48)) as pilot:
                    await pilot.click("#--content-tab-background-page")
                    await pilot.pause()
                    app.query_one("#research-topic", Input).value = "Local model RAG"
                    app.query_one("#research-priority", Input).value = "4"
                    await pilot.click("#research-now")
                    for _ in range(20):
                        await pilot.pause(0.05)
                        if research.called:
                            break

                    job = KnowledgeStore(settings["knowledge_db_path"]).queue_status()[0]
                    self.assertEqual((job["topic"], job["status"]), ("Local model RAG", "pending"))
                    research.assert_called_once()
                    app.query_one("#background-poll-seconds", Input).value = "12"
                    app._save_settings()

                    saved = load_settings(settings_path)
                    self.assertEqual(saved["background_poll_interval_seconds"], 12)
                    self.assertFalse(saved["background_research_enabled"])

    async def test_options_page_saves_folder_access_and_tool_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = DEFAULT_SETTINGS.copy()
            settings["knowledge_db_path"] = str(Path(directory) / "knowledge.db")
            settings["background_research_enabled"] = False
            settings_path = Path(directory) / "settings.json"
            app = SmartHarnessApp(settings, settings_path=settings_path)

            async with app.run_test(size=(140, 48)) as pilot:
                await pilot.click("#--content-tab-options-page")
                await pilot.pause()
                self.assertFalse(app.query_one("#allow-file-writes", Checkbox).value)
                app.query_one("#filesystem-root", TextArea).text = directory
                app.query_one("#allow-file-writes", Checkbox).value = True
                app.query_one("#max-tool-calls", Input).value = "7"
                app.query_one("#max-search-results", Input).value = "3"
                app.query_one("#save-options", Button).press()
                await pilot.pause()

                saved = load_settings(settings_path)
                self.assertEqual(saved["filesystem_root"], directory)
                self.assertTrue(saved["allow_file_writes"])
                self.assertEqual((saved["max_tool_calls"], saved["max_search_results"]), (7, 3))

    async def test_knowledge_page_browses_topics_sources_and_graph(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = DEFAULT_SETTINGS.copy()
            settings["knowledge_db_path"] = str(Path(directory) / "knowledge.db")
            settings["background_research_enabled"] = False
            store = KnowledgeStore(settings["knowledge_db_path"])
            store.store_search_results(
                "Docker builds",
                [{"title": "Docker guide", "url": "https://example.test/docker", "snippet": "Multi-stage Docker builds."}],
                topic="Docker",
            )
            app = SmartHarnessApp(settings)

            async with app.run_test(size=(140, 48)) as pilot:
                await pilot.click("#--content-tab-knowledge-page")
                app.query_one("#knowledge-search", Input).value = "Docker builds"
                app.query_one("#knowledge-search", Input).focus()
                await pilot.press("enter")
                await wait_until(pilot, lambda: app._knowledge_sources)

                tree = app.query_one("#knowledge-tree", Tree)
                self.assertEqual(len(tree.root.children), 1)
                self.assertIn("supported_by", app._knowledge_graph[0]["relation"])
                self.assertEqual(app._knowledge_query, "Docker builds")

                topic_node = tree.root.children[0]
                tree.select_node(topic_node)
                await wait_until(pilot, lambda: app._knowledge_topic_id == topic_node.data)
                await pilot.pause(0.2)
                self.assertIs(tree.root.children[0], topic_node)
                self.assertEqual(app._knowledge_query, "")

    async def test_background_refresh_keeps_the_current_search(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = DEFAULT_SETTINGS.copy()
            settings["knowledge_db_path"] = str(Path(directory) / "knowledge.db")
            settings["background_research_enabled"] = False
            store = KnowledgeStore(settings["knowledge_db_path"])
            for query, title in (("Docker builds", "Docker guide"), ("Nix flakes", "Flake guide")):
                store.store_search_results(
                    query,
                    [{"title": title, "url": f"https://example.test/{title}", "snippet": query}],
                    topic=query,
                )
            app = SmartHarnessApp(settings)

            async with app.run_test(size=(140, 48)) as pilot:
                app._search_knowledge("Docker builds")
                await wait_until(pilot, lambda: len(app._knowledge_sources) == 1)
                app._refresh_knowledge()
                await pilot.pause(0.2)

                self.assertEqual([source["title"] for source in app._knowledge_sources], ["Docker guide"])

    async def test_cancel_stops_a_running_request(self):
        app = SmartHarnessApp(DEFAULT_SETTINGS, initial_prompt="Draft a plan")
        started = threading.Event()

        def endless_pipeline(prompt, **kwargs):
            kwargs["progress_callback"](STAGE_LABELS[1])
            while True:
                started.set()
                kwargs["stage_output_callback"](STAGE_LABELS[1], "token ")
                time.sleep(0.01)

        with patch("smartharness.tui.execute_pipeline", side_effect=endless_pipeline):
            async with app.run_test(size=(120, 42)) as pilot:
                app._start_run()
                await wait_until(pilot, started.is_set)
                self.assertTrue(app.query_one("#clear", Button).disabled)
                self.assertFalse(app.query_one("#cancel", Button).disabled)

                app.query_one("#cancel", Button).press()
                await wait_until(pilot, lambda: not app._request_running)

                self.assertEqual(str(app.query_one("#status").render()), "Cancelled")
                self.assertIn("STOP", str(app.query_one("#stage-row-2").render()))
                self.assertFalse(app.query_one("#run", Button).disabled)
                self.assertTrue(app.query_one("#cancel", Button).disabled)

    async def test_failed_run_marks_the_failing_stage(self):
        app = SmartHarnessApp(DEFAULT_SETTINGS, initial_prompt="Draft a plan")

        def failing_pipeline(prompt, **kwargs):
            kwargs["progress_callback"](STAGE_LABELS[3])
            raise RuntimeError("tool exploded")

        with patch("smartharness.tui.execute_pipeline", side_effect=failing_pipeline):
            async with app.run_test(size=(120, 42)) as pilot:
                app._start_run()
                await wait_until(pilot, lambda: not app._request_running)

                self.assertIn("FAIL", str(app.query_one("#stage-row-4").render()))
                self.assertIn("DONE", str(app.query_one("#stage-row-3").render()))

    async def test_choosing_a_phase_tab_stops_following_stages(self):
        app = SmartHarnessApp(DEFAULT_SETTINGS)

        async with app.run_test(size=(120, 42)) as pilot:
            app._set_running(True)
            app._update_stage(STAGE_LABELS[0])
            await pilot.pause()
            app.query_one("#phase-tabs", TabbedContent).active = "phase-1"
            app._update_stage(STAGE_LABELS[1])
            await pilot.pause()
            self.assertEqual(app.query_one("#phase-tabs").active, "phase-2")

            app.query_one("#phase-tabs", TabbedContent).active = "final"
            await pilot.pause()
            app._update_stage(STAGE_LABELS[2])
            await pilot.pause()

            self.assertEqual(app.query_one("#phase-tabs").active, "final")

    async def test_ctrl_r_runs_the_prompt(self):
        app = SmartHarnessApp(DEFAULT_SETTINGS, initial_prompt="Draft a plan")

        with patch("smartharness.tui.execute_pipeline", return_value="Shortcut response"):
            async with app.run_test(size=(120, 42)) as pilot:
                await pilot.press("ctrl+r")
                await wait_until(pilot, lambda: app._last_answer)

                self.assertEqual(app._last_answer, "Shortcut response")


async def wait_until(pilot, condition, attempts=40):
    for _ in range(attempts):
        if condition():
            return
        await pilot.pause(0.05)
    raise AssertionError("condition was not met in time")


if __name__ == "__main__":
    unittest.main()