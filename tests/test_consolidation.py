import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from smartharness.consolidation import NEW_PARENT, TOP_LEVEL, consolidate_knowledge
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

    def test_empty_topics_are_queued_for_research_once(self):
        self.store.add_topic("Empty")
        failed_job = self.store.enqueue_topic("Failed")
        self.store.claim_job()
        self.store.finish_job(failed_job, "No results")
        self.store.enqueue_topic("Queued")

        self.assertEqual(self.store.tidy(prune_after_days=90), {"empty topics queued for research": 1})
        self.assertEqual(self.store.tidy(prune_after_days=90), {})
        self.assertEqual(set(self.topic_names()), {"Empty", "Queued", "Failed"})
        pending = {job["topic"] for job in self.store.queue_status() if job["status"] == "pending"}
        self.assertEqual(pending, {"Empty", "Queued"})

    def test_empty_topics_wait_while_the_queue_is_full(self):
        self.store.add_topic("Empty")
        self.store.enqueue_topic("Queued")

        self.assertEqual(self.store.tidy(prune_after_days=90, max_pending=1), {})

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
    def search_topic(self, query: str, fact: str) -> None:
        """Store a search under a topic named after its query, as a request does, with one fact."""
        self.store.store_search_results(query, [{"title": "FTS5", "url": f"https://example.test/{len(query)}", "snippet": fact}], topic=query)
        self.store.add_fact(query, fact)

    def test_a_topic_named_after_its_search_query_is_renamed_once(self):
        self.search_topic("how do i use fts5 in sqlite", "FTS5 adds full-text search to SQLite.")
        self.store.add_topic("SQLite", priority=1)
        self.store.adopt_topic(self.store.add_topic("SQLite"), self.store.add_topic("how do i use fts5 in sqlite"))
        self.place_every_topic()

        worked, calls = self.consolidate(json.dumps({"reason": "It is about FTS5.", "name": "SQLite FTS5"}))

        self.assertTrue(worked)
        self.assertIn("FTS5 adds full-text search to SQLite.", calls[0].args[2])
        self.assertEqual(self.topic_names(), {"SQLite": None, "SQLite FTS5": "SQLite"})
        edges = [(edge["source"], edge["relation"], edge["target"]) for edge in self.store.graph()]
        self.assertIn(("SQLite", "contains", "SQLite FTS5"), edges)
        self.assertNotIn("how do i use fts5 in sqlite", {edge["target"] for edge in self.store.graph()})
        self.assertIsNone(self.store.next_topic_to_name())

    def test_a_renamed_topic_and_its_subtopics_are_placed_again(self):
        self.search_topic("what is the pinephone", "The PinePhone is a Linux phone.")
        self.store.add_topic("PinePhone screen", parent="what is the pinephone")
        self.store.add_fact("PinePhone screen", "The PinePhone screen is 5.95 inches.")
        self.store.add_fact("SQLite", "SQLite is small.")
        self.place_every_topic()

        self.consolidate(json.dumps({"reason": "It is about the PinePhone.", "name": "PinePhone"}))

        with self.store._connect() as connection:
            unplaced = {row["name"] for row in connection.execute("SELECT name FROM topics WHERE placed_at IS NULL")}
        self.assertEqual(unplaced, {"PinePhone", "PinePhone screen"})

    def test_a_query_topic_given_an_existing_name_is_merged_into_that_topic(self):
        self.store.add_fact("SQLite FTS5", "FTS5 supports ranking.")
        self.search_topic("fts5 full text search sqlite", "FTS5 adds full-text search to SQLite.")
        self.place_every_topic()

        self.consolidate(json.dumps({"reason": "Same subject.", "name": "sqlite fts5"}))

        self.assertEqual(list(self.topic_names()), ["SQLite FTS5"])
        self.assertEqual(len(self.store.facts()), 2)

    def test_an_unreadable_or_query_like_name_keeps_the_topic_and_is_not_asked_again(self):
        self.search_topic("fts5 sqlite", "FTS5 adds full-text search to SQLite.")
        self.place_every_topic()

        self.consolidate(json.dumps({"reason": "Long.", "name": "how to use the full text search module of the sqlite database"}))

        self.assertEqual(list(self.topic_names()), ["fts5 sqlite"])
        self.assertIsNone(self.store.next_topic_to_name())

    def test_a_long_name_is_renamed_even_when_no_search_used_it(self):
        self.store.add_fact("Notes on the PinePhone smartphone made by Pine64", "The PinePhone runs Linux.")
        self.place_every_topic()

        self.consolidate(json.dumps({"reason": "It is about the PinePhone.", "name": "PinePhone"}))

        self.assertEqual(list(self.topic_names()), ["PinePhone"])

    def test_a_topic_that_names_no_subject_and_holds_no_facts_is_removed(self):
        sentence = "Therefore the claim should be omitted."
        self.store.store_search_results(sentence, [{"title": "Fact checks", "url": "https://example.test/check", "snippet": "Checks."}], topic=sentence, summary="Fact checking.")
        self.store.add_fact("SQLite", "SQLite is small.")
        self.place_every_topic()

        self.consolidate(json.dumps({"reason": "No subject is named.", "name": ""}))

        self.assertEqual(list(self.topic_names()), ["SQLite"])
        self.assertEqual(len(self.store.sources()), 1)

    def test_a_topic_that_names_no_subject_lifts_its_subtopics_into_its_place(self):
        sentence = "Regarding the screen size mentioned before, it could not be verified."
        self.store.add_topic("PineTime")
        self.store.add_topic(sentence, parent="PineTime")
        self.store.add_topic("Screen notes", parent=sentence)
        self.store.add_fact("Screen notes", "Screens are measured diagonally.")
        self.store.add_fact("PineTime", "The PineTime is a smartwatch.")
        self.store.set_topic_summary(sentence, "Fact checking.")
        self.place_every_topic()

        self.consolidate(json.dumps({"reason": "No subject is named.", "name": ""}))

        self.assertEqual(self.topic_names(), {"PineTime": None, "Screen notes": "PineTime"})

    def test_a_title_sharing_no_word_with_the_current_name_counts_as_no_subject(self):
        sentence = "It features a 5.7-inch touchscreen and a 13-megapixel rear camera."
        self.store.store_search_results(sentence, [{"title": "Scanner", "url": "https://example.test/scan", "snippet": "A rugged scanner."}], topic=sentence, summary="A rugged handheld scanner.")
        self.store.add_fact("SQLite", "SQLite is small.")
        self.place_every_topic()

        self.consolidate(json.dumps({"reason": "The sources describe a scanner.", "name": "Honeywell ScanPal EDA52"}))

        self.assertEqual(list(self.topic_names()), ["SQLite"])
        self.assertEqual(self.store.queue_status(), [])

    def test_a_topic_already_called_by_a_title_is_never_removed_as_naming_no_subject(self):
        self.store.store_search_results("PineTime distinction", [{"title": "Watch", "url": "https://example.test/watch", "snippet": "A watch."}], topic="PineTime distinction", summary="A smartwatch.")
        self.place_every_topic()

        self.consolidate(json.dumps({"reason": "Unclear.", "name": ""}))

        self.assertEqual(list(self.topic_names()), ["PineTime distinction"])

    def test_the_naming_call_lists_existing_topics_sharing_a_word(self):
        query = "can you search the internet for information about the pinetime smartwatch"
        self.store.store_search_results(query, [{"title": "Watch", "url": "https://example.test/watch", "snippet": "A watch."}], topic=query)
        self.store.add_fact("pinetime", "The PineTime is a smartwatch.")
        self.store.add_fact("SQLite", "SQLite is small.")
        self.place_every_topic()

        worked, calls = self.consolidate(json.dumps({"reason": "It asks about the PineTime.", "name": "pinetime"}))

        self.assertIn("Existing topics:\npinetime", calls[0].args[2])
        self.assertNotIn("SQLite", calls[0].args[2])
        self.assertEqual(set(self.topic_names()), {"pinetime", "SQLite"})

    def test_a_query_topic_with_no_summary_or_facts_is_still_named(self):
        query = "can you search the internet for information about the pinetime smartwatch"
        self.store.store_search_results(query, [{"title": "Watch", "url": "https://example.test/watch", "snippet": "A watch."}], topic=query)
        self.place_every_topic()

        self.consolidate(json.dumps({"reason": "It asks about the PineTime.", "name": "PineTime"}))

        self.assertEqual(list(self.topic_names()), ["PineTime"])

    def test_a_renamed_topic_with_no_facts_is_researched_under_its_new_name(self):
        query = "what is the pinephone"
        self.store.store_search_results(query, [{"title": "Phone", "url": "https://example.test/phone", "snippet": "A phone."}], topic=query, summary="A Linux phone.")
        self.place_every_topic()

        self.consolidate(json.dumps({"reason": "It is about the PinePhone.", "name": "PinePhone"}))

        self.assertEqual([job["topic"] for job in self.store.queue_status()], ["PinePhone"])

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

        worked, calls = self.consolidate(verdict("first is broader"), json.dumps({"summary": "SQLite overview."}))

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

    def test_a_stated_user_memory_outlasts_a_newer_learned_one_it_contradicts(self):
        self.store.add_user_memory("preference", "Prefers Python for scripting tasks.", origin="user")
        self.store.add_user_memory("preference", "Prefers Rust for scripting tasks.")

        self.consolidate(verdict("contradict"))

        self.assertEqual([memory["statement"] for memory in self.store.user_memories()], ["Prefers Python for scripting tasks."])

    def test_a_topic_is_moved_under_the_parent_the_model_picks(self):
        self.store.add_fact("Databases", "Databases hold data.")
        self.store.set_topic_summary("Databases", "Systems that store data.")
        self.store.add_fact("Notes", "Notes are written down.")
        self.store.add_fact("Web frameworks", "Frameworks serve pages.")
        self.store.add_fact("PostgreSQL", "PostgreSQL is a relational database.")
        self.store.add_topic("PostgreSQL", parent="Web frameworks")
        self.place_every_topic()
        with self.store._connect() as connection:
            connection.execute("UPDATE topics SET placed_at = NULL WHERE name = 'PostgreSQL'")

        worked, calls = self.consolidate(verdict("Databases", key="parent"), json.dumps({"summary": "Databases overview."}))

        self.assertTrue(worked)
        # Notes has no summary, so nothing tells the model what it covers.
        self.assertEqual(
            set(calls[0].kwargs["json_schema"]["properties"]["parent"]["enum"]),
            {TOP_LEVEL, "Databases", "Web frameworks"},
        )
        self.assertEqual(self.topic_names()["PostgreSQL"], "Databases")
        edges = [(edge["source"], edge["relation"], edge["target"]) for edge in self.store.graph()]
        self.assertNotIn(("Web frameworks", "contains", "PostgreSQL"), edges)

    def test_a_researched_parent_keeps_its_own_summary_when_a_topic_moves_under_it(self):
        self.store.store_search_results("pinephone", [{"title": "Phone", "url": "https://example.test/phone", "snippet": "A phone."}], topic="PinePhone", summary="A Linux phone made by Pine64.")
        self.store.add_fact("Owner forums", "The community meets on Matrix.")
        self.store.set_topic_summary("Owner forums", "Where PinePhone owners talk.")
        self.store.add_fact("PinePhone", "The PinePhone runs Linux.")
        self.place_every_topic()
        with self.store._connect() as connection:
            connection.execute("UPDATE topics SET placed_at = NULL WHERE name = 'Owner forums'")
            connection.execute("INSERT INTO consolidation_checks VALUES ('name', (SELECT id FROM topics WHERE name = 'PinePhone'), (SELECT id FROM topics WHERE name = 'PinePhone'), 'PinePhone', 0)")

        worked, calls = self.consolidate(verdict("PinePhone", key="parent"))

        self.assertTrue(worked)
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.topic_names()["Owner forums"], "PinePhone")
        with self.store._connect() as connection:
            summary = connection.execute("SELECT summary FROM topics WHERE name = 'PinePhone'").fetchone()["summary"]
        self.assertEqual(summary, "A Linux phone made by Pine64.")

    def test_a_researched_topic_can_name_a_new_parent_made_where_it_sits(self):
        self.store.add_fact("Hardware", "Hardware is physical computing equipment.")
        self.store.set_topic_summary("Hardware", "Physical computing equipment.")
        self.store.add_fact("PineTime", "The PineTime is a smartwatch made by Pine64.")
        self.store.store_search_results("pinephone linux phone", [{"title": "Phone", "url": "https://example.test/phone", "snippet": "A phone."}], topic="PinePhone", summary="A Linux phone made by Pine64.")
        self.store.add_topic("PinePhone", parent="Hardware")
        self.place_every_topic()
        with self.store._connect() as connection:
            connection.execute("UPDATE topics SET placed_at = NULL WHERE name = 'PinePhone'")

        placement = json.dumps({"reason": "Both are Pine64 devices.", "parent": NEW_PARENT, "new_parent": "Pine64"})
        worked, calls = self.consolidate(placement, json.dumps({"summary": "Pine64 makes the PinePhone."}), json.dumps({"summary": "Hardware."}))

        self.assertTrue(worked)
        self.assertIn(NEW_PARENT, calls[0].kwargs["json_schema"]["properties"]["parent"]["enum"])
        self.assertEqual(self.topic_names(), {"Hardware": None, "Pine64": "Hardware", "PinePhone": "Pine64", "PineTime": None})
        self.assertEqual(self.store.child_summaries("Hardware"), [("Pine64", "Pine64 makes the PinePhone.")])

    def test_a_topic_never_researched_cannot_name_a_new_parent(self):
        self.store.add_fact("Hardware", "Hardware is physical computing equipment.")
        self.store.set_topic_summary("Hardware", "Physical computing equipment.")
        self.store.add_topic("Pine64", parent="PineTime")
        self.store.add_fact("Pine64", "Pine64 makes single-board computers.")
        self.store.add_fact("PineTime", "The PineTime is a smartwatch.")
        self.place_every_topic()
        with self.store._connect() as connection:
            connection.execute("UPDATE topics SET placed_at = NULL WHERE name = 'Pine64'")

        worked, calls = self.consolidate(verdict("Hardware", key="parent"), json.dumps({"summary": "Hardware."}), json.dumps({"summary": "PineTime."}))

        self.assertTrue(worked)
        self.assertNotIn(NEW_PARENT, calls[0].kwargs["json_schema"]["properties"]["parent"]["enum"])
        self.assertEqual(self.topic_names()["Pine64"], "Hardware")

    def test_a_topic_whose_name_holds_every_word_of_this_one_and_more_is_not_offered_as_a_parent(self):
        for name in ("PinePhone", "PinePhone community", "Pine64"):
            self.store.add_fact(name, f"{name} is real.")
            self.store.set_topic_summary(name, f"About {name}.")

        candidates = self.store.placement_candidates(self.store.add_topic("PinePhone"))

        self.assertEqual({candidate["name"] for candidate in candidates}, {"Pine64"})

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
