import unittest
from unittest.mock import patch

from textual.widgets import Button, Markdown, TabPane, TextArea

from smartharness.settings import DEFAULT_SETTINGS
from smartharness.tui import STAGE_LABELS, SmartHarnessApp


class TuiTests(unittest.IsolatedAsyncioTestCase):
    async def test_app_mounts_prompt_pipeline_and_response_controls(self):
        app = SmartHarnessApp(DEFAULT_SETTINGS, initial_prompt="Draft a plan")

        async with app.run_test(size=(120, 42)):
            self.assertEqual(app.query_one("#prompt", TextArea).text, "Draft a plan")
            self.assertEqual(len(app.query(".stage-row")), len(STAGE_LABELS))
            self.assertEqual(len(app.query(TabPane)), len(STAGE_LABELS) + 1)
            self.assertTrue(app.query_one("#copy", Button).disabled)

            app._update_stage(STAGE_LABELS[2])
            self.assertEqual(app.query_one("#phase-tabs").active, "stage-3")
            app._finish_run("# Completed")

            self.assertFalse(app.query_one("#copy", Button).disabled)
            self.assertEqual(app._last_answer, "# Completed")
            self.assertEqual(app.query_one("#final-output", Markdown).id, "final-output")

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


if __name__ == "__main__":
    unittest.main()