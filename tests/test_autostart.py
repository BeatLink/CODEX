import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from codex import autostart


class AutostartTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        environment = patch.dict(os.environ, {"XDG_CONFIG_HOME": self.directory.name})
        environment.start()
        self.addCleanup(environment.stop)
        self.addCleanup(self.directory.cleanup)

    def test_enabling_writes_an_entry_that_starts_in_the_tray_and_disabling_removes_it(self):
        self.assertFalse(autostart.is_enabled())

        with patch("codex.autostart.shutil.which", return_value="/usr/bin/codex-gtk"):
            autostart.enable()

        entry = (Path(self.directory.name) / "autostart" / "org.codex.CODEX.desktop").read_text()
        self.assertIn("Exec=/usr/bin/codex-gtk --background\n", entry)
        self.assertTrue(autostart.is_enabled())

        autostart.disable()
        autostart.disable()

        self.assertFalse(autostart.is_enabled())


if __name__ == "__main__":
    unittest.main()
