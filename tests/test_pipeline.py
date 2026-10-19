import unittest
from contextlib import redirect_stdout
from io import StringIO
from unittest.mock import patch

from smartharness.pipeline import execute_pipeline, run_stage


class PipelineTests(unittest.TestCase):
    def test_show_thinking_prints_each_stage_result(self):
        stage_results = iter(
            ["Task checklist", "Answer plan", "Reviewed outline", "Draft", "Critique", "Final"]
        )
        output = StringIO()

        def fake_run_stage(llm, system_prompt, user_input, **kwargs):
            result = next(stage_results)
            if kwargs.get("on_token"):
                kwargs["on_token"](result)
            return result

        def fake_run_tool_stage(llm, system_prompt, user_input, toolbox, **kwargs):
            if kwargs.get("on_token"):
                kwargs["on_token"]("Tool evidence")
            return "Tool evidence"

        with (
            patch("smartharness.pipeline.run_stage", side_effect=fake_run_stage),
            patch("smartharness.pipeline.run_tool_stage", side_effect=fake_run_tool_stage),
            redirect_stdout(output),
        ):
            result = execute_pipeline("Answer the request", llm=object(), show_thinking=True)

        self.assertEqual(result, "Final")
        self.assertIn("[Stage 1/7: Identifying the task and constraints result] Task checklist", output.getvalue())
        self.assertIn("Task checklist", output.getvalue())
        self.assertIn("[Stage 3/7: Searching and using local files when needed result] Tool evidence", output.getvalue())
        self.assertIn("[Stage 6/7: Critiquing the draft result] Critique", output.getvalue())

    def test_progress_callback_reports_stages_without_writing_to_stdout(self):
        stage_results = iter(
            ["Task checklist", "Answer plan", "Reviewed outline", "Draft", "Critique", "Final"]
        )
        output = StringIO()
        progress = []

        with (
            patch(
                "smartharness.pipeline.run_stage",
                side_effect=lambda *args, **kwargs: next(stage_results),
            ),
            patch("smartharness.pipeline.run_tool_stage", return_value="Tool evidence"),
            redirect_stdout(output),
        ):
            result = execute_pipeline(
                "Answer the request",
                llm=object(),
                progress_callback=progress.append,
            )

        self.assertEqual(result, "Final")
        self.assertEqual(len(progress), 7)
        self.assertTrue(progress[0].startswith("Stage 1/7:"))
        self.assertTrue(progress[-1].startswith("Stage 7/7:"))
        self.assertEqual(output.getvalue(), "")

    def test_stage_output_callback_streams_tokens_with_stage_labels(self):
        stage_results = iter(
            ["Task checklist", "Answer plan", "Reviewed outline", "Draft", "Critique", "Final"]
        )
        output = StringIO()
        streamed = []

        def fake_run_stage(llm, system_prompt, user_input, **kwargs):
            kwargs["on_token"]("stage-token")
            return next(stage_results)

        def fake_run_tool_stage(llm, system_prompt, user_input, toolbox, **kwargs):
            kwargs["on_token"]("tool-token")
            return "Tool evidence"

        with (
            patch("smartharness.pipeline.run_stage", side_effect=fake_run_stage),
            patch("smartharness.pipeline.run_tool_stage", side_effect=fake_run_tool_stage),
            redirect_stdout(output),
        ):
            result = execute_pipeline(
                "Answer the request",
                llm=object(),
                progress_callback=lambda label: None,
                stage_output_callback=lambda label, token: streamed.append((label, token)),
            )

        self.assertEqual(result, "Final")
        self.assertEqual([label for label, _ in streamed], [
            "Stage 1/7: Identifying the task and constraints",
            "Stage 2/7: Preparing an answer plan",
            "Stage 3/7: Searching and using local files when needed",
            "Stage 4/7: Reviewing the plan and tool evidence",
            "Stage 5/7: Drafting the response",
            "Stage 6/7: Critiquing the draft",
            "Stage 7/7: Revising the response",
        ])
        self.assertEqual(streamed[2][1], "tool-token")
        self.assertEqual(output.getvalue(), "")

    def test_run_stage_streams_and_reassembles_content(self):
        class StreamingModel:
            def __init__(self):
                self.request = None

            def create_chat_completion(self, **request):
                self.request = request
                return iter(
                    [
                        {"choices": [{"delta": {"content": "First "}, "finish_reason": None}]},
                        {"choices": [{"delta": {"content": "second"}, "finish_reason": "stop"}]},
                    ]
                )

        llm = StreamingModel()
        streamed = []

        result = run_stage(llm, "System", "Input", on_token=streamed.append)

        self.assertEqual(result, "First second")
        self.assertEqual(streamed, ["First ", "second"])
        self.assertTrue(llm.request["stream"])

    def test_run_stage_omits_streaming_when_disabled(self):
        class NonStreamingModel:
            def __init__(self):
                self.request = None

            def create_chat_completion(self, **request):
                self.request = request
                return {
                    "choices": [
                        {"finish_reason": "stop", "message": {"content": "Complete"}}
                    ]
                }

        llm = NonStreamingModel()
        result = run_stage(llm, "System", "Input")

        self.assertEqual(result, "Complete")
        self.assertNotIn("stream", llm.request)

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
        self.assertIn("every distinct requirement", stage_calls[4][0])
        self.assertIn("appropriate level of detail", stage_calls[5][0])
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

    def test_source_checks_apply_after_automatic_web_search(self):
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

        def fake_search(toolbox, name, arguments):
            toolbox.used_tools.add(name)
            return "Captured automatic search"

        with (
            patch("smartharness.pipeline.run_stage", side_effect=fake_run_stage),
            patch("smartharness.pipeline.run_tool_stage", side_effect=fake_run_tool_stage),
            patch("smartharness.pipeline.Toolbox.call", new=fake_search),
        ):
            execute_pipeline("Research this", llm=object())

        self.assertIn("captured search", stage_calls[4][0])
        self.assertIn("captured search", stage_calls[5][0])

    def test_technical_setup_searches_and_uses_selective_stage_handoffs(self):
        stage_results = iter(
            ["Task checklist", "Answer plan", "Reviewed outline", "Draft", "Critique", "Final"]
        )
        stage_calls = []
        tool_stage_inputs = []
        searches = []

        def fake_run_stage(llm, system_prompt, user_input, **kwargs):
            stage_calls.append((system_prompt, user_input))
            return next(stage_results)

        def fake_search(toolbox, name, arguments):
            searches.append((name, arguments["query"]))
            toolbox.used_tools.add(name)
            return '[{"title":"Trilium MCP docs","url":"https://example.test","snippet":"MCP details"}]'

        def fake_tool_stage(llm, system_prompt, user_input, toolbox, **kwargs):
            tool_stage_inputs.append(user_input)
            return "Tool findings"

        with (
            patch("smartharness.pipeline.run_stage", side_effect=fake_run_stage),
            patch("smartharness.pipeline.run_tool_stage", side_effect=fake_tool_stage),
            patch("smartharness.pipeline.Toolbox.call", new=fake_search),
        ):
            execute_pipeline("Set up SmartHarness with Trilium's MCP endpoint", llm=object())

        self.assertEqual(len(searches), 1)
        self.assertEqual(searches[0][0], "web_search")
        self.assertIn("Trilium's MCP endpoint", searches[0][1])
        self.assertIn("Automatic web search result", tool_stage_inputs[0])
        self.assertIn("Stage 2 result", stage_calls[2][1])
        self.assertIn("Stage 4 result", stage_calls[3][1])
        self.assertNotIn("Stage 1 result", stage_calls[3][1])
        self.assertNotIn("Stage 2 result", stage_calls[3][1])
        self.assertIn("Be concise", stage_calls[3][0])
        self.assertIn("Stage 5 result", stage_calls[5][1])
        self.assertNotIn("Stage 1 result", stage_calls[5][1])
        self.assertIn("every distinct request constraint", stage_calls[5][0])


if __name__ == "__main__":
    unittest.main()