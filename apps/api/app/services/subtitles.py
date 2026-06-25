import re
from pathlib import Path
from typing import Any


SHORTS_SUBTITLE_FONT_NAME = "G마켓 산스 TTF Bold"
SUBTITLE_MODES = {"auto", "on", "off"}
DEFAULT_PRIMARY_COLOR = "&H00FFFFFF"
DEFAULT_HIGHLIGHT_COLOR = "&H0000E6FF"
STYLE_PRESETS = {
    "korean_pop": {
        "font_size": 70,
        "margin_v": 220,
        "max_chars": 16,
        "max_lines": 2,
        "primary_color": "&H00FFFFFF",
        "highlight_enabled": True,
        "highlight_color": "&H0000E6FF",
        "outline": 5,
        "shadow": 2,
    },
    "clean": {
        "font_size": 64,
        "margin_v": 190,
        "max_chars": 18,
        "max_lines": 2,
        "primary_color": "&H00FFFFFF",
        "highlight_enabled": False,
        "highlight_color": "&H00FFFFFF",
        "outline": 4,
        "shadow": 1,
    },
    "news": {
        "font_size": 68,
        "margin_v": 235,
        "max_chars": 14,
        "max_lines": 2,
        "primary_color": "&H00FFFFFF",
        "highlight_enabled": True,
        "highlight_color": "&H0000A5FF",
        "outline": 6,
        "shadow": 0,
    },
}
STYLE_PRESET_ALIASES = {
    "k_shorts": "korean_pop",
    "kshorts": "korean_pop",
    "korean": "korean_pop",
}
STYLE_PRESET_IDS = tuple(STYLE_PRESETS.keys()) + ("custom",)


def normalize_subtitle_mode(value: object, default: object = "auto") -> str:
    mode = str(value or default or "auto").lower().strip()
    return mode if mode in SUBTITLE_MODES else "auto"


def normalize_style_preset(value: object, default: object = "korean_pop") -> str:
    fallback = str(default or "korean_pop").lower().strip().replace("-", "_")
    fallback = STYLE_PRESET_ALIASES.get(fallback, fallback)
    if fallback not in STYLE_PRESET_IDS:
        fallback = "korean_pop"
    preset = str(value or fallback).lower().strip().replace("-", "_")
    preset = STYLE_PRESET_ALIASES.get(preset, preset)
    return preset if preset in STYLE_PRESET_IDS else fallback


def available_style_presets() -> tuple[str, ...]:
    return STYLE_PRESET_IDS


def _preset_value(settings: Any, preset: str, key: str, setting_name: str, fallback: object) -> object:
    if preset != "custom":
        return STYLE_PRESETS.get(preset, {}).get(key, fallback)
    return getattr(settings, setting_name, fallback)


def _clean_text(text: object) -> str:
    return " ".join(str(text or "").replace("{", "").replace("}", "").replace("\\", " ").split())


def _ass_style_color(value: object, default: str) -> str:
    text = str(value or default).strip().upper()
    if re.fullmatch(r"&H[0-9A-F]{8}", text):
        return text
    if re.fullmatch(r"&H[0-9A-F]{6}", text):
        return "&H00" + text[2:]
    return default


def _ass_override_color(value: object, default: str) -> str:
    style_color = _ass_style_color(value, default)
    return f"&H{style_color[4:]}&"


def _hex_to_ass_color(value: object) -> str | None:
    """Convert a web hex color (#RRGGBB) to an ASS style color (&H00BBGGRR)."""
    text = str(value or "").strip().lstrip("#")
    if len(text) == 3:
        text = "".join(ch * 2 for ch in text)
    if not re.fullmatch(r"[0-9A-Fa-f]{6}", text):
        return None
    rr, gg, bb = text[0:2], text[2:4], text[4:6]
    return f"&H00{bb}{gg}{rr}".upper()


def _highlight_terms(hook_terms: list[str] | None) -> list[str]:
    seen: set[str] = set()
    terms: list[str] = []
    for raw in hook_terms or []:
        term = _clean_text(raw)
        key = term.lower()
        if len(term) < 2 or key in seen:
            continue
        seen.add(key)
        terms.append(term)
    return sorted(terms, key=len, reverse=True)[:8]


def _highlight_caption(text: str, hook_terms: list[str] | None, primary_color: str, highlight_color: str) -> str:
    terms = _highlight_terms(hook_terms)
    if not terms:
        return text
    pattern = re.compile("|".join(re.escape(term) for term in terms), re.IGNORECASE)
    primary = _ass_override_color(primary_color, DEFAULT_PRIMARY_COLOR)
    highlight = _ass_override_color(highlight_color, DEFAULT_HIGHLIGHT_COLOR)
    return pattern.sub(lambda match: f"{{\\c{highlight}}}{match.group(0)}{{\\c{primary}}}", text)


def _time_item(item: dict[str, Any]) -> dict[str, Any] | None:
    try:
        start = float(item.get("start"))
        end = float(item.get("end"))
    except (TypeError, ValueError):
        return None
    text = _clean_text(item.get("text") or item.get("word"))
    if end <= start or not text:
        return None
    normalized = dict(item)
    normalized["start"] = start
    normalized["end"] = end
    normalized["text"] = text
    return normalized


def _overlaps(item: dict[str, Any], start: float, end: float) -> bool:
    return float(item["end"]) > start and float(item["start"]) < end


def _ass_time(seconds: float) -> str:
    seconds = max(0.0, seconds)
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    centiseconds = int(round((seconds - int(seconds)) * 100))
    if centiseconds >= 100:
        secs += 1
        centiseconds = 0
    return f"{hours}:{minutes:02d}:{secs:02d}.{centiseconds:02d}"


def _wrap_caption(text: str, max_chars: int, max_lines: int) -> str:
    cleaned = _clean_text(text)
    if not cleaned:
        return ""
    max_chars = max(8, int(max_chars or 16))
    max_lines = max(1, int(max_lines or 2))
    words = cleaned.split(" ")
    lines: list[str] = []
    current = ""
    for word in words:
        chunks = [word[index : index + max_chars] for index in range(0, len(word), max_chars)] or [word]
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
    return "\\N".join(lines[:max_lines])


def _caption_items(transcript: dict[str, Any], clip_start: float, clip_end: float) -> list[dict[str, Any]]:
    segments = [
        item
        for item in (_time_item(segment) for segment in transcript.get("segments", []))
        if item is not None and _overlaps(item, clip_start, clip_end)
    ]
    if segments:
        return sorted(segments, key=lambda item: float(item["start"]))
    words = [
        item
        for item in (_time_item(word) for word in transcript.get("words", []))
        if item is not None and _overlaps(item, clip_start, clip_end)
    ]
    if not words:
        return []
    grouped: list[dict[str, Any]] = []
    bucket: list[dict[str, Any]] = []
    bucket_start = float(words[0]["start"])
    for word in words:
        if len(bucket) >= 8 or float(word["end"]) - bucket_start > 2.8:
            grouped.append(
                {
                    "start": bucket_start,
                    "end": float(bucket[-1]["end"]),
                    "text": " ".join(str(item["text"]) for item in bucket),
                }
            )
            bucket = []
            bucket_start = float(word["start"])
        bucket.append(word)
    if bucket:
        grouped.append(
            {
                "start": bucket_start,
                "end": float(bucket[-1]["end"]),
                "text": " ".join(str(item["text"]) for item in bucket),
            }
        )
    return grouped


def build_ass_subtitles(
    transcript: dict[str, Any],
    clip_start: float,
    clip_end: float,
    settings: Any,
    output_path: Path,
    hook_terms: list[str] | None = None,
    style_preset: str | None = None,
    highlight_color_override: str | None = None,
) -> Path | None:
    if not getattr(settings, "shorts_subtitles_enabled", True):
        return None

    items = _caption_items(transcript, clip_start, clip_end)
    if not items:
        return None

    output_path.parent.mkdir(parents=True, exist_ok=True)
    width = int(getattr(settings, "shorts_width", 1080) or 1080)
    height = int(getattr(settings, "shorts_height", 1920) or 1920)
    preset = normalize_style_preset(style_preset, getattr(settings, "shorts_style_preset_default", "korean_pop"))
    font_name = str(getattr(settings, "shorts_subtitle_font_name", SHORTS_SUBTITLE_FONT_NAME) or SHORTS_SUBTITLE_FONT_NAME)
    font_size = int(_preset_value(settings, preset, "font_size", "shorts_subtitle_font_size", 70) or 70)
    margin_v = int(_preset_value(settings, preset, "margin_v", "shorts_subtitle_margin_v", 220) or 220)
    max_chars = int(_preset_value(settings, preset, "max_chars", "shorts_subtitle_max_chars_per_line", 16) or 16)
    max_lines = int(_preset_value(settings, preset, "max_lines", "shorts_subtitle_max_lines", 2) or 2)
    primary_color = _ass_style_color(
        _preset_value(settings, preset, "primary_color", "shorts_subtitle_primary_color", DEFAULT_PRIMARY_COLOR),
        DEFAULT_PRIMARY_COLOR,
    )
    highlight_color = _ass_style_color(
        _preset_value(settings, preset, "highlight_color", "shorts_subtitle_highlight_color", DEFAULT_HIGHLIGHT_COLOR),
        DEFAULT_HIGHLIGHT_COLOR,
    )
    highlight_enabled = bool(
        _preset_value(settings, preset, "highlight_enabled", "shorts_subtitle_highlight_enabled", True)
    )
    # The editor's emphasis-color picker (state.hl) wins so the baked highlight
    # matches the color shown in the preview captions.
    override_highlight = _hex_to_ass_color(highlight_color_override)
    if override_highlight:
        highlight_color = override_highlight
        highlight_enabled = True
    outline = max(0, int(_preset_value(settings, preset, "outline", "shorts_subtitle_outline", 5) or 0))
    shadow = max(0, int(_preset_value(settings, preset, "shadow", "shorts_subtitle_shadow", 2) or 0))

    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Default,{font_name},{font_size},{primary_color},{primary_color},&H00000000,&H7F000000,-1,0,0,0,100,100,0,0,1,{outline},{shadow},2,80,80,{margin_v},1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

    for item in items:
        start = max(0.0, float(item["start"]) - clip_start)
        end = min(max(0.1, clip_end - clip_start), float(item["end"]) - clip_start)
        if end - start < 0.25:
            end = start + 0.25
        text = _wrap_caption(str(item["text"]), max_chars, max_lines)
        if not text:
            continue
        if highlight_enabled:
            text = _highlight_caption(text, hook_terms, primary_color, highlight_color)
        lines.append(f"Dialogue: 0,{_ass_time(start)},{_ass_time(end)},Default,,0,0,0,,{text}")

    if len(lines) <= 12:
        return None
    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return output_path
