"""Agents: named specialists a task can hand its work to, each with its own instructions, tools, and sub-agents."""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .instructions import config_directory


# ==============================================================================
# Limits
# ==============================================================================

# Each hand-over loses detail and can misroute, so agents nest only this deep.
MAX_AGENT_DEPTH = 3

# An agent's instructions go into every call it makes, so they are cut like the user's own.
MAX_AGENT_INSTRUCTIONS_CHARS = 2000


# ==============================================================================
# Definitions
# ==============================================================================


@dataclass
class AgentDefinition:
    """One agent: what the parent reads to choose it, and what it works with once chosen."""

    name: str
    description: str
    instructions: str = ""
    mcp_servers: list[str] = field(default_factory=list)
    agents: list[str] = field(default_factory=list)


def agent_directories(filesystem_root: str | Path) -> list[Path]:
    """Return where agent files live, the global folder first so a folder's own file replaces it."""
    root = Path(filesystem_root).expanduser().resolve()
    return [config_directory() / "agents", root / ".codex" / "agents"]


def _names(value: Any) -> list[str]:
    """Read a YAML list of names, or a single name or comma-separated string."""
    items = value if isinstance(value, list) else str(value or "").split(",")
    return [str(item).strip() for item in items if str(item).strip()]


def parse_agent(name: str, text: str) -> AgentDefinition | None:
    """Read one agent file, or return None when it has no description to choose it by."""
    fields: Any = {}
    body = text.strip()
    lines = body.splitlines()
    if lines and lines[0].strip() == "---":
        for index, line in enumerate(lines[1:], start=1):
            if line.strip() == "---":
                try:
                    fields = yaml.safe_load("\n".join(lines[1:index]))
                except yaml.YAMLError:
                    return None
                body = "\n".join(lines[index + 1:]).strip()
                break
    if not isinstance(fields, dict):
        return None
    description = str(fields.get("description") or "").strip()
    if not description:
        return None
    return AgentDefinition(
        name=name,
        description=description,
        instructions=body[:MAX_AGENT_INSTRUCTIONS_CHARS],
        mcp_servers=_names(fields.get("mcp_servers")),
        agents=_names(fields.get("agents")),
    )


def load_agents(filesystem_root: str | Path) -> dict[str, AgentDefinition]:
    """Return every agent by name; a sub-agent that does not exist is dropped from its parent's list."""
    agents: dict[str, AgentDefinition] = {}
    for directory in dict.fromkeys(agent_directories(filesystem_root)):
        for path in sorted(directory.glob("*.md")) if directory.is_dir() else []:
            try:
                agent = parse_agent(path.stem, path.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError):
                continue
            if agent is not None:
                agents[agent.name] = agent
    for agent in agents.values():
        agent.agents = [name for name in agent.agents if name in agents and name != agent.name]
    return agents


# ==============================================================================
# Who can be handed what
# ==============================================================================


def top_level_agents(agents: dict[str, AgentDefinition]) -> list[str]:
    """Return the agents no other agent lists, which the request's own tasks can hand work to."""
    listed = {name for agent in agents.values() for name in agent.agents}
    return [name for name in agents if name not in listed]


def claimed_servers(agents: dict[str, AgentDefinition]) -> set[str]:
    """Return the MCP servers some agent owns, which no other run may use."""
    return {name for agent in agents.values() for name in agent.mcp_servers}


def servers_for(agent: AgentDefinition | None, agents: dict[str, AgentDefinition], servers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return the MCP servers a run may use: the agent's own, or those no agent owns at the top."""
    if agent is not None:
        return [server for server in servers if server["name"] in agent.mcp_servers]
    claimed = claimed_servers(agents)
    return [server for server in servers if server["name"] not in claimed]
