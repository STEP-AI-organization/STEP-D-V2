from typing import Any

from app.services.candidates import Candidate


def clamp_score(value: object, default: int = 0) -> int:
    try:
        score = int(round(float(value)))
    except (TypeError, ValueError):
        score = default
    return max(0, min(100, score))


def final_score(candidate: Candidate, evaluation: dict[str, Any]) -> int:
    gemini_score = clamp_score(evaluation.get("score"), default=int(candidate.local_score))
    weighted = gemini_score * 0.82 + candidate.local_score * 0.18
    return clamp_score(weighted)
