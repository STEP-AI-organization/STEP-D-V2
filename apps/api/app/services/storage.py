from pathlib import Path
from typing import TYPE_CHECKING
from uuid import uuid4

if TYPE_CHECKING:
    from app.core.config import Settings


def safe_job_id() -> str:
    return uuid4().hex


def ensure_job_dirs(settings: "Settings", job_id: str) -> dict[str, Path]:
    root = settings.storage_dir.resolve()
    upload_dir = root / "uploads" / job_id
    job_dir = root / "jobs" / job_id
    dirs = {
        "root": root,
        "upload": upload_dir,
        "job": job_dir,
        "frames": job_dir / "frames",
        "clips": job_dir / "clips",
        "highlights": job_dir / "highlights",
        "thumbnails": job_dir / "thumbnails",
        "transcripts": job_dir / "transcripts",
        "assets": job_dir / "assets",
    }
    for path in dirs.values():
        path.mkdir(parents=True, exist_ok=True)
    return dirs


# Storage-relative second-level dirs (under jobs/<id>/) whose artifacts are
# durable and worth mirroring to GCS. Everything else — uploads/ sources (up to
# 2GB), frames/ (temp), transcripts/ and *.json debug artifacts — stays on the
# local disk and is served same-origin via the /media mount.
_GCS_MIRROR_DIRS = {"clips", "thumbnails", "highlights", "assets"}


def _gcs_enabled(settings: "Settings") -> bool:
    return getattr(settings, "storage_backend", "local") == "gcs" and bool(settings.gcs_bucket)


def _is_mirrored(rel: str) -> bool:
    parts = rel.split("/")
    return len(parts) >= 3 and parts[0] == "jobs" and parts[2] in _GCS_MIRROR_DIRS


def _local_media_url(settings: "Settings", rel: str) -> str:
    url = f"/media/{rel}"
    if settings.public_base_url:
        return settings.public_base_url.rstrip("/") + url
    return url


def media_url(settings: "Settings", path: Path) -> str:
    root = settings.storage_dir.resolve()
    rel = path.resolve().relative_to(root).as_posix()
    # GCS mode: mirror durable artifacts to the bucket and serve them off-VM.
    # Non-mirrored paths (and any file that doesn't exist yet) fall back to the
    # same-origin /media URL so nothing crashes the pipeline.
    if _gcs_enabled(settings) and _is_mirrored(rel) and path.exists():
        from app.services import gcs

        return gcs.upload(settings, rel, path)
    return _local_media_url(settings, rel)


def media_path_from_url(settings: "Settings", url: str) -> Path:
    """Resolve a media URL (as produced by :func:`media_url`) back to a local
    filesystem path inside the storage directory.

    Handles three URL shapes: a same-origin ``/media/<rel>`` URL (optionally
    with a ``public_base_url`` prefix), a GCS public URL (when the gcs backend
    is active), and a bare relative path. Tolerates a cache-busting query
    string (e.g. ``?v=3``). In gcs mode, if the local copy is missing it is
    downloaded from the bucket first so all readers keep working unchanged.
    Raises ``ValueError`` if the URL escapes the storage directory.
    """
    text = str(url or "").split("?", 1)[0].split("#", 1)[0]
    marker = "/media/"
    index = text.find(marker)
    rel: str | None = None
    if index >= 0:
        rel = text[index + len(marker) :]
    elif _gcs_enabled(settings):
        from app.services import gcs

        rel = gcs.rel_from_url(settings, text)
    if rel is None:
        rel = text.lstrip("/")
    root = settings.storage_dir.resolve()
    path = (root / rel).resolve()
    if root not in path.parents and path != root:
        raise ValueError(f"Media URL resolves outside the storage directory: {url}")
    if _gcs_enabled(settings) and not path.exists():
        from app.services import gcs

        gcs.download(settings, rel, path)  # best effort; absent object -> caller sees a missing file
    return path
