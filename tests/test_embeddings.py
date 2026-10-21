import re
import tempfile
import unittest
import unittest.mock
from pathlib import Path
from unittest.mock import patch

from smartharness.background import index_knowledge
from smartharness.embeddings import normalize
from smartharness.knowledge import KnowledgeStore, _fuse_rankings
from smartharness.settings import DEFAULT_SETTINGS

# Words that mean the same thing share a dimension, so the fake model "understands" paraphrases.
CONCEPTS = {
    "fastapi": 0, "api": 0, "web": 0,
    "endpoints": 1, "handlers": 1, "requests": 1,
    "async": 2, "blocking": 2, "event": 2, "loop": 2,
    "cargo": 3, "crates": 3, "rust": 3,
    "bm25": 4, "ranking": 4, "fts5": 4, "search": 4,
}


class FakeEmbedder:
    name = "fake.gguf"

    def __init__(self, fail=False):
        self.fail = fail
        self.documents = []

    def vector(self, text):
        vector = [0.0] * 6
        for word in re.findall(r"\w+", text.casefold()):
            vector[CONCEPTS.get(word, 5)] += 1.0 if word in CONCEPTS else 0.1
        return normalize(vector)

    def embed_documents(self, texts):
        self.documents.extend(texts)
        return [self.vector(text) for text in texts]

    def embed_query(self, text):
        if self.fail:
            raise RuntimeError("model will not load")
        return self.vector(text)


class EmbeddingRetrievalTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.database_path = Path(self.directory.name) / "knowledge.db"
        self.embedder = FakeEmbedder()
        self.store = KnowledgeStore(self.database_path, self.embedder)

    def tearDown(self):
        self.directory.cleanup()

    def index_everything(self):
        items = self.store.items_to_embed(self.embedder.name, 100)
        self.store.save_embeddings(self.embedder.name, items, self.embedder.embed_documents([body for *_, body in items]))

    def test_a_fact_sharing_no_words_with_the_request_is_found_by_meaning(self):
        self.store.add_fact("Web frameworks", "FastAPI runs async endpoints on the event loop.")
        self.store.add_fact("Rust", "Cargo builds crates.")
        self.index_everything()

        recalled = self.store.recall("How do I keep my web API's request handlers from blocking?")

        self.assertEqual([fact["statement"] for fact in recalled["facts"]], ["FastAPI runs async endpoints on the event loop."])

    def test_without_a_working_model_recall_stays_lexical(self):
        self.store.add_fact("Rust", "Cargo builds crates.")
        self.index_everything()
        store = KnowledgeStore(self.database_path, FakeEmbedder(fail=True))

        self.assertEqual([fact["statement"] for fact in store.recall("cargo crates")["facts"]], ["Cargo builds crates."])
        self.assertEqual(store.recall("How do I package a library?")["facts"], [])

    def test_a_branch_is_entered_by_meaning_when_no_topic_is_named(self):
        self.store.add_topic("Full-text search")
        self.store.set_topic_summary("Full-text search", "fts5 bm25 ranking search")
        self.store.add_fact("Full-text search", "Tokenizers split text into words.")
        self.index_everything()

        recalled = self.store.recall("Which ranking does sqlite search use?")

        self.assertIn("Tokenizers split text into words.", [fact["statement"] for fact in recalled["facts"]])

    def test_only_new_or_changed_items_are_embedded_again(self):
        self.store.add_fact("Rust", "Cargo builds crates.")
        self.index_everything()
        self.assertEqual(self.store.items_to_embed(self.embedder.name, 100), [])

        self.store.set_topic_summary("Rust", "A systems language.")

        self.assertEqual(
            [(kind, body) for kind, _, body in self.store.items_to_embed(self.embedder.name, 100)],
            [("topic", "Rust: A systems language.")],
        )
        self.assertEqual(len(self.store.items_to_embed("another.gguf", 100)), 2)

    def test_rankings_are_fused_so_an_item_high_in_either_comes_first(self):
        self.assertEqual(_fuse_rankings([1, 2, 3], [3, 4]), [3, 1, 2, 4])

    def test_the_background_worker_indexes_one_batch_per_pass(self):
        for number in range(10):
            self.store.add_fact("Rust", f"Cargo fact {number}.")
        settings = {**DEFAULT_SETTINGS, "knowledge_db_path": str(self.database_path), "embedding_model_path": "fake.gguf"}

        with patch("smartharness.background.get_embedder", return_value=self.embedder):
            passes = 0
            while index_knowledge(settings):
                passes += 1

        self.assertEqual(passes, 2)
        self.assertEqual(len(self.embedder.documents), 11)
        self.assertEqual(self.store.items_to_embed(self.embedder.name, 100), [])

    def test_the_worker_does_nothing_without_an_embedding_model(self):
        settings = {**DEFAULT_SETTINGS, "knowledge_db_path": str(self.database_path), "embedding_model_path": ""}
        self.store.add_fact("Rust", "Cargo builds crates.")

        self.assertFalse(index_knowledge(settings))


class EmbedderTests(unittest.TestCase):
    def test_a_repeated_query_is_embedded_once(self):
        from smartharness.embeddings import QUERY_INSTRUCTION, Embedder

        embedder = Embedder("unused.gguf")
        model = unittest.mock.Mock()
        model.embed.return_value = [3.0, 4.0]
        embedder._model = model

        self.assertEqual(embedder.embed_query("cargo"), [0.6, 0.8])
        self.assertEqual(embedder.embed_query("cargo"), [0.6, 0.8])
        model.embed.assert_called_once_with(QUERY_INSTRUCTION + "cargo")


if __name__ == "__main__":
    unittest.main()
