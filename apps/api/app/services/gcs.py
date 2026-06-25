"""Thin Google Cloud Storage wrapper for the "lazy mirror" media backend.

Only used when ``settings.storage_backend == "gcs"``. The rest of the app keeps
doing local-disk FFmpeg I/O; :mod:`app.services.storage` calls this module at the
two seam functions to (a) upload durable artifacts to a public bucket and
(b) download them back on demand if the local copy is missing.

Design notes:
- A fresh ``storage.Client()`` is created per call. ``BackgroundTasks`` run in
  Starlette's anyio worker threads and ``storage.Client`` is not documented
  thread-safe; a per-call client is cheap relative to a multi-MB transfer and
  removes all sharing concerns.
- Auth is Application Default Credentials (the VM's attached service account).
  No key file is needed.
- ``google-cloud-storage`` is imported lazily so local-dev installs that do not
  have the package can still import this module (it is never called in "local"
  mode).
"""

from __future__ import annotations

import time
from pathlib import Path

from app.core.config import Settings

# rel path suffix -> Content-Type. Correct types let browsers play <video>
# inline and serve HTTP Range requests; octet-stream can break inline playback.
_CONTENT_TYPES: dict[str, str] = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".json": "application/json",
    ".zip": "application/zip",
    ".ass": "text/plain; charset=utf-8",
    ".srt": "text/plain; charset=utf-8",
    ".vtt": "text/vtt",
}

_DEFAULT_CONTENT_TYPE = "application/octet-stream"
_CACHE_CONTROL = "public, max-age=3600"
_TIMEOUT_SECONDS = 60


def guess_content_type(rel_or_path: str | Path) -> str:
    suffix = Path(str(rel_or_path)).suffix.lower()
    return _CONTENT_TYPES.get(suffix, _DEFAULT_CONTENT_TYPE)


def object_key(settings: Settings, rel: str) -> str:
    """Storage-relative path -> bucket object key (applies the optional prefix)."""
    rel = str(rel).lstrip("/")
    prefix = str(getattr(settings, "gcs_prefix", "") or "").strip("/")
    return f"{prefix}/{rel}" if prefix else rel


def public_url(settings: Settings, rel: str) -> str:
    """Public, directly-servable URL for a storage-relative path."""
    key = object_key(settings, rel)
    base = str(getattr(settings, "gcs_public_base_url", "") or "").strip()
    if base:
        return f"{base.rstrip('/')}/{key}"
    return f"https://storage.googleapis.com/{settings.gcs_bucket}/{key}"


def rel_from_url(settings: Settings, url: str) -> str | None:
    """Reverse :func:`public_url`: GCS media URL -> storage-relative path.

    Strips the host/bucket (or the custom ``gcs_public_base_url``) and the
    optional prefix so the result matches the local ``/data`` layout. Returns
    ``None`` if ``url`` is not a GCS URL for this bucket/base.
    """
    text = str(url or "").split("?", 1)[0].split("#", 1)[0]
    candidates = []
    base = str(getattr(settings, "gcs_public_base_url", "") or "").strip()
    if base:
        candidates.append(base.rstrip("/") + "/")
    if settings.gcs_bucket:
        candidates.append(f"https://storage.googleapis.com/{settings.gcs_bucket}/")
    key: str | None = None
    for prefix_url in candidates:
        if text.startswith(prefix_url):
            key = text[len(prefix_url) :]
            break
    if key is None:
        return None
    prefix = str(getattr(settings, "gcs_prefix", "") or "").strip("/")
    if prefix and key.startswith(prefix + "/"):
        key = key[len(prefix) + 1 :]
    return key.lstrip("/")


def _bucket(settings: Settings):
    from google.cloud import storage  # lazy: only needed in gcs mode

    client = storage.Client()
    return client.bucket(settings.gcs_bucket)


def _with_retry(fn):
    last: Exception | None = None
    for attempt in range(2):  # 1 try + 1 retry
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 - surfaced to caller after retry
            last = exc
            if attempt == 0:
                time.sleep(1.0)
    assert last is not None
    raise last


def upload(settings: Settings, rel: str, path: Path, content_type: str | None = None) -> str:
    """Upload a local file to ``object_key(rel)`` and return its public URL."""
    key = object_key(settings, rel)
    ctype = content_type or guess_content_type(rel)

    def _do() -> None:
        blob = _bucket(settings).blob(key)
        blob.cache_control = _CACHE_CONTROL
        blob.upload_from_filename(str(path), content_type=ctype, timeout=_TIMEOUT_SECONDS)

    _with_retry(_do)
    return public_url(settings, rel)


def download(settings: Settings, rel: str, path: Path) -> bool:
    """Download ``object_key(rel)`` to a local path. Returns False if absent."""
    key = object_key(settings, rel)

    def _do() -> bool:
        blob = _bucket(settings).blob(key)
        if not blob.exists():
            return False
        path.parent.mkdir(parents=True, exist_ok=True)
        blob.download_to_filename(str(path), timeout=_TIMEOUT_SECONDS)
        return True

    return _with_retry(_do)


def exists(settings: Settings, rel: str) -> bool:
    key = object_key(settings, rel)
    return _with_retry(lambda: _bucket(settings).blob(key).exists())
