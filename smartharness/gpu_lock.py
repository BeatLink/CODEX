"""Share the GPU with other programs through one lock file, so two model loads never crash each other."""

import fcntl
import os
import threading
import time
from collections.abc import Callable
from pathlib import Path

# llama.cpp aborts the whole process when the GPU runs out of memory, so every GPU load takes this lock.
LOCK_PATH_VARIABLE = "SMARTHARNESS_GPU_LOCK"

# How long a load waits for another program to free the GPU before it gives up.
WAIT_TIMEOUT_SECONDS = 1800
POLL_SECONDS = 1.0


def lock_path() -> Path | None:
    """Return the lock file, or None when the variable is set empty to turn the lock off."""
    configured = os.environ.get(LOCK_PATH_VARIABLE)
    if configured is not None:
        return Path(configured) if configured.strip() else None
    runtime_directory = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    return Path(runtime_directory) / "smartharness-gpu.lock"


def _inherited_descriptor(path: Path) -> int | None:
    """Find a descriptor for the lock file that this process inherited, as `flock FILE command` passes one."""
    try:
        names = os.listdir("/proc/self/fd")
    except OSError:
        return None
    for name in names:
        try:
            if Path(os.readlink(f"/proc/self/fd/{name}")) == path:
                return int(name)
        except OSError:
            continue
    return None


class GpuLock:
    """One process's hold on the shared lock, counted so several of its models can share one hold."""

    def __init__(self) -> None:
        self._holders = 0
        self._descriptor: int | None = None
        self._owns_descriptor = False
        self._mutex = threading.Lock()

    def acquire(self, on_wait: Callable[[str], None] | None = None, timeout: float = WAIT_TIMEOUT_SECONDS) -> None:
        with self._mutex:
            if self._holders == 0:
                self._take(on_wait, timeout)
            self._holders += 1

    def release(self) -> None:
        with self._mutex:
            if self._holders == 0:
                return
            self._holders -= 1
            if self._holders == 0 and self._descriptor is not None:
                # An inherited descriptor belongs to the program that started this one, which keeps its lock.
                if self._owns_descriptor:
                    fcntl.flock(self._descriptor, fcntl.LOCK_UN)
                    os.close(self._descriptor)
                self._descriptor = None

    def _take(self, on_wait: Callable[[str], None] | None, timeout: float) -> None:
        path = lock_path()
        if path is None:
            return
        descriptor = _inherited_descriptor(path)
        owns_descriptor = descriptor is None
        if descriptor is None:
            path.parent.mkdir(parents=True, exist_ok=True)
            descriptor = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
        deadline = time.monotonic() + timeout
        told = False
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    if owns_descriptor:
                        os.close(descriptor)
                    raise RuntimeError(f"The GPU stayed in use by another program for {timeout:.0f} seconds ({path}).")
                if on_wait is not None and not told:
                    on_wait("Waiting for the GPU, which another program is using")
                    told = True
                time.sleep(POLL_SECONDS)
        self._descriptor, self._owns_descriptor = descriptor, owns_descriptor


GPU_LOCK = GpuLock()
