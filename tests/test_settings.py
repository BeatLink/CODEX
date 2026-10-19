import unittest

from smartharness.settings import DEFAULT_SETTINGS, validate_settings


class SettingsTests(unittest.TestCase):
    def test_test_execution_setting_must_be_boolean(self):
        settings = DEFAULT_SETTINGS.copy()
        settings["enable_test_execution"] = "yes"

        with self.assertRaisesRegex(ValueError, "enable_test_execution"):
            validate_settings(settings)


if __name__ == "__main__":
    unittest.main()