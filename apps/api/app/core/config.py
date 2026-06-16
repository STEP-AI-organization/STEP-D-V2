from functools import lru_cache
from pathlib import Path
from typing import List

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.prompts.transcription import TRANSCRIPTION_PROMPT


API_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = Path(__file__).resolve().parents[4]


class Settings(BaseSettings):
    app_name: str = "Viral Shorts MVP"
    environment: str = "local"
    database_url: str = "sqlite:///./storage/app.db"
    storage_dir: Path = Path("./storage")
    public_base_url: str = ""

    openai_api_key: str = ""
    openai_transcribe_model: str = "whisper-1"
    openai_transcribe_language: str = "ko"
    openai_transcribe_prompt: str = TRANSCRIPTION_PROMPT

    gemini_api_key: str = ""
    gemini_model: str = "gemini-3.5-flash"
    gemini_timeout_seconds: int = 90
    gemini_max_eval_candidates: int = 12

    max_upload_mb: int = 2048
    youtube_max_source_seconds: int = 3600
    max_candidate_count: int = 30
    final_clip_count: int = 8
    min_clip_seconds: int = 20
    max_clip_seconds: int = 90
    target_clip_seconds: int = 45
    frame_count_per_candidate: int = 4
    boundary_refine_enabled: bool = True
    boundary_max_seconds: int = 70
    boundary_start_lookback_seconds: float = 6.0
    boundary_end_lookahead_seconds: float = 8.0
    boundary_pre_padding_seconds: float = 0.4
    boundary_post_padding_seconds: float = 0.8

    ffmpeg_binary: str = "ffmpeg"
    ffprobe_binary: str = "ffprobe"
    ffmpeg_audio_filter: str = "loudnorm=I=-16:TP=-1.5:LRA=11,highpass=f=80,lowpass=f=12000"

    render_vertical_shorts: bool = True
    shorts_reframe_mode: str = "blur"
    shorts_width: int = 1080
    shorts_height: int = 1920
    shorts_background_color: str = "black"
    shorts_blur_background_strength: int = 24
    shorts_title_overlay: bool = True
    shorts_title_font_file: str = ""
    shorts_title_font_size: int = 58
    shorts_title_y_ratio: float = 0.095
    shorts_title_line_spacing: int = 12
    shorts_title_box_border: int = 24
    shorts_title_max_chars_per_line: int = 18
    shorts_title_max_lines: int = 2
    shorts_video_fade_seconds: float = 0.15
    shorts_audio_fade_seconds: float = 0.12
    shorts_subtitles_enabled: bool = True
    shorts_style_preset_default: str = "korean_pop"
    shorts_subtitle_mode_default: str = "auto"
    shorts_subtitle_font_name: str = "G마켓 산스 TTF Bold"
    shorts_subtitle_fonts_dir: str = ""
    shorts_subtitle_font_size: int = 70
    shorts_subtitle_margin_v: int = 220
    shorts_subtitle_max_chars_per_line: int = 16
    shorts_subtitle_max_lines: int = 2
    shorts_subtitle_primary_color: str = "&H00FFFFFF"
    shorts_subtitle_highlight_enabled: bool = True
    shorts_subtitle_highlight_color: str = "&H0000E6FF"
    shorts_subtitle_outline: int = 5
    shorts_subtitle_shadow: int = 2
    burned_in_caption_detection_enabled: bool = True
    burned_in_caption_detection_max_frames: int = 6
    burned_in_caption_detection_confidence_threshold: float = 0.72

    # YouTube publishing / Google OAuth
    youtube_client_id: str = ""
    youtube_client_secret: str = ""
    youtube_refresh_token: str = ""
    youtube_oauth_redirect_uri: str = "http://127.0.0.1:8010/api/youtube/oauth/callback"
    web_base_url: str = "http://localhost:3000"
    youtube_default_privacy_status: str = "public"
    youtube_category_id: str = "24"
    youtube_upload_timeout_seconds: int = 600

    # App login (Google Sign-In identity, decoupled from the YouTube publish account)
    auth_oauth_redirect_uri: str = "http://127.0.0.1:8010/api/auth/google/callback"
    session_secret: str = ""
    session_cookie_name: str = "sid"
    session_ttl_days: int = 30

    cors_origins: List[str] = Field(
        default_factory=lambda: [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
        ]
    )

    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env", API_ROOT / ".env"),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.storage_dir.mkdir(parents=True, exist_ok=True)
    return settings
