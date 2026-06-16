import base64
import hashlib
import hmac
import json
import time
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import urlencode

import httpx

from app.core.config import Settings


GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
YOUTUBE_CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels"
YOUTUBE_SCOPES = [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
]


def _state_secret(settings: Settings) -> bytes:
    seed = settings.youtube_client_secret or settings.app_name
    return seed.encode("utf-8")


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _unb64(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def create_oauth_state(settings: Settings, return_url: str | None = None) -> str:
    payload = {
        "iat": int(time.time()),
        "return_url": return_url or settings.web_base_url,
    }
    body = _b64(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signature = hmac.new(_state_secret(settings), body.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{body}.{signature}"


def parse_oauth_state(settings: Settings, state: str) -> dict[str, Any]:
    try:
        body, signature = state.split(".", 1)
    except ValueError as exc:
        raise ValueError("Invalid OAuth state.") from exc
    expected = hmac.new(_state_secret(settings), body.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise ValueError("Invalid OAuth state signature.")
    payload = json.loads(_unb64(body).decode("utf-8"))
    issued_at = int(payload.get("iat") or 0)
    if issued_at < int(time.time()) - 3600:
        raise ValueError("OAuth state expired.")
    return payload


def build_authorization_url(settings: Settings, return_url: str | None = None) -> str:
    state = create_oauth_state(settings, return_url)
    params = {
        "client_id": settings.youtube_client_id,
        "redirect_uri": settings.youtube_oauth_redirect_uri,
        "response_type": "code",
        "scope": " ".join(YOUTUBE_SCOPES),
        "access_type": "offline",
        "include_granted_scopes": "true",
        "prompt": "consent",
        "state": state,
    }
    return f"{GOOGLE_AUTH_URL}?{urlencode(params)}"


def exchange_code_for_tokens(settings: Settings, code: str) -> dict[str, Any]:
    response = httpx.post(
        GOOGLE_TOKEN_URL,
        data={
            "client_id": settings.youtube_client_id,
            "client_secret": settings.youtube_client_secret,
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": settings.youtube_oauth_redirect_uri,
        },
        timeout=30,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Google OAuth token exchange failed: {response.status_code} {response.text[:500]}")
    payload = response.json()
    expires_in = int(payload.get("expires_in") or 3600)
    payload["expires_at"] = datetime.utcnow() + timedelta(seconds=max(60, expires_in - 60))
    return payload


def refresh_access_token(settings: Settings, refresh_token: str) -> dict[str, Any]:
    response = httpx.post(
        GOOGLE_TOKEN_URL,
        data={
            "client_id": settings.youtube_client_id,
            "client_secret": settings.youtube_client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        },
        timeout=30,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Google OAuth token refresh failed: {response.status_code} {response.text[:500]}")
    payload = response.json()
    expires_in = int(payload.get("expires_in") or 3600)
    payload["expires_at"] = datetime.utcnow() + timedelta(seconds=max(60, expires_in - 60))
    return payload


def ensure_channel_access_token(settings: Settings, channel: Any) -> tuple[str, bool]:
    """Return a valid access token for a stored YouTubeChannel, refreshing it when
    expired. Mutates the channel in place; the caller is responsible for committing.

    Returns ``(access_token, changed)`` where ``changed`` is True when the token was
    refreshed and the channel row needs to be persisted.
    """
    expires_at = getattr(channel, "expires_at", None)
    still_valid = bool(
        getattr(channel, "access_token", None)
        and expires_at
        and expires_at > datetime.utcnow() + timedelta(seconds=60)
    )
    if still_valid:
        return str(channel.access_token), False

    refresh_token = getattr(channel, "refresh_token", None)
    if not refresh_token:
        raise RuntimeError(
            f"YouTube channel '{getattr(channel, 'title', '')}' has no refresh token. Reconnect the channel."
        )
    payload = refresh_access_token(settings, str(refresh_token))
    channel.access_token = str(payload.get("access_token") or "")
    channel.expires_at = payload.get("expires_at")
    channel.token_type = payload.get("token_type") or channel.token_type
    channel.scope = payload.get("scope") or channel.scope
    return str(channel.access_token), True


def fetch_my_channels(access_token: str) -> list[dict[str, Any]]:
    response = httpx.get(
        YOUTUBE_CHANNELS_URL,
        params={"part": "snippet", "mine": "true", "maxResults": 50},
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=30,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"YouTube channel lookup failed: {response.status_code} {response.text[:500]}")
    return list(response.json().get("items") or [])


def fetch_google_userinfo(access_token: str) -> dict[str, Any]:
    response = httpx.get(
        GOOGLE_USERINFO_URL,
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=30,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Google profile lookup failed: {response.status_code} {response.text[:500]}")
    return dict(response.json())


def channel_payload(
    item: dict[str, Any],
    tokens: dict[str, Any],
    fallback_refresh_token: str | None = None,
    google_profile: dict[str, Any] | None = None,
) -> dict[str, Any]:
    snippet = item.get("snippet") or {}
    thumbnails = snippet.get("thumbnails") or {}
    thumbnail = thumbnails.get("high") or thumbnails.get("medium") or thumbnails.get("default") or {}
    profile = google_profile or {}
    return {
        "channel_id": str(item.get("id") or ""),
        "title": str(snippet.get("title") or "Untitled channel"),
        "description": str(snippet.get("description") or ""),
        "thumbnail_url": thumbnail.get("url"),
        "google_account_id": profile.get("sub"),
        "google_account_email": profile.get("email"),
        "google_account_name": profile.get("name"),
        "google_account_picture_url": profile.get("picture"),
        "access_token": str(tokens.get("access_token") or ""),
        "refresh_token": tokens.get("refresh_token") or fallback_refresh_token,
        "token_type": tokens.get("token_type"),
        "scope": tokens.get("scope"),
        "expires_at": tokens.get("expires_at"),
    }
