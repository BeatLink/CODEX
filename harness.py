import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any


DEFAULT_MODEL_PATH = "./models/model.gguf"
CONTEXT_SIZE = 4096
MAX_TOKENS = 1024
TEMPERATURE = 0.1
DEFAULT_SETTINGS_PATH = Path(__file__).with_name("settings.json")
DEFAULT_SETTINGS = {
    "model_path": DEFAULT_MODEL_PATH,
    "context_size": CONTEXT_SIZE,
    "gpu_layers": -1,
    "max_tokens": MAX_TOKENS,
    "temperature": TEMPERATURE,
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
    values["temperature"] = float(values["temperature"])
    return values


def create_model(model_path: str, context_size: int, gpu_layers: int) -> Any:
    """Load the local GGUF model only when inference is requested."""
    try:
        from llama_cpp import Llama
    except ImportError as error:
        raise RuntimeError(
            "llama-cpp-python is required; install it in the active environment."
        ) from error

    return Llama(
        model_path=model_path,
        n_gpu_layers=gpu_layers,
        n_ctx=context_size,
        verbose=False,
    )


def run_stage(
    llm: Any,
    system_prompt: str,
    user_input: str,
    max_tokens: int = MAX_TOKENS,
    temperature: float = TEMPERATURE,
) -> str:
    response = llm.create_chat_completion(
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_input},
        ],
        temperature=temperature,
        max_tokens=max_tokens,
    )
    choices = response.get("choices", [])
    if not choices:
        raise RuntimeError("The model returned no completion choices.")

    choice = choices[0]
    if choice.get("finish_reason") == "length":
        raise RuntimeError(
            "A pipeline stage reached the token limit; increase --max-tokens."
        )
    content = choice.get("message", {}).get("content")
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("The model returned an empty completion.")
    return content.strip()


def _stage_context(user_prompt: str, previous_results: list[tuple[str, str]]) -> str:
    sections = [f"Original user request:\n{user_prompt}"]
    sections.extend(f"{label}:\n{result}" for label, result in previous_results)
    return "\n\n".join(sections)


def execute_pipeline(
    user_prompt: str,
    model_path: str = DEFAULT_MODEL_PATH,
    context_size: int = CONTEXT_SIZE,
    gpu_layers: int = -1,
    max_tokens: int = MAX_TOKENS,
    temperature: float = TEMPERATURE,
    llm: Any = None,
) -> str:
    if not user_prompt.strip():
        raise ValueError("The prompt cannot be empty.")
    if llm is None:
        print(f"Loading model from {model_path}...")
        llm = create_model(model_path, context_size, gpu_layers)

    stages = [
        (
            "Stage 1/4: Identifying the task and constraints",
            "Extract the requested outcome, explicit constraints, and any"
            " assumptions that need clarification. Return a concise checklist.",
        ),
        (
            "Stage 2/4: Preparing an answer plan",
            "Using the original request and task checklist, make a concise"
            " answer plan. Use general knowledge only; flag uncertain or"
            " time-sensitive claims instead of implying external research.",
        ),
        (
            "Stage 3/4: Reviewing the plan",
            "Check the plan against the original request and constraints."
            " Identify omissions, unsupported claims, or contradictions,"
            " then provide a corrected outline.",
        ),
        (
            "Stage 4/4: Writing the response",
            "Answer the original request using the reviewed outline. Follow"
            " its constraints, address every requested outcome, and state"
            " material assumptions or uncertainty. Do not claim research"
            " that was not performed.",
        ),
    ]
    previous_results: list[tuple[str, str]] = []
    for index, (label, system_prompt) in enumerate(stages, start=1):
        print(f"[{label}]...")
        result = run_stage(
            llm,
            system_prompt,
            _stage_context(user_prompt, previous_results),
            max_tokens=max_tokens,
            temperature=temperature,
        )
        previous_results.append((f"Stage {index} result", result))

    return previous_results[-1][1]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run a staged local LLM prompt harness.")
    parser.add_argument(
        "prompt",
        nargs="*",
        help="Prompt text. Omit it to enter a prompt interactively.",
    )
    parser.add_argument(
        "--settings",
        default=str(DEFAULT_SETTINGS_PATH),
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
        )
    except (OSError, RuntimeError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1

    print("\n=== FINAL RESULT ===\n")
    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())