"""
STEP D Core — Pipeline
Main orchestrator: audio extraction → ASR → segmentation → scoring

Usage:
    python pipeline.py video.mp4

    from core.pipeline import run_pipeline
    recommendations = run_pipeline('video.mp4', language='ko')
"""
import json
import os
import sys
from pathlib import Path
from typing import Optional

# The progress prints use emoji, and Windows consoles default to cp949, which raises
# UnicodeEncodeError on the first line. Force UTF-8 so the pipeline runs regardless of
# the console/codepage (direct run or spawned from the Node bridge).
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

import subprocess

from .asr import transcribe, get_segments, result_to_srt
from .segment import segment_by_silence, score_candidates, get_top_candidates


def _video_duration(path: str) -> Optional[float]:
    """True container duration via ffprobe. None if ffprobe is unavailable/fails."""
    try:
        out = subprocess.run(
            ['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
             '-of', 'default=noprint_wrappers=1:nokey=1', path],
            capture_output=True, text=True, check=True,
        )
        return float(out.stdout.strip())
    except (subprocess.CalledProcessError, FileNotFoundError, ValueError):
        return None


def run_pipeline(
    video_path: str,
    language: str = 'ko',
    model_name: str = 'large-v3',
    device: str = 'cuda',
    output_dir: Optional[str] = None,
    top_n: int = 5,
    min_duration: float = 15.0,
    max_duration: float = 90.0,
    max_gap: float = 2.0,
) -> dict:
    """
    Run the full STEP D pipeline on a video.

    Args:
        video_path: Path to the video file
        language: Language code
        model_name: Whisper model name
        device: 'cuda' or 'cpu'
        output_dir: Directory for output files (default: same as video)
        top_n: Number of top recommendations to return
        min_duration: Minimum clip duration (seconds)
        max_duration: Maximum clip duration (seconds)
        max_gap: Maximum silence gap within a clip (seconds)

    Returns:
        dict with:
        - duration: total video duration
        - segments: all transcribed segments
        - candidates: scored clip candidates
        - recommendations: top N recommendations
    """
    video_path = str(Path(video_path).resolve())
    if output_dir is None:
        output_dir = str(Path(video_path).parent)

    print(f"🎬 STEP D Pipeline")
    print(f"   Video: {video_path}")
    print(f"   Language: {language}")
    print(f"   Model: {model_name} on {device}")
    print()

    # 1. Transcribe with WhisperX
    print("🎤 [1/3] Transcribing with WhisperX...")
    result = transcribe(
        video_path,
        language=language,
        model_name=model_name,
        device=device,
    )
    # Real video length, not speech-end. With VAD on, a variety-show outro (music/
    # applause) produces no segments, so the last segment ends well before the video
    # does — using speech-end would skew position scores and misreport duration.
    speech_end = result['segments'][-1]['end'] if result['segments'] else 0
    total_duration = _video_duration(video_path) or speech_end
    print(f"   Done. {len(result['segments'])} segments, {total_duration:.1f}s total")
    print(f"   Language: {result.get('language', '?')}")

    # 2. Segment into clip candidates
    print(f"\n✂️ [2/3] Segmenting ({min_duration}s–{max_duration}s, gap<{max_gap}s)...")
    candidates = segment_by_silence(
        result['segments'],
        max_gap=max_gap,
        min_duration=min_duration,
        max_duration=max_duration,
    )
    print(f"   {len(candidates)} raw candidates")

    # 3. Score and rank
    print(f"\n📊 [3/3] Scoring...")
    candidates = score_candidates(candidates, total_duration)
    recommendations = get_top_candidates(candidates, top_n=top_n)
    print(f"   Top {len(recommendations)} recommendations:")
    for i, r in enumerate(recommendations, 1):
        ts = r.start
        tm = f'{int(ts//60)}:{int(ts%60):02d}'
        print(f"   #{i} [{tm}] {r.duration:.0f}s → score={r.score:.0f}")
        preview = r.text[:80] + '...' if len(r.text) > 80 else r.text
        print(f"      \"{preview}\"")

    # 4. Save outputs
    output = {
        'video': video_path,
        'duration': total_duration,
        'language': result.get('language', '?'),
        'total_segments': len(result['segments']),
        'segments': get_segments(result),
        'candidates': [
            {
                'start': c.start,
                'end': c.end,
                'duration': c.duration,
                'text': c.text,
                'score': round(c.score, 1),
                'hook_score': round(c.hook_score, 1),
                'climax_score': round(c.climax_score, 1),
                'resolution_score': round(c.resolution_score, 1),
            }
            for c in candidates
        ],
        'recommendations': [
            {
                'start': r.start,
                'end': r.end,
                'duration': r.duration,
                'text': r.text,
                'score': round(r.score, 1),
            }
            for r in recommendations
        ],
    }

    # Save JSON
    json_path = Path(output_dir) / 'pipeline_output.json'
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"\n✅ Pipeline complete. Output: {json_path}")

    # Save SRT
    srt_path = Path(output_dir) / 'transcript.srt'
    with open(srt_path, 'w', encoding='utf-8') as f:
        f.write(result_to_srt(result))
    print(f"   SRT transcript: {srt_path}")

    return output


# CLI entry point
if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(f"Usage: python {sys.argv[0]} <video.mp4>")
        print(f"       python {sys.argv[0]} <video.mp4> --lang en")
        print(f"       python {sys.argv[0]} <video.mp4> --cpu")
        sys.exit(1)

    video = sys.argv[1]
    lang = 'ko'
    dev = 'cuda'

    for i, arg in enumerate(sys.argv[2:], 2):
        if arg == '--lang' and i + 1 < len(sys.argv):
            lang = sys.argv[i + 1]
        elif arg == '--cpu':
            dev = 'cpu'

    # Tuning knobs the Node bridge passes via env (spawn can't easily add flags).
    def _envf(name, default):
        v = os.environ.get(name)
        if v in (None, ''):
            return default
        try:
            return float(v)
        except ValueError:
            print(f"   (warn: {name}={v!r} is not numeric, using {default})")
            return default

    run_pipeline(
        video,
        language=lang,
        device=dev,
        top_n=int(_envf('STEPD_TOP_N', 5)),
        min_duration=_envf('STEPD_MIN_DURATION', 15.0),
        max_duration=_envf('STEPD_MAX_DURATION', 90.0),
        max_gap=_envf('STEPD_MAX_GAP', 2.0),
    )