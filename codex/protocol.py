import json
import os
import tempfile
from pathlib import Path
from typing import Any


# Every message is one JSON object on its own line.
# A request is {"id", "method", "params"}; its reply is {"id", "result"} or {"id", "error"}.
# The daemon also sends {"event", "data"} lines to every client at any time.


def default_socket_path() -> Path:
    runtime_directory = os.environ.get("XDG_RUNTIME_DIR")
    if runtime_directory:
        return Path(runtime_directory) / "codex" / "daemon.sock"
    return Path(tempfile.gettempdir()) / f"codex-{os.getuid()}" / "daemon.sock"


def default_log_path() -> Path:
    state_directory = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state")
    return state_directory / "codex" / "daemon.log"


def encode_message(message: dict[str, Any]) -> bytes:
    return (json.dumps(message, ensure_ascii=False, default=str) + "\n").encode("utf-8")


def decode_message(line: bytes) -> dict[str, Any]:
    message = json.loads(line)
    if not isinstance(message, dict):
        raise ValueError("Each message must be a JSON object.")
    return message
