"""Keep tests away from the user's own instructions and command files under ~/.config/codex."""

import os
import tempfile
from unittest.mock import patch

_config_directory = None
_environment = None


def setUpModule():
    global _config_directory, _environment
    _config_directory = tempfile.TemporaryDirectory()
    _environment = patch.dict(os.environ, {"XDG_CONFIG_HOME": _config_directory.name})
    _environment.start()


def tearDownModule():
    _environment.stop()
    _config_directory.cleanup()
