import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from smartharness.commands import expand_command, load_commands, run_memory_command
from smartharness.knowledge import KnowledgeStore
from smartharness.task_tree import execute_task_tree


class CommandTestCase(unittest.TestCase):
    def setUp(self):
        temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(temporary_directory.cleanup)
        base = Path(temporary_directory.name)
        self.config = base / "config"
        self.root = base / "project"
        self.root.mkdir()
        self.database = base / "knowledge.db"
        self.store = KnowledgeStore(self.database)
        environment = patch.dict(os.environ, {"XDG_CONFIG_HOME": str(self.config)})
        environment.start()
        self.addCleanup(environment.stop)

    def write_command(self, directory, name, text):
        directory.mkdir(parents=True, exist_ok=True)
        (directory / f"{name}.md").write_text(text)


class MemoryCommandTests(CommandTestCase):
    def remember(self, text):
        return run_memory_command(f"/remember {text}", self.store, str(self.root))

    def test_remember_stores_a_stated_preference_with_its_reason(self):
        reply = self.remember("Answer in British English. Why: I work in the UK.")

        [memory] = self.store.user_memories()
        self.assertIn("Remembered", reply)
        self.assertEqual(
            (memory["kind"], memory["statement"], memory["reason"], memory["origin"], memory["scope"]),
            ("preference", "Answer in British English.", "I work in the UK.", "user", ""),
        )

    def test_a_remembered_project_belongs_to_this_folder(self):
        self.remember("project: Porting the parser to Zig")

        [memory] = self.store.user_memories()
        self.assertEqual((memory["kind"], memory["scope"]), ("project", str(self.root)))

    def test_forget_by_words_asks_for_a_number_when_several_match(self):
        self.remember("Use tabs in Go")
        self.remember("Use tabs in Make")

        reply = run_memory_command("/forget use tabs", self.store, str(self.root))
        self.assertIn("Several memories match", reply)
        self.assertEqual(len(self.store.user_memories()), 2)

        run_memory_command("/forget tabs make", self.store, str(self.root))
        self.assertEqual([memory["statement"] for memory in self.store.user_memories()], ["Use tabs in Go"])

    def test_memories_lists_them_and_forget_takes_a_number(self):
        self.remember("reference Docs live at https://example.test/docs")
        memory_id = self.store.user_memories()[0]["id"]

        self.assertIn(f"{memory_id}. (reference) Docs live", run_memory_command("/memories", self.store, str(self.root)))
        run_memory_command(f"/forget {memory_id}", self.store, str(self.root))
        self.assertIn("No memories yet", run_memory_command("/memories", self.store, str(self.root)))

    def test_the_runner_answers_memory_commands_without_a_model(self):
        with patch("smartharness.task_tree.load_model", side_effect=AssertionError("model loaded")):
            reply = execute_task_tree("/remember Prefers short answers", knowledge_db_path=str(self.database),
                                      filesystem_root=str(self.root))
        self.assertIn("Prefers short answers", reply)
        self.assertEqual(len(self.store.user_memories()), 1)


class UserCommandTests(CommandTestCase):
    def test_a_command_file_fills_in_its_arguments_and_picks_its_mode(self):
        self.write_command(self.config / "smartharness" / "commands", "review", (
            "---\ndescription: Review some code\nmode: draft\n---\nReview this for bugs: $ARGUMENTS\n"
        ))

        self.assertEqual(
            expand_command("/review parser.py", self.root, allow_file_writes=False),
            ("draft", "Review this for bugs: parser.py"),
        )

    def test_the_folder_s_command_wins_and_arguments_follow_a_template_without_a_place(self):
        self.write_command(self.config / "smartharness" / "commands", "summary", "Summarize globally.")
        self.write_command(self.root / ".smartharness" / "commands", "summary", "Summarize this folder.")

        self.assertEqual(load_commands(self.root)["summary"].mode, None)
        self.assertEqual(
            expand_command("/summary briefly", self.root, allow_file_writes=False),
            (None, "Summarize this folder.\n\nbriefly"),
        )

    def test_unknown_commands_and_paths_are_left_alone(self):
        self.assertEqual(expand_command("/etc/hosts is wrong", self.root, False), (None, "/etc/hosts is wrong"))
        self.assertEqual(expand_command("/nothing here", self.root, False), (None, "/nothing here"))

    def test_init_writes_the_file_only_when_writing_is_allowed(self):
        self.assertEqual(expand_command("/init", self.root, allow_file_writes=True)[0], "execute")
        mode, prompt = expand_command("/init", self.root, allow_file_writes=False)
        self.assertEqual(mode, "draft")
        self.assertIn("reply with the file's full text", prompt)

        (self.root / "AGENTS.md").write_text("Old rules.")
        self.assertIn("AGENTS.md already exists", expand_command("/init", self.root, False)[1])

    def test_the_runner_works_the_expanded_prompt(self):
        self.write_command(self.root / ".smartharness" / "commands", "explain", "---\nmode: answer\n---\nExplain $ARGUMENTS simply.")
        inputs = []

        def fake_run_stage(llm, system_prompt, user_input, **kwargs):
            inputs.append(user_input)
            if kwargs.get("json_schema"):
                return ('{"reason": "Simple.", "facts_to_check": [], "approach": "answer", "search_queries": [],'
                        ' "subtasks": [], "verdict": "met", "problem": ""}')
            return "Simply put."

        with (
            patch("smartharness.task_tree.run_stage", side_effect=fake_run_stage),
            patch("smartharness.task_tree.search_with_memory", return_value=("Automatic web search result", "[]", False)),
        ):
            execute_task_tree("/explain recursion", llm=object(), filesystem_root=str(self.root),
                              progress_callback=lambda label: None)

        self.assertIn("Original user request:\nExplain recursion simply.", inputs[0])


if __name__ == "__main__":
    unittest.main()
