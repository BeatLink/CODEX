import json
from pathlib import Path
from typing import Any


DEFAULT_MODEL_PATH = "./models/model.gguf"
CONTEXT_SIZE = 4096
MAX_TOKENS = 1024
TEMPERATURE = 0.1
DEFAULT_SETTINGS_PATH = Path(__file__).resolve().parent.parent / "settings.json"
DEFAULT_SETTINGS = {
    "model_path": DEFAULT_MODEL_PATH,
    "context_size": CONTEXT_SIZE,
    "gpu_layers": -1,
    "max_tokens": MAX_TOKENS,
    "temperature": TEMPERATURE,
    "filesystem_root": ".",
    "max_tool_calls": 5,
    "max_search_results": 5,
}


def load_settings(settings_path: str | Path) -> dict[str, Any]:
    try:
        with Path(settings_path).open(encoding="utf-8") as settings_file:
            settings = json.load(settings_file)
    except json.JSONDecodeError as error:
        raise ValueError(f"Invalid JSON in settings file: {error}") from error

    if not isinstance(settings, dict):
        raise ValueError("The settings file must contain a JSON object.")

    unknown_keys = settings.keys() - DEFAULT_SETTINGS.keys()
    if unknown_keys:
        raise ValueError(f"Unknown setting(s): {', '.join(sorted(unknown_keys))}")

    return validate_settings({**DEFAULT_SETTINGS, **settings})


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
    for name in ("max_tool_calls", "max_search_results"):
        if isinstance(values[name], bool) or not isinstance(values[name], int) or not 1 <= values[name] <= 10:
            raise ValueError(f"{name} must be an integer from 1 to 10.")
    values["temperature"] = float(values["temperature"])
    return values