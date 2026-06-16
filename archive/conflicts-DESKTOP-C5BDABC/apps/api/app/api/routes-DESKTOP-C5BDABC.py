import json
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database import get_db
from app.models import Clip, Job, JobStatus, YouTubeChannel, YouTubePublish
from app.queue import queue
from app.schemas import (
    ClipActionResponse,
    ClipResponse,
    ClipUpdateRequest,
    HealthResponse,
    JobDebugResponse,
    JobResponse,
    ResultsResponse,
    UploadResponse,
    VideoResponse,
    VideosResponse,
    YouTubeConfigResponse,
    YouTubeChannelResponse,
    YouTubeChannelsResponse,
    YouTubeAutoPublishRequest,
    YouTubeAutoPublishResponse,
    YouTubeOAuthStartResponse,
    YouTubePublishRequest,
    YouTubePublishResponse,
    YouTubePublishesResponse,
)
from app.services.ffmpeg import ffmpeg_available
from app.services.editor import rerender_clip, update_clip_fields
from app.services.pipeline import process_job
from app.services.storage import ensure_job_dirs, media_path_from_url, media_url, safe_job_id
from app.services.timecode import format_time
from app.services.youtube_metadata import build_youtube_metadata
from app.services.youtube_oauth import (
    build_authorization_url,
    channel_payload,
    exchange_code_for_tokens,
    fetch_google_userinfo,
    fetch_my_channels,
    parse_oauth_state,
)
from app.services.youtube_publish import publish_youtube_clip, youtube_configured


router = APIRouter(prefix="/api")


def _read_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def _versioned_media_url(url: str) -> str:
    settings = get_settings()
    try:
        path = media_path_from_url(settings, url)
        version = int(path.stat().st_mtime_ns)
    except (OSError, ValueError):
        return url
    separator = "&" if "?" in url else "?"
    return f"{url}{separator}v={version}"


def _clip_response(clip: Clip) -> ClipResponse:
    evaluation = clip.evaluation_json or {}
    return ClipResponse(
        id=clip.id,
        rank=clip.rank,
        title=clip.title,
        score=clip.score,
        local_score=round(float(clip.local_score), 2),
        gemini_score=clip.gemini_score,
        start_time=format_time(clip.start_time),
        end_time=format_time(clip.end_time),
        start_seconds=clip.start_time,
        end_seconds=clip.end_time,
        duration_seconds=round(max(0.0, clip.end_time - clip.start_time), 2),
        reason=clip.reason,
        video_url=_versioned_media_url(clip.video_url),
        thumbnail_url=_versioned_media_url(clip.thumbnail_url),
        thumbnail_text=clip.thumbnail_text,
        thumbnail_description=clip.thumbnail_description,
        best_frame_time=clip.best_frame_time,
        transcript=clip.transcript,
        youtube_metadata=build_youtube_metadata(clip),
        edit_status=evaluation.get("edit_status"),
        edit_error=evaluation.get("edit_error"),
        editor_project=evaluation.get("editor_project") if isinstance(evaluation.get("editor_project"), dict) else None,
    )


def _publish_response(publish: YouTubePublish) -> YouTubePublishResponse:
    metadata = publish.metadata_json if isinstance(publish.metadata_json, dict) else {}
    return YouTubePublishResponse(
        publish_id=publish.id,
        clip_id=publish.clip_id,
        job_id=publish.job_id,
        status=publish.status,
        title=publish.title,
        description=publish.description,
        tags=list(publish.tags_json or []),
        privacy_status=publish.privacy_status,
        category_id=publish.category_id,
        schedule_date=publish.schedule_date,
        youtube_channel_id=metadata.get("youtube_channel_id"),
        youtube_channel_title=metadata.get("youtube_channel_title"),
        youtube_video_id=publish.youtube_video_id,
        youtube_url=publish.youtube_url,
        error=publish.error,
        created_at=publish.created_at,
        updated_at=publish.updated_at,
    )


def _channel_response(channel: YouTubeChannel) -> YouTubeChannelResponse:
    upload_ready = bool(
        channel.refresh_token
        or (channel.access_token and channel.expires_at and channel.expires_at > datetime.utcnow() + timedelta(seconds=60))
    )
    return YouTubeChannelResponse(
        id=channel.id,
        channel_id=channel.channel_id,
        title=channel.title,
        description=channel.description,
        thumbnail_url=channel.thumbnail_url,
        google_account_id=channel.google_account_id,
        google_account_email=channel.google_account_email,
        google_account_name=channel.google_account_name,
        google_account_picture_url=channel.google_account_picture_url,
        upload_ready=upload_ready,
        is_default=bool(channel.is_default),
        created_at=channel.created_at,
        updated_at=channel.updated_at,
    )


def _video_response(job: Job, clips: list[Clip]) -> VideoResponse:
    first_clip = clips[0] if clips else None
    return VideoResponse(
        job_id=job.id,
        original_filename=job.original_filename,
        status=job.status,
        progress=job.progress,
        error=job.error,
        duration=job.duration,
        clip_count=len(clips),
        top_score=max((clip.score for clip in clips), default=None),
        thumbnail_url=_versioned_media_url(first_clip.thumbnail_url) if first_clip else None,
        created_at=job.created_at,
        updated_at=job.updated_at,
    )


def _safe_return_url(return_url: str | None) -> str:
    settings = get_settings()
    base = settings.web_base_url.rstrip("/")
    if return_url and return_url.startswith(base):
        return return_url
    return base


def _redirect_with_status(return_url: str, **params: str | int) -> RedirectResponse:
    separator = "&" if "?" in return_url else "?"
    return RedirectResponse(f"{return_url}{separator}{urlencode(params)}")


def _require_youtube_ready(settings, db: Session) -> int:
    connected_channel_count = db.query(YouTubeChannel).count()
    if not youtube_configured(settings) or (connected_channel_count == 0 and not settings.youtube_refresh_token):
        raise HTTPException(
            status_code=400,
            detail="Connect a YouTube channel with Google login, or set YOUTUBE_REFRESH_TOKEN for legacy upload.",
        )
    return connected_channel_count


def _resolve_youtube_channel(db: Session, youtube_channel_id: str | None, connected_channel_count: int) -> YouTubeChannel | None:
    if youtube_channel_id:
        channel = db.get(YouTubeChannel, youtube_channel_id)
        if not channel:
            channel = db.query(YouTubeChannel).filter(YouTubeChannel.channel_id == youtube_channel_id).first()
        if not channel:
            raise HTTPException(status_code=404, detail="YouTube channel not found.")
        return channel
    if not connected_channel_count:
        return None
    return (
        db.query(YouTubeChannel)
        .order_by(YouTubeChannel.is_default.desc(), YouTubeChannel.updated_at.desc(), YouTubeChannel.created_at.desc())
        .first()
    )


def _new_youtube_publish(
    clip: Clip,
    settings,
    channel: YouTubeChannel | None,
    *,
    title: str | None = None,
    description: str | None = None,
    tags: list[str] | None = None,
    privacy_status: str | None = None,
    category_id: str | None = None,
    schedule_date: str | None = None,
    source: str = "ai-shorts-studio",
) -> YouTubePublish:
    metadata = build_youtube_metadata(clip)
    return YouTubePublish(
        id=safe_job_id(),
        clip_id=clip.id,
        job_id=clip.job_id,
        status="pending",
        title=(title or metadata["youtube_title"])[:100],
        description=description if description is not None else metadata.get("description"),
        tags_json=tags if tags is not None else metadata.get("tags", []),
        privacy_status=privacy_status or settings.youtube_default_privacy_status,
        category_id=category_id or settings.youtube_category_id,
        schedule_date=schedule_date,
        metadata_json={
            "source": source,
            **(
                {
                    "youtube_channel_db_id": channel.id,
                    "youtube_channel_id": channel.channel_id,
                    "youtube_channel_title": channel.title,
                }
                if channel
                else {}
            ),
        },
    )


@router.get("/health", response_model=HealthResponse)
def health():
    settings = get_settings()
    return HealthResponse(
        status="ok",
        ffmpeg_configured=ffmpeg_available(settings),
        storage_dir=str(settings.storage_dir.resolve()),
        settings={
            "gemini_model": settings.gemini_model,
            "gemini_max_eval_candidates": settings.gemini_max_eval_candidates,
            "openai_transcribe_model": settings.openai_transcribe_model,
            "openai_transcribe_language": settings.openai_transcribe_language,
            "max_candidate_count": settings.max_candidate_count,
            "final_clip_count": settings.final_clip_count,
            "render_vertical_shorts": settings.render_vertical_shorts,
            "shorts_reframe_mode": settings.shorts_reframe_mode,
            "shorts_title_overlay": settings.shorts_title_overlay,
            "shorts_title_font_size": settings.shorts_title_font_size,
            "shorts_title_accent_color": settings.shorts_title_accent_color,
            "shorts_size": f"{settings.shorts_width}x{settings.shorts_height}",
            "youtube_configured": youtube_configured(settings),
        },
    )


@router.post("/upload", response_model=UploadResponse, status_code=status.HTTP_202_ACCEPTED)
async def upload_video(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    settings = get_settings()
    suffix = Path(file.filename or "").suffix.lower()
    if suffix != ".mp4":
        raise HTTPException(status_code=400, detail="Only .mp4 uploads are supported in the MVP.")

    job_id = safe_job_id()
    dirs = ensure_job_dirs(settings, job_id)
    input_path = dirs["upload"] / "source.mp4"

    written = 0
    with input_path.open("wb") as output:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            written += len(chunk)
            if written > settings.max_upload_bytes:
                input_path.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail=f"Upload exceeds {settings.max_upload_mb} MB limit.")
            output.write(chunk)

    job = Job(
        id=job_id,
        status=JobStatus.pending,
        original_filename=file.filename or "video.mp4",
        input_path=str(input_path),
        progress=0,
    )
    db.add(job)
    db.commit()

    queue.enqueue(background_tasks, process_job, job_id)
    return UploadResponse(job_id=job_id)


@router.get("/videos", response_model=VideosResponse)
def list_videos(db: Session = Depends(get_db)):
    jobs = db.query(Job).order_by(Job.updated_at.desc(), Job.created_at.desc()).limit(100).all()
    job_ids = [job.id for job in jobs]
    clips = db.query(Clip).filter(Clip.job_id.in_(job_ids)).order_by(Clip.rank.asc()).all() if job_ids else []
    by_job: dict[str, list[Clip]] = {job_id: [] for job_id in job_ids}
    for clip in clips:
        by_job.setdefault(clip.job_id, []).append(clip)
    return VideosResponse(videos=[_video_response(job, by_job.get(job.id, [])) for job in jobs])


@router.get("/jobs/latest-completed", response_model=ResultsResponse, response_model_by_alias=False)
def get_latest_completed_results(db: Session = Depends(get_db)):
    job = (
        db.query(Job)
        .filter(Job.status == JobStatus.completed)
        .order_by(Job.updated_at.desc(), Job.created_at.desc())
        .first()
    )
    if not job:
        raise HTTPException(status_code=404, detail="No completed job found.")
    clips = db.query(Clip).filter(Clip.job_id == job.id).order_by(Clip.rank.asc()).all()
    return ResultsResponse(job_id=job.id, status=job.status, clips=[_clip_response(clip) for clip in clips])


@router.get("/jobs/{job_id}", response_model=JobResponse, response_model_by_alias=False)
def get_job(job_id: str, db: Session = Depends(get_db)):
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    return job


@router.get("/jobs/{job_id}/debug", response_model=JobDebugResponse)
def get_job_debug(job_id: str, db: Session = Depends(get_db)):
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")

    settings = get_settings()
    dirs = ensure_job_dirs(settings, job_id)
    transcript = _read_json(dirs["transcripts"] / "transcript.json", {})
    candidates = _read_json(dirs["job"] / "candidates.json", [])
    evaluations = _read_json(dirs["job"] / "evaluations.json", [])
    metadata = job.metadata_json or {}

    candidate_rows = []
    for candidate in candidates[:30]:
        candidate_rows.append(
            {
                "id": candidate.get("id"),
                "start_time": format_time(float(candidate.get("start") or 0.0)),
                "end_time": format_time(float(candidate.get("end") or 0.0)),
                "start_seconds": candidate.get("start"),
                "end_seconds": candidate.get("end"),
                "duration_seconds": round(float(candidate.get("duration") or 0.0), 2),
                "local_score": round(float(candidate.get("local_score") or 0.0), 2),
                "hook_terms": candidate.get("hook_terms") or [],
                "transcript_preview": " ".join(str(candidate.get("transcript") or "").split())[:360],
            }
        )

    artifacts = {}
    for name, path in {
        "transcript": dirs["transcripts"] / "transcript.json",
        "candidates": dirs["job"] / "candidates.json",
        "evaluations": dirs["job"] / "evaluations.json",
    }.items():
        if path.exists():
            artifacts[name] = media_url(settings, path)

    return JobDebugResponse(
        job_id=job.id,
        status=job.status,
        progress=job.progress,
        transcript_preview=" ".join(str(transcript.get("text") or "").split())[:4000],
        transcript_segment_count=len(transcript.get("segments") or []),
        candidate_count=len(candidates),
        candidates=candidate_rows,
        evaluations=evaluations[:30] if isinstance(evaluations, list) else [],
        warnings=[str(item) for item in metadata.get("warnings", [])],
        artifacts=artifacts,
    )


@router.patch("/clips/{clip_id}", response_model=ClipActionResponse, response_model_by_alias=False)
def update_clip(clip_id: str, body: ClipUpdateRequest, db: Session = Depends(get_db)):
    clip = db.get(Clip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found.")
    update_clip_fields(clip, body.model_dump(exclude_unset=True))
    db.commit()
    db.refresh(clip)
    return ClipActionResponse(clip=_clip_response(clip))


@router.post("/clips/{clip_id}/rerender", response_model=ClipActionResponse, response_model_by_alias=False)
def rerender_clip_endpoint(
    clip_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    clip = db.get(Clip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found.")
    data = dict(clip.evaluation_json or {})
    data["edit_status"] = "queued"
    clip.evaluation_json = data
    db.commit()
    db.refresh(clip)
    queue.enqueue(background_tasks, rerender_clip, clip_id)
    return ClipActionResponse(clip=_clip_response(clip))


@router.get("/youtube/config", response_model=YouTubeConfigResponse)
def youtube_config(db: Session = Depends(get_db)):
    settings = get_settings()
    default_channel = db.query(YouTubeChannel).filter(YouTubeChannel.is_default == 1).first()
    return YouTubeConfigResponse(
        configured=youtube_configured(settings),
        privacy_status=settings.youtube_default_privacy_status,
        category_id=settings.youtube_category_id,
        connected_channel_count=db.query(YouTubeChannel).count(),
        default_channel_id=default_channel.channel_id if default_channel else None,
        legacy_refresh_configured=bool(settings.youtube_refresh_token),
    )


@router.get("/youtube/oauth/start", response_model=YouTubeOAuthStartResponse)
def youtube_oauth_start(return_url: str | None = None):
    settings = get_settings()
    if not youtube_configured(settings):
        raise HTTPException(status_code=400, detail="Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET before connecting YouTube.")
    return YouTubeOAuthStartResponse(auth_url=build_authorization_url(settings, _safe_return_url(return_url)))


@router.get("/youtube/oauth/callback")
def youtube_oauth_callback(
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    db: Session = Depends(get_db),
):
    settings = get_settings()
    return_url = settings.web_base_url.rstrip("/")
    if state:
        try:
            return_url = _safe_return_url(str(parse_oauth_state(settings, state).get("return_url") or return_url))
        except ValueError:
            return _redirect_with_status(return_url, youtube_error="invalid_state")
    if error:
        return _redirect_with_status(return_url, youtube_error=error)
    if not code:
        return _redirect_with_status(return_url, youtube_error="missing_code")

    try:
        tokens = exchange_code_for_tokens(settings, code)
        access_token = str(tokens.get("access_token") or "")
        profile = fetch_google_userinfo(access_token)
        items = fetch_my_channels(access_token)
        if not items:
            return _redirect_with_status(return_url, youtube_error="no_channel")

        has_default = db.query(YouTubeChannel).filter(YouTubeChannel.is_default == 1).first() is not None
        connected = 0
        for item in items:
            channel_id = str(item.get("id") or "")
            if not channel_id:
                continue
            existing = db.query(YouTubeChannel).filter(YouTubeChannel.channel_id == channel_id).first()
            payload = channel_payload(item, tokens, existing.refresh_token if existing else None, profile)
            if existing:
                for key, value in payload.items():
                    if value is not None:
                        setattr(existing, key, value)
                channel = existing
            else:
                channel = YouTubeChannel(id=safe_job_id(), **payload)
                db.add(channel)
            if not has_default:
                channel.is_default = 1
                has_default = True
            connected += 1
        db.commit()
    except Exception as exc:
        return _redirect_with_status(return_url, youtube_error=str(exc)[:160])
    return _redirect_with_status(return_url, youtube_connected=connected)


@router.get("/youtube/channels", response_model=YouTubeChannelsResponse)
def list_youtube_channels(db: Session = Depends(get_db)):
    channels = db.query(YouTubeChannel).order_by(YouTubeChannel.is_default.desc(), YouTubeChannel.updated_at.desc()).all()
    return YouTubeChannelsResponse(channels=[_channel_response(channel) for channel in channels])


@router.post("/youtube/channels/{channel_id}/default", response_model=YouTubeChannelResponse)
def set_default_youtube_channel(channel_id: str, db: Session = Depends(get_db)):
    channel = db.get(YouTubeChannel, channel_id)
    if not channel:
        channel = db.query(YouTubeChannel).filter(YouTubeChannel.channel_id == channel_id).first()
    if not channel:
        raise HTTPException(status_code=404, detail="YouTube channel not found.")
    for item in db.query(YouTubeChannel).all():
        item.is_default = 1 if item.id == channel.id else 0
    db.commit()
    db.refresh(channel)
    return _channel_response(channel)


@router.get("/youtube/publishes", response_model=YouTubePublishesResponse)
def list_youtube_publishes(job_id: str | None = None, db: Session = Depends(get_db)):
    query = db.query(YouTubePublish).order_by(YouTubePublish.updated_at.desc(), YouTubePublish.created_at.desc())
    if job_id:
        query = query.filter(YouTubePublish.job_id == job_id)
    return YouTubePublishesResponse(publishes=[_publish_response(item) for item in query.limit(200).all()])


@router.post("/clips/{clip_id}/youtube/publish", response_model=YouTubePublishResponse)
def publish_clip_to_youtube(
    clip_id: str,
    body: YouTubePublishRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    settings = get_settings()
    connected_channel_count = _require_youtube_ready(settings, db)
    clip = db.get(Clip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found.")
    channel = _resolve_youtube_channel(db, body.youtube_channel_id, connected_channel_count)
    publish = _new_youtube_publish(
        clip,
        settings,
        channel,
        title=body.title,
        description=body.description,
        tags=body.tags,
        privacy_status=body.privacy_status,
        category_id=body.category_id,
        schedule_date=body.schedule_date,
    )
    db.add(publish)
    db.commit()
    db.refresh(publish)
    queue.enqueue(background_tasks, publish_youtube_clip, publish.id)
    return _publish_response(publish)


@router.post("/jobs/{job_id}/youtube/auto-publish", response_model=YouTubeAutoPublishResponse)
def auto_publish_job_to_youtube(
    job_id: str,
    body: YouTubeAutoPublishRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    settings = get_settings()
    connected_channel_count = _require_youtube_ready(settings, db)
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    if job.status != JobStatus.completed:
        raise HTTPException(status_code=400, detail="Job must be completed before auto publishing.")

    channel = _resolve_youtube_channel(db, body.youtube_channel_id, connected_channel_count)
    existing_active_clip_ids: set[str] = set()
    if body.skip_existing:
        rows = (
            db.query(YouTubePublish.clip_id)
            .filter(YouTubePublish.job_id == job_id)
            .filter(YouTubePublish.status.in_(["pending", "uploading", "scheduled", "published"]))
            .all()
        )
        existing_active_clip_ids = {str(row[0]) for row in rows}

    clips = (
        db.query(Clip)
        .filter(Clip.job_id == job_id)
        .filter(Clip.score >= body.min_score)
        .order_by(Clip.score.desc(), Clip.rank.asc())
        .all()
    )

    publishes: list[YouTubePublish] = []
    skipped_count = 0
    for clip in clips:
        if len(publishes) >= body.max_clips:
            break
        if clip.id in existing_active_clip_ids:
            skipped_count += 1
            continue
        publish = _new_youtube_publish(
            clip,
            settings,
            channel,
            privacy_status=body.privacy_status,
            category_id=body.category_id,
            schedule_date=body.schedule_date,
            source="auto-publish",
        )
        db.add(publish)
        publishes.append(publish)

    db.commit()
    for publish in publishes:
        db.refresh(publish)
        queue.enqueue(background_tasks, publish_youtube_clip, publish.id)

    return YouTubeAutoPublishResponse(
        job_id=job_id,
        requested_count=body.max_clips,
        queued_count=len(publishes),
        skipped_count=skipped_count,
        youtube_channel_id=channel.channel_id if channel else None,
        youtube_channel_title=channel.title if channel else None,
        publishes=[_publish_response(publish) for publish in publishes],
    )


@router.get("/jobs/{job_id}/results", response_model=ResultsResponse, response_model_by_alias=False)
def get_results(job_id: str, db: Session = Depends(get_db)):
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    clips = db.query(Clip).filter(Clip.job_id == job_id).order_by(Clip.rank.asc()).all()
    return ResultsResponse(
        job_id=job.id,
        status=job.status,
        clips=[_clip_response(clip) for clip in clips],
    )
