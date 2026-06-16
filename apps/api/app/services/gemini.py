import base64
import json
from pathlib import Path
from typing import Any

import httpx

from app.core.config import Settings
from app.prompts import (
    CAPTION_DETECTION_SCHEMA,
    EVALUATION_SCHEMA,
    build_caption_detection_prompt,
    build_evaluation_prompt,
)
from app.services.candidates import Candidate


class GeminiError(RuntimeError):
    pass


def _image_part(path: Path) -> dict[str, Any]:
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    return {"inline_data": {"mime_type": "image/jpeg", "data": data}}


def _request_body(parts: list[dict[str, Any]], generation_config: dict[str, Any]) -> dict[str, Any]:
    return {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": generation_config,
    }


def _body_variants(parts: list[dict[str, Any]], schema: dict[str, Any] = EVALUATION_SCHEMA) -> list[dict[str, Any]]:
    return [
        _request_body(
            parts,
            {
                "temperature": 0.2,
                "responseMimeType": "application/json",
                "responseSchema": schema,
            },
        ),
        _request_body(
            parts,
            {
                "temperature": 0.2,
                "responseFormat": {
                    "text": {
                        "mimeType": "application/json",
                        "schema": schema,
                    }
                },
            },
        ),
        _request_body(
            parts,
            {
                "temperature": 0.2,
                "responseMimeType": "application/json",
            },
        ),
        _request_body(parts, {"temperature": 0.2}),
    ]


def _extract_text(payload: dict[str, Any]) -> str:
    candidates = payload.get("candidates") or []
    if not candidates:
        raise GeminiError(f"No Gemini candidates returned: {payload}")
    parts = candidates[0].get("content", {}).get("parts", [])
    text = "".join(part.get("text", "") for part in parts if isinstance(part, dict))
    if not text:
        raise GeminiError(f"Gemini response did not contain text: {payload}")
    return text.strip()


def _clean_json(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        cleaned = cleaned.removeprefix("json").strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise GeminiError(f"Gemini returned invalid JSON: {text[:500]}") from exc


def evaluate_candidate(candidate: Candidate, frame_paths: list[Path], settings: Settings) -> dict[str, Any]:
    if not settings.gemini_api_key:
        raise GeminiError("GEMINI_API_KEY is required for vision evaluation.")

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{settings.gemini_model}:generateContent"
    parts: list[dict[str, Any]] = [{"text": build_evaluation_prompt(candidate)}]
    parts.extend(_image_part(path) for path in frame_paths)

    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": settings.gemini_api_key,
    }
    errors: list[str] = []
    with httpx.Client(timeout=settings.gemini_timeout_seconds) as client:
        for body in _body_variants(parts):
            response = client.post(url, headers=headers, json=body)
            if response.status_code < 400:
                break
            errors.append(f"{response.status_code}: {response.text[:500]}")
            if response.status_code != 400:
                break
    if response.status_code >= 400:
        raise GeminiError(f"Gemini API error after {len(errors)} attempt(s): {' | '.join(errors)}")

    payload = response.json()
    result = _clean_json(_extract_text(payload))
    result["_raw"] = payload
    return result


def detect_burned_in_captions(frame_paths: list[Path], settings: Settings) -> dict[str, Any]:
    if not frame_paths:
        return {"has_burned_in_captions": False, "confidence": 0.0, "reason": "No frames were provided."}
    if not settings.gemini_api_key:
        raise GeminiError("GEMINI_API_KEY is required for visual caption detection.")

    max_frames = max(1, int(getattr(settings, "burned_in_caption_detection_max_frames", 6) or 6))
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{settings.gemini_model}:generateContent"
    parts: list[dict[str, Any]] = [{"text": build_caption_detection_prompt()}]
    parts.extend(_image_part(path) for path in frame_paths[:max_frames])

    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": settings.gemini_api_key,
    }
    errors: list[str] = []
    with httpx.Client(timeout=settings.gemini_timeout_seconds) as client:
        for body in _body_variants(parts, CAPTION_DETECTION_SCHEMA):
            response = client.post(url, headers=headers, json=body)
            if response.status_code < 400:
                break
            errors.append(f"{response.status_code}: {response.text[:500]}")
            if response.status_code != 400:
                break
    if response.status_code >= 400:
        raise GeminiError(f"Gemini API error after {len(errors)} attempt(s): {' | '.join(errors)}")

    payload = response.json()
    result = _clean_json(_extract_text(payload))
    confidence = float(result.get("confidence") or 0.0)
    result["confidence"] = max(0.0, min(1.0, confidence))
    result["has_burned_in_captions"] = bool(result.get("has_burned_in_captions"))
    result["reason"] = str(result.get("reason") or "")[:240]
    result["_raw"] = payload
    return result
