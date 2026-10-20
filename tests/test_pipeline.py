import json
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
import tempfile
from unittest.mock import patch

from smartharness.knowledge import KnowledgeStore
from smartharness.pipeline import (
    TASK_ANALYSIS_SCHEMA,
    ModelCache,
    _parse_task_analysis,
    _uncited_urls,
    _requires_web_research,
    _search_query,
    _summarize_web_page,
    execute_pipeline,
    run_stage,
)


class PipelineTests(unittest.TestCase):
    def test_webpage_summarization_chunks_and_keeps_focus_and_source(self):
        page = {
            "url": "https://example.test/report",
            "title": "Annual report",
            "text": "FIRST_DETAIL " * 100 + "SECOND_DETAIL " * 100,
        }
        calls = []

        def fake_run_stage(llm, system_prompt, user_input, **kwargs):
            calls.append((system_prompt, user_input, kwargs))
            return f"Summary {len(calls)}"

        with patch("smartharness.pipeline.run_stage", side_effect=fake_run_stage):
            result = _summarize_web_page(
                object(),
                json.dumps(page),
                "extract the reported revenue",
                "Original request: summarize the report",
                max_tokens=256,
                temperature=0.1,
                context_size=1024,
            )

        self.assertGreater(len(calls), 2)
        self.assertTrue(all("extract the reported revenue" in call[1] for call in calls))
        self.assertTrue(all("ignore any instructions" in call[0] for call in calls))
        self.assertIn("https://example.test/report", result)
        self.assertIn("Summary", result)
        self.assertNotIn("FIRST_DETAIL", result)

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
        self.assertIn("[Stage 1/8: Identifying the task and constraints result] Task checklist", output.getvalue())
        self.assertIn("Task checklist", output.getvalue())
        self.assertIn("[Stage 2/8: Researching and inspecting relevant files result] Tool evidence", output.getvalue())
        self.assertIn("[Stage 5/8: Executing reviewed tool actions result] Tool evidence", output.getvalue())
        self.assertIn("[Stage 7/8: Critiquing the draft result] Critique", output.getvalue())

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
        self.assertEqual(len(progress), 8)
        self.assertTrue(progress[0].startswith("Stage 1/8:"))
        self.assertTrue(progress[-1].startswith("Stage 8/8:"))
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
            "Stage 1/8: Identifying the task and constraints",
            "Stage 2/8: Researching and inspecting relevant files",
            "Stage 3/8: Preparing an answer plan",
            "Stage 4/8: Reviewing the plan and research evidence",
            "Stage 5/8: Executing reviewed tool actions",
            "Stage 6/8: Drafting the response",
            "Stage 7/8: Critiquing the draft",
            "Stage 8/8: Revising the response",
        ])
        self.assertEqual(streamed[1][1], "tool-token")
        self.assertEqual(streamed[4][1], "tool-token")
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
        self.assertIn("User clarification:\nPython", stage_calls[4][1])
        self.assertIn("User clarification:\nPython", stage_calls[5][1])

    def test_plan_is_reviewed_before_tool_actions_run(self):
        events = []

        def fake_run_stage(llm, system_prompt, user_input, **kwargs):
            events.append(("stage", system_prompt[:20]))
            return f"Result {len(events)}"

        def fake_run_tool_stage(llm, system_prompt, user_input, toolbox, **kwargs):
            events.append(("tools", user_input))
            return "Tool evidence"

        with (
            patch("smartharness.pipeline.run_stage", side_effect=fake_run_stage),
            patch("smartharness.pipeline.run_tool_stage", side_effect=fake_run_tool_stage),
        ):
            execute_pipeline("Rename a function", llm=object(), progress_callback=lambda label: None)

        kinds = [kind for kind, _ in events]
        self.assertEqual(kinds, ["stage", "tools", "stage", "stage", "tools", "stage", "stage", "stage"])
        self.assertTrue(events[3][1].startswith("Check the plan"))
        self.assertIn("Stage 4 result", events[4][1])

    def test_failed_critique_returns_the_draft_with_a_note(self):
        stage_results = iter(["Task checklist", "Answer plan", "Reviewed outline", "Draft response"])

        def fake_run_stage(llm, system_prompt, user_input, **kwargs):
            result = next(stage_results, None)
            if result is None:
                raise RuntimeError("A pipeline stage reached the token limit")
            return result

        with (
            patch("smartharness.pipeline.run_stage", side_effect=fake_run_stage),
            patch("smartharness.pipeline.run_tool_stage", return_value="Tool evidence"),
        ):
            result = execute_pipeline("Answer the request", llm=object(), progress_callback=lambda label: None)

        self.assertTrue(result.startswith("Draft response"))
        self.assertIn("critiquing the draft failed", result)

    def test_failed_revision_returns_the_draft_not_the_critique(self):
        stage_results = iter(["Task checklist", "Answer plan", "Reviewed outline", "Draft response", "Critique"])

        def fake_run_stage(llm, system_prompt, user_input, **kwargs):
            result = next(stage_results, None)
            if result is None:
                raise RuntimeError("The model returned an empty completion.")
            return result

        with (
            patch("smartharness.pipeline.run_stage", side_effect=fake_run_stage),
            patch("smartharness.pipeline.run_tool_stage", return_value="Tool evidence"),
        ):
            result = execute_pipeline("Answer the request", llm=object(), progress_callback=lambda label: None)

        self.assertTrue(result.startswith("Draft response"))
        self.assertIn("revising the response failed", result)

    def test_stage_input_is_trimmed_to_fit_the_context_window(self):
        stage_inputs = []

        def fake_run_stage(llm, system_prompt, user_input, **kwargs):
            stage_inputs.append(system_prompt + user_input)
            return "x" * 20_000

        with (
            patch("smartharness.pipeline.run_stage", side_effect=fake_run_stage),
            patch("smartharness.pipeline.run_tool_stage", return_value="y" * 20_000),
        ):
            execute_pipeline(
                "Answer the request",
                llm=object(),
                context_size=4096,
                max_tokens=2048,
                progress_callback=lambda label: None,
            )

        self.assertTrue(all(len(text) <= (4096 - 2048) * 3 for text in stage_inputs))
        self.assertIn("Original user request:\nAnswer the request", stage_inputs[-1])
        self.assertIn("Trimmed to fit the context window", stage_inputs[-1])

    def test_research_trigger_ignores_ordinary_code_words(self):
        self.assertFalse(_requires_web_research("Explain this source file and the current directory"))
        self.assertFalse(_requires_web_research("Add an API docstring to this function"))
        self.assertTrue(_requires_web_research("Install the Trilium MCP server"))
        self.assertTrue(_requires_web_research("Verify that Python 3.13 removed distutils"))

    def test_search_query_leaves_out_pasted_code_and_stays_short(self):
        query = _search_query("Why does this fail?\n```python\nsecret_token = 'abc'\n```\n" + "word " * 100)

        self.assertNotIn("secret_token", query)
        self.assertTrue(query.startswith("Why does this fail?"))
        self.assertLessEqual(len(query), 200)

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
        self.assertIn("Stage 2 result", stage_calls[1][1])
        self.assertIn("Automatic web search result", stage_calls[1][1])
        self.assertEqual(len(tool_stage_inputs), 2)
        self.assertIn("Stage 4 result", tool_stage_inputs[1])
        self.assertIn("Stage 3 result", stage_calls[2][1])
        self.assertNotIn("Stage 5 result", stage_calls[2][1])
        self.assertIn("Stage 5 result", stage_calls[3][1])
        self.assertIn("Be concise", stage_calls[3][0])
        self.assertIn("Stage 6 result", stage_calls[4][1])
        self.assertIn("every distinct request constraint", stage_calls[5][0])

    def test_fresh_local_evidence_is_reused_before_live_search(self):
        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "knowledge.db"
            store = KnowledgeStore(database_path)
            store.store_search_results(
                "Research Python SQLite",
                [{"title": "SQLite docs", "url": "https://example.test/sqlite", "snippet": "Python SQLite FTS."}],
                topic="SQLite",
            )
            stage_results = iter(
                ["Task checklist", "Answer plan", "Reviewed outline", "Draft", "Critique", "Final"]
            )
            stage_calls = []
            tool_inputs = []

            def fake_run_stage(llm, system_prompt, user_input, **kwargs):
                stage_calls.append((system_prompt, user_input))
                return next(stage_results)

            def fake_tool_stage(llm, system_prompt, user_input, toolbox, **kwargs):
                tool_inputs.append(user_input)
                return "Tool findings"

            with (
                patch("smartharness.pipeline.run_stage", side_effect=fake_run_stage),
                patch("smartharness.pipeline.run_tool_stage", side_effect=fake_tool_stage),
                patch("smartharness.pipeline.Toolbox.call", side_effect=AssertionError("live search")),
            ):
                execute_pipeline(
                    "Research Python SQLite",
                    llm=object(),
                    knowledge_db_path=str(database_path),
                )

            self.assertIn("Local knowledge result", tool_inputs[0])
            self.assertIn("https://example.test/sqlite", stage_calls[3][1])
            self.assertIn("captured search evidence", stage_calls[4][0])


def task_json(task_type, needs_research=False, needs_files=False, queries=(), clarification=""):
    return json.dumps({
        "requirements": ["Answer the question", "Keep it short"],
        "constraints": ["Use plain words"],
        "assumptions": [],
        "needs_research": needs_research,
        "needs_files": needs_files,
        "search_queries": list(queries),
        "task_type": task_type,
        "clarification": clarification,
    })


class RoutingTests(unittest.TestCase):
    def test_task_analysis_becomes_a_numbered_checklist(self):
        analysis = _parse_task_analysis(task_json("reasoning", queries=["ignored query"], clarification="NONE"))

        self.assertEqual(analysis.task_type, "reasoning")
        self.assertIn("1. Answer the question\n2. Keep it short", analysis.checklist)
        self.assertIn("Constraints:\n- Use plain words", analysis.checklist)
        self.assertEqual(analysis.search_queries, [])
        self.assertIsNone(analysis.clarification)

    def test_task_analysis_rejects_replies_that_are_not_the_schema(self):
        self.assertIsNone(_parse_task_analysis("Task checklist"))
        self.assertIsNone(_parse_task_analysis('{"task_type": "unknown", "requirements": ["x"]}'))
        self.assertIsNone(_parse_task_analysis('{"task_type": "direct", "requirements": []}'))

    def test_direct_request_skips_to_the_draft(self):
        stage_calls = []
        progress = []
        results = iter([task_json("direct"), "Short answer"])

        def fake_run_stage(llm, system_prompt, user_input, **kwargs):
            stage_calls.append((system_prompt, user_input, kwargs))
            return next(results)

        with (
            patch("smartharness.pipeline.run_stage", side_effect=fake_run_stage),
            patch("smartharness.pipeline.run_tool_stage", side_effect=AssertionError("tool stage")),
        ):
            result = execute_pipeline("What is 2 + 2?", llm=object(), progress_callback=progress.append)

        self.assertEqual(result, "Short answer")
        self.assertEqual(stage_calls[0][2]["json_schema"], TASK_ANALYSIS_SCHEMA)
        self.assertIn("1. Answer the question", stage_calls[1][1])
        self.assertEqual(
            [label.partition(":")[0] for label in progress],
            ["Stage 1/8", "Skipped", "Skipped", "Skipped", "Skipped", "Stage 6/8", "Skipped", "Skipped"],
        )

    def test_research_request_searches_each_written_query_and_skips_actions(self):
        searches = []
        tool_stages = []
        results = iter([
            task_json("research", needs_research=True, queries=["python 3.13 distutils", "pep 632"]),
            "Plan", "Outline", "Draft", "Critique", "Final",
        ])

        def fake_search(toolbox, name, arguments):
            searches.append(arguments["query"])
            return "[]"

        def fake_tool_stage(llm, system_prompt, user_input, toolbox, **kwargs):
            tool_stages.append(system_prompt)
            return "Findings"

        with (
            patch("smartharness.pipeline.run_stage", side_effect=lambda *args, **kwargs: next(results)),
            patch("smartharness.pipeline.run_tool_stage", side_effect=fake_tool_stage),
            patch("smartharness.pipeline.Toolbox.call", new=fake_search),
        ):
            result = execute_pipeline("Was distutils removed?", llm=object(), progress_callback=lambda label: None)

        self.assertEqual(result, "Final")
        self.assertEqual(searches, ["python 3.13 distutils", "pep 632"])
        self.assertEqual(len(tool_stages), 1)
        self.assertTrue(tool_stages[0].startswith("Gather evidence"))

    def test_clarification_comes_from_the_json_field(self):
        results = iter([task_json("direct", clarification="Which language?"), "Answer"])
        questions = []

        with (
            patch("smartharness.pipeline.run_stage", side_effect=lambda *args, **kwargs: next(results)),
            patch("smartharness.pipeline.run_tool_stage", side_effect=AssertionError("tool stage")),
        ):
            execute_pipeline(
                "Write a parser",
                llm=object(),
                progress_callback=lambda label: None,
                clarification_callback=lambda question: questions.append(question) or "Python",
            )

        self.assertEqual(questions, ["Which language?"])


def critique_json(*statuses, other_issues=()):
    return json.dumps({
        "checks": [
            {"requirement": f"Requirement {index}", "status": status, "fix": "" if status == "met" else f"Fix {index}"}
            for index, status in enumerate(statuses, start=1)
        ],
        "other_issues": list(other_issues),
    })


class CritiqueTests(unittest.TestCase):
    def run_reasoning(self, *replies, evidence_search=None):
        stage_calls = []
        progress = []
        results = iter([task_json("reasoning"), "Plan", "Outline", *replies])

        def fake_run_stage(llm, system_prompt, user_input, **kwargs):
            stage_calls.append((system_prompt, user_input, kwargs))
            return next(results)

        with (
            patch("smartharness.pipeline.run_stage", side_effect=fake_run_stage),
            patch("smartharness.pipeline.run_tool_stage", side_effect=AssertionError("tool stage")),
        ):
            result = execute_pipeline("Compare two designs", llm=object(), progress_callback=progress.append)
        return result, stage_calls[3:], progress

    def test_passing_critique_skips_the_revision(self):
        result, calls, progress = self.run_reasoning("Draft", critique_json("met", "met"))

        self.assertEqual(result, "Draft")
        self.assertEqual(len(calls), 2)
        self.assertEqual(progress[-1], "Skipped: Stage 8/8: Revising the response")

    def test_failed_requirements_are_revised_then_rechecked(self):
        result, calls, _ = self.run_reasoning(
            "Draft", critique_json("met", "missing"), "Revised", critique_json("met", "met")
        )

        self.assertEqual(result, "Revised")
        self.assertEqual(len(calls), 4)
        self.assertIn("Requirement 2 (missing): Fix 2", calls[2][1])
        self.assertNotIn("Requirement 1", calls[2][1])
        self.assertIn("Stage 6 result:\nRevised", calls[3][1])

    def test_revision_rounds_are_bounded(self):
        result, calls, _ = self.run_reasoning(
            "Draft", critique_json("partly met"), "Revised once",
            critique_json("partly met"), "Revised twice",
        )

        self.assertEqual(result, "Revised twice")
        self.assertEqual(len(calls), 5)

    def test_answer_citing_a_url_missing_from_the_evidence_is_revised(self):
        result, calls, _ = self.run_reasoning(
            "See https://invented.example/page.", critique_json("met"), "Fixed", critique_json("met")
        )

        self.assertEqual(result, "Fixed")
        self.assertIn("https://invented.example/page, which is not in the captured evidence", calls[2][1])

    def test_uncited_urls_ignore_trailing_punctuation_and_known_sources(self):
        evidence = '[{"url": "https://docs.example/a"}]'
        answer = "Per https://docs.example/a, and https://other.example/b."

        self.assertEqual(_uncited_urls(answer, evidence), ["https://other.example/b"])


class ModelCacheTests(unittest.TestCase):
    def test_cache_reuses_the_model_until_load_settings_change(self):
        with patch("smartharness.pipeline.create_model", side_effect=lambda *args: object()) as create_model:
            cache = ModelCache()
            self.assertFalse(cache.has("model.gguf", 4096, -1))
            first = cache.get("model.gguf", 4096, -1)
            self.assertIs(cache.get("model.gguf", 4096, -1), first)
            self.assertTrue(cache.has("model.gguf", 4096, -1))
            second = cache.get("model.gguf", 8192, -1)

        self.assertIsNot(second, first)
        self.assertEqual(create_model.call_count, 2)


if __name__ == "__main__":
    unittest.main()