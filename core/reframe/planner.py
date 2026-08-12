"""Deterministic ``vision-safety-v1`` Beat reframe policy.

The detector adapter lives in :mod:`core.reframe.video`.  Everything in this
module is pure Python so the product policy can be tested without MediaPipe or
a model weight.  Times in public results are master-media absolute seconds;
face boxes and tracking centers are normalized to ``0..1``.
"""
from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass
from math import exp, hypot, log
from statistics import median
from typing import Any, Iterable, Sequence

PLAN_VERSION = 1
SCORE_VERSION = "vision-safety-v1"
SCORE_THRESHOLD = 70
TARGET_ASPECT = 9.0 / 16.0
SAMPLE_FPS = 5.0

MIN_DETECTION_COVERAGE = 0.75
MIN_DOMINANT_FRAME_RATE = 0.60
MIN_CROP_SAFETY_RATE = 0.80
MAX_UNSAFE_RUN_SEC = 0.50

_EPS = 1e-6


class PlanInputError(ValueError):
    """The planner cannot produce a safe plan from the supplied inputs."""


@dataclass(frozen=True)
class FaceBox:
    """One normalized face detection."""

    x: float
    y: float
    width: float
    height: float
    confidence: float

    @property
    def cx(self) -> float:
        return self.x + self.width / 2.0

    @property
    def cy(self) -> float:
        return self.y + self.height / 2.0

    @property
    def area(self) -> float:
        return max(0.0, self.width) * max(0.0, self.height)


@dataclass(frozen=True)
class FrameObservation:
    """Detections for one sampled video frame."""

    t: float
    faces: tuple[FaceBox, ...]


@dataclass(frozen=True)
class ScoreMetrics:
    detection_coverage: float
    single_subject_dominance: float
    dominant_frame_rate: float
    crop_safety_rate: float
    tracking_stability: float
    mean_confidence: float
    max_missing_run_sec: float
    max_ambiguous_run_sec: float


@dataclass(frozen=True)
class _SelectedFrame:
    observation: FrameObservation
    primary: FaceBox | None
    dominance: float
    dominant: bool
    crop_safe: bool
    shot_index: int


def _clamp(value: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, value))


def _round_score(value: float) -> int:
    # Python's round() is bankers rounding. Product thresholds need ordinary
    # half-up behavior so the same fixture cannot flip between runtimes.
    return int(_clamp(value, 0.0, 100.0) + 0.5)


def calculate_score(metrics: ScoreMetrics) -> int:
    """Return the fixed, versioned 0..100 vision safety score."""

    detection = min(_clamp(metrics.detection_coverage) / 0.90, 1.0)
    raw = (
        30.0 * detection
        + 25.0 * _clamp(metrics.single_subject_dominance)
        + 20.0 * _clamp(metrics.crop_safety_rate)
        + 15.0 * _clamp(metrics.tracking_stability)
        + 10.0 * _clamp(metrics.mean_confidence)
    )
    return _round_score(raw)


def decide_layout(metrics: ScoreMetrics) -> tuple[int, str, list[str]]:
    """Apply safety gates first, then the fixed 70-point Fill threshold."""

    score = calculate_score(metrics)
    reasons: list[str] = []
    if metrics.detection_coverage + _EPS < MIN_DETECTION_COVERAGE:
        reasons.append("LOW_DETECTION_COVERAGE")
    if metrics.dominant_frame_rate + _EPS < MIN_DOMINANT_FRAME_RATE:
        reasons.append("MULTI_PERSON_DOMINANCE")
    if metrics.crop_safety_rate + _EPS < MIN_CROP_SAFETY_RATE:
        reasons.append("UNSAFE_VERTICAL_CROP")
    if metrics.max_missing_run_sec > MAX_UNSAFE_RUN_SEC + _EPS:
        reasons.append("LONG_DETECTION_GAP")
    if metrics.max_ambiguous_run_sec > MAX_UNSAFE_RUN_SEC + _EPS:
        reasons.append("MULTI_PERSON_AMBIGUOUS")
    if score < SCORE_THRESHOLD:
        reasons.append("SCORE_BELOW_THRESHOLD")

    if reasons:
        return score, "fit", reasons
    return score, "fill", ["SCORE_THRESHOLD_MET", "SINGLE_SUBJECT_SAFE"]


def _coerce_time(value: Any, field: str) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise PlanInputError(f"invalid {field}: {value!r}") from exc
    if result != result:  # NaN
        raise PlanInputError(f"invalid {field}: NaN")
    return result


def _beat_id(value: Any, fallback: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def build_beat_segments(
    beats_payload: dict[str, Any] | list[dict[str, Any]],
    clip_start: float,
    clip_end: float,
) -> list[dict[str, Any]]:
    """Intersect Beats with the clip and explicitly cover every gap with Fit.

    Synthetic gap records use negative IDs and are never eligible for Fill.
    Completely missing legacy Beat data is an error instead of silently
    pretending that the whole clip is one Beat.
    """

    clip_start = _coerce_time(clip_start, "clip_start")
    clip_end = _coerce_time(clip_end, "clip_end")
    if clip_end <= clip_start:
        raise PlanInputError("clip_end must be greater than clip_start")

    raw = beats_payload.get("beats") if isinstance(beats_payload, dict) else beats_payload
    if not isinstance(raw, list):
        raise PlanInputError("beats JSON must be a list or an object with a beats list")

    candidates: list[tuple[float, float, int]] = []
    for index, beat in enumerate(raw):
        if not isinstance(beat, dict):
            continue
        try:
            start = float(beat.get("start"))
            end = float(beat.get("end"))
        except (TypeError, ValueError):
            continue
        if start != start or end != end or end <= start:
            continue
        start = max(clip_start, start)
        end = min(clip_end, end)
        if end > start + _EPS:
            candidates.append((start, end, _beat_id(beat.get("id"), index)))

    if not candidates:
        raise PlanInputError("no beats overlap the clip range")

    candidates.sort(key=lambda item: (item[0], item[1], item[2]))
    result: list[dict[str, Any]] = []
    cursor = clip_start
    synthetic_id = -1
    for start, end, beat_id in candidates:
        if end <= cursor + _EPS:
            continue
        if start > cursor + _EPS:
            result.append({
                "beatId": synthetic_id,
                "start": cursor,
                "end": start,
                "synthetic": True,
            })
            synthetic_id -= 1
        segment_start = max(cursor, start)
        result.append({
            "beatId": beat_id,
            "start": segment_start,
            "end": end,
            "synthetic": False,
        })
        cursor = end
        if cursor >= clip_end - _EPS:
            break
    if cursor < clip_end - _EPS:
        result.append({
            "beatId": synthetic_id,
            "start": cursor,
            "end": clip_end,
            "synthetic": True,
        })

    # Stable millisecond precision keeps Node render hashes deterministic. A
    # sub-millisecond source gap can otherwise round into a zero-length segment,
    # so rebuild the already-contiguous result on one shared rounded cursor.
    rounded_result: list[dict[str, Any]] = []
    rounded_cursor = round(clip_start, 3)
    rounded_clip_end = round(clip_end, 3)
    for index, segment in enumerate(result):
        rounded_end = (
            rounded_clip_end
            if index == len(result) - 1
            else round(float(segment["end"]), 3)
        )
        if rounded_end <= rounded_cursor:
            continue
        rounded_result.append({
            **segment,
            "start": rounded_cursor,
            "end": rounded_end,
        })
        rounded_cursor = rounded_end
    if not rounded_result:
        raise PlanInputError("clip range is shorter than output time precision")
    rounded_result[-1]["end"] = rounded_clip_end
    return rounded_result


def _iou(a: FaceBox, b: FaceBox) -> float:
    left = max(a.x, b.x)
    top = max(a.y, b.y)
    right = min(a.x + a.width, b.x + b.width)
    bottom = min(a.y + a.height, b.y + b.height)
    intersection = max(0.0, right - left) * max(0.0, bottom - top)
    union = a.area + b.area - intersection
    return intersection / union if union > _EPS else 0.0


def _association_score(previous: FaceBox, current: FaceBox) -> float:
    distance = hypot(previous.cx - current.cx, previous.cy - current.cy)
    distance_score = max(0.0, 1.0 - distance / 0.45)
    if previous.area > _EPS and current.area > _EPS:
        size_score = exp(-abs(log(current.area / previous.area)))
    else:
        size_score = 0.0
    return 0.55 * _iou(previous, current) + 0.30 * distance_score + 0.15 * size_score


def _crop_width(source_width: int, source_height: int) -> float:
    if source_width <= 0 or source_height <= 0:
        raise PlanInputError("source width and height must be positive")
    source_aspect = source_width / source_height
    return min(1.0, TARGET_ASPECT / source_aspect)


def _is_crop_safe(face: FaceBox, crop_width: float) -> bool:
    # Center the 9:16 window on the face, then clamp it to the source edges.
    half = crop_width / 2.0
    center = _clamp(face.cx, half, 1.0 - half) if crop_width < 1.0 else 0.5
    left = center - half
    right = center + half
    margin = max(0.008, face.width * 0.15)
    relative_face_width = face.width / max(crop_width, _EPS)
    return (
        face.x - margin >= left - _EPS
        and face.x + face.width + margin <= right + _EPS
        and 0.16 <= relative_face_width <= 0.85
        and face.y >= 0.01
        and face.y + face.height <= 0.80
    )


def _shot_index(t: float, boundaries: Sequence[float]) -> int:
    return bisect_right(boundaries, t + _EPS)


def _select_frames(
    observations: Sequence[FrameObservation],
    shot_boundaries: Sequence[float],
    crop_width: float,
) -> list[_SelectedFrame]:
    selected: list[_SelectedFrame] = []
    previous: FaceBox | None = None
    previous_shot = -1
    for observation in sorted(observations, key=lambda item: item.t):
        shot = _shot_index(observation.t, shot_boundaries)
        if shot != previous_shot:
            previous = None
            previous_shot = shot
        faces = sorted(
            (face for face in observation.faces if face.area > _EPS),
            key=lambda face: face.area,
            reverse=True,
        )
        primary: FaceBox | None = None
        if faces:
            largest = faces[0]
            if previous is None:
                primary = largest
            else:
                candidate = max(faces, key=lambda face: _association_score(previous, face))
                # Do not let a tiny background face retain the track when the
                # former subject has disappeared.
                primary = candidate if candidate.area >= largest.area * 0.25 else largest
            previous = primary

        if not faces or primary is None:
            dominance = 0.0
            dominant = False
            crop_safe = False
        else:
            other_areas = [face.area for face in faces if face is not primary]
            second_area = max(other_areas, default=0.0)
            ratio = min(1.0, second_area / max(primary.area, _EPS))
            dominance = _clamp((1.0 - ratio) / 0.60)
            dominant = ratio <= 0.40 + _EPS
            crop_safe = _is_crop_safe(primary, crop_width)
        selected.append(_SelectedFrame(
            observation=observation,
            primary=primary,
            dominance=dominance,
            dominant=dominant,
            crop_safe=crop_safe,
            shot_index=shot,
        ))
    return selected


def _longest_run(
    frames: Sequence[_SelectedFrame],
    predicate,
    sample_fps: float,
) -> float:
    interval = 1.0 / max(sample_fps, _EPS)
    longest = 0.0
    start: float | None = None
    last = 0.0
    for frame in frames:
        if predicate(frame):
            if start is None or frame.observation.t - last > interval * 1.6:
                start = frame.observation.t
            last = frame.observation.t
            longest = max(longest, last - start + interval)
        else:
            start = None
    return longest


def _tracking_stability(frames: Sequence[_SelectedFrame]) -> float:
    stable = 0
    total = 0
    previous: _SelectedFrame | None = None
    for frame in frames:
        if frame.primary is None:
            continue
        if previous is not None and previous.primary is not None and previous.shot_index == frame.shot_index:
            dt = frame.observation.t - previous.observation.t
            if dt > _EPS:
                velocity = hypot(
                    frame.primary.cx - previous.primary.cx,
                    frame.primary.cy - previous.primary.cy,
                ) / dt
                size_ratio = max(
                    frame.primary.area / max(previous.primary.area, _EPS),
                    previous.primary.area / max(frame.primary.area, _EPS),
                )
                stable += int(velocity <= 0.80 and size_ratio <= 2.0)
                total += 1
        previous = frame
    return stable / total if total else 0.0


def measure_metrics(
    frames: Sequence[_SelectedFrame],
    segment_start: float,
    segment_end: float,
    sample_fps: float,
) -> ScoreMetrics:
    duration = max(0.0, segment_end - segment_start)
    expected = max(1, int(duration * sample_fps + 0.5))
    detected = [frame for frame in frames if frame.primary is not None]
    denominator = max(expected, len(frames))
    coverage = len(detected) / denominator
    dominance = sum(frame.dominance for frame in detected) / len(detected) if detected else 0.0
    dominant_rate = sum(frame.dominant for frame in detected) / len(detected) if detected else 0.0
    crop_rate = sum(frame.crop_safe for frame in detected) / len(detected) if detected else 0.0
    confidence = (
        sum(frame.primary.confidence for frame in detected if frame.primary is not None) / len(detected)
        if detected else 0.0
    )

    missing_run = _longest_run(frames, lambda frame: frame.primary is None, sample_fps)
    # Include missing coverage at segment edges even when no sampled frame lies
    # exactly on the boundary.
    if detected:
        missing_run = max(
            missing_run,
            max(0.0, detected[0].observation.t - segment_start),
            max(0.0, segment_end - detected[-1].observation.t - 1.0 / sample_fps),
        )
    else:
        missing_run = duration
    ambiguous_run = _longest_run(
        frames,
        lambda frame: frame.primary is not None and not frame.dominant,
        sample_fps,
    )

    return ScoreMetrics(
        detection_coverage=_clamp(coverage),
        single_subject_dominance=_clamp(dominance),
        dominant_frame_rate=_clamp(dominant_rate),
        crop_safety_rate=_clamp(crop_rate),
        tracking_stability=_clamp(_tracking_stability(frames)),
        mean_confidence=_clamp(confidence),
        max_missing_run_sec=max(0.0, missing_run),
        max_ambiguous_run_sec=max(0.0, ambiguous_run),
    )


def _median_smooth(values: Sequence[float]) -> list[float]:
    if not values:
        return []
    result: list[float] = []
    for index in range(len(values)):
        lo = max(0, index - 1)
        hi = min(len(values), index + 2)
        result.append(float(median(values[lo:hi])))
    return result


def _smooth_group(
    frames: Sequence[_SelectedFrame],
    crop_width: float,
    tau_sec: float = 0.25,
) -> list[dict[str, float]]:
    detected = [frame for frame in frames if frame.primary is not None]
    if not detected:
        return []
    raw_x = [frame.primary.cx for frame in detected if frame.primary is not None]
    raw_y = [frame.primary.cy for frame in detected if frame.primary is not None]
    med_x = _median_smooth(raw_x)
    med_y = _median_smooth(raw_y)
    smoothed: list[dict[str, float]] = []
    last_x = med_x[0]
    last_y = med_y[0]
    last_t = detected[0].observation.t
    half = crop_width / 2.0
    for index, frame in enumerate(detected):
        t = frame.observation.t
        if index:
            alpha = 1.0 - exp(-max(0.0, t - last_t) / max(tau_sec, _EPS))
            last_x += alpha * (med_x[index] - last_x)
            last_y += alpha * (med_y[index] - last_y)
        else:
            last_x = med_x[index]
            last_y = med_y[index]
        if crop_width < 1.0:
            last_x = _clamp(last_x, half, 1.0 - half)
        else:
            last_x = _clamp(last_x)
        last_y = _clamp(last_y)
        smoothed.append({
            "t": t,
            "cx": last_x,
            "cy": last_y,
            "confidence": frame.primary.confidence if frame.primary is not None else 0.0,
        })
        last_t = t
    return smoothed


def smooth_tracking(
    frames: Sequence[_SelectedFrame],
    segment_start: float,
    segment_end: float,
    shot_boundaries: Sequence[float],
    crop_width: float,
) -> list[dict[str, float]]:
    """Median + 250 ms smoothing, reset at every shot boundary."""

    boundaries = [b for b in sorted(set(shot_boundaries)) if segment_start < b < segment_end]
    groups: dict[int, list[_SelectedFrame]] = {}
    for frame in frames:
        if frame.primary is not None:
            groups.setdefault(_shot_index(frame.observation.t, boundaries), []).append(frame)

    keys: list[dict[str, float]] = []
    ranges = [segment_start, *boundaries, segment_end]
    for group_index in range(len(ranges) - 1):
        smoothed = _smooth_group(groups.get(group_index, []), crop_width)
        if not smoothed:
            continue
        group_start = ranges[group_index]
        group_end = ranges[group_index + 1]
        first = dict(smoothed[0])
        first["t"] = group_start
        if keys and abs(first["t"] - keys[-1]["t"]) < 0.002:
            # Two keyframes 1 ms apart encode a hard focus reset rather than a
            # glide across the visual cut.
            keys[-1]["t"] = max(segment_start, first["t"] - 0.001)
        keys.append(first)
        keys.extend(smoothed)
        last = dict(smoothed[-1])
        last["t"] = max(group_start, group_end - (0.001 if group_end < segment_end else 0.0))
        keys.append(last)

    compact: list[dict[str, float]] = []
    for key in sorted(keys, key=lambda item: item["t"]):
        rounded = {
            "t": round(_clamp(key["t"], segment_start, segment_end), 3),
            "cx": round(_clamp(key["cx"]), 4),
            "cy": round(_clamp(key["cy"]), 4),
            "confidence": round(_clamp(key["confidence"]), 4),
        }
        if compact and rounded == compact[-1]:
            continue
        compact.append(rounded)
    return compact


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


def build_reframe_plan(
    *,
    beats_payload: dict[str, Any] | list[dict[str, Any]],
    observations: Sequence[FrameObservation],
    clip_start: float,
    clip_end: float,
    source_width: int,
    source_height: int,
    proxy_width: int | None = None,
    proxy_height: int | None = None,
    shot_boundaries: Iterable[float] = (),
    sample_fps: float = SAMPLE_FPS,
) -> dict[str, Any]:
    """Build a complete, non-overlapping Fit/Fill plan for one clip."""

    if sample_fps <= 0:
        raise PlanInputError("sample_fps must be positive")
    segments = build_beat_segments(beats_payload, clip_start, clip_end)
    shots = sorted(
        float(value) for value in shot_boundaries
        if clip_start < float(value) < clip_end
    )
    crop_width = _crop_width(source_width, source_height)
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
                "score": 0,
                "layout": "fit",
                "reasonCodes": ["BEAT_GAP_FALLBACK"],
                "metrics": None,
            })
            continue

        frames = [
            item for item in sorted_observations
            if start - _EPS <= item.t < end - _EPS
        ]
        selected = _select_frames(frames, shots, crop_width)
        metrics = measure_metrics(selected, start, end, sample_fps)
        score, layout, reasons = decide_layout(metrics)
        item: dict[str, Any] = {
            "beatId": segment["beatId"],
            "start": start,
            "end": end,
            "score": score,
            "layout": layout,
            "reasonCodes": reasons,
            "metrics": _metrics_json(metrics),
        }
        if layout == "fill":
            item["tracking"] = smooth_tracking(selected, start, end, shots, crop_width)
            if not item["tracking"]:
                # Defensive invariant: a Fill result without a focus path can
                # never be rendered safely.
                item["layout"] = "fit"
                item["reasonCodes"] = ["EMPTY_TRACKING_PATH"]
        planned.append(item)

    return {
        "version": PLAN_VERSION,
        "mode": "ai_multi",
        "scoreVersion": SCORE_VERSION,
        "threshold": SCORE_THRESHOLD,
        "source": {
            "start": round(float(clip_start), 3),
            "end": round(float(clip_end), 3),
            "width": int(source_width),
            "height": int(source_height),
        },
        "proxy": {
            "width": int(proxy_width if proxy_width is not None else source_width),
            "height": int(proxy_height if proxy_height is not None else source_height),
        },
        "sampleFps": float(sample_fps),
        "beats": planned,
    }
