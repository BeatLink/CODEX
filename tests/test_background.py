import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from smartharness.background import learn_from_episodes, research_one_topic
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
            self.assertTrue(streamed)
            self.assertEqual(set(streamed), {"Summary"})
            self.assertIn("Extracting facts", progress)
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
            self.assertEqual(cache.get.call_args.args, (settings["model_path"], settings["context_size"], settings["gpu_layers"]))

            settings.update(background_model_path="big.gguf", background_context_size=8192, background_gpu_layers=0)
            KnowledgeStore(settings["knowledge_db_path"]).enqueue_topic("SQLite WAL")
            with (
                patch("smartharness.background.Toolbox", return_value=toolbox),
                patch("smartharness.background.run_stage", return_value="Summary"),
            ):
                research_one_topic(settings, model_cache=cache)

            self.assertEqual(cache.get.call_args.args, ("big.gguf", 8192, 0))

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


class ExtractionTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.settings = DEFAULT_SETTINGS.copy()
        self.settings["knowledge_db_path"] = str(Path(directory.name) / "knowledge.db")
        self.settings["filesystem_root"] = directory.name
        self.store = KnowledgeStore(self.settings["knowledge_db_path"])

    def test_worker_stores_page_summaries_facts_relationships_and_parent(self):
        self.store.enqueue_topic("SQLite FTS5")
        toolbox = unittest.mock.Mock()

        def call(name, arguments):
            if name == "web_search":
                return json.dumps([{"title": "FTS5", "url": "https://example.test/fts", "snippet": "Full text."}])
            return json.dumps({"url": arguments["url"], "title": "FTS5", "text": "FTS5 is an SQLite module."})

        toolbox.call.side_effect = call
        page_facts = json.dumps({"facts": [{"statement": "FTS5 is an SQLite module.", "source": 1, "confidence": "high"}]})
        snippet_facts = json.dumps({"facts": [{"statement": "FTS5 is fast.", "source": 99, "confidence": "low"}]})
        overview = json.dumps({
            "summary": "FTS5 adds full-text search to SQLite.",
            "relationships": [{"subject": "FTS5", "relation": "extends", "object": "SQLite", "source": 2}],
            "parent_topic": "Databases",
        })
        replies = iter([page_facts, snippet_facts, overview, "Databases overview."])

        with (
            patch("smartharness.background.Toolbox", return_value=toolbox),
            patch("smartharness.background.summarize_web_page", return_value="FTS5 is an SQLite module.") as summarize,
            patch("smartharness.background.run_stage", side_effect=lambda *args, **kwargs: next(replies)) as run_stage,
        ):
            self.assertTrue(research_one_topic(self.settings, llm=object()))

        self.assertEqual(summarize.call_count, 1)
        self.assertIn("FTS5 is an SQLite module.", run_stage.call_args_list[0].args[2])
        self.assertNotIn("Full text.", run_stage.call_args_list[0].args[2])
        self.assertIn("Full text.", run_stage.call_args_list[1].args[2])
        for call in run_stage.call_args_list[:3]:
            self.assertIsNotNone(call.kwargs["json_schema"])
        facts = {fact["statement"]: fact for fact in self.store.facts()}
        self.assertEqual(facts["FTS5 is an SQLite module."]["confidence"], 0.9)
        self.assertEqual(facts["FTS5 is an SQLite module."]["source_url"], "https://example.test/fts")
        self.assertIsNone(facts["FTS5 is fast."]["source_url"])
        self.assertIn(("FTS5", "extends", "SQLite"), [(e["source"], e["relation"], e["target"]) for e in self.store.graph()])
        topics = {topic["name"]: topic for topic in self.store.topics()}
        self.assertEqual(topics["SQLite FTS5"]["parent"], "Databases")
        self.assertEqual(self.store.child_summaries("Databases"), [("SQLite FTS5", "FTS5 adds full-text search to SQLite.")])
        self.assertEqual(self.store.sources()[0]["summary"], "FTS5 is an SQLite module.")
        self.assertEqual(self.store.queue_status()[0]["status"], "done")

    def test_the_same_page_under_a_second_address_is_read_once_and_the_next_page_instead(self):
        from smartharness.background import _parse_overview

        self.store.enqueue_topic("SQLite WAL")
        pages = {
            "https://sqlite.org/wal.html": "WAL is a journal mode.",
            "https://sqlite.org/wal.html?source=post_page-----2c7f": "WAL  is a journal\nmode.",
            "https://example.test/wal": "WAL lets readers run beside a writer.",
        }
        toolbox = unittest.mock.Mock()

        def call(name, arguments):
            if name == "web_search":
                return json.dumps([{"title": "WAL", "url": url, "snippet": "WAL."} for url in pages])
            return json.dumps({"url": arguments["url"], "title": "WAL", "text": pages[arguments["url"]]})

        toolbox.call.side_effect = call
        with (
            patch("smartharness.background.Toolbox", return_value=toolbox),
            patch("smartharness.background.summarize_web_page", return_value="Summary.") as summarize,
            patch("smartharness.background.run_stage", return_value=json.dumps({"facts": []})),
        ):
            research_one_topic(self.settings, llm=object())

        self.assertEqual(summarize.call_count, 2)
        self.assertNotIn("post_page", summarize.call_args_list[1].args[1])

        overview = _parse_overview(json.dumps({"summary": "", "parent_topic": "", "relationships": [
            {"subject": "SQLite WAL", "relation": "implemented_in", "object": "SQLite", "source": 1},
            {"subject": "sqlite wal", "relation": "implemented_in", "object": "SQLite", "source": 2},
            {"subject": "SQLite WAL", "relation": "described_by", "object": "sqlite.org", "source": 1},
        ]}), {1: "https://sqlite.org/wal.html", 2: "https://example.test/wal"})
        self.assertEqual([relationship[:3] for relationship in overview.relationships], [
            ("SQLite WAL", "implemented_in", "SQLite"),
            ("SQLite WAL", "described_by", "sqlite.org"),
        ])

    def test_a_failed_search_says_so_in_the_job_error(self):
        self.store.enqueue_topic("SQLite WAL")
        toolbox = unittest.mock.Mock()
        toolbox.call.return_value = "Tool error: RatelimitException: 202 Ratelimit"

        with patch("smartharness.background.Toolbox", return_value=toolbox):
            research_one_topic(self.settings, llm=object())

        self.assertEqual(self.store.queue_status()[0]["status"], "failed")
        self.assertIn("Web search failed: RatelimitException", self.store.queue_status()[0]["error"])

    def test_a_cut_off_snippet_loses_its_last_sentence_and_no_fact_may_end_cut_off(self):
        from smartharness.background import _complete_sentences, _grounded_facts, _Source

        self.assertEqual(_complete_sentences("WAL is faster. WAL provides more ..."), "WAL is faster.")
        self.assertEqual(_complete_sentences("WAL provides more \u2026"), "WAL provides more")
        self.assertEqual(_complete_sentences("WAL is faster."), "WAL is faster.")
        sources = [_Source(1, "https://sqlite.org/wal.html", "WAL is faster. WAL provides more concurrency.")]
        self.assertEqual(
            _grounded_facts([("WAL is faster.", "https://sqlite.org/wal.html", 0.9), ("WAL provides more ...", "https://sqlite.org/wal.html", 0.9)], sources),
            [("WAL is faster.", "https://sqlite.org/wal.html", 0.9)],
        )

    def test_extracted_facts_are_checked_against_the_sources(self):
        from smartharness.background import _grounded_facts, _Source

        sources = [
            _Source(1, "https://example.test/zig", "Zig 0.13.0 was released on 2024-06-07 with a new build system."),
            _Source(2, "https://example.test/news", "News: Zig ships releases twice a year."),
        ]
        facts = _grounded_facts([
            ("Zig 0.13.0 was released on June 7, 2024.", "https://example.test/zig", 0.9),
            ("Zig 0.14.0 was released in 2025.", "https://example.test/zig", 0.9),
            ("Zig 0.13.0 has a new build system.", "https://example.test/news", 0.9),
            ("Zig ships releases twice a year.", None, 0.6),
            ("Rust compiles quickly with incremental caching.", "https://example.test/zig", 0.9),
        ], sources)

        self.assertEqual(facts, [
            ("Zig 0.13.0 was released on June 7, 2024.", "https://example.test/zig", 0.9),
            ("Zig 0.13.0 has a new build system.", "https://example.test/news", 0.3),
            ("Zig ships releases twice a year.", None, 0.3),
            ("Rust compiles quickly with incremental caching.", "https://example.test/zig", 0.3),
        ])

    def test_learning_turns_past_requests_into_user_memory(self):
        self.store.record_episode("Write my Rust CLI in clap", "action", "1. Use clap", "Done", "answered")
        self.store.add_fact("Rust", "Rust is a systems language.")
        reply = json.dumps({
            "memories": [{"kind": "project", "statement": "Is building a Rust CLI with clap."}],
            "research_topics": ["clap argument parsing", "Rust"],
        })

        with patch("smartharness.background.run_stage", return_value=reply) as run_stage:
            self.assertTrue(learn_from_episodes(self.settings, llm=object()))

        self.assertIn("Write my Rust CLI in clap", run_stage.call_args.args[2])
        self.assertEqual(
            [(memory["kind"], memory["statement"]) for memory in self.store.user_memories()],
            [("project", "Is building a Rust CLI with clap.")],
        )
        self.assertEqual([job["topic"] for job in self.store.queue_status()], ["clap argument parsing"])
        self.assertEqual(self.store.episodes(unprocessed_only=True), [])
        self.assertFalse(learn_from_episodes(self.settings, llm=object()))


if __name__ == "__main__":
    unittest.main()