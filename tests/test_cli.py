import unittest
from pathlib import Path
from unittest.mock import patch

from daemon_harness import RunningDaemon

from smartharness.cli import main
from smartharness.client import DaemonClient
from smartharness.settings import DEFAULT_SETTINGS


class CliTests(unittest.TestCase):
    def setUp(self):
        # These tests run the pipeline in-process, as when no daemon is running.
        no_daemon = patch("smartharness.cli.connect_to_daemon", side_effect=FileNotFoundError)
        no_daemon.start()
        self.addCleanup(no_daemon.stop)

    def test_final_result_uses_markdown_renderer_in_terminal(self):
        result = "```python\nprint('hello')\n```"
        with (
            patch("smartharness.cli.load_settings", return_value=DEFAULT_SETTINGS.copy()),
            patch("smartharness.cli.execute_pipeline", return_value=result),
            patch("sys.stdin.isatty", return_value=False),
            patch("sys.stdout.isatty", return_value=True),
            patch("smartharness.cli.Console") as console,
            patch("smartharness.cli.Markdown") as markdown,
            patch("builtins.print"),
        ):
            self.assertEqual(main(["prompt"]), 0)

        markdown.assert_called_once_with(result)
        console.return_value.print.assert_called_once_with(markdown.return_value)

    def test_show_thinking_setting_and_command_line_override(self):
        for arguments, expected in ((["prompt"], True), (["--no-show-thinking", "prompt"], False)):
            with self.subTest(arguments=arguments):
                with (
                    patch("smartharness.cli.load_settings", return_value=DEFAULT_SETTINGS.copy()),
                    patch("smartharness.cli.execute_pipeline", return_value="answer") as execute_pipeline,
                    patch("sys.stdin.isatty", return_value=False),
                    patch("builtins.print"),
                ):
                    self.assertEqual(main(arguments), 0)

                self.assertIs(execute_pipeline.call_args.kwargs["show_thinking"], expected)

    def test_mode_option_overrides_the_setting(self):
        with (
            patch("smartharness.cli.load_settings", return_value=DEFAULT_SETTINGS.copy()),
            patch("smartharness.cli.execute_pipeline", return_value="answer") as execute_pipeline,
            patch("sys.stdin.isatty", return_value=False),
            patch("builtins.print"),
        ):
            self.assertEqual(main(["--mode", "draft", "prompt"]), 0)

        self.assertEqual(execute_pipeline.call_args.kwargs["mode"], "draft")

    def test_tui_subcommand_opens_interface_with_initial_prompt(self):
        with (
            patch("smartharness.cli.load_settings", return_value=DEFAULT_SETTINGS.copy()),
            patch("smartharness.tui.SmartHarnessApp") as app,
            patch("sys.stdin.isatty", return_value=False),
        ):
            self.assertEqual(main(["tui", "draft", "a", "plan"]), 0)

            app.assert_called_once_with(
                DEFAULT_SETTINGS.copy(),
                initial_prompt="draft a plan",
                settings_path=str(Path.cwd() / "settings.json"),
                settings_overrides={},
            )
        app.return_value.run.assert_called_once_with()

    def test_prompt_runs_on_a_running_daemon_with_resolved_paths(self):
        daemon = RunningDaemon(DEFAULT_SETTINGS.copy())
        self.addCleanup(daemon.stop)

        def connect(on_event, start):
            self.assertFalse(start)
            client = DaemonClient(daemon.socket_path, on_event)
            client.connect()
            return client

        with (
            patch("smartharness.cli.load_settings", return_value=DEFAULT_SETTINGS.copy()),
            patch("smartharness.cli.connect_to_daemon", side_effect=connect),
            patch("smartharness.cli.execute_pipeline") as local_pipeline,
            patch("smartharness.daemon.execute_pipeline", return_value="daemon answer") as daemon_pipeline,
            patch("sys.stdin.isatty", return_value=False),
            patch("sys.stdout.isatty", return_value=False),
            patch("builtins.print") as printed,
        ):
            self.assertEqual(main(["--max-tokens", "512", "prompt"]), 0)

        local_pipeline.assert_not_called()
        printed.assert_called_with("daemon answer")
        options = daemon_pipeline.call_args.kwargs
        self.assertEqual(options["max_tokens"], 512)
        self.assertEqual(options["filesystem_root"], str(Path.cwd()))
        self.assertIsNone(options["clarification_callback"])


if __name__ == "__main__":
    unittest.main()
