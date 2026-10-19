import asyncio
import json
from collections.abc import Callable
from typing import Any

from .mcp_tools import MCPToolbox
from .tools import Toolbox

MAX_TOOL_HISTORY_CHARS = 8_000


def run_tool_stage(
    llm: Any,
    system_prompt: str,
    user_input: str,
    toolbox: Toolbox,
    max_tokens: int,
    temperature: float,
    max_tool_calls: int,
    mcp_servers: list[dict[str, Any]] | None = None,
    on_token: Callable[[str], None] | None = None,
) -> str:
    if (
        isinstance(max_tool_calls, bool)
        or not isinstance(max_tool_calls, int)
        or not 1 <= max_tool_calls <= 10
    ):
        raise ValueError("max_tool_calls must be between 1 and 10.")
    return asyncio.run(
        _run_tool_stage(
            llm,
            system_prompt,
            user_input,
            toolbox,
            max_tokens,
            temperature,
            max_tool_calls,
            mcp_servers or [],
            on_token,
        )
    )


async def _run_tool_stage(
    llm: Any,
    system_prompt: str,
    user_input: str,
    toolbox: Toolbox,
    max_tokens: int,
    temperature: float,
    max_tool_calls: int,
    mcp_servers: list[dict[str, Any]],
    on_token: Callable[[str], None] | None,
) -> str:
    async with MCPToolbox(mcp_servers) as mcp_toolbox:
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_input},
        ]
        tool_history = []
        tool_call_count = 0
        tool_output_chars = 0

        while True:
            request = {
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens,
                "tools": [*toolbox.tool_definitions, *mcp_toolbox.tool_definitions],
                "tool_choice": "auto" if tool_call_count < max_tool_calls else "none",
            }
            if on_token is not None:
                request["stream"] = True
            response = llm.create_chat_completion(**request)
            if on_token is not None:
                content_parts = []
                tool_calls_by_index: dict[int, dict[str, Any]] = {}
                finish_reason = None
                for chunk in response:
                    chunk_choices = chunk.get("choices", [])
                    if not chunk_choices:
                        continue
                    chunk_choice = chunk_choices[0]
                    finish_reason = chunk_choice.get("finish_reason") or finish_reason
                    delta = chunk_choice.get("delta", {})
                    content = delta.get("content")
                    if isinstance(content, str) and content:
                        content_parts.append(content)
                        on_token(content)
                    for streamed_call in delta.get("tool_calls", []):
                        call_index = streamed_call.get("index", 0)
                        tool_call = tool_calls_by_index.setdefault(
                            call_index,
                            {
                                "id": "",
                                "type": "function",
                                "function": {"name": "", "arguments": ""},
                            },
                        )
                        if streamed_call.get("id"):
                            tool_call["id"] = streamed_call["id"]
                        if streamed_call.get("type"):
                            tool_call["type"] = streamed_call["type"]
                        function_delta = streamed_call.get("function", {})
                        if function_delta.get("name"):
                            tool_call["function"]["name"] += function_delta["name"]
                        if function_delta.get("arguments"):
                            tool_call["function"]["arguments"] += function_delta["arguments"]
                assistant_message = {
                    "role": "assistant",
                    "content": "".join(content_parts) or None,
                }
                if tool_calls_by_index:
                    assistant_message["tool_calls"] = [
                        tool_calls_by_index[index]
                        for index in sorted(tool_calls_by_index)
                    ]
                response = {
                    "choices": [
                        {
                            "finish_reason": finish_reason,
                            "message": assistant_message,
                        }
                    ]
                }
            choices = response.get("choices", [])
            if not choices:
                raise RuntimeError("The model returned no completion choices.")

            choice = choices[0]
            if choice.get("finish_reason") == "length":
                raise RuntimeError(
                    "The tool stage reached the token limit; increase --max-tokens."
                )
            assistant_message = choice.get("message", {})
            tool_calls = assistant_message.get("tool_calls") or []
            if not tool_calls:
                content = assistant_message.get("content")
                if not isinstance(content, str) or not content.strip():
                    raise RuntimeError("The model returned an empty tool-stage response.")
                if tool_history:
                    return content.strip() + "\n\nTool call results:\n" + "\n".join(tool_history)
                return content.strip()
            if tool_call_count >= max_tool_calls:
                raise RuntimeError("The model continued requesting tools after the call limit.")

            messages.append(assistant_message)
            for tool_call in tool_calls:
                call_id = tool_call.get("id")
                function = tool_call.get("function", {})
                name = function.get("name", "")
                if not isinstance(call_id, str) or not call_id:
                    raise RuntimeError("The model returned a tool call without an ID.")

                if tool_call_count >= max_tool_calls:
                    result = "Tool error: the configured tool-call limit was reached."
                else:
                    tool_call_count += 1
                    try:
                        raw_arguments = function.get("arguments", "{}")
                        arguments = (
                            json.loads(raw_arguments)
                            if isinstance(raw_arguments, str)
                            else raw_arguments
                        )
                        if mcp_toolbox.handles(name):
                            result = await mcp_toolbox.call(name, arguments)
                        else:
                            result = toolbox.call(name, arguments)
                    except (json.JSONDecodeError, TypeError) as error:
                        result = f"Tool error: invalid JSON arguments: {error}"

                remaining_output = MAX_TOOL_HISTORY_CHARS - tool_output_chars
                if len(result) > remaining_output:
                    result = result[:remaining_output]
                tool_output_chars += len(result)

                messages.append(
                    {"role": "tool", "tool_call_id": call_id, "content": result}
                )
                tool_history.append(f"{name}: {result}")