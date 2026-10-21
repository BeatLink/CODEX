"""Slash commands: memory commands answered without the model, /init, and commands the user defines in files."""

import re
from dataclasses import dataclass
from pathlib import Path

from .instructions import INSTRUCTIONS_FILE_NAMES, config_directory, project_instructions_path
from .knowledge import USER_MEMORY_KINDS, KnowledgeStore


# ==============================================================================
# Memory commands
# ==============================================================================

MEMORY_COMMANDS = ("/remember", "/forget", "/memories")

# "Why:" starts the reason a remembered statement holds.
_REASON = re.compile(r"\s*\bwhy:\s*", re.IGNORECASE)


def _command_word(user_prompt: str) -> tuple[str, str]:
    """Return the prompt's leading word in lower case and the text after it."""
    parts = user_prompt.strip().split(maxsplit=1)
    if not parts or not parts[0].startswith("/"):
        return "", user_prompt
    return parts[0].casefold(), parts[1].strip() if len(parts) > 1 else ""


def is_memory_command(user_prompt: str) -> bool:
    return _command_word(user_prompt)[0] in MEMORY_COMMANDS


def run_memory_command(user_prompt: str, knowledge_store: KnowledgeStore | None, scope: str) -> str:
    """Carry out /remember, /forget, or /memories and return the reply to show."""
    command, text = _command_word(user_prompt)
    if knowledge_store is None:
        return "There is no knowledge store to keep memories in; set knowledge_db_path in the settings."
    if command == "/remember":
        return _remember(knowledge_store, text, scope)
    if command == "/forget":
        return _forget(knowledge_store, text, scope)
    return _list_memories(knowledge_store, scope)


def _remember(knowledge_store: KnowledgeStore, text: str, scope: str) -> str:
    kinds = ", ".join(USER_MEMORY_KINDS)
    first_word, _, rest = text.partition(" ")
    kind = first_word.casefold().rstrip(":")
    if kind in USER_MEMORY_KINDS:
        text = rest.strip()
    else:
        kind = "preference"
    reason_start = _REASON.search(text)
    statement, reason = (text[:reason_start.start()], text[reason_start.end():]) if reason_start else (text, "")
    statement = statement.strip()
    if not statement:
        return f"Say what to remember, for example: /remember preference Answer in British English. Why: I work in the UK. Kinds: {kinds}."
    # A project memory belongs to the folder it was stated in; everything else holds everywhere.
    memory_scope = scope if kind == "project" else ""
    memory_id = knowledge_store.add_user_memory(kind, statement, reason=reason.strip(), origin="user", scope=memory_scope)
    where = " for this folder" if memory_scope else ""
    return f"Remembered{where} as memory {memory_id} ({kind}): {statement}"


def _forget(knowledge_store: KnowledgeStore, text: str, scope: str) -> str:
    if not text:
        return "Say which memory to forget: its number from /memories, or words from it."
    memories = knowledge_store.user_memories(limit=10_000, scope=scope)
    if text.isdigit():
        matches = [memory for memory in memories if memory["id"] == int(text)]
    else:
        words = text.casefold().split()
        matches = [memory for memory in memories if all(word in memory["statement"].casefold() for word in words)]
    if not matches:
        return f"No memory matches '{text}'. List them with /memories."
    if len(matches) > 1:
        # Deleting cannot be undone, so several matches are listed instead of all being forgotten.
        return "Several memories match; forget one by its number:\n" + _memory_lines(matches)
    knowledge_store.forget_user_memory(matches[0]["id"])
    return f"Forgot memory {matches[0]['id']}: {matches[0]['statement']}"


def _list_memories(knowledge_store: KnowledgeStore, scope: str) -> str:
    memories = knowledge_store.user_memories(limit=10_000, scope=scope)
    if not memories:
        return "No memories yet. Add one with /remember."
    return "Memories for this folder, newest first:\n" + _memory_lines(memories)


def _memory_lines(memories: list[dict]) -> str:
    return "\n".join(
        f"{memory['id']}. ({memory['kind']}"
        + (", this folder" if memory["scope"] else "")
        + (", learned" if memory["origin"] == "learned" else "")
        + f") {memory['statement']}"
        + (f" Why: {memory['reason']}" if memory["reason"] else "")
        for memory in memories
    )


# ==============================================================================
# Commands the user defines
# ==============================================================================

# A command name is one word, so a path such as /etc/hosts at the start of a prompt is never taken for one.
_COMMAND_NAME = re.compile(r"[a-z0-9][a-z0-9_-]*")
_FRONT_MATTER = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
COMMAND_MODES = ("answer", "draft", "execute")


@dataclass
class Command:
    name: str
    description: str
    mode: str | None
    template: str
    path: Path


def command_directories(filesystem_root: str | Path) -> list[Path]:
    """Return where command files live, the folder's own last so they win over global ones of the same name."""
    root = Path(filesystem_root).expanduser().resolve()
    return [config_directory() / "commands", root / ".smartharness" / "commands"]


def load_commands(filesystem_root: str | Path) -> dict[str, Command]:
    commands = {}
    for directory in command_directories(filesystem_root):
        for path in sorted(directory.glob("*.md")) if directory.is_dir() else []:
            command = _read_command(path)
            if command is not None:
                commands[command.name] = command
    return commands


def _read_command(path: Path) -> Command | None:
    name = path.stem.casefold()
    if not _COMMAND_NAME.fullmatch(name) or f"/{name}" in MEMORY_COMMANDS or name == "init":
        return None
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    fields = {}
    front_matter = _FRONT_MATTER.match(text)
    if front_matter:
        for line in front_matter.group(1).splitlines():
            key, separator, value = line.partition(":")
            if separator:
                fields[key.strip().casefold()] = value.strip().strip("\"'")
        text = text[front_matter.end():]
    mode = fields.get("mode", "").casefold() or None
    if mode is not None and mode not in COMMAND_MODES:
        mode = None
    return Command(name, fields.get("description", ""), mode, text.strip(), path)


def _fill_template(template: str, arguments: str) -> str:
    """Put the command's arguments where $ARGUMENTS stands, or after the template when it has no such place."""
    if "$ARGUMENTS" in template:
        return template.replace("$ARGUMENTS", arguments)
    return f"{template}\n\n{arguments}".strip() if arguments else template


# ==============================================================================
# /init
# ==============================================================================

INIT_PROMPT = (
    "Read this folder's README, build and package files, and test setup, then write a short"
    f" {INSTRUCTIONS_FILE_NAMES[0]} for it: how to build it, how to run its tests, how its files are"
    " laid out, and the rules anyone changing it must follow. Give each rule as one short, plain line"
    " under a few headings, and include only what the files show."
)


def _init_prompt(filesystem_root: str | Path, allow_file_writes: bool, arguments: str) -> tuple[str, str]:
    existing = project_instructions_path(filesystem_root)
    prompt = INIT_PROMPT
    if existing is not None:
        prompt += f" {existing.name} already exists: read it, keep what is still right, and improve the rest."
    if allow_file_writes:
        prompt += f" Write the result to {INSTRUCTIONS_FILE_NAMES[0]} at the top of the folder and change no other file."
        mode = "execute"
    else:
        prompt += " Writing files is turned off, so reply with the file's full text only."
        mode = "draft"
    return mode, _fill_template(prompt, arguments)


# ==============================================================================
# Expanding a prompt
# ==============================================================================


def expand_command(user_prompt: str, filesystem_root: str | Path, allow_file_writes: bool) -> tuple[str | None, str]:
    """Return the mode a leading /init or user command picks, or None, and the prompt it expands to.

    A prompt that starts with no such command comes back unchanged.
    """
    command_word, arguments = _command_word(user_prompt)
    name = command_word[1:]
    if name == "init":
        return _init_prompt(filesystem_root, allow_file_writes, arguments)
    if not _COMMAND_NAME.fullmatch(name):
        return None, user_prompt
    command = load_commands(filesystem_root).get(name)
    if command is None:
        return None, user_prompt
    return command.mode, _fill_template(command.template, arguments)
