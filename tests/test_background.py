import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from smartharness.background import research_one_topic
from smartharness.knowledge import KnowledgeStore
from smartharness.settings import DEFAULT_SETTINGS


class BackgroundResearchTests(unittest.TestCase):
    def test_worker_saves_search_evidence_summary_and_job_status(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = DEFAULT_SETTINGS.copy()
            settings["knowledge_db_path"] = str(Path(directory) / "knowledge.db")
            settings["filesystem_root"] = directory
            store = KnowledgeStore(settings["knowledge_db_path"])
            store.enqueue_topic("SQLite FTS5")
            toolbox = unittest.mock.Mock()
            toolbox.call.return_value = json.dumps(
                [{"title": "SQLite FTS5", "url": "https://example.test/fts", "snippet": "Full text search."}]
            )
            progress = []
            streamed = []

            def summarize(*args, **kwargs):
                kwargs["on_token"]("Summary")
                return "SQLite includes full-text search. https://example.test/fts"

            with (
                patch("smartharness.background.Toolbox", return_value=toolbox),
                patch("smartharness.background.run_stage", side_effect=summarize),
            ):
                worked = research_one_topic(
                    settings,
                    on_progress=progress.append,
                    on_token=streamed.append,
                    llm=object(),
                )

            self.assertTrue(worked)
            self.assertEqual(streamed, ["Summary"])
            self.assertIn("Summarizing retrieved evidence", progress)
            self.assertEqual(store.queue_status()[0]["status"], "done")
            self.assertEqual(store.search("full text search")[0]["summary"],
                             "SQLite includes full-text search. https://example.test/fts")

    def test_worker_loads_its_model_through_the_shared_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = DEFAULT_SETTINGS.copy()
            settings["knowledge_db_path"] = str(Path(directory) / "knowledge.db")
            settings["filesystem_root"] = directory
            KnowledgeStore(settings["knowledge_db_path"]).enqueue_topic("SQLite FTS5")
            toolbox = unittest.mock.Mock()
            toolbox.call.return_value = json.dumps(
                [{"title": "SQLite FTS5", "url": "https://example.test/fts", "snippet": "Full text search."}]
            )
            cache = unittest.mock.Mock()
            cache.get.return_value = "shared model"

            with (
                patch("smartharness.background.Toolbox", return_value=toolbox),
                patch("smartharness.background.run_stage", return_value="Summary") as run_stage,
                patch("smartharness.background.create_model") as create_model,
            ):
                research_one_topic(settings, model_cache=cache)

            create_model.assert_not_called()
            self.assertEqual(run_stage.call_args.args[0], "shared model")

    def test_worker_does_not_load_model_when_queue_is_empty(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = DEFAULT_SETTINGS.copy()
            settings["knowledge_db_path"] = str(Path(directory) / "knowledge.db")
            settings["filesystem_root"] = directory

            with patch("smartharness.background.create_model") as create_model:
                self.assertFalse(research_one_topic(settings))

            create_model.assert_not_called()

    def test_worker_defers_current_topic_when_foreground_work_arrives(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = DEFAULT_SETTINGS.copy()
            settings["knowledge_db_path"] = str(Path(directory) / "knowledge.db")
            settings["filesystem_root"] = directory
            store = KnowledgeStore(settings["knowledge_db_path"])
            store.enqueue_topic("SQLite")
            toolbox = unittest.mock.Mock()
            toolbox.call.return_value = json.dumps(
                [{"title": "SQLite", "url": "https://example.test/sqlite", "snippet": "Database."}]
            )
            active = {"prompt": False}

            def interrupt_summary(*args, **kwargs):
                active["prompt"] = True
                kwargs["on_token"]("partial")
                return "unreachable"

            with (
                patch("smartharness.background.Toolbox", return_value=toolbox),
                patch("smartharness.background.run_stage", side_effect=interrupt_summary),
            ):
                self.assertTrue(
                    research_one_topic(
                        settings,
                        should_pause=lambda: active["prompt"],
                        llm=object(),
                    )
                )

            self.assertEqual(store.queue_status()[0]["status"], "pending")
            self.assertEqual(store.search("database"), [])


if __name__ == "__main__":
    unittest.main()