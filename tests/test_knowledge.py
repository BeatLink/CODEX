import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from smartharness.knowledge import _MIGRATIONS, KnowledgeStore


class KnowledgeStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.store = KnowledgeStore(Path(self.temporary_directory.name) / "nested" / "knowledge.db")

    def test_topics_sources_and_graph_relationships_persist(self):
        self.store.add_topic("Python", parent="Software")
        self.store.store_search_results(
            "python sqlite",
            [{"title": "SQLite docs", "url": "https://example.test/sqlite", "snippet": "Python database"}],
            topic="Python",
            summary="SQLite is a database.",
        )

        results = self.store.search("python database")
        self.assertEqual(results[0]["topic"], "Python")
        self.assertEqual(results[0]["summary"], "SQLite is a database.")
        self.assertTrue(any(edge["relation"] == "contains" for edge in self.store.graph()))
        self.assertTrue(any(edge["relation"] == "supported_by" for edge in self.store.graph()))
        self.assertEqual(len(self.store.topics()), 2)

    def test_expired_sources_are_not_retrieved(self):
        self.store.store_search_results(
            "old result",
            [{"title": "Old", "url": "https://example.test/old", "snippet": "stale evidence"}],
            ttl_seconds=0,
        )

        self.assertEqual(self.store.search("stale evidence"), [])

    def test_entity_relationship_can_reference_its_evidence_source(self):
        self.store.store_search_results(
            "tool relationship",
            [{"title": "Integration notes", "url": "https://example.test/tool", "snippet": "Tool A uses Tool B."}],
            topic="Integrations",
        )

        self.store.add_relationship(
            "Tool A", "uses", "Tool B", source_url="https://example.test/tool"
        )

        relationship = next(edge for edge in self.store.graph() if edge["source"] == "Tool A")
        self.assertEqual((relationship["relation"], relationship["target"]), ("uses", "Tool B"))
        self.assertEqual(relationship["evidence_url"], "https://example.test/tool")

    def test_queue_deduplicates_pending_jobs_and_orders_priority(self):
        low_priority = self.store.enqueue_topic("Low", priority=1)
        high_priority = self.store.enqueue_topic("High", priority=5)
        self.assertEqual(self.store.enqueue_topic("High", priority=5), high_priority)

        job = self.store.claim_job()

        self.assertEqual(job["id"], high_priority)
        self.assertNotEqual(job["id"], low_priority)
        self.store.finish_job(job["id"])
        self.assertEqual(self.store.queue_status()[0]["status"], "done")

    def test_stale_source_topics_are_queued_for_refresh(self):
        self.store.store_search_results(
            "stale topic",
            [{"title": "Topic", "url": "https://example.test/topic", "snippet": "Research source."}],
            topic="Topic",
        )

        with patch("smartharness.knowledge.time.time", return_value=time.time() + 7200):
            queued = self.store.enqueue_due_topics(refresh_interval_hours=1)

        self.assertEqual(queued, 1)
        self.assertEqual(self.store.queue_status()[0]["status"], "pending")

    def test_pending_job_count_is_hard_limited(self):
        first_id = self.store.enqueue_topic("First", max_pending=1)

        self.assertEqual(self.store.enqueue_topic("First", max_pending=1), first_id)
        with self.assertRaisesRegex(ValueError, "queue is full"):
            self.store.enqueue_topic("Second", max_pending=1)
        self.assertEqual(len(self.store.queue_status()), 1)


    def test_topic_keeps_its_parent_and_priority_when_updated_without_them(self):
        self.store.add_topic("Python", parent="Software", priority=4)
        self.store.store_search_results(
            "python",
            [{"title": "Python", "url": "https://example.test/python", "snippet": "Python"}],
            topic="Python",
        )

        python = next(topic for topic in self.store.topics() if topic["name"] == "Python")
        self.assertEqual((python["parent"], python["priority"]), ("Software", 4))

    def test_summary_is_stored_once_on_the_topic(self):
        self.store.store_search_results(
            "sqlite",
            [
                {"title": "One", "url": "https://example.test/one", "snippet": "SQLite one"},
                {"title": "Two", "url": "https://example.test/two", "snippet": "SQLite two"},
            ],
            topic="SQLite",
            summary="Topic summary.",
        )

        self.assertTrue(all(source["summary"] == "" for source in self.store.sources()))
        self.assertTrue(all(result["summary"] == "Topic summary." for result in self.store.search("sqlite")))

    def test_repeated_fact_keeps_its_highest_confidence_and_source(self):
        self.store.store_search_results(
            "fts", [{"title": "FTS", "url": "https://example.test/fts", "snippet": "FTS5"}], topic="SQLite"
        )
        self.store.add_fact("SQLite", "SQLite ships  FTS5.", "https://example.test/fts", confidence=0.9)
        self.store.add_fact("SQLite", "SQLite ships FTS5.", confidence=0.4)

        facts = self.store.facts()
        self.assertEqual(len(facts), 1)
        self.assertEqual(facts[0]["confidence"], 0.9)
        self.assertEqual(facts[0]["source_url"], "https://example.test/fts")

    def test_recall_returns_user_memory_facts_and_episodes_and_counts_use(self):
        self.store.add_user_memory("preference", "Prefers Python examples")
        self.store.add_fact("SQLite", "SQLite FTS5 supports bm25 ranking.", confidence=0.8)
        self.store.add_fact("Rust", "Cargo builds crates.", confidence=0.8)
        self.store.record_episode("Explain SQLite FTS5 ranking", "reasoning", "1. Explain ranking", "Answer", "answered")

        recalled = self.store.recall("How does SQLite FTS5 ranking work?")

        self.assertEqual([memory["statement"] for memory in recalled["user"]], ["Prefers Python examples"])
        self.assertEqual([fact["statement"] for fact in recalled["facts"]], ["SQLite FTS5 supports bm25 ranking."])
        self.assertEqual(recalled["episodes"][0]["prompt"], "Explain SQLite FTS5 ranking")
        use_counts = {fact["topic"]: fact["use_count"] for fact in self.store.facts()}
        self.assertEqual(use_counts, {"SQLite": 1, "Rust": 0})

    def test_a_long_request_recalls_a_fact_sharing_three_of_its_terms(self):
        self.store.add_user_memory("preference", "Prefers Python examples")
        self.store.add_fact("FastAPI", "FastAPI runs async def endpoints on the event loop.")
        self.store.add_fact("FastAPI", "FastAPI is a Python web framework.")

        recalled = self.store.recall(
            "I am building a web service with FastAPI and Postgres; how should I structure"
            " async endpoints and database sessions so they do not block?",
            include_user=False,
        )

        self.assertEqual(recalled["user"], [])
        self.assertEqual(
            [fact["statement"] for fact in recalled["facts"]],
            ["FastAPI runs async def endpoints on the event loop."],
        )

    def test_a_fact_whose_source_has_expired_is_recalled_as_stale(self):
        self.store.store_search_results("zig", [{"url": "https://zig.example/", "title": "Zig", "snippet": "Zig."}])
        self.store.add_fact("Zig", "Zig 0.13.0 is the newest Zig release.", "https://zig.example/")
        self.store.add_fact("Zig", "Zig releases ship a new Zig build system.")
        with sqlite3.connect(self.store.path) as connection:
            connection.execute("UPDATE sources SET expires_at = 0")

        facts = {fact["statement"]: fact for fact in self.store.recall("newest zig release build")["facts"]}

        self.assertTrue(facts["Zig 0.13.0 is the newest Zig release."]["stale"])
        self.assertFalse(facts["Zig releases ship a new Zig build system."]["stale"])
        self.assertIsNotNone(facts["Zig releases ship a new Zig build system."]["retrieved_at"])

    def test_recall_brings_the_relationships_of_entities_a_fact_names(self):
        self.store.store_search_results("fts5", [{"url": "https://example.test/fts", "title": "FTS5", "snippet": "FTS5."}])
        self.store.add_fact("SQLite", "FTS5 supports bm25 ranking.")
        self.store.add_relationship("FTS5", "extends", "SQLite", "https://example.test/fts")
        self.store.add_relationship("Cargo", "builds", "Rust")
        self.store.add_relationship("FTS", "precedes", "FTS4")

        relationships = self.store.recall("FTS5 bm25 ranking")["relationships"]

        self.assertEqual(relationships, [
            {"subject": "FTS5", "relation": "extends", "object": "SQLite", "source_url": "https://example.test/fts"},
        ])

    def test_recalled_fact_carries_its_chain_of_parent_summaries(self):
        self.store.add_topic("SQLite", parent="Databases")
        self.store.add_topic("SQLite FTS5", parent="SQLite")
        self.store.set_topic_summary("Databases", "Ways to store data.")
        self.store.set_topic_summary("SQLite", "An embedded database.")
        self.store.add_fact("SQLite FTS5", "FTS5 supports bm25 ranking.")

        fact = self.store.recall("FTS5 bm25 ranking")["facts"][0]

        self.assertEqual(fact["topic_path"], [
            {"name": "Databases", "summary": "Ways to store data."},
            {"name": "SQLite", "summary": "An embedded database."},
        ])

    def test_user_memory_rejects_unknown_kinds(self):
        with self.assertRaisesRegex(ValueError, "kind must be one of"):
            self.store.add_user_memory("secret", "anything")

    def test_episodes_can_be_marked_processed(self):
        episode_id = self.store.record_episode("Prompt", "direct", "", "Answer", "answered")

        self.store.mark_episode_processed(episode_id)

        self.assertEqual(self.store.episodes(unprocessed_only=True), [])
        self.assertEqual(len(self.store.episodes()), 1)


class KnowledgeMigrationTests(unittest.TestCase):
    def test_version_one_database_moves_summaries_onto_topics(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "knowledge.db"
            connection = sqlite3.connect(path)
            connection.executescript(_MIGRATIONS[0])
            connection.execute("INSERT INTO topics(id, name) VALUES (1, 'SQLite')")
            connection.execute(
                "INSERT INTO sources(id, url, title, snippet, summary, topic_id, retrieved_at, expires_at) "
                "VALUES (1, 'https://example.test/a', 'A', 'SQLite snippet', 'Old summary', 1, ?, ?)",
                (time.time(), time.time() + 3600),
            )
            connection.execute("PRAGMA user_version = 1")
            connection.commit()
            connection.close()

            store = KnowledgeStore(path)

            with sqlite3.connect(path) as check:
                self.assertEqual(check.execute("PRAGMA user_version").fetchone()[0], len(_MIGRATIONS))
                self.assertEqual(check.execute("SELECT summary FROM topics").fetchone()[0], "Old summary")
                self.assertEqual(check.execute("SELECT summary FROM sources").fetchone()[0], "")
            self.assertEqual(store.search("sqlite snippet")[0]["summary"], "Old summary")

    def test_newer_schema_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "knowledge.db"
            with sqlite3.connect(path) as connection:
                connection.execute(f"PRAGMA user_version = {len(_MIGRATIONS) + 1}")

            with self.assertRaisesRegex(RuntimeError, "newer than this application"):
                KnowledgeStore(path)


if __name__ == "__main__":
    unittest.main()