import json
import tempfile
import unittest
from pathlib import Path

from smartharness.recall_benchmark import (
    QUESTIONS_PATH,
    SEED_PATH,
    Answer,
    Question,
    Score,
    load_questions,
    score_recall,
    summarize,
)


class RecallBenchmarkTests(unittest.TestCase):
    def test_the_shipped_questions_score_by_words_alone(self):
        score = score_recall(SEED_PATH, load_questions(QUESTIONS_PATH), None, "words only")
        summary = summarize(score)

        self.assertEqual(summary["shared words"], 1.0)
        self.assertEqual(summary["unrelated"], 1.0)
        self.assertLess(summary["paraphrase"], 0.5)

    def test_scores_count_hits_coverage_and_rank(self):
        question = Question("q", "several facts", "query", ["A.", "B."])
        unrelated = Question("u", "unrelated", "other", [])
        score = Score("test", [Answer(question, ["C.", "A."], 0.5), Answer(unrelated, ["C."], 0.5)])

        summary = summarize(score)

        self.assertEqual(summary["several facts"], 1.0)
        self.assertEqual(summary["unrelated"], 0.0)
        self.assertEqual(summary["facts found"], 0.5)
        self.assertEqual(summary["mean reciprocal rank"], 0.5)

    def test_a_question_expecting_a_fact_not_in_the_seed_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "questions.json"
            path.write_text(json.dumps([{"id": "x", "kind": "paraphrase", "query": "q", "expected": ["Not seeded."]}]))

            with self.assertRaisesRegex(ValueError, "missing from the seed"):
                score_recall(SEED_PATH, load_questions(path), None, "words only")

    def test_unrelated_questions_may_not_list_expected_facts(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "questions.json"
            path.write_text(json.dumps([{"id": "x", "kind": "unrelated", "query": "q", "expected": ["A."]}]))

            with self.assertRaisesRegex(ValueError, "only when it is not unrelated"):
                load_questions(path)


if __name__ == "__main__":
    unittest.main()
