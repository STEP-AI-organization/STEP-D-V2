"""App login sessions (Google Sign-In identity), decoupled from YouTube publishing.

The app login only proves *who the user is*; which YouTube channel they publish to
is a separate OAuth grant (see ``youtube_oauth``) and may be a different Google
account. Sessions are stateless: a signed, expiring token stored in an httpOnly
cookie. No server-side session store needed at this scale.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.core.database import get_db
from app.models import User


def _session_secret(settings: Settings) -> bytes:
    seed = settings.session_secret or settings.youtube_client_secret or settings.app_name
    return seed.encode("utf-8")


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _unb64(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def create_session_token(settings: Settings, user_id: str) -> str:
    payload = {"uid": user_id, "iat": int(time.time())}
    body = _b64(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signature = hmac.new(_session_secret(settings), body.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{body}.{signature}"


def parse_session_token(settings: Settings, token: str) -> dict[str, Any] | None:
    try:
        body, signature = token.split(".", 1)
    except ValueError:
        return None
    expected = hmac.new(_session_secret(settings), body.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        return None
    try:
        payload = json.loads(_unb64(body).decode("utf-8"))
    except (ValueError, json.JSONDecodeError):
        return None
    issued_at = int(payload.get("iat") or 0)
    if issued_at < int(time.time()) - settings.session_ttl_days * 86400:
        return None
    return payload


def get_optional_user(
    request: Request,
    db: Session = Depends(get_db),
) -> User | None:
    settings = get_settings()
    token = request.cookies.get(settings.session_cookie_name)
    if not token:
        return None
    payload = parse_session_token(settings, token)
    if not payload:
        return None
    user_id = payload.get("uid")
    if not user_id:
        return None
    return db.get(User, str(user_id))


def get_current_user(user: User | None = Depends(get_optional_user)) -> User:
    if user is None:
        raise HTTPException(status_code=401, detail="Sign in with Google first.")
    return user
