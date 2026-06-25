"""Prompt + response schema for vision-based clip candidate evaluation."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from app.services.timecode import format_time

if TYPE_CHECKING:
    from app.services.candidates import Candidate


EVALUATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "score": {"type": "integer", "minimum": 0, "maximum": 100},
        "hook_score": {"type": "integer", "minimum": 0, "maximum": 100},
        "emotion_score": {"type": "integer", "minimum": 0, "maximum": 100},
        "retention_score": {"type": "integer", "minimum": 0, "maximum": 100},
        "shareability_score": {"type": "integer", "minimum": 0, "maximum": 100},
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
- All score fields must be integers from 0 to 100. Do not use a 1-10 scale.
- best_frame_time must be an absolute timestamp within the candidate range.
- Titles and thumbnail text should be Korean if the transcript is Korean.
- Prefer Korean Shorts patterns: fast first-line hook, clear emotional reaction,
  curiosity gap, reversal/payoff, comment-worthy tension, and natural Korean
  spoken phrasing. Avoid stiff translated English.
- The returned title must be viral and provocative, not a neutral summary.
  Prefer titles that make viewers ask "what happened?", "why did they react?",
  or "what was the final line?" while staying truthful to the transcript.
- Avoid bland titles like "반전 있는 장면", "대화가 바뀌는 순간", or
  "하이라이트 장면". Use concrete tension words only when supported:
  소름, 반전, 난리, 정색, 멈칫, 댓글 갈림, 분위기 뒤집힘.
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
