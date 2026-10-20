import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from smartharness.consolidation import TOP_LEVEL, consolidate_knowledge
from smartharness.knowledge import KnowledgeStore
from smartharness.settings import DEFAULT_SETTINGS


def verdict(choice: str, key: str = "verdict") -> str:
    return json.dumps({"reason": "Because.", key: choice})


class ConsolidationTestCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.settings = DEFAULT_SETTINGS.copy()
        self.settings["knowledge_db_path"] = str(Path(directory.name) / "knowledge.db")
        self.settings["filesystem_root"] = directory.name
        self.store = KnowledgeStore(self.settings["knowledge_db_path"])

    def consolidate(self, *replies: str, **options):
        """Run one consolidation pass with the model giving these replies, returning the pass result and the calls."""
        answers = iter(replies)
        with patch("smartharness.background.run_stage", side_effect=lambda *args, **kwargs: next(answers)) as run_stage:
            worked = consolidate_knowledge(self.settings, llm=object(), **options)
        return worked, run_stage.call_args_list

    def place_every_topic(self):
        with self.store._connect() as connection:
            connection.execute("UPDATE topics SET placed_at = ?", (time.time(),))

    def topic_names(self):
        return {topic["name"]: topic["parent"] for topic in self.store.topics()}


class TidyTests(ConsolidationTestCase):
    def test_topics_named_with_the_same_words_are_merged_into_the_one_with_more_facts(self):
        self.store.add_fact("Python packaging", "Wheels are built distributions.", confidence=0.9)
        self.store.add_fact("packaging Python", "Wheels are built distributions!", confidence=0.6)
        self.store.add_fact("packaging Python", "Sdists hold source code.", confidence=0.6)

        changes = self.store.tidy(prune_after_days=90)
        self.store.tidy(prune_after_days=90)

        self.assertEqual(changes["topics merged"], 1)
        self.assertEqual(list(self.topic_names()), ["packaging Python"])
        facts = {fact["statement"]: fact for fact in self.store.facts()}
        self.assertEqual(set(facts), {"Wheels are built distributions.", "Sdists hold source code."})
        self.assertEqual(facts["Wheels are built distributions."]["confidence"], 0.9)

    def test_empty_topics_go_but_queued_and_failed_ones_stay(self):
        self.store.add_topic("Empty")
        failed_job = self.store.enqueue_topic("Failed")
        self.store.claim_job()
        self.store.finish_job(failed_job, "No results")
        self.store.enqueue_topic("Queued")

        self.assertEqual(self.store.tidy(prune_after_days=90), {"empty topics removed": 1})
        self.assertEqual(set(self.topic_names()), {"Queued", "Failed"})

    def test_old_unused_low_confidence_facts_are_pruned_and_return_when_found_again(self):
        self.store.add_fact("SQLite", "SQLite is small.", confidence=0.3)
        self.store.add_fact("SQLite", "SQLite is public domain.", confidence=0.9)
        with self.store._connect() as connection:
            connection.execute("UPDATE facts SET created_at = ?", (time.time() - 100 * 86400,))

        self.assertEqual(self.store.tidy(prune_after_days=90), {"facts pruned": 1})
        statuses = {fact["statement"]: fact["status"] for fact in self.store.facts()}
        self.assertEqual(statuses, {"SQLite is small.": "pruned", "SQLite is public domain.": "active"})

        self.store.add_fact("SQLite", "SQLite is small.", confidence=0.3)
        self.assertEqual({fact["status"] for fact in self.store.facts()}, {"active"})

    def test_a_parent_loop_is_broken(self):
        self.store.add_topic("Databases", parent="SQLite")
        self.store.add_topic("SQLite", parent="Databases")
        self.store.add_fact("SQLite", "SQLite is small.")
        self.store.add_fact("Databases", "Databases hold data.")

        self.assertEqual(self.store.tidy(prune_after_days=90), {"parent loops broken": 1})
        self.assertIn(self.topic_names(), [{"Databases": None, "SQLite": "Databases"}, {"Databases": "SQLite", "SQLite": None}])


class ModelCheckTests(ConsolidationTestCase):
    def test_topics_naming_one_subject_are_merged_into_the_better_supported_one(self):
        self.store.add_fact("SQLite FTS5", "FTS5 adds full-text search.")
        self.store.add_fact("SQLite FTS5", "FTS5 supports ranking.")
        self.store.add_fact("FTS5", "FTS5 is a virtual table module.")
        self.store.enqueue_topic("FTS5")
        self.place_every_topic()

        worked, calls = self.consolidate(verdict("same subject"))

        self.assertTrue(worked)
        self.assertIn("SQLite FTS5", calls[0].args[2])
        self.assertEqual(list(self.topic_names()), ["SQLite FTS5"])
        self.assertEqual(len(self.store.facts()), 3)
        self.assertEqual([job["topic"] for job in self.store.queue_status()], ["SQLite FTS5"])

    def test_a_broader_topic_adopts_a_top_level_one_and_rewrites_its_summary(self):
        self.store.add_fact("SQLite", "SQLite is an embedded database.")
        self.store.add_fact("SQLite FTS5", "FTS5 adds full-text search.")
        self.store.set_topic_summary("SQLite FTS5", "Full-text search for SQLite.")
        self.place_every_topic()

        worked, calls = self.consolidate(verdict("first is broader"), "SQLite overview.")

        self.assertTrue(worked)
        self.assertEqual(self.topic_names()["SQLite FTS5"], "SQLite")
        self.assertEqual(self.store.child_summaries("SQLite"), [("SQLite FTS5", "Full-text search for SQLite.")])
        edges = [(edge["source"], edge["relation"], edge["target"]) for edge in self.store.graph()]
        self.assertIn(("SQLite", "contains", "SQLite FTS5"), edges)

    def test_each_pair_is_compared_once(self):
        self.store.add_fact("SQLite", "SQLite is an embedded database.")
        self.store.add_fact("SQLite FTS5", "FTS5 adds full-text search.")
        self.place_every_topic()

        self.consolidate(verdict("different"))
        worked, calls = self.consolidate()

        self.assertFalse(worked)
        self.assertEqual(calls, [])

    def test_contradicting_facts_set_aside_the_weaker_one_and_queue_research(self):
        self.store.add_fact("SQLite", "SQLite 3.0 was released in 2004.", confidence=0.9)
        self.store.add_fact("SQLite", "SQLite 3.0 was released in 2005.", confidence=0.3)
        self.place_every_topic()

        worked, _ = self.consolidate(verdict("contradict"))

        self.assertTrue(worked)
        statuses = {fact["statement"]: fact["status"] for fact in self.store.facts()}
        self.assertEqual(statuses["SQLite 3.0 was released in 2004."], "active")
        self.assertEqual(statuses["SQLite 3.0 was released in 2005."], "disputed")
        self.assertEqual(self.store.queue_status()[0]["topic"], "SQLite")

    def test_matching_facts_are_merged(self):
        self.store.add_fact("SQLite", "SQLite stores each database in one file.", confidence=0.6)
        self.store.add_fact("SQLite", "SQLite stores the whole database in one file.", confidence=0.9)
        self.place_every_topic()

        self.consolidate(verdict("same"))

        self.assertEqual(
            [(fact["statement"], fact["confidence"]) for fact in self.store.facts()],
            [("SQLite stores the whole database in one file.", 0.9)],
        )

    def test_a_newer_user_memory_supersedes_a_contradicting_older_one(self):
        self.store.add_user_memory("preference", "Prefers Python for scripting tasks.")
        self.store.add_user_memory("preference", "Prefers Rust for scripting tasks.")

        worked, calls = self.consolidate(verdict("contradict"))

        self.assertTrue(worked)
        self.assertLess(calls[0].args[2].index("Python"), calls[0].args[2].index("Rust"))
        self.assertEqual([memory["statement"] for memory in self.store.user_memories()], ["Prefers Rust for scripting tasks."])

    def test_a_topic_is_moved_under_the_parent_the_model_picks(self):
        self.store.add_fact("Databases", "Databases hold data.")
        self.store.add_fact("Web frameworks", "Frameworks serve pages.")
        self.store.add_fact("PostgreSQL", "PostgreSQL is a relational database.")
        self.store.add_topic("PostgreSQL", parent="Web frameworks")
        self.place_every_topic()
        with self.store._connect() as connection:
            connection.execute("UPDATE topics SET placed_at = NULL WHERE name = 'PostgreSQL'")

        worked, calls = self.consolidate(verdict("Databases", key="parent"), "Databases overview.")

        self.assertTrue(worked)
        self.assertEqual(
            set(calls[0].kwargs["json_schema"]["properties"]["parent"]["enum"]),
            {TOP_LEVEL, "Databases", "Web frameworks"},
        )
        self.assertEqual(self.topic_names()["PostgreSQL"], "Databases")
        edges = [(edge["source"], edge["relation"], edge["target"]) for edge in self.store.graph()]
        self.assertNotIn(("Web frameworks", "contains", "PostgreSQL"), edges)

    def test_a_topic_is_never_offered_its_own_subtopics_as_a_parent(self):
        self.store.add_fact("Databases", "Databases hold data.")
        self.store.add_fact("SQLite", "SQLite is small.")
        self.store.add_topic("SQLite", parent="Databases")
        self.place_every_topic()
        with self.store._connect() as connection:
            connection.execute("UPDATE topics SET placed_at = NULL WHERE name = 'Databases'")

        worked, calls = self.consolidate()

        self.assertTrue(worked)
        self.assertEqual(calls, [])
        self.assertEqual(self.topic_names()["Databases"], None)

    def test_foreground_work_leaves_the_pair_to_compare_later(self):
        self.store.add_fact("SQLite", "SQLite is an embedded database.")
        self.store.add_fact("SQLite FTS5", "FTS5 adds full-text search.")
        self.place_every_topic()
        active = {"prompt": False}

        def interrupt(*args, **kwargs):
            active["prompt"] = True
            kwargs["on_token"]("partial")
            return verdict("same subject")

        with patch("smartharness.background.run_stage", side_effect=interrupt):
            self.assertTrue(consolidate_knowledge(self.settings, should_pause=lambda: active["prompt"], llm=object()))

        self.assertEqual(set(self.topic_names()), {"SQLite", "SQLite FTS5"})
        self.assertIsNotNone(self.store.next_unchecked_pair("topic"))

    def test_an_unreadable_reply_changes_nothing_and_is_not_asked_again(self):
        self.store.add_fact("SQLite", "SQLite is an embedded database.")
        self.store.add_fact("SQLite FTS5", "FTS5 adds full-text search.")
        self.place_every_topic()

        self.consolidate("not json")

        self.assertEqual(set(self.topic_names()), {"SQLite", "SQLite FTS5"})
        self.assertIsNone(self.store.next_unchecked_pair("topic"))


if __name__ == "__main__":
    unittest.main()
