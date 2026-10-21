"""Read the standing instructions the user writes for every request, and the commands they define."""

import os
from pathlib import Path


# ==============================================================================
# Where the user's files live
# ==============================================================================

# A folder's instructions file; the first of these names found in the folder is read.
INSTRUCTIONS_FILE_NAMES = ("CODEX.md", "AGENTS.md")

# Instructions go into every model call, so they are kept short enough to leave room for the work itself.
MAX_INSTRUCTIONS_CHARS = 4000

INSTRUCTIONS_LABEL = "Standing instructions from the user"


def config_directory() -> Path:
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "codex"


def global_instructions_path() -> Path:
    return config_directory() / INSTRUCTIONS_FILE_NAMES[0]


def project_instructions_path(filesystem_root: str | Path) -> Path | None:
    """Return the folder's instructions file, or None when it has none."""
    root = Path(filesystem_root).expanduser().resolve()
    for name in INSTRUCTIONS_FILE_NAMES:
        if (root / name).is_file():
            return root / name
    return None


# ==============================================================================
# Reading the instructions
# ==============================================================================


def load_instructions(filesystem_root: str | Path) -> str:
    """Return the global instructions, then the folder's own, or an empty string when there are none."""
    paths = [global_instructions_path(), project_instructions_path(filesystem_root)]
    parts = []
    for path in dict.fromkeys(path for path in paths if path is not None):
        try:
            text = path.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeDecodeError):
            continue
        if text:
            parts.append(text)
    instructions = "\n\n".join(parts)
    if len(instructions) > MAX_INSTRUCTIONS_CHARS:
        instructions = instructions[:MAX_INSTRUCTIONS_CHARS] + "\n[Cut: the instructions are longer than the limit.]"
    return instructions
