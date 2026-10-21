import argparse
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
import json
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import time
from typing import Any

from .pipeline import create_model, execute_pipeline, run_stage
from .settings import default_settings_path, load_settings, validate_settings
from .task_tree import execute_task_tree


DEFAULT_TASKS_PATH = Path(__file__).resolve().parent.parent / "evals" / "tasks.json"
RUNNER_CHOICES = ("bare", "pipeline", "tree")
# Runners that recall from the knowledge store, and so get a seeded run beside the empty one.
STORE_RUNNERS = ("pipeline", "tree")
SEEDED_SUFFIX = "+store"
BARE_SYSTEM_PROMPT = "You are a helpful assistant. Answer the user's request."
# Execute mode is left out because its tasks would need files to work on.
EVAL_MODES = ("auto", "answer", "draft")
CHECK_TYPES = ("contains", "contains_any", "not_contains", "regex", "max_words", "min_words")


# ==============================================================================
# Loading the task set
# ==============================================================================


@dataclass
class EvalTask:
    id: str
    prompt: str
    checks: list[dict[str, Any]]
    mode: str = "auto"


def load_tasks(tasks_path: str | Path) -> list[EvalTask]:
    """Read and validate the task set, a JSON list of tasks each with an id, a prompt, and checks."""
    data = json.loads(Path(tasks_path).read_text(encoding="utf-8"))
    if not isinstance(data, list) or not data:
        raise ValueError("The task set must be a non-empty JSON list.")
    tasks = []
    seen_ids = set()
    for entry in data:
        task = EvalTask(
            id=str(entry.get("id", "")).strip(),
            prompt=str(entry.get("prompt", "")).strip(),
            checks=entry.get("checks", []),
            mode=entry.get("mode", "auto"),
        )
        if not task.id or task.id in seen_ids:
            raise ValueError(f"Each task needs a unique id; got {task.id!r}.")
        if not task.prompt:
            raise ValueError(f"Task {task.id} has no prompt.")
        if task.mode not in EVAL_MODES:
            raise ValueError(f"Task {task.id} has mode {task.mode!r}; use one of: {', '.join(EVAL_MODES)}.")
        if not isinstance(task.checks, list) or not task.checks:
            raise ValueError(f"Task {task.id} has no checks.")
        for check in task.checks:
            validate_check(task.id, check)
        seen_ids.add(task.id)
        tasks.append(task)
    return tasks


def validate_check(task_id: str, check: Any) -> None:
    if not isinstance(check, dict) or check.get("type") not in CHECK_TYPES:
        raise ValueError(f"Task {task_id} has a check whose type is not one of: {', '.join(CHECK_TYPES)}.")
    kind = check["type"]
    if kind == "contains_any":
        values = check.get("values")
        if not isinstance(values, list) or not values or not all(isinstance(value, str) for value in values):
            raise ValueError(f"Task {task_id}: a contains_any check needs a list of strings in 'values'.")
    elif kind in ("max_words", "min_words"):
        if isinstance(check.get("value"), bool) or not isinstance(check.get("value"), int):
            raise ValueError(f"Task {task_id}: a {kind} check needs a whole number in 'value'.")
    elif kind == "regex":
        try:
            re.compile(check.get("pattern", ""))
        except (re.error, TypeError) as error:
            raise ValueError(f"Task {task_id}: a regex check has a bad pattern: {error}") from error
        if not check.get("pattern"):
            raise ValueError(f"Task {task_id}: a regex check needs a 'pattern'.")
    elif not isinstance(check.get("value"), str) or not check["value"]:
        raise ValueError(f"Task {task_id}: a {kind} check needs a string in 'value'.")


# ==============================================================================
# Scoring an answer
# ==============================================================================


def check_passes(answer: str, check: dict[str, Any]) -> bool:
    """Score one check against the answer; text matches ignore case."""
    kind = check["type"]
    lowered = answer.lower()
    if kind == "contains":
        return check["value"].lower() in lowered
    if kind == "contains_any":
        return any(value.lower() in lowered for value in check["values"])
    if kind == "not_contains":
        return check["value"].lower() not in lowered
    if kind == "regex":
        return re.search(check["pattern"], answer, re.IGNORECASE | re.MULTILINE) is not None
    word_count = len(answer.split())
    if kind == "max_words":
        return word_count <= check["value"]
    return word_count >= check["value"]


def describe_check(check: dict[str, Any]) -> str:
    kind = check["type"]
    if kind == "contains_any":
        return f"contains_any {check['values']}"
    if kind == "regex":
        return f"regex {check['pattern']}"
    return f"{kind} {check['value']!r}" if isinstance(check["value"], str) else f"{kind} {check['value']}"


# ==============================================================================
# Running one task on one runner
# ==============================================================================


class CountingModel:
    """Wrap the loaded model to count its calls and the tokens it generates."""

    def __init__(self, llm: Any) -> None:
        self._llm = llm
        self.calls = 0
        self.completion_tokens = 0

    def create_chat_completion(self, **request: Any) -> Any:
        self.calls += 1
        response = self._llm.create_chat_completion(**request)
        if isinstance(response, dict):
            self.completion_tokens += response.get("usage", {}).get("completion_tokens", 0)
        return response

    def __getattr__(self, name: str) -> Any:
        return getattr(self._llm, name)


@dataclass
class RunResult:
    task_id: str
    runner: str
    answer: str = ""
    error: str = ""
    checks_passed: int = 0
    checks_total: int = 0
    failed_checks: list[str] = field(default_factory=list)
    seconds: float = 0.0
    model_calls: int = 0
    completion_tokens: int = 0

    @property
    def passed(self) -> bool:
        return not self.error and self.checks_passed == self.checks_total


def run_task(
    task: EvalTask,
    runner: str,
    llm: Any,
    settings: dict[str, Any],
    seed_store: str | Path | None = None,
) -> RunResult:
    """Answer one task with one runner and score the answer, recording a failure as an error."""
    counting_model = CountingModel(llm)
    label = runner + SEEDED_SUFFIX if seed_store is not None else runner
    result = RunResult(task_id=task.id, runner=label, checks_total=len(task.checks))
    started = time.monotonic()
    # Each run gets its own store, empty or a fresh copy of the seed, so no run sees what an earlier one stored.
    with tempfile.TemporaryDirectory(prefix="smartharness-eval-") as scratch_directory:
        try:
            if seed_store is not None:
                copy_store(seed_store, Path(scratch_directory) / "knowledge.sqlite3")
            result.answer = answer_with(runner, task, counting_model, settings, scratch_directory)
        except Exception as error:
            result.error = f"{type(error).__name__}: {error}"
    result.seconds = round(time.monotonic() - started, 2)
    result.model_calls = counting_model.calls
    result.completion_tokens = counting_model.completion_tokens
    if not result.error:
        for check in task.checks:
            if check_passes(result.answer, check):
                result.checks_passed += 1
            else:
                result.failed_checks.append(describe_check(check))
    return result


def copy_store(seed_store: str | Path, destination: Path) -> None:
    """Copy a knowledge store with SQLite's backup, which also takes what its write-ahead log holds."""
    if not Path(seed_store).is_file():
        raise FileNotFoundError(f"No knowledge store at {seed_store}")
    source = sqlite3.connect(seed_store)
    target = sqlite3.connect(destination)
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()


def answer_with(runner: str, task: EvalTask, llm: Any, settings: dict[str, Any], scratch_directory: str) -> str:
    if runner == "bare":
        return run_stage(
            llm,
            BARE_SYSTEM_PROMPT,
            task.prompt,
            max_tokens=settings["max_tokens"],
            temperature=settings["temperature"],
        )
    options = dict(
        context_size=settings["context_size"],
        max_tokens=settings["max_tokens"],
        temperature=settings["temperature"],
        # The scratch directory stands in for the filesystem, so no task reads the user's own files.
        filesystem_root=scratch_directory,
        max_tool_calls=settings["max_tool_calls"],
        max_search_results=settings["max_search_results"],
        mcp_servers=[],
        knowledge_db_path=str(Path(scratch_directory) / "knowledge.sqlite3"),
        llm=llm,
        mode=task.mode,
        progress_callback=lambda label: None,
    )
    if runner == "tree":
        return execute_task_tree(
            task.prompt,
            **options,
            max_task_depth=settings["max_task_depth"],
            max_task_nodes=settings["max_task_nodes"],
        )
    return execute_pipeline(task.prompt, **options)


# ==============================================================================
# Running the whole set and reporting
# ==============================================================================


def runner_labels(runners: list[str], seed_store: str | Path | None) -> list[str]:
    """List each runner, followed by its seeded run when a seed store is given and it recalls from one."""
    labels = []
    for runner in runners:
        labels.append(runner)
        if seed_store is not None and runner in STORE_RUNNERS:
            labels.append(runner + SEEDED_SUFFIX)
    return labels


def run_eval(
    tasks: list[EvalTask],
    runners: list[str],
    llm: Any,
    settings: dict[str, Any],
    on_result: Callable[[RunResult], None] | None = None,
    seed_store: str | Path | None = None,
) -> list[RunResult]:
    results = []
    for task in tasks:
        for label in runner_labels(runners, seed_store):
            runner = label.removesuffix(SEEDED_SUFFIX)
            result = run_task(task, runner, llm, settings, seed_store if label != runner else None)
            results.append(result)
            if on_result is not None:
                on_result(result)
    return results


def summarize(results: list[RunResult], runners: list[str]) -> dict[str, dict[str, Any]]:
    """Total each runner's passed tasks, passed checks, errors, time, calls, and tokens."""
    summary = {}
    for runner in runners:
        own = [result for result in results if result.runner == runner]
        summary[runner] = {
            "tasks": len(own),
            "tasks_passed": sum(result.passed for result in own),
            "checks_passed": sum(result.checks_passed for result in own),
            "checks_total": sum(result.checks_total for result in own),
            "errors": sum(bool(result.error) for result in own),
            "seconds": round(sum(result.seconds for result in own), 2),
            "model_calls": sum(result.model_calls for result in own),
            "completion_tokens": sum(result.completion_tokens for result in own),
        }
    return summary


def format_summary(summary: dict[str, dict[str, Any]]) -> str:
    header = f"{'runner':<14} {'tasks':>9} {'checks':>9} {'errors':>6} {'seconds':>9} {'calls':>6} {'tokens':>8}"
    lines = [header, "-" * len(header)]
    for runner, totals in summary.items():
        lines.append(
            f"{runner:<14} {totals['tasks_passed']:>4}/{totals['tasks']:<4} "
            f"{totals['checks_passed']:>4}/{totals['checks_total']:<4} {totals['errors']:>6} "
            f"{totals['seconds']:>9.1f} {totals['model_calls']:>6} {totals['completion_tokens']:>8}"
        )
    return "\n".join(lines)


def format_result(result: RunResult) -> str:
    if result.error:
        outcome = f"error: {result.error}"
    elif result.passed:
        outcome = "pass"
    else:
        outcome = f"fail ({'; '.join(result.failed_checks)})"
    return f"[{result.task_id} / {result.runner}] {result.checks_passed}/{result.checks_total} in {result.seconds}s: {outcome}"


# ==============================================================================
# Command line
# ==============================================================================


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="smartharness eval",
        description="Compare the bare model with the pipeline and the task tree on a fixed task set.",
    )
    parser.add_argument("--tasks", default=str(DEFAULT_TASKS_PATH), help="Path to the JSON task set.")
    parser.add_argument("--settings", default=str(default_settings_path()), help="Path to the JSON settings file.")
    parser.add_argument(
        "--runners",
        default=",".join(RUNNER_CHOICES),
        help=f"Comma-separated runners to compare, from: {', '.join(RUNNER_CHOICES)}.",
    )
    parser.add_argument("--only", help="Comma-separated task ids to run instead of the whole set.")
    parser.add_argument("--output", help="Write every answer and score to this JSON file.")
    parser.add_argument(
        "--seed-store",
        help="Also run the pipeline and task tree with a copy of this knowledge store, to measure what recall adds.",
    )
    parser.add_argument("--model-path", help="Path to a GGUF model (overrides settings.json).")
    args = parser.parse_args(argv)

    runners = [name.strip() for name in args.runners.split(",") if name.strip()]
    unknown = [name for name in runners if name not in RUNNER_CHOICES]
    if not runners or unknown:
        parser.error(f"--runners takes names from: {', '.join(RUNNER_CHOICES)}")
    try:
        settings = load_settings(args.settings)
        if args.model_path:
            settings["model_path"] = args.model_path
        settings = validate_settings(settings)
        tasks = load_tasks(args.tasks)
        if args.seed_store:
            args.seed_store = str(Path(args.seed_store).expanduser())
        if args.seed_store and not Path(args.seed_store).is_file():
            raise ValueError(f"No knowledge store at {args.seed_store}")
    except (OSError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    if args.only:
        wanted = {task_id.strip() for task_id in args.only.split(",")}
        missing = wanted - {task.id for task in tasks}
        if missing:
            print(f"Error: no task with id {', '.join(sorted(missing))}.", file=sys.stderr)
            return 1
        tasks = [task for task in tasks if task.id in wanted]

    print(f"Loading model from {settings['model_path']}...")
    try:
        llm = create_model(settings["model_path"], settings["context_size"], settings["gpu_layers"])
    except (OSError, RuntimeError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    results = run_eval(
        tasks,
        runners,
        llm,
        settings,
        on_result=lambda result: print(format_result(result), flush=True),
        seed_store=args.seed_store,
    )
    summary = summarize(results, runner_labels(runners, args.seed_store))
    print()
    print(format_summary(summary))
    if args.output:
        report = {
            "model_path": settings["model_path"],
            "tasks_path": args.tasks,
            "seed_store": args.seed_store,
            "summary": summary,
            "results": [{**asdict(result), "passed": result.passed} for result in results],
        }
        Path(args.output).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(f"\nWrote {args.output}")
    return 0
