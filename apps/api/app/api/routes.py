import base64
import binascii
import json
import re
import shutil
from tempfile import TemporaryDirectory
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database import get_db
from app.models import Clip, Job, JobStatus, YouTubePublish
from app.queue import queue
from app.schemas import (
    AssetUploadResponse,
    ClipResponse,
    CreativeApplyRequest,
    HighlightRenderRequest,
    HighlightRenderResponse,
    HealthResponse,
    JobDebugResponse,
    JobResponse,
    PplAnalysisResponse,
    PplLinksRequest,
    RenderTemplate,
    ResultsResponse,
    RetrimRequest,
    StudioProject,
    StudioProjectClip,
    StudioScheduleItem,
    StudioSummaryResponse,
    ThumbnailTextOptionsResponse,
    TitleOptionsResponse,
    UploadResponse,
    VideoInspectionResponse,
    YouTubeImportRequest,
)
from app.services.creative import generate_thumbnail_text_options, generate_title_options
from app.services.clip_briefing import build_clip_briefing
from app.services.clip_signals import build_korean_shorts_signals
from app.services.ffmpeg import (
    cut_clip,
    extract_thumbnail,
    ffmpeg_available,
    probe_duration,
    probe_has_subtitle_stream,
    render_highlight_segments,
)
from app.services.pipeline import import_and_process, process_job, subtitle_render_plan
from app.services.ppl import analyze_clip_ppl, update_ppl_affiliate_links
from app.services.storage import ensure_job_dirs, media_path_from_url, media_url, safe_job_id
from app.services.subtitles import (
    available_style_presets,
    build_ass_subtitles,
    normalize_style_preset,
    normalize_subtitle_mode,
)
from app.services.templates import ALLOWED_OVERLAY_POSITIONS, get_render_template, list_render_templates
from app.services.timecode import format_time
from app.services.youtube_metadata import build_youtube_metadata
from app.services.youtube_package import build_youtube_package


router = APIRouter(prefix="/api")


def _read_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def _clip_response(clip: Clip) -> ClipResponse:
    settings = get_settings()
    evaluation = clip.evaluation_json or {}
    youtube_metadata = build_youtube_metadata(clip)
    korean_shorts_signals = build_korean_shorts_signals(clip, youtube_metadata)
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
        video_url=clip.video_url,
        thumbnail_url=clip.thumbnail_url,
        source_thumbnail_url=clip.source_thumbnail_url,
        thumbnail_text=clip.thumbnail_text,
        thumbnail_description=clip.thumbnail_description,
        best_frame_time=clip.best_frame_time,
        transcript=clip.transcript,
        youtube_metadata=youtube_metadata,
        title_options=evaluation.get("title_options") or [],
        thumbnail_text_options=evaluation.get("thumbnail_text_options") or [],
        edit_status=evaluation.get("edit_status"),
        creative_settings=evaluation.get("creative_settings") or {},
        render_revision=int(evaluation.get("render_revision") or 0),
        youtube_package_url=f"{settings.public_base_url.rstrip('/') if settings.public_base_url else ''}/api/clips/{clip.id}/youtube-package",
        korean_shorts_signals=korean_shorts_signals,
        clip_briefing=build_clip_briefing(clip, youtube_metadata, korean_shorts_signals),
        ppl_analysis=clip.ppl_analysis_json or None,
    )


def _publish_status_for_clip(publish: YouTubePublish | None) -> str:
    if not publish:
        return "draft"
    status = str(publish.status or "").lower()
    if status in {"published", "scheduled", "uploading", "pending", "failed"}:
        return status
    return "draft"


def _latest_publish_by_clip(publishes: list[YouTubePublish]) -> dict[str, YouTubePublish]:
    latest: dict[str, YouTubePublish] = {}
    for publish in sorted(publishes, key=lambda item: item.updated_at, reverse=True):
        latest.setdefault(publish.clip_id, publish)
    return latest


def _studio_schedule_item(publish: YouTubePublish, clip: Clip | None) -> StudioScheduleItem:
    metadata = publish.metadata_json if isinstance(publish.metadata_json, dict) else {}
    return StudioScheduleItem(
        publish_id=publish.id,
        clip_id=publish.clip_id,
        job_id=publish.job_id,
        title=publish.title,
        status=publish.status,
        privacy_status=publish.privacy_status,
        schedule_date=publish.schedule_date,
        youtube_url=publish.youtube_url,
        channel_title=metadata.get("youtube_channel_title"),
        thumbnail_url=clip.thumbnail_url if clip else None,
        score=clip.score if clip else None,
        created_at=publish.created_at,
        updated_at=publish.updated_at,
    )


def _revision_media_url(settings, path: Path, revision: int) -> str:
    url = media_url(settings, path)
    separator = "&" if "?" in url else "?"
    return f"{url}{separator}v={revision}"


def _clip_paths(settings, clip: Clip) -> tuple[Path, Path]:
    dirs = ensure_job_dirs(settings, clip.job_id)
    return dirs["clips"] / f"short_{clip.rank:03d}.mp4", dirs["thumbnails"] / f"short_{clip.rank:03d}.jpg"


def _asset_path(settings, job_id: str, asset_id: str | None) -> Path | None:
    if not asset_id:
        return None
    if Path(asset_id).name != asset_id:
        raise HTTPException(status_code=400, detail="Invalid asset id.")
    path = ensure_job_dirs(settings, job_id)["assets"] / asset_id
    if not path.exists():
        raise HTTPException(status_code=404, detail="Asset not found.")
    return path


def _data_url_to_asset(settings, job_id: str, value: str, index: int) -> Path | None:
    if not value.startswith("data:image/"):
        return None
    try:
        header, encoded = value.split(",", 1)
    except ValueError:
        return None
    mime = header.split(";", 1)[0].removeprefix("data:").lower()
    suffix = { "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/webp": ".webp" }.get(mime)
    if not suffix:
        return None
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        return None
    if not data or len(data) > 10 * 1024 * 1024:
        return None
    path = ensure_job_dirs(settings, job_id)["assets"] / f"editor_overlay_{index:02d}_{uuid4().hex}{suffix}"
    path.write_bytes(data)
    return path


def _prepare_burn_overlays(settings, job_id: str, overlays: list[dict] | None) -> list[dict]:
    prepared: list[dict] = []
    if not isinstance(overlays, list):
        return prepared
    for index, item in enumerate(overlays[:24]):
        if not isinstance(item, dict):
            continue
        kind = str(item.get("kind") or "").lower()
        next_item = dict(item)
        if kind == "image":
            src = str(next_item.pop("src", "") or "")
            asset_path = _data_url_to_asset(settings, job_id, src, index)
            if asset_path:
                next_item["path"] = str(asset_path)
            elif src.startswith("/media/") or "/media/" in src:
                try:
                    from app.services.storage import media_path_from_url

                    next_item["path"] = str(media_path_from_url(settings, src))
                except Exception:
                    continue
            elif not next_item.get("path"):
                continue
        prepared.append(next_item)
    return prepared


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
            "boundary_refine_enabled": settings.boundary_refine_enabled,
            "boundary_max_seconds": settings.boundary_max_seconds,
            "render_vertical_shorts": settings.render_vertical_shorts,
            "shorts_reframe_mode": settings.shorts_reframe_mode,
            "shorts_blur_background_strength": settings.shorts_blur_background_strength,
            "shorts_title_overlay": settings.shorts_title_overlay,
            "shorts_subtitles_enabled": settings.shorts_subtitles_enabled,
            "shorts_style_preset_default": normalize_style_preset(settings.shorts_style_preset_default),
            "shorts_style_presets": list(available_style_presets()),
            "shorts_subtitle_mode_default": normalize_subtitle_mode(settings.shorts_subtitle_mode_default),
            "shorts_subtitle_font_name": settings.shorts_subtitle_font_name,
            "shorts_subtitle_highlight_enabled": settings.shorts_subtitle_highlight_enabled,
            "shorts_subtitle_highlight_color": settings.shorts_subtitle_highlight_color,
            "burned_in_caption_detection_enabled": settings.burned_in_caption_detection_enabled,
            "burned_in_caption_detection_confidence_threshold": settings.burned_in_caption_detection_confidence_threshold,
            "shorts_video_fade_seconds": settings.shorts_video_fade_seconds,
            "shorts_audio_fade_seconds": settings.shorts_audio_fade_seconds,
            "shorts_size": f"{settings.shorts_width}x{settings.shorts_height}",
        },
    )


@router.get("/studio/summary", response_model=StudioSummaryResponse)
def studio_summary(db: Session = Depends(get_db)):
    settings = get_settings()
    jobs = db.query(Job).order_by(Job.updated_at.desc(), Job.created_at.desc()).limit(24).all()
    job_ids = [job.id for job in jobs]
    clips = (
        db.query(Clip)
        .filter(Clip.job_id.in_(job_ids))
        .order_by(Clip.job_id.asc(), Clip.rank.asc())
        .all()
        if job_ids
        else []
    )
    publishes = (
        db.query(YouTubePublish)
        .filter(YouTubePublish.job_id.in_(job_ids))
        .order_by(YouTubePublish.updated_at.desc(), YouTubePublish.created_at.desc())
        .all()
        if job_ids
        else []
    )
    clips_by_job: dict[str, list[Clip]] = {}
    clips_by_id: dict[str, Clip] = {}
    for clip in clips:
        clips_by_job.setdefault(clip.job_id, []).append(clip)
        clips_by_id[clip.id] = clip
    latest_publish = _latest_publish_by_clip(publishes)

    projects: list[StudioProject] = []
    for job in jobs:
        job_clips = clips_by_job.get(job.id, [])
        metadata = job.metadata_json if isinstance(job.metadata_json, dict) else {}
        source_url = metadata.get("source_url")
        original_video_url = None
        if job.input_path:
            try:
                input_path = Path(job.input_path)
                if input_path.exists():
                    original_video_url = media_url(settings, input_path)
            except (ValueError, OSError):
                original_video_url = None
        project_clips = []
        for clip in job_clips[:8]:
            publish = latest_publish.get(clip.id)
            project_clips.append(
                StudioProjectClip(
                    clip_id=clip.id,
                    rank=clip.rank,
                    title=clip.title,
                    score=clip.score,
                    thumbnail_url=clip.thumbnail_url,
                    video_url=clip.video_url,
                    status=_publish_status_for_clip(publish),
                    publish_id=publish.id if publish else None,
                    youtube_url=publish.youtube_url if publish else None,
                    schedule_date=publish.schedule_date if publish else None,
                    updated_at=publish.updated_at if publish else clip.created_at,
                )
            )
        projects.append(
            StudioProject(
                job_id=job.id,
                title=job.original_filename,
                status=job.status,
                original_filename=job.original_filename,
                duration=job.duration,
                progress=job.progress,
                clip_count=len(job_clips),
                top_score=max((clip.score for clip in job_clips), default=None),
                source=str(metadata.get("source") or "upload"),
                source_url=source_url if isinstance(source_url, str) else None,
                original_video_url=original_video_url,
                subtitle_mode=str(metadata.get("shorts_subtitle_mode") or metadata.get("subtitle_mode") or "auto"),
                style_preset=str(metadata.get("shorts_style_preset") or metadata.get("style_preset") or "korean_pop"),
                created_at=job.created_at,
                updated_at=job.updated_at,
                clips=project_clips,
            )
        )

    schedule = [_studio_schedule_item(publish, clips_by_id.get(publish.clip_id)) for publish in publishes[:60]]
    return StudioSummaryResponse(
        project_count=len(projects),
        clip_count=len(clips),
        scheduled_count=sum(1 for publish in publishes if publish.status == "scheduled"),
        published_count=sum(1 for publish in publishes if publish.status == "published"),
        projects=projects,
        schedule=schedule,
    )


@router.post("/videos/inspect", response_model=VideoInspectionResponse)
async def inspect_video(file: UploadFile = File(...)):
    settings = get_settings()
    suffix = Path(file.filename or "").suffix.lower()
    if suffix != ".mp4":
        raise HTTPException(status_code=400, detail="Only .mp4 uploads are supported in the MVP.")

    temp_root = settings.storage_dir / "inspections"
    temp_root.mkdir(parents=True, exist_ok=True)
    written = 0
    with TemporaryDirectory(prefix="video_", dir=temp_root) as temp_dir:
        input_path = Path(temp_dir) / "source.mp4"
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

        try:
            duration_seconds = round(probe_duration(input_path, settings), 2)
            has_subtitle_stream = probe_has_subtitle_stream(input_path, settings)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Video inspection failed: {str(exc)[:200]}") from exc

    return VideoInspectionResponse(
        filename=file.filename or "video.mp4",
        size_bytes=written,
        duration_seconds=duration_seconds,
        has_subtitle_stream=has_subtitle_stream,
    )


@router.post("/upload", response_model=UploadResponse, status_code=status.HTTP_202_ACCEPTED)
async def upload_video(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    subtitle_mode: str = Form("auto"),
    style_preset: str = Form(""),
    db: Session = Depends(get_db),
):
    settings = get_settings()
    subtitle_mode = normalize_subtitle_mode(subtitle_mode, settings.shorts_subtitle_mode_default)
    style_preset = normalize_style_preset(style_preset, settings.shorts_style_preset_default)
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
        metadata_json={"subtitle_mode": subtitle_mode, "style_preset": style_preset},
    )
    db.add(job)
    db.commit()

    queue.enqueue(background_tasks, process_job, job_id)
    return UploadResponse(job_id=job_id)


@router.post("/jobs/from-youtube", response_model=UploadResponse, status_code=status.HTTP_202_ACCEPTED)
def import_from_youtube(
    request: YouTubeImportRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    settings = get_settings()
    url = (request.url or "").strip()
    if not re.match(r"^https?://", url, re.IGNORECASE):
        raise HTTPException(
            status_code=400,
            detail="올바른 링크를 입력해 주세요. http(s)로 시작하는 YouTube 주소가 필요합니다.",
        )
    subtitle_mode = normalize_subtitle_mode(request.subtitle_mode, settings.shorts_subtitle_mode_default)
    style_preset = normalize_style_preset(request.style_preset, settings.shorts_style_preset_default)

    job_id = safe_job_id()
    dirs = ensure_job_dirs(settings, job_id)
    input_path = dirs["upload"] / "source.mp4"

    job = Job(
        id=job_id,
        status=JobStatus.pending,
        original_filename="youtube-video",
        input_path=str(input_path),
        progress=0,
        metadata_json={
            "subtitle_mode": subtitle_mode,
            "style_preset": style_preset,
            "source": "youtube",
            "source_url": url,
        },
    )
    db.add(job)
    db.commit()

    queue.enqueue(background_tasks, import_and_process, job_id)
    return UploadResponse(job_id=job_id)


@router.get("/render-templates", response_model=list[RenderTemplate])
def get_templates():
    return list_render_templates()


@router.post("/jobs/{job_id}/assets", response_model=AssetUploadResponse)
async def upload_asset(
    job_id: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in {".png", ".jpg", ".jpeg"}:
        raise HTTPException(status_code=400, detail="Only PNG, JPG, and JPEG overlay assets are supported.")

    settings = get_settings()
    dirs = ensure_job_dirs(settings, job_id)
    asset_id = f"{uuid4().hex}{suffix}"
    output_path = dirs["assets"] / asset_id
    max_bytes = 10 * 1024 * 1024
    written = 0
    with output_path.open("wb") as output:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            written += len(chunk)
            if written > max_bytes:
                output_path.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail="Overlay asset exceeds 10 MB limit.")
            output.write(chunk)

    return AssetUploadResponse(
        asset_id=asset_id,
        asset_url=media_url(settings, output_path),
        filename=file.filename or asset_id,
        content_type=file.content_type,
    )


@router.post("/clips/{clip_id}/titles/regenerate", response_model=TitleOptionsResponse)
def regenerate_titles(clip_id: str, db: Session = Depends(get_db)):
    clip = db.get(Clip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found.")
    settings = get_settings()
    options = generate_title_options(clip, settings)
    evaluation = dict(clip.evaluation_json or {})
    evaluation["title_options"] = options
    clip.evaluation_json = evaluation
    db.add(clip)
    db.commit()
    return TitleOptionsResponse(clip_id=clip.id, options=options)


@router.post("/clips/{clip_id}/thumbnails/regenerate", response_model=ThumbnailTextOptionsResponse)
def regenerate_thumbnail_texts(clip_id: str, db: Session = Depends(get_db)):
    clip = db.get(Clip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found.")
    settings = get_settings()
    options = generate_thumbnail_text_options(clip, settings)
    evaluation = dict(clip.evaluation_json or {})
    evaluation["thumbnail_text_options"] = options
    clip.evaluation_json = evaluation
    db.add(clip)
    db.commit()
    return ThumbnailTextOptionsResponse(clip_id=clip.id, options=options)


@router.post("/clips/{clip_id}/ppl", response_model=PplAnalysisResponse)
def analyze_ppl(clip_id: str, db: Session = Depends(get_db)):
    if not db.get(Clip, clip_id):
        raise HTTPException(status_code=404, detail="Clip not found.")
    try:
        analysis = analyze_clip_ppl(clip_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 — surface Gemini/render errors to the client
        raise HTTPException(status_code=502, detail=f"PPL analysis failed: {exc}") from exc
    return PplAnalysisResponse(clip_id=clip_id, analysis=analysis)


@router.patch("/clips/{clip_id}/ppl/links", response_model=PplAnalysisResponse)
def patch_ppl_links(clip_id: str, request: PplLinksRequest, db: Session = Depends(get_db)):
    if not db.get(Clip, clip_id):
        raise HTTPException(status_code=404, detail="Clip not found.")
    analysis = update_ppl_affiliate_links(clip_id, request.links)
    return PplAnalysisResponse(clip_id=clip_id, analysis=analysis)


@router.post("/clips/{clip_id}/retrim", response_model=ClipResponse)
def retrim_clip(clip_id: str, request: RetrimRequest, db: Session = Depends(get_db)):
    clip = db.get(Clip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found.")
    job = db.get(Job, clip.job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")

    start = round(max(0.0, float(request.start_seconds)), 3)
    end = round(float(request.end_seconds), 3)
    if end <= start:
        raise HTTPException(status_code=400, detail="end_seconds must be greater than start_seconds.")
    if job.duration:
        end = min(end, round(float(job.duration), 3))
    if end - start < 1.0:
        raise HTTPException(status_code=400, detail="Clip must be at least 1 second long.")
    if end - start > 180.0:
        raise HTTPException(status_code=400, detail="Clip must be 180 seconds or shorter.")

    settings = get_settings()
    evaluation = dict(clip.evaluation_json or {})
    creative_settings = evaluation.get("creative_settings") if isinstance(evaluation.get("creative_settings"), dict) else None
    asset_id = (creative_settings or {}).get("asset_id")
    asset_path = _asset_path(settings, clip.job_id, asset_id) if asset_id else None
    clip_path, thumb_path = _clip_paths(settings, clip)
    revision = int(evaluation.get("render_revision") or 0) + 1

    render_title_text = (clip.thumbnail_text or clip.title or "").strip()
    dirs = ensure_job_dirs(settings, clip.job_id)
    transcript = _read_json(dirs["transcripts"] / "transcript.json", {})
    subtitle_plan = subtitle_render_plan(Path(job.input_path), settings, dict(job.metadata_json or {}))
    subtitle_path = None
    if subtitle_plan["render"]:
        subtitle_path = build_ass_subtitles(
            transcript,
            start,
            end,
            settings,
            dirs["clips"] / f"short_{clip.rank:03d}.ass",
            hook_terms=[str(term) for term in evaluation.get("hook_terms", [])],
            style_preset=subtitle_plan["style_preset"],
        )

    best_frame_time = clip.best_frame_time
    if best_frame_time is None or best_frame_time < start or best_frame_time > end:
        best_frame_time = start + max(0.1, end - start) / 2
    try:
        cut_clip(
            Path(job.input_path),
            clip_path,
            start,
            end,
            settings,
            title_text=render_title_text,
            creative_settings=creative_settings,
            overlay_asset_path=asset_path,
            subtitle_path=subtitle_path,
        )
        extract_thumbnail(
            Path(job.input_path),
            thumb_path,
            best_frame_time,
            settings,
            title_text=render_title_text,
            creative_settings=creative_settings,
            overlay_asset_path=asset_path,
        )
    except Exception as exc:
        evaluation["edit_status"] = "failed"
        evaluation["edit_error"] = str(exc)[:300]
        clip.evaluation_json = evaluation
        db.add(clip)
        db.commit()
        raise HTTPException(status_code=500, detail=f"Re-cut failed: {str(exc)[:300]}") from exc

    clip.start_time = start
    clip.end_time = end
    clip.best_frame_time = best_frame_time
    evaluation["render_revision"] = revision
    evaluation["shorts_subtitles_rendered"] = bool(subtitle_path)
    evaluation["edit_status"] = "rendered"
    evaluation.pop("edit_error", None)
    clip.video_url = _revision_media_url(settings, clip_path, revision)
    clip.thumbnail_url = _revision_media_url(settings, thumb_path, revision)
    clip.evaluation_json = evaluation
    db.add(clip)
    db.commit()
    db.refresh(clip)
    return _clip_response(clip)


@router.post("/clips/{clip_id}/creative/apply", response_model=ClipResponse)
def apply_creative(clip_id: str, request: CreativeApplyRequest, db: Session = Depends(get_db)):
    clip = db.get(Clip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found.")
    job = db.get(Job, clip.job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    if request.overlay_position not in ALLOWED_OVERLAY_POSITIONS:
        raise HTTPException(status_code=400, detail="Unsupported overlay position.")

    settings = get_settings()
    template = get_render_template(request.template_id)
    asset_path = _asset_path(settings, clip.job_id, request.asset_id)
    clip_path, thumb_path = _clip_paths(settings, clip)
    evaluation = dict(clip.evaluation_json or {})
    revision = int(evaluation.get("render_revision") or 0) + 1
    metadata_overrides = request.metadata_overrides or {}
    editor_state = request.editor_state
    if editor_state is None and isinstance(metadata_overrides.get("editor_state"), dict):
        editor_state = metadata_overrides.get("editor_state")
    burn_overlays = request.burn_overlays
    if burn_overlays is None and isinstance(metadata_overrides.get("burn_overlays"), list):
        burn_overlays = metadata_overrides.get("burn_overlays")
    prepared_overlays = _prepare_burn_overlays(settings, clip.job_id, burn_overlays)
    creative_settings = {
        **template,
        "title": request.title,
        "thumbnail_text": request.thumbnail_text,
        "template_id": request.template_id,
        "asset_id": request.asset_id,
        "overlay_position": request.overlay_position,
        "overlay_scale": max(0.04, min(0.4, float(request.overlay_scale))),
        "overlay_opacity": 0.92,
        "editor_state": editor_state or {},
        "burn_overlays": prepared_overlays,
        "metadata_overrides": metadata_overrides,
    }
    if asset_path:
        creative_settings["badge_text"] = ""
        creative_settings["asset_url"] = media_url(settings, asset_path)

    title_text = request.title.strip()
    thumbnail_text = request.thumbnail_text.strip()
    render_title_text = thumbnail_text or title_text
    dirs = ensure_job_dirs(settings, clip.job_id)
    transcript = _read_json(dirs["transcripts"] / "transcript.json", {})
    subtitle_plan = subtitle_render_plan(Path(job.input_path), settings, dict(job.metadata_json or {}))
    subtitle_path = None
    if subtitle_plan["render"]:
        subtitle_path = build_ass_subtitles(
            transcript,
            clip.start_time,
            clip.end_time,
            settings,
            dirs["clips"] / f"short_{clip.rank:03d}.ass",
            hook_terms=[str(term) for term in evaluation.get("hook_terms", [])],
            style_preset=subtitle_plan["style_preset"],
            highlight_color_override=(editor_state or {}).get("hl"),
        )
    cut_clip(
        Path(job.input_path),
        clip_path,
        clip.start_time,
        clip.end_time,
        settings,
        title_text=render_title_text,
        creative_settings=creative_settings,
        overlay_asset_path=asset_path,
        subtitle_path=subtitle_path,
    )
    best_frame_time = clip.best_frame_time or (clip.start_time + max(0.1, clip.end_time - clip.start_time) / 2)
    if best_frame_time < clip.start_time or best_frame_time > clip.end_time:
        best_frame_time = clip.start_time + max(0.1, clip.end_time - clip.start_time) / 2
    extract_thumbnail(
        Path(job.input_path),
        thumb_path,
        best_frame_time,
        settings,
        title_text=render_title_text,
        creative_settings=creative_settings,
        overlay_asset_path=asset_path,
    )

    evaluation["creative_settings"] = creative_settings
    evaluation["render_revision"] = revision
    evaluation["shorts_style_preset"] = subtitle_plan["style_preset"]
    evaluation["shorts_subtitle_mode"] = subtitle_plan["mode"]
    evaluation["shorts_subtitles_rendered"] = bool(subtitle_path)
    evaluation["source_has_subtitle_stream"] = subtitle_plan["source_has_subtitle_stream"]
    if metadata_overrides:
        evaluation["metadata_overrides"] = metadata_overrides
    if editor_state:
        evaluation["editor_state"] = editor_state
    clip.title = title_text[:180]
    clip.thumbnail_text = thumbnail_text[:120]
    clip.video_url = _revision_media_url(settings, clip_path, revision)
    clip.thumbnail_url = _revision_media_url(settings, thumb_path, revision)
    clip.evaluation_json = evaluation
    db.add(clip)
    db.commit()
    db.refresh(clip)
    return _clip_response(clip)


@router.post(
    "/jobs/{job_id}/highlights/render",
    response_model=HighlightRenderResponse,
    response_model_by_alias=False,
)
def render_highlight(job_id: str, request: HighlightRenderRequest, db: Session = Depends(get_db)):
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    source_path = Path(job.input_path)
    if not source_path.exists():
        raise HTTPException(status_code=404, detail="Source video not found.")

    requested_ids = [str(clip_id) for clip_id in request.clip_ids[:24]]
    query = db.query(Clip).filter(Clip.job_id == job.id)
    if requested_ids:
        clips = query.filter(Clip.id.in_(requested_ids)).all()
        by_id = {clip.id: clip for clip in clips}
        ordered = [by_id[clip_id] for clip_id in requested_ids if clip_id in by_id]
    else:
        ordered = query.order_by(Clip.rank.asc()).limit(8).all()
    if not ordered:
        raise HTTPException(status_code=400, detail="No clips selected for highlight.")

    max_duration = max(15.0, min(1800.0, float(request.max_duration_seconds or 720)))
    segments: list[dict[str, float]] = []
    total = 0.0
    for clip in ordered:
        start = max(0.0, float(clip.start_time))
        end = max(start + 0.1, float(clip.end_time))
        duration = end - start
        if total + duration > max_duration:
            remaining = max_duration - total
            if remaining < 3.0:
                break
            end = start + remaining
            duration = remaining
        segments.append({"start": start, "end": end})
        total += duration
        if total >= max_duration:
            break
    if not segments:
        raise HTTPException(status_code=400, detail="Selected clips are too short for highlight rendering.")

    settings = get_settings()
    aspect = str(request.aspect or "landscape").strip().lower()
    if aspect not in {"landscape", "vertical", "square"}:
        aspect = "landscape"
    title = " ".join(str(request.title or "").split())[:120] or f"{job.original_filename} 하이라이트"
    output_path = ensure_job_dirs(settings, job.id)["highlights"] / f"highlight_{uuid4().hex[:10]}.mp4"
    try:
        render_highlight_segments(source_path, output_path, segments, settings, title_text=title, aspect=aspect)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Highlight render failed: {str(exc)[:300]}") from exc

    result = {
        "id": output_path.stem,
        "title": title,
        "video_url": media_url(settings, output_path),
        "duration_seconds": round(total, 2),
        "clip_count": len(segments),
        "aspect": aspect,
        "clip_ids": [clip.id for clip in ordered[: len(segments)]],
    }
    metadata = dict(job.metadata_json or {})
    history = metadata.get("highlights")
    if not isinstance(history, list):
        history = []
    history.append(result)
    metadata["highlights"] = history[-20:]
    job.metadata_json = metadata
    db.add(job)
    db.commit()
    return HighlightRenderResponse(
        job_id=job.id,
        title=title,
        video_url=result["video_url"],
        duration_seconds=result["duration_seconds"],
        clip_count=result["clip_count"],
        aspect=aspect,
    )


@router.get("/clips/{clip_id}/youtube-package")
def download_youtube_package(clip_id: str, db: Session = Depends(get_db)):
    clip = db.get(Clip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found.")
    settings = get_settings()
    try:
        zip_path = build_youtube_package(settings, clip)
    except FileNotFoundError as exc:
        missing = exc.filename or (exc.args[0] if exc.args else "unknown")
        raise HTTPException(status_code=404, detail=f"Package source file not found: {Path(missing).name}") from exc
    return FileResponse(
        zip_path,
        media_type="application/zip",
        filename=f"{clip.job_id}_clip_{clip.rank:03d}_youtube_package.zip",
    )


@router.get("/clips/{clip_id}/download")
def download_clip_video(clip_id: str, db: Session = Depends(get_db)):
    """Stream the clip's rendered MP4 with a Content-Disposition: attachment header
    so the browser downloads it instead of playing it inline (the bare /media URL
    is served inline, and the <a download> attribute is ignored cross-origin)."""
    clip = db.get(Clip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found.")
    settings = get_settings()
    video_path = media_path_from_url(settings, clip.video_url)
    if not video_path.exists():
        raise HTTPException(status_code=404, detail="Clip video file not found.")
    filename = f"{clip.job_id}_clip_{clip.rank:03d}.mp4"
    return FileResponse(video_path, media_type="video/mp4", filename=filename)


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


@router.delete("/jobs/{job_id}", status_code=204)
def delete_job(job_id: str, db: Session = Depends(get_db)):
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    settings = get_settings()
    db.query(YouTubePublish).filter(YouTubePublish.job_id == job_id).delete()
    db.delete(job)
    db.commit()
    for subdir in ("uploads", "jobs"):
        p = settings.storage_dir / subdir / job_id
        if p.exists():
            shutil.rmtree(p, ignore_errors=True)


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
                "original_start_time": format_time(float(candidate.get("original_start") or candidate.get("start") or 0.0)),
                "original_end_time": format_time(float(candidate.get("original_end") or candidate.get("end") or 0.0)),
                "original_start_seconds": candidate.get("original_start"),
                "original_end_seconds": candidate.get("original_end"),
                "refined_start_seconds": candidate.get("refined_start", candidate.get("start")),
                "refined_end_seconds": candidate.get("refined_end", candidate.get("end")),
                "boundary_reason": candidate.get("boundary_reason") or "",
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
