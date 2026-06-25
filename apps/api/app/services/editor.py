from pathlib import Path
from typing import Any

from app.core.config import get_settings
from app.core.database import session_scope
from app.models import Clip, Job
from app.services.ffmpeg import extract_source_frame, extract_thumbnail, render_segments
from app.services.storage import ensure_job_dirs, media_path_from_url, media_url
from app.services.timecode import parse_time


def _patch_clip_status(clip: Clip, status: str, error: str | None = None) -> None:
    data = dict(clip.evaluation_json or {})
    data["edit_status"] = status
    if error:
        data["edit_error"] = error
    elif "edit_error" in data:
        data.pop("edit_error", None)
    clip.evaluation_json = data


def update_clip_fields(clip: Clip, values: dict[str, Any]) -> None:
    if "title" in values and values["title"] is not None:
        clip.title = str(values["title"])[:180]
    if "reason" in values and values["reason"] is not None:
        clip.reason = str(values["reason"])
    if "thumbnail_text" in values:
        clip.thumbnail_text = str(values.get("thumbnail_text") or "")[:120]
    if "thumbnail_description" in values:
        clip.thumbnail_description = str(values.get("thumbnail_description") or "")

    metadata = values.get("youtube_metadata")
    if metadata is not None:
        data = dict(clip.evaluation_json or {})
        data["youtube_metadata_override"] = metadata
        clip.evaluation_json = data
    editor_project = values.get("editor_project")
    if editor_project is not None:
        data = dict(clip.evaluation_json or {})
        data["editor_project"] = editor_project
        if isinstance(editor_project, dict) and editor_project.get("render_title"):
            data["render_title"] = str(editor_project.get("render_title"))
        clip.evaluation_json = data


def _project_segments(clip: Clip, project: dict[str, Any]) -> list[dict[str, float]]:
    raw_segments = project.get("segments") if isinstance(project, dict) else None
    if not raw_segments:
        return [{"start": float(clip.start_time), "end": float(clip.end_time)}]

    segments: list[dict[str, float]] = []
    for item in raw_segments:
        if not isinstance(item, dict):
            continue
        start = item.get("start")
        end = item.get("end")
        if start is None:
            start = item.get("start_seconds")
        if end is None:
            end = item.get("end_seconds")
        try:
            start_value = float(start)
            end_value = float(end)
        except (TypeError, ValueError):
            continue
        if end_value > start_value:
            segments.append({"start": start_value, "end": end_value})
    return segments or [{"start": float(clip.start_time), "end": float(clip.end_time)}]


def _project_overlays(project: dict[str, Any]) -> list[dict[str, Any]]:
    raw_overlays = project.get("overlays") if isinstance(project, dict) else None
    if not isinstance(raw_overlays, list):
        return []
    overlays: list[dict[str, Any]] = []
    for item in raw_overlays:
        if not isinstance(item, dict):
            continue
        if item.get("type", "text") != "text":
            continue
        if not str(item.get("text") or "").strip():
            continue
        overlays.append(item)
    return overlays


def rerender_clip(clip_id: str) -> None:
    settings = get_settings()
    try:
        with session_scope() as db:
            clip = db.get(Clip, clip_id)
            if not clip:
                return
            _patch_clip_status(clip, "rendering")

        with session_scope() as db:
            clip = db.get(Clip, clip_id)
            if not clip:
                return
            job = db.get(Job, clip.job_id)
            if not job:
                raise RuntimeError("Job not found for clip")

            video_path = media_path_from_url(settings, clip.video_url)
            thumbnail_path = media_path_from_url(settings, clip.thumbnail_url)
            source_path = Path(job.input_path)
            evaluation = clip.evaluation_json or {}
            editor_project = evaluation.get("editor_project") if isinstance(evaluation.get("editor_project"), dict) else {}
            render_title = str(
                (editor_project or {}).get("render_title")
                or evaluation.get("render_title")
                or (evaluation.get("youtube_metadata_override") or {}).get("youtube_title")
                or clip.title
            )
            segments = _project_segments(clip, editor_project or {})
            text_overlays = _project_overlays(editor_project or {})
            best_frame_time = clip.best_frame_time
            if best_frame_time is None or best_frame_time < clip.start_time or best_frame_time > clip.end_time:
                best_frame_time = parse_time(evaluation.get("best_frame_time"), default=clip.start_time)
            if best_frame_time < clip.start_time or best_frame_time > clip.end_time:
                best_frame_time = clip.start_time

            render_segments(source_path, video_path, segments, settings, title_text=render_title, text_overlays=text_overlays)
            extract_thumbnail(source_path, thumbnail_path, best_frame_time, settings, title_text=render_title, text_overlays=text_overlays)
            try:
                source_thumb_path = ensure_job_dirs(settings, clip.job_id)["thumbnails"] / f"source_{clip.rank:03d}.jpg"
                extract_source_frame(source_path, source_thumb_path, best_frame_time, settings)
                clip.source_thumbnail_url = media_url(settings, source_thumb_path)
            except Exception:
                pass
            clip.start_time = min(segment["start"] for segment in segments)
            clip.end_time = max(segment["end"] for segment in segments)
            _patch_clip_status(clip, "rendered")
    except Exception as exc:
        with session_scope() as db:
            clip = db.get(Clip, clip_id)
            if clip:
                _patch_clip_status(clip, "failed", str(exc))
