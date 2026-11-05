import unittest

try:
    from codex.tray import MenuItem, Tray
except (ImportError, ValueError):
    Tray = None


@unittest.skipIf(Tray is None, "PyGObject is not installed")
class TrayMenuTests(unittest.TestCase):
    def setUp(self):
        self.chosen = []
        items = [
            MenuItem("Show", lambda: self.chosen.append("show")),
            MenuItem(None),
            MenuItem("Research", lambda: self.chosen.append("research"), checked=True),
            MenuItem("Status", None),
        ]
        self.tray = Tray("CODEX", "icon", lambda: items, lambda: None)
        self.tray._current = self.tray._items()

    def test_layout_lists_each_entry_with_its_kind_and_state(self):
        root, _properties, children = self.tray.layout().unpack()

        self.assertEqual(root, 0)
        self.assertEqual([child[0] for child in children], [1, 2, 3, 4])
        self.assertEqual(children[0][1]["label"], "Show")
        self.assertEqual(children[1][1], {"type": "separator"})
        self.assertEqual(children[2][1]["toggle-state"], 1)
        self.assertFalse(children[3][1]["enabled"])

    def test_choosing_an_entry_runs_its_action_and_ignores_unknown_ones(self):
        self.tray.choose(3)
        self.tray.choose(4)
        self.tray.choose(99)

        self.assertEqual(self.chosen, ["research"])


if __name__ == "__main__":
    unittest.main()
