import fcntl
import os
import subprocess
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from codex.gpu_lock import LOCK_PATH_VARIABLE, GpuLock
from codex.model import create_model

REPOSITORY = Path(__file__).resolve().parent.parent


def held_elsewhere(path):
    """Say whether another open of the lock file would have to wait."""
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return True
    finally:
        os.close(descriptor)
    return False


class GpuLockTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "gpu.lock"
        patcher = patch.dict(os.environ, {LOCK_PATH_VARIABLE: str(self.path)})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.directory.cleanup)

    def test_the_lock_is_held_until_every_holder_in_the_process_releases_it(self):
        lock = GpuLock()
        lock.acquire()
        lock.acquire()
        self.assertTrue(held_elsewhere(self.path))

        lock.release()
        self.assertTrue(held_elsewhere(self.path))
        lock.release()
        self.assertFalse(held_elsewhere(self.path))

    def test_a_load_waits_for_another_program_and_gives_up_after_the_timeout(self):
        # Another process holds the lock, as a second program on the machine would.
        holder = subprocess.Popen(["flock", str(self.path), "sleep", "30"])
        self.addCleanup(holder.kill)
        while not held_elsewhere(self.path):
            time.sleep(0.05)
        waits = []

        with self.assertRaisesRegex(RuntimeError, "stayed in use by another program"):
            GpuLock().acquire(on_wait=waits.append, timeout=0.1)

        self.assertEqual(waits, ["Waiting for the GPU, which another program is using"])

    def test_a_program_started_under_flock_reuses_the_lock_it_inherited(self):
        script = (
            "from codex.gpu_lock import GpuLock\n"
            "lock = GpuLock(); lock.acquire(timeout=2); lock.release(); print('acquired')\n"
        )
        result = subprocess.run(
            ["flock", str(self.path), sys.executable, "-c", script],
            cwd=REPOSITORY, capture_output=True, text=True, timeout=60,
        )

        self.assertEqual(result.stdout.strip(), "acquired", result.stderr)

    def test_an_empty_variable_turns_the_lock_off(self):
        with patch.dict(os.environ, {LOCK_PATH_VARIABLE: ""}):
            lock = GpuLock()
            lock.acquire()

        self.assertFalse(self.path.exists())
        lock.release()


class ModelLockTests(unittest.TestCase):
    def test_only_a_model_with_gpu_layers_holds_the_lock_and_freeing_it_releases_it(self):
        class FakeLlama:
            def __init__(self, **options):
                self.options = options

        with (
            patch.dict(sys.modules, {"llama_cpp": types.SimpleNamespace(Llama=FakeLlama)}),
            patch("codex.model.GPU_LOCK") as lock,
        ):
            create_model("model.gguf", 2048, 0)
            lock.acquire.assert_not_called()

            model = create_model("model.gguf", 2048, -1)
            lock.acquire.assert_called_once()
            lock.release.assert_not_called()
            del model
            lock.release.assert_called_once()


if __name__ == "__main__":
    unittest.main()
