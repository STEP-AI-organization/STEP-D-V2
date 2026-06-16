import sys
import unittest
from pathlib import Path
from types import SimpleNamespace


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))

from app.services.clip_briefing import build_clip_briefing  # noqa: E402


class ClipBriefingTest(unittest.TestCase):
    def test_builds_publish_candidate_briefing_with_actions(self):
        clip = SimpleNamespace(
            title="Jackpot reveal",
            reason="The clip opens with a strong surprise and keeps the payoff clear.",
            thumbnail_text="Jackpot moment",
            transcript="This is the setup. Then the jackpot reveal happens.",
            score=92,
            local_score=81,
            gemini_score=94,
            start_time=10.0,
            end_time=48.0,
            evaluation_json={
                "hook_terms": ["jackpot", "reveal"],
                "hook_score": 90,
                "retention_score": 88,
                "shareability_score": 86,
            },
        )

        briefing = build_clip_briefing(
            clip,
            {"labels": ["reveal", "shorts"]},
            {"hook_terms": ["jackpot", "reveal"]},
        )

        self.assertEqual("publish_candidate", briefing["score_band"])
        self.assertIn("Jackpot moment", briefing["first_three_seconds"])
        self.assertTrue(briefing["retention_plan"])
        self.assertTrue(briefing["upload_actions"])
        self.assertEqual(38.0, briefing["score_summary"]["duration_seconds"])

    def test_flags_long_and_weak_clip_risks(self):
        clip = SimpleNamespace(
            title="Slow setup",
            reason="Needs more editing.",
            thumbnail_text="",
            transcript="Long setup with little payoff.",
            score=59,
            local_score=50,
            gemini_score=58,
            start_time=0.0,
            end_time=80.0,
            evaluation_json={
                "hook_score": 40,
                "retention_score": 52,
                "shareability_score": 50,
                "fallback": True,
                "boundary_reason": "fallback-start-padding",
            },
        )

        briefing = build_clip_briefing(clip, {"labels": []}, {})

        self.assertEqual("weak", briefing["score_band"])
        self.assertGreaterEqual(len(briefing["risk_flags"]), 4)
        self.assertIn("Apply & Render", " ".join(briefing["upload_actions"]))


if __name__ == "__main__":
    unittest.main()
