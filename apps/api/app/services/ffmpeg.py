import json
import subprocess
from math import ceil
from pathlib import Path
from typing import Any, Iterable

from app.core.config import Settings


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


def probe_has_audio(video_path: Path, settings: Settings) -> bool:
    try:
        proc = _run(
            [
                settings.ffprobe_binary,
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=index",
                "-of",
                "json",
                str(video_path),
            ],
            timeout=30,
        )
    except Exception:
        return False
    payload = json.loads(proc.stdout or "{}")
    return bool(payload.get("streams"))


def probe_has_subtitle_stream(video_path: Path, settings: Settings) -> bool:
    try:
        proc = _run(
            [
                settings.ffprobe_binary,
                "-v",
                "error",
                "-select_streams",
                "s",
                "-show_entries",
                "stream=index",
                "-of",
                "json",
                str(video_path),
            ],
            timeout=30,
        )
    except Exception:
        return False
    payload = json.loads(proc.stdout or "{}")
    return bool(payload.get("streams"))


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


def _reframe_mode(settings: Settings) -> str:
    return str(getattr(settings, "shorts_reframe_mode", "fit") or "fit").lower().strip()


def _uses_blur_reframe(settings: Settings) -> bool:
    return bool(settings.render_vertical_shorts) and _reframe_mode(settings) == "blur"


def _blur_background_base_filter(settings: Settings, input_label: str = "[0:v]", output_label: str = "[base]") -> str:
    blur = max(4, min(80, int(getattr(settings, "shorts_blur_background_strength", 24) or 24)))
    return (
        f"{input_label}split=2[fg][bg];"
        f"[bg]scale={settings.shorts_width}:{settings.shorts_height}:force_original_aspect_ratio=increase,"
        f"crop={settings.shorts_width}:{settings.shorts_height},boxblur={blur}:2,setsar=1[bg];"
        f"[fg]scale={settings.shorts_width}:{settings.shorts_height}:force_original_aspect_ratio=decrease,setsar=1[fg];"
        f"[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto{output_label}"
    )


def _filter_path(path: Path) -> str:
    return str(path.resolve()).replace("\\", "/").replace(":", "\\:").replace("'", "\\'")


def _asset_fonts_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "assets" / "fonts"


def _font_path(settings: Settings) -> Path | None:
    candidates = [
        Path(settings.shorts_title_font_file) if settings.shorts_title_font_file else None,
        _asset_fonts_dir() / "GmarketSansTTFBold.ttf",
        Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"),
        Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
        Path("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"),
        Path("C:/Windows/Fonts/malgun.ttf"),
        Path("C:/Windows/Fonts/malgunbd.ttf"),
        Path("C:/Windows/Fonts/arial.ttf"),
    ]
    for candidate in candidates:
        if candidate and candidate.exists():
            return candidate
    return None


def _wrap_title(text: str, settings: Settings) -> str:
    cleaned = " ".join(str(text or "").split())
    if not cleaned:
        return ""

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
    return "\n".join(lines[:max_lines])


def _write_title_file(output_path: Path, title_text: str | None, settings: Settings) -> Path | None:
    if not settings.shorts_title_overlay or not title_text:
        return None
    wrapped = _wrap_title(title_text, settings)
    if not wrapped:
        return None
    title_path = output_path.with_suffix(output_path.suffix + ".title.txt")
    title_path.write_text(wrapped, encoding="utf-8")
    return title_path


def _write_text_file(output_path: Path, suffix: str, text: str | None) -> Path | None:
    cleaned = " ".join(str(text or "").split())
    if not cleaned:
        return None
    text_path = output_path.with_suffix(output_path.suffix + suffix)
    text_path.write_text(cleaned, encoding="utf-8")
    return text_path


def _drawtext_filter(title_file: Path, settings: Settings) -> str:
    font = _font_path(settings)
    font_option = f"fontfile='{_filter_path(font)}':" if font else ""
    font_size = max(24, ceil(settings.shorts_title_font_size * settings.shorts_width / 1080))
    y = max(20, ceil(settings.shorts_height * settings.shorts_title_y_ratio))
    border = max(10, ceil(settings.shorts_title_box_border * settings.shorts_width / 1080))
    return (
        "drawtext="
        f"{font_option}"
        f"textfile='{_filter_path(title_file)}':"
        "x=(w-text_w)/2:"
        f"y={y}:"
        f"fontsize={font_size}:"
        "fontcolor=white:"
        f"line_spacing={settings.shorts_title_line_spacing}:"
        "box=1:"
        "boxcolor=black@0.42:"
        f"boxborderw={border}:"
        "shadowcolor=black@0.85:"
        "shadowx=2:"
        "shadowy=2"
    )


def _subtitle_fonts_dir(settings: Settings) -> Path | None:
    configured = str(getattr(settings, "shorts_subtitle_fonts_dir", "") or "").strip()
    candidates = [Path(configured)] if configured else []
    candidates.append(_asset_fonts_dir())
    for candidate in candidates:
        if candidate.exists() and candidate.is_dir():
            return candidate
    return None


def _ass_filter(subtitle_path: Path | None, settings: Settings) -> str:
    if not subtitle_path:
        return ""
    value = f"ass='{_filter_path(subtitle_path)}'"
    fonts_dir = _subtitle_fonts_dir(settings)
    if fonts_dir:
        value += f":fontsdir='{_filter_path(fonts_dir)}'"
    return value


def _overlay_position(position: str, margin: int = 44) -> tuple[str, str]:
    if position == "top_left":
        return str(margin), str(margin)
    if position == "bottom_left":
        return str(margin), f"main_h-overlay_h-{margin}"
    if position == "bottom_right":
        return f"main_w-overlay_w-{margin}", f"main_h-overlay_h-{margin}"
    if position == "top_center":
        return "(main_w-overlay_w)/2", str(margin)
    return f"main_w-overlay_w-{margin}", str(margin)


def _drawtext_position(position: str, margin: int = 44) -> tuple[str, str]:
    if position == "top_left":
        return str(margin), str(margin)
    if position == "bottom_left":
        return str(margin), f"h-text_h-{margin}"
    if position == "bottom_right":
        return f"w-text_w-{margin}", f"h-text_h-{margin}"
    if position == "top_center":
        return "(w-text_w)/2", str(margin)
    return f"w-text_w-{margin}", str(margin)


def _badge_filter(badge_file: Path | None, settings: Settings, creative_settings: dict[str, Any] | None) -> str:
    if not badge_file or not creative_settings:
        return ""
    font = _font_path(settings)
    font_option = f"fontfile='{_filter_path(font)}':" if font else ""
    position = str(creative_settings.get("overlay_position") or creative_settings.get("position") or "top_right")
    x, y = _drawtext_position(position)
    scale = max(0.06, min(0.24, float(creative_settings.get("overlay_scale") or creative_settings.get("scale") or 0.12)))
    font_size = max(18, ceil(settings.shorts_width * scale * 0.28))
    border = max(8, ceil(settings.shorts_width * 0.012))
    return (
        "drawtext="
        f"{font_option}"
        f"textfile='{_filter_path(badge_file)}':"
        f"x={x}:"
        f"y={y}:"
        f"fontsize={font_size}:"
        "fontcolor=white:"
        "box=1:"
        "boxcolor=black@0.54:"
        f"boxborderw={border}:"
        "shadowcolor=black@0.8:"
        "shadowx=1:"
        "shadowy=1"
    )


def _vertical_filter(settings: Settings, title_file: Path | None = None, include_format: bool = True) -> str:
    mode = _reframe_mode(settings)
    filters = [_crop_filter(settings) if mode == "crop" else _fit_filter(settings)]
    if title_file:
        filters.append(_drawtext_filter(title_file, settings))
    if include_format:
        filters.append("format=yuv420p")
    return ",".join(filters)


def _bounded_fade_seconds(value: float, duration: float) -> float:
    fade = max(0.0, float(value or 0.0))
    if fade <= 0.0 or duration <= 0.2:
        return 0.0
    return min(fade, duration / 3)


def _video_fade_filters(settings: Settings, duration: float) -> list[str]:
    fade = _bounded_fade_seconds(getattr(settings, "shorts_video_fade_seconds", 0.0), duration)
    if fade <= 0.0:
        return []
    out_start = max(0.0, duration - fade)
    return [
        f"fade=t=in:st=0:d={fade:.3f}",
        f"fade=t=out:st={out_start:.3f}:d={fade:.3f}",
    ]


def _clip_video_filter(
    settings: Settings,
    title_file: Path | None,
    duration: float,
    creative_settings: dict[str, Any] | None = None,
    badge_file: Path | None = None,
    include_fade: bool = True,
    subtitle_path: Path | None = None,
) -> str:
    filters: list[str] = []
    if settings.render_vertical_shorts:
        filters.append(_vertical_filter(settings, title_file, include_format=False))
    subtitle_filter = _ass_filter(subtitle_path, settings)
    if subtitle_filter:
        filters.append(subtitle_filter)
    badge = _badge_filter(badge_file, settings, creative_settings)
    if badge:
        filters.append(badge)
    if include_fade:
        filters.extend(_video_fade_filters(settings, duration))
    if filters:
        filters.append("format=yuv420p")
    return ",".join(filters)


def _post_base_filter(
    settings: Settings,
    title_file: Path | None,
    duration: float,
    creative_settings: dict[str, Any] | None = None,
    badge_file: Path | None = None,
    include_fade: bool = True,
    subtitle_path: Path | None = None,
    include_format: bool = True,
) -> str:
    filters: list[str] = []
    if title_file:
        filters.append(_drawtext_filter(title_file, settings))
    subtitle_filter = _ass_filter(subtitle_path, settings)
    if subtitle_filter:
        filters.append(subtitle_filter)
    badge = _badge_filter(badge_file, settings, creative_settings)
    if badge:
        filters.append(badge)
    if include_fade:
        filters.extend(_video_fade_filters(settings, duration))
    if include_format:
        filters.append("format=yuv420p")
    return ",".join(filters)


def _blur_clip_filter_complex(
    settings: Settings,
    title_file: Path | None,
    duration: float,
    creative_settings: dict[str, Any] | None = None,
    badge_file: Path | None = None,
    include_fade: bool = True,
    subtitle_path: Path | None = None,
    output_label: str = "[v]",
) -> str:
    base = _blur_background_base_filter(settings, "[0:v]", "[base]")
    post = _post_base_filter(
        settings,
        title_file,
        duration,
        creative_settings,
        badge_file,
        include_fade=include_fade,
        subtitle_path=subtitle_path,
        include_format=True,
    )
    return f"{base};[base]{post}{output_label}"


def _image_overlay_filter(
    settings: Settings,
    title_file: Path | None,
    duration: float,
    creative_settings: dict[str, Any] | None,
    include_fade: bool = True,
    subtitle_path: Path | None = None,
) -> str:
    if _uses_blur_reframe(settings):
        base_filter = _blur_background_base_filter(settings, "[0:v]", "[base0]")
        post_filter = _post_base_filter(
            settings,
            title_file,
            duration,
            include_fade=include_fade,
            subtitle_path=subtitle_path,
            include_format=False,
        )
        base_stage = f"{base_filter};[base0]{post_filter}[base]" if post_filter else f"{base_filter};[base0]null[base]"
    else:
        base_filter = _clip_video_filter(
            settings,
            title_file,
            duration,
            None,
            None,
            include_fade=False,
            subtitle_path=subtitle_path,
        )
        if base_filter.endswith(",format=yuv420p"):
            base_filter = base_filter[: -len(",format=yuv420p")]
        if include_fade:
            fade_filters = _video_fade_filters(settings, duration)
            if fade_filters:
                base_filter = ",".join([part for part in [base_filter, *fade_filters] if part])
        if not base_filter:
            base_filter = "null"
        base_stage = f"[0:v]{base_filter}[base]"

    creative_settings = creative_settings or {}
    scale = max(0.04, min(0.4, float(creative_settings.get("overlay_scale") or creative_settings.get("scale") or 0.12)))
    opacity = max(0.1, min(1.0, float(creative_settings.get("overlay_opacity") or 0.92)))
    overlay_width = max(24, ceil(settings.shorts_width * scale))
    position = str(creative_settings.get("overlay_position") or creative_settings.get("position") or "top_right")
    x, y = _overlay_position(position)
    return (
        f"{base_stage};"
        f"[1:v]scale={overlay_width}:-1:force_original_aspect_ratio=decrease,"
        f"format=rgba,colorchannelmixer=aa={opacity:.3f}[overlay_asset];"
        f"[base][overlay_asset]overlay=x={x}:y={y}:format=auto,format=yuv420p[v]"
    )


def _audio_fade_filter(settings: Settings, duration: float) -> str:
    fade = _bounded_fade_seconds(getattr(settings, "shorts_audio_fade_seconds", 0.0), duration)
    if fade <= 0.0:
        return ""
    out_start = max(0.0, duration - fade)
    return f"afade=t=in:st=0:d={fade:.3f},afade=t=out:st={out_start:.3f}:d={fade:.3f}"


def _replace_filter_arg(args: list[str], option: str, value: str) -> list[str]:
    next_args = args.copy()
    if option in next_args:
        next_args[next_args.index(option) + 1] = value
    return next_args


def _remove_filter_arg(args: list[str], option: str) -> list[str]:
    if option not in args:
        return args.copy()
    index = args.index(option)
    return args[:index] + args[index + 2 :]


def _run_with_fallbacks(
    args: list[str],
    settings: Settings,
    title_file: Path | None,
    subtitle_path: Path | None,
    duration: float,
) -> None:
    attempts = [args]
    if (title_file or subtitle_path) and "-vf" in args:
        attempts.append(_replace_filter_arg(args, "-vf", _clip_video_filter(settings, None, duration)))
    if "-af" in args:
        attempts.append(_remove_filter_arg(args, "-af"))
        if (title_file or subtitle_path) and "-vf" in args:
            attempts.append(_replace_filter_arg(_remove_filter_arg(args, "-af"), "-vf", _clip_video_filter(settings, None, duration)))

    last_error: FFmpegError | None = None
    seen: set[tuple[str, ...]] = set()
    for attempt in attempts:
        key = tuple(attempt)
        if key in seen:
            continue
        seen.add(key)
        try:
            _run(attempt, timeout=None)
            return
        except FFmpegError as exc:
            last_error = exc
    if last_error:
        raise last_error


def cut_clip(
    video_path: Path,
    output_path: Path,
    start: float,
    end: float,
    settings: Settings,
    title_text: str | None = None,
    creative_settings: dict[str, Any] | None = None,
    overlay_asset_path: Path | None = None,
    subtitle_path: Path | None = None,
) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    duration = max(0.1, end - start)
    title_file = _write_title_file(output_path, title_text, settings)
    badge_text = "" if overlay_asset_path else str((creative_settings or {}).get("badge_text") or "")
    badge_file = _write_text_file(output_path, ".badge.txt", badge_text)
    args = [
        settings.ffmpeg_binary,
        "-y",
        "-ss",
        f"{start:.3f}",
        "-i",
        str(video_path),
    ]
    if overlay_asset_path:
        args.extend(["-loop", "1", "-i", str(overlay_asset_path)])
        args.extend(
            [
                "-filter_complex",
                _image_overlay_filter(settings, title_file, duration, creative_settings, include_fade=True, subtitle_path=subtitle_path),
                "-map",
                "[v]",
                "-map",
                "0:a?",
            ]
        )
    else:
        if _uses_blur_reframe(settings):
            args.extend(
                [
                    "-filter_complex",
                    _blur_clip_filter_complex(settings, title_file, duration, creative_settings, badge_file, subtitle_path=subtitle_path),
                    "-map",
                    "[v]",
                    "-map",
                    "0:a?",
                ]
            )
        else:
            args.extend(["-map", "0:v:0", "-map", "0:a?"])
            video_filter = _clip_video_filter(settings, title_file, duration, creative_settings, badge_file, subtitle_path=subtitle_path)
            if video_filter:
                args.extend(["-vf", video_filter])
    args.extend(["-t", f"{duration:.3f}"])
    if probe_has_audio(video_path, settings):
        audio_filter = _audio_fade_filter(settings, duration)
        if audio_filter:
            args.extend(["-af", audio_filter])
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
    _run_with_fallbacks(args, settings, title_file, subtitle_path, duration)
    return output_path


def extract_thumbnail(
    video_path: Path,
    output_path: Path,
    seconds: float,
    settings: Settings,
    title_text: str | None = None,
    creative_settings: dict[str, Any] | None = None,
    overlay_asset_path: Path | None = None,
) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    title_file = _write_title_file(output_path, title_text, settings)
    badge_text = "" if overlay_asset_path else str((creative_settings or {}).get("badge_text") or "")
    badge_file = _write_text_file(output_path, ".badge.txt", badge_text)
    args = [
        settings.ffmpeg_binary,
        "-y",
        "-ss",
        f"{max(0.0, seconds):.3f}",
        "-i",
        str(video_path),
    ]
    if overlay_asset_path:
        args.extend(["-loop", "1", "-i", str(overlay_asset_path)])
        args.extend(
            [
                "-filter_complex",
                _image_overlay_filter(settings, title_file, 1.0, creative_settings, include_fade=False),
                "-map",
                "[v]",
            ]
        )
    elif _uses_blur_reframe(settings):
        args.extend(
            [
                "-filter_complex",
                _blur_clip_filter_complex(settings, title_file, 1.0, creative_settings, badge_file, include_fade=False),
                "-map",
                "[v]",
            ]
        )
    elif settings.render_vertical_shorts:
        args.extend(["-vf", _clip_video_filter(settings, title_file, 1.0, creative_settings, badge_file, include_fade=False)])
    args.extend(["-frames:v", "1"])
    args.extend(["-q:v", "2", str(output_path)])
    try:
        _run(args, timeout=60)
    except FFmpegError:
        if not title_file or "-vf" not in args:
            raise
        fallback_args = args.copy()
        vf_index = fallback_args.index("-vf")
        fallback_args[vf_index + 1] = _vertical_filter(settings, None)
        _run(fallback_args, timeout=60)
    return output_path
