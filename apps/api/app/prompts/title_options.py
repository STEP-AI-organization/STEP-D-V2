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
- Make the titles viral, sharp, and curiosity-driven. They should feel like a Korean Shorts creator wrote them, not a neutral summary.
- Prefer tension words when supported by the transcript: 소름, 반전, 난리, 정색, 멈칫, 뒤집힘, 댓글 갈림, 끝남, 못 넘김.
- Every option must create an open loop: viewers should want to know "왜?", "뭐라고 했길래?", or "그래서 어떻게 됐는데?"

Generate these 5 distinct styles:
1. shock/reaction: the most scroll-stopping version.
2. reversal/payoff: tease the turn without spoiling the ending.
3. quote-trigger: use the strongest spoken line or paraphrase it as a hook.
4. comment-bait: invite disagreement, agreement, or tagging someone.
5. curiosity-gap: make the viewer feel they missed something important.

Rules:
- Be provocative, but do not invent facts that are not clearly implied by the transcript.
- Avoid bland summaries like "대화 흐름이 바뀌는 순간" or "반전 있는 장면".
- Avoid generic titles like "이 장면 진짜 뭐죠?" unless a concrete detail is attached.
- No hashtags, no episode numbers, no stiff translated English.
- Do not use defamatory, sexual, or harmful claims. Do not claim "충격", "레전드", or "논란" unless the transcript supports that intensity.

Current title: {clip.title}
Reason: {clip.reason}
Transcript:
{clip.transcript[:3000]}
"""
