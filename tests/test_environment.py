import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from codex import environment
from codex.environment import probe_locations, probe_software, refresh_environment
from codex.knowledge import KnowledgeStore
from user_config import setUpModule, tearDownModule  # The user's own config files never reach these tests.


class EnvironmentProbeTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.settings = {
            "knowledge_db_path": str(self.root / "knowledge.db"),
            "filesystem_root": str(self.root),
            "background_refresh_interval_hours": 24,
        }
        self.addCleanup(environment._last_probed_at.clear)

    def test_locations_name_the_home_and_working_folders(self):
        statements = probe_locations(self.root)

        self.assertIn(f"The user's home folder is {Path.home()}.", statements)
        self.assertIn(f"CODEX works in the folder {self.root.resolve()}.", statements)

    def test_software_lists_installed_and_missing_commands(self):
        with (
            patch("codex.environment.shutil.which", side_effect=lambda tool: "/bin/git" if tool == "git" else None),
            patch.dict("os.environ", {"SHELL": "/bin/fish"}),
        ):
            statements = probe_software()

        self.assertIn("These commands are installed: git.", statements)
        self.assertIn("The user's shell is /bin/fish.", statements)
        self.assertTrue(any(statement.startswith("These commands are not installed: python3") for statement in statements))

    def test_refresh_probes_once_per_interval_and_records_probed_memories(self):
        with patch("codex.environment.probe_software", return_value=["git is installed."]):
            self.assertTrue(refresh_environment(self.settings))
            self.assertFalse(refresh_environment(self.settings))

        memories = KnowledgeStore(self.settings["knowledge_db_path"]).memories(limit=1000)
        self.assertIn(("software", "git is installed.", "probed"), [
            (memory["store"], memory["statement"], memory["origin"]) for memory in memories
        ])
        self.assertTrue(any(memory["store"] == "locations" for memory in memories))


if __name__ == "__main__":
    unittest.main()
