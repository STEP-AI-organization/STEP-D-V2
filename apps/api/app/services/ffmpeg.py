import hashlib
import json
import shutil
import subprocess
import tempfile
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
                "-i",
                str(video_path),
                "-ss",
                f"{max(0.0, seconds):.3f}",
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
    return str(getattr(settings, "shorts_reframe_mode", "blur") or "blur").lower().strip()


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


# drawtext's ``fontfile=`` is opened by freetype with a narrow ``fopen``, which fails on
# Windows when the absolute path contains non-ASCII characters (e.g. a Korean project
# folder). ffmpeg then falls back to fontconfig — unconfigured on Windows builds — and
# crashes (exit 139). Stage such fonts in an ASCII-only directory so freetype can open them.
_ascii_font_cache: dict[str, Path] = {}


def _ascii_safe_font(path: Path) -> Path:
    resolved = path.resolve()
    if str(resolved).isascii():
        return resolved
    cached = _ascii_font_cache.get(str(resolved))
    if cached and cached.exists():
        return cached
    base = next(
        (b for b in (Path(tempfile.gettempdir()), Path("C:/Users/Public"), Path("C:/Windows/Temp")) if str(b).isascii()),
        Path(tempfile.gettempdir()),
    )
    target_dir = base / "aishorts_fonts"
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
        digest = hashlib.md5(str(resolved).encode("utf-8")).hexdigest()[:8]
        suffix = resolved.suffix if resolved.suffix.isascii() else ".ttf"
        stem = resolved.stem if resolved.stem.isascii() else "font"
        target = target_dir / f"{stem}_{digest}{suffix}"
        if not target.exists() or target.stat().st_size != resolved.stat().st_size:
            shutil.copyfile(resolved, target)
    except OSError:
        return resolved  # fall back to the original path; better a font warning than a hard crash
    _ascii_font_cache[str(resolved)] = target
    return target


# Editor font keys ("bold"/"medium"/"light") map to the bundled Gmarket weights
# so a per-line font choice in the editor bakes with the matching face.
_OVERLAY_FONT_FILES = {
    "bold": "GmarketSansTTFBold.ttf",
    "medium": "GmarketSansTTFMedium.ttf",
    "light": "GmarketSansTTFLight.ttf",
}


def _overlay_font_path(settings: Settings, font_key: Any) -> Path | None:
    """Resolve an editor overlay's font key to a bundled weight, else the default."""
    filename = _OVERLAY_FONT_FILES.get(str(font_key or "").strip().lower())
    if filename:
        candidate = _asset_fonts_dir() / filename
        if candidate.exists():
            return _ascii_safe_font(candidate)
    return _font_path(settings)


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
            return _ascii_safe_font(candidate)
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
    # Write raw bytes so Windows text-mode newline translation can't turn the
    # line breaks into CRLF. ffmpeg drawtext renders a stray "\r" as a .notdef
    # tofu box (□) at the end of each wrapped line.
    title_path.write_bytes(wrapped.encode("utf-8"))
    return title_path


def _write_text_file(output_path: Path, suffix: str, text: str | None) -> Path | None:
    cleaned = " ".join(str(text or "").split())
    if not cleaned:
        return None
    text_path = output_path.with_suffix(output_path.suffix + suffix)
    text_path.write_text(cleaned, encoding="utf-8")
    return text_path


def _split_line_files(text_file: Path) -> list[Path]:
    """ffmpeg's drawtext in this build renders a literal newline as a .notdef
    tofu box (□) at the line break. To draw multi-line text cleanly we split it
    into one file per line and stack separate drawtext filters, instead of
    relying on a "\\n" inside a single drawtext."""
    try:
        content = text_file.read_text(encoding="utf-8")
    except OSError:
        return [text_file]
    lines = [line for line in content.replace("\r\n", "\n").replace("\r", "\n").split("\n") if line.strip()]
    if len(lines) <= 1:
        return [text_file]
    paths: list[Path] = []
    for index, line in enumerate(lines):
        line_path = text_file.with_suffix(text_file.suffix + f".l{index:02d}")
        line_path.write_bytes(line.encode("utf-8"))
        paths.append(line_path)
    return paths


def _drawtext_filter(title_file: Path, settings: Settings) -> str:
    font = _font_path(settings)
    font_option = f"fontfile='{_filter_path(font)}':" if font else ""
    font_size = max(24, ceil(settings.shorts_title_font_size * settings.shorts_width / 1080))
    y0 = max(20, ceil(settings.shorts_height * settings.shorts_title_y_ratio))
    border = max(10, ceil(settings.shorts_title_box_border * settings.shorts_width / 1080))
    line_h = font_size + max(0, int(settings.shorts_title_line_spacing))
    drawtexts = [
        "drawtext="
        f"{font_option}"
        f"textfile='{_filter_path(line_file)}':"
        "x=(w-text_w)/2:"
        f"y={y0 + index * line_h}:"
        f"fontsize={font_size}:"
        "fontcolor=white:"
        "box=1:"
        "boxcolor=black@0.42:"
        f"boxborderw={border}:"
        "shadowcolor=black@0.85:"
        "shadowx=2:"
        "shadowy=2"
        for index, line_file in enumerate(_split_line_files(title_file))
    ]
    return ",".join(drawtexts)


def _safe_color(value: object, default: str = "0xFFFFFF") -> str:
    text = str(value or "").strip()
    if text.startswith("#"):
        text = text[1:]
    if len(text) == 3 and all(ch in "0123456789abcdefABCDEF" for ch in text):
        text = "".join(ch * 2 for ch in text)
    if len(text) == 6 and all(ch in "0123456789abcdefABCDEF" for ch in text):
        return f"0x{text.upper()}"
    if str(default).startswith("#"):
        return _safe_color(default, "0xFFFFFF")
    return default


def _safe_float(value: object, default: float, low: float, high: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = default
    return max(low, min(high, parsed))


def _scale_preview_px(settings: Settings, px: float) -> int:
    return max(1, ceil(px * settings.shorts_height / 720))


def _editor_text_x_expr(item: dict[str, Any]) -> str:
    x = _safe_float(item.get("x"), 0.0, -20.0, 120.0) / 100
    width = _safe_float(item.get("widthPct"), 0.0, 0.0, 100.0) / 100
    align = str(item.get("align") or "left").lower()
    if width > 0 and align == "center":
        return f"w*{x + width / 2:.6f}-text_w/2"
    if width > 0 and align == "right":
        return f"w*{x + width:.6f}-text_w"
    return f"w*{x:.6f}"


def _editor_text_y_expr(item: dict[str, Any]) -> str:
    y = _safe_float(item.get("y"), 0.0, -20.0, 120.0) / 100
    return f"h*{y:.6f}"


def _editor_text_align_option(item: dict[str, Any]) -> str:
    align = str(item.get("align") or "left").lower()
    horizontal = {"center": "C", "right": "R"}.get(align, "L")
    return f"text_align=T+{horizontal}"


def _editor_image_x_expr(item: dict[str, Any]) -> str:
    x = _safe_float(item.get("x"), 0.0, -20.0, 120.0) / 100
    return f"main_w*{x:.6f}"


def _editor_image_y_expr(item: dict[str, Any]) -> str:
    y = _safe_float(item.get("y"), 0.0, -20.0, 120.0) / 100
    return f"main_h*{y:.6f}"


def _editor_overlays(creative_settings: dict[str, Any] | None) -> list[dict[str, Any]]:
    raw = (creative_settings or {}).get("burn_overlays")
    if not isinstance(raw, list):
        return []
    overlays: list[dict[str, Any]] = []
    for index, item in enumerate(raw[:24]):
        if not isinstance(item, dict):
            continue
        kind = str(item.get("kind") or "").lower()
        if kind == "text":
            # Preserve the editor's line breaks (it pre-wraps text to the overlay
            # width so the bake matches the preview) while normalizing whitespace
            # within each line.
            raw_lines = str(item.get("text") or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
            norm_lines = [" ".join(line.split()) for line in raw_lines]
            norm_lines = [line for line in norm_lines if line]
            if not norm_lines:
                continue
            text = "\n".join(norm_lines)
            text_file = item.get("_text_file")
            overlays.append({**item, "kind": "text", "text": text, "_index": index, "_text_file": text_file})
        elif kind == "image":
            path = Path(str(item.get("path") or ""))
            if path.exists() and path.is_file():
                overlays.append({**item, "kind": "image", "_index": index, "path": str(path)})
    return overlays


def _write_editor_overlay_texts(output_path: Path, overlays: list[dict[str, Any]]) -> list[dict[str, Any]]:
    prepared: list[dict[str, Any]] = []
    for item in overlays:
        if item.get("kind") != "text":
            prepared.append(item)
            continue
        text = str(item.get("text") or "")
        if not text.strip():
            continue
        text_file = output_path.with_suffix(output_path.suffix + f".overlay_{int(item.get('_index') or 0):02d}.txt")
        # write_bytes keeps the pre-wrapped "\n" line breaks and avoids Windows
        # CRLF translation (a stray "\r" renders as a tofu box in drawtext).
        text_file.write_bytes(text.encode("utf-8"))
        prepared.append({**item, "_text_file": text_file})
    return prepared


def _editor_drawtext_filter(item: dict[str, Any], settings: Settings) -> str:
    text_file = item.get("_text_file")
    if not isinstance(text_file, Path):
        raise ValueError("Editor text overlay is missing a text file")
    font = _overlay_font_path(settings, item.get("font"))
    font_option = f"fontfile='{_filter_path(font)}':" if font else ""
    font_size = max(12, min(190, _scale_preview_px(settings, _safe_float(item.get("fontSize"), 16.0, 8.0, 96.0))))
    color = _safe_color(item.get("color"), "0xFFFFFF")
    x_expr = _editor_text_x_expr(item)
    y_expr = _editor_text_y_expr(item)
    # ~1.22 line-height to match the preview; each wrapped line is drawn as its
    # own drawtext (a "\n" inside one drawtext renders as a tofu box here).
    line_h = font_size + max(0, round(font_size * 0.22))

    box_parts: list[str] = []
    box_color = item.get("boxColor")
    if box_color:
        alpha = _safe_float(item.get("boxAlpha"), 0.9, 0.0, 1.0)
        border = max(2, min(80, _scale_preview_px(settings, _safe_float(item.get("boxBorder"), 8.0, 0.0, 40.0))))
        box_parts = ["box=1:", f"boxcolor={_safe_color(box_color, '0x000000')}@{alpha:.3f}:", f"boxborderw={border}:"]
    shadow_parts = ["shadowcolor=black@0.8:", "shadowx=2:", "shadowy=2:"] if bool(item.get("shadow")) else []

    drawtexts: list[str] = []
    for index, line_file in enumerate(_split_line_files(text_file)):
        y = y_expr if index == 0 else f"{y_expr}+{index * line_h}"
        parts = [
            "drawtext=",
            font_option,
            f"textfile='{_filter_path(line_file)}':",
            f"x={x_expr}:",
            f"y={y}:",
            f"fontsize={font_size}:",
            f"fontcolor={color}:",
            f"{_editor_text_align_option(item)}:",
            f"line_spacing={max(0, round(font_size * 0.22))}:",
            "fix_bounds=1:",
            *box_parts,
            *shadow_parts,
        ]
        drawtexts.append("".join(parts).rstrip(":"))
    return ",".join(drawtexts)


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


def _aspect_band_height(aspect: str, width: int, height: int) -> int:
    try:
        a, b = str(aspect or "9:16").split(":")
        band = int(round(width * float(b) / float(a)))
    except (ValueError, ZeroDivisionError):
        band = height
    return max(2, min(height, band))


def _editor_video_state(creative_settings: dict[str, Any] | None) -> dict[str, Any] | None:
    state = (creative_settings or {}).get("editor_state")
    if isinstance(state, dict) and any(key in state for key in ("aspect", "videoY", "zoom", "bg")):
        return state
    return None


def _has_editor_video(creative_settings: dict[str, Any] | None) -> bool:
    return _editor_video_state(creative_settings) is not None


def _editor_reframe_filter(settings: Settings, editor_state: dict[str, Any] | None) -> str | None:
    """Replicate the editor preview's video framing so the bake matches the screen:
    cover-fit the source into an aspect band, apply the zoom, then place that band
    vertically over a solid background (the editor's aspect/zoom/videoY/bg)."""
    if not editor_state:
        return None
    width = int(settings.shorts_width)
    height = int(settings.shorts_height)
    band_h = _aspect_band_height(str(editor_state.get("aspect") or "9:16"), width, height)
    zoom = _safe_float(editor_state.get("zoom"), 100.0, 40.0, 300.0) / 100.0
    y_off = int(round(_safe_float(editor_state.get("videoY"), 0.0, -50.0, 150.0) / 100.0 * height))
    y_off = max(0, min(height - band_h, y_off))
    bg = _safe_color(editor_state.get("bg"), "0x000000")
    band_bg = "0x0E0E12"  # matches the editor preview's video band background
    parts = [f"scale={width}:{band_h}:force_original_aspect_ratio=increase", f"crop={width}:{band_h}"]
    if zoom > 1.0001:
        parts.append(f"scale=iw*{zoom:.4f}:ih*{zoom:.4f}")
        parts.append(f"crop={width}:{band_h}")
    elif zoom < 0.9999:
        parts.append(f"scale=iw*{zoom:.4f}:ih*{zoom:.4f}")
        parts.append(f"pad={width}:{band_h}:(ow-iw)/2:(oh-ih)/2:{band_bg}")
    if band_h != height or y_off != 0:
        parts.append(f"pad={width}:{height}:0:{y_off}:{bg}")
    parts.append("setsar=1")
    return ",".join(parts)


def _vertical_filter(
    settings: Settings,
    title_file: Path | None = None,
    include_format: bool = True,
    editor_state: dict[str, Any] | None = None,
) -> str:
    editor = _editor_reframe_filter(settings, editor_state)
    if editor:
        filters = [editor]
    else:
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
        filters.append(
            _vertical_filter(settings, title_file, include_format=False, editor_state=_editor_video_state(creative_settings))
        )
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
    if _uses_blur_reframe(settings) and not _has_editor_video(creative_settings):
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


def _composite_base_stage(
    settings: Settings,
    title_file: Path | None,
    duration: float,
    creative_settings: dict[str, Any] | None,
    badge_file: Path | None,
    include_fade: bool,
    subtitle_path: Path | None,
) -> str:
    if _uses_blur_reframe(settings) and not _has_editor_video(creative_settings):
        base_filter = _blur_background_base_filter(settings, "[0:v]", "[base0]")
        post_filter = _post_base_filter(
            settings,
            title_file,
            duration,
            creative_settings,
            badge_file,
            include_fade=include_fade,
            subtitle_path=subtitle_path,
            include_format=False,
        )
        return f"{base_filter};[base0]{post_filter}[base]" if post_filter else f"{base_filter};[base0]null[base]"

    base_filter = _clip_video_filter(
        settings,
        title_file,
        duration,
        creative_settings,
        badge_file,
        include_fade=include_fade,
        subtitle_path=subtitle_path,
    )
    if base_filter.endswith(",format=yuv420p"):
        base_filter = base_filter[: -len(",format=yuv420p")]
    if not base_filter:
        base_filter = "null"
    return f"[0:v]{base_filter}[base]"


def _editor_overlay_filter_complex(
    settings: Settings,
    title_file: Path | None,
    duration: float,
    creative_settings: dict[str, Any] | None,
    badge_file: Path | None,
    overlay_asset_path: Path | None,
    editor_overlays: list[dict[str, Any]],
    include_fade: bool = True,
    subtitle_path: Path | None = None,
) -> str:
    chains = [
        _composite_base_stage(
            settings,
            title_file,
            duration,
            creative_settings,
            badge_file,
            include_fade=include_fade,
            subtitle_path=subtitle_path,
        )
    ]
    current = "[base]"
    image_input_index = 1
    output_index = 0

    if overlay_asset_path:
        creative_settings = creative_settings or {}
        scale = max(0.04, min(0.4, float(creative_settings.get("overlay_scale") or creative_settings.get("scale") or 0.12)))
        opacity = max(0.1, min(1.0, float(creative_settings.get("overlay_opacity") or 0.92)))
        overlay_width = max(24, ceil(settings.shorts_width * scale))
        position = str(creative_settings.get("overlay_position") or creative_settings.get("position") or "top_right")
        x, y = _overlay_position(position)
        image_label = f"[editor_img{output_index}]"
        next_label = f"[editor_stage{output_index}]"
        chains.append(
            f"[{image_input_index}:v]scale={overlay_width}:-1:force_original_aspect_ratio=decrease,"
            f"format=rgba,colorchannelmixer=aa={opacity:.3f}{image_label}"
        )
        chains.append(f"{current}{image_label}overlay=x={x}:y={y}:format=auto{next_label}")
        current = next_label
        image_input_index += 1
        output_index += 1

    for item in editor_overlays:
        next_label = f"[editor_stage{output_index}]"
        if item.get("kind") == "text":
            chains.append(f"{current}{_editor_drawtext_filter(item, settings)}{next_label}")
            current = next_label
            output_index += 1
            continue
        if item.get("kind") == "image":
            path = Path(str(item.get("path") or ""))
            if not path.exists():
                continue
            width = max(24, min(settings.shorts_width, _scale_preview_px(settings, _safe_float(item.get("width"), 120.0, 8.0, 720.0))))
            opacity = _safe_float(item.get("opacity"), 0.95, 0.05, 1.0)
            image_label = f"[editor_img{output_index}]"
            chains.append(
                f"[{image_input_index}:v]scale={width}:-1:force_original_aspect_ratio=decrease,"
                f"format=rgba,colorchannelmixer=aa={opacity:.3f}{image_label}"
            )
            chains.append(
                f"{current}{image_label}overlay=x={_editor_image_x_expr(item)}:"
                f"y={_editor_image_y_expr(item)}:format=auto{next_label}"
            )
            current = next_label
            image_input_index += 1
            output_index += 1

    chains.append(f"{current}format=yuv420p[v]")
    return ";".join(chains)


def _audio_fade_filter(settings: Settings, duration: float) -> str:
    fade = _bounded_fade_seconds(getattr(settings, "shorts_audio_fade_seconds", 0.0), duration)
    if fade <= 0.0:
        return ""
    out_start = max(0.0, duration - fade)
    return f"afade=t=in:st=0:d={fade:.3f},afade=t=out:st={out_start:.3f}:d={fade:.3f}"


def _highlight_dimensions(settings: Settings, aspect: str) -> tuple[int, int]:
    mode = str(aspect or "landscape").strip().lower()
    if mode == "vertical":
        return int(settings.shorts_width), int(settings.shorts_height)
    if mode == "square":
        return 1080, 1080
    return 1920, 1080


def _highlight_title_filter(title_file: Path, width: int, height: int, settings: Settings) -> str:
    font = _font_path(settings)
    font_option = f"fontfile='{_filter_path(font)}':" if font else ""
    font_size = max(34, ceil(height * 0.062))
    y = max(24, ceil(height * 0.07))
    border = max(14, ceil(width * 0.014))
    return (
        "drawtext="
        f"{font_option}"
        f"textfile='{_filter_path(title_file)}':"
        "x=(w-text_w)/2:"
        f"y={y}:"
        f"fontsize={font_size}:"
        "fontcolor=white:"
        "line_spacing=10:"
        "box=1:"
        "boxcolor=black@0.48:"
        f"boxborderw={border}:"
        "shadowcolor=black@0.85:"
        "shadowx=2:"
        "shadowy=2:"
        "enable='between(t,0,3.2)'"
    )


def _normalized_segments(segments: Iterable[dict[str, Any]]) -> list[dict[str, float]]:
    normalized: list[dict[str, float]] = []
    for item in segments:
        if not isinstance(item, dict):
            continue
        try:
            start = float(item.get("start", item.get("start_seconds")))
            end = float(item.get("end", item.get("end_seconds")))
        except (TypeError, ValueError):
            continue
        if end <= start:
            continue
        normalized.append({"start": max(0.0, start), "end": end})
    return normalized


def render_highlight_segments(
    video_path: Path,
    output_path: Path,
    segments: Iterable[dict[str, Any]],
    settings: Settings,
    title_text: str | None = None,
    aspect: str = "landscape",
    text_overlays: list[dict[str, Any]] | None = None,
) -> Path:
    prepared = _normalized_segments(segments)
    if not prepared:
        raise FFmpegError("No valid highlight segments were provided")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    prepared_overlays = (
        _write_editor_overlay_texts(output_path, _editor_overlays({"burn_overlays": text_overlays}))
        if text_overlays
        else []
    )
    width, height = _highlight_dimensions(settings, aspect)
    has_audio = probe_has_audio(video_path, settings)
    title_file = _write_text_file(output_path, ".highlight_title.txt", title_text)
    args = [settings.ffmpeg_binary, "-y"]
    for segment in prepared:
        duration = max(0.1, segment["end"] - segment["start"])
        args.extend(["-ss", f"{segment['start']:.3f}", "-t", f"{duration:.3f}", "-i", str(video_path)])

    chains: list[str] = []
    concat_inputs: list[str] = []
    video_base = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black,"
        "setsar=1,fps=30,format=yuv420p,setpts=PTS-STARTPTS"
    )
    for index in range(len(prepared)):
        chains.append(f"[{index}:v]{video_base}[v{index}]")
        concat_inputs.append(f"[v{index}]")
        if has_audio:
            chains.append(
                f"[{index}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,"
                f"asetpts=PTS-STARTPTS[a{index}]"
            )
            concat_inputs.append(f"[a{index}]")

    if has_audio:
        chains.append("".join(concat_inputs) + f"concat=n={len(prepared)}:v=1:a=1[cv][a]")
    else:
        chains.append("".join(concat_inputs) + f"concat=n={len(prepared)}:v=1:a=0[cv]")
    title_filter = _highlight_title_filter(title_file, width, height, settings) if title_file else None
    if prepared_overlays:
        current = "[cv]"
        if title_filter:
            chains.append(f"[cv]{title_filter}[titled]")
            current = "[titled]"
        for index, item in enumerate(prepared_overlays):
            if item.get("kind") != "text":
                continue
            next_label = f"[ov{index}]"
            chains.append(f"{current}{_editor_drawtext_filter(item, settings)}{next_label}")
            current = next_label
        chains.append(f"{current}format=yuv420p[v]")
    elif title_filter:
        chains.append(f"[cv]{title_filter}[v]")
    else:
        chains.append("[cv]format=yuv420p[v]")

    args.extend(["-filter_complex", ";".join(chains), "-map", "[v]"])
    if has_audio:
        args.extend(["-map", "[a]"])
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
            "160k",
            "-movflags",
            "+faststart",
            str(output_path),
        ]
    )
    _run(args, timeout=None)
    return output_path


def render_segments(
    video_path: Path,
    output_path: Path,
    segments: Iterable[dict[str, Any]],
    settings: Settings,
    title_text: str | None = None,
    text_overlays: list[dict[str, Any]] | None = None,
) -> Path:
    aspect = "vertical" if bool(settings.render_vertical_shorts) else "landscape"
    return render_highlight_segments(
        video_path, output_path, segments, settings, title_text=title_text, aspect=aspect, text_overlays=text_overlays
    )


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
    editor_overlays = _write_editor_overlay_texts(output_path, _editor_overlays(creative_settings))
    editor_image_paths = [Path(str(item.get("path"))) for item in editor_overlays if item.get("kind") == "image"]
    title_file = None if editor_overlays else _write_title_file(output_path, title_text, settings)
    badge_text = "" if overlay_asset_path or editor_overlays else str((creative_settings or {}).get("badge_text") or "")
    badge_file = _write_text_file(output_path, ".badge.txt", badge_text)
    args = [
        settings.ffmpeg_binary,
        "-y",
        "-ss",
        f"{start:.3f}",
        "-i",
        str(video_path),
    ]
    if editor_overlays:
        if overlay_asset_path:
            args.extend(["-loop", "1", "-i", str(overlay_asset_path)])
        for image_path in editor_image_paths:
            args.extend(["-loop", "1", "-i", str(image_path)])
        args.extend(
            [
                "-filter_complex",
                _editor_overlay_filter_complex(
                    settings,
                    title_file,
                    duration,
                    creative_settings,
                    badge_file,
                    overlay_asset_path,
                    editor_overlays,
                    include_fade=True,
                    subtitle_path=subtitle_path,
                ),
                "-map",
                "[v]",
                "-map",
                "0:a?",
            ]
        )
    elif overlay_asset_path:
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
        if _uses_blur_reframe(settings) and not _has_editor_video(creative_settings):
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
    text_overlays: list[dict[str, Any]] | None = None,
) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    # `creative_settings` overlays are baked from the editor (they include the
    # title), so they suppress the separate title/badge. `text_overlays` is an
    # additional plain-text layer (e.g. from a project re-render) that is drawn
    # ON TOP of the reframed frame + title, so it must not suppress the title.
    creative_norm = _editor_overlays(creative_settings)
    extra_norm = _editor_overlays({"burn_overlays": text_overlays}) if text_overlays else []
    if extra_norm:
        base_index = max((int(item.get("_index") or 0) for item in creative_norm), default=-1) + 1
        for offset, item in enumerate(extra_norm):
            item["_index"] = base_index + offset
    editor_overlays = _write_editor_overlay_texts(output_path, creative_norm + extra_norm)
    editor_image_paths = [Path(str(item.get("path"))) for item in editor_overlays if item.get("kind") == "image"]
    title_file = None if creative_norm else _write_title_file(output_path, title_text, settings)
    badge_text = "" if overlay_asset_path or creative_norm else str((creative_settings or {}).get("badge_text") or "")
    badge_file = _write_text_file(output_path, ".badge.txt", badge_text)
    args = [
        settings.ffmpeg_binary,
        "-y",
        "-ss",
        f"{max(0.0, seconds):.3f}",
        "-i",
        str(video_path),
    ]
    if editor_overlays:
        if overlay_asset_path:
            args.extend(["-loop", "1", "-i", str(overlay_asset_path)])
        for image_path in editor_image_paths:
            args.extend(["-loop", "1", "-i", str(image_path)])
        args.extend(
            [
                "-filter_complex",
                _editor_overlay_filter_complex(
                    settings,
                    title_file,
                    1.0,
                    creative_settings,
                    badge_file,
                    overlay_asset_path,
                    editor_overlays,
                    include_fade=False,
                ),
                "-map",
                "[v]",
            ]
        )
    elif overlay_asset_path:
        args.extend(["-loop", "1", "-i", str(overlay_asset_path)])
        args.extend(
            [
                "-filter_complex",
                _image_overlay_filter(settings, title_file, 1.0, creative_settings, include_fade=False),
                "-map",
                "[v]",
            ]
        )
    elif _uses_blur_reframe(settings) and not _has_editor_video(creative_settings):
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


def extract_source_frame(
    video_path: Path,
    output_path: Path,
    seconds: float,
    settings: Settings,
) -> Path:
    """Grab a raw, original-aspect frame with no reframe/blur/title baked in.

    Used as a clean preview source for the in-app editor so the caption-card
    layouts don't leak the finished short's baked-in pixels.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    args = [
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
        str(output_path),
    ]
    _run(args, timeout=60)
    return output_path
