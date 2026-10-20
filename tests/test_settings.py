import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from smartharness import settings as settings_module
from smartharness.settings import (
    DEFAULT_SETTINGS,
    default_settings_path,
    mcp_servers_from_json,
    mcp_servers_to_json,
    validate_settings,
)


class SettingsTests(unittest.TestCase):
    def test_show_thinking_defaults_to_enabled_and_must_be_boolean(self):
        self.assertIs(DEFAULT_SETTINGS["show_thinking"], True)

        settings = DEFAULT_SETTINGS.copy()
        settings["show_thinking"] = "yes"

        with self.assertRaisesRegex(ValueError, "show_thinking"):
            validate_settings(settings)

    def test_mode_defaults_to_auto_and_must_be_known(self):
        self.assertEqual(DEFAULT_SETTINGS["mode"], "auto")

        settings = DEFAULT_SETTINGS.copy()
        settings["mode"] = "chat"

        with self.assertRaisesRegex(ValueError, "mode"):
            validate_settings(settings)

    def test_test_execution_setting_must_be_boolean(self):
        settings = DEFAULT_SETTINGS.copy()
        settings["enable_test_execution"] = "yes"

        with self.assertRaisesRegex(ValueError, "enable_test_execution"):
            validate_settings(settings)

    def test_file_writes_default_to_disabled_and_must_be_boolean(self):
        self.assertIs(DEFAULT_SETTINGS["allow_file_writes"], False)

        settings = DEFAULT_SETTINGS.copy()
        settings["allow_file_writes"] = "yes"

        with self.assertRaisesRegex(ValueError, "allow_file_writes"):
            validate_settings(settings)

    def test_background_settings_are_bounded_and_boolean(self):
        settings = DEFAULT_SETTINGS.copy()
        settings["background_poll_interval_seconds"] = 0

        with self.assertRaisesRegex(ValueError, "background_poll_interval_seconds"):
            validate_settings(settings)

        settings = DEFAULT_SETTINGS.copy()
        settings["background_research_enabled"] = "yes"
        with self.assertRaisesRegex(ValueError, "background_research_enabled"):
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
                "transport": "sse",
                "url": "http://127.0.0.1:8000/sse",
                "allowed_tools": ["search"],
            }
        ]

        with self.assertRaisesRegex(ValueError, "unsupported transport"):
            validate_settings(settings)

    def test_http_mcp_server_takes_a_url_and_headers(self):
        settings = DEFAULT_SETTINGS.copy()
        settings["mcp_servers"] = [
            {
                "name": "trilium",
                "transport": "http",
                "url": "http://127.0.0.1:37840/mcp",
                "headers": {"Authorization": "Bearer ${TRILIUM_ETAPI_TOKEN}"},
                "allowed_tools": ["search_notes"],
            }
        ]

        validated = validate_settings(settings)["mcp_servers"][0]

        self.assertEqual(validated["url"], "http://127.0.0.1:37840/mcp")
        self.assertNotIn("command", validated)

    def test_http_mcp_server_rejects_stdio_fields_and_bad_urls(self):
        for server, message in (
            ({"url": "http://127.0.0.1/mcp", "command": "server"}, "cannot set: command"),
            ({"url": "file:///tmp/socket"}, "url must be"),
            ({"url": "http://127.0.0.1/mcp", "headers": {"Bad Header": "x"}}, "header name"),
        ):
            settings = DEFAULT_SETTINGS.copy()
            settings["mcp_servers"] = [
                {"name": "remote", "transport": "http", "allowed_tools": ["search"], **server}
            ]
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                validate_settings(settings)

    def test_enabled_mcp_server_must_allow_tools(self):
        settings = DEFAULT_SETTINGS.copy()
        settings["mcp_servers"] = [
            {"name": "empty", "command": "server", "allowed_tools": []}
        ]

        with self.assertRaisesRegex(ValueError, "at least one tool"):
            validate_settings(settings)

    def test_settings_fall_back_to_the_user_config_file(self):
        with tempfile.TemporaryDirectory() as directory:
            current_directory = os.getcwd()
            os.chdir(directory)
            try:
                user_path = Path(directory) / "config" / "settings.json"
                with patch.object(
                    settings_module, "DEFAULT_SETTINGS_PATH", Path(directory) / "missing.json"
                ), patch.object(settings_module, "USER_SETTINGS_PATH", user_path):
                    self.assertEqual(default_settings_path(), user_path)
                    Path("settings.json").write_text("{}", encoding="utf-8")
                    self.assertEqual(default_settings_path().resolve(), (Path(directory) / "settings.json").resolve())
            finally:
                os.chdir(current_directory)


class McpServersJsonTests(unittest.TestCase):
    def test_edited_json_is_read_back_and_checked(self):
        servers = [
            {
                "name": "docs",
                "transport": "stdio",
                "command": "docs-mcp-server",
                "allowed_tools": ["search_docs"],
            }
        ]

        read_back = mcp_servers_from_json(mcp_servers_to_json(servers))

        self.assertEqual(read_back[0]["allowed_tools"], ["search_docs"])
        self.assertEqual(mcp_servers_from_json("  "), [])
        with self.assertRaisesRegex(ValueError, "valid JSON"):
            mcp_servers_from_json("[{")


if __name__ == "__main__":
    unittest.main()