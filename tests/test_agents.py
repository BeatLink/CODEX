import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from codex.agents import (
    claimed_servers,
    load_agents,
    parse_agent,
    servers_for,
    top_level_agents,
)
from user_config import setUpModule, tearDownModule  # The user's own config files never reach these tests.


def server(name):
    return {"name": name, "enabled": True}


class ParseAgentTests(unittest.TestCase):
    def test_front_matter_gives_the_fields_and_the_body_gives_the_instructions(self):
        agent = parse_agent("mail", "---\ndescription: Sends email.\nmcp_servers: [mail, smtp]\nagents:\n  - contacts\n---\nBe brief.\n")
        self.assertEqual(agent.name, "mail")
        self.assertEqual(agent.description, "Sends email.")
        self.assertEqual(agent.mcp_servers, ["mail", "smtp"])
        self.assertEqual(agent.agents, ["contacts"])
        self.assertEqual(agent.instructions, "Be brief.")

    def test_a_single_name_or_comma_separated_string_is_a_list_of_names(self):
        agent = parse_agent("mail", "---\ndescription: Sends email.\nmcp_servers: mail\nagents: contacts, notes\n---\n")
        self.assertEqual(agent.mcp_servers, ["mail"])
        self.assertEqual(agent.agents, ["contacts", "notes"])

    def test_front_matter_that_is_not_valid_yaml_is_not_an_agent(self):
        self.assertIsNone(parse_agent("mail", "---\ndescription: [unclosed\n---\nBe brief."))
        self.assertIsNone(parse_agent("mail", "---\n- just\n- a list\n---\nBe brief."))

    def test_a_file_without_a_description_is_not_an_agent(self):
        self.assertIsNone(parse_agent("mail", "Be brief."))
        self.assertIsNone(parse_agent("mail", "---\nagents: contacts\n---\nBe brief."))


class LoadAgentsTests(unittest.TestCase):
    def test_a_folders_own_agent_replaces_the_global_one_and_unknown_sub_agents_are_dropped(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            global_folder = root / "config" / "codex" / "agents"
            global_folder.mkdir(parents=True)
            (global_folder / "mail.md").write_text("---\ndescription: Global mail.\nagents: ghost, mail, contacts\n---\n")
            (global_folder / "contacts.md").write_text("---\ndescription: Contacts.\n---\n")
            own_folder = root / "project" / ".codex" / "agents"
            own_folder.mkdir(parents=True)
            (own_folder / "mail.md").write_text("---\ndescription: Own mail.\nagents: ghost, mail, contacts\n---\n")

            with patch.dict(os.environ, {"XDG_CONFIG_HOME": str(root / "config")}):
                agents = load_agents(root / "project")

        self.assertEqual(agents["mail"].description, "Own mail.")
        self.assertEqual(agents["mail"].agents, ["contacts"])


class ScopeTests(unittest.TestCase):
    def setUp(self):
        self.agents = {
            "assistant": parse_agent("assistant", "---\ndescription: Does everything.\nagents: mail\n---\n"),
            "mail": parse_agent("mail", "---\ndescription: Email.\nmcp_servers: mail\n---\n"),
            "notes": parse_agent("notes", "---\ndescription: Notes.\nmcp_servers: notes\n---\n"),
        }

    def test_only_agents_nobody_lists_are_offered_at_the_top(self):
        self.assertEqual(top_level_agents(self.agents), ["assistant", "notes"])

    def test_a_server_an_agent_owns_is_withheld_from_everyone_else(self):
        servers = [server("mail"), server("notes"), server("web")]
        self.assertEqual(claimed_servers(self.agents), {"mail", "notes"})
        self.assertEqual([s["name"] for s in servers_for(None, self.agents, servers)], ["web"])
        self.assertEqual([s["name"] for s in servers_for(self.agents["mail"], self.agents, servers)], ["mail"])
