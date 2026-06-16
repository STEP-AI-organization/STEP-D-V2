from typing import Any

from app.services.korean_shorts import labels as korean_labels
from app.services.korean_shorts import unique


def _number(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _score_item(label: str, value: object) -> dict[str, Any]:
    score = max(0.0, min(100.0, _number(value)))
    return {"label": label, "value": round(score, 1)}


def build_korean_shorts_signals(clip: object, youtube_metadata: dict[str, Any]) -> dict[str, Any]:
    evaluation = getattr(clip, "evaluation_json", None) or {}
    hook_terms = unique([str(item) for item in evaluation.get("hook_terms", []) if item], 10)
    labels = youtube_metadata.get("labels") if isinstance(youtube_metadata, dict) else None
    if not isinstance(labels, list) or not labels:
        source_text = " ".join(
            [
                str(getattr(clip, "title", "") or ""),
                str(getattr(clip, "reason", "") or ""),
                str(getattr(clip, "thumbnail_text", "") or ""),
                str(getattr(clip, "transcript", "") or "")[:500],
                " ".join(hook_terms),
            ]
        )
        labels = korean_labels(source_text)

    breakdown = [
        _score_item("Viral", getattr(clip, "score", 0)),
        _score_item("Korean hook", getattr(clip, "local_score", 0)),
        _score_item("Vision", getattr(clip, "gemini_score", 0)),
    ]
    optional_scores = [
        ("Hook", evaluation.get("hook_score")),
        ("Emotion", evaluation.get("emotion_score")),
        ("Retention", evaluation.get("retention_score")),
        ("Share", evaluation.get("shareability_score")),
    ]
    for label, value in optional_scores:
        if value is not None:
            breakdown.append(_score_item(label, value))

    fallback = bool(evaluation.get("fallback"))
    basis = "Local Korean Shorts scoring" if fallback else "Vision + Korean Shorts scoring"
    boundary_reason = str(evaluation.get("boundary_reason") or "")
    title_styles = unique(
        [
            str(option.get("style"))
            for option in evaluation.get("title_options", [])
            if isinstance(option, dict) and option.get("style")
        ],
        5,
    )

    return {
        "hook_terms": hook_terms,
        "labels": unique([str(label) for label in labels if label], 8),
        "score_breakdown": breakdown,
        "selection_basis": basis,
        "boundary_reason": boundary_reason,
        "title_styles": title_styles,
        "fallback": fallback,
    }
