"""Download a single YouTube (or other yt-dlp supported) URL to a local mp4 that
the existing pipeline can read.

Two phases: (1) metadata-only extract to validate (length cap, live/premiere,
playlist) before spending bandwidth, then (2) download + merge to H.264/AAC mp4
using the same ffmpeg binary the rest of the app uses. Errors are mapped to a
small, friendly Korean taxonomy via ``YouTubeDownloadError.code``.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

import yt_dlp
from yt_dlp.utils import DownloadError, ExtractorError, UnsupportedError

from app.core.config import Settings


# Prefer H.264 mp4+m4a, then any best video+audio (ffmpeg merges to mp4 regardless).
_FORMAT = "bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio/bestvideo+bestaudio/best"

# Ordered (substring, code, friendly message); first match wins.
_ERROR_PATTERNS: list[tuple[str, str, str]] = [
    ("private video", "private", "비공개 영상이라 가져올 수 없습니다."),
    ("members-only", "members_only", "멤버십 전용 영상은 가져올 수 없습니다."),
    ("join this channel", "members_only", "멤버십 전용 영상은 가져올 수 없습니다."),
    ("sign in to confirm your age", "age_restricted", "연령 제한 영상이라 가져올 수 없습니다."),
    ("age-restricted", "age_restricted", "연령 제한 영상이라 가져올 수 없습니다."),
    ("not available in your country", "geo_blocked", "이 지역에서는 재생할 수 없는 영상입니다."),
    ("blocked it in your country", "geo_blocked", "이 지역에서는 재생할 수 없는 영상입니다."),
    ("this live event will begin", "premiere_not_started", "아직 시작되지 않은 라이브/프리미어 영상입니다."),
    ("premieres in", "premiere_not_started", "아직 시작되지 않은 라이브/프리미어 영상입니다."),
    ("is not a valid url", "invalid_url", "올바른 YouTube 주소가 아닙니다."),
    ("unsupported url", "unsupported_url", "지원하지 않는 주소입니다. YouTube 영상 링크를 입력해 주세요."),
    ("video unavailable", "unavailable", "삭제되었거나 사용할 수 없는 영상입니다."),
    ("removed", "unavailable", "삭제되었거나 사용할 수 없는 영상입니다."),
    ("copyright", "unavailable", "삭제되었거나 사용할 수 없는 영상입니다."),
    ("too many requests", "rate_limited", "YouTube에서 요청을 차단했습니다 (429). 잠시 후 다시 시도하거나 쿠키 파일을 설정하세요."),
    ("http error 429", "rate_limited", "YouTube에서 요청을 차단했습니다 (429). 잠시 후 다시 시도하거나 쿠키 파일을 설정하세요."),
    ("sign in to confirm", "bot_challenge", "YouTube 봇 차단에 걸렸습니다. YTDLP_COOKIES_FILE 설정이 필요합니다."),
    ("please sign in", "bot_challenge", "YouTube 봇 차단에 걸렸습니다. YTDLP_COOKIES_FILE 설정이 필요합니다."),
    ("confirm you're not a bot", "bot_challenge", "YouTube 봇 차단에 걸렸습니다. YTDLP_COOKIES_FILE 설정이 필요합니다."),
    ("urlopen error", "network", "네트워크 오류로 영상을 가져오지 못했습니다. 잠시 후 다시 시도해 주세요."),
    ("timed out", "network", "네트워크 오류로 영상을 가져오지 못했습니다. 잠시 후 다시 시도해 주세요."),
    ("getaddrinfo failed", "network", "네트워크 오류로 영상을 가져오지 못했습니다. 잠시 후 다시 시도해 주세요."),
]


class YouTubeDownloadError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _ffmpeg_location(settings: Settings) -> str | None:
    binary = settings.ffmpeg_binary
    path = Path(binary)
    if path.is_absolute() and path.exists():
        return str(path.parent)
    found = shutil.which(binary)
    return str(Path(found).parent) if found else None


def _classify(exc: Exception) -> YouTubeDownloadError:
    if isinstance(exc, UnsupportedError):
        return YouTubeDownloadError("unsupported_url", "지원하지 않는 주소입니다. YouTube 영상 링크를 입력해 주세요.")
    text = " ".join(str(exc).split()).lower()
    for needle, code, message in _ERROR_PATTERNS:
        if needle in text:
            return YouTubeDownloadError(code, message)
    return YouTubeDownloadError("download_failed", "영상을 가져오지 못했습니다. 주소를 확인해 주세요.")


def _validate_meta(info: dict[str, Any], settings: Settings) -> None:
    if info.get("_type") == "playlist" or info.get("entries"):
        raise YouTubeDownloadError("playlist", "재생목록이 아닌 단일 영상 주소를 입력해 주세요.")
    if info.get("is_live"):
        raise YouTubeDownloadError("livestream", "현재 진행 중인 라이브는 가져올 수 없습니다.")
    if info.get("live_status") in {"is_upcoming", "is_live", "post_live"}:
        raise YouTubeDownloadError(
            "premiere_not_started", "아직 시작되지 않았거나 진행 중인 라이브/프리미어 영상입니다."
        )
    cap = int(getattr(settings, "youtube_max_source_seconds", 3600) or 0)
    duration = float(info.get("duration") or 0.0)
    if cap and duration and duration > cap:
        raise YouTubeDownloadError("too_long", f"영상이 너무 깁니다. 최대 {cap // 60}분까지 지원합니다.")


def _base_opts(settings: Settings) -> dict[str, Any]:
    opts: dict[str, Any] = {
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "no_color": True,
        "retries": 3,
        "fragment_retries": 3,
        "socket_timeout": 30,
        "overwrites": True,
        # yt-dlp >=2026 uses EJS (External JavaScript Support) for YouTube's
        # "n" throttling parameter. Deno is baked into the image.
        # Must be a list — passing a string causes yt-dlp to iterate chars.
        "remote_components": ["ejs:github"],
        # android_vr bypasses YouTube's SABR-only streaming experiment that
        # affects datacenter IPs on the standard android client, restoring
        # full DASH format availability (1080p+). web is the fallback.
        "extractor_args": {"youtube": {"player_client": ["android_vr", "web"]}},
    }
    location = _ffmpeg_location(settings)
    if location:
        opts["ffmpeg_location"] = location
    cookies = str(getattr(settings, "ytdlp_cookies_file", "") or "").strip()
    if cookies and Path(cookies).exists():
        # Reduces bot challenges / 429s when importing from a datacenter IP.
        opts["cookiefile"] = cookies
    return opts


def download_youtube(url: str, dest_path: Path, settings: Settings) -> dict[str, Any]:
    dest_path = Path(dest_path)
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    outtmpl = str(dest_path.with_suffix("")) + ".%(ext)s"
    base_opts = _base_opts(settings)

    # Phase 1: metadata only — validate before spending bandwidth.
    try:
        with yt_dlp.YoutubeDL({**base_opts, "skip_download": True}) as ydl:
            info = ydl.extract_info(url, download=False)
    except (DownloadError, ExtractorError, UnsupportedError) as exc:
        raise _classify(exc) from exc
    if not info:
        raise YouTubeDownloadError("unavailable", "삭제되었거나 사용할 수 없는 영상입니다.")
    _validate_meta(info, settings)
    title = str(info.get("title") or "youtube-video").strip() or "youtube-video"
    duration = float(info.get("duration") or 0.0)

    # Phase 2: download + merge to mp4.
    dl_opts = {**base_opts, "format": _FORMAT, "merge_output_format": "mp4", "outtmpl": outtmpl}
    try:
        with yt_dlp.YoutubeDL(dl_opts) as ydl:
            ydl.extract_info(url, download=True)
    except (DownloadError, ExtractorError, UnsupportedError) as exc:
        raise _classify(exc) from exc

    # Ensure the final artifact is exactly dest_path (source.mp4).
    if not dest_path.exists():
        stem = dest_path.with_suffix("").name
        produced = sorted(dest_path.parent.glob(f"{stem}.*"))
        produced = [p for p in produced if p.suffix.lower() not in {".part", ".ytdl"}]
        if produced:
            shutil.move(str(produced[0]), str(dest_path))

    if not dest_path.exists() or dest_path.stat().st_size == 0:
        raise YouTubeDownloadError("file_not_produced", "영상 파일을 만들지 못했습니다. 다시 시도해 주세요.")

    return {"title": title, "duration": duration, "path": dest_path}
