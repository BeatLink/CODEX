"""Probe the machine for the environment memory stores: where things are and what software is installed or running.

Every probe is a plain reading of the system, never a model call, so what it records is always what the machine shows.
"""

import os
import platform
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from .knowledge import KnowledgeStore


# ==============================================================================
# Limits
# ==============================================================================

# Filesystems that are views of the kernel or memory rather than places files are kept.
_VIRTUAL_FILESYSTEMS = frozenset(
    "autofs binfmt_misc bpf cgroup cgroup2 configfs debugfs devpts devtmpfs efivarfs fusectl hugetlbfs"
    " mqueue nsfs overlay proc pstore ramfs rpc_pipefs securityfs squashfs sysfs tmpfs tracefs".split()
)
_SYSTEM_PATHS = ("/proc", "/sys", "/dev", "/run", "/nix/store", "/boot")
# Mount points deeper than this are usually bind mounts of single settings, not places worth remembering.
MAX_MOUNT_DEPTH = 2
MAX_MOUNTS = 12
MAX_SERVICES = 25
SERVICES_PER_STATEMENT = 8

# Tools a request is likely to need, checked on PATH.
COMMON_TOOLS = (
    "git", "python3", "pip", "uv", "nix", "node", "npm", "cargo", "rustc", "go", "gcc", "make", "cmake",
    "docker", "podman", "systemctl", "flatpak", "sqlite3", "curl", "rg", "jq", "ffmpeg",
)
SERVICE_TIMEOUT_SECONDS = 5


# ==============================================================================
# Locations
# ==============================================================================


def _user_directories() -> list[str]:
    """Return the desktop's named folders, such as Documents and Downloads, from its user-dirs file."""
    config = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "user-dirs.dirs"
    try:
        lines = config.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return []
    statements = []
    for line in lines:
        name, separator, value = line.partition("=")
        if not separator or not name.startswith("XDG_") or not name.endswith("_DIR"):
            continue
        folder = Path(value.strip().strip('"').replace("$HOME", str(Path.home())))
        if folder.is_dir() and folder != Path.home():
            label = name[len("XDG_"):-len("_DIR")].replace("PUBLICSHARE", "public share").casefold()
            statements.append(f"The user's {label} folder is {folder}.")
    return statements


def _mounted_filesystems() -> list[str]:
    try:
        lines = Path("/proc/mounts").read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    statements = []
    for line in lines:
        fields = line.split()
        if len(fields) < 3:
            continue
        mount_point, filesystem = fields[1].replace("\\040", " "), fields[2]
        if filesystem in _VIRTUAL_FILESYSTEMS or mount_point.startswith(_SYSTEM_PATHS):
            continue
        if len(Path(mount_point).parts) - 1 > MAX_MOUNT_DEPTH or not Path(mount_point).is_dir():
            continue
        statements.append(f"{mount_point} is a mounted {filesystem} filesystem.")
    return list(dict.fromkeys(statements))[:MAX_MOUNTS]


def probe_locations(filesystem_root: str | Path) -> list[str]:
    root = Path(filesystem_root).expanduser().resolve()
    statements = [f"The user's home folder is {Path.home()}.", f"CODEX works in the folder {root}."]
    statements.extend(_user_directories())
    statements.extend(_mounted_filesystems())
    return statements


# ==============================================================================
# Software
# ==============================================================================


def _operating_system() -> str:
    try:
        for line in Path("/etc/os-release").read_text(encoding="utf-8").splitlines():
            if line.startswith("PRETTY_NAME="):
                return line.partition("=")[2].strip().strip('"')
    except OSError:
        pass
    return platform.system()


def _running_services(user: bool) -> list[str]:
    """Return the running systemd services as 'name (description)', or nothing when systemd is not there."""
    if shutil.which("systemctl") is None:
        return []
    command = ["systemctl", *(["--user"] if user else []), "list-units", "--type=service", "--state=running",
               "--no-legend", "--plain"]
    try:
        output = subprocess.run(
            command, capture_output=True, text=True, timeout=SERVICE_TIMEOUT_SECONDS, check=False
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    services = []
    for line in output.splitlines():
        fields = line.split(maxsplit=4)
        # Per-connection D-Bus units come and go with every program, so they say nothing lasting.
        if len(fields) < 4 or fields[0].startswith("dbus-"):
            continue
        name = fields[0].removesuffix(".service")
        description = fields[4] if len(fields) > 4 and fields[4] != fields[0] else ""
        services.append(f"{name} ({description})" if description else name)
    return services[:MAX_SERVICES]


def probe_software() -> list[str]:
    statements = [
        f"The operating system is {_operating_system()}, kernel {platform.release()}, on {platform.machine()}.",
        f"Python {platform.python_version()} runs CODEX from {sys.executable}.",
    ]
    shell = os.environ.get("SHELL")
    if shell:
        statements.append(f"The user's shell is {shell}.")
    desktop = os.environ.get("XDG_CURRENT_DESKTOP")
    if desktop:
        statements.append(f"The desktop is {desktop}.")
    installed = [tool for tool in COMMON_TOOLS if shutil.which(tool)]
    if installed:
        statements.append(f"These commands are installed: {', '.join(installed)}.")
    missing = [tool for tool in COMMON_TOOLS if tool not in installed]
    if missing:
        statements.append(f"These commands are not installed: {', '.join(missing)}.")
    for user, owner in ((False, "system"), (True, "user")):
        services = _running_services(user)
        # A memory holds 500 characters, so a long list is split rather than cut off.
        for start in range(0, len(services), SERVICES_PER_STATEMENT):
            statements.append(f"Running {owner} services: {', '.join(services[start:start + SERVICES_PER_STATEMENT])}.")
    return statements


# ==============================================================================
# Recording
# ==============================================================================


# When each knowledge store was last probed; a daemon that starts again probes once more, which is cheap.
_last_probed_at: dict[str, float] = {}


def refresh_environment(settings: dict[str, Any]) -> bool:
    """Probe the machine again once the last probe is older than the refresh interval, and say whether it did."""
    database = str(settings["knowledge_db_path"])
    interval = settings["background_refresh_interval_hours"] * 3600
    if time.time() - _last_probed_at.get(database, 0.0) < interval:
        return False
    _last_probed_at[database] = time.time()
    store = KnowledgeStore(database)
    store.replace_probed_memories("locations", probe_locations(settings["filesystem_root"]))
    store.replace_probed_memories("software", probe_software())
    return True
