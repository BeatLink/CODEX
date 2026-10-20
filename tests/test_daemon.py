import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from daemon_harness import EventLog, RunningDaemon

from smartharness.client import DaemonError
from smartharness.daemon import HarnessDaemon
from smartharness.knowledge import KnowledgeStore
from smartharness.settings import DEFAULT_SETTINGS, load_settings


class DaemonTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.settings = DEFAULT_SETTINGS.copy()
        self.settings["knowledge_db_path"] = str(Path(self.directory.name) / "knowledge.db")
        self.settings["background_research_enabled"] = False
        # These tests patch the eight-stage pipeline, so they run in pipeline mode.
        self.settings["runner"] = "pipeline"
        self.settings_path = Path(self.directory.name) / "settings.json"

    def tearDown(self):
        self.directory.cleanup()

    def start(self, start_worker=False):
        daemon = RunningDaemon(self.settings, self.settings_path, start_worker=start_worker)
        self.addCleanup(daemon.stop)
        return daemon

    def test_run_streams_progress_and_tokens_then_the_result(self):
        def fake_pipeline(prompt, **kwargs):
            kwargs["progress_callback"]("Stage 1/8: Identifying the task and constraints")
            kwargs["stage_output_callback"]("Stage 1/8: Identifying the task and constraints", "token")
            return f"Answer to {prompt}"

        with patch("smartharness.daemon.execute_pipeline", side_effect=fake_pipeline) as pipeline:
            daemon = self.start()
            events = EventLog()
            client = daemon.client(events)
            run_id = client.call("run", prompt="Draft a plan", settings={"max_tokens": 512})["run_id"]
            finished = events.wait_for("run.finished")

        self.assertEqual(finished, {"run_id": run_id, "result": "Answer to Draft a plan"})
        self.assertEqual(
            events.names(), ["run.started", "run.progress", "run.token", "run.finished"]
        )
        self.assertEqual(pipeline.call_args.kwargs["max_tokens"], 512)
        self.assertEqual(daemon.harness.settings["max_tokens"], DEFAULT_SETTINGS["max_tokens"])
        self.assertIsNone(client.call("status")["run"])

    def test_tree_run_broadcasts_the_tree_and_keeps_it_for_late_interfaces(self):
        tree = [{"id": "1", "prompt": "Draft a plan", "status": "running"}]
        late_status = []

        def fake_task_tree(prompt, **kwargs):
            kwargs["tree_callback"](tree)
            late_status.append(daemon.client().call("status")["run"])
            return "Tree answer"

        with patch("smartharness.daemon.execute_task_tree", side_effect=fake_task_tree) as task_tree:
            daemon = self.start()
            events = EventLog()
            client = daemon.client(events)
            client.call("run", prompt="Draft a plan", settings={"runner": "tree", "max_task_depth": 1})
            finished = events.wait_for("run.finished")

        self.assertEqual(finished["result"], "Tree answer")
        self.assertEqual(events.wait_for("run.started")["runner"], "tree")
        self.assertEqual(events.wait_for("run.tree")["nodes"], tree)
        self.assertEqual(task_tree.call_args.kwargs["max_task_depth"], 1)
        self.assertEqual(late_status[0]["runner"], "tree")
        self.assertEqual(late_status[0]["tree"], tree)

    def test_clarification_is_asked_of_the_owner_and_answered(self):
        answers = []

        def asking_pipeline(prompt, **kwargs):
            answers.append(kwargs["clarification_callback"]("Which format?"))
            return "done"

        with patch("smartharness.daemon.execute_pipeline", side_effect=asking_pipeline):
            daemon = self.start()
            owner_events, watcher_events = EventLog(), EventLog()
            owner = daemon.client(owner_events)
            daemon.client(watcher_events)
            run_id = owner.call("run", prompt="Draft a plan")["run_id"]
            question = owner_events.wait_for("run.clarification")
            self.assertEqual(question["question"], "Which format?")
            owner.call(
                "answer_clarification",
                run_id=run_id,
                clarification_id=question["clarification_id"],
                answer="Markdown",
            )
            watcher_events.wait_for("run.finished")

        self.assertEqual(answers, ["Markdown"])
        self.assertNotIn("run.clarification", watcher_events.names())

    def test_cancel_and_a_lost_owner_both_stop_the_run(self):
        started = threading.Event()

        def endless_pipeline(prompt, **kwargs):
            while True:
                started.set()
                kwargs["stage_output_callback"]("Stage 2/8: Researching and inspecting relevant files", "x")
                time.sleep(0.01)

        with patch("smartharness.daemon.execute_pipeline", side_effect=endless_pipeline):
            daemon = self.start()
            events = EventLog()
            client = daemon.client(events)
            client.call("run", prompt="first")
            self.assertTrue(started.wait(5))
            with self.assertRaisesRegex(DaemonError, "already running"):
                client.call("run", prompt="second")
            self.assertTrue(client.call("cancel")["cancelled"])
            events.wait_for("run.cancelled")

            started.clear()
            leaving = daemon.client()
            leaving.call("run", prompt="third")
            self.assertTrue(started.wait(5))
            leaving.close()
            for _ in range(100):
                if client.call("status")["run"] is None:
                    break
                time.sleep(0.05)
            self.assertIsNone(client.call("status")["run"])

    def test_failed_run_reports_its_message(self):
        with patch("smartharness.daemon.execute_pipeline", side_effect=RuntimeError("tool exploded")):
            daemon = self.start()
            events = EventLog()
            daemon.client(events).call("run", prompt="Draft a plan")
            self.assertEqual(events.wait_for("run.failed")["message"], "tool exploded")

    def test_settings_are_applied_to_every_client_and_saved(self):
        daemon = self.start()
        events = EventLog()
        daemon.client(events)
        client = daemon.client()

        saved = client.call("save_settings", settings={"max_tool_calls": 7})

        self.assertEqual(saved["path"], str(self.settings_path))
        self.assertEqual(load_settings(self.settings_path)["max_tool_calls"], 7)
        self.assertEqual(events.wait_for("settings.changed")["settings"]["max_tool_calls"], 7)
        with self.assertRaisesRegex(DaemonError, "max_tool_calls"):
            client.call("apply_settings", settings={"max_tool_calls": 50})

    def test_auto_size_counts_the_loaded_model_and_leaves_settings_alone(self):
        from smartharness.auto_size import SizeChoice

        daemon = self.start()
        client = daemon.client()
        choice = SizeChoice(14336, 3584, 1792, "Tiny")

        with (
            patch("smartharness.daemon.auto_size", return_value=choice) as sizer,
            patch.object(daemon.harness._model_cache, "has", return_value=True),
        ):
            result = client.call("auto_size", model_path="tiny.gguf", gpu_layers=-1)

        self.assertEqual(result["context_size"], 14336)
        self.assertEqual(sizer.call_args.args, ("tiny.gguf", -1, self.settings["context_size"]))
        self.assertEqual(client.call("get_settings")["context_size"], self.settings["context_size"])

    def test_research_now_runs_a_queued_topic_while_idle_research_is_paused(self):
        researched = threading.Event()

        def fake_research(settings, **kwargs):
            KnowledgeStore(settings["knowledge_db_path"]).claim_job()
            researched.set()
            return True

        with patch("smartharness.daemon.research_one_topic", side_effect=fake_research):
            daemon = self.start(start_worker=True)
            client = daemon.client()
            with self.assertRaisesRegex(DaemonError, "Queue a topic"):
                client.call("research_now")
            client.call("queue_topic", topic="Local model RAG", priority=4)
            self.assertEqual(client.call("queue_status")[0]["topic"], "Local model RAG")
            client.call("research_now")
            self.assertTrue(researched.wait(5))

    def test_knowledge_returns_topics_sources_and_graph(self):
        KnowledgeStore(self.settings["knowledge_db_path"]).store_search_results(
            "Docker builds",
            [{"title": "Docker guide", "url": "https://example.test/docker", "snippet": "Multi-stage builds."}],
            topic="Docker",
        )
        client = self.start().client()

        knowledge = client.call("knowledge", query="Docker builds")

        self.assertEqual([topic["name"] for topic in knowledge["topics"]], ["Docker"])
        self.assertEqual(knowledge["sources"][0]["url"], "https://example.test/docker")
        self.assertEqual(knowledge["graph"][0]["relation"], "supported_by")

    def test_bind_replaces_a_stale_socket_but_not_a_live_one(self):
        daemon = self.start()
        with self.assertRaisesRegex(RuntimeError, "already listening"):
            HarnessDaemon(self.settings).bind(daemon.socket_path)

        stale_path = daemon.socket_path.with_name("stale.sock")
        stale = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        stale.bind(str(stale_path))
        stale.close()
        replacement = HarnessDaemon(self.settings)
        replacement.bind(stale_path)
        replacement.close()
        self.assertFalse(stale_path.exists())

    def test_daemon_exits_once_no_interface_stays_connected(self):
        daemon = RunningDaemon(self.settings, self.settings_path, exit_when_unused_seconds=0.3)
        self.addCleanup(daemon.stop)
        client = daemon.client()
        time.sleep(0.6)
        self.assertEqual(client.call("status")["run"], None)

        client.close()
        daemon.thread.join(timeout=5)

        self.assertFalse(daemon.thread.is_alive())
        self.assertTrue(daemon.harness._stop.is_set())

    def test_unknown_method_is_an_error(self):
        with self.assertRaisesRegex(DaemonError, "Unknown method"):
            self.start().client().call("explode")


if __name__ == "__main__":
    unittest.main()
