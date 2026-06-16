import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))

try:
    from app.services import pipeline  # noqa: E402
except ModuleNotFoundError as exc:
    if exc.name in {"pydantic", "pydantic_settings", "sqlalchemy"}:
        pipeline = None
    else:
        raise


@unittest.skipIf(pipeline is None, "API dependencies are not installed in this Python environment")
class BurnedInCaptionDetectionTest(unittest.TestCase):
    def test_subtitle_render_plan_respects_prior_burned_in_detection_metadata(self):
        settings = SimpleNamespace(shorts_subtitle_mode_default="auto", shorts_subtitles_enabled=True)
        metadata = {
            "subtitle_mode": "auto",
            "source_has_burned_in_captions": True,
            "burned_in_caption_confidence": 0.93,
            "burned_in_caption_reason": "large repeated dialogue captions",
            "burned_in_caption_detection_checked": True,
        }
        with patch.object(pipeline, "probe_has_subtitle_stream", return_value=False):
            plan = pipeline.subtitle_render_plan(Path("source.mp4"), settings, metadata)

        self.assertFalse(plan["render"])
        self.assertTrue(plan["source_has_burned_in_captions"])
        self.assertEqual(0.93, plan["burned_in_caption_confidence"])
        self.assertTrue(plan["burned_in_caption_detection_checked"])

    def test_apply_burned_in_detection_skips_generated_captions_above_threshold(self):
        subtitle_plan = {
            "render": True,
            "source_has_burned_in_captions": False,
            "burned_in_caption_confidence": 0.0,
            "burned_in_caption_reason": "",
            "burned_in_caption_detection_checked": False,
        }
        evaluated = [(SimpleNamespace(), {}, [Path("frame_01.jpg"), Path("frame_02.jpg")])]
        settings = SimpleNamespace(
            burned_in_caption_detection_enabled=True,
            burned_in_caption_detection_max_frames=2,
            burned_in_caption_detection_confidence_threshold=0.72,
        )
        warnings: list[str] = []

        with patch.object(
            pipeline,
            "detect_burned_in_captions",
            return_value={
                "has_burned_in_captions": True,
                "confidence": 0.91,
                "reason": "Large repeated Korean dialogue captions are visible.",
            },
        ):
            pipeline._apply_burned_in_caption_detection(subtitle_plan, evaluated, settings, warnings)

        self.assertFalse(subtitle_plan["render"])
        self.assertTrue(subtitle_plan["source_has_burned_in_captions"])
        self.assertEqual(0.91, subtitle_plan["burned_in_caption_confidence"])
        self.assertIn("Large repeated", subtitle_plan["burned_in_caption_reason"])
        self.assertTrue(warnings)

    def test_apply_burned_in_detection_keeps_captions_below_threshold(self):
        subtitle_plan = {
            "render": True,
            "source_has_burned_in_captions": False,
            "burned_in_caption_confidence": 0.0,
            "burned_in_caption_reason": "",
            "burned_in_caption_detection_checked": False,
        }
        evaluated = [(SimpleNamespace(), {}, [Path("frame_01.jpg")])]
        settings = SimpleNamespace(
            burned_in_caption_detection_enabled=True,
            burned_in_caption_detection_max_frames=1,
            burned_in_caption_detection_confidence_threshold=0.72,
        )
        warnings: list[str] = []

        with patch.object(
            pipeline,
            "detect_burned_in_captions",
            return_value={
                "has_burned_in_captions": True,
                "confidence": 0.45,
                "reason": "Maybe a lower third label.",
            },
        ):
            pipeline._apply_burned_in_caption_detection(subtitle_plan, evaluated, settings, warnings)

        self.assertTrue(subtitle_plan["render"])
        self.assertFalse(subtitle_plan["source_has_burned_in_captions"])
        self.assertEqual(0.45, subtitle_plan["burned_in_caption_confidence"])
        self.assertFalse(warnings)


if __name__ == "__main__":
    unittest.main()
