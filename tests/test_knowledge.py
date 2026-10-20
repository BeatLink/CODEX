import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from smartharness.knowledge import KnowledgeStore


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


if __name__ == "__main__":
    unittest.main()