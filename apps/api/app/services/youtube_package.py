import csv
import json
import zipfile
from io import StringIO
from pathlib import Path
from typing import TYPE_CHECKING

from app.services.storage import ensure_job_dirs
from app.services.clip_briefing import build_clip_briefing
from app.services.clip_signals import build_korean_shorts_signals
from app.services.youtube_metadata import build_youtube_metadata

if TYPE_CHECKING:
    from app.core.config import Settings
    from app.models import Clip


def _clip_media_paths(settings: "Settings", clip: "Clip") -> tuple[Path, Path]:
    dirs = ensure_job_dirs(settings, clip.job_id)
    return dirs["clips"] / f"short_{clip.rank:03d}.mp4", dirs["thumbnails"] / f"short_{clip.rank:03d}.jpg"


def _tags_csv(tags: list[str]) -> str:
    stream = StringIO()
    writer = csv.writer(stream)
    writer.writerow(["tag"])
    for tag in tags:
        writer.writerow([tag])
    return stream.getvalue()


def _checklist(metadata: dict) -> str:
    return "\n".join(
        [
            "YouTube upload checklist",
            "",
            "1. Upload short.mp4 in YouTube Studio.",
            "2. Upload thumbnail.jpg as the custom thumbnail.",
            "3. Paste the title from metadata.json.",
            "4. Paste description.txt into the description field.",
            "5. Paste tags from tags.csv or metadata.json.",
            "6. Confirm privacy, category, made-for-kids, copyright, and platform policy settings before publishing.",
            "",
            f"Suggested privacy: {metadata.get('privacy_status', 'private')}",
            f"Made for kids: {metadata.get('made_for_kids', False)}",
        ]
    )


def _briefing_text(briefing: dict) -> str:
    lines = [
        "Korean Shorts clip briefing",
        "",
        f"Score band: {briefing.get('score_band', '')}",
        f"First 3 seconds: {briefing.get('first_three_seconds', '')}",
        f"Why it works: {briefing.get('why_it_works', '')}",
        "",
        "Retention plan:",
    ]
    lines.extend(f"- {item}" for item in briefing.get("retention_plan", []))
    lines.extend(["", "Risks:"])
    risks = briefing.get("risk_flags", [])
    lines.extend(f"- {item}" for item in risks) if risks else lines.append("- none")
    lines.extend(["", "Upload actions:"])
    lines.extend(f"- {item}" for item in briefing.get("upload_actions", []))
    return "\n".join(lines)


def build_youtube_package(settings: "Settings", clip: "Clip") -> Path:
    dirs = ensure_job_dirs(settings, clip.job_id)
    package_dir = dirs["job"] / "packages"
    package_dir.mkdir(parents=True, exist_ok=True)
    zip_path = package_dir / f"clip_{clip.rank:03d}_youtube_package.zip"
    video_path, thumbnail_path = _clip_media_paths(settings, clip)
    if not video_path.exists():
        raise FileNotFoundError(video_path)
    if not thumbnail_path.exists():
        raise FileNotFoundError(thumbnail_path)
    metadata = build_youtube_metadata(clip)
    signals = build_korean_shorts_signals(clip, metadata)
    briefing = build_clip_briefing(clip, metadata, signals)

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.write(video_path, "short.mp4")
        archive.write(thumbnail_path, "thumbnail.jpg")
        archive.writestr("metadata.json", json.dumps(metadata, ensure_ascii=False, indent=2))
        archive.writestr("clip-briefing.json", json.dumps(briefing, ensure_ascii=False, indent=2))
        archive.writestr("clip-briefing.txt", _briefing_text(briefing))
        archive.writestr("description.txt", metadata.get("description", ""))
        archive.writestr("tags.csv", _tags_csv(metadata.get("tags", [])))
        archive.writestr("upload-checklist.txt", _checklist(metadata))

    return zip_path
