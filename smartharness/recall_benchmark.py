"""Score recall against fixed questions whose relevant stored facts are known, by words alone and by meaning too."""

import argparse
import json
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .embeddings import Embedder, get_embedder
from .evaluation import EVALS_DIRECTORY, build_seed_store
from .knowledge import KnowledgeStore
from .settings import default_settings_path, load_settings

SEED_PATH = EVALS_DIRECTORY / "recall_benchmark_seed.json"
QUESTIONS_PATH = EVALS_DIRECTORY / "recall_benchmark.json"
QUESTION_KINDS = ("shared words", "paraphrase", "several facts", "unrelated")

# Recall returns five facts by default, which is what a request sees.
RECALL_LIMIT = 5


# ==============================================================================
# Questions and results
# ==============================================================================


@dataclass
class Question:
    id: str
    kind: str
    query: str
    expected: list[str]


@dataclass
class Answer:
    question: Question
    recalled: list[str]
    seconds: float

    @property
    def found(self) -> list[str]:
        return [statement for statement in self.question.expected if statement in self.recalled]

    @property
    def first_hit_rank(self) -> int | None:
        """Return the position of the first expected fact among those recalled, counting from 1."""
        return next((rank for rank, statement in enumerate(self.recalled, start=1) if statement in self.question.expected), None)

    @property
    def passed(self) -> bool:
        # An unrelated question passes only when nothing comes back; the rest need one expected fact.
        return not self.recalled if not self.question.expected else bool(self.found)


@dataclass
class Score:
    label: str
    answers: list[Answer] = field(default_factory=list)


def load_questions(questions_path: str | Path) -> list[Question]:
    data = json.loads(Path(questions_path).read_text(encoding="utf-8"))
    if not isinstance(data, list) or not data:
        raise ValueError("The question file must be a non-empty JSON list.")
    questions = []
    for item in data:
        if not isinstance(item, dict) or item.get("kind") not in QUESTION_KINDS:
            raise ValueError(f"Each question needs a kind from: {', '.join(QUESTION_KINDS)}.")
        if not isinstance(item.get("expected"), list) or bool(item["expected"]) == (item["kind"] == "unrelated"):
            raise ValueError(f"Question {item.get('id')} lists expected facts only when it is not unrelated.")
        questions.append(Question(str(item["id"]), item["kind"], str(item["query"]), [str(fact) for fact in item["expected"]]))
    return questions


# ==============================================================================
# Running
# ==============================================================================


def score_recall(seed_path: str | Path, questions: list[Question], embedder: Embedder | None, label: str) -> Score:
    """Build a fresh store from the seed, then recall each question and record what came back."""
    with tempfile.TemporaryDirectory(prefix="smartharness-recall-") as directory:
        database_path = Path(directory) / "seed.sqlite3"
        build_seed_store(seed_path, database_path, embedder)
        store = KnowledgeStore(database_path, embedder)
        statements = {fact["statement"] for fact in store.facts(limit=10_000)}
        missing = [fact for question in questions for fact in question.expected if fact not in statements]
        if missing:
            raise ValueError(f"Expected facts missing from the seed: {missing[0]}")
        score = Score(label)
        for question in questions:
            started = time.perf_counter()
            recalled = store.recall(question.query, limit=RECALL_LIMIT, include_user=False)["facts"]
            score.answers.append(Answer(question, [fact["statement"] for fact in recalled], time.perf_counter() - started))
    return score


def summarize(score: Score) -> dict[str, Any]:
    """Return the pass rate per question kind, the share of expected facts found, the mean reciprocal rank, and timing."""
    summary: dict[str, Any] = {"label": score.label}
    for kind in QUESTION_KINDS:
        answers = [answer for answer in score.answers if answer.question.kind == kind]
        if answers:
            summary[kind] = sum(answer.passed for answer in answers) / len(answers)
    relevant = [answer for answer in score.answers if answer.question.expected]
    summary["facts found"] = (
        sum(len(answer.found) for answer in relevant) / sum(len(answer.question.expected) for answer in relevant)
    )
    summary["mean reciprocal rank"] = sum(1 / (answer.first_hit_rank or float("inf")) for answer in relevant) / len(relevant)
    summary["mean seconds"] = sum(answer.seconds for answer in score.answers) / len(score.answers)
    return summary


def format_table(summaries: list[dict[str, Any]]) -> str:
    rows = [label for label in (*QUESTION_KINDS, "facts found", "mean reciprocal rank", "mean seconds") if label in summaries[0]]
    width = max(len(row) for row in rows) + 2
    lines = [" " * width + "".join(f"{summary['label']:>16}" for summary in summaries)]
    for row in rows:
        cells = "".join(
            f"{summary[row]:>16.2f}" if row in ("mean reciprocal rank", "mean seconds") else f"{summary[row]:>16.0%}"
            for summary in summaries
        )
        lines.append(f"{row:<{width}}{cells}")
    return "\n".join(lines)


def format_failures(score: Score) -> str:
    lines = [f"Failed with {score.label}:"]
    for answer in score.answers:
        if not answer.passed:
            got = "; ".join(answer.recalled) or "nothing"
            lines.append(f"- {answer.question.id} ({answer.question.kind}): got {got}")
    return "\n".join(lines) if len(lines) > 1 else f"No failures with {score.label}."


# ==============================================================================
# Command line
# ==============================================================================


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="smartharness recall-benchmark",
        description="Score recall on fixed questions with known relevant facts, by words alone and by meaning too.",
    )
    parser.add_argument("--seed", default=str(SEED_PATH), help="Seed file of made-up facts (default: evals/recall_benchmark_seed.json).")
    parser.add_argument("--questions", default=str(QUESTIONS_PATH), help="Question file (default: evals/recall_benchmark.json).")
    parser.add_argument("--settings", default=str(default_settings_path()), help="Settings file naming the embedding model.")
    parser.add_argument("--embedding-model-path", help="Embedding GGUF model (overrides the settings file).")
    parser.add_argument("--words-only", action="store_true", help="Skip the run that recalls by meaning.")
    parser.add_argument("--show-failures", action="store_true", help="List what each failed question recalled.")
    args = parser.parse_args(argv)
    try:
        questions = load_questions(args.questions)
        embedding_model_path = args.embedding_model_path or load_settings(args.settings)["embedding_model_path"]
    except (OSError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    runs: list[tuple[str, Embedder | None]] = [("words only", None)]
    if not args.words_only:
        embedder = get_embedder(embedding_model_path)
        if embedder is None:
            print(f"No embedding model at {embedding_model_path}; scoring words only.", file=sys.stderr)
        else:
            runs.append(("with meaning", embedder))
    try:
        scores = [score_recall(args.seed, questions, embedder, label) for label, embedder in runs]
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    print(format_table([summarize(score) for score in scores]))
    if args.show_failures:
        for score in scores:
            print()
            print(format_failures(score))
    return 0
