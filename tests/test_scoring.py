import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))

from app.services.candidates import Candidate  # noqa: E402
from app.services.scoring import final_score, normalize_score  # noqa: E402


class ScoringTest(unittest.TestCase):
    def test_normalizes_ten_point_gemini_scores(self):
        self.assertEqual(70, normalize_score(7))
        self.assertEqual(85, normalize_score(85))
        self.assertEqual(73, normalize_score(None, default=73))

    def test_final_score_uses_normalized_gemini_score(self):
        candidate = Candidate(
            id="cand_001",
            start=0.0,
            end=42.0,
            anchor_time=1.0,
            transcript="test",
            local_score=90.0,
            hook_terms=[],
        )

        self.assertEqual(74, final_score(candidate, {"score": 7}))


if __name__ == "__main__":
    unittest.main()
