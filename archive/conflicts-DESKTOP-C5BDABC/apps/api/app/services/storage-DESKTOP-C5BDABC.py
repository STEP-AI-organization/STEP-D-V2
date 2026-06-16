from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

from app.core.config import Settings


def safe_job_id() -> str:
    return uuid4().hex


def ensure_job_dirs(settings: Settings, job_id: str) -> dict[str, Path]:
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
    }
    for path in dirs.values():
        path.mkdir(parents=True, exist_ok=True)
    return dirs


def media_url(settings: Settings, path: Path) -> str:
    root = settings.storage_dir.resolve()
    rel = path.resolve().relative_to(root).as_posix()
    url = f"/media/{rel}"
    if settings.public_base_url:
        return settings.public_base_url.rstrip("/") + url
    return url


def media_path_from_url(settings: Settings, url: str) -> Path:
    parsed_path = urlparse(url).path
    marker = "/media/"
    if marker not in parsed_path:
        raise ValueError(f"URL is not a local media URL: {url}")
    rel = parsed_path.split(marker, 1)[1]
    path = (settings.storage_dir.resolve() / rel).resolve()
    root = settings.storage_dir.resolve()
    path.relative_to(root)
    return path
