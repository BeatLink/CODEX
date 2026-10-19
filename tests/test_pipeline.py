import unittest
from contextlib import redirect_stdout
from io import StringIO
from unittest.mock import patch

from smartharness.pipeline import execute_pipeline


class PipelineTests(unittest.TestCase):
    def test_show_thinking_prints_each_stage_result(self):
        stage_results = iter(
            ["Task checklist", "Answer plan", "Reviewed outline", "Draft", "Critique", "Final"]
        )
        output = StringIO()

        with (
            patch("smartharness.pipeline.run_stage", side_effect=lambda *args, **kwargs: next(stage_results)),
            patch("smartharness.pipeline.run_tool_stage", return_value="Tool evidence", create=True),
            redirect_stdout(output),
        ):
            result = execute_pipeline("Answer the request", llm=object(), show_thinking=True)

        self.assertEqual(result, "Final")
        self.assertIn("[Stage 1/7: Identifying the task and constraints result]", output.getvalue())
        self.assertIn("Task checklist", output.getvalue())
        self.assertIn("[Stage 3/7 result]\nTool evidence", output.getvalue())
        self.assertIn("[Stage 6/7: Critiquing the draft result]", output.getvalue())

    def test_critique_and_revision_follow_draft(self):
        stage_results = iter(
            [
                "Task checklist",
                "Answer plan",
                "Reviewed outline",
                "Draft response",
                "Critique: add the missing constraint",
                "Revised final response",
            ]
        )
        stage_calls = []

        def fake_run_stage(llm, system_prompt, user_input, **kwargs):
            stage_calls.append((system_prompt, user_input))
            return next(stage_results)

        with (
            patch("smartharness.pipeline.run_stage", side_effect=fake_run_stage),
            patch(
                "smartharness.pipeline.run_tool_stage",
                return_value="Tool evidence",
                create=True,
            ),
        ):
            result = execute_pipeline("Answer the request", llm=object())

        self.assertEqual(result, "Revised final response")
        self.assertEqual(len(stage_calls), 6)
        self.assertIn("Draft response", stage_calls[4][1])
        self.assertIn("Critique: add the missing constraint", stage_calls[5][1])
        self.assertIn("Return only the final", stage_calls[5][0])

    def test_clarification_answer_is_passed_to_later_stages(self):
        stage_results = iter(
            [
                "Task checklist\nCLARIFICATION: Which language?",
                "Answer plan",
                "Reviewed outline",
                "Draft response",
                "No material issues",
                "Revised final response",
            ]
        )
        stage_calls = []

        def fake_run_stage(llm, system_prompt, user_input, **kwargs):
            stage_calls.append((system_prompt, user_input))
            return next(stage_results)

        def answer_clarification(question):
            self.assertEqual(question, "Which language?")
            return "Python"

        with (
            patch("smartharness.pipeline.run_stage", side_effect=fake_run_stage),
            patch("smartharness.pipeline.run_tool_stage", return_value="", create=True),
        ):
            result = execute_pipeline(
                "Write a parser",
                llm=object(),
                clarification_callback=answer_clarification,
            )

        self.assertEqual(result, "Revised final response")
        self.assertIn("User clarification:\nPython", stage_calls[1][1])
        self.assertNotIn("CLARIFICATION:", stage_calls[1][1])

    def test_source_checks_run_only_after_web_search(self):
        stage_results = iter(
            ["Task checklist", "Answer plan", "Reviewed outline", "Draft", "Critique", "Final"]
        )
        stage_calls = []

        def fake_run_stage(llm, system_prompt, user_input, **kwargs):
            stage_calls.append((system_prompt, user_input))
            return next(stage_results)

        def fake_run_tool_stage(llm, system_prompt, user_input, toolbox, **kwargs):
            toolbox.used_tools.add("web_search")
            return "Captured search evidence"

        with (
            patch("smartharness.pipeline.run_stage", side_effect=fake_run_stage),
            patch("smartharness.pipeline.run_tool_stage", side_effect=fake_run_tool_stage),
        ):
            execute_pipeline("Research this", llm=object())

        self.assertIn("captured search", stage_calls[4][0])
        self.assertIn("captured search", stage_calls[5][0])


if __name__ == "__main__":
    unittest.main()