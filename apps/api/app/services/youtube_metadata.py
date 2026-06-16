from typing import TYPE_CHECKING, Any

from app.services.korean_shorts import clean_text, keyword_tags, labels as korean_labels, unique
from app.services.timecode import format_time

if TYPE_CHECKING:
    from app.models import Clip


def _limit_tags(tags: list[str], max_chars: int = 500) -> list[str]:
    result: list[str] = []
    for tag in tags:
        candidate = [*result, tag]
        if len(",".join(candidate)) > max_chars:
            break
        result.append(tag)
    return result


def build_youtube_metadata(clip: "Clip") -> dict[str, Any]:
    evaluation = clip.evaluation_json or {}
    title = clean_text(clip.title or evaluation.get("title") or "놓치면 아쉬운 장면", 70)
    reason = clean_text(clip.reason, 180)
    transcript_preview = clean_text(clip.transcript, 420)
    source_range = f"{format_time(clip.start_time)} - {format_time(clip.end_time)}"
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

    description_parts = [
        title,
        "",
        f"원본 구간: {source_range}",
        f"바이럴 점수: {clip.score}/100",
    ]
    if reason:
        description_parts.extend(["", f"추천 이유: {reason}"])
    if transcript_preview:
        description_parts.extend(["", f"자막 요약: {transcript_preview}"])
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
    return metadata
