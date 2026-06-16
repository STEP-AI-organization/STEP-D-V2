from pathlib import Path
from typing import Any

from openai import OpenAI

from app.core.config import Settings


class STTError(RuntimeError):
    pass


def _to_dict(value: Any) -> dict[str, Any]:
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if isinstance(value, dict):
        return value
    return dict(value)


def _offset_item(item: dict[str, Any], offset: float) -> dict[str, Any]:
    item = dict(item)
    for key in ("start", "end"):
        if item.get(key) is not None:
            item[key] = float(item[key]) + offset
    return item


def transcribe_audio_chunks(chunks: list[Path], settings: Settings, chunk_seconds: int = 600) -> dict[str, Any]:
    if not settings.openai_api_key:
        raise STTError("OPENAI_API_KEY is required for transcription.")

    client = OpenAI(api_key=settings.openai_api_key)
    all_text: list[str] = []
    all_segments: list[dict[str, Any]] = []
    all_words: list[dict[str, Any]] = []
    language = None
    duration = 0.0

    for index, chunk_path in enumerate(chunks):
        offset = index * chunk_seconds
        with chunk_path.open("rb") as audio_file:
            kwargs: dict[str, Any] = {
                "file": audio_file,
                "model": settings.openai_transcribe_model,
                "response_format": "verbose_json",
            }
            if settings.openai_transcribe_language:
                kwargs["language"] = settings.openai_transcribe_language
            if settings.openai_transcribe_prompt:
                kwargs["prompt"] = settings.openai_transcribe_prompt
            if settings.openai_transcribe_model == "whisper-1":
                kwargs["timestamp_granularities"] = ["word", "segment"]
            try:
                response = client.audio.transcriptions.create(**kwargs)
            except Exception as exc:
                if "timestamp_granularities" not in kwargs:
                    raise STTError(str(exc)) from exc
                audio_file.seek(0)
                kwargs.pop("timestamp_granularities", None)
                response = client.audio.transcriptions.create(**kwargs)

        payload = _to_dict(response)
        text = payload.get("text") or ""
        all_text.append(text)
        language = language or payload.get("language")
        duration = max(duration, offset + float(payload.get("duration") or 0.0))

        segments = payload.get("segments") or []
        if segments:
            all_segments.extend(_offset_item(segment, offset) for segment in segments)
        elif text:
            all_segments.append(
                {
                    "id": len(all_segments),
                    "start": float(offset),
                    "end": float(offset + payload.get("duration", 0.0)),
                    "text": text,
                }
            )

        words = payload.get("words") or []
        all_words.extend(_offset_item(word, offset) for word in words)

    return {
        "text": "\n".join(part.strip() for part in all_text if part.strip()),
        "language": language,
        "duration": duration,
        "segments": all_segments,
        "words": all_words,
    }
