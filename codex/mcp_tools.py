import os
import re
from contextlib import AsyncExitStack
from typing import Any

from .tools import MAX_TOOL_OUTPUT_CHARS


class MCPToolbox:
    def __init__(self, servers: list[dict[str, Any]]):
        self.servers = [server for server in servers if server["enabled"]]
        self.tool_definitions = []
        self._routes: dict[str, tuple[Any, str]] = {}
        self._stack: AsyncExitStack | None = None

    async def __aenter__(self):
        if not self.servers:
            return self

        try:
            from mcp import ClientSession
        except ImportError as error:
            raise RuntimeError(
                "MCP servers require the 'mcp' package; install the project dependencies."
            ) from error

        self._stack = AsyncExitStack()
        await self._stack.__aenter__()
        try:
            for server in self.servers:
                await self._connect_server(server, ClientSession)
        except Exception as error:
            await self._stack.aclose()
            self._stack = None
            if isinstance(error, (ValueError, RuntimeError)):
                raise
            raise RuntimeError(f"Failed to start an MCP server: {error}") from error
        return self

    async def __aexit__(self, exc_type, exc_value, traceback):
        if self._stack is not None:
            return await self._stack.__aexit__(exc_type, exc_value, traceback)
        return False

    def handles(self, tool_name: str) -> bool:
        return tool_name in self._routes

    async def call(self, tool_name: str, arguments: dict[str, Any]) -> str:
        route = self._routes.get(tool_name)
        if route is None:
            return f"Tool error: unknown MCP tool '{tool_name}'."
        session, server_tool_name = route
        try:
            result = await session.call_tool(server_tool_name, arguments)
        except Exception as error:
            return f"MCP tool error: {type(error).__name__}: {error}"[:MAX_TOOL_OUTPUT_CHARS]

        content = []
        for item in getattr(result, "content", []):
            if getattr(item, "type", None) == "text":
                content.append(getattr(item, "text", ""))
            else:
                content.append(f"[Non-text MCP result omitted: {getattr(item, 'type', 'unknown')}]")
        output = "\n".join(content) or "MCP tool returned no text content."
        if getattr(result, "isError", getattr(result, "is_error", False)):
            output = f"MCP tool error: {output}"
        return output[:MAX_TOOL_OUTPUT_CHARS]

    async def _connect_server(self, server: dict[str, Any], client_session_type: Any) -> None:
        if server["transport"] == "http":
            read_stream, write_stream = await self._open_http_streams(server)
        else:
            read_stream, write_stream = await self._open_stdio_streams(server)
        session = await self._stack.enter_async_context(
            client_session_type(read_stream, write_stream)
        )
        await session.initialize()
        response = await session.list_tools()
        discovered = {tool.name: tool for tool in response.tools}
        missing_tools = set(server["allowed_tools"]) - discovered.keys()
        if missing_tools:
            raise ValueError(
                f"MCP server '{server['name']}' does not provide allowed tool(s): "
                f"{', '.join(sorted(missing_tools))}."
            )

        for tool_name in server["allowed_tools"]:
            tool = discovered[tool_name]
            function_name = self._function_name(server["name"], tool_name)
            if function_name in self._routes:
                raise ValueError(f"Duplicate MCP function name: {function_name}.")
            input_schema = getattr(tool, "inputSchema", None)
            if not isinstance(input_schema, dict):
                raise ValueError(
                    f"MCP tool '{server['name']}/{tool_name}' has an invalid input schema."
                )
            self.tool_definitions.append(
                {
                    "type": "function",
                    "function": {
                        "name": function_name,
                        "description": tool.description or f"MCP tool {tool_name}",
                        "parameters": input_schema,
                    },
                }
            )
            self._routes[function_name] = (session, tool_name)

    async def _open_stdio_streams(self, server: dict[str, Any]) -> tuple[Any, Any]:
        from mcp import StdioServerParameters
        from mcp.client.stdio import stdio_client

        inherited_variables = (
            "PATH",
            "HOME",
            "TMPDIR",
            "TEMP",
            "TMP",
            "LANG",
            "LC_ALL",
            "LC_CTYPE",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
        )
        environment = {
            key: os.environ[key]
            for key in inherited_variables
            if key in os.environ
        }
        for key, value in server["env"].items():
            environment[key] = _resolve_placeholders(value, server["name"])

        parameters = StdioServerParameters(
            command=server["command"],
            args=server["args"],
            env=environment,
        )
        return await self._stack.enter_async_context(stdio_client(parameters))

    async def _open_http_streams(self, server: dict[str, Any]) -> tuple[Any, Any]:
        from mcp.client.streamable_http import streamable_http_client
        from mcp.shared._httpx_utils import create_mcp_http_client

        headers = {
            key: _resolve_placeholders(value, server["name"])
            for key, value in server["headers"].items()
        }
        http_client = await self._stack.enter_async_context(
            create_mcp_http_client(headers=headers)
        )
        read_stream, write_stream, _ = await self._stack.enter_async_context(
            streamable_http_client(server["url"], http_client=http_client)
        )
        return read_stream, write_stream

    @staticmethod
    def _function_name(server_name: str, tool_name: str) -> str:
        name = re.sub(r"[^A-Za-z0-9_-]", "_", f"mcp__{server_name}__{tool_name}")
        if len(name) > 64:
            raise ValueError(
                f"MCP tool name '{server_name}/{tool_name}' exceeds the 64-character limit."
            )
        return name


def _resolve_placeholders(value: str, server_name: str) -> str:
    def substitute(match: re.Match) -> str:
        variable_name = match.group(1)
        if variable_name not in os.environ:
            raise ValueError(
                f"Environment variable '{variable_name}' required by MCP server "
                f"'{server_name}' is not set."
            )
        return os.environ[variable_name]

    return re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", substitute, value)
