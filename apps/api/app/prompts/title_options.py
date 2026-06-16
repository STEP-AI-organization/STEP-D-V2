"""Prompt + response schema for generating Korean Shorts title options."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from app.models import Clip


TITLE_OPTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "options": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "overlay_text": {"type": "string"},
                    "style": {"type": "string"},
                    "reason": {"type": "string"},
                },
                "required": ["title", "overlay_text", "style", "reason"],
            },
        }
    },
    "required": ["options"],
}


def build_title_options_prompt(clip: "Clip") -> str:
    return f"""
Return JSON only. Generate exactly 5 Korean YouTube Shorts title options for this clip.
Each option needs: title, overlay_text, style, reason.
title must be under 70 chars.
overlay_text must be under 24 chars and suitable for a bold Korean thumbnail caption.

Prioritize Korean Shorts patterns:
- reaction hook: "이 장면 진짜 뭐죠?"
- reversal hook: "끝까지 보면 반전 있습니다"
- quote hook: use the strongest spoken line directly
- comment hook: viewers will argue, agree, or tag someone
- no stiff translated English

Current title: {clip.title}
Reason: {clip.reason}
Transcript:
{clip.transcript[:3000]}
"""
