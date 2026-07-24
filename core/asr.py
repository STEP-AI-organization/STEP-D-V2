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

    STT_PROVIDER 옵션:
      - "whisper": faster-whisper 단독
      - "hybrid" : Gemini text + whisper timestamp 병렬 (2026-07-24 신규 · 정확한 시각)
      - 기본     : Gemini 단독 + 실패 시 whisper fallback
    """
    if STT_PROVIDER == "whisper":
        return _transcribe_whisper(audio_path, language, model_name, device, compute_type, beam_size)
    if STT_PROVIDER == "hybrid":
        return _transcribe_hybrid(audio_path, language, on_progress=on_progress, beam_size=beam_size)

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


# ── Hybrid: Gemini text + whisper timestamp (2026-07-24) ────────────────────────
#
# 관찰: Gemini asr는 text는 정확하지만 segment 시작·끝 timestamp가 부정확 (특히 60분+
# 영상에서 초 단위 drift). 이 시각이 downstream(shorts 자르기·editor 자막 sync)에 그대로
# 흘러가 큰 오차 유발. faster-whisper는 wav2vec2 forced alignment 원리로 word-level
# timestamp가 훨씬 정확 (10~50ms). 두 개 병렬 실행해서 text는 Gemini · 시각은 whisper.

def _norm_ko(s: str) -> str:
    """한국어 매칭용 정규화: 공백·구두점 제거, 소문자화."""
    import re
    return re.sub(r"[\s\.,\?!\-…·'\"]+", "", (s or "")).lower()


def _align_gemini_to_whisper(gemini_segs: list[dict], whisper_segs: list[dict]) -> tuple[list[dict], dict]:
    """Word-level alignment (v2 · 2026-07-24 개선):

    이전 v1의 두 이슈 fix:
      a) 매칭률 39% → whisper words flat list에서 subsequence 검색으로 향상
      b) 짧은 텍스트("직업만" 3글자) 팽창 → text 길이만큼의 word range 정확 매핑

    알고리즘:
      1) whisper segs → flat words list (시간순 · abs_start/abs_end/text)
      2) 각 Gemini seg text 정규화
      3) Gemini seg 시각 ± 5초 range 안의 words 후보 추림
      4) 후보 words의 text concat에서 Gemini text 앞 10글자로 시작 위치 pinpoint
      5) 매칭 못하면 앞 5글자 · 3글자 순서로 부분 매칭 재시도
      6) Gemini text 길이만큼의 word range 정확히 매핑 · 첫 word.start ~ 마지막 word.end
      7) 팽창 방지: 매칭 word range 총 text 길이가 Gemini 길이 대비 3배 초과면 reject
    """
    if not gemini_segs or not whisper_segs:
        return gemini_segs, {"aligned": 0, "kept": len(gemini_segs), "mean_shift_ms": 0.0, "max_shift_ms": 0.0}

    # 1) whisper words flat list
    flat_words: list[dict] = []
    for ws in whisper_segs:
        for w in (ws.get("words") or []):
            try:
                st = float(w.get("start", 0)); en = float(w.get("end", 0))
            except (TypeError, ValueError):
                continue
            if en <= st:
                continue
            txt = _norm_ko(w.get("word") or "")
            if not txt:
                continue
            flat_words.append({"start": st, "end": en, "text": txt})
    if not flat_words:
        # whisper words 정보 없음 (fallback: seg 단위) — v1 방식으로 폴백
        return gemini_segs, {"aligned": 0, "kept": len(gemini_segs), "mean_shift_ms": 0.0, "max_shift_ms": 0.0, "note": "no_whisper_words"}

    aligned: list[dict] = []
    shifts_ms: list[float] = []
    kept = 0
    W_WINDOW = 5.0

    for g in gemini_segs:
        try:
            g_start = float(g.get("start", 0))
            g_end = float(g.get("end", g_start + 3))
        except (TypeError, ValueError):
            aligned.append(g); kept += 1; continue
        g_text_norm = _norm_ko(g.get("text", ""))
        if len(g_text_norm) < 2:
            aligned.append(g); kept += 1; continue

        # 후보 words: Gemini seg 시각 ± 5s 겹치는 것들 (index 유지)
        lo, hi = g_start - W_WINDOW, g_end + W_WINDOW
        cand = [(i, w) for i, w in enumerate(flat_words) if w["end"] > lo and w["start"] < hi]
        if not cand:
            aligned.append(g); kept += 1; continue

        # 후보 words의 text concat + 각 word 시작 char 인덱스 매핑
        char_starts: list[tuple[int, int]] = []  # [(char_index, cand_index)] 각 word 시작
        cand_text = ""
        for idx, (_, w) in enumerate(cand):
            char_starts.append((len(cand_text), idx))
            cand_text += w["text"]

        # 매칭 시도: 앞 10, 앞 5, 앞 3글자 순으로 pinpoint
        pos = -1
        for prefix_len in (10, 5, 3):
            if len(g_text_norm) < prefix_len:
                continue
            key = g_text_norm[:prefix_len]
            pos = cand_text.find(key)
            if pos >= 0:
                break
        # 짧으면 (< 3글자) 전체 일치 시도
        if pos < 0 and len(g_text_norm) >= 2:
            pos = cand_text.find(g_text_norm)

        # 매칭 실패해도 시작·끝은 확실히 잡음 (2026-07-24 사용자 지적):
        # nearest whisper word start로 시작 확정 · 한글 음절 평균 0.15초 × 글자수로 duration 추정.
        # 이렇게 하면 kept 세그도 시작만이라도 whisper 기준 · 끝은 발화 예상 길이로 완결.
        if pos < 0:
            # Gemini start와 가장 가까운 word 찾기
            nearest = min(cand, key=lambda pr: abs(pr[1]["start"] - g_start))
            near_start = nearest[1]["start"]
            est_dur = max(0.5, min(15.0, len(g_text_norm) * 0.15))
            near_end = near_start + est_dur
            shift = (near_start - g_start) * 1000.0
            shifts_ms.append(shift)
            new_seg = dict(g)
            new_seg["start"] = round(near_start, 3)
            new_seg["end"] = round(near_end, 3)
            new_seg["orig_start"] = g_start
            new_seg["orig_end"] = g_end
            new_seg["align_source"] = "whisper_nearest"
            aligned.append(new_seg)
            continue

        # pos에 해당하는 첫 word 찾기
        first_word_idx = None
        for char_i, cand_i in char_starts:
            if char_i <= pos:
                first_word_idx = cand_i
            else:
                break
        if first_word_idx is None:
            aligned.append(g); kept += 1; continue

        # Gemini text 길이만큼의 word range 매핑 · 팽창 방지
        target_char_end = pos + len(g_text_norm)
        acc_char = 0
        last_word_idx = first_word_idx
        for idx in range(first_word_idx, len(cand)):
            wtl = len(cand[idx][1]["text"])
            acc_char += wtl
            last_word_idx = idx
            if char_starts[first_word_idx][0] + acc_char >= target_char_end:
                break
        # 팽창 검증: 매칭 word range 총 char 수가 Gemini 대비 3배 초과면 reject
        matched_char_len = sum(len(cand[i][1]["text"]) for i in range(first_word_idx, last_word_idx + 1))
        if matched_char_len > len(g_text_norm) * 3:
            aligned.append(g); kept += 1; continue

        new_start = cand[first_word_idx][1]["start"]
        new_end = cand[last_word_idx][1]["end"]
        if new_end <= new_start:
            aligned.append(g); kept += 1; continue

        shift = (new_start - g_start) * 1000.0
        shifts_ms.append(shift)
        new_seg = dict(g)
        new_seg["start"] = round(new_start, 3)
        new_seg["end"] = round(new_end, 3)
        new_seg["orig_start"] = g_start
        new_seg["orig_end"] = g_end
        new_seg["align_source"] = "whisper_word"
        aligned.append(new_seg)

    stats = {
        "aligned": len(aligned) - kept,
        "kept": kept,
        "mean_shift_ms": round(sum(shifts_ms) / len(shifts_ms), 1) if shifts_ms else 0.0,
        "max_shift_ms": round(max(abs(s) for s in shifts_ms), 1) if shifts_ms else 0.0,
        "min_shift_ms": round(min(shifts_ms), 1) if shifts_ms else 0.0,
        "max_pos_shift_ms": round(max(shifts_ms), 1) if shifts_ms else 0.0,
    }
    return aligned, stats


def _seq_similar(a: str, b: str) -> float:
    """difflib 기반 유사도 (0.0~1.0). 짧은 문자열엔 정확 · 긴 문자열엔 부분 매칭도 잡음."""
    from difflib import SequenceMatcher
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def _whisper_device_auto() -> tuple[str, str]:
    """CUDA 사용 가능하면 (cuda, float16), 아니면 (cpu, int8) 폴백. faster-whisper 최적 세팅."""
    try:
        import torch
        if torch.cuda.is_available():
            return ("cuda", "float16")
    except Exception:
        pass
    return ("cpu", "int8")


def _transcribe_hybrid(audio_path: str, language: str, on_progress=None, beam_size: int = 5) -> dict:
    """Gemini + faster-whisper 병렬 실행 · Gemini text 유지 · whisper timestamp로 재정렬.
    whisper는 CUDA 있으면 GPU float16으로 (RTX 급이면 30분 영상 1~2분) · 없으면 CPU int8."""
    dev, ctype = _whisper_device_auto()
    print(f"   STT hybrid: Gemini + faster-whisper({dev} · {ctype}) 병렬 실행 중")
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=2) as ex:
        f_gem = ex.submit(_transcribe_gemini, audio_path, language, on_progress)
        f_whi = ex.submit(_transcribe_whisper, audio_path, language, "large-v3", dev, ctype, beam_size)
        try:
            gem = f_gem.result()
        except Exception as e:
            print(f"   STT hybrid: Gemini 실패 ({str(e)[:80]}) → whisper 단독 결과 사용")
            return f_whi.result()
        try:
            whi = f_whi.result()
        except Exception as e:
            print(f"   STT hybrid: whisper 실패 ({str(e)[:80]}) → Gemini 단독 결과 반환 (timestamp 부정확)")
            return gem

    gem_segs = gem.get("segments", [])
    whi_segs = whi.get("segments", [])
    if not gem_segs or not whi_segs:
        print(f"   STT hybrid: 한쪽 빈 결과 → Gemini 반환")
        return gem

    aligned, stats = _align_gemini_to_whisper(gem_segs, whi_segs)
    print(f"   STT hybrid: alignment {stats['aligned']}/{len(gem_segs)} 재정렬 · "
          f"평균 shift {stats['mean_shift_ms']:+.0f}ms · max {stats['max_shift_ms']:.0f}ms")
    return {
        "segments": aligned,
        "language": gem.get("language", language),
        "alignment_stats": stats,
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
