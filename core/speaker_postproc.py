"""화자분리 raw 결과 후처리 (Layer 1 · 오디오·STT만).

WhisperX 의 assign_word_speakers 는 diarize turn 과 word 시각 겹칠 때만 speaker 를
붙인다. 짧은 세그나 turn 사이 gap 에 있는 세그는 speaker='' 로 남고, 화자가 튀는
구간에서는 하나의 발화가 여러 speaker 로 잘못 나뉘는 케이스도 흔하다.

여기서 잡는 3가지 규칙 (한국 예능 특성 반영):
  1) 짧은 세그(<MIN_STABLE) + 앞뒤 동일 speaker → 그 speaker 로 흡수
  2) speaker=='' 세그 → 시간 gap≤GAP_SEC 안 인접 speaker 계승 (앞 우선, 없으면 뒤)
  3) 접속사(그리고/근데/그래서 등) 로 시작 + 앞 세그와 gap≤GAP_SEC → 앞 speaker 로 rewrite

원본 mutate 안 함 · 새 list 반환. 통계는 stderr 로 로깅.
"""
from __future__ import annotations

MIN_STABLE_SEC = 1.0
GAP_SEC = 2.0
CONJUNCTIONS = ("그리고", "근데", "그런데", "그래서", "그러니까", "그럼",
                "그래도", "그러면", "그러다", "그러니", "그러므로",
                "하지만", "그치만", "그니까", "그러다가")


def _spk(seg: dict) -> str:
    return (seg.get("speaker") or "").strip()


def _dur(seg: dict) -> float:
    try:
        return float(seg.get("end", 0)) - float(seg.get("start", 0))
    except (TypeError, ValueError):
        return 0.0


def _gap_after(prev: dict, cur: dict) -> float:
    try:
        return float(cur.get("start", 0)) - float(prev.get("end", 0))
    except (TypeError, ValueError):
        return 1e9


def absorb_short_segments(segments: list[dict], min_stable_sec: float = MIN_STABLE_SEC) -> tuple[list[dict], int]:
    """짧은 세그(<min_stable_sec)의 speaker 를 앞뒤 speaker 로 흡수. 앞·뒤 같아야 함."""
    out = [dict(s) for s in segments]
    changed = 0
    for i, seg in enumerate(out):
        if _dur(seg) >= min_stable_sec:
            continue
        cur = _spk(seg)
        prev = _spk(out[i - 1]) if i > 0 else ""
        nxt = _spk(out[i + 1]) if i + 1 < len(out) else ""
        # 짧은데 앞뒤 같은 speaker 면 그걸로 통일
        if prev and prev == nxt and prev != cur:
            seg["speaker"] = prev
            changed += 1
            continue
        # 짧고 speaker 없는데 앞뒤 중 하나라도 있으면 그걸 계승 (앞 우선)
        if not cur:
            pick = prev or nxt
            if pick:
                seg["speaker"] = pick
                changed += 1
    return out, changed


def inherit_empty(segments: list[dict], gap_sec: float = GAP_SEC) -> tuple[list[dict], int]:
    """speaker='' 세그를 시간 근접(gap≤gap_sec) 인접 speaker 로 계승. 앞 우선, 없으면 뒤."""
    out = [dict(s) for s in segments]
    changed = 0
    for i, seg in enumerate(out):
        if _spk(seg):
            continue
        prev_seg = out[i - 1] if i > 0 else None
        nxt_seg = out[i + 1] if i + 1 < len(out) else None
        prev_spk = _spk(prev_seg) if prev_seg else ""
        nxt_spk = _spk(nxt_seg) if nxt_seg else ""
        # 앞 우선 (근접 & speaker 있음)
        if prev_spk and prev_seg is not None and _gap_after(prev_seg, seg) <= gap_sec:
            seg["speaker"] = prev_spk
            changed += 1
            continue
        # 뒤 fallback
        if nxt_spk and nxt_seg is not None and _gap_after(seg, nxt_seg) <= gap_sec:
            seg["speaker"] = nxt_spk
            changed += 1
    return out, changed


def inherit_conjunction(segments: list[dict], gap_sec: float = GAP_SEC,
                          conjunctions: tuple[str, ...] = CONJUNCTIONS) -> tuple[list[dict], int]:
    """접속사로 시작 + 앞 세그와 gap≤gap_sec → 앞 speaker 로 rewrite (같은 화자 이어짐 판정).

    speaker 가 이미 붙어있어도 앞 speaker 로 덮음 (PyAnnote 오탐 정정용).
    앞 speaker 없으면 skip.
    """
    out = [dict(s) for s in segments]
    changed = 0
    for i, seg in enumerate(out):
        if i == 0:
            continue
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        if not any(text.startswith(c) for c in conjunctions):
            continue
        prev = out[i - 1]
        prev_spk = _spk(prev)
        if not prev_spk:
            continue
        if _gap_after(prev, seg) > gap_sec:
            continue
        if _spk(seg) != prev_spk:
            seg["speaker"] = prev_spk
            changed += 1
    return out, changed


def postprocess(segments: list[dict], *,
                min_stable_sec: float = MIN_STABLE_SEC,
                gap_sec: float = GAP_SEC) -> tuple[list[dict], dict]:
    """3규칙 순차 적용. 반환: (수정된 segments, stats)."""
    stats: dict = {}
    segs = segments
    segs, stats["conjunction"] = inherit_conjunction(segs, gap_sec=gap_sec)
    segs, stats["short_absorb"] = absorb_short_segments(segs, min_stable_sec=min_stable_sec)
    segs, stats["empty_inherit"] = inherit_empty(segs, gap_sec=gap_sec)
    stats["total_changed"] = sum(stats.values())
    return segs, stats


def rewrite_names(segments: list[dict], name_map: dict[str, str]) -> tuple[list[dict], dict]:
    """세그의 text·words[].word·speaker 필드에서 name_map(오탈자 → 정답)을 일괄 치환.

    예: STT 가 '류진' 으로 잘못 뽑은 것을 등록된 실명 '유식' 으로 정정. speaker 라벨에도
    적용해 chyron/얼굴 매핑으로 실명 붙은 뒤 오탈자만 남은 케이스도 정리.

    치환은 whole-word 가 아니라 substring · 한국어는 어절이 붙어있어 substring 이 자연스러움
    (예 '류진이가' → '유식이가'). 다만 짧은 이름은 오히려 오치환 위험 · name_map 은
    사용자가 명시적으로 넘긴 dict 만 사용 (자동 fuzzy match X).
    """
    if not name_map:
        return segments, {"rewritten_text": 0, "rewritten_words": 0, "rewritten_speaker": 0}
    stats = {"rewritten_text": 0, "rewritten_words": 0, "rewritten_speaker": 0}
    out = [dict(s) for s in segments]
    for s in out:
        # text
        text = s.get("text") or ""
        new_text = text
        for wrong, right in name_map.items():
            if wrong and wrong in new_text:
                new_text = new_text.replace(wrong, right)
        if new_text != text:
            s["text"] = new_text
            stats["rewritten_text"] += 1
        # words[].word
        ws = s.get("words") or []
        new_ws = []
        w_changed = False
        for w in ws:
            wd = w.get("word") or ""
            new_wd = wd
            for wrong, right in name_map.items():
                if wrong and wrong in new_wd:
                    new_wd = new_wd.replace(wrong, right)
            if new_wd != wd:
                w = dict(w); w["word"] = new_wd; w_changed = True
            new_ws.append(w)
        if w_changed:
            s["words"] = new_ws
            stats["rewritten_words"] += 1
        # speaker (실명 부여된 후 오탈자만 정정하는 케이스)
        sp = (s.get("speaker") or "").strip()
        if sp in name_map:
            s["speaker"] = name_map[sp]
            stats["rewritten_speaker"] += 1
    return out, stats


def rediarize_pyannote_embedding(audio_path: str, segments: list[dict],
                                   expected_speakers: int | None = None,
                                   distance_threshold: float = 0.65,
                                   min_dur_sec: float = 0.5) -> tuple[list[dict], dict]:
    """PyAnnote 임베딩 모델(pyannote/wespeaker-voxceleb-resnet34-LM)만 로드해서
    Soniox STT 세그 시각별로 embedding 을 뽑고 Agglomerative cosine 클러스터링으로 speaker 부여.

    Pipeline 방식(rediarize_pyannote) 의 차이:
      - Pipeline: PyAnnote 가 자체 segmentation·turn·clustering 다 함 · 우리 세그와 시간 stitch
      - Embedding: 우리 세그 시각을 그대로 사용 · 세그당 정확히 1개 speaker · 시간 stitch 없음

    한국 예능처럼 짧은 발화 다수 케이스에 유리 (PyAnnote 자체 segmentation 편향 회피).
    HF_TOKEN 필요 (pyannote/wespeaker-voxceleb-resnet34-LM · gate accept 필수).
    """
    import os
    hf_token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
    if not hf_token:
        return segments, {"rediarized": 0, "reason": "HF_TOKEN 미설정"}

    # PyTorch 2.6 weights_only 우회
    import torch as _torch
    if not getattr(_torch.load, "_stepd_patched", False):
        _orig = _torch.load
        def _patched(*a, **kw):
            kw["weights_only"] = False
            return _orig(*a, **kw)
        _patched._stepd_patched = True
        _torch.load = _patched

    try:
        from pyannote.audio import Model, Inference
        from pyannote.core import Segment
        model = Model.from_pretrained(
            "pyannote/wespeaker-voxceleb-resnet34-LM", use_auth_token=hf_token,
        )
        if _torch.cuda.is_available():
            model.to(_torch.device("cuda"))
        inference = Inference(model, window="whole")
    except Exception as e:
        return segments, {"rediarized": 0, "reason": f"embedding 모델 로드 실패: {str(e)[:120]}"}

    # audio → wav (pyannote 이 mp4 못 읽음)
    import subprocess, tempfile
    src = audio_path
    tmp_wav = None
    if not audio_path.lower().endswith((".wav", ".flac")):
        tmp_wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
        subprocess.run(
            ["ffmpeg", "-y", "-v", "quiet", "-i", audio_path,
             "-vn", "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le", tmp_wav],
            check=True,
        )
        src = tmp_wav

    import numpy as np
    embeddings: list[np.ndarray] = []
    seg_indices: list[int] = []
    try:
        for i, s in enumerate(segments):
            try:
                st = float(s.get("start", 0)); en = float(s.get("end", 0))
            except (TypeError, ValueError):
                continue
            if en - st < min_dur_sec:
                continue
            try:
                emb = inference.crop(src, Segment(st, en))
                if emb is None:
                    continue
                emb = np.asarray(emb).squeeze()
                embeddings.append(emb)
                seg_indices.append(i)
            except Exception:
                continue
    finally:
        if tmp_wav and os.path.exists(tmp_wav):
            try:
                os.unlink(tmp_wav)
            except Exception:
                pass

    if len(embeddings) < 2:
        return segments, {"rediarized": 0, "reason": f"embedding 부족({len(embeddings)}개)"}

    X = np.array(embeddings)
    X = X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-8)

    if expected_speakers and expected_speakers >= 2 and expected_speakers <= len(embeddings):
        from sklearn.cluster import KMeans
        k = min(expected_speakers + 1, len(embeddings))
        km = KMeans(n_clusters=k, random_state=42, n_init=10)
        labels = km.fit_predict(X)
        method = f"KMeans k={k}"
    else:
        from sklearn.cluster import AgglomerativeClustering
        clustering = AgglomerativeClustering(
            n_clusters=None, metric="cosine", linkage="average",
            distance_threshold=distance_threshold,
        )
        labels = clustering.fit_predict(X)
        method = f"Agglomerative threshold={distance_threshold}"

    out = [dict(s) for s in segments]
    for s in out:
        s["speaker"] = ""  # 벤더 라벨 초기화 · 아래에서 부여, 못 잡으면 Layer 1 empty_inherit
    for seg_i, lbl in zip(seg_indices, labels):
        out[seg_i]["speaker"] = f"SPEAKER_{int(lbl):02d}"

    n_speakers = len(set(labels))
    n_assigned = sum(1 for s in out if s.get("speaker"))
    return out, {
        "rediarized": n_assigned, "n_seg": len(out), "n_speakers": n_speakers,
        "method": method,
    }


def rediarize_pyannote(audio_path: str, segments: list[dict],
                        expected_speakers: int | None = None) -> tuple[list[dict], dict]:
    """PyAnnote 3.1 diarization pipeline 으로 speaker 재라벨.

    HF_TOKEN 필요 (pyannote/speaker-diarization-3.1 · segmentation-3.0 gate accept 필수).
    ECAPA(단순 embedding+KMeans) 대비 훨씬 성숙한 파이프라인 · 예능 짧은 발화도 커버.

    각 STT 세그의 중간 시각을 포함하는 diarize turn 의 speaker 부여 · turn 없으면 ""
    (Layer 1 empty_inherit 가 계승).
    """
    import os
    hf_token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
    if not hf_token:
        return segments, {"rediarized": 0, "reason": "HF_TOKEN 미설정"}

    # PyTorch 2.6 weights_only=True 우회 (asr.py 와 동일)
    import torch as _torch
    if not getattr(_torch.load, "_stepd_patched", False):
        _orig = _torch.load
        def _patched(*a, **kw):
            kw["weights_only"] = False
            return _orig(*a, **kw)
        _patched._stepd_patched = True
        _torch.load = _patched

    try:
        from pyannote.audio import Pipeline
        pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1", use_auth_token=hf_token,
        )
        # GPU
        try:
            if _torch.cuda.is_available():
                pipeline.to(_torch.device("cuda"))
        except Exception:
            pass
    except Exception as e:
        return segments, {"rediarized": 0, "reason": f"pyannote 로드 실패: {str(e)[:120]}"}

    # audio 는 wav 로 변환 (pyannote 이 mp4 못 읽음)
    import subprocess, tempfile
    from pathlib import Path
    src = audio_path
    tmp_wav = None
    if not audio_path.lower().endswith((".wav", ".flac")):
        tmp_wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
        subprocess.run(
            ["ffmpeg", "-y", "-v", "quiet", "-i", audio_path,
             "-vn", "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le", tmp_wav],
            check=True,
        )
        src = tmp_wav

    kwargs: dict = {}
    if expected_speakers and expected_speakers >= 2:
        kwargs["min_speakers"] = expected_speakers
        kwargs["max_speakers"] = expected_speakers + 1

    try:
        diarization = pipeline(src, **kwargs)
    except Exception as e:
        return segments, {"rediarized": 0, "reason": f"pyannote 실행 실패: {str(e)[:120]}"}
    finally:
        if tmp_wav and os.path.exists(tmp_wav):
            try:
                os.unlink(tmp_wav)
            except Exception:
                pass

    # turns: [(start, end, speaker_label)]
    turns: list[tuple[float, float, str]] = []
    for turn, _, spk in diarization.itertracks(yield_label=True):
        turns.append((turn.start, turn.end, str(spk)))

    def _pick_speaker(seg_st: float, seg_en: float) -> str:
        # 세그 중간 시각을 포함하는 turn 우선 · 없으면 최대 overlap turn
        mid = (seg_st + seg_en) / 2.0
        for st, en, sp in turns:
            if st <= mid <= en:
                return sp
        # overlap 최대
        best_sp = ""; best_ov = 0.0
        for st, en, sp in turns:
            ov = max(0.0, min(en, seg_en) - max(st, seg_st))
            if ov > best_ov:
                best_ov = ov; best_sp = sp
        return best_sp if best_ov > 0 else ""

    out = [dict(s) for s in segments]
    n = 0
    for s in out:
        st = float(s.get("start", 0)); en = float(s.get("end", 0))
        spk = _pick_speaker(st, en)
        s["speaker"] = spk  # 빈 문자열이면 Layer 1 empty_inherit 이 계승
        if spk:
            n += 1

    n_speakers = len({sp for _, _, sp in turns})
    return out, {"rediarized": n, "n_seg": len(out), "n_speakers": n_speakers,
                  "n_turns": len(turns)}


def rediarize_ecapa(audio_path: str, segments: list[dict],
                     expected_speakers: int | None = None) -> tuple[list[dict], dict]:
    """벤더 diarize 결과를 버리고 순수 ECAPA 파형 클러스터링으로 speaker 재라벨.

    사용 이유: real-time 최적화 벤더(Soniox)는 시간 근접 발화를 뭉치고, PyAnnote 는
    유사 톤(예능 여성)을 과잉분할하는 등 편향이 다르다. audio embedding 만으로 재클러스터링해서
    벤더 편향에서 벗어난 결과를 얻는다.

    core.asr._diarize_audio (SpeechBrain ECAPA + KMeans/Agglomerative) 재사용.
    반환: (segments with new speaker, stats). speaker='' 인 세그(embedding 부족)는 그대로 둠.
    """
    from .asr import _diarize_audio
    turns = _diarize_audio(audio_path, segments, expected_speakers=expected_speakers)
    if not turns:
        return segments, {"rediarized": 0, "reason": "ecapa 실패"}

    # turns 는 각 segment 시각별 speaker · dict {(start,end): speaker}
    key = lambda t: (round(t["start"], 3), round(t["end"], 3))
    turn_map = {key(t): t["speaker"] for t in turns}
    out = [dict(s) for s in segments]
    n = 0
    for s in out:
        k = (round(float(s.get("start", 0)), 3), round(float(s.get("end", 0)), 3))
        if k in turn_map:
            s["speaker"] = turn_map[k]
            n += 1
        else:
            # ECAPA 커버 못한 세그(주로 <1s)는 벤더 라벨 대신 speaker='' 로 초기화.
            # Layer 1 empty_inherit 이 시간 근접 ECAPA 화자로 채운다. 벤더/ECAPA 라벨
            # 뒤섞임을 없애 최종 speaker set 을 하나의 체계로 통일.
            s["speaker"] = ""
    return out, {"rediarized": n, "n_seg": len(out), "n_speakers": len({t["speaker"] for t in turns})}
