import argparse
import os
import sys
from pathlib import Path

from .pipeline import execute_pipeline
from .settings import DEFAULT_SETTINGS_PATH, load_settings, validate_settings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run a staged local LLM prompt harness.")
    local_settings_path = Path.cwd() / "settings.json"
    parser.add_argument(
        "prompt",
        nargs="*",
        help="Prompt text. Omit it to enter a prompt interactively.",
    )
    parser.add_argument(
        "--settings",
        default=str(local_settings_path if local_settings_path.is_file() else DEFAULT_SETTINGS_PATH),
        help="Path to the JSON settings file.",
    )
    parser.add_argument(
        "--model-path",
        help="Path to a GGUF model (overrides settings.json and MODEL_PATH).",
    )
    parser.add_argument("--context-size", type=int)
    parser.add_argument("--gpu-layers", type=int)
    parser.add_argument("--max-tokens", type=int)
    parser.add_argument("--temperature", type=float)
    args = parser.parse_args(argv)

    try:
        settings = load_settings(args.settings)
    except (OSError, ValueError) as error:
        print(f"Error loading settings: {error}", file=sys.stderr)
        return 1

    if os.getenv("MODEL_PATH"):
        settings["model_path"] = os.environ["MODEL_PATH"]
    for name in ("model_path", "context_size", "gpu_layers", "max_tokens", "temperature"):
        argument = getattr(args, name)
        if argument is not None:
            settings[name] = argument
    try:
        settings = validate_settings(settings)
    except ValueError as error:
        print(f"Error in settings: {error}", file=sys.stderr)
        return 1

    prompt = " ".join(args.prompt).strip()
    if not prompt and sys.stdin.isatty():
        prompt = input("Prompt: ").strip()
    elif not prompt:
        prompt = sys.stdin.read().strip()
    if not prompt:
        parser.error("provide a prompt as an argument or through standard input")

    try:
        result = execute_pipeline(
            prompt,
            model_path=settings["model_path"],
            context_size=settings["context_size"],
            gpu_layers=settings["gpu_layers"],
            max_tokens=settings["max_tokens"],
            temperature=settings["temperature"],
            filesystem_root=settings["filesystem_root"],
            max_tool_calls=settings["max_tool_calls"],
            max_search_results=settings["max_search_results"],
        )
    except (OSError, RuntimeError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1

    print("\n=== FINAL RESULT ===\n")
    print(result)
    return 0