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


def tool_call_response(call_id="call-1"):
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
                                "name": "read_file",
                                "arguments": json.dumps({"path": "notes.txt"}),
                            },
                        }
                    ],
                },
            }
        ]
    }


class ToolStageTests(unittest.TestCase):
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

    def test_stops_after_tool_call_limit(self):
        toolbox = FakeToolbox()
        model = FakeModel([tool_call_response("call-1"), tool_call_response("call-2")])

        with self.assertRaisesRegex(RuntimeError, "after the call limit"):
            run_tool_stage(
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


if __name__ == "__main__":
    unittest.main()
