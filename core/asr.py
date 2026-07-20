"""
STEP D Core — ASR (Automatic Speech Recognition)

Two interchangeable providers behind one `transcribe()`:
  - "gemini"  (default): managed, GPU-free — runs on the worker VM with no GPU, keeps
    audio in-country (Vertex asia-northeast3), no extra vendor. Chosen for production.
  - "whisper" (local): faster-whisper large-v3 on a local CUDA GPU. Faster/free where a
    GPU exists, so handy for local dev. Requires faster-whisper + CUDA (imported lazily).

Pick with STT_PROVIDER=gemini|whisper. Both return the same shape:
    { "segments": [ {start, end, text, words} ], "language": "ko" }

On a Korean variety clip, managed Google STT mangled "정우성"→"정구속"; Gemini and
whisper both keep it — which is why Gemini is the managed default here.

DUALIZATION (STT_FALLBACK, default on): with STT_PROVIDER=gemini, if Gemini raises or
returns an empty transcript (outage/timeout/quota), we automatically fall back to
faster-whisper large-v3 in int8 on CPU — algorithmic, no GPU, no extra vendor — so an
STT hiccup never zeroes out the transcript. faster-whisper is MIT-licensed and imported
lazily; if it isn't installed the pipeline just continues transcript-free (non-destructive).
Opt out with STT_FALLBACK=off. faster-whisper large-v3 int8 on CPU is slow (last resort).
"""
import io
import json
import os
import subprocess
import tempfile
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

from .retry import call_with_retry, is_transient

STT_PROVIDER = (os.environ.get("STT_PROVIDER") or "gemini").lower()
# Auto-fallback to faster-whisper when the primary (Gemini) yields nothing. On by default;
# STT_FALLBACK=off|none|0 disables it (then a Gemini failure just means no transcript).
STT_FALLBACK = (os.environ.get("STT_FALLBACK") or "whisper").lower()
_FALLBACK_ON = STT_FALLBACK not in ("off", "none", "0", "false", "")

# Gemini provider config (Vertex AI, Seoul — audio is personal data, keep it in-country)
GEMINI_PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT") or "step-d"
GEMINI_LOCATION = os.environ.get("VERTEX_LOCATION") or "asia-northeast3"
GEMINI_MODEL = os.environ.get("GEMINI_STT_MODEL") or os.environ.get("GEMINI_MODEL") or "gemini-2.5-flash"
# Transcribe in windows so timestamps stay accurate AND each call's JSON output stays
# within the token budget (dense speech in a long window overflows and truncates).
STT_WINDOW_SEC = int(os.environ.get("STT_WINDOW_SEC") or 90)
STT_WORKERS = int(os.environ.get("STT_WORKERS") or 6)


class STTOutageError(RuntimeError):
    """Gemini STT 아웃티지/과다 실패. 빈·구멍 전사를 체크포인트로 굳히면 영구 데이터
    손실이므로, 폴백까지 실패하면 이 예외를 전파해 잡 재시도로 넘겨야 한다."""


def extract_audio(video_path: str, output_path: Optional[str] = None) -> str:
    """Extract a 16 kHz mono PCM WAV from the video (ffmpeg)."""
    if output_path is None:
        output_path = str(Path(video_path).with_suffix(".wav"))
    subprocess.run(
        ["ffmpeg", "-y", "-v", "quiet", "-i", video_path,
         "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", output_path],
        check=True,
    )
    return output_path


def transcribe(
    audio_path: str,
    language: str = "ko",
    model_name: str = "large-v3",
    device: str = "cuda",
    compute_type: str = "float16",
    beam_size: int = 5,
    on_progress=None,
) -> dict:
    """Transcribe via the configured provider. Returns {segments, language}.
    on_progress(done, total) fires per completed window (gemini provider only).

    STT_PROVIDER=whisper → whisper only. Otherwise Gemini is primary and, on failure or an
    empty result, we fall back to faster-whisper (int8 CPU) when STT_FALLBACK is on."""
    if STT_PROVIDER == "whisper":
        return _transcribe_whisper(audio_path, language, model_name, device, compute_type, beam_size)

    # Primary: managed Gemini (GPU-free, in-country).
    outage: Optional[Exception] = None
    try:
        result = _transcribe_gemini(audio_path, language, on_progress=on_progress)
    except STTOutageError as e:
        # 아웃티지/과다 실패 — 폴백이 못 살리면 아래에서 재던져 잡을 실패시킨다.
        print(f"   (STT Gemini 실패: {str(e)[:100]})")
        outage = e
        result = {"segments": [], "language": language}
    except Exception as e:
        print(f"   (STT Gemini 실패: {str(e)[:100]})")
        result = {"segments": [], "language": language}
    if result.get("segments"):
        return result

    # Algorithmic fallback: faster-whisper large-v3 (int8, CPU) so a Gemini outage/timeout
    # doesn't zero out the transcript. Lazy import → absent lib just means we skip it.
    if _FALLBACK_ON:
        try:
            print("   STT: Gemini 무결과 → faster-whisper large-v3(int8 CPU) 폴백")
            fb = _transcribe_whisper(audio_path, language, "large-v3", "cpu", "int8", beam_size)
            if fb.get("segments"):
                print(f"   STT 폴백 성공: {len(fb['segments'])} 세그먼트")
                return fb
        except Exception as e:
            print(f"   (STT 폴백(faster-whisper) 불가: {str(e)[:100]})")
    if outage is not None:
        # 아웃티지인데 폴백도 실패 — 빈 전사를 체크포인트로 굳히는 대신 잡 재시도.
        raise outage
    return result  # empty → pipeline continues transcript-free (frames-only candidates)


# ── Provider: Gemini (managed, GPU-free) ────────────────────────────────────────

_GEMINI_SCHEMA = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "start": {"type": "NUMBER"},
            "end": {"type": "NUMBER"},
            "text": {"type": "STRING"},
        },
        "required": ["start", "end", "text"],
    },
}

_GEMINI_PROMPT = """이 오디오를 한국어로 정확히 전사하라. 예능/방송 대화다.
발화(문장/호흡) 단위로 나누고, 각 발화의 시작·끝 초를 이 오디오 기준(0부터)으로 매겨라.
고유명사·이름을 정확히. 배경음·잡음은 전사하지 마라. JSON 배열 [{start,end,text}]로만."""


def _wav_meta(wav_path: str) -> tuple[int, int, int, float]:
    with wave.open(wav_path, "rb") as w:
        return w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes() / w.getframerate()


def _slice_wav(wav_path: str, start_sec: float, dur_sec: float) -> bytes:
    """Return a WAV blob for [start, start+dur) of a mono PCM WAV."""
    with wave.open(wav_path, "rb") as w:
        rate, ch, sw = w.getframerate(), w.getnchannels(), w.getsampwidth()
        w.setpos(int(start_sec * rate))
        data = w.readframes(int(dur_sec * rate))
        buf = io.BytesIO()
        with wave.open(buf, "wb") as o:
            o.setnchannels(ch); o.setsampwidth(sw); o.setframerate(rate)
            o.writeframes(data)
        return buf.getvalue()


def _transcribe_gemini(audio_or_video: str, language: str, on_progress=None) -> dict:
    from google import genai
    from google.genai import types

    # Need a WAV. If handed a video, extract audio to a temp file first.
    src = Path(audio_or_video)
    tmp_wav = None
    if src.suffix.lower() != ".wav":
        tmp_wav = str(Path(tempfile.gettempdir()) / f"stepd_stt_{os.getpid()}.wav")
        extract_audio(str(src), tmp_wav)
        wav_path = tmp_wav
    else:
        wav_path = str(src)

    client = genai.Client(vertexai=True, project=GEMINI_PROJECT, location=GEMINI_LOCATION)
    config = types.GenerateContentConfig(
        temperature=0,
        response_mime_type="application/json",
        response_schema=_GEMINI_SCHEMA,
        max_output_tokens=8192,
        # No reasoning needed for transcription — free the whole output budget for JSON
        # (thinking tokens were eating into it and truncating long windows).
        thinking_config=types.ThinkingConfig(thinking_budget=0),
    )

    failed = [0]

    def do_window(start: float, dur: float, depth: int = 0) -> list[dict]:
        try:
            # 429/503 같은 일시 오류는 제자리에서 백오프 재시도 — 반으로 쪼개 재호출하면
            # 스로틀 중에 호출량만 2배가 된다.
            resp = call_with_retry(lambda: client.models.generate_content(
                model=GEMINI_MODEL,
                contents=[
                    types.Part.from_bytes(data=_slice_wav(wav_path, start, dur), mime_type="audio/wav"),
                    _GEMINI_PROMPT,
                ],
                config=config,
            ))
            rows = json.loads(resp.text or "[]")
        except Exception as e:
            # A dense/noisy window can overflow the JSON output and truncate. Split it in
            # half and retry so we don't lose the whole window (e.g. the intro montage).
            # 단, 일시 오류(재시도 소진)는 분할해도 소용없다 — 절단/파싱류만 분할한다.
            if not is_transient(e) and depth < 2 and dur > 20:
                half = dur / 2
                return do_window(start, half, depth + 1) + do_window(start + half, half, depth + 1)
            failed[0] += 1
            print(f"   (STT window @{start:.0f}s+{dur:.0f}s failed, skipped: {str(e)[:70]})\n",
                  end="", flush=True)
            return []
        out = []
        for r in rows:
            try:
                text = (r.get("text") or "").strip()
                if not text:
                    continue
                out.append({
                    "start": round(start + float(r.get("start", 0)), 3),
                    "end": round(start + float(r.get("end", 0)), 3),
                    "text": text,
                    "words": [],  # Gemini gives utterance-level, not word-level, timestamps
                })
            except Exception:
                continue  # one malformed row shouldn't abort the whole transcription
        return out

    try:
        _, _, _, total = _wav_meta(wav_path)
        starts = [i * STT_WINDOW_SEC for i in range(int(total // STT_WINDOW_SEC) + 1)]
        starts = [s for s in starts if s < total]
        done = [0]

        def run_window(s: float) -> list[dict]:
            # 창 끝을 +2s 오버랩해 경계에 걸친 발화가 중간에 잘리지 않게 한다.
            # 오버랩 구간에서 '시작'하는 발화는 다음 창 소유이므로 버리고,
            # 경계를 살짝 넘겨 끝나는 발화는 end만 오버랩 한도로 클램프한다.
            rows = do_window(s, min(STT_WINDOW_SEC + 2.0, total - s))
            boundary = s + STT_WINDOW_SEC
            rows = [r for r in rows if r["start"] < boundary]
            for r in rows:
                r["end"] = min(r["end"], boundary + 2.0)
            done[0] += 1
            if on_progress:
                on_progress(done[0], len(starts))
            return rows

        with ThreadPoolExecutor(max_workers=STT_WORKERS) as ex:
            results = list(ex.map(run_window, starts))
    finally:
        if tmp_wav and os.path.exists(tmp_wav):
            os.remove(tmp_wav)

    segments = [seg for batch in results for seg in batch]
    segments.sort(key=lambda s: s["start"])
    # An outage (all/most windows erroring with nothing transcribed) must fail the run —
    # returning an empty result would be checkpointed and become permanent silent data loss.
    if failed[0] and not segments:
        raise STTOutageError(
            f"Gemini STT: {failed[0]}/{len(starts)} windows failed and no segments were produced"
        )
    # 일부만 성공해도 구멍이 10%를 넘으면 실패 처리 — 구멍 난 전사가 체크포인트로
    # 굳어 영구화되는 것보다 잡 재시도(완료 단계부터 재개)가 낫다.
    if failed[0] > max(1, len(starts) * 0.1):
        raise STTOutageError(
            f"Gemini STT: {failed[0]}/{len(starts)} windows failed (>10%) — "
            "holey transcript, failing so the job retries instead of checkpointing data loss"
        )
    return {"segments": segments, "language": language}


# ── Provider: faster-whisper (local GPU) ────────────────────────────────────────

def _transcribe_whisper(
    audio_path: str, language: str, model_name: str, device: str, compute_type: str, beam_size: int,
) -> dict:
    from faster_whisper import WhisperModel  # lazy: not installed on the GPU-less worker

    if device != "cuda" and compute_type == "float16":
        compute_type = "int8"  # float16 is CPU-unsupported (CTranslate2 falls back slowly)
    model = WhisperModel(model_name, device=device, compute_type=compute_type)

    segments_iter, info = model.transcribe(
        audio_path,
        language=language,
        beam_size=beam_size,
        word_timestamps=True,
        vad_filter=True,  # gates music/silence → kills large-v3's non-speech hallucinations
        vad_parameters={"min_silence_duration_ms": 500},
        condition_on_previous_text=False,  # stops phrase-repeat loops
        hallucination_silence_threshold=2.0,
    )

    segments = []
    for seg in segments_iter:
        words = [
            {"word": w.word, "start": w.start, "end": w.end, "probability": w.probability}
            for w in (seg.words or [])
        ]
        segments.append({"start": seg.start, "end": seg.end, "text": seg.text.strip(), "words": words})

    del model
    try:
        import torch
        torch.cuda.empty_cache()
    except Exception:
        pass

    return {
        "segments": segments,
        "language": info.language,
        "language_probability": info.language_probability,
    }


# ── Shared helpers ──────────────────────────────────────────────────────────────

def result_to_srt(result: dict) -> str:
    lines = []
    for i, seg in enumerate(result["segments"], 1):
        lines.append(f"{i}\n{_format_timestamp(seg['start'])} --> {_format_timestamp(seg['end'])}\n{seg['text'].strip()}\n")
    return "\n".join(lines)


def _format_timestamp(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds - int(seconds)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def get_segments(result: dict) -> list[dict]:
    return [
        {"start": seg["start"], "end": seg["end"], "text": seg["text"].strip(), "words": seg.get("words", [])}
        for seg in result["segments"]
    ]
