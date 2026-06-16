from functools import lru_cache
from pathlib import Path
from typing import List

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


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
    openai_transcribe_prompt: str = (
        "Korean broadcast, variety show, interview, and talk show footage. "
        "Preserve names, places, proper nouns, exclamations, honorifics, and casual speech as spoken."
    )

    gemini_api_key: str = ""
    gemini_model: str = "gemini-3.5-flash"
    gemini_timeout_seconds: int = 90
    gemini_max_eval_candidates: int = 12

    max_upload_mb: int = 2048
    max_candidate_count: int = 30
    final_clip_count: int = 8
    min_clip_seconds: int = 20
    max_clip_seconds: int = 90
    target_clip_seconds: int = 45
    frame_count_per_candidate: int = 4

    ffmpeg_binary: str = "ffmpeg"
    ffprobe_binary: str = "ffprobe"
    ffmpeg_audio_filter: str = "loudnorm=I=-16:TP=-1.5:LRA=11,highpass=f=80,lowpass=f=12000"

    render_vertical_shorts: bool = True
    shorts_reframe_mode: str = "fit"
    shorts_width: int = 1080
    shorts_height: int = 1920
    shorts_background_color: str = "black"
    shorts_title_overlay: bool = True
    shorts_title_overlay_fallback: bool = False
    shorts_title_font_file: str = ""
    shorts_title_font_size: int = 72
    shorts_title_y_ratio: float = 0.105
    shorts_title_line_spacing: int = 18
    shorts_title_box: bool = False
    shorts_title_box_border: int = 22
    shorts_title_primary_color: str = "white"
    shorts_title_accent_color: str = "0xFFE600"
    shorts_title_outline_color: str = "black"
    shorts_title_outline_width: int = 5
    shorts_title_max_chars_per_line: int = 14
    shorts_title_max_lines: int = 2

    youtube_client_id: str = ""
    youtube_client_secret: str = ""
    youtube_refresh_token: str = ""
    youtube_category_id: str = "24"
    youtube_default_privacy_status: str = "private"
    youtube_upload_timeout_seconds: int = 3600
    youtube_oauth_redirect_uri: str = "http://127.0.0.1:8010/api/youtube/oauth/callback"
    web_base_url: str = "http://127.0.0.1:3000"

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
