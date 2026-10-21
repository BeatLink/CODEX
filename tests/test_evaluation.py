import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from smartharness.cli import main as cli_main
from smartharness.evaluation import (
    DEFAULT_SEED_PATH,
    DEFAULT_TASKS_PATH,
    RECALL_TASKS_PATH,
    build_seed_store,
    CountingModel,
    EvalTask,
    check_passes,
    load_tasks,
    main,
    run_eval,
    run_task,
    summarize,
)
from smartharness.knowledge import KnowledgeStore
from smartharness.settings import DEFAULT_SETTINGS


class ReplyingModel:
    """Answers every chat completion with the same reply and reports token usage."""

    def __init__(self, reply):
        self.reply = reply

    def create_chat_completion(self, **request):
        return {
            "choices": [{"finish_reason": "stop", "message": {"content": self.reply}}],
            "usage": {"completion_tokens": 7},
        }


def write_tasks(directory, tasks):
    path = Path(directory) / "tasks.json"
    path.write_text(json.dumps(tasks), encoding="utf-8")
    return path


def write_seed_store(directory):
    path = Path(directory) / "seed.sqlite3"
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE notes (text TEXT)")
        connection.execute("INSERT INTO notes VALUES ('seeded')")
    connection.close()
    return path


TASK = {"id": "sum", "prompt": "What is 2 + 2?", "checks": [{"type": "contains", "value": "4"}]}


class LoadTasksTests(unittest.TestCase):
    def test_shipped_task_set_loads(self):
        tasks = load_tasks(DEFAULT_TASKS_PATH)

        self.assertTrue(tasks)
        self.assertEqual(len({task.id for task in tasks}), len(tasks))

    def test_recall_task_set_loads(self):
        self.assertTrue(load_tasks(RECALL_TASKS_PATH))

    def test_rejects_duplicate_ids_bad_checks_and_execute_mode(self):
        bad_sets = [
            [TASK, TASK],
            [{**TASK, "checks": []}],
            [{**TASK, "checks": [{"type": "sounds_right"}]}],
            [{**TASK, "checks": [{"type": "regex", "pattern": "("}]}],
            [{**TASK, "checks": [{"type": "max_words", "value": "ten"}]}],
            [{**TASK, "mode": "execute"}],
        ]
        with tempfile.TemporaryDirectory() as directory:
            for tasks in bad_sets:
                with self.subTest(tasks=tasks), self.assertRaises(ValueError):
                    load_tasks(write_tasks(directory, tasks))


class SeedStoreTests(unittest.TestCase):
    def test_shipped_seed_builds_a_store_that_recalls_its_facts_sources_and_user_memory(self):
        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "seed.sqlite3"
            build_seed_store(DEFAULT_SEED_PATH, database_path)
            store = KnowledgeStore(database_path)
            recalled = store.recall("What TCP port does the Kestrel ingest service listen on?")
            sources = store.search("Kestrel ingest port")
            topics = {topic["name"]: topic for topic in store.topics()}

        self.assertTrue(any("7413" in fact["statement"] for fact in recalled["facts"]))
        self.assertTrue(any("ISO 8601" in memory["statement"] for memory in recalled["user"]))
        self.assertTrue(any("7413" in source["snippet"] for source in sources))
        self.assertEqual(topics["Kestrel ingest"]["parent_id"], topics["Halvorsen Lab"]["id"])

    def test_a_seed_without_facts_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            seed_path = Path(directory) / "seed.json"
            seed_path.write_text(json.dumps({"topics": []}), encoding="utf-8")
            with self.assertRaises(ValueError):
                build_seed_store(seed_path, Path(directory) / "seed.sqlite3")


class CheckTests(unittest.TestCase):
    def test_each_check_type(self):
        answer = "The answer is Carol.\n- red"
        cases = [
            ({"type": "contains", "value": "carol"}, True),
            ({"type": "contains_any", "values": ["Bob", "CAROL"]}, True),
            ({"type": "not_contains", "value": "carol"}, False),
            ({"type": "regex", "pattern": r"^- red$"}, True),
            ({"type": "max_words", "value": 5}, False),
            ({"type": "min_words", "value": 5}, True),
        ]
        for check, expected in cases:
            with self.subTest(check=check):
                self.assertEqual(check_passes(answer, check), expected)


class RunTaskTests(unittest.TestCase):
    def test_bare_runner_scores_answer_and_counts_calls_and_tokens(self):
        task = EvalTask(id="sum", prompt="What is 2 + 2?", checks=[
            {"type": "contains", "value": "4"},
            {"type": "contains", "value": "five"},
        ])

        result = run_task(task, "bare", ReplyingModel("It is 4."), DEFAULT_SETTINGS)

        self.assertEqual(result.answer, "It is 4.")
        self.assertEqual((result.checks_passed, result.checks_total), (1, 2))
        self.assertEqual(result.failed_checks, ["contains 'five'"])
        self.assertFalse(result.passed)
        self.assertEqual((result.model_calls, result.completion_tokens), (1, 7))

    def test_pipeline_runner_gets_an_empty_store_and_a_scratch_root(self):
        seen = {}

        def fake_pipeline(prompt, **options):
            seen.update(options)
            self.assertFalse(Path(options["knowledge_db_path"]).exists())
            return "4"

        task = EvalTask(id="sum", prompt="What is 2 + 2?", checks=[{"type": "contains", "value": "4"}], mode="answer")
        with patch("smartharness.evaluation.execute_pipeline", side_effect=fake_pipeline):
            result = run_task(task, "pipeline", ReplyingModel(""), DEFAULT_SETTINGS)

        self.assertTrue(result.passed)
        self.assertEqual(seen["mode"], "answer")
        self.assertEqual(seen["mcp_servers"], [])
        self.assertEqual(Path(seen["knowledge_db_path"]).parent, Path(seen["filesystem_root"]))
        self.assertIsInstance(seen["llm"], CountingModel)
        self.assertFalse(Path(seen["filesystem_root"]).exists())

    def test_a_seeded_run_answers_from_a_copy_of_the_seed_store(self):
        def fake_pipeline(prompt, **options):
            with sqlite3.connect(options["knowledge_db_path"]) as connection:
                text = connection.execute("SELECT text FROM notes").fetchone()[0]
                connection.execute("DELETE FROM notes")
            connection.close()
            return text

        task = EvalTask(id="seed", prompt="What was stored?", checks=[{"type": "contains", "value": "seeded"}])
        with tempfile.TemporaryDirectory() as directory:
            seed_path = write_seed_store(directory)
            with patch("smartharness.evaluation.execute_pipeline", side_effect=fake_pipeline):
                result = run_task(task, "pipeline", ReplyingModel(""), DEFAULT_SETTINGS, seed_store=seed_path)
            with sqlite3.connect(seed_path) as connection:
                remaining = connection.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
            connection.close()

        self.assertTrue(result.passed)
        self.assertEqual(result.runner, "pipeline+store")
        self.assertEqual(remaining, 1)

    def test_a_seed_store_adds_a_seeded_run_for_each_runner_that_recalls(self):
        task = EvalTask(id="sum", prompt="What is 2 + 2?", checks=[{"type": "contains", "value": "4"}])
        with tempfile.TemporaryDirectory() as directory:
            seed_path = write_seed_store(directory)
            with (
                patch("smartharness.evaluation.execute_pipeline", return_value="4"),
                patch("smartharness.evaluation.execute_task_tree", return_value="4"),
            ):
                results = run_eval([task], ["bare", "pipeline", "tree"], ReplyingModel("4"), DEFAULT_SETTINGS, seed_store=seed_path)

        self.assertEqual(
            [result.runner for result in results],
            ["bare", "pipeline", "pipeline+store", "tree", "tree+store"],
        )

    def test_a_failing_run_is_recorded_as_an_error_and_scores_nothing(self):
        task = EvalTask(id="sum", prompt="What is 2 + 2?", checks=[{"type": "not_contains", "value": "5"}])
        with patch("smartharness.evaluation.execute_task_tree", side_effect=RuntimeError("token limit")):
            result = run_task(task, "tree", ReplyingModel(""), DEFAULT_SETTINGS)

        self.assertEqual(result.error, "RuntimeError: token limit")
        self.assertEqual(result.checks_passed, 0)
        self.assertFalse(result.passed)

    def test_summary_totals_each_runner(self):
        task = EvalTask(id="sum", prompt="What is 2 + 2?", checks=[{"type": "contains", "value": "4"}])
        results = [
            run_task(task, "bare", ReplyingModel("4"), DEFAULT_SETTINGS),
            run_task(task, "bare", ReplyingModel("3"), DEFAULT_SETTINGS),
        ]

        totals = summarize(results, ["bare"])["bare"]

        self.assertEqual((totals["tasks"], totals["tasks_passed"], totals["checks_passed"]), (2, 1, 1))
        self.assertEqual((totals["model_calls"], totals["completion_tokens"]), (2, 14))


class CommandLineTests(unittest.TestCase):
    def test_eval_subcommand_runs_chosen_tasks_and_writes_report(self):
        with tempfile.TemporaryDirectory() as directory:
            tasks_path = write_tasks(directory, [TASK, {**TASK, "id": "other"}])
            output_path = Path(directory) / "report.json"
            with (
                patch("smartharness.evaluation.load_settings", return_value=DEFAULT_SETTINGS.copy()),
                patch("smartharness.evaluation.create_model", return_value=ReplyingModel("4")),
                patch("builtins.print"),
            ):
                exit_code = cli_main([
                    "eval", "--tasks", str(tasks_path), "--runners", "bare",
                    "--only", "sum", "--output", str(output_path),
                ])

            report = json.loads(output_path.read_text(encoding="utf-8"))

        self.assertEqual(exit_code, 0)
        self.assertEqual([result["task_id"] for result in report["results"]], ["sum"])
        self.assertTrue(report["results"][0]["passed"])
        self.assertEqual(report["summary"]["bare"]["tasks_passed"], 1)

    def test_seed_flag_builds_the_store_and_answers_the_recall_tasks_with_and_without_it(self):
        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory) / "report.json"
            with (
                patch("smartharness.evaluation.load_settings", return_value={**DEFAULT_SETTINGS, "embedding_model_path": ""}),
                patch("smartharness.evaluation.create_model", return_value=ReplyingModel("")),
                patch("smartharness.evaluation.execute_pipeline", return_value="7413"),
                patch("builtins.print"),
            ):
                exit_code = main(["--seed", "--runners", "pipeline", "--only", "recall-port", "--output", str(output_path)])
            report = json.loads(output_path.read_text(encoding="utf-8"))

        self.assertEqual(exit_code, 0)
        self.assertEqual(report["tasks_path"], str(RECALL_TASKS_PATH))
        self.assertEqual(set(report["summary"]), {"pipeline", "pipeline+store"})

    def test_unknown_task_id_or_runner_fails_before_loading_the_model(self):
        with tempfile.TemporaryDirectory() as directory:
            tasks_path = write_tasks(directory, [TASK])
            with (
                patch("smartharness.evaluation.load_settings", return_value=DEFAULT_SETTINGS.copy()),
                patch("smartharness.evaluation.create_model") as create_model,
                patch("builtins.print"),
            ):
                self.assertEqual(main(["--tasks", str(tasks_path), "--only", "missing"]), 1)
                with patch("sys.stderr"):
                    self.assertEqual(main(["--tasks", str(tasks_path), "--seed-store", str(Path(directory) / "none")]), 1)
                with self.assertRaises(SystemExit), patch("sys.stderr"):
                    main(["--tasks", str(tasks_path), "--runners", "bare,magic"])

        create_model.assert_not_called()


if __name__ == "__main__":
    unittest.main()
