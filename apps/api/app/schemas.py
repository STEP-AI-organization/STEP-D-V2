from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

from app.models import JobStatus


class UploadResponse(BaseModel):
    job_id: str


class VideoInspectionResponse(BaseModel):
    filename: str
    size_bytes: int
    duration_seconds: Optional[float] = None
    has_subtitle_stream: bool


class YouTubeImportRequest(BaseModel):
    url: str
    subtitle_mode: str = "auto"
    style_preset: str = ""


class AssetUploadResponse(BaseModel):
    asset_id: str
    asset_url: str
    filename: str
    content_type: Optional[str] = None


class TitleOption(BaseModel):
    id: str
    title: str
    overlay_text: str
    style: str
    reason: str


class TitleOptionsResponse(BaseModel):
    clip_id: str
    options: List[TitleOption]


class ThumbnailTextOption(BaseModel):
    id: str
    text: str
    style: str = ""
    reason: str = ""


class ThumbnailTextOptionsResponse(BaseModel):
    clip_id: str
    options: List[ThumbnailTextOption]


class RetrimRequest(BaseModel):
    start_seconds: float
    end_seconds: float


class RenderTemplate(BaseModel):
    id: str
    label: str
    platform: str
    kind: str
    badge_text: str
    position: str
    scale: float


class CreativeApplyRequest(BaseModel):
    title: str
    thumbnail_text: str
    template_id: str = "clean"
    asset_id: Optional[str] = None
    overlay_position: str = "top_right"
    overlay_scale: float = 0.12
    editor_state: Optional[Dict[str, Any]] = None
    burn_overlays: Optional[List[Dict[str, Any]]] = None
    metadata_overrides: Optional[Dict[str, Any]] = None


class HighlightRenderRequest(BaseModel):
    clip_ids: List[str] = Field(default_factory=list)
    title: str = "하이라이트"
    aspect: str = "landscape"
    max_duration_seconds: int = 720


class HighlightRenderResponse(BaseModel):
    job_id: str
    title: str
    video_url: str
    duration_seconds: float
    clip_count: int
    aspect: str


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
    job_id: str = ""
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
    source_thumbnail_url: Optional[str] = None
    thumbnail_text: Optional[str] = None
    thumbnail_description: Optional[str] = None
    best_frame_time: Optional[float] = None
    transcript: str
    youtube_metadata: Dict[str, Any]
    title_options: List[TitleOption] = Field(default_factory=list)
    thumbnail_text_options: List[Dict[str, Any]] = Field(default_factory=list)
    edit_status: Optional[str] = None
    creative_settings: Dict[str, Any] = Field(default_factory=dict)
    render_revision: int = 0
    youtube_package_url: Optional[str] = None
    korean_shorts_signals: Dict[str, Any] = Field(default_factory=dict)
    clip_briefing: Dict[str, Any] = Field(default_factory=dict)
    ppl_analysis: Optional[Dict[str, Any]] = None

    model_config = {"populate_by_name": True}


class PplAnalysisResponse(BaseModel):
    clip_id: str
    analysis: Optional[Dict[str, Any]] = None


class PplLinksRequest(BaseModel):
    links: Dict[str, str] = Field(default_factory=dict)


class ResultsResponse(BaseModel):
    job_id: Optional[str] = None
    status: Optional[JobStatus] = None
    clips: List[ClipResponse]


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


class StudioProjectClip(BaseModel):
    clip_id: str
    rank: int
    title: str
    score: int
    thumbnail_url: str
    video_url: str
    status: str
    publish_id: Optional[str] = None
    youtube_url: Optional[str] = None
    schedule_date: Optional[str] = None
    updated_at: Optional[datetime] = None


class StudioProject(BaseModel):
    job_id: str
    title: str
    status: JobStatus
    original_filename: str
    duration: Optional[float] = None
    progress: int
    clip_count: int
    top_score: Optional[int] = None
    source: str = "upload"
    source_url: Optional[str] = None
    original_video_url: Optional[str] = None
    subtitle_mode: str = "auto"
    style_preset: str = "korean_pop"
    created_at: datetime
    updated_at: datetime
    clips: List[StudioProjectClip] = Field(default_factory=list)


class StudioScheduleItem(BaseModel):
    publish_id: str
    clip_id: str
    job_id: str
    title: str
    status: str
    privacy_status: str
    schedule_date: Optional[str] = None
    youtube_url: Optional[str] = None
    channel_title: Optional[str] = None
    thumbnail_url: Optional[str] = None
    score: Optional[int] = None
    created_at: datetime
    updated_at: datetime


class StudioSummaryResponse(BaseModel):
    project_count: int
    clip_count: int
    scheduled_count: int
    published_count: int
    projects: List[StudioProject]
    schedule: List[StudioScheduleItem]


class YouTubeChannelResponse(BaseModel):
    id: str
    channel_id: str
    title: str
    description: Optional[str] = None
    thumbnail_url: Optional[str] = None
    style_note: Optional[str] = None
    google_account_email: Optional[str] = None
    is_default: bool = False
    connected_at: Optional[datetime] = None


class ChannelStyleNoteRequest(BaseModel):
    style_note: str = ""


class YouTubeChannelCandidate(BaseModel):
    channel_id: str
    title: str
    thumbnail_url: Optional[str] = None
    description: Optional[str] = None
    already_connected: bool = False


class YouTubeChannelDraftResponse(BaseModel):
    id: str
    google_account_email: Optional[str] = None
    google_account_name: Optional[str] = None
    google_account_picture_url: Optional[str] = None
    expires_at: datetime
    channels: List[YouTubeChannelCandidate] = Field(default_factory=list)


class YouTubeChannelDraftConfirmRequest(BaseModel):
    channel_id: str


class YouTubeChannelDraftConfirmManyRequest(BaseModel):
    channel_ids: List[str]


class YouTubeStatusResponse(BaseModel):
    configured: bool
    oauth_ready: bool
    env_fallback_ready: bool
    authenticated: bool = False
    default_privacy_status: str
    channels: List[YouTubeChannelResponse] = Field(default_factory=list)


class YouTubePublishRequest(BaseModel):
    channel_db_id: Optional[str] = None
    privacy_status: Optional[str] = None
    schedule_date: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    tags: Optional[List[str]] = None


class ReschedulePublishRequest(BaseModel):
    schedule_date: Optional[str] = None


class AutoDistributeRequest(BaseModel):
    clip_ids: List[str]
    channel_db_id: str
    start_date: str
    times: List[str] = Field(default_factory=list)
    privacy_status: Optional[str] = None


class AutoDistributeItem(BaseModel):
    clip_id: str
    publish_id: str
    schedule_date: str


class AutoDistributeResponse(BaseModel):
    items: List[AutoDistributeItem] = Field(default_factory=list)


class YouTubePublishResponse(BaseModel):
    id: str
    clip_id: str
    status: str
    title: str
    privacy_status: str
    schedule_date: Optional[str] = None
    youtube_video_id: Optional[str] = None
    youtube_url: Optional[str] = None
    error: Optional[str] = None
    channel_title: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class ChannelAnalyticsVideo(BaseModel):
    video_id: str
    title: str
    url: str
    thumbnail: Optional[str] = None
    published_at: Optional[str] = None
    view_count: int = 0
    like_count: int = 0
    comment_count: int = 0
    duration: Optional[str] = None
    rank: int = 0


class ChannelAnalyticsTotals(BaseModel):
    video_count: int = 0
    subscriber_count: int = 0
    hidden_subscriber_count: bool = False
    channel_view_count: int = 0
    sampled_videos: int = 0
    sampled_views: int = 0
    sampled_likes: int = 0
    sampled_comments: int = 0


class ChannelAnalyticsResponse(BaseModel):
    channel_db_id: str
    channel_title: str
    channel_thumbnail: Optional[str] = None
    sort: str = "views"
    totals: ChannelAnalyticsTotals
    videos: List[ChannelAnalyticsVideo] = Field(default_factory=list)


class ChannelInsightsVideo(BaseModel):
    video_id: str
    title: str = ""
    url: str = ""
    views: int = 0
    likes: int = 0
    comments: int = 0
    duration_seconds: int = 0
    rank: int = 0


class ChannelInsightsResponse(BaseModel):
    channel_db_id: str
    sample_size: int = 0
    has_enough: bool = False
    best_videos: List[ChannelInsightsVideo] = Field(default_factory=list)
    recommendations: List[str] = Field(default_factory=list)
    patterns: Dict[str, Any] = Field(default_factory=dict)


class VideoCommentResponse(BaseModel):
    author: str
    text: str
    likes: int = 0
    published_at: Optional[str] = None


class AuthUser(BaseModel):
    id: str
    email: Optional[str] = None
    name: Optional[str] = None
    picture_url: Optional[str] = None


class AuthMeResponse(BaseModel):
    user: Optional[AuthUser] = None


class ReportChatMessage(BaseModel):
    role: str  # "user" | "assistant"
    content: str


class ReportChatRequest(BaseModel):
    messages: List[ReportChatMessage] = Field(default_factory=list)
    context: Dict[str, Any] = Field(default_factory=dict)


class ReportChatResponse(BaseModel):
    answer: str
