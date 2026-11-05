"""Start the GTK interface when the user logs in, through an XDG autostart entry."""

import os
import shutil
import sys
from pathlib import Path

ENTRY_NAME = "org.codex.CODEX.desktop"
BACKGROUND_FLAG = "--background"


def entry_path() -> Path:
    configured = os.environ.get("XDG_CONFIG_HOME")
    base = Path(configured) if configured else Path.home() / ".config"
    return base / "autostart" / ENTRY_NAME


def is_enabled() -> bool:
    return entry_path().exists()


def _launch_command() -> str:
    # The command on the path survives updates, where this process's own path may be a replaced store path.
    program = shutil.which("codex-gtk") or sys.argv[0]
    return f"{program} {BACKGROUND_FLAG}"


def enable() -> None:
    path = entry_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "[Desktop Entry]\n"
        "Type=Application\n"
        "Name=CODEX\n"
        "Comment=Local LLM harness, started in the system tray\n"
        f"Exec={_launch_command()}\n"
        "Icon=applications-science\n"
        "Terminal=false\n"
        "X-GNOME-Autostart-enabled=true\n"
    )


def disable() -> None:
    entry_path().unlink(missing_ok=True)
