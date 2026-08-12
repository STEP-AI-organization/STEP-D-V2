from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from core.reframe.cli import write_json_atomic
from core.reframe.planner import (
    FaceBox,
    FrameObservation,
    ScoreMetrics,
    build_beat_segments,
    build_reframe_plan,
    decide_layout,
)
from core.reframe.video import ModelConfigurationError, resolve_model_path


def metrics(**overrides) -> ScoreMetrics:
    values = {
        "detection_coverage": 1.0,
        "single_subject_dominance": 1.0,
        "dominant_frame_rate": 1.0,
        "crop_safety_rate": 1.0,
        "tracking_stability": 1.0,
        "mean_confidence": 1.0,
        "max_missing_run_sec": 0.0,
        "max_ambiguous_run_sec": 0.0,
    }
    values.update(overrides)
    return ScoreMetrics(**values)


def face(cx: float = 0.5, confidence: float = 0.9, width: float = 0.10) -> FaceBox:
    return FaceBox(cx - width / 2, 0.15, width, 0.14, confidence)


class ScorePolicyTests(unittest.TestCase):
    def test_fixed_threshold_70_is_fill_and_69_is_fit(self) -> None:
        exactly_70 = metrics(
            detection_coverage=0.75,
            single_subject_dominance=0.60,
            dominant_frame_rate=0.60,
            crop_safety_rate=0.80,
            tracking_stability=0.60,
            mean_confidence=0.50,
            max_missing_run_sec=0.50,
            max_ambiguous_run_sec=0.50,
        )
        score, layout, _ = decide_layout(exactly_70)
        self.assertEqual((score, layout), (70, "fill"))

        score, layout, reasons = decide_layout(metrics(
            detection_coverage=0.75,
            single_subject_dominance=0.60,
            dominant_frame_rate=0.60,
            crop_safety_rate=0.80,
            tracking_stability=0.53,
            mean_confidence=0.50,
        ))
        self.assertEqual((score, layout), (69, "fit"))
        self.assertIn("SCORE_BELOW_THRESHOLD", reasons)

    def test_safety_gates_override_a_high_score(self) -> None:
        cases = [
            ("LOW_DETECTION_COVERAGE", {"detection_coverage": 0.74}),
            ("MULTI_PERSON_DOMINANCE", {"dominant_frame_rate": 0.59}),
            ("UNSAFE_VERTICAL_CROP", {"crop_safety_rate": 0.79}),
            ("LONG_DETECTION_GAP", {"max_missing_run_sec": 0.501}),
            ("MULTI_PERSON_AMBIGUOUS", {"max_ambiguous_run_sec": 0.501}),
        ]
        for expected_reason, override in cases:
            with self.subTest(expected_reason):
                score, layout, reasons = decide_layout(metrics(**override))
                self.assertGreaterEqual(score, 70)
                self.assertEqual(layout, "fit")
                self.assertIn(expected_reason, reasons)


class CoverageTests(unittest.TestCase):
    def test_partial_beats_create_explicit_fit_gaps_and_full_coverage(self) -> None:
        segments = build_beat_segments({"beats": [
            {"id": 10, "start": 1.0, "end": 4.0},
            {"id": 11, "start": 6.0, "end": 9.0},
        ]}, 0.0, 10.0)
        self.assertEqual([(s["start"], s["end"]) for s in segments], [
            (0.0, 1.0), (1.0, 4.0), (4.0, 6.0), (6.0, 9.0), (9.0, 10.0),
        ])
        self.assertEqual(segments[0]["beatId"], -1)
        self.assertTrue(segments[0]["synthetic"])
        self.assertEqual(segments[-1]["end"], 10.0)

    def test_overlap_is_trimmed_without_duplicate_time(self) -> None:
        segments = build_beat_segments({"beats": [
            {"id": 1, "start": 0.0, "end": 6.0},
            {"id": 2, "start": 5.0, "end": 10.0},
        ]}, 0.0, 10.0)
        self.assertEqual([(s["start"], s["end"]) for s in segments], [(0.0, 6.0), (6.0, 10.0)])

    def test_sub_millisecond_gap_cannot_create_zero_length_segment(self) -> None:
        segments = build_beat_segments({"beats": [
            {"id": 1, "start": 0.0, "end": 5.0002},
            {"id": 2, "start": 5.0004, "end": 10.0},
        ]}, 0.0, 10.0)
        self.assertTrue(all(segment["end"] > segment["start"] for segment in segments))
        self.assertEqual(segments[0]["start"], 0.0)
        self.assertEqual(segments[-1]["end"], 10.0)
        self.assertTrue(all(
            current["end"] == following["start"]
            for current, following in zip(segments, segments[1:])
        ))


class PlannerTests(unittest.TestCase):
    def test_missing_and_multi_person_beats_fail_safe_to_fit(self) -> None:
        observations: list[FrameObservation] = []
        for index in range(50):
            t = index / 5
            if t < 5:
                faces = ()
            else:
                faces = (face(0.38), face(0.62))
            observations.append(FrameObservation(t, faces))
        plan = build_reframe_plan(
            beats_payload={"beats": [
                {"id": 1, "start": 0.0, "end": 5.0},
                {"id": 2, "start": 5.0, "end": 10.0},
            ]},
            observations=observations,
            clip_start=0.0,
            clip_end=10.0,
            source_width=640,
            source_height=360,
        )
        self.assertEqual([beat["layout"] for beat in plan["beats"]], ["fit", "fit"])
        self.assertIn("LOW_DETECTION_COVERAGE", plan["beats"][0]["reasonCodes"])
        self.assertIn("MULTI_PERSON_DOMINANCE", plan["beats"][1]["reasonCodes"])

    def test_fill_tracking_is_smoothed_normalized_and_resets_on_shot(self) -> None:
        observations = []
        for index in range(50):
            t = index / 5
            base = 0.35 if t < 5 else 0.70
            jitter = 0.015 if index % 2 else -0.015
            observations.append(FrameObservation(t, (face(base + jitter),)))
        plan = build_reframe_plan(
            beats_payload={"beats": [{"id": 1, "start": 0.0, "end": 10.0}]},
            observations=observations,
            clip_start=0.0,
            clip_end=10.0,
            source_width=640,
            source_height=360,
            shot_boundaries=[5.0],
        )
        beat = plan["beats"][0]
        self.assertEqual(beat["layout"], "fill")
        tracking = beat["tracking"]
        self.assertTrue(all(0.0 <= key["cx"] <= 1.0 and 0.0 <= key["cy"] <= 1.0 for key in tracking))
        before = max((key for key in tracking if key["t"] < 5.0), key=lambda key: key["t"])
        after = min((key for key in tracking if key["t"] >= 5.0), key=lambda key: key["t"])
        self.assertLess(before["cx"], 0.5)
        self.assertGreater(after["cx"], 0.5)
        self.assertLessEqual(after["t"] - before["t"], 0.002)

    def test_atomic_json_replaces_existing_complete_document(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "plan.json"
            path.write_text('{"old":true}\n', encoding="utf-8")
            write_json_atomic(path, {"version": 1, "beats": []})
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"version": 1, "beats": []})
            self.assertEqual(list(Path(directory).glob("*.tmp")), [])

    def test_missing_model_has_actionable_deterministic_error(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "missing.tflite"
            with self.assertRaisesRegex(ModelConfigurationError, "REFRAME_FACE_MODEL"):
                resolve_model_path(missing)


if __name__ == "__main__":
    unittest.main()
