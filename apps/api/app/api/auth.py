"""App login endpoints — "Sign in with Google" for identity only.

This OAuth flow requests identity scopes (openid/email/profile) and is completely
separate from the YouTube-publish OAuth flow. A user signs in here to get a session;
they later connect a YouTube channel (possibly a different Google account) to publish.
"""

from datetime import datetime
from urllib.parse import urlencode
from uuid import uuid4

import httpx
from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database import get_db
from app.models import User
from app.schemas import AuthMeResponse, AuthUser
from app.services.auth import create_session_token, get_optional_user
from app.services.youtube_oauth import (
    GOOGLE_AUTH_URL,
    GOOGLE_TOKEN_URL,
    create_oauth_state,
    fetch_google_userinfo,
    parse_oauth_state,
)


router = APIRouter(prefix="/api/auth", tags=["auth"])

LOGIN_SCOPES = ["openid", "email", "profile"]


def _auth_configured(settings) -> bool:
    return bool(settings.youtube_client_id and settings.youtube_client_secret)


def _build_login_url(settings, return_url: str | None) -> str:
    state = create_oauth_state(settings, return_url)
    params = {
        "client_id": settings.youtube_client_id,
        "redirect_uri": settings.auth_oauth_redirect_uri,
        "response_type": "code",
        "scope": " ".join(LOGIN_SCOPES),
        "include_granted_scopes": "true",
        "prompt": "select_account",
        "state": state,
    }
    return f"{GOOGLE_AUTH_URL}?{urlencode(params)}"


def _exchange_code(settings, code: str) -> dict:
    response = httpx.post(
        GOOGLE_TOKEN_URL,
        data={
            "client_id": settings.youtube_client_id,
            "client_secret": settings.youtube_client_secret,
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": settings.auth_oauth_redirect_uri,
        },
        timeout=30,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Google login token exchange failed: {response.status_code} {response.text[:300]}")
    return response.json()


def _to_auth_user(user: User) -> AuthUser:
    return AuthUser(id=user.id, email=user.email, name=user.name, picture_url=user.picture_url)


@router.get("/me", response_model=AuthMeResponse)
def me(user: User | None = Depends(get_optional_user)):
    return AuthMeResponse(user=_to_auth_user(user) if user else None)


@router.get("/google/start")
def google_start(return_url: str | None = None):
    settings = get_settings()
    if not _auth_configured(settings):
        raise HTTPException(
            status_code=400,
            detail="Google login is not configured. Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET.",
        )
    return RedirectResponse(_build_login_url(settings, return_url), status_code=307)


@router.get("/google/callback")
def google_callback(
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    db: Session = Depends(get_db),
):
    settings = get_settings()
    return_url = settings.web_base_url
    try:
        if state:
            payload = parse_oauth_state(settings, state)
            return_url = str(payload.get("return_url") or return_url)
        if error:
            raise RuntimeError(error)
        if not code:
            raise RuntimeError("Missing authorization code.")

        tokens = _exchange_code(settings, code)
        access_token = str(tokens.get("access_token") or "")
        if not access_token:
            raise RuntimeError("Google did not return an access token.")
        profile = fetch_google_userinfo(access_token)
        sub = str(profile.get("sub") or "")
        if not sub:
            raise RuntimeError("Google profile did not include an account id.")

        user = db.query(User).filter(User.google_sub == sub).first()
        if user:
            user.email = profile.get("email") or user.email
            user.name = profile.get("name") or user.name
            user.picture_url = profile.get("picture") or user.picture_url
            user.updated_at = datetime.utcnow()
        else:
            user = User(
                id=uuid4().hex,
                google_sub=sub,
                email=profile.get("email"),
                name=profile.get("name"),
                picture_url=profile.get("picture"),
            )
            db.add(user)
        db.commit()
        db.refresh(user)
    except Exception as exc:  # noqa: BLE001 - surface to the web app
        separator = "&" if "?" in return_url else "?"
        return RedirectResponse(f"{return_url}{separator}login=error&message={str(exc)[:200]}", status_code=302)

    token = create_session_token(settings, user.id)
    separator = "&" if "?" in return_url else "?"
    redirect = RedirectResponse(f"{return_url}{separator}login=ok", status_code=302)
    redirect.set_cookie(
        key=settings.session_cookie_name,
        value=token,
        max_age=settings.session_ttl_days * 86400,
        httponly=True,
        # SameSite=None so the session cookie is still sent when the web app and
        # the API are on different hosts (e.g. localhost:3000 -> 127.0.0.1:8010);
        # with Lax it is dropped on cross-site fetches and the user looks logged
        # out on every reload. None requires Secure, which localhost/127.0.0.1
        # accept over http (they are treated as secure contexts).
        samesite="none",
        secure=True,
        path="/",
    )
    return redirect


@router.post("/logout")
def logout(response: Response):
    settings = get_settings()
    response.delete_cookie(key=settings.session_cookie_name, path="/", samesite="none", secure=True)
    return {"ok": True}
