"""vertical-candidates-v1 — 4택 비교 정책 고정 테스트.

계획서(docs/plans/active/reframe-compare-viewer-plan.md §7)의 fixture 목록을 덮는다:
단일 인물·다인 모호·무얼굴·클로즈업 차등·히스테리시스(샷 경계·2초·10점)·
안전 강등·기존 Fit/Fill 회귀 변환·결정론.
"""
from __future__ import annotations

import unittest

from core.reframe.candidates import (
    HYSTERESIS_POINTS,
    LAYOUT_IDS,
    build_candidate_plans,
    is_aggressive,
    layout_crop_fraction,
    layout_from_legacy,
    layout_screen_utilization,
    timeline_from_legacy_plan,
)
from core.reframe.planner import FaceBox, FrameObservation

W, H = 1920, 1080  # 16:9 소스


def face(cx: float, width: float = 0.11, confidence: float = 0.9) -> FaceBox:
    return FaceBox(cx - width / 2, 0.15, width, 0.14, confidence)


def frames(
    start: float, end: float, faces_fn, fps: float = 5.0,
) -> list[FrameObservation]:
    out: list[FrameObservation] = []
    t = start
    index = 0
    while t < end - 1e-9:
        out.append(FrameObservation(t=round(t, 3), faces=tuple(faces_fn(index))))
        index += 1
        t = start + index / fps
    return out


def beats(*ranges: tuple[float, float]) -> list[dict]:
    return [
        {"id": i + 1, "start": s, "end": e} for i, (s, e) in enumerate(ranges)
    ]


def plan(observations, beat_ranges, *, shots=(), start=0.0, end=None):
    end = end if end is not None else beat_ranges[-1][1]
    return build_candidate_plans(
        beats_payload=beats(*beat_ranges),
        observations=observations,
        clip_start=start,
        clip_end=end,
        source_width=W,
        source_height=H,
        shot_boundaries=shots,
    )


class GeometryTests(unittest.TestCase):
    def test_crop_fraction_matches_aspect_presets(self) -> None:
        # aspect-presets.ts 의 1080×1920 rect 기하에서 유도되는 수평 크롭 폭.
        self.assertEqual(layout_crop_fraction("9:16-letterbox", W, H), 1.0)
        self.assertAlmostEqual(layout_crop_fraction("9:16-crop-sub", W, H), (1080 / 980) / (16 / 9), places=4)
        self.assertAlmostEqual(layout_crop_fraction("9:16-crop-main", W, H), (1080 / 1480) / (16 / 9), places=4)
        self.assertAlmostEqual(layout_crop_fraction("9:16-crop-full", W, H), (1080 / 1920) / (16 / 9), places=4)

    def test_aggressive_boundary_is_half_width(self) -> None:
        # 16:9: crop-sub(0.62)=비공격 · crop-main(0.41)·crop-full(0.32)=공격.
        self.assertFalse(is_aggressive("9:16-letterbox", W, H))
        self.assertFalse(is_aggressive("9:16-crop-sub", W, H))
        self.assertTrue(is_aggressive("9:16-crop-main", W, H))
        self.assertTrue(is_aggressive("9:16-crop-full", W, H))

    def test_utilization_ordering(self) -> None:
        values = [layout_screen_utilization(layout, W, H) for layout in LAYOUT_IDS]
        self.assertEqual(values, sorted(values))  # letterbox < sub < main < full


class SelectionTests(unittest.TestCase):
    def test_single_stable_face_selects_crop_full(self) -> None:
        result = plan(frames(0, 4, lambda i: [face(0.5)]), [(0.0, 4.0)])
        [segment] = result["segments"]
        self.assertEqual(segment["final"], "9:16-crop-full")
        by_layout = {c["layout"]: c for c in segment["candidates"]}
        self.assertTrue(all(c["eligible"] for c in by_layout.values()))
        self.assertIn("tracking", by_layout["9:16-crop-full"])

    def test_closeup_face_demotes_to_crop_main(self) -> None:
        # 얼굴이 crop-full 창 대비 너무 커서(>0.85) 꽉 채우기만 탈락한다.
        result = plan(frames(0, 4, lambda i: [face(0.5, width=0.30)]), [(0.0, 4.0)])
        [segment] = result["segments"]
        by_layout = {c["layout"]: c for c in segment["candidates"]}
        self.assertFalse(by_layout["9:16-crop-full"]["eligible"])
        self.assertIn("UNSAFE_VERTICAL_CROP", by_layout["9:16-crop-full"]["reasonCodes"])
        self.assertEqual(segment["final"], "9:16-crop-main")

    def test_very_large_face_falls_back_to_crop_sub(self) -> None:
        result = plan(frames(0, 4, lambda i: [face(0.5, width=0.42)]), [(0.0, 4.0)])
        [segment] = result["segments"]
        by_layout = {c["layout"]: c for c in segment["candidates"]}
        self.assertFalse(by_layout["9:16-crop-full"]["eligible"])
        self.assertFalse(by_layout["9:16-crop-main"]["eligible"])
        self.assertEqual(segment["final"], "9:16-crop-sub")

    def test_no_faces_selects_letterbox(self) -> None:
        result = plan(frames(0, 4, lambda i: []), [(0.0, 4.0)])
        [segment] = result["segments"]
        by_layout = {c["layout"]: c for c in segment["candidates"]}
        for layout in ("9:16-crop-sub", "9:16-crop-main", "9:16-crop-full"):
            self.assertFalse(by_layout[layout]["eligible"], layout)
            self.assertIn("LOW_DETECTION_COVERAGE", by_layout[layout]["reasonCodes"])
        self.assertEqual(segment["final"], "9:16-letterbox")

    def test_sustained_multi_person_ambiguity_forces_letterbox(self) -> None:
        # 두 얼굴 크기가 비슷(면적비 ~0.79 > 0.4)해 우세가 없다 — 0.5초 넘게 지속되면
        # 크롭 후보 전부 탈락(계획서: letterbox 우선).
        result = plan(
            frames(0, 4, lambda i: [face(0.30, width=0.12), face(0.72, width=0.095)]),
            [(0.0, 4.0)],
        )
        [segment] = result["segments"]
        by_layout = {c["layout"]: c for c in segment["candidates"]}
        for layout in ("9:16-crop-sub", "9:16-crop-main", "9:16-crop-full"):
            self.assertIn("MULTI_PERSON_AMBIGUOUS", by_layout[layout]["reasonCodes"], layout)
        self.assertEqual(segment["final"], "9:16-letterbox")


class HysteresisTests(unittest.TestCase):
    def big_then_medium(self, *, shots, ranges):
        # beat1 = 클로즈업(crop-main) · beat2 = 중간 크기(단독 선택이면 crop-full).
        observations = (
            frames(ranges[0][0], ranges[0][1], lambda i: [face(0.5, width=0.30)])
            + frames(ranges[1][0], ranges[1][1], lambda i: [face(0.5)])
        )
        return plan(observations, ranges, shots=shots)

    def test_switch_needs_shot_boundary(self) -> None:
        result = self.big_then_medium(shots=(), ranges=[(0.0, 4.0), (4.0, 8.0)])
        second = result["segments"][1]
        self.assertEqual(second["selected"], "9:16-crop-full")
        self.assertEqual(second["final"], "9:16-crop-main")
        self.assertIn("HOLD_NOT_AT_SHOT_BOUNDARY", second["hysteresis"])

    def test_switch_needs_min_hold_two_seconds(self) -> None:
        result = self.big_then_medium(shots=(1.0,), ranges=[(0.0, 1.0), (1.0, 8.0)])
        second = result["segments"][1]
        self.assertEqual(second["final"], "9:16-crop-main")
        self.assertIn("HOLD_MIN_DURATION", second["hysteresis"])

    def test_small_score_gap_keeps_previous_layout(self) -> None:
        # 샷 경계·2초 유지까지 통과해도 점수 차 10점 미만이면 전환하지 않는다.
        result = self.big_then_medium(shots=(4.0,), ranges=[(0.0, 4.0), (4.0, 8.0)])
        second = result["segments"][1]
        by_layout = {c["layout"]: c for c in second["candidates"]}
        gap = by_layout["9:16-crop-full"]["score"] - by_layout["9:16-crop-main"]["score"]
        self.assertLess(gap, HYSTERESIS_POINTS)
        self.assertEqual(second["final"], "9:16-crop-main")
        self.assertIn("HOLD_SCORE_HYSTERESIS", second["hysteresis"])

    def test_safety_demotion_switches_immediately(self) -> None:
        # 이전 레이아웃(crop-main)이 다음 구간에서 안전하지 않으면 샷 경계·2초 규칙과
        # 무관하게 즉시 보수 레이아웃으로 내려간다.
        observations = (
            frames(0, 4, lambda i: [face(0.5, width=0.30)])
            + frames(4, 8, lambda i: [])
        )
        result = plan(observations, [(0.0, 4.0), (4.0, 8.0)], shots=())
        second = result["segments"][1]
        self.assertEqual(second["final"], "9:16-letterbox")
        self.assertIn("SAFETY_DEMOTION", second["hysteresis"])

    def test_timeline_merges_and_counts_switches(self) -> None:
        result = self.big_then_medium(shots=(), ranges=[(0.0, 4.0), (4.0, 8.0)])
        self.assertEqual(result["timeline"], [
            {"start": 0.0, "end": 8.0, "layout": "9:16-crop-main"},
        ])
        self.assertEqual(result["switchesPerMinute"], 0.0)


class LegacyCompatTests(unittest.TestCase):
    def test_fit_fill_mapping(self) -> None:
        self.assertEqual(layout_from_legacy("fit"), "9:16-letterbox")
        self.assertEqual(layout_from_legacy("fill"), "9:16-crop-full")
        self.assertEqual(layout_from_legacy("9:16-crop-sub"), "9:16-crop-sub")

    def test_legacy_plan_converts_to_merged_timeline(self) -> None:
        legacy = {"beats": [
            {"start": 0.0, "end": 2.0, "layout": "fit"},
            {"start": 2.0, "end": 5.0, "layout": "fit"},
            {"start": 5.0, "end": 9.0, "layout": "fill"},
        ]}
        self.assertEqual(timeline_from_legacy_plan(legacy), [
            {"start": 0.0, "end": 5.0, "layout": "9:16-letterbox"},
            {"start": 5.0, "end": 9.0, "layout": "9:16-crop-full"},
        ])


class DeterminismTests(unittest.TestCase):
    def test_same_input_same_output(self) -> None:
        observations = frames(0, 4, lambda i: [face(0.5 + (i % 3) * 0.01)])
        first = plan(observations, [(0.0, 4.0)])
        second = plan(observations, [(0.0, 4.0)])
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
