import asyncio
import json
import sys
import types
import unittest
from contextlib import asynccontextmanager
from unittest.mock import patch

from smartharness.mcp_tools import MCPToolbox
from smartharness.tool_stage import run_tool_stage
from smartharness.tools import Toolbox


class FakeSession:
    instances = []

    def __init__(self, read_stream, write_stream):
        self.closed = False
        self.tool_calls = []
        self.__class__.instances.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_value, traceback):
        self.closed = True
        return False

    async def initialize(self):
        return None

    async def list_tools(self):
        tool = types.SimpleNamespace(
            name="lookup",
            description="Look up a document",
            inputSchema={
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        )
        ignored = types.SimpleNamespace(
            name="delete_all",
            description="Not allowed",
            inputSchema={"type": "object", "properties": {}},
        )
        return types.SimpleNamespace(tools=[tool, ignored])

    async def call_tool(self, name, arguments):
        self.tool_calls.append((name, arguments))
        return types.SimpleNamespace(
            isError=False,
            content=[types.SimpleNamespace(type="text", text="document result")],
        )


def install_fake_mcp():
    FakeSession.instances = []
    launches = []

    class FakeServerParameters:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    @asynccontextmanager
    async def fake_stdio_client(parameters):
        launches.append(parameters)
        yield "read-stream", "write-stream"

    mcp_module = types.ModuleType("mcp")
    mcp_module.ClientSession = FakeSession
    mcp_module.StdioServerParameters = FakeServerParameters
    client_module = types.ModuleType("mcp.client")
    stdio_module = types.ModuleType("mcp.client.stdio")
    stdio_module.stdio_client = fake_stdio_client
    return {
        "mcp": mcp_module,
        "mcp.client": client_module,
        "mcp.client.stdio": stdio_module,
    }, launches


def server_config():
    return {
        "name": "docs",
        "enabled": True,
        "transport": "stdio",
        "command": "docs-server",
        "args": [],
        "env": {},
        "allowed_tools": ["lookup"],
    }


class MCPToolboxTests(unittest.TestCase):
    def test_discovers_allowlisted_tools_routes_calls_and_closes_session(self):
        modules, launches = install_fake_mcp()

        async def exercise():
            async with MCPToolbox([server_config()]) as toolbox:
                self.assertEqual(len(toolbox.tool_definitions), 1)
                self.assertEqual(
                    toolbox.tool_definitions[0]["function"]["name"],
                    "mcp__docs__lookup",
                )
                self.assertNotIn(
                    "delete_all",
                    json.dumps(toolbox.tool_definitions),
                )
                result = await toolbox.call(
                    "mcp__docs__lookup", {"query": "quick start"}
                )
                self.assertEqual(result, "document result")
                self.assertEqual(
                    FakeSession.instances[0].tool_calls,
                    [("lookup", {"query": "quick start"})],
                )
            self.assertTrue(FakeSession.instances[0].closed)

        with patch.dict(sys.modules, modules):
            asyncio.run(exercise())
        self.assertEqual(launches[0].command, "docs-server")

    def test_tool_stage_dispatches_mcp_calls(self):
        modules, _ = install_fake_mcp()

        class FakeModel:
            def __init__(self):
                self.requests = []

            def create_chat_completion(self, **request):
                self.requests.append(request)
                if len(self.requests) == 1:
                    return {
                        "choices": [
                            {
                                "finish_reason": "tool_calls",
                                "message": {
                                    "role": "assistant",
                                    "tool_calls": [
                                        {
                                            "id": "call-1",
                                            "type": "function",
                                            "function": {
                                                "name": "mcp__docs__lookup",
                                                "arguments": json.dumps(
                                                    {"query": "quick start"}
                                                ),
                                            },
                                        }
                                    ],
                                },
                            }
                        ]
                    }
                return {
                    "choices": [
                        {
                            "finish_reason": "stop",
                            "message": {"content": "The document says ..."},
                        }
                    ]
                }

        model = FakeModel()
        with patch.dict(sys.modules, modules):
            result = run_tool_stage(
                model,
                "Use tools when needed.",
                "Search the docs.",
                Toolbox("."),
                max_tokens=200,
                temperature=0.1,
                max_tool_calls=3,
                mcp_servers=[server_config()],
            )

        self.assertIn("document result", model.requests[1]["messages"][-1]["content"])
        self.assertIn("mcp__docs__lookup", model.requests[0]["tools"][-1]["function"]["name"])
        self.assertIn("document result", result)
        self.assertTrue(FakeSession.instances[0].closed)

    def test_environment_placeholders_resolve_from_process_environment(self):
        modules, launches = install_fake_mcp()
        config = server_config()
        config["env"] = {"DOCS_TOKEN": "${SMART_HARNESS_TEST_TOKEN}"}

        async def exercise():
            async with MCPToolbox([config]):
                return None

        with patch.dict(sys.modules, modules), patch.dict(
            "os.environ",
            {
                "SMART_HARNESS_TEST_TOKEN": "test-secret",
                "UNRELATED_SECRET": "must-not-leak",
            },
        ):
            asyncio.run(exercise())

        self.assertEqual(launches[0].env["DOCS_TOKEN"], "test-secret")
        self.assertNotIn("UNRELATED_SECRET", launches[0].env)


if __name__ == "__main__":
    unittest.main()
