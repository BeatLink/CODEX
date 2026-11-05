import sys
import unittest

from codex.gamemode import game_mode_active


class GameModeTests(unittest.TestCase):
    def test_active_only_when_gamemode_reports_it(self):
        self.assertTrue(game_mode_active((sys.executable, "-c", "print('gamemode is active')")))
        self.assertFalse(game_mode_active((sys.executable, "-c", "print('gamemode is inactive')")))

    def test_a_machine_without_gamemode_has_no_game(self):
        self.assertFalse(game_mode_active(("codex-test-no-such-program",)))


if __name__ == "__main__":
    unittest.main()
