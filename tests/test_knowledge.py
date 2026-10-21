import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from codex.knowledge import _MIGRATIONS, KnowledgeStore


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

        with patch("codex.knowledge.time.time", return_value=time.time() + 7200):
            queued = self.store.enqueue_due_topics(refresh_interval_hours=1)

        self.assertEqual(queued, 1)
        self.assertEqual(self.store.queue_status()[0]["status"], "pending")

    def test_often_used_topics_are_refreshed_in_half_the_time(self):
        for name in ("Used", "Unused"):
            self.store.store_search_results(
                name, [{"title": name, "url": f"https://example.test/{name}", "snippet": f"{name} source."}], topic=name,
            )
        self.store.add_fact("Used", "Used topics come back often.")
        with patch("codex.knowledge.time.time", return_value=time.time() + 10):
            for _ in range(5):
                self.store.recall("used topics come back often")

        with patch("codex.knowledge.time.time", return_value=time.time() + 2400):
            queued = self.store.enqueue_due_topics(refresh_interval_hours=1)

        self.assertEqual(queued, 1)
        self.assertEqual([job["topic"] for job in self.store.queue_status()], ["Used"])

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
        # The other fact comes from the named topic's branch, after the one matching the request itself.
        self.assertEqual(
            [fact["statement"] for fact in recalled["facts"]],
            ["FastAPI runs async def endpoints on the event loop.", "FastAPI is a Python web framework."],
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
        self.store.store_search_results("fts5 docs", [{"url": "https://example.test/docs", "title": "FTS5", "snippet": "FTS5."}])
        self.store.add_relationship("FTS5", "extends", "SQLite", "https://example.test/fts")
        self.store.add_relationship("FTS5", "extends", "SQLite", "https://example.test/docs")
        self.store.add_relationship("Cargo", "builds", "Rust")
        self.store.add_relationship("FTS", "precedes", "FTS4")

        relationships = self.store.recall("FTS5 bm25 ranking")["relationships"]

        self.assertEqual(relationships, [
            {"subject": "FTS5", "relation": "extends", "object": "SQLite", "source_url": "https://example.test/docs"},
        ])

    def test_recall_fills_up_from_the_branch_of_the_topic_the_query_names(self):
        self.store.add_topic("FastAPI", parent="Python web frameworks")
        self.store.add_topic("FastAPI dependencies", parent="FastAPI")
        self.store.add_fact("FastAPI", "It is built on Starlette and Pydantic.", confidence=0.6)
        self.store.add_fact("FastAPI dependencies", "Depends() injects shared resources.", confidence=0.9)
        self.store.add_fact("Python web frameworks", "Django ships an admin site.", confidence=0.9)
        self.store.add_fact("Rust", "Cargo builds crates.", confidence=0.9)

        recalled = self.store.recall("How should I lay out a FastAPI app?")

        self.assertEqual(
            [fact["statement"] for fact in recalled["facts"]],
            ["Depends() injects shared resources.", "It is built on Starlette and Pydantic."],
        )

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

    def test_a_new_user_memory_is_recalled_beside_often_used_ones(self):
        for number in range(12):
            self.store.add_user_memory("preference", f"Likes style number {number}")
        for _ in range(3):
            self.store.recall("anything at all")
        self.store.add_user_memory("preference", "Wants answers in British English")

        recalled = [memory["statement"] for memory in self.store.recall("anything at all")["user"]]

        self.assertEqual(len(recalled), 10)
        self.assertEqual(recalled[0], "Wants answers in British English")

    def test_user_memories_sharing_the_request_s_words_come_first(self):
        self.store.add_user_memory("preference", "Uses Rust for command line tools")
        self.store.add_user_memory("preference", "Prefers short answers")

        recalled = self.store.recall("Write a Rust command line parser")["user"]

        self.assertEqual(recalled[0]["statement"], "Uses Rust for command line tools")

    def test_a_project_memory_is_recalled_only_in_its_project(self):
        self.store.add_user_memory("project", "Is porting the parser to Zig", scope="/work/parser")
        self.store.add_user_memory("preference", "Prefers short answers")

        here = [memory["statement"] for memory in self.store.recall("next step", scope="/work/parser")["user"]]
        elsewhere = [memory["statement"] for memory in self.store.recall("next step", scope="/work/other")["user"]]

        self.assertCountEqual(here, ["Is porting the parser to Zig", "Prefers short answers"])
        self.assertEqual(elsewhere, ["Prefers short answers"])

    def test_learning_a_stated_memory_again_keeps_it_stated_with_its_reason(self):
        self.store.add_user_memory("reference", "Docs live at https://example.test/docs", reason="Moved there", origin="user")
        self.store.add_user_memory("reference", "Docs live at https://example.test/docs")

        [memory] = self.store.user_memories()

        self.assertEqual((memory["origin"], memory["reason"]), ("user", "Moved there"))

    def test_a_forgotten_user_memory_is_gone(self):
        memory_id = self.store.add_user_memory("preference", "Prefers tabs")

        self.assertTrue(self.store.forget_user_memory(memory_id))
        self.assertFalse(self.store.forget_user_memory(memory_id))
        self.assertEqual(self.store.user_memories(), [])

    def test_user_memory_rejects_unknown_kinds(self):
        with self.assertRaisesRegex(ValueError, "kind must be one of"):
            self.store.add_user_memory("secret", "anything")

    def test_episodes_can_be_marked_processed(self):
        episode_id = self.store.record_episode("Prompt", "direct", "", "Answer", "answered")

        self.store.mark_episode_processed(episode_id)

        self.assertEqual(self.store.episodes(unprocessed_only=True), [])
        self.assertEqual(len(self.store.episodes()), 1)


    def test_jobs_a_stopped_worker_left_running_go_back_in_the_queue(self):
        self.store.enqueue_topic("SQLite")
        self.store.claim_job()
        self.store.enqueue_topic("PinePhone")
        self.store.claim_job()
        self.store.enqueue_topic("PinePhone")

        self.assertEqual(self.store.requeue_interrupted_jobs(), 1)

        jobs = sorted((job["topic"], job["status"]) for job in self.store.queue_status())
        self.assertEqual(jobs, [("PinePhone", "pending"), ("SQLite", "pending")])


class StoreSizeCapTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "knowledge.db"
        self.store = KnowledgeStore(self.path)

    def tearDown(self):
        self.directory.cleanup()

    def live_megabytes(self):
        with sqlite3.connect(self.path) as connection:
            used = connection.execute("PRAGMA page_count").fetchone()[0] - connection.execute("PRAGMA freelist_count").fetchone()[0]
            size = used * connection.execute("PRAGMA page_size").fetchone()[0]
        connection.close()
        return size / (1024 * 1024)

    def test_processed_episodes_go_before_any_fact_or_user_memory(self):
        self.store.add_fact("Kestrel", "Kestrel ingest listens on port 7413.")
        self.store.add_user_memory("preference", "Prefers ISO dates.")
        for number in range(60):
            episode_id = self.store.record_episode(f"Request {number}", "answer", "", "Done.", "answered", task_tree="x" * 40_000)
            self.store.mark_episode_processed(episode_id)
        self.assertGreater(self.live_megabytes(), 1)

        changes = self.store.tidy(prune_after_days=90, max_megabytes=1)

        self.assertLessEqual(self.live_megabytes(), 0.9)
        self.assertGreater(changes["items evicted to fit the size cap"], 0)
        self.assertLess(len(self.store.episodes(limit=100)), 60)
        self.assertEqual([fact["statement"] for fact in self.store.facts()], ["Kestrel ingest listens on port 7413."])
        self.assertEqual([memory["statement"] for memory in self.store.user_memories()], ["Prefers ISO dates."])

    def test_the_least_used_facts_go_first_and_their_search_entries_with_them(self):
        # The used fact is the oldest, so only its use can keep it.
        self.store.add_fact("Kestrel", "Kestrel ingest listens on port 7413.")
        self.store.recall("Kestrel ingest port")
        filler = " ".join(f"word{number}" for number in range(60))
        for number in range(1500):
            self.store.add_fact("Filler", f"Unused fact {number}: {filler}")
        self.assertGreater(self.live_megabytes(), 1)

        self.store.tidy(prune_after_days=90, max_megabytes=1)

        statements = [fact["statement"] for fact in self.store.facts(limit=5000)]
        self.assertLess(len(statements), 1501)
        self.assertIn("Kestrel ingest listens on port 7413.", statements)
        with sqlite3.connect(self.path) as connection:
            indexed = connection.execute("SELECT COUNT(*) FROM memory_search WHERE kind = 'fact'").fetchone()[0]
        connection.close()
        self.assertEqual(indexed, len(statements))

    def test_a_store_under_its_cap_is_left_alone(self):
        self.store.add_fact("Kestrel", "Kestrel ingest listens on port 7413.")

        changes = self.store.tidy(prune_after_days=90, max_megabytes=1)

        self.assertNotIn("items evicted to fit the size cap", changes)
        self.assertEqual(len(self.store.facts()), 1)


def build_old_store(path, version):
    """Write a database at an earlier schema version holding one row in each table that version has."""
    now = time.time()
    connection = sqlite3.connect(path)
    connection.executescript(_MIGRATIONS[0])
    connection.execute("INSERT INTO topics(id, name) VALUES (1, 'Kestrel')")
    connection.execute(
        "INSERT INTO sources(id, url, title, snippet, topic_id, retrieved_at, expires_at) "
        "VALUES (1, 'https://wiki.example/ingest', 'Kestrel ingest', 'Kestrel ingest listens on port 7413.', 1, ?, ?)",
        (now, now + 3600),
    )
    connection.execute(
        "INSERT INTO knowledge_search(rowid, title, body, url) VALUES "
        "(1, 'Kestrel ingest', 'Kestrel ingest listens on port 7413.', 'https://wiki.example/ingest')"
    )
    connection.execute("INSERT INTO research_queue(topic_id, requested_at) VALUES (1, ?)", (now,))
    connection.execute("INSERT INTO graph_nodes(id, kind, label) VALUES (1, 'topic', 'Kestrel'), (2, 'source', 'https://wiki.example/ingest')")
    connection.execute("INSERT INTO graph_edges(source_node_id, relation, target_node_id, source_id) VALUES (1, 'supported_by', 2, 1)")
    for next_version in range(2, version + 1):
        connection.executescript(_MIGRATIONS[next_version - 1])
        if next_version == 2:
            connection.execute(
                "INSERT INTO facts(id, topic_id, statement, source_id, created_at) "
                "VALUES (1, 1, 'Kestrel ingest listens on port 7413.', 1, ?)",
                (now,),
            )
            connection.execute("INSERT INTO memory_search(body, kind, item_id) VALUES ('Kestrel ingest listens on port 7413.', 'fact', 1)")
            connection.execute("INSERT INTO user_memory(kind, statement, created_at) VALUES ('preference', 'Prefers ISO dates.', ?)", (now,))
            connection.execute("INSERT INTO episodes(prompt, task_type, created_at) VALUES ('What port?', 'answer', ?)", (now,))
    connection.execute(f"PRAGMA user_version = {version}")
    connection.commit()
    connection.close()


def count_rows(connection, table):
    return connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


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

    def test_every_earlier_version_migrates_without_losing_rows(self):
        tables = ("topics", "sources", "research_queue", "graph_nodes", "graph_edges", "facts", "user_memory", "episodes")
        for start_version in range(1, len(_MIGRATIONS)):
            with self.subTest(start_version=start_version), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "knowledge.db"
                build_old_store(path, start_version)
                with sqlite3.connect(path) as connection:
                    existing = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
                    before = {table: count_rows(connection, table) for table in tables if table in existing}
                connection.close()

                store = KnowledgeStore(path)

                with sqlite3.connect(path) as connection:
                    self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], len(_MIGRATIONS))
                    self.assertEqual({table: count_rows(connection, table) for table in before}, before)
                connection.close()
                self.assertEqual(store.search("Kestrel ingest")[0]["url"], "https://wiki.example/ingest")
                if start_version >= 2:
                    statements = [fact["statement"] for fact in store.recall("Kestrel ingest port")["facts"]]
                    self.assertIn("Kestrel ingest listens on port 7413.", statements)
                    self.assertEqual([memory["statement"] for memory in store.user_memories()], ["Prefers ISO dates."])
                    self.assertEqual(len(store.episodes()), 1)
                store.add_fact("Kestrel", "Kestrel ingest is written in Rust.")
                self.assertEqual(len(store.facts()), 2 if start_version >= 2 else 1)

    def test_newer_schema_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "knowledge.db"
            with sqlite3.connect(path) as connection:
                connection.execute(f"PRAGMA user_version = {len(_MIGRATIONS) + 1}")

            with self.assertRaisesRegex(RuntimeError, "newer than this application"):
                KnowledgeStore(path)


if __name__ == "__main__":
    unittest.main()