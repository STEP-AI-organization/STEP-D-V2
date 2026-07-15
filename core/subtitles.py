"""
STEP D Core — Subtitle Engine
SRT generation & formatting utilities for short-form content.

Based on VideoLingo's _6_gen_sub.py (Apache 2.0) — adapted for
k-style karaoke subtitles (word-by-word highlighting) for shorts/reels.
"""


def generate_srt(segments: list[dict]) -> str:
    """
    Convert transcription segments to SRT format.
    Each segment becomes one subtitle block.
    """
    srt = []
    for i, seg in enumerate(segments, 1):
        start = _ts(seg['start'])
        end = _ts(seg['end'])
        text = seg['text'].strip()
        srt.append(f"{i}\n{start} --> {end}\n{text}\n")
    return '\n'.join(srt)


def generate_vtt(segments: list[dict]) -> str:
    """Convert transcription segments to WebVTT format."""
    vtt = ["WEBVTT\n"]
    for i, seg in enumerate(segments, 1):
        start = _ts_vtt(seg['start'])
        end = _ts_vtt(seg['end'])
        text = seg['text'].strip()
        vtt.append(f"{i}\n{start} --> {end}\n{text}\n")
    return '\n'.join(vtt)


def generate_ass(
    segments: list[dict],
    video_width: int = 1080,
    video_height: int = 1920,  # shorts portrait
) -> str:
    """
    Generate ASS (Advanced SubStation Alpha) subtitles.
    Good for burning into video with ffmpeg.
    """
    # ASS header
    ass = f"""[Script Info]
Title: STEP D Subtitles
ScriptType: v4.00+
PlayResX: {video_width}
PlayResY: {video_height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans CJK KR,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,0,2,60,60,80,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    for seg in segments:
        start = _ts_ass(seg['start'])
        end = _ts_ass(seg['end'])
        text = seg['text'].strip().replace('\n', '\\N')
        ass += f"Dialogue: 0,{start},{end},Default,,0,0,0,,{text}\n"

    return ass


def _ts(seconds: float) -> str:
    """Convert seconds to SRT timestamp."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds - int(seconds)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _ts_vtt(seconds: float) -> str:
    """Convert seconds to VTT timestamp."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds - int(seconds)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def _ts_ass(seconds: float) -> str:
    """Convert seconds to ASS timestamp."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    cs = int((seconds - int(seconds)) * 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"