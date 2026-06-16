"""Prompt + response schema for detecting burned-in captions in source frames."""

from __future__ import annotations

from typing import Any


CAPTION_DETECTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "has_burned_in_captions": {"type": "boolean"},
        "confidence": {"type": "number"},
        "reason": {"type": "string"},
    },
    "required": ["has_burned_in_captions", "confidence", "reason"],
}


def build_caption_detection_prompt() -> str:
    return """
You are checking source-video frames before an automated Shorts editor adds new captions.
Return JSON only.

Decide whether the original source video already contains burned-in dialogue captions/subtitles
that are part of the video image. Mark true only when the frames show repeated on-screen text
intended to transcribe spoken dialogue or narration, usually near the lower third/center and
large enough for viewers to read.

Do NOT mark true for:
- channel logos, watermarks, UI chrome, lower-third name labels, dates, scores, or product labels
- a single title card or decorative headline
- text added by this app after rendering; these frames are source-frame samples

Return:
- has_burned_in_captions: boolean
- confidence: 0.0 to 1.0
- reason: short explanation
"""
