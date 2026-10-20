import json
import re
from pathlib import Path
from typing import Any


DEFAULT_MODEL_PATH = "./models/model.gguf"
CONTEXT_SIZE = 4096
MAX_TOKENS = 2048
TEMPERATURE = 0.1
DEFAULT_SETTINGS_PATH = Path(__file__).resolve().parent.parent / "settings.json"
DEFAULT_KNOWLEDGE_DB_PATH = "~/.local/share/smartharness/knowledge.sqlite3"
DEFAULT_SETTINGS = {
    "model_path": DEFAULT_MODEL_PATH,
    "context_size": CONTEXT_SIZE,
    "gpu_layers": -1,
    "max_tokens": MAX_TOKENS,
    "temperature": TEMPERATURE,
    "filesystem_root": ".",
    "max_tool_calls": 5,
    "max_search_results": 5,
    "enable_test_execution": False,
    "show_thinking": True,
    "mcp_servers": [],
    "knowledge_db_path": DEFAULT_KNOWLEDGE_DB_PATH,
    "background_research_enabled": True,
    "background_poll_interval_seconds": 10,
    "background_refresh_interval_hours": 168,
    "background_max_tokens": 512,
    "background_max_pending_jobs": 100,
}


def load_settings(settings_path: str | Path) -> dict[str, Any]:
    settings_path = Path(settings_path)
    try:
        with settings_path.open(encoding="utf-8") as settings_file:
            settings = json.load(settings_file)
    except FileNotFoundError:
        if settings_path.resolve() == DEFAULT_SETTINGS_PATH.resolve():
            return DEFAULT_SETTINGS.copy()
        raise
    except json.JSONDecodeError as error:
        raise ValueError(f"Invalid JSON in settings file: {error}") from error

    if not isinstance(settings, dict):
        raise ValueError("The settings file must contain a JSON object.")

    unknown_keys = settings.keys() - DEFAULT_SETTINGS.keys()
    if unknown_keys:
        raise ValueError(f"Unknown setting(s): {', '.join(sorted(unknown_keys))}")

    return validate_settings({**DEFAULT_SETTINGS, **settings})


def save_settings(settings_path: str | Path, values: dict[str, Any]) -> dict[str, Any]:
    validated = validate_settings(values.copy())
    path = Path(settings_path).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(validated, indent=2) + "\n", encoding="utf-8")
    return validated


def validate_settings(values: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(values["model_path"], str) or not values["model_path"].strip():
        raise ValueError("model_path must be a non-empty string.")
    for name in ("context_size", "max_tokens"):
        if isinstance(values[name], bool) or not isinstance(values[name], int) or values[name] <= 0:
            raise ValueError(f"{name} must be a positive integer.")
    if (
        isinstance(values["gpu_layers"], bool)
        or not isinstance(values["gpu_layers"], int)
        or values["gpu_layers"] < -1
    ):
        raise ValueError("gpu_layers must be -1 or a non-negative integer.")
    if (
        isinstance(values["temperature"], bool)
        or not isinstance(values["temperature"], (int, float))
        or values["temperature"] < 0
    ):
        raise ValueError("temperature must be a non-negative number.")
    if not isinstance(values["filesystem_root"], str) or not values["filesystem_root"].strip():
        raise ValueError("filesystem_root must be a non-empty path string.")
    if not isinstance(values["enable_test_execution"], bool):
        raise ValueError("enable_test_execution must be a boolean.")
    if not isinstance(values["show_thinking"], bool):
        raise ValueError("show_thinking must be a boolean.")
    if not isinstance(values["knowledge_db_path"], str) or not values["knowledge_db_path"].strip():
        raise ValueError("knowledge_db_path must be a non-empty path string.")
    if not isinstance(values["background_research_enabled"], bool):
        raise ValueError("background_research_enabled must be a boolean.")
    for name, minimum, maximum in (
        ("background_poll_interval_seconds", 1, 3600),
        ("background_refresh_interval_hours", 1, 8760),
        ("background_max_tokens", 32, 4096),
        ("background_max_pending_jobs", 1, 1000),
    ):
        value = values[name]
        if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
            raise ValueError(f"{name} must be an integer from {minimum} to {maximum}.")
    for name in ("max_tool_calls", "max_search_results"):
        if isinstance(values[name], bool) or not isinstance(values[name], int) or not 1 <= values[name] <= 10:
            raise ValueError(f"{name} must be an integer from 1 to 10.")
    values["mcp_servers"] = validate_mcp_servers(values["mcp_servers"])
    values["temperature"] = float(values["temperature"])
    return values


def validate_mcp_servers(servers: Any) -> list[dict[str, Any]]:
    if not isinstance(servers, list):
        raise ValueError("mcp_servers must be a list.")

    validated = []
    seen_names = set()
    allowed_fields = {
        "name",
        "enabled",
        "transport",
        "command",
        "args",
        "env",
        "allowed_tools",
    }
    for index, server in enumerate(servers):
        if not isinstance(server, dict):
            raise ValueError(f"mcp_servers[{index}] must be an object.")
        unknown_fields = server.keys() - allowed_fields
        if unknown_fields:
            raise ValueError(
                f"Unknown field(s) in mcp_servers[{index}]: "
                f"{', '.join(sorted(unknown_fields))}"
            )

        name = server.get("name")
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", name):
            raise ValueError(f"mcp_servers[{index}].name must be 1-32 letters, numbers, '_' or '-'.")
        if name in seen_names:
            raise ValueError(f"MCP server names must be unique: {name}.")
        seen_names.add(name)

        enabled = server.get("enabled", True)
        if not isinstance(enabled, bool):
            raise ValueError(f"MCP server '{name}' enabled must be a boolean.")
        transport = server.get("transport", "stdio")
        if transport != "stdio":
            raise ValueError(f"MCP server '{name}' uses unsupported transport '{transport}'.")

        command = server.get("command")
        if not isinstance(command, str) or not command.strip():
            raise ValueError(f"MCP server '{name}' command must be a non-empty string.")
        args = server.get("args", [])
        if not isinstance(args, list) or any(not isinstance(arg, str) for arg in args):
            raise ValueError(f"MCP server '{name}' args must be a list of strings.")

        allowed_tools = server.get("allowed_tools", [])
        if (
            not isinstance(allowed_tools, list)
            or any(not isinstance(tool, str) or not tool for tool in allowed_tools)
            or len(allowed_tools) != len(set(allowed_tools))
        ):
            raise ValueError(f"MCP server '{name}' allowed_tools must be a unique list of names.")
        if enabled and not allowed_tools:
            raise ValueError(f"MCP server '{name}' must allow at least one tool when enabled.")

        env = server.get("env", {})
        if not isinstance(env, dict):
            raise ValueError(f"MCP server '{name}' env must be an object of strings.")
        for key, value in env.items():
            if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
                raise ValueError(f"MCP server '{name}' has an invalid environment variable name.")
            if not isinstance(value, str):
                raise ValueError(f"MCP server '{name}' environment values must be strings.")

        validated.append(
            {
                "name": name,
                "enabled": enabled,
                "transport": transport,
                "command": command,
                "args": args,
                "env": env,
                "allowed_tools": allowed_tools,
            }
        )
    return validated