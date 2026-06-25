import re
from typing import TYPE_CHECKING, Any

from app.services.korean_shorts import clean_text, keyword_tags, labels as korean_labels, unique
from app.services.timecode import format_time

if TYPE_CHECKING:
    from app.models import Clip


SHORTS_HASHTAG = "#Shorts"
SHORTS_TITLE_HASHTAG = "#short"
SHORTS_TAG = "Shorts"
SHORTS_HASHTAG_PATTERN = re.compile(r"(^|\s)#shorts?\b", re.IGNORECASE)


def _limit_tags(tags: list[str], max_chars: int = 500) -> list[str]:
    result: list[str] = []
    for tag in tags:
        candidate = [*result, tag]
        if len(",".join(candidate)) > max_chars:
            break
        result.append(tag)
    return result


def has_shorts_hashtag(*values: object) -> bool:
    return any(SHORTS_HASHTAG_PATTERN.search(str(value or "")) for value in values)


def ensure_shorts_hashtag(description: object, title: object = "", max_length: int = 5000) -> str:
    clean_description = clean_text(description)
    if has_shorts_hashtag(title):
        return clean_text(clean_description, max_length)

    limited_description = clean_text(clean_description, max_length)
    if has_shorts_hashtag(limited_description):
        return limited_description

    if not clean_description:
        return SHORTS_HASHTAG
    if max_length and len(clean_description) + len(f" {SHORTS_HASHTAG}") > max_length:
        clean_description = clean_description[: max(0, max_length - len(f" {SHORTS_HASHTAG}"))].rstrip()
    return f"{clean_description} {SHORTS_HASHTAG}".strip()


def ensure_shorts_title_hashtag(title: object, max_length: int = 100) -> str:
    clean_title = clean_text(title)
    if has_shorts_hashtag(clean_title):
        return clean_text(clean_title, max_length)

    suffix = f" {SHORTS_TITLE_HASHTAG}" if clean_title else SHORTS_TITLE_HASHTAG
    if max_length and len(clean_title) + len(suffix) > max_length:
        clean_title = clean_title[: max(0, max_length - len(suffix))].rstrip()
    return f"{clean_title}{suffix}".strip()


def ensure_shorts_tags(tags: list[object], limit: int = 20, max_chars: int = 500) -> list[str]:
    cleaned = [clean_text(tag) for tag in tags]
    without_shorts = [tag for tag in cleaned if tag and tag.lower() != SHORTS_TAG.lower()]
    return _limit_tags(unique([SHORTS_TAG, *without_shorts], limit), max_chars)


def sanitize_youtube_text(text: object) -> str:
    return str(text or "").replace("<", "(").replace(">", ")").strip()


def normalize_shorts_publish_metadata(
    title: str,
    description: str | None,
    tags: list[object] | None,
) -> tuple[str, str, list[str]]:
    clean_title = ensure_shorts_title_hashtag(sanitize_youtube_text(title))
    clean_description = sanitize_youtube_text(ensure_shorts_hashtag(description or ""))
    clean_tags = ensure_shorts_tags(list(tags or []))
    return clean_title, clean_description, clean_tags


def build_youtube_metadata(clip: "Clip") -> dict[str, Any]:
    evaluation = clip.evaluation_json or {}
    title = clean_text(clip.title or evaluation.get("title") or "놓치면 아쉬운 장면", 70)
    reason = clean_text(clip.reason, 180)
    transcript_preview = clean_text(clip.transcript, 420)
    hook_terms = [str(item) for item in evaluation.get("hook_terms", []) if item]
    source_text = " ".join(
        [
            title,
            reason,
            clean_text(clip.thumbnail_text),
            transcript_preview,
            " ".join(hook_terms),
        ]
    )

    labels = korean_labels(source_text)
    tags = _limit_tags(
        unique(
            [
                *labels,
                *keyword_tags(source_text),
                "유튜브쇼츠",
                "Shorts",
                "쇼츠추천",
                "AI쇼츠",
                "한국쇼츠",
            ],
            20,
        )
    )
    hashtags = unique(
        [
            "#Shorts",
            "#쇼츠",
            "#한국쇼츠",
            *[f"#{label}" for label in labels if label not in {"쇼츠", "한국쇼츠"}],
        ],
        8,
    )

    # Viewer-facing description only. Internal signals (source range, viral score,
    # LLM recommendation reason, transcript dump) are kept out of what gets
    # published to YouTube — they live in other metadata fields for in-app use.
    hook = clean_text(clip.thumbnail_text, 60)
    description_parts = [title]
    if hook and hook != title:
        description_parts.append(hook)
    description_parts.extend(["", " ".join(hashtags)])

    metadata = {
        "youtube_title": title,
        "description": clean_text("\n".join(description_parts), 5000),
        "tags": tags,
        "hashtags": hashtags,
        "labels": labels,
        "category": "Entertainment",
        "privacy_status": "private",
        "made_for_kids": False,
        "source_start_time": format_time(clip.start_time),
        "source_end_time": format_time(clip.end_time),
        "duration_seconds": round(max(0.0, clip.end_time - clip.start_time), 2),
        "thumbnail_text": clean_text(clip.thumbnail_text, 80),
        "thumbnail_description": clean_text(clip.thumbnail_description, 180),
        "upload_note": "Rendered MP4 and real video-frame thumbnail are ready. Review copyright and platform policy before publishing.",
    }

    overrides = evaluation.get("metadata_overrides") if isinstance(evaluation, dict) else None
    if isinstance(overrides, dict):
        for key in ("youtube_title", "description", "category", "privacy_status"):
            if overrides.get(key):
                metadata[key] = clean_text(overrides[key], 5000 if key == "description" else 100)
        if isinstance(overrides.get("tags"), list):
            metadata["tags"] = _limit_tags(unique([str(tag) for tag in overrides["tags"]], 20))

    metadata["youtube_title"] = ensure_shorts_title_hashtag(metadata.get("youtube_title", ""))
    metadata["description"] = ensure_shorts_hashtag(metadata.get("description", ""))
    metadata["tags"] = ensure_shorts_tags(list(metadata.get("tags") or []))
    return metadata
