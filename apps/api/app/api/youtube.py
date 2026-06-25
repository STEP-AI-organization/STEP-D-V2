"""YouTube OAuth + auto-publish endpoints (scoped per logged-in app user).

Flow: the user signs in to the app (see ``app.api.auth``), then connects a
Google/YouTube channel here — which may be a *different* Google account than the
login — and publishes rendered clips to it. Channels are owned by the app user
(``YouTubeChannel.user_id``), so each user only sees and publishes to their own.
"""

import logging
import re
from datetime import datetime, timedelta
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database import get_db
from app.models import Clip, User, YouTubeChannel, YouTubeChannelDraft, YouTubePublish
from app.schemas import (
    AutoDistributeItem,
    AutoDistributeRequest,
    AutoDistributeResponse,
    ChannelAnalyticsResponse,
    ChannelInsightsResponse,
    ChannelStyleNoteRequest,
    ReschedulePublishRequest,
    VideoCommentResponse,
    YouTubeChannelCandidate,
    YouTubeChannelDraftConfirmManyRequest,
    YouTubeChannelDraftConfirmRequest,
    YouTubeChannelDraftResponse,
    YouTubeChannelResponse,
    YouTubePublishRequest,
    YouTubePublishResponse,
    YouTubeStatusResponse,
)
from app.services.auth import get_current_user, get_optional_user
from app.services.youtube_analytics import (
    SORT_KEYS,
    build_channel_analytics,
    build_success_insights,
    fetch_video_comments,
    fetch_video_stats,
)
from app.services.youtube_metadata import build_youtube_metadata, normalize_shorts_publish_metadata
from app.services.youtube_oauth import (
    build_authorization_url,
    channel_payload,
    ensure_channel_access_token,
    exchange_code_for_tokens,
    fetch_google_userinfo,
    fetch_my_channels,
    parse_oauth_state,
)
from app.services.youtube_publish import (
    publish_youtube_clip,
    update_youtube_schedule,
    youtube_configured,
)


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/youtube", tags=["youtube"])

ALLOWED_PRIVACY = {"public", "unlisted", "private"}


def _with_query_params(url: str, **params: str) -> str:
    parts = urlsplit(url)
    query = [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True) if key not in params]
    query.extend(params.items())
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def _channel_response(channel: YouTubeChannel) -> YouTubeChannelResponse:
    return YouTubeChannelResponse(
        id=channel.id,
        channel_id=channel.channel_id,
        title=channel.title,
        description=channel.description,
        thumbnail_url=channel.thumbnail_url,
        style_note=channel.style_note,
        google_account_email=channel.google_account_email,
        is_default=bool(channel.is_default),
        connected_at=channel.created_at,
    )


def _candidate_from_item(item: dict, connected_ids: set[str] | None = None) -> YouTubeChannelCandidate:
    snippet = item.get("snippet") or {}
    thumbnails = snippet.get("thumbnails") or {}
    thumbnail = thumbnails.get("high") or thumbnails.get("medium") or thumbnails.get("default") or {}
    channel_id = str(item.get("id") or "")
    return YouTubeChannelCandidate(
        channel_id=channel_id,
        title=str(snippet.get("title") or "Untitled channel"),
        description=str(snippet.get("description") or ""),
        thumbnail_url=thumbnail.get("url"),
        already_connected=channel_id in (connected_ids or set()),
    )


def _publish_response(publish: YouTubePublish) -> YouTubePublishResponse:
    metadata = publish.metadata_json if isinstance(publish.metadata_json, dict) else {}
    return YouTubePublishResponse(
        id=publish.id,
        clip_id=publish.clip_id,
        status=publish.status,
        title=publish.title,
        privacy_status=publish.privacy_status,
        schedule_date=publish.schedule_date,
        youtube_video_id=publish.youtube_video_id,
        youtube_url=publish.youtube_url,
        error=publish.error,
        channel_title=metadata.get("youtube_channel_title"),
        created_at=publish.created_at,
        updated_at=publish.updated_at,
    )


def _channels(db: Session, user_id: str) -> list[YouTubeChannel]:
    return (
        db.query(YouTubeChannel)
        .filter(YouTubeChannel.user_id == user_id)
        .order_by(
            YouTubeChannel.is_default.desc(),
            YouTubeChannel.updated_at.desc(),
            YouTubeChannel.created_at.desc(),
        )
        .all()
    )


def _owned_channel(db: Session, channel_db_id: str, user: User) -> YouTubeChannel:
    channel = db.get(YouTubeChannel, channel_db_id)
    if not channel or channel.user_id != user.id:
        raise HTTPException(status_code=404, detail="Channel not found.")
    return channel


def _owned_publish(db: Session, publish_id: str, user: User) -> YouTubePublish:
    publish = db.get(YouTubePublish, publish_id)
    if not publish:
        raise HTTPException(status_code=404, detail="Publish job not found.")
    metadata = publish.metadata_json if isinstance(publish.metadata_json, dict) else {}
    owner = metadata.get("app_user_id")
    if owner and owner != user.id:
        raise HTTPException(status_code=404, detail="Publish job not found.")
    return publish


def _publish_channel(db: Session, publish: YouTubePublish, user: User) -> YouTubeChannel | None:
    metadata = publish.metadata_json if isinstance(publish.metadata_json, dict) else {}
    channel_db_id = metadata.get("youtube_channel_db_id")
    if channel_db_id:
        channel = db.get(YouTubeChannel, str(channel_db_id))
        if channel and channel.user_id == user.id:
            return channel
    return None


def _owned_draft(db: Session, draft_id: str, user: User) -> YouTubeChannelDraft:
    draft = db.get(YouTubeChannelDraft, draft_id)
    if not draft or draft.user_id != user.id:
        raise HTTPException(status_code=404, detail="Channel connection draft not found.")
    if draft.draft_expires_at < datetime.utcnow():
        db.delete(draft)
        db.commit()
        raise HTTPException(status_code=410, detail="Channel connection draft expired. Try connecting again.")
    return draft


def _draft_response(db: Session, draft: YouTubeChannelDraft, user: User) -> YouTubeChannelDraftResponse:
    profile = draft.google_profile_json if isinstance(draft.google_profile_json, dict) else {}
    items = draft.channels_json if isinstance(draft.channels_json, list) else []
    connected_ids = {channel.channel_id for channel in _channels(db, user.id)}
    return YouTubeChannelDraftResponse(
        id=draft.id,
        google_account_email=profile.get("email"),
        google_account_name=profile.get("name"),
        google_account_picture_url=profile.get("picture"),
        expires_at=draft.draft_expires_at,
        channels=[_candidate_from_item(item, connected_ids) for item in items],
    )


def _delete_expired_drafts(db: Session, user_id: str) -> None:
    db.query(YouTubeChannelDraft).filter(
        YouTubeChannelDraft.user_id == user_id,
        YouTubeChannelDraft.draft_expires_at < datetime.utcnow(),
    ).delete(synchronize_session=False)


def _upsert_channel_from_draft(
    db: Session,
    user: User,
    draft: YouTubeChannelDraft,
    selected: dict,
    existing_for_user: list[YouTubeChannel],
) -> YouTubeChannel:
    channel_id = str(selected.get("id") or "")
    if not channel_id:
        raise HTTPException(status_code=400, detail="Selected channel did not include a YouTube channel id.")

    existing = next((channel for channel in existing_for_user if channel.channel_id == channel_id), None)
    profile = draft.google_profile_json if isinstance(draft.google_profile_json, dict) else {}
    profile_email = str(profile.get("email") or "")
    profile_sub = str(profile.get("sub") or "")
    account_fallback = next(
        (
            channel.refresh_token
            for channel in existing_for_user
            if channel.refresh_token
            and (
                (profile_sub and channel.google_account_id == profile_sub)
                or (profile_email and channel.google_account_email == profile_email)
            )
        ),
        None,
    )
    tokens = {
        "access_token": draft.access_token,
        "refresh_token": draft.refresh_token,
        "token_type": draft.token_type,
        "scope": draft.scope,
        "expires_at": draft.token_expires_at,
    }
    data = channel_payload(
        selected,
        tokens,
        fallback_refresh_token=(existing.refresh_token if existing else account_fallback),
        google_profile=profile,
    )
    if not data["channel_id"]:
        raise HTTPException(status_code=400, detail="Selected channel did not include a YouTube channel id.")

    if existing:
        for key, value in data.items():
            if value is not None:
                setattr(existing, key, value)
        return existing

    has_default = any(bool(channel.is_default) for channel in existing_for_user)
    channel = YouTubeChannel(
        id=uuid4().hex,
        user_id=user.id,
        is_default=0 if has_default else 1,
        **data,
    )
    db.add(channel)
    existing_for_user.append(channel)
    return channel


@router.get("/status", response_model=YouTubeStatusResponse)
def youtube_status(
    db: Session = Depends(get_db),
    user: User | None = Depends(get_optional_user),
):
    settings = get_settings()
    configured = youtube_configured(settings)
    channels = _channels(db, user.id) if user else []
    return YouTubeStatusResponse(
        configured=configured,
        oauth_ready=configured,
        env_fallback_ready=configured and bool(settings.youtube_refresh_token),
        authenticated=user is not None,
        default_privacy_status=settings.youtube_default_privacy_status,
        channels=[_channel_response(channel) for channel in channels],
    )


@router.get("/channels", response_model=list[YouTubeChannelResponse])
def list_channels(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return [_channel_response(channel) for channel in _channels(db, user.id)]


@router.get("/oauth/start")
def oauth_start(return_url: str | None = None, user: User | None = Depends(get_optional_user)):
    settings = get_settings()
    web = return_url or settings.web_base_url
    if not youtube_configured(settings):
        raise HTTPException(
            status_code=400,
            detail="YouTube OAuth is not configured. Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET.",
        )
    if user is None:
        login_return_url = _with_query_params(web, connect_youtube="1")
        login_query = urlencode({"return_url": login_return_url})
        return RedirectResponse(f"/api/auth/google/start?{login_query}", status_code=302)
    authorization_url = build_authorization_url(settings, return_url)
    return RedirectResponse(authorization_url, status_code=307)


@router.get("/oauth/callback")
def oauth_callback(
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    db: Session = Depends(get_db),
    user: User | None = Depends(get_optional_user),
):
    settings = get_settings()
    return_url = settings.web_base_url
    try:
        if state:
            payload = parse_oauth_state(settings, state)
            return_url = str(payload.get("return_url") or return_url)
        if user is None:
            raise RuntimeError("Sign in to the app before connecting a YouTube channel.")
        if error:
            raise RuntimeError(error)
        if not code:
            raise RuntimeError("Missing authorization code.")

        tokens = exchange_code_for_tokens(settings, code)
        access_token = str(tokens.get("access_token") or "")
        if not access_token:
            raise RuntimeError("Google did not return an access token.")

        try:
            profile = fetch_google_userinfo(access_token)
        except Exception:
            profile = {}

        items = fetch_my_channels(access_token)
        if not items:
            raise RuntimeError("No YouTube channel is available for this Google account.")

        _delete_expired_drafts(db, user.id)
        draft = YouTubeChannelDraft(
            id=uuid4().hex,
            user_id=user.id,
            access_token=access_token,
            refresh_token=tokens.get("refresh_token"),
            token_type=tokens.get("token_type"),
            scope=tokens.get("scope"),
            token_expires_at=tokens.get("expires_at"),
            draft_expires_at=datetime.utcnow() + timedelta(minutes=15),
            google_profile_json=profile,
            channels_json=items,
        )
        db.add(draft)
        db.commit()
    except Exception as exc:  # noqa: BLE001 - surface failure to the web app
        return RedirectResponse(_with_query_params(return_url, youtube="error", message=str(exc)[:200]), status_code=302)

    return RedirectResponse(_with_query_params(return_url, youtube="review", draft=draft.id), status_code=302)


@router.get("/channel-drafts/{draft_id}", response_model=YouTubeChannelDraftResponse)
def get_channel_draft(
    draft_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    draft = _owned_draft(db, draft_id, user)
    return _draft_response(db, draft, user)


@router.post("/channel-drafts/{draft_id}/confirm", response_model=YouTubeChannelResponse)
def confirm_channel_draft(
    draft_id: str,
    request: YouTubeChannelDraftConfirmRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    draft = _owned_draft(db, draft_id, user)
    items = draft.channels_json if isinstance(draft.channels_json, list) else []
    selected = next((item for item in items if str(item.get("id") or "") == request.channel_id), None)
    if not selected:
        raise HTTPException(status_code=404, detail="Selected channel was not found in this connection draft.")

    existing_for_user = _channels(db, user.id)
    channel = _upsert_channel_from_draft(db, user, draft, selected, existing_for_user)

    db.delete(draft)
    db.commit()
    db.refresh(channel)
    return _channel_response(channel)


@router.post("/channel-drafts/{draft_id}/confirm-many", response_model=list[YouTubeChannelResponse])
def confirm_many_channel_draft(
    draft_id: str,
    request: YouTubeChannelDraftConfirmManyRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    draft = _owned_draft(db, draft_id, user)
    requested_ids = [str(channel_id) for channel_id in request.channel_ids if str(channel_id or "").strip()]
    requested_ids = list(dict.fromkeys(requested_ids))
    if not requested_ids:
        raise HTTPException(status_code=400, detail="Select at least one YouTube channel.")

    items = draft.channels_json if isinstance(draft.channels_json, list) else []
    by_id = {str(item.get("id") or ""): item for item in items}
    missing = [channel_id for channel_id in requested_ids if channel_id not in by_id]
    if missing:
        raise HTTPException(status_code=404, detail="One or more selected channels were not found in this connection draft.")

    existing_for_user = _channels(db, user.id)
    channels = [
        _upsert_channel_from_draft(db, user, draft, by_id[channel_id], existing_for_user)
        for channel_id in requested_ids
    ]
    db.delete(draft)
    db.commit()
    for channel in channels:
        db.refresh(channel)
    return [_channel_response(channel) for channel in channels]


@router.delete("/channel-drafts/{draft_id}", status_code=204)
def cancel_channel_draft(
    draft_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    draft = _owned_draft(db, draft_id, user)
    db.delete(draft)
    db.commit()
    return None


@router.post("/channels/{channel_db_id}/default", response_model=YouTubeChannelResponse)
def set_default_channel(
    channel_db_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    channel = _owned_channel(db, channel_db_id, user)
    for other in _channels(db, user.id):
        other.is_default = 1 if other.id == channel_db_id else 0
    db.commit()
    db.refresh(channel)
    return _channel_response(channel)


@router.put("/channels/{channel_db_id}/style-note", response_model=YouTubeChannelResponse)
def update_channel_style_note(
    channel_db_id: str,
    request: ChannelStyleNoteRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    channel = _owned_channel(db, channel_db_id, user)
    channel.style_note = (request.style_note or "").strip()[:2000] or None
    db.commit()
    db.refresh(channel)
    return _channel_response(channel)


@router.delete("/channels/{channel_db_id}", status_code=204)
def disconnect_channel(
    channel_db_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    channel = _owned_channel(db, channel_db_id, user)
    was_default = bool(channel.is_default)
    db.delete(channel)
    db.commit()
    if was_default:
        remaining = _channels(db, user.id)
        if remaining:
            remaining[0].is_default = 1
            db.commit()
    return None


@router.get("/channels/{channel_db_id}/analytics", response_model=ChannelAnalyticsResponse)
def channel_analytics(
    channel_db_id: str,
    limit: int = 30,
    sort: str = "views",
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    settings = get_settings()
    channel = _owned_channel(db, channel_db_id, user)
    if sort not in SORT_KEYS:
        sort = "views"
    limit = max(1, min(100, limit))

    try:
        access_token, changed = ensure_channel_access_token(settings, channel)
        if changed:
            db.commit()
        data = build_channel_analytics(access_token, channel.channel_id, limit=limit, sort=sort)
    except Exception as exc:  # noqa: BLE001 - surface upstream YouTube/API errors
        raise HTTPException(status_code=502, detail=f"Failed to load channel analytics: {exc}") from exc

    return ChannelAnalyticsResponse(channel_db_id=channel_db_id, **data)


@router.get("/channels/{channel_db_id}/insights", response_model=ChannelInsightsResponse)
def channel_insights(
    channel_db_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    settings = get_settings()
    channel = _owned_channel(db, channel_db_id, user)

    publishes = db.query(YouTubePublish).filter(YouTubePublish.youtube_video_id.isnot(None)).all()
    mine = []
    for publish in publishes:
        metadata = publish.metadata_json if isinstance(publish.metadata_json, dict) else {}
        if metadata.get("youtube_channel_db_id") != channel.id:
            continue
        if metadata.get("app_user_id") and metadata.get("app_user_id") != user.id:
            continue
        mine.append(publish)

    if not mine:
        return ChannelInsightsResponse(
            channel_db_id=channel.id,
            recommendations=["이 채널에 발행된 쇼츠가 아직 없어요. 발행 후 성과가 쌓이면 분석해 드려요."],
        )

    video_ids = list({publish.youtube_video_id for publish in mine if publish.youtube_video_id})
    try:
        access_token, changed = ensure_channel_access_token(settings, channel)
        if changed:
            db.commit()
        stats = fetch_video_stats(access_token, video_ids)
    except Exception as exc:  # noqa: BLE001 - surface upstream YouTube/API errors
        raise HTTPException(status_code=502, detail=f"인사이트를 불러오지 못했어요: {exc}") from exc

    stats_by_id = {str(item.get("video_id")): item for item in stats}
    records: list[dict] = []
    seen: set[str] = set()
    for publish in mine:
        video_id = str(publish.youtube_video_id or "")
        if not video_id or video_id in seen:
            continue
        seen.add(video_id)
        stat = stats_by_id.get(video_id)
        if not stat:
            continue
        clip = db.get(Clip, publish.clip_id)
        evaluation = (clip.evaluation_json or {}) if clip else {}
        duration = round(max(0.0, float(clip.end_time) - float(clip.start_time))) if clip else 0
        records.append(
            {
                "video_id": video_id,
                "title": stat.get("title") or publish.title,
                "url": stat.get("url") or publish.youtube_url or f"https://youtu.be/{video_id}",
                "views": stat.get("view_count", 0),
                "likes": stat.get("like_count", 0),
                "comments": stat.get("comment_count", 0),
                "duration_seconds": duration,
                "hook_terms": [str(term) for term in (evaluation.get("hook_terms") or [])],
                "labels": [str(term) for term in (evaluation.get("labels") or [])],
            }
        )

    data = build_success_insights(records)
    return ChannelInsightsResponse(channel_db_id=channel.id, **data)


@router.get("/channels/{channel_db_id}/videos/{video_id}/comments", response_model=list[VideoCommentResponse])
def video_comments(
    channel_db_id: str,
    video_id: str,
    limit: int = 20,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    settings = get_settings()
    channel = _owned_channel(db, channel_db_id, user)
    try:
        access_token, changed = ensure_channel_access_token(settings, channel)
        if changed:
            db.commit()
        comments = fetch_video_comments(access_token, video_id, max(1, min(50, limit)))
    except Exception as exc:  # noqa: BLE001 - surface upstream YouTube/API errors
        logger.exception("Failed to load comments for video %s (channel %s)", video_id, channel_db_id)
        raise HTTPException(status_code=502, detail=f"Failed to load comments: {exc}") from exc
    return [VideoCommentResponse(**comment) for comment in comments]


@router.get("/publishes/{publish_id}", response_model=YouTubePublishResponse)
def get_publish(
    publish_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    publish = _owned_publish(db, publish_id, user)
    return _publish_response(publish)


@router.post("/publishes/{publish_id}/reschedule", response_model=YouTubePublishResponse)
def reschedule_publish(
    publish_id: str,
    request: ReschedulePublishRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    publish = _owned_publish(db, publish_id, user)
    if publish.status == "published":
        raise HTTPException(status_code=400, detail="이미 발행된 영상은 예약 시간을 변경할 수 없어요.")
    settings = get_settings()
    schedule_date = (request.schedule_date or "").strip() or None
    if schedule_date and not (len(schedule_date) == 14 and schedule_date.isdigit()):
        raise HTTPException(status_code=400, detail="schedule_date must be a 14-digit YYYYMMDDHHMMSS string.")

    if publish.youtube_video_id:
        channel = _publish_channel(db, publish, user)
        if not channel:
            raise HTTPException(status_code=400, detail="이 영상이 올라간 채널을 찾을 수 없어요. 채널을 다시 연결해 주세요.")
        try:
            access_token, changed = ensure_channel_access_token(settings, channel)
            if changed:
                db.commit()
            update_youtube_schedule(access_token, publish.youtube_video_id, schedule_date, publish.privacy_status)
        except Exception as exc:  # noqa: BLE001 - surface YouTube API errors
            raise HTTPException(status_code=502, detail=f"YouTube 예약 변경에 실패했어요: {exc}") from exc
        publish.schedule_date = schedule_date
        publish.status = "scheduled" if schedule_date else "published"
        publish.error = None
        db.commit()
    else:
        publish.schedule_date = schedule_date
        publish.status = "pending"
        publish.error = None
        db.commit()
        background_tasks.add_task(publish_youtube_clip, publish.id)

    db.refresh(publish)
    return _publish_response(publish)


@router.post("/publishes/{publish_id}/cancel", response_model=YouTubePublishResponse)
def cancel_publish(
    publish_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    publish = _owned_publish(db, publish_id, user)
    settings = get_settings()
    metadata = dict(publish.metadata_json or {})
    if publish.youtube_video_id and publish.status == "scheduled":
        channel = _publish_channel(db, publish, user)
        if channel:
            try:
                access_token, changed = ensure_channel_access_token(settings, channel)
                if changed:
                    db.commit()
                update_youtube_schedule(access_token, publish.youtube_video_id, None, "private")
            except Exception as exc:  # noqa: BLE001 - record but still cancel locally
                metadata["cancel_error"] = str(exc)[:300]
    publish.status = "cancelled"
    metadata["cancelled"] = True
    publish.metadata_json = metadata
    db.commit()
    db.refresh(publish)
    return _publish_response(publish)


@router.post("/auto-distribute", response_model=AutoDistributeResponse)
def auto_distribute(
    request: AutoDistributeRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    settings = get_settings()
    if not youtube_configured(settings):
        raise HTTPException(status_code=400, detail="YouTube OAuth is not configured.")
    channel = _owned_channel(db, request.channel_db_id, user)
    if not request.clip_ids:
        raise HTTPException(status_code=400, detail="배포할 쇼츠를 한 개 이상 선택하세요.")
    if not re.match(r"^\d{8}$", request.start_date or ""):
        raise HTTPException(status_code=400, detail="start_date must be a YYYYMMDD string.")
    times = [t for t in request.times if re.match(r"^\d{1,2}:\d{2}$", t.strip())] or ["18:00"]

    privacy_status = (request.privacy_status or settings.youtube_default_privacy_status).lower()
    if privacy_status not in ALLOWED_PRIVACY:
        privacy_status = settings.youtube_default_privacy_status

    start = datetime(int(request.start_date[:4]), int(request.start_date[4:6]), int(request.start_date[6:8]))
    items: list[AutoDistributeItem] = []
    for index, clip_id in enumerate(request.clip_ids[:60]):
        clip = db.get(Clip, clip_id)
        if not clip:
            continue
        day = index // len(times)
        hour_str, minute_str = times[index % len(times)].split(":")
        slot_date = start + timedelta(days=day)
        stamp = f"{slot_date.year:04d}{slot_date.month:02d}{slot_date.day:02d}{int(hour_str):02d}{int(minute_str):02d}00"

        metadata = build_youtube_metadata(clip)
        title = (metadata.get("youtube_title") or clip.title).strip()[:100]
        title, description, tags = normalize_shorts_publish_metadata(
            title,
            metadata.get("description", ""),
            list(metadata.get("tags") or []),
        )
        publish = YouTubePublish(
            id=uuid4().hex,
            clip_id=clip.id,
            job_id=clip.job_id,
            status="pending",
            title=title,
            description=description,
            tags_json=tags,
            privacy_status=privacy_status,
            category_id=settings.youtube_category_id,
            schedule_date=stamp,
            metadata_json={
                "youtube_channel_db_id": channel.id,
                "youtube_channel_id": channel.channel_id,
                "youtube_channel_title": channel.title,
                "app_user_id": user.id,
                "auto_distributed": True,
            },
        )
        db.add(publish)
        db.commit()
        db.refresh(publish)
        background_tasks.add_task(publish_youtube_clip, publish.id)
        items.append(AutoDistributeItem(clip_id=clip.id, publish_id=publish.id, schedule_date=stamp))

    if not items:
        raise HTTPException(status_code=404, detail="선택한 쇼츠를 찾을 수 없어요.")
    return AutoDistributeResponse(items=items)


@router.post("/clips/{clip_id}/publish", response_model=YouTubePublishResponse, status_code=202)
def publish_clip(
    clip_id: str,
    request: YouTubePublishRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    settings = get_settings()
    if not youtube_configured(settings):
        raise HTTPException(
            status_code=400,
            detail="YouTube OAuth is not configured. Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET.",
        )

    clip = db.get(Clip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found.")

    privacy_status = (request.privacy_status or settings.youtube_default_privacy_status).lower()
    if privacy_status not in ALLOWED_PRIVACY:
        raise HTTPException(status_code=400, detail=f"Unsupported privacy_status: {privacy_status}")

    if request.channel_db_id:
        channel = _owned_channel(db, request.channel_db_id, user)
    else:
        owned = _channels(db, user.id)
        if not owned:
            raise HTTPException(status_code=400, detail="Connect a YouTube channel before publishing.")
        channel = owned[0]

    metadata = build_youtube_metadata(clip)
    title = (request.title or metadata.get("youtube_title") or clip.title).strip()
    description = request.description if request.description is not None else metadata.get("description", "")
    tags = request.tags if request.tags is not None else list(metadata.get("tags") or [])
    title, description, tags = normalize_shorts_publish_metadata(title[:100], description, tags)

    publish_metadata = {
        "youtube_channel_db_id": channel.id,
        "youtube_channel_id": channel.channel_id,
        "youtube_channel_title": channel.title,
        "app_user_id": user.id,
    }

    publish = YouTubePublish(
        id=uuid4().hex,
        clip_id=clip.id,
        job_id=clip.job_id,
        status="pending",
        title=title,
        description=description,
        tags_json=tags,
        privacy_status=privacy_status,
        category_id=settings.youtube_category_id,
        schedule_date=request.schedule_date,
        metadata_json=publish_metadata,
    )
    db.add(publish)
    db.commit()
    db.refresh(publish)

    background_tasks.add_task(publish_youtube_clip, publish.id)
    return _publish_response(publish)
