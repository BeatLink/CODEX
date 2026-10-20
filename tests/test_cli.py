import unittest
from pathlib import Path
from unittest.mock import patch

from smartharness.cli import main
from smartharness.settings import DEFAULT_SETTINGS


class CliTests(unittest.TestCase):
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
            )
        app.return_value.run.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
