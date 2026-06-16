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
        "thumbnails": job_dir / "thumbnails",
        "transcripts": job_dir / "transcripts",
        "assets": job_dir / "assets",
    }
    for path in dirs.values():
        path.mkdir(parents=True, exist_ok=True)
    return dirs


def media_url(settings: "Settings", path: Path) -> str:
    root = settings.storage_dir.resolve()
    rel = path.resolve().relative_to(root).as_posix()
    url = f"/media/{rel}"
    if settings.public_base_url:
        return settings.public_base_url.rstrip("/") + url
    return url


def media_path_from_url(settings: "Settings", url: str) -> Path:
    """Resolve a ``/media/...`` URL (as produced by :func:`media_url`) back to a
    filesystem path inside the storage directory.

    Tolerates an absolute ``public_base_url`` prefix and a cache-busting query
    string (e.g. ``?v=3``). Raises ``ValueError`` if the URL escapes storage.
    """
    text = str(url or "").split("?", 1)[0].split("#", 1)[0]
    marker = "/media/"
    index = text.find(marker)
    rel = text[index + len(marker) :] if index >= 0 else text.lstrip("/")
    root = settings.storage_dir.resolve()
    path = (root / rel).resolve()
    if root not in path.parents and path != root:
        raise ValueError(f"Media URL resolves outside the storage directory: {url}")
    return path
