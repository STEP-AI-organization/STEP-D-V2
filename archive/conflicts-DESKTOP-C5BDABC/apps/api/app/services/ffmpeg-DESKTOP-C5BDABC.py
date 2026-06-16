import json
import shutil
import subprocess
from math import ceil
from pathlib import Path
from typing import Any, Iterable

from app.core.config import Settings


API_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = API_ROOT.parents[1]


class FFmpegError(RuntimeError):
    pass


def _run(args: list[str], timeout: int | None = None) -> subprocess.CompletedProcess:
    proc = subprocess.run(
        args,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    if proc.returncode != 0:
        message = proc.stderr.strip() or proc.stdout.strip() or "FFmpeg command failed"
        raise FFmpegError(message)
    return proc


def ffmpeg_available(settings: Settings) -> bool:
    try:
        _run([settings.ffmpeg_binary, "-version"], timeout=5)
        _run([settings.ffprobe_binary, "-version"], timeout=5)
        return True
    except Exception:
        return False


def probe_duration(video_path: Path, settings: Settings) -> float:
    proc = _run(
        [
            settings.ffprobe_binary,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(video_path),
        ],
        timeout=30,
    )
    payload = json.loads(proc.stdout)
    return float(payload["format"]["duration"])


def extract_audio(video_path: Path, audio_path: Path, settings: Settings) -> Path:
    audio_path.parent.mkdir(parents=True, exist_ok=True)
    args = [
        settings.ffmpeg_binary,
        "-y",
        "-i",
        str(video_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
    ]
    if settings.ffmpeg_audio_filter:
        args.extend(["-af", settings.ffmpeg_audio_filter])
    args.extend(["-c:a", "pcm_s16le", str(audio_path)])
    _run(args, timeout=None)
    return audio_path


def split_audio(audio_path: Path, chunks_dir: Path, settings: Settings, chunk_seconds: int = 600) -> list[Path]:
    chunks_dir.mkdir(parents=True, exist_ok=True)
    pattern = chunks_dir / "chunk_%03d.wav"
    _run(
        [
            settings.ffmpeg_binary,
            "-y",
            "-i",
            str(audio_path),
            "-f",
            "segment",
            "-segment_time",
            str(chunk_seconds),
            "-c",
            "copy",
            str(pattern),
        ],
        timeout=None,
    )
    return sorted(chunks_dir.glob("chunk_*.wav"))


def extract_frames(
    video_path: Path,
    output_dir: Path,
    times: Iterable[float],
    settings: Settings,
    prefix: str,
) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for index, seconds in enumerate(times, start=1):
        frame_path = output_dir / f"{prefix}_{index:02d}_{seconds:.2f}.jpg"
        _run(
            [
                settings.ffmpeg_binary,
                "-y",
                "-ss",
                f"{max(0.0, seconds):.3f}",
                "-i",
                str(video_path),
                "-frames:v",
                "1",
                "-q:v",
                "2",
                str(frame_path),
            ],
            timeout=60,
        )
        paths.append(frame_path)
    return paths


def _fit_filter(settings: Settings) -> str:
    return (
        f"scale={settings.shorts_width}:{settings.shorts_height}:force_original_aspect_ratio=decrease,"
        f"pad={settings.shorts_width}:{settings.shorts_height}:(ow-iw)/2:(oh-ih)/2:{settings.shorts_background_color},"
        "setsar=1"
    )


def _crop_filter(settings: Settings) -> str:
    return (
        f"scale={settings.shorts_width}:{settings.shorts_height}:force_original_aspect_ratio=increase,"
        f"crop={settings.shorts_width}:{settings.shorts_height},setsar=1"
    )


def _filter_path(path: Path) -> str:
    return str(path.resolve()).replace("\\", "/").replace(":", "\\:").replace("'", "\\'")


def _drawtext_text(text: str) -> str:
    return (
        str(text)
        .replace("\\", "\\\\")
        .replace("'", "\\'")
        .replace(":", "\\:")
        .replace("%", "\\%")
    )


def _font_path(settings: Settings) -> Path | None:
    configured = Path(settings.shorts_title_font_file) if settings.shorts_title_font_file else None
    candidates = [
        configured,
        API_ROOT / "assets" / "fonts" / "GmarketSansTTFBold.ttf",
        REPO_ROOT / "apps" / "api" / "assets" / "fonts" / "GmarketSansTTFBold.ttf",
        Path("C:/Windows/Fonts/NotoSansKR-VF.ttf"),
        Path("C:/Windows/Fonts/malgunbd.ttf"),
        Path("C:/Windows/Fonts/malgun.ttf"),
        Path("C:/Windows/Fonts/arial.ttf"),
    ]
    for candidate in candidates:
        if candidate and candidate.exists():
            return candidate
    return None


def _wrap_title_lines(text: str, settings: Settings) -> list[str]:
    cleaned = " ".join(str(text or "").split())
    if not cleaned:
        return []

    max_chars = max(8, settings.shorts_title_max_chars_per_line)
    max_lines = max(1, settings.shorts_title_max_lines)
    words = cleaned.split(" ")
    lines: list[str] = []
    current = ""

    for word in words:
        if len(word) > max_chars:
            chunks = [word[index : index + max_chars] for index in range(0, len(word), max_chars)]
        else:
            chunks = [word]
        for chunk in chunks:
            next_line = chunk if not current else f"{current} {chunk}"
            if len(next_line) <= max_chars:
                current = next_line
                continue
            if current:
                lines.append(current)
            current = chunk
            if len(lines) >= max_lines:
                break
        if len(lines) >= max_lines:
            break

    if current and len(lines) < max_lines:
        lines.append(current)

    consumed = " ".join(lines)
    if len(consumed) < len(cleaned) and lines:
        lines[-1] = lines[-1][: max(1, max_chars - 1)].rstrip() + "..."
    return lines[:max_lines]


def _title_lines(title_text: str | None, settings: Settings) -> list[str]:
    if not settings.shorts_title_overlay or not title_text:
        return []
    return [line for line in _wrap_title_lines(title_text, settings) if line]


def _drawtext_filter(text: str, settings: Settings, line_index: int, line_count: int) -> str:
    font = _font_path(settings)
    font_option = f"fontfile='{_filter_path(font)}':" if font else ""
    font_size = max(24, ceil(settings.shorts_title_font_size * settings.shorts_width / 1080))
    line_gap = font_size + settings.shorts_title_line_spacing
    total_height = line_count * font_size + max(0, line_count - 1) * settings.shorts_title_line_spacing
    anchor_y = max(20, ceil(settings.shorts_height * settings.shorts_title_y_ratio))
    y = max(20, anchor_y + line_index * line_gap - total_height // 2)
    border = max(10, ceil(settings.shorts_title_box_border * settings.shorts_width / 1080))
    outline = max(0, ceil(settings.shorts_title_outline_width * settings.shorts_width / 1080))
    color = settings.shorts_title_accent_color if line_index == line_count - 1 and line_count > 1 else settings.shorts_title_primary_color
    box = "1" if settings.shorts_title_box else "0"
    return (
        "drawtext="
        f"{font_option}"
        f"text='{_drawtext_text(text)}':"
        "x=(w-text_w)/2:"
        f"y={y}:"
        f"fontsize={font_size}:"
        f"fontcolor={color}:"
        f"borderw={outline}:"
        f"bordercolor={settings.shorts_title_outline_color}:"
        f"box={box}:"
        "boxcolor=black@0.34:"
        f"boxborderw={border}:"
        "shadowcolor=black@0.85:"
        "shadowx=2:"
        "shadowy=2"
    )


def _editor_drawtext_filter(overlay: dict[str, Any], settings: Settings) -> str:
    font = _font_path(settings)
    font_option = f"fontfile='{_filter_path(font)}':" if font else ""
    text = str(overlay.get("text") or "").strip()
    if not text:
        return ""
    font_size = max(12, int(overlay.get("fontSize") or 64))
    x = max(0, int(overlay.get("x") or 0))
    y = max(0, int(overlay.get("y") or 0))
    color = str(overlay.get("color") or "white")
    stroke_color = str(overlay.get("strokeColor") or "black")
    stroke_width = max(0, int(overlay.get("strokeWidth") or 0))
    alpha = float(overlay.get("opacity") if overlay.get("opacity") is not None else 1)
    alpha = max(0.0, min(1.0, alpha))
    return (
        "drawtext="
        f"{font_option}"
        f"text='{_drawtext_text(text)}':"
        f"x={x}:"
        f"y={y}:"
        f"fontsize={font_size}:"
        f"fontcolor={color}@{alpha:.3f}:"
        f"borderw={stroke_width}:"
        f"bordercolor={stroke_color}:"
        "shadowcolor=black@0.65:"
        "shadowx=2:"
        "shadowy=2"
    )


def _vertical_filter(
    settings: Settings,
    title_lines: list[str] | None = None,
    text_overlays: list[dict[str, Any]] | None = None,
) -> str:
    mode = settings.shorts_reframe_mode.lower().strip()
    filters = [_crop_filter(settings) if mode == "crop" else _fit_filter(settings)]
    if title_lines:
        line_count = len(title_lines)
        for line_index, text in enumerate(title_lines):
            filters.append(_drawtext_filter(text, settings, line_index, line_count))
    for overlay in text_overlays or []:
        overlay_filter = _editor_drawtext_filter(overlay, settings)
        if overlay_filter:
            filters.append(overlay_filter)
    filters.append("format=yuv420p")
    return ",".join(filters)


def _cut_raw_segment(video_path: Path, output_path: Path, start: float, end: float, settings: Settings) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    duration = max(0.1, end - start)
    _run(
        [
            settings.ffmpeg_binary,
            "-y",
            "-ss",
            f"{start:.3f}",
            "-i",
            str(video_path),
            "-t",
            f"{duration:.3f}",
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            str(output_path),
        ],
        timeout=None,
    )
    return output_path


def _concat_files(paths: list[Path], output_path: Path, settings: Settings) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    list_path = output_path.with_suffix(".txt")
    lines = []
    for path in paths:
        safe_path = str(path.resolve()).replace("\\", "/").replace("'", "'\\''")
        lines.append(f"file '{safe_path}'")
    list_path.write_text("\n".join(lines), encoding="utf-8")
    _run(
        [
            settings.ffmpeg_binary,
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(list_path),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            str(output_path),
        ],
        timeout=None,
    )
    return output_path


def cut_clip(
    video_path: Path,
    output_path: Path,
    start: float,
    end: float,
    settings: Settings,
    title_text: str | None = None,
    text_overlays: list[dict[str, Any]] | None = None,
) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    duration = max(0.1, end - start)
    title_lines = _title_lines(title_text, settings)
    args = [
        settings.ffmpeg_binary,
        "-y",
        "-ss",
        f"{start:.3f}",
        "-i",
        str(video_path),
        "-t",
        f"{duration:.3f}",
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
    ]
    if settings.render_vertical_shorts:
        args.extend(["-vf", _vertical_filter(settings, title_lines, text_overlays)])
    args.extend(
        [
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            str(output_path),
        ]
    )
    try:
        _run(args, timeout=None)
    except FFmpegError:
        if not title_lines or "-vf" not in args or not settings.shorts_title_overlay_fallback:
            raise
        fallback_args = args.copy()
        vf_index = fallback_args.index("-vf")
        fallback_args[vf_index + 1] = _vertical_filter(settings, [])
        _run(fallback_args, timeout=None)
    return output_path


def render_segments(
    video_path: Path,
    output_path: Path,
    segments: list[dict[str, float]],
    settings: Settings,
    title_text: str | None = None,
    text_overlays: list[dict[str, Any]] | None = None,
) -> Path:
    normalized = [
        {
            "start": max(0.0, float(segment.get("start") or 0.0)),
            "end": max(0.0, float(segment.get("end") or 0.0)),
        }
        for segment in segments
    ]
    normalized = [segment for segment in normalized if segment["end"] - segment["start"] > 0.05]
    if not normalized:
        raise FFmpegError("No valid editor segments to render.")
    if len(normalized) == 1:
        segment = normalized[0]
        return cut_clip(
            video_path,
            output_path,
            segment["start"],
            segment["end"],
            settings,
            title_text=title_text,
            text_overlays=text_overlays,
        )

    tmp_dir = output_path.with_name(f"{output_path.stem}_edit_parts")
    shutil.rmtree(tmp_dir, ignore_errors=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)
    try:
        parts: list[Path] = []
        for index, segment in enumerate(normalized, start=1):
            part_path = tmp_dir / f"part_{index:03d}.mp4"
            parts.append(_cut_raw_segment(video_path, part_path, segment["start"], segment["end"], settings))
        joined = _concat_files(parts, tmp_dir / "joined.mp4", settings)
        total = sum(segment["end"] - segment["start"] for segment in normalized)
        return cut_clip(joined, output_path, 0.0, total, settings, title_text=title_text, text_overlays=text_overlays)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def extract_thumbnail(
    video_path: Path,
    output_path: Path,
    seconds: float,
    settings: Settings,
    title_text: str | None = None,
    text_overlays: list[dict[str, Any]] | None = None,
) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    title_lines = _title_lines(title_text, settings)
    args = [
        settings.ffmpeg_binary,
        "-y",
        "-ss",
        f"{max(0.0, seconds):.3f}",
        "-i",
        str(video_path),
        "-frames:v",
        "1",
    ]
    if settings.render_vertical_shorts:
        args.extend(["-vf", _vertical_filter(settings, title_lines, text_overlays)])
    args.extend(["-q:v", "2", str(output_path)])
    try:
        _run(args, timeout=60)
    except FFmpegError:
        if not title_lines or "-vf" not in args or not settings.shorts_title_overlay_fallback:
            raise
        fallback_args = args.copy()
        vf_index = fallback_args.index("-vf")
        fallback_args[vf_index + 1] = _vertical_filter(settings, [])
        _run(fallback_args, timeout=60)
    return output_path
