from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator

from app.models import JobStatus

PrivacyStatus = Literal["private", "unlisted", "public"]


def _parse_schedule_date(value: str) -> datetime:
    raw = value.strip()
    if len(raw) == 14 and raw.isdigit():
        return datetime.strptime(raw, "%Y%m%d%H%M%S").replace(tzinfo=timezone(timedelta(hours=9)))
    return datetime.fromisoformat(raw.replace("Z", "+00:00"))


def _validate_category_id(value: Optional[str]) -> Optional[str]:
    if value is None:
        return value
    cleaned = value.strip()
    if not cleaned.isdigit():
        raise ValueError("category_id must be a numeric YouTube category id.")
    return cleaned


def _validate_schedule_date(value: Optional[str]) -> Optional[str]:
    if value is None or not value.strip():
        return None
    try:
        parsed = _parse_schedule_date(value)
    except ValueError as exc:
        raise ValueError("schedule_date must be ISO 8601 or YYYYMMDDHHMMSS.") from exc
    if parsed.tzinfo is None:
        parsed_utc = parsed.replace(tzinfo=timezone.utc)
    else:
        parsed_utc = parsed.astimezone(timezone.utc)
    if parsed_utc <= datetime.now(timezone.utc) + timedelta(minutes=15):
        raise ValueError("schedule_date must be at least 15 minutes in the future.")
    return value.strip()


class UploadResponse(BaseModel):
    job_id: str


class JobResponse(BaseModel):
    job_id: str = Field(alias="id")
    status: JobStatus
    progress: int
    error: Optional[str] = None
    duration: Optional[float] = None
    original_filename: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True, "populate_by_name": True}


class ClipResponse(BaseModel):
    clip_id: str = Field(alias="id")
    rank: int
    title: str
    score: int
    local_score: float
    gemini_score: int
    start_time: str
    end_time: str
    start_seconds: float
    end_seconds: float
    duration_seconds: float
    reason: str
    video_url: str
    thumbnail_url: str
    thumbnail_text: Optional[str] = None
    thumbnail_description: Optional[str] = None
    best_frame_time: Optional[float] = None
    transcript: str
    youtube_metadata: Dict[str, Any]
    edit_status: Optional[str] = None
    edit_error: Optional[str] = None
    editor_project: Optional[Dict[str, Any]] = None

    model_config = {"populate_by_name": True}


class VideoResponse(BaseModel):
    job_id: str
    original_filename: str
    status: JobStatus
    progress: int
    error: Optional[str] = None
    duration: Optional[float] = None
    clip_count: int
    top_score: Optional[int] = None
    thumbnail_url: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class VideosResponse(BaseModel):
    videos: List[VideoResponse]


class ResultsResponse(BaseModel):
    job_id: Optional[str] = None
    status: Optional[JobStatus] = None
    clips: List[ClipResponse]


class ClipUpdateRequest(BaseModel):
    title: Optional[str] = None
    reason: Optional[str] = None
    thumbnail_text: Optional[str] = None
    thumbnail_description: Optional[str] = None
    youtube_metadata: Optional[Dict[str, Any]] = None
    editor_project: Optional[Dict[str, Any]] = None


class ClipActionResponse(BaseModel):
    clip: ClipResponse


class YouTubeConfigResponse(BaseModel):
    configured: bool
    privacy_status: str
    category_id: str
    connected_channel_count: int = 0
    default_channel_id: Optional[str] = None
    legacy_refresh_configured: bool = False


class YouTubeChannelResponse(BaseModel):
    id: str
    channel_id: str
    title: str
    description: Optional[str] = None
    thumbnail_url: Optional[str] = None
    google_account_id: Optional[str] = None
    google_account_email: Optional[str] = None
    google_account_name: Optional[str] = None
    google_account_picture_url: Optional[str] = None
    upload_ready: bool = False
    is_default: bool = False
    created_at: datetime
    updated_at: datetime


class YouTubeChannelsResponse(BaseModel):
    channels: List[YouTubeChannelResponse]


class YouTubeOAuthStartResponse(BaseModel):
    auth_url: str


class YouTubePublishRequest(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    tags: Optional[List[str]] = None
    privacy_status: Optional[PrivacyStatus] = None
    category_id: Optional[str] = None
    schedule_date: Optional[str] = None
    youtube_channel_id: Optional[str] = None

    _category_id = field_validator("category_id")(_validate_category_id)
    _schedule_date = field_validator("schedule_date")(_validate_schedule_date)


class YouTubeAutoPublishRequest(BaseModel):
    max_clips: int = Field(default=5, ge=1, le=10)
    min_score: int = Field(default=0, ge=0, le=100)
    privacy_status: Optional[PrivacyStatus] = None
    category_id: Optional[str] = None
    schedule_date: Optional[str] = None
    youtube_channel_id: Optional[str] = None
    skip_existing: bool = True

    _category_id = field_validator("category_id")(_validate_category_id)
    _schedule_date = field_validator("schedule_date")(_validate_schedule_date)


class YouTubePublishResponse(BaseModel):
    publish_id: str
    clip_id: str
    job_id: str
    status: str
    title: str
    description: Optional[str] = None
    tags: List[str] = Field(default_factory=list)
    privacy_status: str
    category_id: str
    schedule_date: Optional[str] = None
    youtube_channel_id: Optional[str] = None
    youtube_channel_title: Optional[str] = None
    youtube_video_id: Optional[str] = None
    youtube_url: Optional[str] = None
    error: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class YouTubePublishesResponse(BaseModel):
    publishes: List[YouTubePublishResponse]


class YouTubeAutoPublishResponse(BaseModel):
    job_id: str
    requested_count: int
    queued_count: int
    skipped_count: int
    youtube_channel_id: Optional[str] = None
    youtube_channel_title: Optional[str] = None
    publishes: List[YouTubePublishResponse]


class JobDebugResponse(BaseModel):
    job_id: str
    status: JobStatus
    progress: int
    transcript_preview: str
    transcript_segment_count: int
    candidate_count: int
    candidates: List[Dict[str, Any]]
    evaluations: List[Dict[str, Any]]
    warnings: List[str]
    artifacts: Dict[str, str]


class HealthResponse(BaseModel):
    status: str
    ffmpeg_configured: bool
    storage_dir: str
    settings: Dict[str, Any]
