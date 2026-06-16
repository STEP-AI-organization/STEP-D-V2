from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

from app.core.config import Settings, get_settings
from app.core.database import session_scope
from app.models import Clip, YouTubeChannel, YouTubePublish
from app.services.youtube_oauth import refresh_access_token as refresh_channel_access_token
from app.services.storage import media_path_from_url


GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
YOUTUBE_UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos"
YOUTUBE_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"
YOUTUBE_THUMBNAIL_URL = "https://www.googleapis.com/upload/youtube/v3/thumbnails/set"


def update_youtube_schedule(access_token: str, video_id: str, schedule_date: str | None, privacy_status: str) -> None:
    """Update an already-uploaded video's publish schedule via YouTube Data API.

    When ``schedule_date`` is set the video is held ``private`` until ``publishAt``;
    when it is cleared the video flips to ``privacy_status`` immediately.
    """
    status: dict[str, Any] = {"selfDeclaredMadeForKids": False}
    if schedule_date:
        status["privacyStatus"] = "private"
        status["publishAt"] = _schedule_to_iso(schedule_date)
    else:
        status["privacyStatus"] = privacy_status
    response = httpx.put(
        f"{YOUTUBE_VIDEOS_URL}?part=status",
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        json={"id": video_id, "status": status},
        timeout=30,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"YouTube schedule update failed: {response.status_code} {response.text[:500]}")


def youtube_configured(settings: Settings) -> bool:
    return bool(settings.youtube_client_id and settings.youtube_client_secret)


def sanitize_youtube_text(text: str) -> str:
    return str(text or "").replace("<", "(").replace(">", ")").strip()


def _schedule_to_iso(value: str) -> str:
    if len(value) == 14 and value.isdigit():
        return f"{value[:4]}-{value[4:6]}-{value[6:8]}T{value[8:10]}:{value[10:12]}:{value[12:14]}+09:00"
    return value


def refresh_env_access_token(settings: Settings) -> str:
    if not youtube_configured(settings) or not settings.youtube_refresh_token:
        raise RuntimeError("YouTube env is not configured. Set YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN.")

    response = httpx.post(
        GOOGLE_TOKEN_URL,
        data={
            "client_id": settings.youtube_client_id,
            "client_secret": settings.youtube_client_secret,
            "refresh_token": settings.youtube_refresh_token,
            "grant_type": "refresh_token",
        },
        timeout=30,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"YouTube token refresh failed: {response.status_code} {response.text[:500]}")
    return str(response.json()["access_token"])


def _select_channel(db, publish: YouTubePublish) -> YouTubeChannel | None:
    metadata = publish.metadata_json if isinstance(publish.metadata_json, dict) else {}
    channel_db_id = metadata.get("youtube_channel_db_id")
    youtube_channel_id = metadata.get("youtube_channel_id")
    if channel_db_id:
        channel = db.get(YouTubeChannel, str(channel_db_id))
        if channel:
            return channel
    if youtube_channel_id:
        channel = db.query(YouTubeChannel).filter(YouTubeChannel.channel_id == str(youtube_channel_id)).first()
        if channel:
            return channel
    return (
        db.query(YouTubeChannel)
        .order_by(YouTubeChannel.is_default.desc(), YouTubeChannel.updated_at.desc(), YouTubeChannel.created_at.desc())
        .first()
    )


def _access_token_for_publish(settings: Settings, db, publish: YouTubePublish) -> tuple[str, YouTubeChannel | None]:
    channel = _select_channel(db, publish)
    if channel:
        expires_at = channel.expires_at
        still_valid = bool(expires_at and expires_at > datetime.utcnow() + timedelta(seconds=60))
        if channel.access_token and still_valid:
            return str(channel.access_token), channel
        if not channel.refresh_token:
            raise RuntimeError(f"YouTube channel '{channel.title}' does not have a refresh token. Reconnect the channel.")
        token_payload = refresh_channel_access_token(settings, str(channel.refresh_token))
        channel.access_token = str(token_payload.get("access_token") or "")
        channel.expires_at = token_payload.get("expires_at")
        channel.token_type = token_payload.get("token_type") or channel.token_type
        channel.scope = token_payload.get("scope") or channel.scope
        return str(channel.access_token), channel
    return refresh_env_access_token(settings), None


def _update_publish(publish_id: str, **values: Any) -> None:
    with session_scope() as db:
        publish = db.get(YouTubePublish, publish_id)
        if not publish:
            return
        for key, value in values.items():
            setattr(publish, key, value)


def _video_metadata(publish: YouTubePublish, settings: Settings) -> dict[str, Any]:
    privacy_status = publish.privacy_status or settings.youtube_default_privacy_status
    status: dict[str, Any] = {
        "privacyStatus": privacy_status,
        "selfDeclaredMadeForKids": False,
    }
    if publish.schedule_date:
        status["privacyStatus"] = "private"
        status["publishAt"] = _schedule_to_iso(publish.schedule_date)

    return {
        "snippet": {
            "title": sanitize_youtube_text(publish.title),
            "description": sanitize_youtube_text(publish.description or ""),
            "tags": publish.tags_json or [],
            "categoryId": publish.category_id or settings.youtube_category_id,
        },
        "status": status,
    }


def _upload_video(access_token: str, publish: YouTubePublish, video_path: Path, settings: Settings) -> str:
    file_size = video_path.stat().st_size
    init_response = httpx.post(
        f"{YOUTUBE_UPLOAD_URL}?uploadType=resumable&part=snippet,status",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Length": str(file_size),
            "X-Upload-Content-Type": "video/mp4",
        },
        json=_video_metadata(publish, settings),
        timeout=60,
    )
    if init_response.status_code >= 400:
        raise RuntimeError(f"YouTube upload init failed: {init_response.status_code} {init_response.text[:500]}")

    upload_url = init_response.headers.get("location")
    if not upload_url:
        raise RuntimeError("YouTube upload init did not return a resumable upload URL.")

    with video_path.open("rb") as video_file:
        upload_response = httpx.put(
            upload_url,
            headers={
                "Content-Type": "video/mp4",
                "Content-Length": str(file_size),
            },
            content=video_file,
            timeout=settings.youtube_upload_timeout_seconds,
        )
    if upload_response.status_code >= 400:
        raise RuntimeError(f"YouTube video upload failed: {upload_response.status_code} {upload_response.text[:500]}")

    payload = upload_response.json()
    video_id = payload.get("id")
    if not video_id:
        raise RuntimeError(f"YouTube upload response did not include video id: {payload}")
    return str(video_id)


def _upload_thumbnail(access_token: str, video_id: str, thumbnail_path: Path) -> str | None:
    if not thumbnail_path.exists():
        return "thumbnail file not found"
    content_type = "image/jpeg" if thumbnail_path.suffix.lower() in {".jpg", ".jpeg"} else "image/png"
    response = httpx.post(
        f"{YOUTUBE_THUMBNAIL_URL}?videoId={video_id}&uploadType=media",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": content_type,
        },
        content=thumbnail_path.read_bytes(),
        timeout=120,
    )
    if response.status_code >= 400:
        return f"{response.status_code} {response.text[:500]}"
    return None


def publish_youtube_clip(publish_id: str) -> None:
    settings = get_settings()
    try:
        _update_publish(publish_id, status="uploading", error=None)
        with session_scope() as db:
            publish = db.get(YouTubePublish, publish_id)
            if not publish:
                return
            clip = db.get(Clip, publish.clip_id)
            if not clip:
                raise RuntimeError("Clip not found")

            video_path = media_path_from_url(settings, clip.video_url)
            thumbnail_path = media_path_from_url(settings, clip.thumbnail_url)
            access_token, channel = _access_token_for_publish(settings, db, publish)
            video_id = _upload_video(access_token, publish, video_path, settings)
            thumbnail_error = _upload_thumbnail(access_token, video_id, thumbnail_path)
            final_status = "scheduled" if publish.schedule_date else "published"
            metadata = dict(publish.metadata_json or {})
            if channel:
                metadata["youtube_channel_db_id"] = channel.id
                metadata["youtube_channel_id"] = channel.channel_id
                metadata["youtube_channel_title"] = channel.title
            if thumbnail_error:
                metadata["thumbnail_error"] = thumbnail_error
            publish.status = final_status
            publish.youtube_video_id = video_id
            publish.youtube_url = f"https://youtu.be/{video_id}"
            publish.metadata_json = metadata
    except Exception as exc:
        _update_publish(publish_id, status="failed", error=str(exc))
