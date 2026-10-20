import tempfile
import threading
from pathlib import Path
from typing import Any

from smartharness.client import DaemonClient
from smartharness.daemon import HarnessDaemon


class RunningDaemon:
    """A daemon serving on a temporary socket inside the test process."""

    def __init__(
        self,
        settings: dict[str, Any],
        settings_path: str | Path | None = None,
        start_worker: bool = False,
        exit_when_unused_seconds: float | None = None,
    ) -> None:
        # Unix socket paths are limited to about 100 characters, so this stays short.
        self.directory = tempfile.TemporaryDirectory(prefix="sh-", dir="/tmp")
        self.socket_path = Path(self.directory.name) / "daemon.sock"
        self.harness = HarnessDaemon(
            settings,
            settings_path or Path(self.directory.name) / "settings.json",
            exit_when_unused_seconds,
        )
        server = self.harness.bind(self.socket_path)
        self.thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()
        if start_worker:
            self.harness.start_background_worker()
        self.clients: list[DaemonClient] = []

    def client(self, on_event: Any = None) -> DaemonClient:
        client = DaemonClient(self.socket_path, on_event)
        client.connect()
        self.clients.append(client)
        return client

    def stop(self) -> None:
        for client in self.clients:
            client.on_event = None
            client.close()
        self.harness.shutdown()
        self.thread.join(timeout=5)
        self.harness.close()
        self.directory.cleanup()


class EventLog:
    """Collects daemon events and waits for one to arrive."""

    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []
        self._condition = threading.Condition()

    def __call__(self, event: str, data: dict[str, Any]) -> None:
        with self._condition:
            self.events.append((event, data))
            self._condition.notify_all()

    def names(self) -> list[str]:
        with self._condition:
            return [event for event, _ in self.events]

    def wait_for(self, name: str, timeout: float = 5) -> dict[str, Any]:
        with self._condition:
            found = self._condition.wait_for(
                lambda: any(event == name for event, _ in self.events), timeout
            )
            if not found:
                raise AssertionError(f"{name} did not arrive; saw {[event for event, _ in self.events]}")
            return next(data for event, data in self.events if event == name)
