import json
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database import session_scope
from app.models import Clip, Job, JobStatus
from app.services.candidates import Candidate, detect_candidates, refine_candidates
from app.services.ffmpeg import (
    cut_clip,
    extract_audio,
    extract_frames,
    extract_source_frame,
    extract_thumbnail,
    probe_has_subtitle_stream,
    probe_duration,
    split_audio,
)
from app.services.gemini import detect_burned_in_captions, evaluate_candidate
from app.services.korean_shorts import build_title_options
from app.services.openai_stt import transcribe_audio_chunks
from app.services.scoring import clamp_score, final_score, normalize_score
from app.services.storage import ensure_job_dirs, media_url
from app.services.subtitles import build_ass_subtitles, normalize_style_preset, normalize_subtitle_mode
from app.services.timecode import parse_time
from app.services.youtube_download import YouTubeDownloadError, download_youtube


def _update_job(job_id: str, **values: Any) -> None:
    with session_scope() as db:
        job = db.get(Job, job_id)
        if not job:
            return
        for key, value in values.items():
            setattr(job, key, value)


def _save_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _sample_times(candidate: Candidate, count: int) -> list[float]:
    duration = max(0.1, candidate.end - candidate.start)
    raw = [
        candidate.start + min(1.0, duration * 0.08),
        candidate.start + duration * 0.35,
        candidate.anchor_time,
        candidate.start + duration * 0.72,
        candidate.end - min(1.0, duration * 0.08),
    ]
    times: list[float] = []
    for item in raw:
        bounded = min(candidate.end - 0.05, max(candidate.start, item))
        if all(abs(bounded - existing) > 0.75 for existing in times):
            times.append(bounded)
        if len(times) >= count:
            break
    return times


def _fallback_title(candidate: Candidate) -> str:
    options = build_title_options(
        title="",
        transcript=candidate.transcript,
        thumbnail_text="",
        hook_terms=candidate.hook_terms,
    )
    if options:
        return options[0]["title"]
    text = " ".join(candidate.transcript.strip().split())
    if not text:
        return "놓치면 아쉬운 장면"
    return text[:34] + ("..." if len(text) > 34 else "")


def _render_title(candidate: Candidate, evaluation: dict[str, Any]) -> str:
    title = str(evaluation.get("title") or "").strip()
    if title:
        return title[:90]
    thumbnail_text = str(evaluation.get("thumbnail_text") or "").strip()
    if thumbnail_text:
        return thumbnail_text[:90]
    return _fallback_title(candidate)


def _thumbnail_text(candidate: Candidate) -> str:
    terms = [term for term in candidate.hook_terms if len(term) <= 12]
    if terms:
        return terms[0]
    title = _fallback_title(candidate).removesuffix("...")
    return title[:18]


def _short_error(exc: Exception) -> str:
    return " ".join(str(exc).split())[:280]


def subtitle_render_plan(input_path: Path, settings, metadata: dict[str, Any] | None) -> dict[str, Any]:
    metadata = metadata or {}
    default_mode = getattr(settings, "shorts_subtitle_mode_default", "auto")
    mode = normalize_subtitle_mode(metadata.get("subtitle_mode"), default_mode)
    default_style = getattr(settings, "shorts_style_preset_default", "korean_pop")
    style_preset = normalize_style_preset(metadata.get("style_preset") or metadata.get("shorts_style_preset"), default_style)
    enabled = bool(getattr(settings, "shorts_subtitles_enabled", True))
    source_has_subtitle_stream = False
    source_has_burned_in_captions = bool(metadata.get("source_has_burned_in_captions"))
    render = False
    if enabled and mode != "off":
        source_has_subtitle_stream = probe_has_subtitle_stream(input_path, settings)
        render = not source_has_subtitle_stream and not source_has_burned_in_captions
    return {
        "enabled": enabled,
        "mode": mode,
        "style_preset": style_preset,
        "source_has_subtitle_stream": source_has_subtitle_stream,
        "source_has_burned_in_captions": source_has_burned_in_captions,
        "burned_in_caption_confidence": float(metadata.get("burned_in_caption_confidence") or 0.0),
        "burned_in_caption_reason": str(metadata.get("burned_in_caption_reason") or ""),
        "burned_in_caption_detection_checked": bool(metadata.get("burned_in_caption_detection_checked")),
        "render": render,
    }


def _caption_detection_frame_paths(evaluated: list[tuple[Candidate, dict[str, Any], list[Path]]], limit: int) -> list[Path]:
    paths: list[Path] = []
    for _candidate, _evaluation, frame_paths in evaluated:
        for frame_path in frame_paths:
            if frame_path not in paths:
                paths.append(frame_path)
            if len(paths) >= limit:
                return paths
    return paths


def _apply_burned_in_caption_detection(
    subtitle_plan: dict[str, Any],
    evaluated: list[tuple[Candidate, dict[str, Any], list[Path]]],
    settings,
    warnings: list[str],
) -> None:
    if not subtitle_plan.get("render"):
        return
    if not bool(getattr(settings, "burned_in_caption_detection_enabled", True)):
        return
    limit = max(1, int(getattr(settings, "burned_in_caption_detection_max_frames", 6) or 6))
    frame_paths = _caption_detection_frame_paths(evaluated, limit)
    if not frame_paths:
        return
    subtitle_plan["burned_in_caption_detection_checked"] = True
    try:
        result = detect_burned_in_captions(frame_paths, settings)
    except Exception as exc:
        warnings.append(f"Burned-in caption detection unavailable: {_short_error(exc)}")
        return

    confidence = float(result.get("confidence") or 0.0)
    threshold = float(getattr(settings, "burned_in_caption_detection_confidence_threshold", 0.72) or 0.72)
    has_burned_in = bool(result.get("has_burned_in_captions")) and confidence >= threshold
    subtitle_plan["source_has_burned_in_captions"] = has_burned_in
    subtitle_plan["burned_in_caption_confidence"] = round(confidence, 3)
    subtitle_plan["burned_in_caption_reason"] = str(result.get("reason") or "")
    if has_burned_in:
        subtitle_plan["render"] = False
        warnings.append(
            "Skipped generated captions because source frames appear to already contain burned-in dialogue captions "
            f"(confidence={confidence:.2f})."
        )


def _fallback_evaluation(candidate: Candidate, error: str | None = None) -> dict[str, Any]:
    score = clamp_score(candidate.local_score, default=60)
    reason = "Gemini Vision was unavailable, so this clip was selected by Korean Shorts hook scoring from OpenAI STT."
    if error:
        reason = f"{reason} fallback_reason={error}"
    return {
        "score": score,
        "hook_score": score,
        "emotion_score": max(40, min(100, score - 5)),
        "retention_score": max(45, min(100, score)),
        "shareability_score": max(40, min(100, score - 3)),
        "reason": reason,
        "title": _fallback_title(candidate),
        "thumbnail_text": _thumbnail_text(candidate),
        "thumbnail_description": "Real video-frame thumbnail from an STT-ranked candidate segment.",
        "best_frame_time": f"{candidate.anchor_time:.2f}",
        "fallback": True,
        "fallback_error": error,
    }


def _persist_clip(
    db: Session,
    job_id: str,
    rank: int,
    candidate: Candidate,
    evaluation: dict[str, Any],
    clip_path: Path,
    thumbnail_path: Path,
    source_thumbnail_path: Path | None,
    settings,
) -> None:
    score = final_score(candidate, evaluation)
    evaluation_json = {key: value for key, value in evaluation.items() if key != "_raw"}
    evaluation_json.update(
        {
            "candidate_id": candidate.id,
            "hook_terms": candidate.hook_terms,
            "local_score": candidate.local_score,
            "original_start": candidate.original_start,
            "original_end": candidate.original_end,
            "refined_start": candidate.start,
            "refined_end": candidate.end,
            "boundary_reason": candidate.boundary_reason,
        }
    )
    clip = Clip(
        id=f"{job_id}_{rank:03d}",
        job_id=job_id,
        rank=rank,
        title=str(evaluation.get("title") or _fallback_title(candidate))[:180],
        score=score,
        local_score=float(candidate.local_score),
        gemini_score=normalize_score(evaluation.get("score"), default=score),
        start_time=float(candidate.start),
        end_time=float(candidate.end),
        reason=str(evaluation.get("reason") or "Transcript and representative frames show short-form potential."),
        video_url=media_url(settings, clip_path),
        thumbnail_url=media_url(settings, thumbnail_path),
        source_thumbnail_url=media_url(settings, source_thumbnail_path) if source_thumbnail_path else None,
        thumbnail_text=str(evaluation.get("thumbnail_text") or "")[:120],
        thumbnail_description=str(evaluation.get("thumbnail_description") or ""),
        best_frame_time=parse_time(evaluation.get("best_frame_time"), default=candidate.anchor_time),
        transcript=candidate.transcript,
        evaluation_json=evaluation_json,
    )
    db.add(clip)


def import_and_process(job_id: str) -> None:
    """Download a YouTube source for the job, then hand off to ``process_job`` unchanged.

    The URL lives on ``job.metadata_json['source_url']`` (the task only takes a job_id).
    On download failure the job is marked failed with a friendly message and the
    pipeline is never started.
    """
    settings = get_settings()
    ensure_job_dirs(settings, job_id)
    try:
        with session_scope() as db:
            job = db.get(Job, job_id)
            if not job:
                raise RuntimeError(f"Job {job_id} not found")
            metadata = dict(job.metadata_json or {})
            url = str(metadata.get("source_url") or "").strip()
            input_path = Path(job.input_path)
        if not url:
            raise RuntimeError("No YouTube URL stored on this job.")

        _update_job(job_id, status=JobStatus.processing, progress=2, error=None)
        info = download_youtube(url, input_path, settings)
        _update_job(
            job_id,
            original_filename=str(info.get("title") or "youtube-video")[:255],
            duration=float(info.get("duration") or 0.0) or None,
            progress=4,
        )
    except YouTubeDownloadError as exc:
        with session_scope() as db:
            job = db.get(Job, job_id)
            meta = dict(job.metadata_json or {}) if job else {}
        meta["download_error_code"] = exc.code
        _update_job(job_id, status=JobStatus.failed, progress=100, error=exc.message, metadata_json=meta)
        return
    except Exception as exc:  # noqa: BLE001 - mark the job failed instead of leaving it stuck
        _update_job(job_id, status=JobStatus.failed, progress=100, error=_short_error(exc))
        return

    process_job(job_id)


def process_job(job_id: str) -> None:
    settings = get_settings()
    dirs = ensure_job_dirs(settings, job_id)
    warnings: list[str] = []
    job_metadata: dict[str, Any] = {}

    try:
        _update_job(job_id, status=JobStatus.processing, progress=5, error=None)
        with session_scope() as db:
            job = db.get(Job, job_id)
            if not job:
                raise RuntimeError(f"Job {job_id} not found")
            input_path = Path(job.input_path)
            job_metadata = dict(job.metadata_json or {})

        duration = probe_duration(input_path, settings)
        _update_job(job_id, duration=duration, progress=10)

        audio_path = dirs["job"] / "audio.wav"
        extract_audio(input_path, audio_path, settings)
        _update_job(job_id, progress=20)

        chunks = split_audio(audio_path, dirs["job"] / "audio_chunks", settings)
        transcript = transcribe_audio_chunks(chunks, settings)
        _save_json(dirs["transcripts"] / "transcript.json", transcript)
        _update_job(job_id, progress=42)

        subtitle_plan = subtitle_render_plan(input_path, settings, job_metadata)
        subtitle_clip_count = 0

        candidates = detect_candidates(
            transcript=transcript,
            video_duration=duration,
            min_seconds=settings.min_clip_seconds,
            max_seconds=settings.max_clip_seconds,
            target_seconds=settings.target_clip_seconds,
            max_candidates=settings.max_candidate_count,
        )
        if not candidates:
            raise RuntimeError("No clip candidates were found in the transcript.")
        if settings.boundary_refine_enabled:
            candidates = refine_candidates(
                candidates=candidates,
                transcript=transcript,
                video_duration=duration,
                min_seconds=settings.min_clip_seconds,
                max_seconds=settings.boundary_max_seconds,
                start_lookback_seconds=settings.boundary_start_lookback_seconds,
                end_lookahead_seconds=settings.boundary_end_lookahead_seconds,
                pre_padding_seconds=settings.boundary_pre_padding_seconds,
                post_padding_seconds=settings.boundary_post_padding_seconds,
            )
        _save_json(dirs["job"] / "candidates.json", [candidate.to_dict() for candidate in candidates])
        _update_job(job_id, progress=52)

        evaluation_pool = candidates[: settings.gemini_max_eval_candidates]
        evaluated: list[tuple[Candidate, dict[str, Any], list[Path]]] = []
        gemini_fallback_error: str | None = None
        for index, candidate in enumerate(evaluation_pool, start=1):
            frame_paths = extract_frames(
                input_path,
                dirs["frames"] / candidate.id,
                _sample_times(candidate, settings.frame_count_per_candidate),
                settings,
                candidate.id,
            )
            if gemini_fallback_error:
                evaluation = _fallback_evaluation(candidate, gemini_fallback_error)
            else:
                try:
                    evaluation = evaluate_candidate(candidate, frame_paths, settings)
                except Exception as exc:
                    gemini_fallback_error = _short_error(exc)
                    warnings.append(f"Gemini fallback enabled after {candidate.id}: {gemini_fallback_error}")
                    evaluation = _fallback_evaluation(candidate, gemini_fallback_error)

            evaluated.append((candidate, evaluation, frame_paths))
            progress = 52 + int(28 * index / max(1, len(evaluation_pool)))
            _update_job(job_id, progress=progress)

        ranked = sorted(evaluated, key=lambda item: final_score(item[0], item[1]), reverse=True)
        _apply_burned_in_caption_detection(subtitle_plan, evaluated, settings, warnings)
        winners = ranked[: settings.final_clip_count]
        with session_scope() as db:
            db.query(Clip).filter(Clip.job_id == job_id).delete()
            for rank, (candidate, evaluation, _frames) in enumerate(winners, start=1):
                clip_path = dirs["clips"] / f"short_{rank:03d}.mp4"
                thumb_path = dirs["thumbnails"] / f"short_{rank:03d}.jpg"
                source_thumb_path = dirs["thumbnails"] / f"source_{rank:03d}.jpg"
                render_title = _render_title(candidate, evaluation)
                subtitle_path = None
                if subtitle_plan["render"]:
                    subtitle_path = build_ass_subtitles(
                        transcript,
                        candidate.start,
                        candidate.end,
                        settings,
                        dirs["clips"] / f"short_{rank:03d}.ass",
                        hook_terms=candidate.hook_terms,
                        style_preset=subtitle_plan["style_preset"],
                    )
                    if subtitle_path:
                        subtitle_clip_count += 1
                cut_clip(
                    input_path,
                    clip_path,
                    candidate.start,
                    candidate.end,
                    settings,
                    title_text=render_title,
                    subtitle_path=subtitle_path,
                )

                best_frame_time = parse_time(evaluation.get("best_frame_time"), default=candidate.anchor_time)
                if best_frame_time < candidate.start or best_frame_time > candidate.end:
                    best_frame_time = candidate.anchor_time
                extract_thumbnail(input_path, thumb_path, best_frame_time, settings, title_text=render_title)
                try:
                    extract_source_frame(input_path, source_thumb_path, best_frame_time, settings)
                except Exception:
                    source_thumb_path = None
                _persist_clip(db, job_id, rank, candidate, evaluation, clip_path, thumb_path, source_thumb_path, settings)

        _save_json(
            dirs["job"] / "evaluations.json",
            [
                {
                    "candidate": candidate.to_dict(),
                    "evaluation": {
                        **{key: value for key, value in evaluation.items() if key != "_raw"},
                        "original_start": candidate.original_start,
                        "original_end": candidate.original_end,
                        "refined_start": candidate.start,
                        "refined_end": candidate.end,
                        "boundary_reason": candidate.boundary_reason,
                    },
                    "final_score": final_score(candidate, evaluation),
                }
                for candidate, evaluation, _ in ranked
            ],
        )
        _update_job(
            job_id,
            status=JobStatus.completed,
            progress=100,
            metadata_json={
                **job_metadata,
                "warnings": warnings,
                "gemini_fallback": bool(warnings),
                "render_vertical_shorts": settings.render_vertical_shorts,
                "shorts_reframe_mode": settings.shorts_reframe_mode,
                "shorts_blur_background_strength": settings.shorts_blur_background_strength,
                "shorts_title_overlay": settings.shorts_title_overlay,
                "shorts_style_preset": subtitle_plan["style_preset"],
                "shorts_subtitle_mode": subtitle_plan["mode"],
                "shorts_subtitles_enabled": subtitle_plan["enabled"],
                "shorts_subtitles_rendered": subtitle_clip_count > 0,
                "shorts_subtitle_clip_count": subtitle_clip_count,
                "source_has_subtitle_stream": subtitle_plan["source_has_subtitle_stream"],
                "source_has_burned_in_captions": subtitle_plan["source_has_burned_in_captions"],
                "burned_in_caption_detection_checked": subtitle_plan["burned_in_caption_detection_checked"],
                "burned_in_caption_confidence": subtitle_plan["burned_in_caption_confidence"],
                "burned_in_caption_reason": subtitle_plan["burned_in_caption_reason"],
                "shorts_size": f"{settings.shorts_width}x{settings.shorts_height}",
                "boundary_refine_enabled": settings.boundary_refine_enabled,
                "boundary_max_seconds": settings.boundary_max_seconds,
                "shorts_video_fade_seconds": settings.shorts_video_fade_seconds,
                "shorts_audio_fade_seconds": settings.shorts_audio_fade_seconds,
            },
        )
    except Exception as exc:
        _update_job(job_id, status=JobStatus.failed, progress=100, error=str(exc), metadata_json={**job_metadata, "warnings": warnings})
