import argparse
import os
import queue
import sys
from pathlib import Path
from typing import Any

from rich.console import Console
from rich.markdown import Markdown

from .client import DISCONNECTED_EVENT, connect_to_daemon
from .pipeline import execute_pipeline
from .settings import MODE_CHOICES, default_settings_path, load_settings, validate_settings
from .knowledge import KnowledgeStore
from .task_tree import execute_task_tree


PATH_SETTINGS = ("model_path", "filesystem_root", "knowledge_db_path", "embedding_model_path")


def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    if argv and argv[0] == "tui":
        argv = ["--tui", *argv[1:]]
    if argv and argv[0] == "eval":
        from .evaluation import main as eval_main

        return eval_main(argv[1:])
    parser = argparse.ArgumentParser(description="Run a staged local LLM prompt harness.")
    parser.add_argument(
        "prompt",
        nargs="*",
        help="Prompt text. Omit it to enter a prompt interactively.",
    )
    parser.add_argument(
        "--settings",
        default=str(default_settings_path()),
        help="Path to the JSON settings file.",
    )
    parser.add_argument(
        "--tui",
        action="store_true",
        help="Open the interactive terminal interface.",
    )
    parser.add_argument(
        "--model-path",
        help="Path to a GGUF model (overrides settings.json and MODEL_PATH).",
    )
    parser.add_argument("--context-size", type=int)
    parser.add_argument("--gpu-layers", type=int)
    parser.add_argument("--max-tokens", type=int)
    parser.add_argument("--temperature", type=float)
    parser.add_argument(
        "--enable-test-execution",
        action="store_true",
        help="Allow the model to run unittest discovery under filesystem_root.",
    )
    parser.add_argument(
        "--allow-file-writes",
        action="store_true",
        help="Let the model create or replace files under filesystem_root (read-only by default).",
    )
    parser.add_argument(
        "--mode",
        choices=MODE_CHOICES,
        help="Answer a question, draft a piece of writing or a plan, or execute file changes; auto lets the model pick.",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Carry on the newest task tree run that a crash, restart, or cancel left unfinished.",
    )
    parser.add_argument(
        "--show-thinking",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Stream generated text token by token for each pipeline stage.",
    )
    args = parser.parse_args(argv)

    try:
        settings = load_settings(args.settings)
    except (OSError, ValueError) as error:
        print(f"Error loading settings: {error}", file=sys.stderr)
        return 1

    overrides: dict[str, Any] = {}
    if os.getenv("MODEL_PATH"):
        overrides["model_path"] = os.environ["MODEL_PATH"]
    for name in ("model_path", "context_size", "gpu_layers", "max_tokens", "temperature"):
        argument = getattr(args, name)
        if argument is not None:
            overrides[name] = argument
    if args.enable_test_execution:
        overrides["enable_test_execution"] = True
    if args.allow_file_writes:
        overrides["allow_file_writes"] = True
    if args.show_thinking is not None:
        overrides["show_thinking"] = args.show_thinking
    if args.mode is not None:
        overrides["mode"] = args.mode
    try:
        settings = validate_settings({**settings, **overrides})
    except ValueError as error:
        print(f"Error in settings: {error}", file=sys.stderr)
        return 1

    if args.resume:
        return _resume(settings)

    if args.tui or (not args.prompt and sys.stdin.isatty()):
        from .tui import SmartHarnessApp

        SmartHarnessApp(
            settings,
            initial_prompt=" ".join(args.prompt).strip(),
            settings_path=args.settings,
            settings_overrides=overrides,
        ).run()
        return 0

    prompt = " ".join(args.prompt).strip()
    if not prompt:
        prompt = sys.stdin.read().strip()
    if not prompt:
        parser.error("provide a prompt as an argument or through standard input")

    try:
        result = _run_with_daemon(prompt, settings, interactive=sys.stdin.isatty())
        if result is None:
            options = dict(
                model_path=settings["model_path"],
                context_size=settings["context_size"],
                gpu_layers=settings["gpu_layers"],
                max_tokens=settings["max_tokens"],
                temperature=settings["temperature"],
                filesystem_root=settings["filesystem_root"],
                max_tool_calls=settings["max_tool_calls"],
                max_search_results=settings["max_search_results"],
                enable_test_execution=settings["enable_test_execution"],
                allow_file_writes=settings["allow_file_writes"],
                mcp_servers=settings["mcp_servers"],
                knowledge_db_path=settings["knowledge_db_path"],
                embedding_model_path=settings["embedding_model_path"],
                max_pending_research_jobs=settings["background_max_pending_jobs"],
                mode=settings["mode"],
                show_thinking=settings["show_thinking"],
                clarification_callback=(
                    _ask_clarification if sys.stdin.isatty() else None
                ),
            )
            if settings["runner"] == "tree":
                result = execute_task_tree(
                    prompt,
                    **options,
                    max_task_depth=settings["max_task_depth"],
                    max_task_nodes=settings["max_task_nodes"],
                )
            else:
                result = execute_pipeline(prompt, **options)
    except (OSError, RuntimeError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1

    _print_result(result)
    return 0


def _print_result(result: str) -> None:
    print("\n=== FINAL RESULT ===\n")
    if sys.stdout.isatty():
        Console().print(Markdown(result))
    else:
        print(result)


def _resume(settings: dict[str, Any]) -> int:
    """Resume the newest unfinished task tree run, on a running daemon or in this process."""
    try:
        store = KnowledgeStore(Path(settings["knowledge_db_path"]).expanduser())
        unfinished = store.unfinished_task_runs(limit=1)
        if not unfinished:
            print("There is no unfinished task tree run to resume.", file=sys.stderr)
            return 1
        saved = store.task_run(unfinished[0]["id"])
        print(f"Resuming: {saved['prompt']} ({saved['tasks_done']} of {saved['tasks_total']} tasks done)")
        interactive = sys.stdin.isatty()
        result = _run_with_daemon(saved["prompt"], settings, interactive, resume_run_id=saved["id"])
        if result is None:
            result = execute_task_tree(
                saved["prompt"],
                **saved["options"],
                show_thinking=settings["show_thinking"],
                clarification_callback=_ask_clarification if interactive else None,
                resume_run_id=saved["id"],
            )
    except (OSError, RuntimeError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    _print_result(result)
    return 0


def _run_with_daemon(
    prompt: str,
    settings: dict[str, Any],
    interactive: bool,
    resume_run_id: int | None = None,
) -> str | None:
    """Run the prompt, or resume a saved task tree run, on a daemon that is already running; None when none is."""
    events: queue.Queue[tuple[str, dict[str, Any]]] = queue.Queue()
    try:
        client = connect_to_daemon(on_event=lambda event, data: events.put((event, data)), start=False)
    except OSError:
        return None
    # The daemon may have started elsewhere, so paths are sent resolved from this directory.
    settings = {
        **settings,
        # An empty path means a feature is off, so it stays empty.
        **{name: str(Path(settings[name]).expanduser().resolve()) for name in PATH_SETTINGS if settings[name]},
    }
    try:
        if resume_run_id is not None:
            run_id = client.call("resume_run", run_id=resume_run_id, interactive=interactive)["run_id"]
        else:
            run_id = client.call("run", prompt=prompt, settings=settings, interactive=interactive)["run_id"]
        while True:
            event, data = events.get()
            if event == DISCONNECTED_EVENT:
                raise RuntimeError("The daemon closed the connection.")
            if data.get("run_id") != run_id:
                continue
            if event == "run.progress" and settings["show_thinking"]:
                print(f"\n[{data['label']} result] ", end="", flush=True)
            elif event == "run.progress":
                print(f"[{data['label']}]...")
            elif event == "run.token" and settings["show_thinking"]:
                print(data["token"], end="", flush=True)
            elif event == "run.clarification":
                answer = _ask_clarification(data["question"])
                client.call(
                    "answer_clarification",
                    run_id=run_id,
                    clarification_id=data["clarification_id"],
                    answer=answer,
                )
            elif event == "run.finished":
                return data["result"]
            elif event == "run.failed":
                raise RuntimeError(data["message"])
            elif event == "run.cancelled":
                raise RuntimeError("The run was cancelled.")
    finally:
        client.close()


def _ask_clarification(question: str) -> str:
    return input(
        f"\nClarification needed: {question}\n"
        "Your answer (press Enter to continue with an assumption): "
    ).strip()