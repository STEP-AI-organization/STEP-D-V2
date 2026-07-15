"""
STEP D Core — ASR (Automatic Speech Recognition)
Based on VideoLingo's WhisperX pipeline (Apache 2.0 license)
Uses faster-whisper (CTranslate2 backend) for reliability.

Key features:
- Word-level timestamps via faster-whisper (whisper large-v3)
- GPU acceleration (CUDA float16)
- Korean + multilingual support
- SRT export
"""
import subprocess
from pathlib import Path
from typing import Optional

from faster_whisper import WhisperModel


def extract_audio(video_path: str, output_path: Optional[str] = None) -> str:
    """Extract audio track from video using ffmpeg."""
    if output_path is None:
        output_path = str(Path(video_path).with_suffix('.wav'))

    subprocess.run(
        [
            'ffmpeg', '-y', '-v', 'quiet',
            '-i', video_path,
            '-vn', '-acodec', 'pcm_s16le',
            '-ar', '16000', '-ac', '1',
            output_path,
        ],
        check=True,
    )
    return output_path


def transcribe(
    audio_path: str,
    language: str = 'ko',
    model_name: str = 'large-v3',
    device: str = 'cuda',
    compute_type: str = 'float16',
    beam_size: int = 5,
) -> dict:
    """
    Transcribe audio with word-level timestamps.

    Args:
        audio_path: Path to audio/video file
        language: Language code ('ko', 'en', 'ja', etc.)
        model_name: Whisper model ('large-v3', 'large-v2', 'medium', etc.)
        device: 'cuda' or 'cpu'
        compute_type: 'float16' for GPU, 'int8' for CPU
        beam_size: Beam search width (higher = more accurate, slower)

    Returns:
        dict with segments [{start, end, text, words}], language
    """
    # float16 is unsupported on CPU (CTranslate2 warns and falls back to float32,
    # slowly) — use int8 there, which is what CPU inference actually wants.
    if device != 'cuda' and compute_type == 'float16':
        compute_type = 'int8'
    model = WhisperModel(model_name, device=device, compute_type=compute_type)

    segments_iter, info = model.transcribe(
        audio_path,
        language=language,
        beam_size=beam_size,
        word_timestamps=True,
        # VAD gates out music/silence/applause. Without it, large-v3 hallucinates on
        # the non-speech stretches of variety-show audio (observed: stray English/German
        # words, whole-phrase repeats). This is the single biggest quality lever here.
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        # Stops the decoder from looping the previous line ("자 이제 순위를…" ×2) and
        # from letting one bad hypothesis poison the rest of the transcript.
        condition_on_previous_text=False,
        # Uses the word timestamps to drop hypotheses that span a long silent gap —
        # the actual hallucination filter (no_speech/compression_ratio here would just
        # restate faster-whisper's defaults and change nothing).
        hallucination_silence_threshold=2.0,
    )

    segments = []
    for seg in segments_iter:
        words = [
            {'word': w.word, 'start': w.start, 'end': w.end, 'probability': w.probability}
            for w in (seg.words or [])
        ]
        segments.append({
            'start': seg.start,
            'end': seg.end,
            'text': seg.text.strip(),
            'words': words,
        })

    del model
    # Best-effort VRAM release. torch is not a declared dependency (faster-whisper uses
    # CTranslate2, not PyTorch), so treat it as optional — and it's a no-op for the
    # CTranslate2 allocator anyway, hence best-effort.
    try:
        import torch
        torch.cuda.empty_cache()
    except Exception:
        pass

    return {
        'segments': segments,
        'language': info.language,
        'language_probability': info.language_probability,
    }


def result_to_srt(result: dict) -> str:
    """Convert transcription result to SRT subtitle format."""
    srt_lines = []
    for i, seg in enumerate(result['segments'], 1):
        start = _format_timestamp(seg['start'])
        end = _format_timestamp(seg['end'])
        text = seg['text'].strip()
        srt_lines.append(f"{i}\n{start} --> {end}\n{text}\n")
    return '\n'.join(srt_lines)


def _format_timestamp(seconds: float) -> str:
    """Convert seconds to SRT timestamp (HH:MM:SS,mmm)."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds - int(seconds)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def get_segments(result: dict) -> list[dict]:
    """Extract clean segment list from transcription result."""
    return [
        {
            'start': seg['start'],
            'end': seg['end'],
            'text': seg['text'].strip(),
            'words': seg.get('words', []),
        }
        for seg in result['segments']
    ]