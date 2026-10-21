import json
import re
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from smartharness.context_budget import CONDENSED_MARKER
from smartharness.knowledge import KnowledgeStore
from smartharness.pipeline import CONDENSE_PROMPT
from smartharness.task_tree import (
    _parse_subtasks,
    CHECK_PROMPT,
    COMBINE_PROMPT,
    DECISION_PROMPT,
    REPLAN_PROMPT,
    REVISE_NOTE,
    ROOT_COMBINE_PROMPT,
    SPLIT_PROMPT,
    TaskNode,
    TaskTree,
    execute_task_tree,
    parse_check,
    parse_decision,
)


def decision(approach, facts=(), queries=(), subtasks=(), clarification=None):
    reply = {
        "reason": "Because.",
        "facts_to_check": list(facts),
        "approach": approach,
        "search_queries": list(queries),
        "subtasks": [
            {"prompt": prompt, "deliverable": f"{prompt} done", "depends_on": list(depends_on)}
            for prompt, depends_on in subtasks
        ],
    }
    if clarification is not None:
        reply["clarification"] = clarification
    return json.dumps(reply)


def check(verdict="met", problem=""):
    return json.dumps({"verdict": verdict, "problem": problem})


def subtasks(*prompts):
    return json.dumps({"subtasks": [
        {"prompt": prompt, "deliverable": f"{prompt} done", "depends_on": []} for prompt in prompts
    ]})


def step_of(system_prompt):
    if system_prompt.startswith(CONDENSE_PROMPT):
        return "condense"
    if system_prompt.startswith(DECISION_PROMPT):
        return "decide"
    if system_prompt.startswith(SPLIT_PROMPT):
        return "split"
    if system_prompt.startswith(REPLAN_PROMPT):
        return "replan"
    if system_prompt.startswith(CHECK_PROMPT):
        return "check"
    if REVISE_NOTE in system_prompt:
        return "revise"
    if system_prompt.startswith((COMBINE_PROMPT, ROOT_COMBINE_PROMPT)):
        return "combine"
    return "write"


class ScriptedModel:
    """Stands in for run_stage, answering each step of each task from a script."""

    def __init__(self, replies):
        self.replies = {key: list(value) if isinstance(value, list) else [value] for key, value in replies.items()}
        self.calls = []

    def __call__(self, llm, system_prompt, user_input, **kwargs):
        step = step_of(system_prompt)
        if step == "condense":
            self.calls.append({"step": step, "task": None, "system": system_prompt, "input": user_input, **kwargs})
            return "Condensed findings."
        task_id = re.search(r"Current task:\nTask (\S+):", user_input).group(1)
        self.calls.append({"step": step, "task": task_id, "system": system_prompt, "input": user_input, **kwargs})
        queued = self.replies.get((step, task_id))
        if not queued:
            if step == "check":
                return check()
            raise AssertionError(f"No scripted reply for {step} of task {task_id}")
        reply = queued.pop(0) if len(queued) > 1 else queued[0]
        if isinstance(reply, Exception):
            raise reply
        return reply

    def steps(self):
        return [(call["step"], call["task"]) for call in self.calls]

    def call(self, step, task):
        return next(call for call in self.calls if call["step"] == step and call["task"] == task)


NOTHING_FOUND = ("Automatic web search result", "[]", False)


def run_tree(replies, prompt="Explain the plan", searches=None, **options):
    model = ScriptedModel(replies)
    progress, trees = [], []
    searches = [] if searches is None else searches

    def fake_search(query, store, toolbox, max_pending):
        searches.append(query)
        return NOTHING_FOUND

    with (
        patch("smartharness.task_tree.run_stage", side_effect=model),
        # Condensing earlier results calls the pipeline's run_stage.
        patch("smartharness.pipeline.run_stage", side_effect=model),
        patch("smartharness.task_tree.search_with_memory", side_effect=fake_search),
        patch("smartharness.task_tree.run_tool_stage", side_effect=AssertionError("tool stage")),
    ):
        result = execute_task_tree(
            prompt,
            llm=object(),
            progress_callback=progress.append,
            tree_callback=trees.append,
            **options,
        )
    return result, model, progress, trees


class DirectTaskTests(unittest.TestCase):
    def test_simple_request_is_decided_written_and_checked(self):
        searches = []
        result, model, progress, trees = run_tree({
            ("decide", "1"): decision("answer"),
            ("write", "1"): "Four.",
        }, prompt="What is 2 + 2?", searches=searches)

        self.assertEqual(result, "Four.")
        self.assertEqual(searches, [])
        self.assertIn("Today's date:\n20", model.call("write", "1")["input"])
        self.assertEqual(model.steps(), [("decide", "1"), ("write", "1"), ("check", "1")])
        self.assertEqual(progress, ["Task 1 · Deciding", "Task 1 · Writing", "Task 1 · Checking"])
        self.assertEqual(trees[-1][0]["status"], "done")
        self.assertEqual(trees[-1][0]["approach"], "answer")

    def test_decision_offers_only_the_approaches_the_settings_allow(self):
        _, model, _, _ = run_tree({("decide", "1"): decision("answer"), ("write", "1"): "Done."})
        offered = model.call("decide", "1")["json_schema"]["properties"]["approach"]["enum"]
        self.assertEqual(offered, ["answer", "research", "files", "decompose"])

        _, model, _, _ = run_tree(
            {("decide", "1"): decision("answer"), ("write", "1"): "Done."},
            allow_file_writes=True,
            max_task_depth=0,
        )
        offered = model.call("decide", "1")["json_schema"]["properties"]["approach"]["enum"]
        self.assertEqual(offered, ["answer", "research", "files", "act"])

    def test_a_top_level_answer_gets_one_quick_search_unless_self_contained(self):
        searches = []
        _, model, _, _ = run_tree({
            ("decide", "1"): decision("answer"),
            ("write", "1"): "I could not look that up.",
        }, prompt="Who maintains Zorblex?", searches=searches)

        self.assertEqual(searches, ["Who maintains Zorblex?"])
        self.assertIn("Every search failed or found nothing", model.call("write", "1")["system"])

    def test_answer_and_draft_modes_never_act_and_a_prefix_picks_the_mode(self):
        _, model, _, _ = run_tree(
            {("decide", "1"): decision("answer"), ("write", "1"): "Plan."},
            prompt="/plan Reorganise the notes folder",
            allow_file_writes=True,
        )

        offered = model.call("decide", "1")["json_schema"]["properties"]["approach"]["enum"]
        self.assertNotIn("act", offered)
        self.assertIn("Original user request:\nReorganise the notes folder", model.call("decide", "1")["input"])

        _, model, _, _ = run_tree(
            {("decide", "1"): decision("answer"), ("write", "1"): "Done."},
            allow_file_writes=True,
            mode="execute",
        )
        self.assertIn("act", model.call("decide", "1")["json_schema"]["properties"]["approach"]["enum"])

    def test_listed_facts_turn_an_answer_into_research(self):
        searches = []

        def fake_search(query, store, toolbox, max_pending):
            searches.append(query)
            return "Local knowledge result", '[{"url": "https://pine64.org", "summary": "A watch"}]', True

        model = ScriptedModel({
            ("decide", "1"): decision("answer", facts=["What a PineTime is"], queries=["PineTime watch"]),
            ("write", "1"): "A watch, per https://pine64.org.",
        })
        with (
            patch("smartharness.task_tree.run_stage", side_effect=model),
            patch("smartharness.task_tree.search_with_memory", side_effect=fake_search),
            patch("smartharness.task_tree.run_tool_stage", side_effect=AssertionError("tool stage")),
        ):
            result = execute_task_tree("What is a PineTime?", llm=object(), progress_callback=lambda label: None)

        self.assertEqual(result, "A watch, per https://pine64.org.")
        # The request's own words are always searched first.
        self.assertEqual(searches, ["What is a PineTime?", "PineTime watch"])
        self.assertNotIn("Every search failed", model.call("write", "1")["system"])
        self.assertIn("captured search evidence", model.call("write", "1")["system"])
        self.assertIn("https://pine64.org", model.call("write", "1")["input"])

    def test_research_without_stored_summaries_runs_the_tool_stage(self):
        tool_calls = []

        def fake_tool_stage(llm, system_prompt, user_input, toolbox, **kwargs):
            tool_calls.append(kwargs)
            return "Finding from https://docs.example/a"

        model = ScriptedModel({
            ("decide", "1"): decision("research", queries=["sqlite wal"]),
            ("write", "1"): "WAL is a journal mode (https://docs.example/a).",
        })
        with (
            patch("smartharness.task_tree.run_stage", side_effect=model),
            patch(
                "smartharness.task_tree.search_with_memory",
                return_value=("Automatic web search result", "[]", False),
            ),
            patch("smartharness.task_tree.run_tool_stage", side_effect=fake_tool_stage),
        ):
            result = execute_task_tree("Explain SQLite WAL", llm=object(), progress_callback=lambda label: None)

        self.assertIn("WAL", result)
        self.assertEqual(tool_calls[0]["allowed_tools"], {"web_search", "web_fetch", "list_directory", "read_file"})
        self.assertIn("Finding from https://docs.example/a", model.call("write", "1")["input"])

    def test_failed_check_revises_once_then_accepts_the_result_as_unverified(self):
        result, model, _, trees = run_tree({
            ("decide", "1"): decision("answer"),
            ("write", "1"): "Draft",
            ("check", "1"): check("partly met", "Add the second part."),
            ("revise", "1"): "Revised",
        }, max_task_depth=0)

        self.assertEqual(result, "Revised")
        self.assertEqual(
            model.steps(),
            [("decide", "1"), ("write", "1"), ("check", "1"), ("revise", "1"), ("check", "1")],
        )
        revise_input = model.call("revise", "1")["input"]
        self.assertIn("Correction needed:\nAdd the second part.", revise_input)
        self.assertIn("Previous attempt:\nDraft", revise_input)
        self.assertEqual(trees[-1][0]["status"], "unverified")

    def test_a_failed_revision_keeps_the_attempt_and_splits_the_task(self):
        result, model, _, trees = run_tree({
            ("decide", "1"): decision("answer"),
            ("write", "1"): "Thin draft",
            ("check", "1"): [check("missing", "Covers one part only."), check()],
            ("revise", "1"): RuntimeError("A pipeline stage reached the token limit"),
            ("split", "1"): subtasks("First part", "Second part"),
            ("decide", "1.1"): decision("answer"),
            ("write", "1.1"): "one",
            ("decide", "1.2"): decision("answer"),
            ("write", "1.2"): "two",
            ("combine", "1"): "One and two",
        })

        self.assertEqual(result, "One and two")
        self.assertIn("Failed attempt:\nThin draft", model.call("split", "1")["input"])
        self.assertIn("The revision failed (A pipeline stage reached the token limit)", model.call("split", "1")["input"])
        self.assertEqual(trees[-1][0]["status"], "done")

    def test_a_task_too_big_to_write_is_split_instead(self):
        result, model, _, _ = run_tree({
            ("decide", "1"): decision("answer"),
            ("write", "1"): RuntimeError("A pipeline stage reached the token limit"),
            ("split", "1"): subtasks("First part", "Second part"),
            ("decide", "1.1"): decision("answer"),
            ("write", "1.1"): "one",
            ("decide", "1.2"): decision("answer"),
            ("write", "1.2"): "two",
            ("combine", "1"): "One and two",
        })

        self.assertEqual(result, "One and two")
        self.assertIn("Writing the whole task in one reply failed", model.call("split", "1")["input"])

    def test_answer_citing_a_url_missing_from_the_evidence_fails_its_check(self):
        _, model, _, _ = run_tree({
            ("decide", "1"): decision("answer"),
            ("write", "1"): "See https://invented.example/page.",
            ("revise", "1"): "Fixed.",
        }, max_task_depth=0)

        self.assertIn(
            "https://invented.example/page, which is not in the captured evidence",
            model.call("revise", "1")["input"],
        )

    def test_researched_result_stating_an_unfound_version_fails_its_check(self):
        def found_rust(query, store, toolbox, max_pending):
            return "Local knowledge result", '[{"summary": "Rust 1.80.0 shipped on 2024-07-25."}]', True

        model = ScriptedModel({
            ("decide", "1"): decision("research", queries=["latest rust"]),
            ("write", "1"): "Rust 1.85.0 shipped on July 25, 2024.",
            ("revise", "1"): "Rust 1.80.0 shipped on July 25, 2024.",
        })
        with (
            patch("smartharness.task_tree.run_stage", side_effect=model),
            patch("smartharness.task_tree.search_with_memory", side_effect=found_rust),
        ):
            result = execute_task_tree(
                "What is the latest Rust?", llm=object(), progress_callback=lambda label: None, max_task_depth=0
            )

        self.assertEqual(result, "Rust 1.80.0 shipped on July 25, 2024.")
        revise_input = model.call("revise", "1")["input"]
        self.assertIn("The result states 1.85.0, which appears in no gathered evidence", revise_input)
        self.assertNotIn("July 25, 2024, which", revise_input)

    def test_unresearched_results_may_state_new_numbers(self):
        _, model, _, _ = run_tree(
            {("decide", "1"): decision("answer"), ("write", "1"): "17 * 3.5 is 59.5."},
            prompt="What is 17 * 3.5?",
        )

        self.assertNotIn(("revise", "1"), model.steps())

    def test_clarification_is_asked_once_and_the_decision_is_made_again(self):
        questions = []
        model = ScriptedModel({
            ("decide", "1"): [decision("answer", clarification="Which format?"), decision("answer")],
            ("write", "1"): "Done in Markdown.",
        })
        with patch("smartharness.task_tree.run_stage", side_effect=model):
            execute_task_tree(
                "Write it up",
                llm=object(),
                progress_callback=lambda label: None,
                clarification_callback=lambda question: questions.append(question) or "Markdown",
            )

        self.assertEqual(questions, ["Which format?"])
        decisions = [call for call in model.calls if call["step"] == "decide"]
        self.assertIn("clarification", decisions[0]["json_schema"]["properties"])
        self.assertNotIn("clarification", decisions[1]["json_schema"]["properties"])
        self.assertIn("Answer: Markdown", model.call("write", "1")["input"])

    def test_an_error_in_the_top_task_fails_the_run(self):
        with self.assertRaises(RuntimeError):
            run_tree(
                {("decide", "1"): decision("answer"), ("write", "1"): RuntimeError("token limit")},
                max_task_depth=0,
            )


class SubtaskTests(unittest.TestCase):
    def test_subtasks_run_in_order_and_dependents_see_earlier_results(self):
        result, model, _, trees = run_tree({
            ("decide", "1"): decision("decompose", subtasks=[("Find the options", []), ("Compare them", [1])]),
            ("decide", "1.1"): decision("answer"),
            ("write", "1.1"): "Options: A and B.",
            ("decide", "1.2"): decision("answer"),
            ("write", "1.2"): "A is simpler than B.",
            ("combine", "1"): "Use A: it is simpler than B.",
        })

        self.assertEqual(result, "Use A: it is simpler than B.")
        self.assertEqual(
            [step for step in model.steps() if step[0] != "check"],
            [
                ("decide", "1"),
                ("decide", "1.1"), ("write", "1.1"),
                ("decide", "1.2"), ("write", "1.2"),
                ("combine", "1"),
            ],
        )
        self.assertIn("Result of task 1.1: Find the options:\nOptions: A and B.", model.call("write", "1.2")["input"])
        self.assertNotIn("Options: A and B.", model.call("write", "1.1")["input"])
        combine_input = model.call("combine", "1")["input"]
        self.assertIn("Result of subtask 1.1", combine_input)
        self.assertIn("A is simpler than B.", combine_input)
        self.assertIn("1.2 [running] Compare them  <- current task", model.call("decide", "1.2")["input"])
        self.assertEqual([node["id"] for node in trees[-1]], ["1", "1.1", "1.2"])
        self.assertEqual({node["status"] for node in trees[-1]}, {"done"})
        self.assertEqual(trees[-1][2]["depends_on"], ["1.1"])

    def test_an_earlier_result_too_big_for_the_window_is_condensed_once(self):
        _, model, progress, _ = run_tree({
            ("decide", "1"): decision("decompose", subtasks=[("Gather notes", []), ("Use the notes", [1])]),
            ("decide", "1.1"): decision("answer"),
            ("write", "1.1"): "note " * 6_000,
            ("decide", "1.2"): decision("answer"),
            ("write", "1.2"): "Used them.",
            ("combine", "1"): "Done.",
        }, context_size=4096, max_tokens=1024)

        self.assertIn(CONDENSED_MARKER + "Condensed findings.", model.call("decide", "1.2")["input"])
        self.assertIn(CONDENSED_MARKER + "Condensed findings.", model.call("write", "1.2")["input"])
        self.assertIn("Original user request:\nExplain the plan", model.call("write", "1.2")["input"])
        self.assertEqual(sum(label == "Task 1.2 · Condensing earlier results" for label in progress), 1)

    def test_subtasks_nest_until_the_depth_limit(self):
        _, model, _, trees = run_tree({
            ("decide", "1"): decision("decompose", subtasks=[("Part one", []), ("Part two", [])]),
            ("decide", "1.1"): decision("decompose", subtasks=[("Piece a", []), ("Piece b", [])]),
            ("decide", "1.1.1"): decision("answer"),
            ("write", "1.1.1"): "a",
            ("decide", "1.1.2"): decision("answer"),
            ("write", "1.1.2"): "b",
            ("combine", "1.1"): "a and b",
            ("decide", "1.2"): decision("answer"),
            ("write", "1.2"): "two",
            ("combine", "1"): "a and b, then two",
        }, max_task_depth=2)

        self.assertEqual([node["id"] for node in trees[-1]], ["1", "1.1", "1.1.1", "1.1.2", "1.2"])
        leaf_options = model.call("decide", "1.1.1")["json_schema"]["properties"]["approach"]["enum"]
        self.assertNotIn("decompose", leaf_options)

    def test_node_limit_caps_how_many_subtasks_are_created(self):
        _, _, _, trees = run_tree({
            ("decide", "1"): decision("decompose", subtasks=[("One", []), ("Two", []), ("Three", [])]),
            ("decide", "1.1"): decision("answer"),
            ("write", "1.1"): "1",
            ("decide", "1.2"): decision("answer"),
            ("write", "1.2"): "2",
            ("combine", "1"): "1 and 2",
        }, max_task_nodes=3)

        self.assertEqual([node["id"] for node in trees[-1]], ["1", "1.1", "1.2"])

    def test_a_task_that_keeps_failing_its_check_is_split_into_subtasks(self):
        result, model, _, trees = run_tree({
            ("decide", "1"): decision("answer"),
            ("write", "1"): "Thin draft",
            ("check", "1"): [check("missing", "Covers nothing."), check("missing", "Still thin."), check()],
            ("revise", "1"): "Thin revision",
            ("split", "1"): subtasks("First half", "Second half"),
            ("decide", "1.1"): decision("answer"),
            ("write", "1.1"): "half one",
            ("decide", "1.2"): decision("answer"),
            ("write", "1.2"): "half two",
            ("combine", "1"): "Both halves",
        })

        self.assertEqual(result, "Both halves")
        self.assertIn("Problem with it:\nStill thin.", model.call("split", "1")["input"])
        self.assertEqual(trees[-1][0]["approach"], "decompose")
        self.assertEqual(trees[-1][0]["status"], "done")

    def test_tasks_made_by_a_failure_split_are_not_split_again(self):
        _, model, _, trees = run_tree({
            ("decide", "1"): decision("answer"),
            ("write", "1"): "Thin draft",
            ("check", "1"): [check("missing", "Thin."), check("missing", "Still thin."), check()],
            ("revise", "1"): "Thin revision",
            ("split", "1"): subtasks("First half", "Second half"),
            ("decide", "1.1"): decision("answer"),
            ("write", "1.1"): "half one",
            ("check", "1.1"): check("missing", "Wrong."),
            ("revise", "1.1"): "half one again",
            ("decide", "1.2"): decision("answer"),
            ("write", "1.2"): "half two",
            ("combine", "1"): "Both halves",
        })

        self.assertNotIn(("split", "1.1"), model.steps())
        self.assertEqual(trees[-1][1]["status"], "unverified")

    def test_a_failed_subtask_is_recorded_and_the_rest_are_replanned(self):
        result, model, _, trees = run_tree({
            ("decide", "1"): decision("decompose", subtasks=[("Read the log", []), ("Summarise it", [1])]),
            ("decide", "1.1"): decision("answer"),
            ("write", "1.1"): RuntimeError("A pipeline stage reached the token limit"),
            ("split", "1.1"): subtasks(),
            ("replan", "1"): subtasks("Summarise what is known"),
            ("decide", "1.2"): decision("answer"),
            ("write", "1.2"): "Nothing could be read.",
            ("combine", "1"): "The log could not be read.",
        })

        self.assertEqual(result, "The log could not be read.")
        nodes = {node["id"]: node for node in trees[-1]}
        self.assertEqual(nodes["1.1"]["status"], "failed")
        self.assertIn("token limit", nodes["1.1"]["note"])
        self.assertEqual(nodes["1.2"]["prompt"], "Summarise what is known")
        self.assertIn("Subtask 1.1 failed", model.call("replan", "1")["input"])
        self.assertIn("(failed: Writing the whole task in one reply failed", model.call("combine", "1")["input"])


class ParsingTests(unittest.TestCase):
    def test_decomposing_into_fewer_than_two_real_subtasks_does_the_task_directly(self):
        node = TaskNode("1", "Plan a trip", "A plan")
        reply = decision("decompose", subtasks=[("Plan a trip", []), ("Book it", [])])

        parsed = parse_decision(reply, node, ["answer", "research", "decompose"])

        self.assertEqual(parsed.approach, "answer")
        self.assertEqual(parsed.subtasks, [])

    def test_malformed_replies_are_rejected(self):
        node = TaskNode("1", "Plan", "A plan")
        self.assertIsNone(parse_decision("not json", node, ["answer"]))
        self.assertIsNone(parse_decision(decision("act"), node, ["answer"]))
        self.assertIsNone(parse_check('{"verdict": "fine"}'))
        self.assertEqual(parse_check(check()), "")
        self.assertEqual(parse_check(check("missing", "Add it.")), "Add it.")

    def test_subtasks_repeating_a_task_in_the_tree_are_dropped_and_numbers_follow(self):
        existing = ["Answer the request", "Find the latest stable Rust release"]
        values = [
            {"prompt": "Find the latest stable Python release", "deliverable": "p", "depends_on": []},
            {"prompt": "Find one latest stable Rust release", "deliverable": "r", "depends_on": []},
            {"prompt": "Find the latest stable Go release", "deliverable": "g", "depends_on": [1, 2]},
            {"prompt": "Tabulate them", "deliverable": "t", "depends_on": [1, 3]},
        ]

        parsed = _parse_subtasks(values, existing)

        self.assertEqual(
            [(task["prompt"], task["depends_on"]) for task in parsed],
            [
                ("Find the latest stable Python release", []),
                ("Find the latest stable Go release", [1]),
                ("Tabulate them", [1, 2]),
            ],
        )

    def test_replanned_subtasks_keep_numbers_of_finished_ones(self):
        values = [{"prompt": "Summarise", "deliverable": "s", "depends_on": [1, 2, 3]}]

        parsed = _parse_subtasks(values, ["Request"], first_number=3)

        self.assertEqual(parsed[0]["depends_on"], [1, 2])

    def test_dependencies_only_point_at_earlier_subtasks(self):
        tree = TaskTree("Request", max_depth=3, max_nodes=20)
        tree.set_children(tree.root, [
            {"prompt": "A", "deliverable": "a", "depends_on": [2]},
            {"prompt": "B", "deliverable": "b", "depends_on": [1, 2, 5]},
        ])

        self.assertEqual([child.depends_on for child in tree.root.children], [[], ["1.1"]])


class RecallTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.database_path = str(Path(self.directory.name) / "knowledge.db")
        self.store = KnowledgeStore(self.database_path)
        self.store.store_search_results("sqlite fts5", [
            {"url": "https://sqlite.example/fts5", "title": "FTS5", "snippet": "Full-text search."},
        ])

    def tearDown(self):
        self.directory.cleanup()

    def test_citing_a_recalled_facts_url_passes_the_check(self):
        self.store.add_fact("SQLite", "SQLite FTS5 ranks matches with bm25.", "https://sqlite.example/fts5")

        _, model, _, _ = run_tree({
            ("decide", "1"): decision("answer"),
            ("write", "1"): "FTS5 ranks with bm25 (https://sqlite.example/fts5).",
        }, prompt="How does SQLite FTS5 rank matches?", knowledge_db_path=self.database_path, max_task_depth=0)

        self.assertIn("https://sqlite.example/fts5", model.call("write", "1")["input"])
        self.assertNotIn(("revise", "1"), model.steps())

    def test_a_subtask_recalls_facts_matching_its_own_prompt(self):
        self.store.add_fact("Rust", "Cargo builds Rust crates and fetches their dependencies.")

        _, model, _, _ = run_tree({
            ("decide", "1"): decision("decompose", subtasks=[("Explain how Cargo builds crates", []), ("Explain the rest", [])]),
            ("decide", "1.1"): decision("answer"),
            ("write", "1.1"): "Cargo builds crates.",
            ("decide", "1.2"): decision("answer"),
            ("write", "1.2"): "The rest.",
            ("combine", "1"): "Both.",
        }, prompt="Write a guide to a new toolchain", knowledge_db_path=self.database_path)

        self.assertIn("Cargo builds Rust crates", model.call("decide", "1.1")["input"])
        self.assertNotIn("Cargo builds Rust crates", model.call("decide", "1")["input"])

    def test_a_search_query_recalls_facts_that_answer_it_without_tools(self):
        self.store.add_fact("Zig", "Zig 0.13.0 was released in June 2024.")

        _, model, _, _ = run_tree({
            ("decide", "1"): decision("decompose", subtasks=[("Describe the newest version", []), ("Explain the rest", [])]),
            ("decide", "1.1"): decision("research", queries=["zig release"]),
            ("write", "1.1"): "Zig 0.13.0 was released in June 2024.",
            ("decide", "1.2"): decision("answer"),
            ("write", "1.2"): "The rest.",
            ("combine", "1"): "Both.",
        }, prompt="Write a guide to a systems language", knowledge_db_path=self.database_path)

        self.assertNotIn("Zig 0.13.0", model.call("decide", "1.1")["input"])
        self.assertIn("Stored facts for 'zig release'", model.call("write", "1.1")["input"])
        self.assertNotIn(("revise", "1.1"), model.steps())


    def test_a_stale_fact_is_flagged_queues_its_topic_and_does_not_answer_the_query(self):
        self.store.add_fact("Zig", "Zig 0.13.0 was released in June 2024.")
        with sqlite3.connect(self.database_path) as connection:
            connection.execute("UPDATE facts SET created_at = 0")

        with patch("smartharness.task_tree.run_tool_stage", return_value="Findings.") as tool_stage:
            model = ScriptedModel({
                ("decide", "1"): decision("decompose", subtasks=[("Describe the newest version", []), ("Explain the rest", [])]),
                ("decide", "1.1"): decision("research", queries=["zig release"]),
                ("write", "1.1"): "A result.",
                ("decide", "1.2"): decision("answer"),
                ("write", "1.2"): "The rest.",
                ("combine", "1"): "Both.",
            })
            with (
                patch("smartharness.task_tree.run_stage", side_effect=model),
                patch("smartharness.task_tree.search_with_memory", return_value=NOTHING_FOUND),
            ):
                execute_task_tree(
                    "Write a guide to a systems language", llm=object(), progress_callback=lambda label: None,
                    knowledge_db_path=self.database_path,
                )

        self.assertIn("may be out of date", model.call("write", "1.1")["input"])
        self.assertEqual(tool_stage.call_count, 1)
        self.assertIn("Zig", [job["topic"] for job in self.store.queue_status() if job["status"] == "pending"])


    def test_a_claim_stating_an_unfound_version_is_queued_for_research(self):
        def found_rust(query, store, toolbox, max_pending):
            return "Local knowledge result", '[{"summary": "Rust 1.80.0 shipped on 2024-07-25."}]', True

        model = ScriptedModel({
            ("decide", "1"): decision("research", queries=["latest rust"]),
            ("write", "1"): "Rust is a language. Rust 1.85.0 is the newest release.",
            ("revise", "1"): "Rust is a language.",
        })
        with (
            patch("smartharness.task_tree.run_stage", side_effect=model),
            patch("smartharness.task_tree.search_with_memory", side_effect=found_rust),
        ):
            execute_task_tree(
                "What is the latest Rust?", llm=object(), progress_callback=lambda label: None,
                max_task_depth=0, knowledge_db_path=self.database_path,
            )

        self.assertEqual(
            [job["topic"] for job in self.store.queue_status()],
            ["Rust 1.85.0 is the newest release."],
        )


class EpisodeTests(unittest.TestCase):
    def test_finished_tree_is_recorded_with_the_episode(self):
        with tempfile.TemporaryDirectory() as directory:
            database_path = str(Path(directory) / "knowledge.db")
            store = KnowledgeStore(database_path)
            store.add_user_memory("preference", "Prefers short answers")
            result, model, _, _ = run_tree(
                {("decide", "1"): decision("answer"), ("write", "1"): "Short."},
                prompt="Say something short",
                knowledge_db_path=database_path,
            )
            episode = store.episodes()[0]

        self.assertIn("Prefers short answers", model.call("decide", "1")["input"])
        self.assertEqual(episode["answer"], "Short.")
        self.assertEqual(episode["task_type"], "answer")
        self.assertIn("1 [done, answer] Say something short", episode["checklist"])
        self.assertEqual(json.loads(episode["task_tree"])[0]["result"], "Short.")
        self.assertEqual(episode["outcome"], "1 of 1 task(s) met their deliverable")


if __name__ == "__main__":
    unittest.main()
