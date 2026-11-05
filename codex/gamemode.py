"""Tell whether Feral GameMode is active, which is when a game started with `gamemoderun` is running."""

import subprocess

STATUS_COMMAND = ("gamemoded", "-s")
STATUS_TIMEOUT_SECONDS = 3


def game_mode_active(command: tuple[str, ...] = STATUS_COMMAND) -> bool:
    """Return whether GameMode has a game registered; a machine without GameMode never has one."""
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=STATUS_TIMEOUT_SECONDS)
    except (OSError, subprocess.SubprocessError):
        return False
    return result.stdout.strip().lower().startswith("gamemode is active")
