import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from codex.instructions import INSTRUCTIONS_LABEL, MAX_INSTRUCTIONS_CHARS, load_instructions
from codex.task_tree import execute_task_tree
from user_config import setUpModule, tearDownModule  # The user's own config files never reach these tests.


class InstructionsTests(unittest.TestCase):
    def setUp(self):
        temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(temporary_directory.cleanup)
        self.config = Path(temporary_directory.name) / "config"
        self.root = Path(temporary_directory.name) / "project"
        (self.config / "codex").mkdir(parents=True)
        self.root.mkdir()
        environment = patch.dict(os.environ, {"XDG_CONFIG_HOME": str(self.config)})
        environment.start()
        self.addCleanup(environment.stop)

    def test_global_instructions_come_before_the_folder_s_own(self):
        (self.config / "codex" / "CODEX.md").write_text("Answer in British English.\n")
        (self.root / "AGENTS.md").write_text("Run the tests with make check.\n")

        self.assertEqual(load_instructions(self.root), "Answer in British English.\n\nRun the tests with make check.")

    def test_a_folder_s_codex_file_wins_over_its_agents_file(self):
        (self.root / "CODEX.md").write_text("Use tabs.")
        (self.root / "AGENTS.md").write_text("Use spaces.")

        self.assertEqual(load_instructions(self.root), "Use tabs.")

    def test_no_files_give_no_instructions_and_long_ones_are_cut(self):
        self.assertEqual(load_instructions(self.root), "")

        (self.root / "CODEX.md").write_text("x" * (MAX_INSTRUCTIONS_CHARS + 100))

        self.assertLess(len(load_instructions(self.root)), MAX_INSTRUCTIONS_CHARS + 100)

    def test_every_task_tree_call_sees_the_instructions(self):
        (self.root / "CODEX.md").write_text("Never use emoji.")
        inputs = []

        def fake_run_stage(llm, system_prompt, user_input, **kwargs):
            inputs.append(user_input)
            if kwargs.get("json_schema"):
                return json.dumps({"reason": "Simple.", "facts_to_check": [], "approach": "answer",
                                   "search_queries": [], "subtasks": [], "verdict": "met", "problem": ""})
            return "Four."

        with (
            patch("codex.task_tree.run_stage", side_effect=fake_run_stage),
            patch("codex.task_tree.search_with_memory", return_value=("Automatic web search result", "[]", False)),
        ):
            execute_task_tree("What is 2 + 2?", llm=object(), filesystem_root=str(self.root),
                              progress_callback=lambda label: None)

        self.assertTrue(inputs)
        self.assertTrue(all(f"{INSTRUCTIONS_LABEL}:\nNever use emoji." in text for text in inputs))


if __name__ == "__main__":
    unittest.main()
