"""Prompt + response schema for vision-based clip candidate evaluation."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from app.services.timecode import format_time

if TYPE_CHECKING:
    from app.services.candidates import Candidate


EVALUATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "score": {"type": "integer"},
        "hook_score": {"type": "integer"},
        "emotion_score": {"type": "integer"},
        "retention_score": {"type": "integer"},
        "shareability_score": {"type": "integer"},
        "reason": {"type": "string"},
        "title": {"type": "string"},
        "thumbnail_text": {"type": "string"},
        "thumbnail_description": {"type": "string"},
        "best_frame_time": {"type": "string"},
    },
    "required": [
        "score",
        "hook_score",
        "emotion_score",
        "retention_score",
        "shareability_score",
        "reason",
        "title",
        "thumbnail_text",
        "thumbnail_description",
        "best_frame_time",
    ],
}


def build_evaluation_prompt(candidate: "Candidate") -> str:
    return f"""
You are evaluating a short-form clip candidate. Return JSON only.

Important constraints:
- The full video is not provided. You only receive representative frames and transcript.
- Score the standalone viral potential for TikTok/Reels/YouTube Shorts.
- best_frame_time must be an absolute timestamp within the candidate range.
- Titles and thumbnail text should be Korean if the transcript is Korean.
- Prefer Korean Shorts patterns: fast first-line hook, clear emotional reaction,
  curiosity gap, reversal/payoff, comment-worthy tension, and natural Korean
  spoken phrasing. Avoid stiff translated English.
- Penalize clips that require too much missing context from the full episode.

Candidate:
- start_time: {format_time(candidate.start)} ({candidate.start:.2f}s)
- end_time: {format_time(candidate.end)} ({candidate.end:.2f}s)
- local_hook_terms: {", ".join(candidate.hook_terms) or "none"}

Transcript:
{candidate.transcript[:4500]}

Evaluate with these criteria:
1. Hook Strength: will the first 1-3 seconds stop Korean Shorts viewers?
2. Curiosity Gap: does the viewer need to know what happens next?
3. Reversal/Payoff: is there a turn, reveal, punchline, or conclusion?
4. Emotional Impact: shock, laughter, anger, empathy, awkwardness, or warmth.
5. Comment Potential: would viewers argue, agree, quote, or tag someone?
6. Story Completeness: can this stand alone without the full source video?
7. Visual Interest: faces, reactions, readable action, and thumbnail clarity.
8. Caption Fit: can a short Korean overlay carry the hook?
9. Information Density: no slow setup or filler.
10. Retention Potential through the final second.
"""
