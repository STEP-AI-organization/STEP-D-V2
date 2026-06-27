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
title must be under 70 chars, ideally 16-42 Korean characters.
overlay_text must be 5-14 Korean characters when possible, under 24 chars, and suitable for a bold Korean thumbnail caption.

Tone:
- Write titles the way a popular Korean Shorts creator would — casual, natural, and rooted in what actually happened in the clip.
- Hook the viewer by surfacing the most surprising, funny, or emotionally resonant moment — but in your own words, not a template.
- Every title should make someone stop scrolling because they want to know what happened next, who said it, or what the reaction was.

What to avoid:
- Formulaic filler phrases like "그냥은 못 넘깁니다", "실화냐", "이거 실화임?", "레전드", "충격", "소름" — unless the transcript genuinely supports that level.
- Bland summaries ("대화 흐름이 바뀌는 순간", "반전 있는 장면") with no concrete detail.
- Generic hooks ("이 장면 진짜 뭐죠?") not anchored to something specific from the transcript.
- Hashtags, episode numbers, or stiff phrasing.
- Defamatory, sexual, or harmful claims.

Generate these 5 distinct styles:
1. shock/reaction: the most scroll-stopping version — what's the single most jaw-dropping moment?
2. reversal/payoff: tease the unexpected turn without spoiling the ending.
3. quote-trigger: pull the strongest actual line from the transcript and let it do the work.
4. comment-bait: word it so viewers want to respond, agree, or tag someone they know.
5. curiosity-gap: make the viewer feel like they missed something important and need to watch.

Current title: {clip.title}
Reason: {clip.reason}
Transcript:
{clip.transcript[:3000]}
"""
