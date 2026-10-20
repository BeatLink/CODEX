import json
import unittest

from smartharness.tool_stage import run_tool_stage
from smartharness.tools import TOOL_DEFINITIONS


class FakeToolbox:
    def __init__(self):
        self.calls = []
        self.tool_definitions = TOOL_DEFINITIONS

    def call(self, name, arguments):
        self.calls.append((name, arguments))
        return "sample tool output"


class FakeModel:
    def __init__(self, replies):
        self.replies = iter(replies)
        self.requests = []

    def create_chat_completion(self, **request):
        self.requests.append(request)
        return next(self.replies)


def tool_call_response(call_id="call-1", name="read_file", arguments=None):
    return {
        "choices": [
            {
                "finish_reason": "tool_calls",
                "message": {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "id": call_id,
                            "type": "function",
                            "function": {
                                "name": name,
                                "arguments": json.dumps(
                                    arguments or {"path": "notes.txt"}
                                ),
                            },
                        }
                    ],
                },
            }
        ]
    }


class ToolStageTests(unittest.TestCase):
    def test_fetched_page_is_summarized_before_returning_to_tool_loop(self):
        toolbox = FakeToolbox()
        toolbox.call = lambda name, arguments: json.dumps(
            {
                "url": "https://example.test/page",
                "title": "Page title",
                "text": "FULL PAGE CONTENT THAT MUST NOT ENTER THE MAIN LOOP",
                "focus": arguments["focus"],
            }
        )
        model = FakeModel(
            [
                tool_call_response(
                    name="web_fetch",
                    arguments={"url": "https://example.test/page", "focus": "the date"},
                ),
                {
                    "choices": [
                        {
                            "finish_reason": "stop",
                            "message": {"content": "Research complete."},
                        }
                    ]
                },
            ]
        )
        summarized_pages = []

        def summarize_page(page_json, focus, request_context):
            summarized_pages.append((page_json, focus, request_context))
            return "Source URL: https://example.test/page\nRelevant date: 2026"

        result = run_tool_stage(
            model,
            "Research only.",
            "Find the publication date.",
            toolbox,
            max_tokens=200,
            temperature=0.1,
            max_tool_calls=3,
            allowed_tools={"web_fetch"},
            page_summarizer=summarize_page,
        )

        research_tools = model.requests[0]["tools"]
        self.assertEqual(
            [tool["function"]["name"] for tool in research_tools], ["web_fetch"]
        )
        returned_to_model = model.requests[1]["messages"][-1]["content"]
        self.assertIn("Relevant date: 2026", returned_to_model)
        self.assertNotIn("FULL PAGE CONTENT", returned_to_model)
        self.assertEqual(summarized_pages[0][1], "the date")
        self.assertIn("Find the publication date", summarized_pages[0][2])
        self.assertIn("Relevant date: 2026", result)

    def test_blocked_tools_are_not_offered_to_the_model(self):
        toolbox = FakeToolbox()
        model = FakeModel(
            [
                {
                    "choices": [
                        {
                            "finish_reason": "stop",
                            "message": {"content": "No research tools available."},
                        }
                    ]
                }
            ]
        )

        run_tool_stage(
            model,
            "Execute planned actions.",
            "Update the requested file.",
            toolbox,
            max_tokens=200,
            temperature=0.1,
            max_tool_calls=3,
            blocked_tools={"web_search", "web_fetch"},
        )

        offered_names = {
            tool["function"]["name"] for tool in model.requests[0]["tools"]
        }
        self.assertNotIn("web_search", offered_names)
        self.assertNotIn("web_fetch", offered_names)
        self.assertIn("write_file", offered_names)

    def test_streams_content_and_reassembles_split_tool_call(self):
        toolbox = FakeToolbox()
        model = FakeModel(
            [
                iter(
                    [
                        {
                            "choices": [
                                {
                                    "delta": {
                                        "tool_calls": [
                                            {
                                                "index": 0,
                                                "id": "call-1",
                                                "type": "function",
                                                "function": {
                                                    "name": "read_file",
                                                    "arguments": '{"path":',
                                                },
                                            }
                                        ]
                                    },
                                    "finish_reason": None,
                                }
                            ]
                        },
                        {
                            "choices": [
                                {
                                    "delta": {
                                        "tool_calls": [
                                            {
                                                "index": 0,
                                                "function": {"arguments": ' "notes.txt"}'},
                                            }
                                        ]
                                    },
                                    "finish_reason": "tool_calls",
                                }
                            ]
                        },
                    ]
                ),
                iter(
                    [
                        {"choices": [{"delta": {"content": "Here "}, "finish_reason": None}]},
                        {"choices": [{"delta": {"content": "it is."}, "finish_reason": "stop"}]},
                    ]
                ),
            ]
        )
        streamed = []

        result = run_tool_stage(
            model,
            "Use tools when useful.",
            "Read notes.txt.",
            toolbox,
            max_tokens=200,
            temperature=0.1,
            max_tool_calls=3,
            on_token=streamed.append,
        )

        self.assertEqual(toolbox.calls, [("read_file", {"path": "notes.txt"})])
        self.assertEqual(streamed, ["Here ", "it is."])
        self.assertIn("Here it is.", result)

    def test_executes_tool_and_returns_results_to_model(self):
        toolbox = FakeToolbox()
        model = FakeModel(
            [
                tool_call_response(),
                {
                    "choices": [
                        {
                            "finish_reason": "stop",
                            "message": {"content": "Here is the result."},
                        }
                    ]
                },
            ]
        )

        result = run_tool_stage(
            model,
            "Use tools when useful.",
            "Read notes.txt.",
            toolbox,
            max_tokens=200,
            temperature=0.1,
            max_tool_calls=3,
        )

        self.assertEqual(toolbox.calls, [("read_file", {"path": "notes.txt"})])
        self.assertEqual(model.requests[1]["messages"][-1]["role"], "tool")
        self.assertEqual(model.requests[1]["messages"][-1]["content"], "sample tool output")
        self.assertIn("sample tool output", result)

    def test_stops_after_tool_call_limit_and_keeps_results(self):
        toolbox = FakeToolbox()
        model = FakeModel([tool_call_response("call-1"), tool_call_response("call-2")])

        result = run_tool_stage(
            model,
            "Use tools when useful.",
            "Read notes.txt.",
            toolbox,
            max_tokens=200,
            temperature=0.1,
            max_tool_calls=1,
        )

        self.assertEqual(model.requests[1]["tool_choice"], "none")
        self.assertEqual(len(toolbox.calls), 1)
        self.assertIn("tool-call limit was reached", result)
        self.assertIn("sample tool output", result)

    def test_tool_output_is_trimmed_to_the_context_window(self):
        toolbox = FakeToolbox()
        toolbox.call = lambda name, arguments: "z" * 50_000
        model = FakeModel(
            [
                tool_call_response("call-1"),
                {"choices": [{"finish_reason": "stop", "message": {"content": "Done."}}]},
            ]
        )

        run_tool_stage(
            model,
            "Use tools when useful.",
            "Read notes.txt.",
            toolbox,
            max_tokens=1024,
            temperature=0.1,
            max_tool_calls=1,
            context_size=2048,
        )

        sent = model.requests[1]
        sent_chars = sum(len(json.dumps(message)) for message in sent["messages"]) + len(json.dumps(sent["tools"]))
        self.assertLessEqual(sent_chars, (2048 - 1024) * 3)


if __name__ == "__main__":
    unittest.main()
