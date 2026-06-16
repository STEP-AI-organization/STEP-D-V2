import json
from typing import TYPE_CHECKING, Any

from app.prompts import TITLE_OPTION_SCHEMA, build_title_options_prompt
from app.services.korean_shorts import build_title_options as build_korean_title_options

if TYPE_CHECKING:
    from app.core.config import Settings
    from app.models import Clip


def _clean(text: object, max_length: int | None = None) -> str:
    value = " ".join(str(text or "").split())
    if max_length and len(value) > max_length:
        return value[: max_length - 3].rstrip() + "..."
    return value


def _fallback_options(clip: "Clip") -> list[dict[str, str]]:
    return build_korean_title_options(
        title=clip.title,
        transcript=clip.transcript,
        thumbnail_text=clip.thumbnail_text,
        hook_terms=(clip.evaluation_json or {}).get("hook_terms", []),
    )


def _parse_options(payload: dict[str, Any]) -> list[dict[str, str]]:
    options = payload.get("options") if isinstance(payload, dict) else None
    if not isinstance(options, list):
        return []

    parsed: list[dict[str, str]] = []
    for item in options:
        if not isinstance(item, dict):
            continue
        title = _clean(item.get("title"), 70)
        if not title:
            continue
        parsed.append(
            {
                "id": f"opt_{len(parsed) + 1}",
                "title": title,
                "overlay_text": _clean(item.get("overlay_text"), 24) or title[:18],
                "style": _clean(item.get("style"), 20) or "ai",
                "reason": _clean(item.get("reason"), 160) or "AI generated title option.",
            }
        )
        if len(parsed) >= 5:
            break
    return parsed


def _extract_text(payload: dict[str, Any]) -> str:
    candidates = payload.get("candidates") or []
    parts = candidates[0].get("content", {}).get("parts", []) if candidates else []
    return "".join(part.get("text", "") for part in parts if isinstance(part, dict)).strip()


def _clean_json(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`").removeprefix("json").strip()
    return json.loads(cleaned)


def _gemini_title_options(clip: "Clip", settings: "Settings") -> list[dict[str, str]]:
    if not settings.gemini_api_key:
        return []
    try:
        import httpx
    except ModuleNotFoundError:
        return []

    prompt = build_title_options_prompt(clip)
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.45,
            "responseMimeType": "application/json",
            "responseSchema": TITLE_OPTION_SCHEMA,
        },
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{settings.gemini_model}:generateContent"
    headers = {"Content-Type": "application/json", "x-goog-api-key": settings.gemini_api_key}
    try:
        with httpx.Client(timeout=settings.gemini_timeout_seconds) as client:
            response = client.post(url, headers=headers, json=body)
        if response.status_code >= 400:
            return []
        return _parse_options(_clean_json(_extract_text(response.json())))
    except Exception:
        return []


def generate_title_options(clip: "Clip", settings: "Settings") -> list[dict[str, str]]:
    options = _gemini_title_options(clip, settings)
    if len(options) >= 5:
        return options[:5]

    fallback = _fallback_options(clip)
    seen = {option["title"].lower() for option in options}
    for option in fallback:
        if option["title"].lower() in seen:
            continue
        option = dict(option)
        option["id"] = f"opt_{len(options) + 1}"
        options.append(option)
        if len(options) >= 5:
            break
    return options[:5]


# --- Thumbnail text (on-screen caption) options -----------------------------

THUMBNAIL_TEXT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "options": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "style": {"type": "string"},
                    "reason": {"type": "string"},
                },
                "required": ["text", "style", "reason"],
            },
        }
    },
    "required": ["options"],
}


def _thumbnail_text_prompt(clip: "Clip") -> str:
    return f"""
Return JSON only. Generate exactly 5 Korean YouTube Shorts THUMBNAIL TEXT options.
Each is a very short on-screen caption: 4-16 Korean characters, punchy, high-contrast, scroll-stopping.
Each option needs: text, style, reason. text must be under 16 chars, no surrounding quotes, no English.
Use Korean Shorts hooks: shock, reversal, curiosity, strong quote.
Current title: {clip.title}
Existing thumbnail text: {clip.thumbnail_text or ''}
Transcript:
{clip.transcript[:2000]}
"""


def _parse_thumbnail_options(payload: dict[str, Any]) -> list[dict[str, str]]:
    options = payload.get("options") if isinstance(payload, dict) else None
    if not isinstance(options, list):
        return []
    parsed: list[dict[str, str]] = []
    for item in options:
        if not isinstance(item, dict):
            continue
        text = _clean(item.get("text"), 16)
        if not text:
            continue
        parsed.append(
            {
                "id": f"thumb_{len(parsed) + 1}",
                "text": text,
                "style": _clean(item.get("style"), 20) or "hook",
                "reason": _clean(item.get("reason"), 120) or "AI thumbnail caption.",
            }
        )
        if len(parsed) >= 5:
            break
    return parsed


def _gemini_thumbnail_text_options(clip: "Clip", settings: "Settings") -> list[dict[str, str]]:
    if not settings.gemini_api_key:
        return []
    try:
        import httpx
    except ModuleNotFoundError:
        return []

    body = {
        "contents": [{"role": "user", "parts": [{"text": _thumbnail_text_prompt(clip)}]}],
        "generationConfig": {
            "temperature": 0.6,
            "responseMimeType": "application/json",
            "responseSchema": THUMBNAIL_TEXT_SCHEMA,
        },
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{settings.gemini_model}:generateContent"
    headers = {"Content-Type": "application/json", "x-goog-api-key": settings.gemini_api_key}
    try:
        with httpx.Client(timeout=settings.gemini_timeout_seconds) as client:
            response = client.post(url, headers=headers, json=body)
        if response.status_code >= 400:
            return []
        return _parse_thumbnail_options(_clean_json(_extract_text(response.json())))
    except Exception:
        return []


def _fallback_thumbnail_text_options(clip: "Clip") -> list[dict[str, str]]:
    evaluation = clip.evaluation_json or {}
    seeds: list[str] = []
    if clip.thumbnail_text:
        seeds.append(str(clip.thumbnail_text))
    for option in evaluation.get("title_options") or []:
        if isinstance(option, dict) and option.get("overlay_text"):
            seeds.append(str(option["overlay_text"]))
    for term in evaluation.get("hook_terms") or []:
        seeds.append(str(term))
    transcript_line = " ".join(str(clip.transcript or "").split())
    if transcript_line:
        seeds.append(transcript_line[:14])
    seeds += ["이거 실화?", "끝까지 보세요", "반전 주의", "이 장면 미쳤다", "지금 난리남"]

    options: list[dict[str, str]] = []
    seen: set[str] = set()
    for seed in seeds:
        text = _clean(seed, 16)
        if not text or text.lower() in seen:
            continue
        seen.add(text.lower())
        options.append(
            {
                "id": f"thumb_{len(options) + 1}",
                "text": text,
                "style": "hook",
                "reason": "클립 핵심을 강조하는 후킹 문구",
            }
        )
        if len(options) >= 5:
            break
    return options


def generate_thumbnail_text_options(clip: "Clip", settings: "Settings") -> list[dict[str, str]]:
    options = _gemini_thumbnail_text_options(clip, settings)
    if len(options) >= 5:
        return options[:5]
    seen = {option["text"].lower() for option in options}
    for option in _fallback_thumbnail_text_options(clip):
        if option["text"].lower() in seen:
            continue
        option = dict(option)
        option["id"] = f"thumb_{len(options) + 1}"
        options.append(option)
        seen.add(option["text"].lower())
        if len(options) >= 5:
            break
    return options[:5]
