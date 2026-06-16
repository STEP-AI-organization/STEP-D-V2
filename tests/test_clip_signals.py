import sys
import unittest
from pathlib import Path
from types import SimpleNamespace


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))

from app.services.clip_signals import build_korean_shorts_signals  # noqa: E402


class KoreanShortsSignalsTest(unittest.TestCase):
    def test_builds_hook_labels_and_score_breakdown(self):
        clip = SimpleNamespace(
            title="진짜 소름 돋는 반전 장면",
            reason="댓글 반응이 갈릴 만한 순간입니다.",
            thumbnail_text="소름 반전",
            transcript="그런데 갑자기 분위기가 뒤집혔습니다.",
            score=92,
            local_score=76.4,
            gemini_score=95,
            evaluation_json={
                "hook_terms": ["소름", "반전"],
                "hook_score": 91,
                "emotion_score": 84,
                "retention_score": 88,
                "shareability_score": 82,
                "boundary_reason": "word-start, word-end",
                "title_options": [{"style": "hook"}, {"style": "comment"}],
            },
        )

        signals = build_korean_shorts_signals(clip, {"labels": ["쇼츠", "한국쇼츠", "반전"]})

        self.assertEqual(["소름", "반전"], signals["hook_terms"])
        self.assertIn("한국쇼츠", signals["labels"])
        self.assertIn({"label": "Korean hook", "value": 76.4}, signals["score_breakdown"])
        self.assertIn({"label": "Share", "value": 82.0}, signals["score_breakdown"])
        self.assertEqual("Vision + Korean Shorts scoring", signals["selection_basis"])
        self.assertEqual("word-start, word-end", signals["boundary_reason"])
        self.assertEqual(["hook", "comment"], signals["title_styles"])


if __name__ == "__main__":
    unittest.main()
