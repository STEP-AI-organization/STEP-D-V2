"""Deterministic ``vertical-candidates-v1`` 4-layout comparison policy.

Implements docs/plans/active/reframe-compare-viewer-plan.md §1–2: for every
Beat segment evaluate the four fixed vertical layouts, gate them on safety,
score the survivors with the plan's weight table, then run the shot-boundary /
2-second / 10-point hysteresis pass.  Pure Python — no model, no I/O — so the
policy is testable exactly like :mod:`core.reframe.planner`.

이 모듈은 **비교 전용**이다. 정식 fit/fill 경로(:func:`planner.build_reframe_plan`)는
여기서 손대지 않는다 — 사람이 승인하기 전에는 비교 결과가 정식 클립 상태를 바꾸지
않는다는 계획서 가정(§기본 가정)을 코드 구조로 지킨다.

계획서의 발화자 보존(20)·자막 안전(20) 축은 **아직 입력이 연결되지 않았다**
(diarization·자막 시간창). v1 은 남은 축(30+15+10+5=65)을 100 으로 재정규화하고,
결과 JSON 의 ``pendingAxes`` 로 그 사실을 소비자에게 알린다 — 조용히 0 점을 주면
가중치 표가 거짓말이 된다.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Sequence

from .planner import (
    _EPS,
    MAX_UNSAFE_RUN_SEC,
    MIN_CROP_SAFETY_RATE,
    MIN_DETECTION_COVERAGE,
    MIN_DOMINANT_FRAME_RATE,
    SAMPLE_FPS,
    FrameObservation,
    PlanInputError,
    ScoreMetrics,
    _clamp,
    _round_score,
    _select_frames,
    build_beat_segments,
    measure_metrics,
    smooth_tracking,
)

CANDIDATES_VERSION = 1
CANDIDATES_SCORE_VERSION = "vertical-candidates-v1"

# 세로 4종 — apps/{server,web}/…/aspect-presets.ts 와 **같은 id·같은 기하**.
# (aspect-parity.test.ts 가 서버·웹 파리티를 강제하고, 여기 기하 상수는 그 프리셋의
#  canvas 1080×1920 rect 를 그대로 옮긴 값이다. 한쪽을 바꾸면 셋이 같이 움직여야 한다.)
CANVAS_W = 1080
CANVAS_H = 1920
LAYOUT_IDS: tuple[str, ...] = (
    "9:16-letterbox",   # contain — 원본 전체 보존
    "9:16-crop-sub",    # rect 1080×980 — 위·아래 띠
    "9:16-crop-main",   # rect 1080×1480 — 위 자막띠
    "9:16-crop-full",   # cover 1080×1920 — 꽉 채우기
)
_LAYOUT_RECT_H: dict[str, int] = {
    "9:16-crop-sub": 980,
    "9:16-crop-main": 1480,
    "9:16-crop-full": CANVAS_H,
}

# 계획서 §2 가중치. 발화자·자막 축은 pendingAxes(입력 미연결) — 재정규화로 100 을 만든다.
WEIGHTS: dict[str, float] = {
    "subject_preservation": 30.0,
    "speaker_preservation": 20.0,   # pending — diarization 연결 후
    "subtitle_safety": 20.0,        # pending — 자막 시간창 + Safe Zone 기하 연결 후
    "crop_safety": 15.0,
    "screen_utilization": 10.0,
    "tracking_stability": 5.0,
}
PENDING_AXES: tuple[str, ...] = ("speaker_preservation", "subtitle_safety")

# 히스테리시스 — 계획서 §2 그대로.
MIN_HOLD_SEC = 2.0
HYSTERESIS_POINTS = 10
# 샷 경계 정렬 판정 여유. beat 경계는 GEBD 경계에서 파생되지만 밀리초 반올림이 섞인다.
SHOT_ALIGN_EPS = 0.05

# "공격적 크롭" 경계 — 원본 가로의 절반 미만만 남기면 공격적으로 본다
# (16:9 기준 crop-main 0.41 · crop-full 0.32 가 공격, crop-sub 0.62 는 아님).
AGGRESSIVE_CROP_FRACTION = 0.5


def layout_crop_fraction(layout: str, source_width: int, source_height: int) -> float:
    """Visible horizontal fraction of the source once the layout crops it.

    letterbox 는 크롭이 없다(1.0). rect/cover 는 rect 종횡비가 원본보다 좁은 만큼
    좌우가 잘린다 — cover 의 수평 크롭 폭 = rect_aspect / source_aspect.
    """
    if source_width <= 0 or source_height <= 0:
        raise PlanInputError("source width and height must be positive")
    if layout == "9:16-letterbox":
        return 1.0
    rect_h = _LAYOUT_RECT_H.get(layout)
    if rect_h is None:
        raise PlanInputError(f"unknown vertical layout: {layout!r}")
    rect_aspect = CANVAS_W / rect_h
    source_aspect = source_width / source_height
    return min(1.0, rect_aspect / source_aspect)


def layout_screen_utilization(layout: str, source_width: int, source_height: int) -> float:
    """Fraction of the 9:16 canvas height the video occupies (계획서 '화면 활용률')."""
    if source_width <= 0 or source_height <= 0:
        raise PlanInputError("source width and height must be positive")
    if layout == "9:16-letterbox":
        video_h = CANVAS_W * source_height / source_width
        return _clamp(video_h / CANVAS_H)
    return _clamp(_LAYOUT_RECT_H[layout] / CANVAS_H)


def is_aggressive(layout: str, source_width: int, source_height: int) -> bool:
    return layout_crop_fraction(layout, source_width, source_height) < AGGRESSIVE_CROP_FRACTION


def layout_from_legacy(layout: str) -> str:
    """기존 Fit/Fill 결과 호환 (계획서 §1): fit→letterbox · fill→crop-full."""
    if layout == "fit":
        return "9:16-letterbox"
    if layout == "fill":
        return "9:16-crop-full"
    if layout in LAYOUT_IDS:
        return layout
    raise PlanInputError(f"unknown legacy layout: {layout!r}")


@dataclass(frozen=True)
class _Axes:
    subject_preservation: float
    crop_safety: float
    screen_utilization: float
    tracking_stability: float


def _active_weight_total() -> float:
    return sum(v for k, v in WEIGHTS.items() if k not in PENDING_AXES)


def score_candidate(axes: _Axes) -> int:
    """0..100 — pending 축을 뺀 가중치를 100 으로 재정규화한 결정론 점수."""
    raw = (
        WEIGHTS["subject_preservation"] * _clamp(axes.subject_preservation)
        + WEIGHTS["crop_safety"] * _clamp(axes.crop_safety)
        + WEIGHTS["screen_utilization"] * _clamp(axes.screen_utilization)
        + WEIGHTS["tracking_stability"] * _clamp(axes.tracking_stability)
    )
    return _round_score(raw * 100.0 / _active_weight_total())


def _gate_crop_candidate(
    layout: str, metrics: ScoreMetrics, source_width: int, source_height: int,
) -> list[str]:
    """계획서 §2 안전성 검사 — 통과면 빈 목록, 아니면 탈락 사유."""
    reasons: list[str] = []
    if metrics.detection_coverage + _EPS < MIN_DETECTION_COVERAGE:
        reasons.append("LOW_DETECTION_COVERAGE")
    if (
        is_aggressive(layout, source_width, source_height)
        and metrics.dominant_frame_rate + _EPS < MIN_DOMINANT_FRAME_RATE
    ):
        reasons.append("MULTI_PERSON_DOMINANCE")
    if metrics.crop_safety_rate + _EPS < MIN_CROP_SAFETY_RATE:
        reasons.append("UNSAFE_VERTICAL_CROP")
    if metrics.max_missing_run_sec > MAX_UNSAFE_RUN_SEC + _EPS:
        reasons.append("LONG_DETECTION_GAP")
    if metrics.max_ambiguous_run_sec > MAX_UNSAFE_RUN_SEC + _EPS:
        reasons.append("MULTI_PERSON_AMBIGUOUS")
    return reasons


def _metrics_json(metrics: ScoreMetrics) -> dict[str, float]:
    return {
        "detectionCoverage": round(metrics.detection_coverage, 4),
        "singleSubjectDominance": round(metrics.single_subject_dominance, 4),
        "dominantFrameRate": round(metrics.dominant_frame_rate, 4),
        "cropSafetyRate": round(metrics.crop_safety_rate, 4),
        "trackingStability": round(metrics.tracking_stability, 4),
        "meanConfidence": round(metrics.mean_confidence, 4),
        "maxMissingRunSec": round(metrics.max_missing_run_sec, 3),
        "maxAmbiguousRunSec": round(metrics.max_ambiguous_run_sec, 3),
    }


def evaluate_segment_candidates(
    *,
    observations: Sequence[FrameObservation],
    segment_start: float,
    segment_end: float,
    shot_boundaries: Sequence[float],
    source_width: int,
    source_height: int,
    sample_fps: float = SAMPLE_FPS,
) -> list[dict[str, Any]]:
    """세그먼트 하나에 대한 4개 후보 — 레이아웃·점수·자격·사유·(크롭이면) 추적 경로."""
    frames = sorted(observations, key=lambda item: item.t)
    candidates: list[dict[str, Any]] = []
    for layout in LAYOUT_IDS:
        fraction = layout_crop_fraction(layout, source_width, source_height)
        utilization = layout_screen_utilization(layout, source_width, source_height)
        if layout == "9:16-letterbox":
            # 전체 보존 — 얼굴 유무와 무관하게 항상 안전한 폴백이다.
            axes = _Axes(1.0, 1.0, utilization, 1.0)
            candidates.append({
                "layout": layout,
                "eligible": True,
                "score": score_candidate(axes),
                "reasonCodes": ["FULL_SOURCE_PRESERVED"],
                "cropWidthFraction": round(fraction, 4),
                "metrics": None,
            })
            continue

        selected = _select_frames(frames, shot_boundaries, fraction)
        metrics = measure_metrics(selected, segment_start, segment_end, sample_fps)
        gate = _gate_crop_candidate(layout, metrics, source_width, source_height)
        axes = _Axes(
            subject_preservation=metrics.detection_coverage * metrics.single_subject_dominance,
            crop_safety=metrics.crop_safety_rate,
            screen_utilization=utilization,
            tracking_stability=metrics.tracking_stability,
        )
        item: dict[str, Any] = {
            "layout": layout,
            "eligible": not gate,
            "score": score_candidate(axes),
            "reasonCodes": gate if gate else ["SAFETY_GATES_PASSED"],
            "cropWidthFraction": round(fraction, 4),
            "metrics": _metrics_json(metrics),
        }
        if not gate:
            tracking = smooth_tracking(
                selected, segment_start, segment_end, shot_boundaries, fraction,
            )
            if tracking:
                item["tracking"] = tracking
            else:
                # planner 와 같은 방어 불변식 — 추적 경로 없는 크롭은 렌더할 수 없다.
                item["eligible"] = False
                item["reasonCodes"] = ["EMPTY_TRACKING_PATH"]
        candidates.append(item)
    return candidates


def _pick_layout(
    candidates: Sequence[dict[str, Any]],
    source_width: int,
    source_height: int,
) -> tuple[str, list[str]]:
    """안전 통과 후보 중 최고점. 동점은 보수적인 쪽(원본 보존 큰 쪽)이 이긴다.

    계획서 §2 추가 규칙 중 "단독 인물이 안정 추적되면 crop-full 우선" 은 v1 에서
    발화자 입력이 없어 **단독 얼굴 우세+추적 안정** 프록시로 구현한다.
    """
    eligible = [c for c in candidates if c["eligible"]]
    if not eligible:
        # letterbox 는 항상 eligible 이므로 도달 불가지만, 방어적으로 남긴다.
        return "9:16-letterbox", ["NO_ELIGIBLE_CANDIDATE"]

    def conservative_rank(candidate: dict[str, Any]) -> float:
        return layout_crop_fraction(candidate["layout"], source_width, source_height)

    best = max(eligible, key=lambda c: (c["score"], conservative_rank(c)))

    full = next((c for c in eligible if c["layout"] == "9:16-crop-full"), None)
    if full is not None and full is not best:
        m = full.get("metrics") or {}
        single_stable = (
            m.get("dominantFrameRate", 0.0) >= 0.90
            and m.get("trackingStability", 0.0) >= 0.90
        )
        if single_stable and best["score"] - full["score"] < HYSTERESIS_POINTS:
            return "9:16-crop-full", ["SINGLE_SUBJECT_STABLE_PREFERS_FULL"]
    return best["layout"], ["BEST_SCORE"]


def _is_at_shot_boundary(t: float, boundaries: Sequence[float], clip_start: float) -> bool:
    if abs(t - clip_start) <= SHOT_ALIGN_EPS:
        return True
    return any(abs(t - b) <= SHOT_ALIGN_EPS for b in boundaries)


def build_candidate_plans(
    *,
    beats_payload: dict[str, Any] | list[dict[str, Any]],
    observations: Sequence[FrameObservation],
    clip_start: float,
    clip_end: float,
    source_width: int,
    source_height: int,
    shot_boundaries: Iterable[float] = (),
    sample_fps: float = SAMPLE_FPS,
) -> dict[str, Any]:
    """클립 하나의 비교 산출물 — 세그먼트별 후보 4종 + 히스테리시스 확정 타임라인."""
    if sample_fps <= 0:
        raise PlanInputError("sample_fps must be positive")
    segments = build_beat_segments(beats_payload, clip_start, clip_end)
    shots = sorted(
        float(value) for value in shot_boundaries
        if clip_start < float(value) < clip_end
    )
    sorted_observations = sorted(observations, key=lambda item: item.t)

    planned: list[dict[str, Any]] = []
    for segment in segments:
        start = float(segment["start"])
        end = float(segment["end"])
        if segment["synthetic"]:
            planned.append({
                "beatId": segment["beatId"],
                "start": start,
                "end": end,
                "synthetic": True,
                "candidates": [],
                "selected": "9:16-letterbox",
                "selectedReasons": ["BEAT_GAP_FALLBACK"],
            })
            continue
        frames = [
            item for item in sorted_observations
            if start - _EPS <= item.t < end - _EPS
        ]
        candidates = evaluate_segment_candidates(
            observations=frames,
            segment_start=start,
            segment_end=end,
            shot_boundaries=shots,
            source_width=source_width,
            source_height=source_height,
            sample_fps=sample_fps,
        )
        selected, why = _pick_layout(candidates, source_width, source_height)
        planned.append({
            "beatId": segment["beatId"],
            "start": start,
            "end": end,
            "synthetic": False,
            "candidates": candidates,
            "selected": selected,
            "selectedReasons": why,
        })

    # ── 히스테리시스 (계획서 §2): 샷 경계 전환만 · 2초 유지 · 10점 미만이면 유지 ──
    previous: str | None = None
    previous_since = float(clip_start)
    for item in planned:
        chosen = item["selected"]
        hysteresis: list[str] = []
        if previous is not None and chosen != previous:
            prev_candidate = next(
                (c for c in item.get("candidates", []) if c["layout"] == previous), None,
            )
            # 이전 레이아웃이 이번 구간에서 안전하지 않으면 **즉시** 전환(보수 강등) —
            # 유지 규칙이 안전 악화를 이기면 안 된다(계획서 §2 마지막 줄).
            previous_safe = bool(prev_candidate and prev_candidate["eligible"]) or previous == "9:16-letterbox"
            if previous_safe:
                if not _is_at_shot_boundary(item["start"], shots, float(clip_start)):
                    chosen, hysteresis = previous, ["HOLD_NOT_AT_SHOT_BOUNDARY"]
                elif item["start"] - previous_since < MIN_HOLD_SEC - _EPS:
                    chosen, hysteresis = previous, ["HOLD_MIN_DURATION"]
                else:
                    chosen_candidate = next(
                        (c for c in item["candidates"] if c["layout"] == item["selected"]), None,
                    )
                    prev_score = prev_candidate["score"] if prev_candidate else 0
                    new_score = chosen_candidate["score"] if chosen_candidate else 0
                    if new_score - prev_score < HYSTERESIS_POINTS:
                        chosen, hysteresis = previous, ["HOLD_SCORE_HYSTERESIS"]
            else:
                hysteresis = ["SAFETY_DEMOTION"]
        if chosen != previous:
            previous_since = float(item["start"])
        previous = chosen
        item["final"] = chosen
        item["hysteresis"] = hysteresis

    # 확정 타임라인 — 같은 레이아웃 연속 구간을 합친다 (뷰어의 샷별 타임라인 재료).
    timeline: list[dict[str, Any]] = []
    for item in planned:
        if timeline and timeline[-1]["layout"] == item["final"]:
            timeline[-1]["end"] = item["end"]
        else:
            timeline.append({"start": item["start"], "end": item["end"], "layout": item["final"]})

    duration_min = max(_EPS, (float(clip_end) - float(clip_start)) / 60.0)
    switches = max(0, len(timeline) - 1)

    return {
        "version": CANDIDATES_VERSION,
        "kind": "reframe-candidates",
        "scoreVersion": CANDIDATES_SCORE_VERSION,
        "weights": dict(WEIGHTS),
        "pendingAxes": list(PENDING_AXES),
        "layouts": list(LAYOUT_IDS),
        "source": {
            "start": round(float(clip_start), 3),
            "end": round(float(clip_end), 3),
            "width": int(source_width),
            "height": int(source_height),
        },
        "sampleFps": float(sample_fps),
        "segments": planned,
        "timeline": timeline,
        # 채택 조건(§5) "1분당 평균 전환 6회 이하" 판정 재료 — 소비자가 재계산하지 않게 싣는다.
        "switchesPerMinute": round(switches / duration_min, 2),
    }


def timeline_from_legacy_plan(plan: dict[str, Any]) -> list[dict[str, Any]]:
    """기존 fit/fill 플랜 → 4택 어휘 타임라인 (회귀 대조용 · 계획서 §1 호환)."""
    beats = plan.get("beats")
    if not isinstance(beats, list):
        raise PlanInputError("legacy plan has no beats list")
    timeline: list[dict[str, Any]] = []
    for beat in beats:
        layout = layout_from_legacy(str(beat.get("layout")))
        start = float(beat.get("start"))
        end = float(beat.get("end"))
        if timeline and timeline[-1]["layout"] == layout:
            timeline[-1]["end"] = end
        else:
            timeline.append({"start": start, "end": end, "layout": layout})
    return timeline
