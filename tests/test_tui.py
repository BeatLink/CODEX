import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

from textual.widgets import Button, Input, Markdown, TabPane, TextArea, Tree

from smartharness.knowledge import KnowledgeStore
from smartharness.settings import DEFAULT_SETTINGS, load_settings
from smartharness.tui import STAGE_LABELS, SmartHarnessApp


class TuiTests(unittest.IsolatedAsyncioTestCase):
    async def test_app_mounts_prompt_pipeline_and_response_controls(self):
        app = SmartHarnessApp(DEFAULT_SETTINGS, initial_prompt="Draft a plan")

        async with app.run_test(size=(120, 42)):
            self.assertEqual(app.query_one("#prompt", TextArea).text, "Draft a plan")
            self.assertEqual(len(app.query(".stage-row")), len(STAGE_LABELS))
            self.assertEqual(
                len(app.query_one("#phase-tabs").query(TabPane)), len(STAGE_LABELS) + 1
            )
            self.assertIsInstance(app.query_one("#request-pane", TabPane), TabPane)
            self.assertIsInstance(app.query_one("#output-pane", TabPane), TabPane)
            self.assertEqual(app.query_one("#workbench-tabs").active, "request-pane")
            self.assertTrue(app.query_one("#copy", Button).disabled)

            app._update_stage(STAGE_LABELS[2])
            self.assertEqual(app.query_one("#workbench-tabs").active, "output-pane")
            self.assertEqual(app.query_one("#phase-tabs").active, "stage-3")
            app._finish_run("# Completed")

            self.assertFalse(app.query_one("#copy", Button).disabled)
            self.assertEqual(app._last_answer, "# Completed")
            self.assertEqual(app.query_one("#final-output", Markdown).id, "final-output")

    async def test_phase_output_scrolls_to_latest_content(self):
        app = SmartHarnessApp(DEFAULT_SETTINGS)

        async with app.run_test(size=(100, 30)) as pilot:
            app._update_stage(STAGE_LABELS[0])
            await pilot.pause()
            app._append_stage_output(
                STAGE_LABELS[0],
                "\n\n".join(f"Output line {index}" for index in range(100)),
            )
            app._flush_stage_output()
            await pilot.pause(0.5)

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
                    app.query_one("#main-tabs").active = "background-page"
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
                app.query_one("#main-tabs").active = "knowledge-page"
                await pilot.pause()
                app._refresh_knowledge(query="Docker builds")

                self.assertIsInstance(app.query_one("#knowledge-tree", Tree), Tree)
                self.assertEqual(len(app.query_one("#knowledge-tree", Tree).root.children), 1)
                self.assertIn("supported_by", app._knowledge_graph[0]["relation"])
                self.assertTrue(app._knowledge_sources)


if __name__ == "__main__":
    unittest.main()