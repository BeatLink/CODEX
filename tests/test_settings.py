import unittest

from smartharness.settings import DEFAULT_SETTINGS, validate_settings


class SettingsTests(unittest.TestCase):
    def test_show_thinking_defaults_to_enabled_and_must_be_boolean(self):
        self.assertIs(DEFAULT_SETTINGS["show_thinking"], True)

        settings = DEFAULT_SETTINGS.copy()
        settings["show_thinking"] = "yes"

        with self.assertRaisesRegex(ValueError, "show_thinking"):
            validate_settings(settings)

    def test_test_execution_setting_must_be_boolean(self):
        settings = DEFAULT_SETTINGS.copy()
        settings["enable_test_execution"] = "yes"

        with self.assertRaisesRegex(ValueError, "enable_test_execution"):
            validate_settings(settings)

    def test_mcp_servers_require_stdio_and_an_allowlist(self):
        settings = DEFAULT_SETTINGS.copy()
        settings["mcp_servers"] = [
            {
                "name": "local_docs",
                "command": "uvx",
                "args": ["example-mcp-server"],
                "allowed_tools": ["search_docs"],
            }
        ]

        validated = validate_settings(settings)

        self.assertEqual(validated["mcp_servers"][0]["transport"], "stdio")
        self.assertEqual(validated["mcp_servers"][0]["enabled"], True)

    def test_mcp_settings_reject_unsupported_transport(self):
        settings = DEFAULT_SETTINGS.copy()
        settings["mcp_servers"] = [
            {
                "name": "remote",
                "transport": "http",
                "command": "server",
                "allowed_tools": ["search"],
            }
        ]

        with self.assertRaisesRegex(ValueError, "unsupported transport"):
            validate_settings(settings)

    def test_enabled_mcp_server_must_allow_tools(self):
        settings = DEFAULT_SETTINGS.copy()
        settings["mcp_servers"] = [
            {"name": "empty", "command": "server", "allowed_tools": []}
        ]

        with self.assertRaisesRegex(ValueError, "at least one tool"):
            validate_settings(settings)


if __name__ == "__main__":
    unittest.main()