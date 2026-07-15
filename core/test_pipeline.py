"""
STEP D Core — Test Runner / Demo
Tests the full pipeline on the provided video.
Run with: python test_pipeline.py
"""
import sys
import os
from pathlib import Path

# Windows consoles default to cp949, which crashes on the emoji prints below.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

# Ensure core/ is importable
sys.path.insert(0, str(Path(__file__).parent))

from asr import transcribe, get_segments, result_to_srt
from segment import segment_by_silence, score_candidates, get_top_candidates

VIDEO_FILE = 'TpQgkCs0TzE.mp4'  # Default test video


def test_transcribe():
    print("=" * 60)
    print("TEST: WhisperX Korean Transcription")
    print("=" * 60)

    result = transcribe(VIDEO_FILE, language='ko', device='cuda')
    segments = get_segments(result)

    print(f"\n📊 Stats:")
    print(f"   Duration: {segments[-1]['end']:.1f}s ({segments[-1]['end']/60:.1f}m)")
    print(f"   Segments: {len(segments)}")
    print(f"   Language: {result.get('language', '?')}")

    print(f"\n📝 Transcription:")
    for i, seg in enumerate(segments[:10], 1):
        ts = seg['start']
        tm = f'{int(ts//60)}:{int(ts%60):02d}'
        print(f"   [{tm}] {seg['text'].strip()}")

    if len(segments) > 10:
        print(f"   ... ({len(segments) - 10} more segments)")

    # Save SRT
    srt = result_to_srt(result)
    with open('test_transcript.srt', 'w', encoding='utf-8') as f:
        f.write(srt)
    print(f"\n   ✅ SRT saved to test_transcript.srt")

    return result, segments


def test_segment(segments):
    print("\n" + "=" * 60)
    print("TEST: Clip Segmentation")
    print("=" * 60)

    candidates = segment_by_silence(segments, max_gap=2.0)
    print(f"\n   Raw candidates: {len(candidates)}")

    total_duration = segments[-1]['end'] if segments else 0
    candidates = score_candidates(candidates, total_duration)
    recommendations = get_top_candidates(candidates, top_n=5)

    print(f"\n🏆 Top Recommendations:")
    for i, r in enumerate(recommendations, 1):
        ts = r.start
        tm = f'{int(ts//60)}:{int(ts%60):02d}'
        print(f"   #{i} [{tm}] {r.duration:.0f}s score={r.score:.0f}")
        preview = r.text[:100] + '...' if len(r.text) > 100 else r.text
        print(f"      \"{preview}\"")

    return recommendations


if __name__ == '__main__':
    print("🎬 STEP D Core — Test Pipeline\n")

    # Override video if passed as arg (module scope — no `global` needed, and it was
    # a SyntaxError here since VIDEO_FILE is already assigned above).
    if len(sys.argv) > 1:
        VIDEO_FILE = sys.argv[1]

    print(f"📁 Video: {VIDEO_FILE}")

    result, segments = test_transcribe()
    recommendations = test_segment(segments)

    print("\n" + "=" * 60)
    print("✅ All tests passed!")
    print(f"   Transcribed: {len(segments)} segments")
    print(f"   Recommendations: {len(recommendations)} clips")
    print("=" * 60)