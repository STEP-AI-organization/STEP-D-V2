from dataclasses import asdict, dataclass
from math import ceil
from typing import Any

from app.services.korean_shorts import score_text_for_korean_shorts, unique


SIGNAL_SCORE_THRESHOLD = 32.0
ANCHOR_PRE_ROLL_SECONDS = 1.5


HOOK_TERMS = {
    "shock": [
        "충격",
        "소름",
        "미쳤",
        "대박",
        "실화",
        "레전드",
        "역대급",
        "shocking",
        "crazy",
        "insane",
        "unbelievable",
    ],
    "secret": [
        "비밀",
        "아무도 모르는",
        "처음 공개",
        "공개하는",
        "몰랐",
        "hidden",
        "secret",
        "nobody knows",
    ],
    "warning": [
        "절대",
        "하지 마세요",
        "위험",
        "경고",
        "실수",
        "망했",
        "후회",
        "never",
        "mistake",
        "warning",
        "don't",
    ],
    "turn": [
        "그런데",
        "근데",
        "하지만",
        "반전",
        "갑자기",
        "결국",
        "분위기",
        "however",
        "but then",
        "suddenly",
        "twist",
    ],
    "benefit": [
        "꿀팁",
        "방법",
        "해야 합니다",
        "알아야",
        "인생이 바뀌",
        "tip",
        "how to",
        "you need",
    ],
    "emotion": [
        "웃",
        "울",
        "화나",
        "감동",
        "무서",
        "기쁘",
        "angry",
        "laugh",
        "cry",
        "emotional",
    ],
}


@dataclass
class Candidate:
    id: str
    start: float
    end: float
    anchor_time: float
    transcript: str
    local_score: float
    hook_terms: list[str]
    original_start: float | None = None
    original_end: float | None = None
    boundary_reason: str = ""

    @property
    def duration(self) -> float:
        return self.end - self.start

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["refined_start"] = self.start
        data["refined_end"] = self.end
        data["duration"] = self.duration
        return data


def _segment_text(segment: dict[str, Any]) -> str:
    return str(segment.get("text") or "").strip()


def _item_text(item: dict[str, Any]) -> str:
    return str(item.get("text") or item.get("word") or "").strip()


def _time_item(item: dict[str, Any]) -> dict[str, Any] | None:
    try:
        start = float(item.get("start"))
        end = float(item.get("end"))
    except (TypeError, ValueError):
        return None
    if end < start:
        return None
    normalized = dict(item)
    normalized["start"] = start
    normalized["end"] = end
    return normalized


def _timed_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = [_time_item(item) for item in items]
    return sorted((item for item in normalized if item is not None), key=lambda item: item["start"])


def _overlapping(items: list[dict[str, Any]], start: float, end: float) -> list[dict[str, Any]]:
    return [item for item in items if float(item["end"]) >= start and float(item["start"]) <= end]


def _text_for_window(
    segments: list[dict[str, Any]],
    words: list[dict[str, Any]],
    start: float,
    end: float,
    fallback: str,
) -> str:
    segment_text = " ".join(_segment_text(seg) for seg in _overlapping(segments, start, end) if _segment_text(seg))
    if segment_text:
        return segment_text
    word_text = " ".join(_item_text(word) for word in _overlapping(words, start, end) if _item_text(word))
    return word_text or fallback


def _words_in_range(words: list[dict[str, Any]], start: float, end: float) -> list[dict[str, Any]]:
    return [word for word in words if float(word["end"]) >= start and float(word["start"]) <= end]


def _word_or_segment_start(
    first_segment: dict[str, Any] | None,
    words: list[dict[str, Any]],
    rough_start: float,
    rough_end: float,
    lookback_seconds: float,
) -> tuple[float | None, str]:
    if not first_segment:
        window_start = max(0.0, rough_start - lookback_seconds)
        window_words = _words_in_range(words, window_start, rough_end)
        if window_words:
            return float(window_words[0]["start"]), "word"
        return None, "fallback"

    segment_start = float(first_segment["start"])
    segment_end = float(first_segment["end"])
    floor = max(segment_start, rough_start - lookback_seconds)
    segment_words = _words_in_range(words, floor, segment_end)
    if segment_words:
        return float(segment_words[0]["start"]), "word"
    return max(segment_start, rough_start - lookback_seconds), "segment"


def _word_or_segment_end(
    last_segment: dict[str, Any] | None,
    words: list[dict[str, Any]],
    rough_end: float,
    end_ceiling: float,
) -> tuple[float | None, str]:
    if not last_segment:
        window_words = [word for word in words if float(word["start"]) <= end_ceiling and float(word["end"]) >= rough_end]
        if window_words:
            return float(window_words[-1]["end"]), "word"
        return None, "fallback"

    segment_start = float(last_segment["start"])
    segment_end = min(float(last_segment["end"]), end_ceiling)
    segment_words = _words_in_range(words, segment_start, segment_end)
    if segment_words:
        return min(float(segment_words[-1]["end"]), end_ceiling), "word"
    return segment_end, "segment"


def _expand_to_min_duration(
    start: float,
    end: float,
    segments: list[dict[str, Any]],
    video_duration: float,
    min_seconds: float,
    max_seconds: float,
    post_padding_seconds: float,
) -> tuple[float, float, str | None]:
    if end - start >= min_seconds:
        return start, end, None

    max_end = min(video_duration, start + max_seconds)
    target_end = min(max_end, start + min_seconds)
    next_segments = [seg for seg in segments if float(seg["end"]) >= target_end and float(seg["end"]) <= max_end]
    if next_segments:
        end = min(video_duration, max_end, float(next_segments[0]["end"]) + post_padding_seconds)
    else:
        end = target_end

    if end - start < min_seconds and end >= min_seconds:
        start = max(0.0, end - min_seconds)
    return start, end, "min-duration"


def _trim_to_max_duration(
    start: float,
    end: float,
    segments: list[dict[str, Any]],
    words: list[dict[str, Any]],
    min_seconds: float,
    max_seconds: float,
    post_padding_seconds: float,
) -> tuple[float, float, str | None]:
    if end - start <= max_seconds:
        return start, end, None

    max_end = start + max_seconds
    complete_segments = [
        seg
        for seg in segments
        if float(seg["end"]) + post_padding_seconds <= max_end and float(seg["end"]) - start >= min_seconds
    ]
    if complete_segments:
        segment_end, _ = _word_or_segment_end(complete_segments[-1], words, max_end, max_end)
        if segment_end is not None:
            return start, min(max_end, segment_end + post_padding_seconds), "max-duration-segment"
    return start, max_end, "max-duration-hard"


def _score_text(text: str) -> tuple[float, list[str]]:
    return score_text_for_korean_shorts(text)


def _overlap_ratio(a: Candidate, b: Candidate) -> float:
    left = max(a.start, b.start)
    right = min(a.end, b.end)
    inter = max(0.0, right - left)
    union = max(a.end, b.end) - min(a.start, b.start)
    return inter / union if union else 0.0


def _window_for_anchor(
    segments: list[dict[str, Any]],
    anchor_index: int,
    duration: float,
    min_seconds: int,
    max_seconds: int,
    target_seconds: int,
) -> tuple[float, float, str]:
    anchor = segments[anchor_index]
    anchor_start = float(anchor.get("start") or 0.0)
    anchor_end = float(anchor.get("end") or anchor_start)
    start = max(0.0, anchor_start - ANCHOR_PRE_ROLL_SECONDS)
    end = min(duration, max(anchor_end + 18.0, start + target_seconds))

    while end - start < min_seconds and end < duration:
        end = min(duration, end + 5.0)
    while end - start < min_seconds and start > 0:
        start = max(0.0, start - 5.0)
    if end - start > max_seconds:
        end = start + max_seconds

    text_parts = [
        _segment_text(seg)
        for seg in segments
        if float(seg.get("end") or 0.0) >= start and float(seg.get("start") or 0.0) <= end
    ]
    return start, min(end, duration), " ".join(part for part in text_parts if part)


def detect_candidates(
    transcript: dict[str, Any],
    video_duration: float,
    min_seconds: int,
    max_seconds: int,
    target_seconds: int,
    max_candidates: int,
) -> list[Candidate]:
    segments = [
        seg
        for seg in transcript.get("segments", [])
        if _segment_text(seg) and seg.get("start") is not None and seg.get("end") is not None
    ]
    if not segments and transcript.get("text"):
        segments = [{"start": 0.0, "end": video_duration, "text": transcript["text"]}]

    scored: list[tuple[int, float, list[str]]] = []
    for index, segment in enumerate(segments):
        score, terms = _score_text(_segment_text(segment))
        if score >= SIGNAL_SCORE_THRESHOLD:
            scored.append((index, score, terms))
    scored.sort(key=lambda item: item[1], reverse=True)

    selected: list[Candidate] = []
    for index, score, terms in scored:
        start, end, text = _window_for_anchor(
            segments,
            index,
            video_duration,
            min_seconds=min_seconds,
            max_seconds=max_seconds,
            target_seconds=target_seconds,
        )
        window_score, window_terms = _score_text(text)
        density = min(15.0, len(text.split()) / max(1.0, end - start) * 3)
        candidate = Candidate(
            id=f"cand_{len(selected) + 1:03d}",
            start=start,
            end=end,
            anchor_time=float(segments[index].get("start") or start),
            transcript=text,
            local_score=min(100.0, max(score, window_score) + density),
            hook_terms=unique([*terms, *window_terms], 10),
        )
        if all(_overlap_ratio(candidate, existing) < 0.55 for existing in selected):
            selected.append(candidate)
        if len(selected) >= max_candidates:
            break

    if len(selected) < min(max_candidates, 5):
        step = max(15, target_seconds // 2)
        total_windows = max(1, ceil(max(0.1, video_duration - min_seconds) / step))
        for window_index in range(total_windows):
            start = float(window_index * step)
            if start >= video_duration:
                break
            end = min(video_duration, start + target_seconds)
            if end - start < min_seconds and video_duration >= min_seconds:
                continue
            text_parts = [
                _segment_text(seg)
                for seg in segments
                if float(seg.get("end") or 0.0) >= start and float(seg.get("start") or 0.0) <= end
            ]
            text = " ".join(part for part in text_parts if part)
            if not text:
                continue
            score, terms = _score_text(text)
            candidate = Candidate(
                id=f"cand_{len(selected) + 1:03d}",
                start=start,
                end=end,
                anchor_time=start + (end - start) / 2,
                transcript=text,
                local_score=max(20.0, score * 0.75),
                hook_terms=terms,
            )
            if all(_overlap_ratio(candidate, existing) < 0.55 for existing in selected):
                selected.append(candidate)
            if len(selected) >= max_candidates:
                break

    selected.sort(key=lambda cand: cand.local_score, reverse=True)
    return selected[:max_candidates]


def refine_candidates(
    candidates: list[Candidate],
    transcript: dict[str, Any],
    video_duration: float,
    min_seconds: int,
    max_seconds: float,
    start_lookback_seconds: float,
    end_lookahead_seconds: float,
    pre_padding_seconds: float,
    post_padding_seconds: float,
) -> list[Candidate]:
    segments = _timed_items(
        [
            segment
            for segment in transcript.get("segments", [])
            if _segment_text(segment) and segment.get("start") is not None and segment.get("end") is not None
        ]
    )
    words = _timed_items(
        [
            word
            for word in transcript.get("words", [])
            if _item_text(word) and word.get("start") is not None and word.get("end") is not None
        ]
    )

    refined: list[Candidate] = []
    for candidate in candidates:
        rough_start = max(0.0, float(candidate.start))
        rough_end = min(video_duration, max(rough_start + 0.1, float(candidate.end)))
        reasons: list[str] = []

        first_segment = next(
            (seg for seg in segments if float(seg["end"]) >= rough_start and float(seg["start"]) <= rough_end),
            None,
        )
        end_ceiling = min(video_duration, rough_end + max(0.0, end_lookahead_seconds))
        end_segments = [
            seg
            for seg in segments
            if float(seg["start"]) <= end_ceiling and float(seg["end"]) >= rough_start and float(seg["end"]) <= end_ceiling
        ]
        if not end_segments:
            end_segments = [
                seg
                for seg in segments
                if float(seg["start"]) <= end_ceiling and float(seg["end"]) >= rough_start
            ]
        last_segment = end_segments[-1] if end_segments else None

        start_anchor, start_source = _word_or_segment_start(
            first_segment,
            words,
            rough_start,
            rough_end,
            max(0.0, start_lookback_seconds),
        )
        end_anchor, end_source = _word_or_segment_end(last_segment, words, rough_end, end_ceiling)

        if start_anchor is None:
            new_start = max(0.0, rough_start - max(0.0, pre_padding_seconds))
            reasons.append("fallback-start-padding")
        else:
            new_start = max(0.0, start_anchor - max(0.0, pre_padding_seconds))
            reasons.append(f"{start_source}-start")

        if end_anchor is None:
            new_end = min(video_duration, rough_end + max(0.0, post_padding_seconds))
            reasons.append("fallback-end-padding")
        else:
            new_end = min(video_duration, end_ceiling, end_anchor + max(0.0, post_padding_seconds))
            reasons.append(f"{end_source}-end")

        new_start = min(new_start, max(0.0, video_duration - 0.1))
        new_end = max(new_start + 0.1, min(video_duration, new_end))

        new_start, new_end, min_reason = _expand_to_min_duration(
            new_start,
            new_end,
            segments,
            video_duration,
            float(min_seconds),
            float(max_seconds),
            max(0.0, post_padding_seconds),
        )
        if min_reason:
            reasons.append(min_reason)

        new_start, new_end, max_reason = _trim_to_max_duration(
            new_start,
            new_end,
            segments,
            words,
            float(min_seconds),
            float(max_seconds),
            max(0.0, post_padding_seconds),
        )
        if max_reason:
            reasons.append(max_reason)

        refined_text = _text_for_window(segments, words, new_start, new_end, candidate.transcript)
        refined.append(
            Candidate(
                id=candidate.id,
                start=round(new_start, 3),
                end=round(new_end, 3),
                anchor_time=min(max(candidate.anchor_time, new_start), new_end),
                transcript=refined_text,
                local_score=candidate.local_score,
                hook_terms=candidate.hook_terms,
                original_start=round(rough_start, 3),
                original_end=round(rough_end, 3),
                boundary_reason=", ".join(dict.fromkeys(reasons)),
            )
        )

    return refined
