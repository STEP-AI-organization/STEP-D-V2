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

STT_PROVIDER = (os.environ.get("STT_PROVIDER") or "soniox").lower()
# 2026-07-31: Soniox v5 async 를 default 로 전환 (STT + speaker diarize 정확도·비용 최적).
# STT_FALLBACK 은 default off — 로컬 whisper 경로 죽임 (GPU 미보유 워커에서도 동일 스택).
# Soniox 아웃티지 대응이 필요하면 STT_FALLBACK=whisper 로 명시 켜기 (레거시 경로).
STT_FALLBACK = (os.environ.get("STT_FALLBACK") or "off").lower()
_FALLBACK_ON = STT_FALLBACK not in ("off", "none", "0", "false", "")

# Gemini provider config (Vertex AI, Seoul — audio is personal data, keep it in-country)
GEMINI_PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT") or "step-d"
GEMINI_LOCATION = os.environ.get("VERTEX_LOCATION") or "asia-northeast3"
from .models import STT as GEMINI_MODEL
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
    expected_speakers: int | None = None,
) -> dict:
    """Transcribe via the configured provider. Returns {segments, language}.
    on_progress(done, total) fires per completed window (gemini provider only).

    STT_PROVIDER 옵션:
      - "whisperx": faster-whisper + WAV2VEC2 word align + PyAnnote 3.1 diarize (권장 · .venv310)
      - "whisper" : faster-whisper 단독 (word_timestamps=True)
      - "hybrid"  : Gemini text + whisper timestamp 병렬
      - 기본      : Gemini 단독 + 실패 시 whisper fallback
    """
    if STT_PROVIDER == "soniox":
        return _transcribe_soniox(audio_path, language)
    if STT_PROVIDER == "whisperx":
        return _transcribe_whisperx(
            audio_path, language, model_name, device, compute_type, beam_size,
            expected_speakers=expected_speakers,
        )
    if STT_PROVIDER == "whisper":
        r = _transcribe_whisper(audio_path, language, model_name, device, compute_type, beam_size)
        return _apply_vad_postprocess(audio_path, r, expected_speakers=expected_speakers)
    if STT_PROVIDER == "hybrid":
        return _transcribe_hybrid(audio_path, language, on_progress=on_progress,
                                  beam_size=beam_size, expected_speakers=expected_speakers)

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
        return _apply_vad_postprocess(audio_path, result)

    # Algorithmic fallback: faster-whisper large-v3 (int8, CPU) so a Gemini outage/timeout
    # doesn't zero out the transcript. Lazy import → absent lib just means we skip it.
    if _FALLBACK_ON:
        try:
            print("   STT: Gemini 무결과 → faster-whisper large-v3(int8 CPU) 폴백")
            fb = _transcribe_whisper(audio_path, language, "large-v3", "cpu", "int8", beam_size)
            if fb.get("segments"):
                print(f"   STT 폴백 성공: {len(fb['segments'])} 세그먼트")
                return _apply_vad_postprocess(audio_path, fb)
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


def _parse_rows(text: str) -> list[dict]:
    """Gemini STT 응답을 파싱하되, 절단된 JSON이면 완성된 객체만 건진다.

    밀도 높은 대화 윈도우는 출력이 길어져 JSON이 중간에 잘린다("Unterminated string").
    통째로 버리면 그 윈도우 전체가 사라지므로, 마지막으로 온전히 닫힌 `}`까지만 살려
    배열을 복구한다 — 절반이라도 건지는 게 0보다 낫다.
    """
    text = (text or "").strip()
    try:
        data = json.loads(text)
        return data if isinstance(data, list) else []
    except json.JSONDecodeError:
        pass
    # 절단 복구: 마지막으로 닫힌 객체 뒤에서 잘라 배열을 닫는다.
    last = text.rfind("}")
    if last == -1:
        return []
    salvaged = text[: last + 1] + "]"
    try:
        data = json.loads(salvaged)
        return data if isinstance(data, list) else []
    except json.JSONDecodeError:
        return []


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
            rows = _parse_rows(resp.text or "[]")
        except Exception as e:
            # A dense/noisy window can overflow the JSON output and truncate. Split it in
            # half and retry so we don't lose the whole window (e.g. the intro montage).
            # 단, 일시 오류(재시도 소진)는 분할해도 소용없다 — 절단/파싱류만 분할한다.
            # dur>12로 낮춘 이유: 23초 윈도우가 절단돼 실패하는 사례를 봤다(밀도 높은 대화).
            if not is_transient(e) and depth < 3 and dur > 12:
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

def _preload_cuda_dlls():
    """Windows에서 CTranslate2/faster-whisper가 cuDNN 8을 찾도록 미리 CDLL 로드.
    add_dll_directory·PATH 모두 무시하는 CTranslate2 특성 대응 · site-packages의
    nvidia/cudnn/bin, nvidia/cublas/bin DLL을 ctypes.CDLL로 preload한다."""
    if os.name != "nt":
        return
    try:
        import ctypes, importlib
        for pkg_name in ("nvidia.cudnn", "nvidia.cublas"):
            try:
                pkg = importlib.import_module(pkg_name)
                bin_dir = os.path.join(os.path.dirname(pkg.__file__), "bin")
                if not os.path.isdir(bin_dir):
                    continue
                for fn in os.listdir(bin_dir):
                    if fn.endswith(".dll"):
                        try:
                            ctypes.CDLL(os.path.join(bin_dir, fn))
                        except OSError:
                            pass  # dependency 순서 이슈 · 뒤에서 다시 시도됨
            except Exception:
                continue
    except Exception:
        pass


def _transcribe_whisper(
    audio_path: str, language: str, model_name: str, device: str, compute_type: str, beam_size: int,
) -> dict:
    if device == "cuda":
        _preload_cuda_dlls()

    from faster_whisper import WhisperModel  # lazy: not installed on the GPU-less worker

    if device != "cuda" and compute_type == "float16":
        compute_type = "int8"  # float16 is CPU-unsupported (CTranslate2 falls back slowly)
    try:
        model = WhisperModel(model_name, device=device, compute_type=compute_type)
    except Exception as e:
        # GPU 실패(cuDNN DLL 못 찾음 등) 시 CPU int8로 자동 폴백. 30분 영상 8~10분 (느림).
        if device == "cuda":
            print(f"   [whisper] GPU 로드 실패 ({str(e)[:80]}) → CPU int8 폴백")
            model = WhisperModel(model_name, device="cpu", compute_type="int8")
        else:
            raise

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


# ── Provider: WhisperX (STT + word-align + PyAnnote 3.1 diarize) ────────────────
#
# 2026-07-31 배선 — 사용자 지시("우리 WHISPERX쓰는데 · 코드배선 진행").
# ECAPA embedding + KMeans 클러스터링(_diarize_audio)의 화자분리 정확도 부족 문제를
# WhisperX 표준 파이프라인(PyAnnote 3.1)으로 대체. word-level alignment도 함께 얻는다.
#
# 사용법:
#   1) STT_PROVIDER=whisperx (env)
#   2) HF_TOKEN=hf_... (env) · pyannote/speaker-diarization-3.1 · segmentation-3.0 gate accept 필수
#   3) python 실행은 `core/.venv310/Scripts/python.exe` (Python 3.10 · whisperx 설치 완료)
#
# HF_TOKEN 없으면 STT+align만 수행하고 speaker는 비워둔다 (후속 Phase 1 S1/S2 정규화가
# 빈 speaker를 하나의 화자로 취급해 진행 · pipeline 은 죽지 않음).

def _transcribe_whisperx(
    audio_path: str,
    language: str = "ko",
    model_name: str = "large-v3",
    device: str = "cuda",
    compute_type: str = "float16",
    beam_size: int = 5,
    expected_speakers: int | None = None,
) -> dict:
    """WhisperX pipeline: transcribe → word alignment → diarization.

    반환 shape는 기존 STT 계약과 동일:
        {"segments": [{start,end,text,words,speaker,align_source}], "language": "ko"}

    speaker 값은 "SPEAKER_00"/"SPEAKER_01"/... (PyAnnote 라벨 · analyze.py Phase 1이
    S1/S2로 정규화). diarize 스킵 시 speaker=""로 남김.
    """
    # PyTorch 2.6부터 torch.load의 weights_only 기본값이 True로 바뀌면서 pyannote
    # checkpoint(omegaconf.ListConfig 포함) 로드가 UnpicklingError로 실패한다. HF에서
    # 우리가 gate-accept한 공식 pyannote 모델만 쓰므로 안전 · monkey-patch로 우회.
    import torch as _torch
    if not getattr(_torch.load, "_stepd_patched", False):
        _orig_torch_load = _torch.load
        def _patched_torch_load(*a, **kw):
            # 호출자가 weights_only=True를 명시해도 override (pyannote/lightning은
            # 이 값을 강제로 넣어 우리 setdefault를 무력화한다). pyannote 공식 checkpoint만
            # 다루는 신뢰된 경로.
            kw["weights_only"] = False
            return _orig_torch_load(*a, **kw)
        _patched_torch_load._stepd_patched = True
        _torch.load = _patched_torch_load

    try:
        import whisperx  # lazy · 설치 안 됐으면 즉시 에러 (fallback X · 사용자가 명시적으로 켰을 때만)
    except Exception as e:
        raise RuntimeError(
            f"whisperx 미설치: {e}. `core/.venv310/Scripts/python.exe`로 실행 중인지 확인."
        )

    import torch
    if device == "cuda" and not torch.cuda.is_available():
        print("   [whisperx] CUDA 없음 → CPU int8 폴백")
        device = "cpu"
        compute_type = "int8"
    elif device != "cuda" and compute_type == "float16":
        compute_type = "int8"  # CPU는 float16 미지원

    # Windows CTranslate2 cuDNN 8 검색 실패 방지 (faster-whisper와 동일 이슈)
    if device == "cuda":
        _preload_cuda_dlls()

    # WhisperX는 numpy array를 원함 (내부 sr=16000)
    audio = whisperx.load_audio(audio_path)

    # 1) STT (faster-whisper backend · WhisperX 래퍼)
    asr_options = {
        "beam_size": beam_size,
        "condition_on_previous_text": False,   # phrase-repeat loops 방지
        "hallucination_silence_threshold": 2.0,
        "no_repeat_ngram_size": 3,
    }
    try:
        stt_model = whisperx.load_model(
            model_name, device=device, compute_type=compute_type,
            language=language, asr_options=asr_options,
        )
    except Exception as e:
        # GPU 실패 (cuDNN 등) → CPU int8 폴백
        if device == "cuda":
            print(f"   [whisperx] GPU 로드 실패 ({str(e)[:80]}) → CPU int8 폴백")
            device = "cpu"; compute_type = "int8"
            stt_model = whisperx.load_model(
                model_name, device=device, compute_type=compute_type,
                language=language, asr_options=asr_options,
            )
        else:
            raise

    result = stt_model.transcribe(audio, batch_size=16, language=language)
    print(f"   [whisperx] STT 완료 · {len(result.get('segments', []))} 세그")
    del stt_model
    if device == "cuda":
        torch.cuda.empty_cache()

    # 2) Word-level alignment (WAV2VEC2 for ko)
    try:
        align_model, align_meta = whisperx.load_align_model(
            language_code=language, device=device,
        )
        result = whisperx.align(
            result["segments"], align_model, align_meta, audio, device,
            return_char_alignments=False,
        )
        del align_model
        if device == "cuda":
            torch.cuda.empty_cache()
        print(f"   [whisperx] word align 완료")
    except Exception as e:
        print(f"   [whisperx] align 실패 ({str(e)[:120]}) · segment-level만 사용")

    # 3) Diarization (PyAnnote 3.1 · HF_TOKEN 필요)
    hf_token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if hf_token:
        try:
            from whisperx.diarize import DiarizationPipeline  # top-level 미노출 (3.4.x)
            diarize_model = DiarizationPipeline(
                use_auth_token=hf_token, device=device,
            )
            kwargs: dict = {}
            if expected_speakers and expected_speakers >= 2:
                # tight bound — loose(±2)로 두면 짧은 clip에서 화자 수 잘못 추정.
                # cast 등록 인원이 정답이라 가정 · +1 만 여유(host/narrator 커버).
                kwargs["min_speakers"] = expected_speakers
                kwargs["max_speakers"] = expected_speakers + 1
            diarize_df = diarize_model(audio, **kwargs)
            result = whisperx.assign_word_speakers(diarize_df, result)
            try:
                n_spk = len(set(diarize_df["speaker"])) if hasattr(diarize_df, "__getitem__") else 0
            except Exception:
                n_spk = 0
            print(f"   [whisperx] diarize 완료 · {n_spk}명")
        except Exception as e:
            print(f"   [whisperx] diarize 실패 ({str(e)[:150]}) · speaker 없이 진행")
    else:
        print("   [whisperx] HF_TOKEN 없음 · diarize 스킵 (STT+align만)")

    # 4) 기존 STT 계약 shape으로 변환
    segments = []
    for seg in result.get("segments", []):
        words = []
        for w in (seg.get("words") or []):
            try:
                words.append({
                    "word": w.get("word") or w.get("text") or "",
                    "start": float(w.get("start", 0)) if w.get("start") is not None else 0.0,
                    "end": float(w.get("end", 0)) if w.get("end") is not None else 0.0,
                    "probability": float(w.get("score", 1.0)) if w.get("score") is not None else 1.0,
                    "speaker": w.get("speaker") or "",
                })
            except (TypeError, ValueError):
                continue
        try:
            st = float(seg.get("start", 0)); en = float(seg.get("end", 0))
        except (TypeError, ValueError):
            continue
        segments.append({
            "start": round(st, 3),
            "end": round(en, 3),
            "text": (seg.get("text") or "").strip(),
            "words": words,
            "speaker": seg.get("speaker") or "",  # "SPEAKER_00"/... or ""
            "align_source": "whisperx",
        })

    # 5) PyAnnote diarize 실패 시(HF gate 미승인 등) ECAPA로 폴백해서 최소한
    #    "다른 사람은 구분" 을 보장. speaker 필드가 전부 비어있을 때만 실행.
    #    (사용자 조건: 최소한 다른 사람인지는 인식돼야 이름을 붙일 수 있음)
    if segments and all(not s.get("speaker") for s in segments):
        try:
            turns = _diarize_audio(audio_path, segments, expected_speakers=expected_speakers)
            if turns:
                # turns는 이미 각 segment 인덱스별 speaker(발화자 N)를 부여한 결과
                # (segments 순서 유지 · _diarize_audio가 순서 보존). 다시 병합.
                seg_map = {(round(t["start"], 3), round(t["end"], 3)): t["speaker"] for t in turns}
                assigned = 0
                for s in segments:
                    key = (round(s["start"], 3), round(s["end"], 3))
                    if key in seg_map:
                        s["speaker"] = seg_map[key]
                        assigned += 1
                print(f"   [whisperx] ECAPA 폴백 diarize 완료 · {assigned}/{len(segments)} 세그에 speaker 부여")
        except Exception as e:
            print(f"   [whisperx] ECAPA 폴백 실패 ({str(e)[:120]}) · speaker 비워둠")

    return {"segments": segments, "language": language}


# ── Provider: Soniox (async cloud STT + diarization) ───────────────────────────
#
# 2026-07-31 배선 — 사용자 지시. 상용 클라우드 STT · 한국어 지원 + 화자분리.
# env: SONIOX_API_KEY (Bearer token). 파일 업로드 → 비동기 전사 → 폴링 → 결과.
# Async API doc: https://soniox.com/docs/stt/async_transcription
#
# 결과 shape을 기존 STT 계약으로 매핑:
#   Soniox tokens (word-level): [{text, start_ms, end_ms, speaker, confidence}]
#   → segments: 같은 speaker 연속 word 를 하나의 utterance 로 뭉침 (긴 gap>1s 도 분할)

_SONIOX_BASE = "https://api.soniox.com"
_SONIOX_MODEL = os.environ.get("SONIOX_MODEL") or "stt-async-v5"
_SONIOX_POLL_SEC = 2.0
_SONIOX_TIMEOUT_SEC = 900  # 15분 대기 상한


def _transcribe_soniox(audio_path: str, language: str = "ko") -> dict:
    import requests
    import time as _time

    api_key = os.environ.get("SONIOX_API_KEY")
    if not api_key:
        raise RuntimeError("SONIOX_API_KEY 환경변수 미설정")

    headers = {"Authorization": f"Bearer {api_key}"}

    # 1) 파일 업로드
    print("   [soniox] 업로드 시작...")
    with open(audio_path, "rb") as f:
        r = requests.post(
            f"{_SONIOX_BASE}/v1/files",
            headers=headers,
            files={"file": (Path(audio_path).name, f)},
            timeout=300,
        )
    r.raise_for_status()
    file_id = r.json().get("id")
    if not file_id:
        raise RuntimeError(f"Soniox upload 응답 이상: {r.text[:200]}")
    print(f"   [soniox] 업로드 완료 · file_id={file_id[:8]}...")

    # 2) 전사 요청 (diarization 켬)
    body = {
        "file_id": file_id,
        "model": _SONIOX_MODEL,
        "language_hints": [language] if language else [],
        "enable_speaker_diarization": True,
        "enable_language_identification": False,
    }
    r = requests.post(
        f"{_SONIOX_BASE}/v1/transcriptions",
        headers={**headers, "Content-Type": "application/json"},
        json=body,
        timeout=60,
    )
    r.raise_for_status()
    tx_id = r.json().get("id")
    if not tx_id:
        raise RuntimeError(f"Soniox transcription 생성 실패: {r.text[:200]}")
    print(f"   [soniox] 전사 요청 완료 · tx_id={tx_id[:8]}... · 폴링")

    # 3) 상태 폴링
    started = _time.time()
    while True:
        if _time.time() - started > _SONIOX_TIMEOUT_SEC:
            raise TimeoutError("Soniox 폴링 15분 초과")
        r = requests.get(
            f"{_SONIOX_BASE}/v1/transcriptions/{tx_id}", headers=headers, timeout=30,
        )
        r.raise_for_status()
        status = r.json().get("status")
        if status == "completed":
            break
        if status == "error":
            raise RuntimeError(f"Soniox 전사 실패: {r.json().get('error_message', '?')}")
        _time.sleep(_SONIOX_POLL_SEC)

    # 4) 결과 (transcript with tokens)
    r = requests.get(
        f"{_SONIOX_BASE}/v1/transcriptions/{tx_id}/transcript",
        headers=headers, timeout=60,
    )
    r.raise_for_status()
    tokens = r.json().get("tokens") or []
    print(f"   [soniox] 결과 완료 · {len(tokens)} tokens")

    # 5) tokens → segments
    #    Soniox tokens는 syllable-level이지만 word boundary를 leading space로 표시한다.
    #    즉 [" 지금", " 이", " 자리에서"] 형태 · 그대로 이어붙여야 원래 문장 나옴.
    #    Flush 조건: (a) speaker 변경, (b) gap>GAP_HARD, (c) 종결어미 hit + 다음 token gap>TERM_GAP.
    segments: list[dict] = []
    cur_words: list[dict] = []
    cur_spk: str = ""
    GAP_HARD = 0.8       # 이 이상 침묵이면 무조건 문장 종료
    TERM_GAP = 0.3       # 종결어미 뒤 자연 pause 최소
    END_PUNCTS = (".", "?", "!", "…")
    END_SUFFIXES = (
        "다", "요", "죠", "까", "야", "네", "군", "구나", "니",
        "거야", "거지", "거죠", "잖아", "잖아요", "라고", "래", "래요",
        "습니다", "습니까", "겠다", "겠어", "겠어요",
    )

    def _is_terminal(text: str) -> bool:
        t = text.strip()
        if not t:
            return False
        if t[-1] in END_PUNCTS:
            return True
        for suf in END_SUFFIXES:
            if t.endswith(suf):
                return True
        return False

    def _flush():
        if not cur_words:
            return
        # Soniox 원본 그대로 이어붙임 (leading space 로 word boundary 이미 표시됨)
        text = "".join(w.get("word") or "" for w in cur_words).strip()
        segments.append({
            "start": round(cur_words[0]["start"], 3),
            "end": round(cur_words[-1]["end"], 3),
            "text": text,
            "words": [dict(w) for w in cur_words],
            "speaker": cur_spk,
            "align_source": "soniox",
        })

    for i, tok in enumerate(tokens):
        try:
            st = float(tok.get("start_ms", 0)) / 1000.0
            en = float(tok.get("end_ms", 0)) / 1000.0
        except (TypeError, ValueError):
            continue
        text = tok.get("text") or ""
        spk_raw = tok.get("speaker")
        spk = f"SPEAKER_{int(spk_raw):02d}" if isinstance(spk_raw, (int, float)) else (str(spk_raw or "").strip())
        if cur_words:
            gap = st - cur_words[-1]["end"]
            # speaker 바뀜 or 큰 침묵 → 무조건 flush
            if spk != cur_spk or gap > GAP_HARD:
                _flush()
                cur_words = []
        if not cur_words:
            cur_spk = spk
        cur_words.append({
            "word": text,
            "start": st,
            "end": en,
            "probability": float(tok.get("confidence", 1.0)) if tok.get("confidence") is not None else 1.0,
            "speaker": spk,
        })
        # 종결어미 + 다음 token 과 gap>=TERM_GAP 일 때만 문장 종료 (aggressive 방지)
        if _is_terminal(text):
            next_st = None
            if i + 1 < len(tokens):
                try:
                    next_st = float(tokens[i + 1].get("start_ms", 0)) / 1000.0
                except (TypeError, ValueError):
                    next_st = None
            if next_st is None or (next_st - en) >= TERM_GAP:
                _flush()
                cur_words = []
    _flush()

    return {"segments": segments, "language": language}


# ── Silero VAD: 음성 구간 사전 필터 (2026-07-25) ────────────────────────────────
#
# 문제: STT는 BGM·묵음·효과음 구간에서도 텍스트를 뽑거나(할루시네이션) 시각을 뒤로 밀어버림.
# 방송 원본은 인트로 로고 20초 + 오프닝 음악 15초 등 사람 목소리 없는 구간이 많아 누적 오차 큼.
# 해결: Silero VAD로 "사람 목소리 있는 구간(speech windows)"만 미리 뽑음 · STT 결과 시각을
# 이 window boundary로 스냅해 음성 없는 곳에 잘못 앉은 시각을 밀어냄.

_silero_model = None
_silero_utils = None


def _get_silero() -> tuple:
    """Lazy load Silero VAD (torch.hub · 첫 호출 시 다운로드)."""
    global _silero_model, _silero_utils
    if _silero_model is not None:
        return _silero_model, _silero_utils
    try:
        import torch
        model, utils = torch.hub.load(
            repo_or_dir='snakers4/silero-vad', model='silero_vad', trust_repo=True,
        )
        _silero_model, _silero_utils = model, utils
        return model, utils
    except Exception as e:
        print(f"   [vad] Silero 로드 실패: {str(e)[:100]}")
        return None, None


def _get_speech_windows(audio_path: str) -> list[tuple[float, float]]:
    """오디오 파일에서 사람 목소리 구간 리스트 (초 단위). 실패하면 빈 리스트.
    soundfile backend가 mp4/mkv 못 읽어 · wav가 아니면 tempfile로 변환."""
    model, utils = _get_silero()
    if model is None:
        return []
    # wav 아니면 임시 변환 (16kHz mono)
    src = audio_path
    tmp_wav = None
    try:
        if not audio_path.lower().endswith((".wav", ".flac")):
            import tempfile
            tmp_wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
            subprocess.run(
                ["ffmpeg", "-y", "-v", "quiet", "-i", audio_path,
                 "-vn", "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le", tmp_wav],
                check=True,
            )
            src = tmp_wav
    except Exception as e:
        print(f"   [vad] wav 변환 실패: {str(e)[:100]}")
        return []
    try:
        get_speech_timestamps = utils[0]
        read_audio = utils[2]
        wav = read_audio(src, sampling_rate=16000)
        ts_list = get_speech_timestamps(
            wav, model,
            sampling_rate=16000,
            min_speech_duration_ms=250,   # 0.25s 이하 짧은 음성 무시 (효과음 필터)
            min_silence_duration_ms=300,  # 0.3s 이상 침묵을 window 경계로
            speech_pad_ms=100,             # 각 window 앞뒤 100ms 여유 (자연 발화 감안)
        )
        return [(t["start"] / 16000, t["end"] / 16000) for t in ts_list]
    except Exception as e:
        print(f"   [vad] 음성 구간 감지 실패: {str(e)[:100]}")
        return []


def _snap_to_speech_windows(segs: list[dict], windows: list[tuple[float, float]],
                            max_shift_sec: float = 2.0) -> tuple[list[dict], dict]:
    """세그먼트 각 start/end를 가장 가까운 speech window boundary로 스냅.
    조건: 이동 폭 max_shift_sec 이내일 때만 스냅. 그 외는 원값 유지 (억지 스냅 방지).
    반환: (조정된 segs, {snapped: n, mean_snap_ms, max_snap_ms}).
    """
    if not segs or not windows:
        return segs, {"snapped_start": 0, "snapped_end": 0, "mean_snap_ms": 0.0, "max_snap_ms": 0.0}

    # window 시작·끝 boundary list
    w_starts = [w[0] for w in windows]
    w_ends = [w[1] for w in windows]

    def nearest(target: float, candidates: list[float]) -> float | None:
        if not candidates:
            return None
        return min(candidates, key=lambda x: abs(x - target))

    out: list[dict] = []
    shifts: list[float] = []
    snapped_start = 0
    snapped_end = 0
    skipped_precise = 0
    for s in segs:
        # word-level Whisper alignment은 이미 발화 내부의 정확한 경계다. VAD window
        # boundary(최대 2초)로 다시 이동시키면 정확한 자막과 clip 경계가 오히려 망가진다.
        # VAD 스냅은 Gemini 단독·미정렬 세그먼트의 timestamp 교정에만 사용한다.
        if s.get("align_source") in {"whisper_word", "whisper_segment"} or s.get("words"):
            out.append(dict(s))
            skipped_precise += 1
            continue
        try:
            st = float(s.get("start", 0)); en = float(s.get("end", st + 3))
        except (TypeError, ValueError):
            out.append(s); continue
        # start를 window start 중 가장 가까운 것에 스냅
        cand_start = nearest(st, w_starts)
        new_st = st
        if cand_start is not None and abs(cand_start - st) <= max_shift_sec:
            new_st = cand_start
            if abs(new_st - st) > 0.01:
                shifts.append((new_st - st) * 1000)
                snapped_start += 1
        # end를 window end 중 가장 가까운 것에 스냅
        cand_end = nearest(en, w_ends)
        new_en = en
        if cand_end is not None and abs(cand_end - en) <= max_shift_sec:
            new_en = cand_end
            if abs(new_en - en) > 0.01:
                shifts.append((new_en - en) * 1000)
                snapped_end += 1
        if new_en <= new_st:  # 스냅으로 잘못된 순서 방지
            new_en = new_st + max(0.5, en - st)
        new_seg = dict(s)
        new_seg["start"] = round(new_st, 3)
        new_seg["end"] = round(new_en, 3)
        if "align_source" in s:
            new_seg["align_source"] = s["align_source"] + "+vad"
        else:
            new_seg["align_source"] = "vad"
        out.append(new_seg)
    stats = {
        "snapped_start": snapped_start,
        "snapped_end": snapped_end,
        "mean_snap_ms": round(sum(shifts) / len(shifts), 1) if shifts else 0.0,
        "max_snap_ms": round(max(abs(x) for x in shifts), 1) if shifts else 0.0,
        "windows": len(windows),
        "skipped_precise": skipped_precise,
    }
    return out, stats


# ── PyAnnote 화자분리 (2026-07-25) ──────────────────────────────────────────────
#
# 오디오 기반 화자분리 (누가 언제 말했는지). STT의 speaker 필드가 텍스트 힌트에만 의존하는
# 문제(같은 사람이 여러 세그 걸치는데 다른 speaker로 잡히는 등) 근본 fix. pyannote/speaker-
# diarization-3.1 (HuggingFace token 필요 · pyannote/segmentation-3.0 accept 필요).
#
# 결과 → 각 STT 세그에 speaker="SPEAKER_00"/"SPEAKER_01"/... 붙임. refine·faces가 이걸
# 실명(M1/F1 or 진짜 이름)에 매핑.

_ecapa_classifier = None


def _get_ecapa_classifier():
    """SpeechBrain ECAPA-TDNN speaker embedding 모델 lazy load.
    HF token 불필요 (public model) · Windows symlink 권한 문제 monkey-patch로 우회."""
    global _ecapa_classifier
    if _ecapa_classifier is not None:
        return _ecapa_classifier
    try:
        # Windows symlink 권한 우회: SpeechBrain fetch를 copy로 monkey-patch (관리자 X)
        try:
            import speechbrain.utils.fetching as _fetch
            import shutil as _sh
            _orig = _fetch.link_with_strategy
            def _copy_only(src, dst, strategy):
                if hasattr(dst, "exists") and dst.exists():
                    return
                dst.parent.mkdir(parents=True, exist_ok=True)
                _sh.copy2(src, dst)
            _fetch.link_with_strategy = _copy_only
        except Exception:
            pass
        try:
            from speechbrain.inference.speaker import EncoderClassifier  # sb 1.x
        except ImportError:
            from speechbrain.pretrained import EncoderClassifier  # sb 0.5.x (pyannote 3.1 호환용 다운그레이드)
        import torch
        run_opts = {"device": "cuda"} if torch.cuda.is_available() else None
        classifier = EncoderClassifier.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb",
            savedir=os.path.join(os.path.expanduser("~"), ".cache", "speechbrain", "ecapa"),
            run_opts=run_opts,
        )
        print(f"   [diarize] SpeechBrain ECAPA 로드 ({'CUDA' if run_opts else 'CPU'})")
        _ecapa_classifier = classifier
        return classifier
    except Exception as e:
        print(f"   [diarize] ECAPA 로드 실패: {str(e)[:150]}")
        return None


def _diarize_audio(audio_path: str, segments: list[dict] | None = None,
                   expected_speakers: int | None = None) -> list[dict] | None:
    """오디오 → 화자별 발화 구간. SpeechBrain ECAPA embedding + 클러스터링.

    expected_speakers 있으면 KMeans (n_clusters 고정) · 없으면 Agglomerative (threshold auto).
    KMeans가 실측에서 훨씬 정확 (환승연애 9명 · Agglomerative 0.8→다수 vs KMeans 9).

    min duration 1.0s · 너무 짧은 세그는 embedding 노이즈로 부정확.
    """
    if not segments:
        return None
    classifier = _get_ecapa_classifier()
    if classifier is None:
        return None
    try:
        import torch
        import torchaudio
        import numpy as np

        # 오디오 로드 (mp4면 임시 wav 변환)
        src = audio_path
        if not audio_path.lower().endswith((".wav", ".flac")):
            import tempfile
            tmp_wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
            subprocess.run(
                ["ffmpeg", "-y", "-v", "quiet", "-i", audio_path,
                 "-vn", "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le", tmp_wav],
                check=True,
            )
            src = tmp_wav

        waveform, sr = torchaudio.load(src)
        if sr != 16000:
            waveform = torchaudio.functional.resample(waveform, sr, 16000)
            sr = 16000
        if waveform.shape[0] > 1:
            waveform = waveform.mean(dim=0, keepdim=True)
        device = "cuda" if torch.cuda.is_available() else "cpu"
        waveform = waveform.to(device)

        # embedding · min 0.5s (예능 짧은 발화 커버율 up · 이보다 짧으면 embedding 노이즈)
        embeddings: list[np.ndarray] = []
        seg_indices: list[int] = []
        MIN_DUR = 0.5
        for i, seg in enumerate(segments):
            try:
                st = float(seg.get("start", 0)); en = float(seg.get("end", st + 1))
            except (TypeError, ValueError):
                continue
            if en - st < MIN_DUR:
                continue
            start_sample = int(st * sr)
            end_sample = min(int(en * sr), waveform.shape[1])
            if end_sample <= start_sample:
                continue
            slice_wav = waveform[:, start_sample:end_sample]
            with torch.no_grad():
                emb = classifier.encode_batch(slice_wav).squeeze().cpu().numpy()
            embeddings.append(emb)
            seg_indices.append(i)

        if len(embeddings) < 2:
            print(f"   [diarize] 유효 세그 부족 ({len(embeddings)}개) · 스킵")
            return None

        X = np.array(embeddings)
        X = X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-8)

        # KMeans (expected_speakers 있을 때 · 정확도↑) or Agglomerative (자동 결정)
        if expected_speakers and expected_speakers >= 2 and expected_speakers <= len(embeddings):
            from sklearn.cluster import KMeans
            # 방송 예능은 host/narrator 추가 있을 수 있어 cast+1~2 여유
            k = min(expected_speakers + 2, len(embeddings))
            km = KMeans(n_clusters=k, random_state=42, n_init=10)
            labels = km.fit_predict(X)
            method = f"KMeans k={k} (cast_size={expected_speakers})"
        else:
            from sklearn.cluster import AgglomerativeClustering
            clustering = AgglomerativeClustering(
                n_clusters=None, metric="cosine", linkage="average",
                distance_threshold=0.8,
            )
            labels = clustering.fit_predict(X)
            method = "Agglomerative threshold=0.8"

        n_speakers = len(set(labels))
        print(f"   [diarize] SpeechBrain · {method} · {len(embeddings)} seg → {n_speakers}명")

        turns = []
        for seg_i, lbl in zip(seg_indices, labels):
            seg = segments[seg_i]
            turns.append({
                "start": round(float(seg.get("start", 0)), 3),
                "end": round(float(seg.get("end", 0)), 3),
                # 실명 추론은 하지 않는다. 화자 구분은 익명·일관된 ID로만 제공하고,
                # 운영자가 프론트에서 등록된 출연자와 연결할 때만 이름을 붙인다.
                "speaker": f"발화자 {int(lbl) + 1}",
            })
        return turns
    except Exception as e:
        print(f"   [diarize] 실행 실패: {str(e)[:200]}")
        import traceback; traceback.print_exc()
        return None


def _assign_speakers(segs: list[dict], turns: list[dict]) -> tuple[list[dict], dict]:
    """각 STT 세그의 mid time을 포함하는 diarization turn의 speaker 붙임.
    포함 turn 없으면 가장 가까운 turn (오디오 없는 짧은 gap 커버)."""
    if not segs or not turns:
        return segs, {"assigned": 0, "unique_speakers": 0}
    out = []
    assigned = 0
    speakers_seen: set = set()
    for s in segs:
        try:
            st = float(s.get("start", 0)); en = float(s.get("end", st + 1))
        except (TypeError, ValueError):
            out.append(s); continue
        mid = (st + en) / 2
        # 포함 turn
        matched = None
        for t in turns:
            if t["start"] <= mid <= t["end"]:
                matched = t["speaker"]; break
        # 없으면 nearest
        if not matched:
            matched = min(turns, key=lambda t: min(abs(t["start"] - mid), abs(t["end"] - mid)))["speaker"]
        new_seg = dict(s)
        new_seg["speaker"] = matched  # 발화자 1, 발화자 2 … 익명·일관 라벨
        speakers_seen.add(matched)
        out.append(new_seg)
        assigned += 1
    return out, {"assigned": assigned, "unique_speakers": len(speakers_seen)}


def _normalize_word_timestamps(segments: list[dict], max_word_dur: float = 0.8) -> tuple[list[dict], dict]:
    """faster-whisper의 word.end 침묵 삼킴 fix (2026-07-27 실측 기반).

    관찰: 30s 청크 경계 근처와 예능 BGM/웃음 구간에서 whisper가 word.end를 실제 발음 종료가
    아니라 다음 침묵/음악까지 늘려 잡음. 예: "제일" 2220ms, "오광수," 2980ms.
    이게 누적되어 후반부 timestamp가 실제보다 뒤로 밀림(실측 +32% stretch, 전 25% 452ms →
    후 25% 597ms). 사용자 체감: "초반은 맞다가 뒤로 갈수록 자막이 늦음".

    두 가지 정리:
      1) 세그 내 word.end > next.word.start → next.word.start - 20ms (침묵 삼킴 fix)
      2) word duration이 max_word_dur(기본 800ms) 초과하면 start + max_word_dur로 clip
         (이상치 컷 · 한국어 word는 일반적으로 <800ms · 예외는 이름·강조어 뿐)
    세그 boundary(seg.start·seg.end)는 words 결과에 맞춰 재조정.
    """
    if not segments:
        return segments, {"seg_boundary_fixed": 0, "words_clamped_next": 0, "words_capped_dur": 0}

    seg_fixed = 0
    words_clamped_next = 0
    words_capped_dur = 0
    max_stretch_before_ms = 0.0

    out: list[dict] = []
    for s in segments:
        ws = s.get("words") or []
        if not ws:
            out.append(dict(s))
            continue

        new_words: list[dict] = []
        for i, w in enumerate(ws):
            try:
                wst = float(w.get("start", 0))
                wen = float(w.get("end", wst))
            except (TypeError, ValueError):
                new_words.append(dict(w))
                continue

            # 1) 다음 word가 있으면 그 start 직전으로 clip
            if i + 1 < len(ws):
                try:
                    next_wst = float(ws[i + 1].get("start", wen))
                    if wen > next_wst - 0.02:
                        new_end = max(wst + 0.05, next_wst - 0.02)
                        if wen - new_end > 0.05:  # 50ms 이상 clip 됐을 때만 카운트
                            words_clamped_next += 1
                            max_stretch_before_ms = max(max_stretch_before_ms, (wen - new_end) * 1000)
                        wen = new_end
                except (TypeError, ValueError):
                    pass

            # 2) 이상치 duration cap (마지막 word 포함)
            dur = wen - wst
            if dur > max_word_dur:
                new_end = wst + max_word_dur
                if wen - new_end > 0.05:
                    words_capped_dur += 1
                    max_stretch_before_ms = max(max_stretch_before_ms, (wen - new_end) * 1000)
                wen = new_end

            new_words.append({**w, "start": round(wst, 3), "end": round(wen, 3)})

        # 세그 boundary 재조정 (words가 정리됐으므로 seg.end도 앞당겨질 수 있음)
        new_seg = dict(s)
        new_seg["words"] = new_words
        try:
            first_start = float(new_words[0]["start"])
            last_end = float(new_words[-1]["end"])
            if abs(float(s.get("start", first_start)) - first_start) > 0.01:
                seg_fixed += 1
            if abs(float(s.get("end", last_end)) - last_end) > 0.01:
                seg_fixed += 1
            new_seg["start"] = round(first_start, 3)
            new_seg["end"] = round(last_end, 3)
        except (TypeError, ValueError, IndexError):
            pass
        out.append(new_seg)

    stats = {
        "seg_boundary_fixed": seg_fixed,
        "words_clamped_next": words_clamped_next,
        "words_capped_dur": words_capped_dur,
        "max_stretch_ms": round(max_stretch_before_ms, 1),
    }
    return out, stats


def _apply_vad_postprocess(audio_path: str, result: dict,
                           expected_speakers: int | None = None) -> dict:
    """STT 결과 세그먼트 후처리 · 공통:
    0) word timestamp 정규화 (침묵 삼킴 · 이상치 duration cap) — 후반부 stretch drift fix
    1) Silero VAD → 음성 구간 boundary 스냅 (whisper word 있는 세그는 스킵, Gemini 폴백만)
    2) SpeechBrain ECAPA diarization → speaker_id 배정
    """
    segs = result.get("segments") if isinstance(result, dict) else None
    if not segs:
        return result

    # 0) word timestamp 정규화 — 30s chunk drift · BGM stretch 이상치 clip
    segs, wstats = _normalize_word_timestamps(segs)
    if wstats["words_clamped_next"] or wstats["words_capped_dur"]:
        print(f"   [wnorm] 다음 word.start로 clip {wstats['words_clamped_next']}개 · "
              f"duration cap {wstats['words_capped_dur']}개 · "
              f"max shift {wstats['max_stretch_ms']}ms · seg 경계 재조정 {wstats['seg_boundary_fixed']}회")
    result["segments"] = segs
    result["word_norm_stats"] = wstats

    # 1) VAD 스냅
    windows = _get_speech_windows(audio_path)
    if windows:
        segs, stats = _snap_to_speech_windows(segs, windows)
        print(f"   [vad] {stats['windows']} window · 스냅 start {stats['snapped_start']} · "
              f"end {stats['snapped_end']} · 평균 {stats['mean_snap_ms']:+.0f}ms")
        result["segments"] = segs
        result["vad_stats"] = stats

    # 2) 화자분리 (SpeechBrain ECAPA · HF token 불필요)
    turns = _diarize_audio(audio_path, segments=segs, expected_speakers=expected_speakers)
    if turns:
        segs, dstats = _assign_speakers(segs, turns)
        print(f"   [diarize] turn {len(turns)}개 · seg에 speaker 배정 {dstats['assigned']} · "
              f"화자 {dstats['unique_speakers']}명")
        result["segments"] = segs
        result["diarization_stats"] = dstats
        result["diarization_turns"] = turns  # 진단·downstream 참고용
    return result


# ── (Deprecated 2026-07-27) Gemini↔whisper alignment 삭제 ─────────────────────
# 이전 하이브리드는 Gemini 텍스트를 whisper words에 prefix 매칭했으나 실측
# (20세그 GOOD 15% · BAD 55%)에서 근본적 오배정을 확인. duplicate Gemini 세그 +
# `whisper_segment` 폴백이 완전 다른 대사의 words를 붙이는 게 원인. hybrid는 이제
# whisper-primary(_transcribe_hybrid)로 재설계. alignment 로직·헬퍼는 완전 제거.


def _whisper_device_auto() -> tuple[str, str]:
    """CUDA 사용 가능하면 (cuda, float16), 아니면 (cpu, int8) 폴백. faster-whisper 최적 세팅."""
    try:
        import torch
        if torch.cuda.is_available():
            return ("cuda", "float16")
    except Exception:
        pass
    return ("cpu", "int8")


def _transcribe_hybrid(audio_path: str, language: str, on_progress=None, beam_size: int = 5,
                       expected_speakers: int | None = None) -> dict:
    """whisper-primary (2026-07-27 재설계). 예전엔 Gemini 텍스트 + whisper 시각 병렬 정렬이었지만,
    실측(20세그 3 GOOD · 4 MID · 11 BAD · 2 KEPT)에서 alignment가 절반 이상 오배정을 만들었다.
    원인 두 가지:
      1) Gemini 윈도우 오버랩이 duplicate 세그를 만들어 매칭 후보를 흐림
      2) 매칭 실패 시 nearest whisper 세그를 통째 붙이는 폴백이 완전 다른 대사의 words를 붙임
    따라서 이제는 whisper 세그·words 자체를 진실로 삼고, 텍스트 polish는 이후 refine.py 단계
    (Gemini)가 담당한다. 결과: 세그 100% words 첨부 · duplicate 없음 · align_source 개념 삭제.
    """
    dev, ctype = _whisper_device_auto()
    print(f"   STT whisper-primary: faster-whisper({dev} · {ctype})")
    result = _transcribe_whisper(audio_path, language, "large-v3", dev, ctype, beam_size)
    # 각 whisper 세그는 이미 {start, end, text, words}를 채워 반환한다 (_transcribe_whisper 참조).
    # 별도 alignment 불필요 — words[i].start/.end가 그대로 다운스트림 컷 스냅 seed.
    return _apply_vad_postprocess(audio_path, result, expected_speakers=expected_speakers)


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
    """stt 결과에서 downstream(refine/beats)이 쓰는 세그 필드만 뽑는다.
    2026-07-27: speaker 필드 보존 추가 — diarization 결과가 refine에서 사라져 beats·shorts가
    화자 인식 못 하는 문제 fix. 같은 화자 monologue 중간에서 beat이 잘리는 사용자 지적 원인."""
    out = []
    for seg in result["segments"]:
        row = {
            "start": seg["start"],
            "end": seg["end"],
            "text": (seg.get("text") or "").strip(),
            "words": seg.get("words", []),
        }
        sp = (seg.get("speaker") or "").strip()
        if sp:
            row["speaker"] = sp
        out.append(row)
    return out
