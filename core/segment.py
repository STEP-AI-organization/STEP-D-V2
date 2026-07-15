"""
STEP D Core — Segment Engine
Converts raw transcription into clip-worthy segments.

Based on VideoLingo's _3_1_split_nlp.py + _3_2_split_meaning.py (Apache 2.0),
repurposed for short-form content detection instead of subtitle translation.
"""
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class ClipCandidate:
    """A candidate segment for short-form content."""
    start: float
    end: float
    duration: float
    text: str
    score: float = 0.0  # 0-100: how "clip-worthy" this segment is
    source: str = "transcript"  # "transcript", "visual", "combined"

    # Metadata
    hook_score: float = 0.0   # Opening hook potential
    climax_score: float = 0.0  # Emotional peak / key moment
    resolution_score: float = 0.0  # Complete mini-story

    words: list[dict] = field(default_factory=list)


def segment_by_silence(
    segments: list[dict],
    max_gap: float = 2.0,
    min_duration: float = 15.0,
    max_duration: float = 90.0,
) -> list[ClipCandidate]:
    """
    Segment transcript into clips based on silence gaps.

    Args:
        segments: WhisperX segments [{start, end, text, words}, ...]
        max_gap: Maximum silence gap (seconds) within a clip
        min_duration: Minimum clip duration (seconds)
        max_duration: Maximum clip duration (seconds)

    Returns:
        List of ClipCandidate objects
    """
    if not segments:
        return []

    candidates = []
    current_words = []
    current_text = []
    clip_start = segments[0]['start']

    for i, seg in enumerate(segments):
        gap = seg['start'] - segments[i - 1]['end'] if i > 0 else 0.0

        # `projected` (includes seg i) decides whether to cut; `clip_duration` is the
        # length of the clip we'd actually emit — which ends at seg i-1. The min-length
        # gate must use clip_duration, else a large gap inflates projected past the
        # threshold and lets a sub-min clip through (this was emitting 0.7s/4s clips).
        projected = seg['end'] - clip_start
        if i > 0 and (gap > max_gap or projected > max_duration):
            clip_end = segments[i - 1]['end']
            clip_duration = clip_end - clip_start
            if current_text and clip_duration >= min_duration:
                candidates.append(ClipCandidate(
                    start=clip_start,
                    end=clip_end,
                    duration=clip_duration,
                    text=' '.join(current_text),
                    words=current_words,
                ))
            clip_start = seg['start']
            current_text = []
            current_words = []

        current_text.append(seg['text'])
        current_words.extend(seg.get('words', []))

    # Last segment
    duration = segments[-1]['end'] - clip_start
    if len(current_text) > 0 and duration >= min_duration:
        candidates.append(ClipCandidate(
            start=clip_start,
            end=segments[-1]['end'],
            duration=duration,
            text=' '.join(current_text),
            words=current_words,
        ))

    return candidates


def score_candidates(
    candidates: list[ClipCandidate],
    total_duration: float,
) -> list[ClipCandidate]:
    """
    Score clip candidates based on heuristics:
    - Duration fitness (ideal: 30-60s for shorts/reels)
    - Position (beginning = hook, end = resolution)
    - Text density (too sparse or too dense = worse)
    """
    ideal_min, ideal_max = 30, 60

    for c in candidates:
        # Duration score (0-40)
        if ideal_min <= c.duration <= ideal_max:
            c.score += 40
        elif c.duration < ideal_min:
            c.score += 40 * (c.duration / ideal_min)
        else:
            c.score += 40 * (ideal_max / c.duration)

        # Position score (0-30)
        pos_ratio = c.start / total_duration if total_duration > 0 else 0
        if pos_ratio < 0.15:
            c.hook_score = 25  # Opening hook
        elif pos_ratio > 0.8:
            c.resolution_score = 20  # Ending resolution
        c.score += c.hook_score + c.resolution_score

        # Text density score (0-30)
        text_len = len(c.text)
        if text_len > 0 and c.duration > 0:
            density = text_len / c.duration  # chars per second
            if 8 <= density <= 20:
                c.score += 30
            elif density < 8:
                c.score += 30 * (density / 8)
            else:
                c.score += 30 * (20 / density)

    # Sort by score descending
    candidates.sort(key=lambda c: c.score, reverse=True)
    return candidates


def get_top_candidates(
    candidates: list[ClipCandidate],
    top_n: int = 5,
    min_score: float = 40,
) -> list[ClipCandidate]:
    """Return top N candidates above minimum score threshold."""
    return [c for c in candidates if c.score >= min_score][:top_n]