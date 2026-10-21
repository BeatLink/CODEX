import itertools
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable

from .protocol import decode_message, default_log_path, default_socket_path, encode_message


DAEMON_START_TIMEOUT_SECONDS = 30
# A daemon an interface starts exits this long after its last interface disconnects.
STARTED_DAEMON_EXIT_SECONDS = 30
CALL_TIMEOUT_SECONDS = 30
DISCONNECTED_EVENT = "daemon.disconnected"


class DaemonError(RuntimeError):
    pass


class _PendingCall:
    def __init__(self) -> None:
        self.done = threading.Event()
        self.result: Any = None
        self.error: str | None = None


class DaemonClient:
    """A connection to the daemon; events arrive on a reader thread through on_event."""

    def __init__(
        self,
        socket_path: str | Path | None = None,
        on_event: Callable[[str, dict[str, Any]], None] | None = None,
    ) -> None:
        self.socket_path = Path(socket_path) if socket_path else default_socket_path()
        self.on_event = on_event
        self._socket: socket.socket | None = None
        self._write_lock = threading.Lock()
        self._pending: dict[int, _PendingCall] = {}
        self._pending_lock = threading.Lock()
        self._ids = itertools.count(1)
        self.connected = False

    def connect(self) -> None:
        client_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            client_socket.connect(str(self.socket_path))
        except OSError:
            client_socket.close()
            raise
        self._socket = client_socket
        self.connected = True
        threading.Thread(target=self._read_messages, name="daemon-reader", daemon=True).start()

    def close(self) -> None:
        if self._socket is None:
            return
        try:
            self._socket.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self._socket.close()

    def call(self, method: str, **params: Any) -> Any:
        """Send one request and wait for its reply; never call this from on_event."""
        if not self.connected or self._socket is None:
            raise DaemonError("Not connected to the CODEX daemon.")
        request_id = next(self._ids)
        pending = _PendingCall()
        with self._pending_lock:
            self._pending[request_id] = pending
        try:
            data = encode_message({"id": request_id, "method": method, "params": params})
            with self._write_lock:
                self._socket.sendall(data)
            if not pending.done.wait(CALL_TIMEOUT_SECONDS):
                raise DaemonError(f"The daemon did not answer {method} in time.")
        except OSError as error:
            raise DaemonError(f"Lost the connection to the daemon: {error}") from error
        finally:
            with self._pending_lock:
                self._pending.pop(request_id, None)
        if pending.error is not None:
            raise DaemonError(pending.error)
        return pending.result

    def _read_messages(self) -> None:
        assert self._socket is not None
        try:
            with self._socket.makefile("rb") as reader:
                for line in reader:
                    try:
                        message = decode_message(line)
                    except ValueError:
                        continue
                    if "event" in message:
                        if self.on_event is not None:
                            self.on_event(message["event"], message.get("data") or {})
                        continue
                    with self._pending_lock:
                        pending = self._pending.get(message.get("id"))
                    if pending is not None:
                        pending.result = message.get("result")
                        pending.error = message.get("error")
                        pending.done.set()
        except OSError:
            pass
        finally:
            self.connected = False
            with self._pending_lock:
                waiting = list(self._pending.values())
            for pending in waiting:
                pending.error = "The daemon closed the connection."
                pending.done.set()
            if self.on_event is not None:
                self.on_event(DISCONNECTED_EVENT, {})


# ==============================================================================
# Finding or starting the daemon
# ==============================================================================


def connect_to_daemon(
    socket_path: str | Path | None = None,
    settings_path: str | Path | None = None,
    on_event: Callable[[str, dict[str, Any]], None] | None = None,
    start: bool = True,
) -> DaemonClient:
    """Connect to a running daemon, starting one first when start is true and none answers."""
    client = DaemonClient(socket_path, on_event)
    try:
        client.connect()
        return client
    except (FileNotFoundError, ConnectionRefusedError):
        if not start:
            raise
    process = spawn_daemon(client.socket_path, settings_path)
    deadline = time.monotonic() + DAEMON_START_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        try:
            client.connect()
            return client
        except (FileNotFoundError, ConnectionRefusedError):
            if process.poll() is not None:
                break
            time.sleep(0.1)
    raise DaemonError(
        f"The CODEX daemon did not start; see {default_log_path()}."
    )


def spawn_daemon(socket_path: Path, settings_path: str | Path | None = None) -> subprocess.Popen:
    command = [
        sys.executable,
        "-m",
        "codex.daemon",
        "--socket",
        str(socket_path),
        "--exit-when-unused",
        str(STARTED_DAEMON_EXIT_SECONDS),
    ]
    if settings_path is not None:
        command += ["--settings", str(Path(settings_path).resolve())]
    # The child gets this interpreter's import path, since wrapped installs set it inside the script.
    environment = {**os.environ, "PYTHONPATH": os.pathsep.join(path for path in sys.path if path)}
    log_path = default_log_path()
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("ab") as log_file:
        return subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            env=environment,
            start_new_session=True,
        )
