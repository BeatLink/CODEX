import argparse
import itertools
import os
import signal
import socket
import socketserver
import sys
import threading
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable

from .auto_size import auto_size
from .background import learn_from_episodes, research_one_topic
from .knowledge import KnowledgeStore
from .pipeline import ModelCache, execute_pipeline
from .protocol import decode_message, default_socket_path, encode_message
from .settings import default_settings_path, load_settings, save_settings, validate_settings


class RunCancelled(Exception):
    pass


# ==============================================================================
# Connections and run state
# ==============================================================================


class ClientConnection:
    """One connected interface; writes from several threads share its lock."""

    def __init__(self, client_socket: socket.socket) -> None:
        self.socket = client_socket
        self.closed = False
        self._write_lock = threading.Lock()

    def send(self, message: dict[str, Any]) -> None:
        data = encode_message(message)
        with self._write_lock:
            if self.closed:
                return
            try:
                self.socket.sendall(data)
            except OSError:
                self.closed = True


class Clarification:
    def __init__(self, clarification_id: int, question: str) -> None:
        self.id = clarification_id
        self.question = question
        self.answer = ""
        self.answered = threading.Event()


class ActiveRun:
    def __init__(self, run_id: int, prompt: str, owner: ClientConnection | None) -> None:
        self.id = run_id
        self.prompt = prompt
        self.owner = owner
        self.cancel_requested = threading.Event()
        self.progress: list[str] = []
        self.outputs: dict[str, str] = {}
        self.clarification: Clarification | None = None

    def snapshot(self) -> dict[str, Any]:
        return {
            "run_id": self.id,
            "prompt": self.prompt,
            "progress": list(self.progress),
            "outputs": dict(self.outputs),
        }


# ==============================================================================
# Daemon
# ==============================================================================


class HarnessDaemon:
    """Owns the model, runs requests and background research, and serves interfaces over a socket."""

    def __init__(
        self,
        settings: dict[str, Any],
        settings_path: str | Path | None = None,
        exit_when_unused_seconds: float | None = None,
    ) -> None:
        self.settings = validate_settings(settings.copy())
        self.exit_when_unused_seconds = exit_when_unused_seconds
        self._unused_timer: threading.Timer | None = None
        self.settings_path = Path(settings_path).expanduser() if settings_path else default_settings_path()
        self._lock = threading.RLock()
        self._clients: set[ClientConnection] = set()
        self._run: ActiveRun | None = None
        self._run_ids = itertools.count(1)
        self._clarification_ids = itertools.count(1)
        self._model_lock = threading.Lock()
        self._model_cache = ModelCache()
        self._knowledge_stores: dict[str, KnowledgeStore] = {}
        self._stop = threading.Event()
        self._worker_wakeup = threading.Event()
        self._background_run_requested = threading.Event()
        self._background_status = "Idle"
        self._background_output = ""
        self._worker: threading.Thread | None = None
        self._server: socketserver.ThreadingUnixStreamServer | None = None
        self._methods: dict[str, Callable[..., Any]] = {
            "status": self.status,
            "get_settings": self.get_settings,
            "apply_settings": self.apply_settings,
            "save_settings": self.save_settings,
            "auto_size": self.auto_size,
            "set_background_enabled": self.set_background_enabled,
            "run": self.start_run,
            "cancel": self.cancel_run,
            "answer_clarification": self.answer_clarification,
            "queue_topic": self.queue_topic,
            "research_now": self.research_now,
            "queue_status": self.queue_status,
            "knowledge": self.knowledge,
            "shutdown": self.shutdown,
        }

    # ==========================================================================
    # Lifecycle
    # ==========================================================================

    def start_background_worker(self) -> None:
        self._worker = threading.Thread(target=self._background_loop, name="background-research", daemon=True)
        self._worker.start()

    def bind(self, socket_path: str | Path) -> socketserver.ThreadingUnixStreamServer:
        path = Path(socket_path)
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if path.exists():
            if _socket_answers(path):
                raise RuntimeError(f"A SmartHarness daemon is already listening on {path}.")
            path.unlink()
        self._server = _SocketServer(str(path), self)
        os.chmod(path, 0o600)
        self._schedule_unused_exit()
        return self._server

    def shutdown(self, connection: ClientConnection | None = None) -> dict[str, Any]:
        self._stop.set()
        self._worker_wakeup.set()
        with self._lock:
            if self._run is not None:
                self._run.cancel_requested.set()
        if self._server is not None:
            # serve_forever waits for shutdown(), so it must be called from another thread.
            threading.Thread(target=self._server.shutdown, daemon=True).start()
        return {}

    def _schedule_unused_exit(self) -> None:
        """Start the countdown to exit, when this daemon exits once no interface is connected."""
        if self.exit_when_unused_seconds is None:
            return
        with self._lock:
            if self._clients or self._unused_timer is not None:
                return
            self._unused_timer = threading.Timer(self.exit_when_unused_seconds, self._exit_if_unused)
            self._unused_timer.daemon = True
            self._unused_timer.start()

    def _exit_if_unused(self) -> None:
        with self._lock:
            self._unused_timer = None
            if self._clients:
                return
        self.shutdown()

    def close(self) -> None:
        self._stop.set()
        self._worker_wakeup.set()
        if self._server is not None:
            socket_path = Path(self._server.server_address)
            self._server.server_close()
            socket_path.unlink(missing_ok=True)
        with self._lock:
            clients = list(self._clients)
        for client in clients:
            try:
                client.socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    # ==========================================================================
    # Connections and events
    # ==========================================================================

    def serve_client(self, client_socket: socket.socket, reader: Any) -> None:
        connection = ClientConnection(client_socket)
        with self._lock:
            self._clients.add(connection)
            if self._unused_timer is not None:
                self._unused_timer.cancel()
                self._unused_timer = None
        try:
            for line in reader:
                if not line.strip():
                    continue
                self._dispatch(connection, line)
        except OSError:
            pass
        finally:
            connection.closed = True
            with self._lock:
                self._clients.discard(connection)
                run = self._run
            # A run belongs to the interface that started it, so it stops when that interface leaves.
            if run is not None and run.owner is connection:
                run.cancel_requested.set()
            self._schedule_unused_exit()

    def _dispatch(self, connection: ClientConnection, line: bytes) -> None:
        try:
            message = decode_message(line)
        except ValueError as error:
            connection.send({"id": None, "error": f"Invalid message: {error}"})
            return
        request_id = message.get("id")
        method = self._methods.get(message.get("method", ""))
        params = message.get("params") or {}
        try:
            if method is None:
                raise ValueError(f"Unknown method: {message.get('method')}")
            if not isinstance(params, dict):
                raise ValueError("params must be a JSON object.")
            result = method(connection, **params)
        except Exception as error:
            connection.send({"id": request_id, "error": str(error)})
        else:
            connection.send({"id": request_id, "result": result})

    def broadcast(self, event: str, **data: Any) -> None:
        with self._lock:
            clients = list(self._clients)
        for client in clients:
            client.send({"event": event, "data": data})

    # ==========================================================================
    # Settings and status
    # ==========================================================================

    def status(self, connection: ClientConnection | None = None) -> dict[str, Any]:
        with self._lock:
            return {
                "settings": self.settings.copy(),
                "settings_path": str(self.settings_path),
                "run": self._run.snapshot() if self._run is not None else None,
                "background": {"status": self._background_status, "output": self._background_output},
            }

    def get_settings(self, connection: ClientConnection | None = None) -> dict[str, Any]:
        with self._lock:
            return self.settings.copy()

    def apply_settings(self, connection: ClientConnection | None = None, settings: dict[str, Any] | None = None) -> dict[str, Any]:
        validated = validate_settings({**self.get_settings(), **(settings or {})})
        with self._lock:
            self.settings = validated
        self._worker_wakeup.set()
        self.broadcast("settings.changed", settings=validated)
        return validated

    def save_settings(self, connection: ClientConnection | None = None, settings: dict[str, Any] | None = None) -> dict[str, Any]:
        validated = self.apply_settings(connection, settings)
        saved = save_settings(self.settings_path, validated)
        return {"settings": saved, "path": str(self.settings_path)}

    def auto_size(
        self, connection: ClientConnection | None = None, model_path: str = "", gpu_layers: int = -1
    ) -> dict[str, Any]:
        """Suggest a context size and token limits for a model on this machine, without applying them."""
        settings = self.get_settings()
        model_path = model_path or settings["model_path"]
        loaded = self._model_cache.has(model_path, settings["context_size"], gpu_layers)
        return asdict(auto_size(model_path, gpu_layers, settings["context_size"] if loaded else None))

    def set_background_enabled(self, connection: ClientConnection | None = None, enabled: bool = True) -> dict[str, Any]:
        return self.apply_settings(connection, {"background_research_enabled": bool(enabled)})

    # ==========================================================================
    # Foreground run
    # ==========================================================================

    def start_run(
        self,
        connection: ClientConnection | None = None,
        prompt: str = "",
        settings: dict[str, Any] | None = None,
        interactive: bool = True,
    ) -> dict[str, Any]:
        prompt = prompt.strip()
        if not prompt:
            raise ValueError("The prompt cannot be empty.")
        run_settings = validate_settings({**self.get_settings(), **(settings or {})})
        with self._lock:
            if self._run is not None:
                raise RuntimeError("Another request is already running.")
            run = ActiveRun(next(self._run_ids), prompt, connection)
            self._run = run
        self._worker_wakeup.set()
        self.broadcast("run.started", run_id=run.id, prompt=prompt)
        threading.Thread(
            target=self._execute_run,
            args=(run, run_settings, interactive),
            name=f"run-{run.id}",
            daemon=True,
        ).start()
        return {"run_id": run.id}

    def cancel_run(self, connection: ClientConnection | None = None, run_id: int | None = None) -> dict[str, Any]:
        with self._lock:
            run = self._run
        if run is None or (run_id is not None and run.id != run_id):
            return {"cancelled": False}
        run.cancel_requested.set()
        return {"cancelled": True}

    def answer_clarification(
        self,
        connection: ClientConnection | None = None,
        run_id: int = 0,
        clarification_id: int = 0,
        answer: str = "",
    ) -> dict[str, Any]:
        with self._lock:
            run = self._run
            clarification = run.clarification if run is not None and run.id == run_id else None
        if clarification is None or clarification.id != clarification_id:
            return {"accepted": False}
        clarification.answer = answer
        clarification.answered.set()
        return {"accepted": True}

    def _execute_run(self, run: ActiveRun, settings: dict[str, Any], interactive: bool) -> None:
        def raise_if_cancelled() -> None:
            if run.cancel_requested.is_set() or self._stop.is_set():
                raise RunCancelled

        def report_progress(label: str) -> None:
            raise_if_cancelled()
            run.progress.append(label)
            self.broadcast("run.progress", run_id=run.id, label=label)

        def report_token(label: str, token: str) -> None:
            raise_if_cancelled()
            run.outputs[label] = run.outputs.get(label, "") + token
            self.broadcast("run.token", run_id=run.id, label=label, token=token)

        def ask_clarification(question: str) -> str:
            clarification = Clarification(next(self._clarification_ids), question)
            run.clarification = clarification
            # Only the interface that started the run is asked.
            if run.owner is not None:
                run.owner.send(
                    {
                        "event": "run.clarification",
                        "data": {
                            "run_id": run.id,
                            "clarification_id": clarification.id,
                            "question": question,
                        },
                    }
                )
            try:
                while not clarification.answered.wait(0.2):
                    raise_if_cancelled()
            finally:
                run.clarification = None
            return clarification.answer

        event, data = "run.finished", {}
        try:
            with self._model_lock:
                data["result"] = execute_pipeline(
                    run.prompt,
                    model_path=settings["model_path"],
                    context_size=settings["context_size"],
                    gpu_layers=settings["gpu_layers"],
                    max_tokens=settings["max_tokens"],
                    temperature=settings["temperature"],
                    filesystem_root=settings["filesystem_root"],
                    max_tool_calls=settings["max_tool_calls"],
                    max_search_results=settings["max_search_results"],
                    enable_test_execution=settings["enable_test_execution"],
                    allow_file_writes=settings["allow_file_writes"],
                    mcp_servers=settings["mcp_servers"],
                    knowledge_db_path=settings["knowledge_db_path"],
                    max_pending_research_jobs=settings["background_max_pending_jobs"],
                    show_thinking=False,
                    clarification_callback=ask_clarification if interactive else None,
                    progress_callback=report_progress,
                    stage_output_callback=report_token,
                    model_cache=self._model_cache,
                )
        except RunCancelled:
            event = "run.cancelled"
        except Exception as error:
            event, data = "run.failed", {"message": str(error)}
        # The run is cleared first so a client may start the next one as soon as it hears this one ended.
        with self._lock:
            self._run = None
        self._worker_wakeup.set()
        self.broadcast(event, run_id=run.id, **data)

    # ==========================================================================
    # Background research
    # ==========================================================================

    def queue_topic(self, connection: ClientConnection | None = None, topic: str = "", priority: int = 0) -> dict[str, Any]:
        topic = topic.strip()
        if not topic:
            raise ValueError("Enter a topic to research.")
        if isinstance(priority, bool) or not isinstance(priority, int):
            raise ValueError("priority must be an integer.")
        settings = self.get_settings()
        job_id = self._knowledge_store(settings["knowledge_db_path"]).enqueue_topic(
            topic,
            priority=priority,
            max_pending=settings["background_max_pending_jobs"],
        )
        self._worker_wakeup.set()
        self.broadcast("queue.changed")
        return {"job_id": job_id}

    def research_now(self, connection: ClientConnection | None = None) -> dict[str, Any]:
        jobs = self.queue_status()
        if not any(job["status"] == "pending" for job in jobs):
            raise ValueError("Queue a topic before starting research.")
        self._background_run_requested.set()
        self._worker_wakeup.set()
        return {}

    def queue_status(self, connection: ClientConnection | None = None) -> list[dict[str, Any]]:
        return self._knowledge_store(self.get_settings()["knowledge_db_path"]).queue_status()

    def _set_background_status(self, message: str) -> None:
        with self._lock:
            if message == self._background_status:
                return
            self._background_status = message
            if message.startswith("Searching:"):
                self._background_output = ""
        self.broadcast("background.status", message=message)

    def _append_background_token(self, token: str) -> None:
        with self._lock:
            self._background_output += token
        self.broadcast("background.token", token=token)

    def _run_is_active(self) -> bool:
        with self._lock:
            return self._run is not None

    def _background_loop(self) -> None:
        while not self._stop.is_set():
            settings = self.get_settings()
            manual_run_requested = self._background_run_requested.is_set()
            if not settings["background_research_enabled"] and not manual_run_requested:
                self._set_background_status("Paused")
                wait_seconds = settings["background_poll_interval_seconds"]
            elif self._run_is_active():
                self._set_background_status("Foreground prompt active")
                wait_seconds = 1
            else:
                if manual_run_requested:
                    self._background_run_requested.clear()
                try:
                    self._knowledge_store(settings["knowledge_db_path"]).enqueue_due_topics(
                        settings["background_refresh_interval_hours"],
                        settings["background_max_pending_jobs"],
                    )
                    worker_options = {
                        "on_progress": self._set_background_status,
                        "on_token": self._append_background_token,
                        "should_pause": lambda: self._run_is_active() or self._stop.is_set(),
                        "model_lock": self._model_lock,
                        "model_cache": self._model_cache,
                    }
                    # Queued research comes first; with none left, the worker learns from past requests.
                    worked = research_one_topic(settings, **worker_options) or learn_from_episodes(
                        settings, **worker_options
                    )
                    self.broadcast("queue.changed")
                    if worked:
                        self.broadcast("knowledge.changed")
                        wait_seconds = 0.2
                    else:
                        self._set_background_status("Idle")
                        wait_seconds = settings["background_poll_interval_seconds"]
                except Exception as error:
                    self._set_background_status(f"Worker error: {error}")
                    wait_seconds = settings["background_poll_interval_seconds"]
            self._worker_wakeup.wait(wait_seconds)
            self._worker_wakeup.clear()

    # ==========================================================================
    # Knowledge
    # ==========================================================================

    def knowledge(
        self,
        connection: ClientConnection | None = None,
        query: str = "",
        topic_id: int | None = None,
    ) -> dict[str, Any]:
        store = self._knowledge_store(self.get_settings()["knowledge_db_path"])
        query = query.strip()
        return {
            "topics": store.topics(),
            "sources": store.search(query) if query else store.sources(topic_id, limit=30),
            "graph": store.graph(),
        }

    def _knowledge_store(self, database_path: str) -> KnowledgeStore:
        with self._lock:
            store = self._knowledge_stores.get(database_path)
            if store is None:
                store = KnowledgeStore(database_path)
                self._knowledge_stores[database_path] = store
            return store


# ==============================================================================
# Socket server
# ==============================================================================


class _ClientHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        self.server.harness.serve_client(self.request, self.rfile)


class _SocketServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True

    def __init__(self, socket_path: str, harness: HarnessDaemon) -> None:
        self.harness = harness
        super().__init__(socket_path, _ClientHandler)


def _socket_answers(path: Path) -> bool:
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        probe.connect(str(path))
    except OSError:
        return False
    finally:
        probe.close()
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the SmartHarness daemon that interfaces connect to.")
    parser.add_argument(
        "--settings",
        default=str(default_settings_path()),
        help="Path to the JSON settings file.",
    )
    parser.add_argument(
        "--socket",
        default=str(default_socket_path()),
        help="Path of the Unix socket to listen on.",
    )
    parser.add_argument(
        "--exit-when-unused",
        type=float,
        metavar="SECONDS",
        help="Exit once no interface has been connected for this long.",
    )
    args = parser.parse_args(argv)
    try:
        settings = load_settings(args.settings)
        if os.getenv("MODEL_PATH"):
            settings["model_path"] = os.environ["MODEL_PATH"]
        harness = HarnessDaemon(settings, args.settings, args.exit_when_unused)
        server = harness.bind(args.socket)
    except (OSError, RuntimeError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1

    def stop(signal_number: int, frame: Any) -> None:
        harness.shutdown()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    harness.start_background_worker()
    print(f"SmartHarness daemon listening on {args.socket}", file=sys.stderr, flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        harness.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
