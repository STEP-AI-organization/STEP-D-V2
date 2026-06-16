import re
from typing import Any

from app.models import Clip
from app.services.timecode import format_time


TOKEN_RE = re.compile(r"[0-9A-Za-z\uac00-\ud7a3]{2,}")
STOPWORDS = {
    "그리고",
    "그래서",
    "하지만",
    "제가",
    "오늘",
    "이거",
    "그거",
    "영상",
    "정말",
    "진짜",
    "shorts",
    "clip",
}

LABEL_RULES = [
    ("shock", ("충격", "소름", "대박", "미쳤", "예상 밖", "실화")),
    ("twist", ("반전", "갑자기", "그런데", "근데", "결국", "예상")),
    ("warning", ("절대", "위험", "경고", "실수", "후회", "하지 마")),
    ("secret", ("비밀", "아무도", "몰랐", "처음 공개", "공개")),
    ("tips", ("꿀팁", "방법", "알아야", "해야 합니다", "바꾸")),
    ("emotion", ("울", "웃", "화나", "감동", "무서", "기적")),
]


def _clean(text: object, max_length: int | None = None) -> str:
    value = " ".join(str(text or "").split())
    if max_length and len(value) > max_length:
        return value[: max_length - 3].rstrip() + "..."
    return value


def _unique(items: list[str], limit: int) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        cleaned = _clean(item)
        key = cleaned.lower()
        if not cleaned or key in seen:
            continue
        seen.add(key)
        result.append(cleaned)
        if len(result) >= limit:
            break
    return result


def _keyword_tags(text: str) -> list[str]:
    tokens = TOKEN_RE.findall(text)
    useful = [token for token in tokens if token.lower() not in STOPWORDS and len(token) <= 18]
    return _unique(useful, 12)


def _labels(text: str) -> list[str]:
    labels = ["shorts", "viral"]
    lowered = text.lower()
    for label, needles in LABEL_RULES:
        if any(needle.lower() in lowered for needle in needles):
            labels.append(label)
    return _unique(labels, 8)


def build_youtube_metadata(clip: Clip) -> dict[str, Any]:
    evaluation = clip.evaluation_json or {}
    title = _clean(clip.title or evaluation.get("title") or "Scroll-stopping short", 70)
    reason = _clean(clip.reason, 180)
    transcript_preview = _clean(clip.transcript, 420)
    source_range = f"{format_time(clip.start_time)} - {format_time(clip.end_time)}"
    source_text = " ".join(
        [
            title,
            reason,
            _clean(clip.thumbnail_text),
            transcript_preview,
            " ".join(str(item) for item in evaluation.get("hook_terms", []) if item),
        ]
    )

    labels = _labels(source_text)
    tags = _unique(
        [
            *labels,
            *_keyword_tags(source_text),
            "YouTube Shorts",
            "Shorts",
            "viral clip",
            "AI shorts",
            "Korean shorts",
        ],
        20,
    )
    hashtags = _unique(
        [
            "#Shorts",
            "#viral",
            "#AIShorts",
            *[f"#{label}" for label in labels if label not in {"shorts", "viral"}],
        ],
        8,
    )

    description_parts = [
        title,
        "",
        f"Source segment: {source_range}",
        f"Viral score: {clip.score}/100",
    ]
    if reason:
        description_parts.extend(["", f"Why this clip: {reason}"])
    if transcript_preview:
        description_parts.extend(["", f"Transcript summary: {transcript_preview}"])
    description_parts.extend(["", " ".join(hashtags)])

    metadata = {
        "youtube_title": title,
        "description": "\n".join(description_parts),
        "tags": tags,
        "hashtags": hashtags,
        "labels": labels,
        "category": "Entertainment",
        "privacy_status": "private",
        "made_for_kids": False,
        "source_start_time": format_time(clip.start_time),
        "source_end_time": format_time(clip.end_time),
        "duration_seconds": round(max(0.0, clip.end_time - clip.start_time), 2),
        "thumbnail_text": _clean(clip.thumbnail_text, 80),
        "thumbnail_description": _clean(clip.thumbnail_description, 180),
        "upload_note": "Use the rendered MP4 and the real video-frame thumbnail. Review copyright and platform policy before publishing.",
    }
    override = evaluation.get("youtube_metadata_override")
    if isinstance(override, dict):
        for key, value in override.items():
            if value is not None:
                metadata[key] = value
    return metadata
