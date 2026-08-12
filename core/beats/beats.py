"""
STEP D Core — Beat units (AI-정돈된 편집 최소 완결 단위)

사용자 방향(2026-07-24): shortform/clip을 시나리오 단위로 매번 자유 시각 뽑으니 경계가
이상해짐(60초 미달·대사 중간 잘림). 방송 편집 실무처럼 **먼저 "그대로 써도 이상하지 않은
최소 편집 단위(beat)"를 만들어두고**, recommend는 그 beat들을 조합만 하도록 뒤집는다.

Beat 정의:
- 하나의 완결된 흐름 (예: "민경 자기소개 + 반응", "게임 라운드 1 결과").
- 시작은 새 신·새 화제·새 발화 시작 · 끝은 대사 종결·리액션 마무리·다음 신 전환 직전.
- 최소 20초 (그 이하는 파편) · 최대는 없음(코너 전체가 통째로 beat여도 OK).
- **5분(300s) 초과** beat는 소주제 여러 개일 확률 → 서브 beat로 재분해 시도.

입력:
- narrative.json (segments = 5분 청크별 상세 · key_moments · characters)
- refined transcript (speaker 붙은 대사)
- shots (프레임 diff 기반 shot boundary 시각 리스트)
- duration (초)

출력: beats.json = { "beats": [{ id, start, end, title, summary, characters, hook,
  is_complete, source_segment }, ...] }
"""
from __future__ import annotations

import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Optional

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

from google import genai
from google.genai import types

from core.common.retry import call_with_retry

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT") or "step-d"
LOCATION = os.environ.get("VERTEX_LOCATION") or "asia-northeast3"
from core.common.models import BEATS as MODEL

MIN_BEAT_SEC = 8.0      # 이 미만은 파편 · 인접 beat와 병합 (2026-07-27: 20→8, 세분화 요청)
# 위 병합은 speaker-aware 라서 "화자 다르면 안 붙임" 예외가 있다. 그 예외가 화자 분할과
# 맞물려 1초짜리 beat 까지 살아남았다(실측 52%). 아래는 **예외 없는 하한** — 편집 단위로
# 쓸 수 없는 길이는 화자 순수성보다 우선해 없앤다. (사용자 요청 2026-08-07)
HARD_MIN_BEAT_SEC = float(os.environ.get("MIN_BEAT_SEC") or 6.0)
SUBDIVIDE_SEC = 30.0    # 이 초과는 재분해 시도 (2026-07-27: 45→30, 73s 두 인물 붙어있던 케이스 fix)
SHOT_SNAP_SEC = 3.0     # beat 경계 ±3s 안 shot boundary 있으면 스냅

HOOK_KEYS = ["반전", "감정고조", "돌직구", "질문", "정보성", "웃음", "갈등", "공감", "기타"]


def _mmss(sec: float) -> str:
    try:
        s = float(sec)
    except (TypeError, ValueError):
        return "0:00"
    return f"{int(s // 60)}:{int(s % 60):02d}"


def _segments_in_range(transcript: list[dict], lo: float, hi: float,
                       max_lines: int = 300, line_chars: int = 140) -> list[str]:
    """[lo, hi] 겹치는 자막 라인 반환. speaker prefix 포함."""
    out = []
    for t in transcript or []:
        try:
            tst = float(t.get("start", 0))
            ten = float(t.get("end", 0))
        except (TypeError, ValueError):
            continue
        if ten <= lo or tst >= hi:
            continue
        txt = (t.get("text") or "").strip()
        if not txt:
            continue
        sp = (t.get("speaker") or "").strip()
        prefix = f"[{_mmss(tst)}]" + (f" [{sp}]" if sp else "")
        out.append(f"{prefix} {txt[:line_chars]}")
        if len(out) >= max_lines:
            break
    return out


def _shots_in_range(shots: list[float] | None, lo: float, hi: float, limit: int = 40) -> list[float]:
    if not shots:
        return []
    picked = [s for s in shots if lo <= s <= hi]
    if len(picked) > limit:
        step = len(picked) / limit
        picked = [picked[int(i * step)] for i in range(limit)]
    return picked


def _shot_types_in_range(shot_types: list[dict] | None, lo: float, hi: float,
                         limit: int = 60) -> list[dict]:
    """[lo, hi]와 겹치는 shot_types 반환. 너무 많으면 균등 샘플링."""
    if not shot_types:
        return []
    picked = [s for s in shot_types
              if s.get("end", 0) > lo and s.get("start", 0) < hi]
    if len(picked) > limit:
        step = len(picked) / limit
        picked = [picked[int(i * step)] for i in range(limit)]
    return picked


def _snap_start(t: float, shots: list[float]) -> float:
    if not shots:
        return t
    cand = [s for s in shots if abs(s - t) <= SHOT_SNAP_SEC]
    if not cand:
        return t
    return min(cand, key=lambda x: abs(x - t))


def _snap_end(t: float, shots: list[float]) -> float:
    return _snap_start(t, shots)


# ── word-boundary snap (2026-07-27) ─────────────────────────────────────────────
# STT word.start/word.end로 beat 경계를 정확한 발화 완결 지점에 스냅한다.
# 이유: 모델이 반환하는 beat.end가 대사 완결 시각을 못 맞추고 1-2초 더 가서 다음 발화 시작을
# 잘라오는 문제. word tolerance 안이면 정확한 word 경계로 당김.

WORD_SNAP_TOLERANCE_SEC = 2.5  # 이 범위 밖 word는 무시 (억지 스냅 방지)


def _flatten_words(transcript: list[dict] | None) -> list[dict]:
    if not transcript:
        return []
    flat: list[dict] = []
    for seg in transcript:
        for w in (seg.get("words") or []):
            try:
                st = float(w.get("start", 0)); en = float(w.get("end", 0))
            except (TypeError, ValueError):
                continue
            if en > st:
                flat.append({"start": st, "end": en})
        # words 없으면 seg 자체를 하나의 word로 처리 (fallback)
        if not (seg.get("words") or []):
            try:
                st = float(seg.get("start", 0)); en = float(seg.get("end", 0))
            except (TypeError, ValueError):
                continue
            if en > st:
                flat.append({"start": st, "end": en})
    return flat


def _snap_to_word_start(t: float, transcript: list[dict] | None) -> float | None:
    """t 근처에서 가장 가까운 word.start를 반환. tolerance 밖이면 None (원값 유지 유도)."""
    words = _flatten_words(transcript)
    if not words:
        return None
    best = None
    best_d = WORD_SNAP_TOLERANCE_SEC + 1
    for w in words:
        d = abs(w["start"] - t)
        if d < best_d and d <= WORD_SNAP_TOLERANCE_SEC:
            best, best_d = w["start"], d
        if w["start"] > t + WORD_SNAP_TOLERANCE_SEC:
            break
    return best


def _snap_to_word_end(t: float, transcript: list[dict] | None) -> float | None:
    """t 근처에서 가장 가까운 word.end (문장 완결 지점)를 반환. tolerance 밖이면 None.
    beat.end가 대사 종결 뒤 1-2초 더 가는 문제 fix용."""
    words = _flatten_words(transcript)
    if not words:
        return None
    best = None
    best_d = WORD_SNAP_TOLERANCE_SEC + 1
    for w in words:
        d = abs(w["end"] - t)
        if d < best_d and d <= WORD_SNAP_TOLERANCE_SEC:
            best, best_d = w["end"], d
        if w["start"] > t + WORD_SNAP_TOLERANCE_SEC:
            break
    return best


# ── speaker monologue snap (2026-07-27) ─────────────────────────────────────────
# 같은 화자가 연속 발화 중이면 그 monologue 끝까지 확장. beat이 monologue 중간에서 잘리는
# 사용자 지적 fix. speaker 필드 없는 세그는 스킵.

SPEAKER_MERGE_GAP_SEC = 1.5      # 같은 화자 세그 사이 이 미만 gap이면 같은 monologue로 취급
SPEAKER_EXTEND_MAX_SEC = 8.0     # monologue 확장 최대 폭 — 원 beat 경계에서 이 이상 벗어나지 않음


def _extend_end_to_speaker_block(t: float, transcript: list[dict] | None) -> float:
    """beat.end가 어떤 세그 안이거나 직후라면, 그 세그의 화자가 곧바로 이어 말하는 한
    monologue block 끝까지 t를 확장. 다른 화자가 시작하거나 SPEAKER_MERGE_GAP_SEC 초과
    침묵 지나면 멈춤. 최대 SPEAKER_EXTEND_MAX_SEC 초까지만 확장 (긴 monologue 통째 삼킴 방지)."""
    if not transcript:
        return t
    segs = sorted(
        (s for s in transcript if isinstance(s.get("start"), (int, float))
         and isinstance(s.get("end"), (int, float))),
        key=lambda s: float(s["start"]),
    )
    if not segs:
        return t
    cur = None
    cur_idx = -1
    for i, s in enumerate(segs):
        st = float(s["start"]); en = float(s["end"])
        if st <= t <= en + 0.5:
            cur = s; cur_idx = i
        elif st > t:
            break
    if cur is None:
        return t
    sp = (cur.get("speaker") or "").strip()
    if not sp:
        return t
    new_end = float(cur["end"])
    for j in range(cur_idx + 1, len(segs)):
        nxt = segs[j]
        nxt_sp = (nxt.get("speaker") or "").strip()
        try:
            nxt_st = float(nxt["start"]); nxt_en = float(nxt["end"])
        except (TypeError, ValueError):
            break
        if nxt_st - new_end > SPEAKER_MERGE_GAP_SEC:
            break
        if nxt_sp != sp:
            break
        if nxt_en - t > SPEAKER_EXTEND_MAX_SEC:
            break  # 상한 초과 · 여기서 종결
        new_end = nxt_en
    return max(t, new_end)


def _extend_start_to_speaker_block(t: float, transcript: list[dict] | None) -> float:
    """대칭 — beat.start가 monologue 중간이면 그 화자 발화 시작으로 앞당김 (최대 EXTEND_MAX 내)."""
    if not transcript:
        return t
    segs = sorted(
        (s for s in transcript if isinstance(s.get("start"), (int, float))
         and isinstance(s.get("end"), (int, float))),
        key=lambda s: float(s["start"]),
    )
    if not segs:
        return t
    cur = None
    cur_idx = -1
    for i, s in enumerate(segs):
        st = float(s["start"]); en = float(s["end"])
        if st - 0.5 <= t <= en:
            cur = s; cur_idx = i
        elif st > t + 0.5:
            break
    if cur is None:
        return t
    sp = (cur.get("speaker") or "").strip()
    if not sp:
        return t
    new_start = float(cur["start"])
    for j in range(cur_idx - 1, -1, -1):
        prv = segs[j]
        prv_sp = (prv.get("speaker") or "").strip()
        try:
            prv_st = float(prv["start"]); prv_en = float(prv["end"])
        except (TypeError, ValueError):
            break
        if new_start - prv_en > SPEAKER_MERGE_GAP_SEC:
            break
        if prv_sp != sp:
            break
        if t - prv_st > SPEAKER_EXTEND_MAX_SEC:
            break
        new_start = prv_st
    return min(t, new_start)


def _build_prompt(segment_meta: dict, lines: list[str], shots_in: list[float],
                  shot_types_in: list[dict] | None = None) -> tuple[str, str]:
    """단일 narrative segment(또는 5분 청크)에 대해 beat 정의 프롬프트."""
    seg_start = segment_meta.get("start", 0)
    seg_end = segment_meta.get("end", 0)
    seg_title = segment_meta.get("title") or ""
    seg_summary = segment_meta.get("summary") or ""
    seg_moments = segment_meta.get("key_moments") or []

    shot_str = ", ".join(f"{_mmss(s)}({s:.1f}s)" for s in shots_in) if shots_in else "없음"
    moments_str = "\n".join(f"  - {m}" for m in seg_moments[:10]) if seg_moments else "  (없음)"

    # shot_types: 각 shot이 interview/on_scene/other 중 무엇인지 · 예능 편집 문법에 필수
    if shot_types_in:
        st_lines = []
        for st in shot_types_in:
            typ = st.get("type", "?")
            marker = {"interview": "🎤 인터뷰룸", "on_scene": "🎬 현장", "other": "📺 인서트"}.get(typ, typ)
            st_lines.append(f"  [{_mmss(st['start'])}~{_mmss(st['end'])}] {marker}")
        st_block = "\n".join(st_lines)
    else:
        st_block = "  (분류 데이터 없음)"

    system = f"""너는 한국 예능·방송 편집자다. 아래 구간을 **"소주제 단위의 짧은 편집 완결 단위(beat)"**
로 잘게 분할한다.

**beat 정의**:
- 하나의 소주제·한 화자 발화·한 인터뷰 컷·한 리액션 단위. 8~30초 목표.
- **묶지 마라** — 아래처럼 소주제별로 각각 별개 beat로 분리:
    · 원 신 발화 A (예: "원균 한의사 자기소개 · 20초")
    · 다른 출연자 리액션 (예: "모두 놀란다 · 8초")
    · 인터뷰룸 컷 A (예: "지연이 첫인상 회상 · 15초")
    · 인터뷰룸 컷 B (예: "민경이 한의사에 대한 호감 · 12초")
    · 이어지는 원 신 (예: "원균이 세부 설명 · 18초")
  → 위 5개를 각각 하나의 beat. 하나의 큰 beat로 묶지 말 것.

**⚠️ 세분화 규칙 (엄격 · 반드시 준수)**:
- **화자가 바뀌면 무조건 새 beat**. 같은 화자여도 주제/화제가 바뀌면 새 beat.
- **shot type이 바뀌면 새 beat** (현장 → 인터뷰룸 전환은 반드시 beat 경계).
- **인터뷰룸 컷은 각각 별개 beat** — 여러 인터뷰가 붙어 나와도 화자·주제 다르면 분리.
- **한 사람 자기소개는 그 사람 발화만 하나 beat** (다른 사람 반응은 별개 beat).
- 8초 미만은 파편이라 인접과 묶되, 되도록 8~30초 목표.
- **30초 초과 beat 금지** — 넘으면 반드시 화제·화자 전환점에서 잘라라. 예능은 컷이 빠르다.
- 60초 넘어가면 심각한 문제 — 여러 소주제·화자가 섞였다는 증거.

**🚨 익명 라벨 규칙**:
- 입력 자막에 "[발화자 1]", "[발화자 3]" 같은 익명 라벨이 붙어 있으면 그건 STT 화자분리 임시 ID일 뿐.
- title·summary에 "발화자 N"을 **절대로 노출 금지**. "한 출연자", "그", "누군가"로 표현.
- 예: "발화자 1 소개" 나쁨 → "첫 출연자 자기소개" 좋음.

**경계 조건**:
- 시작은 **새 화자 첫 발화** 또는 **shot boundary 근처**.
- 끝은 **그 발화 종결** 또는 **다음 shot 직전**.
- 가능하면 shot boundary(장면 전환점)에서 시작·끝.

**🚨 커버리지 규칙 (필수)**:
- **자막이 있는 모든 시간은 반드시 어떤 beat 안에** 있어야 한다. 자막 있는 구간을 beat 없이
  건너뛰지 마라. 리액션·짧은 감탄사·인터뷰룸 짧은 컷도 다 beat에 넣어라.
- 인접 beat 사이 gap(자막 있는데 beat 없는 시각)이 3초를 넘으면 안 됨.
- 짧은 리액션 여러 개가 붙어 있으면 하나의 "리액션 묶음" beat로 묶어라 (8초는 넘겨야).
- 자기소개 발화 뒤 즉시 나오는 리액션·평가는 자기소개 beat과 별개의 "리액션 beat"로 반드시 만들어라.

**hook 카테고리** (반드시 다음 중 하나): 반전 / 감정고조 / 돌직구 / 질문 / 정보성 / 웃음 / 갈등 / 공감 / 기타

**반환 형식** (JSON, 다른 문장 없이):
{{"beats":[
  {{"start":90.0,"end":110.0,"title":"원규 한의사 자기소개",
    "summary":"원규가 자신이 7년차 한의사라고 밝힌다. 근골격계 환자 위주로 진료.",
    "characters":["원규"],"hook":"반전","is_complete":true}},
  {{"start":110.0,"end":118.0,"title":"모두 원규 직업에 놀란 리액션",
    "summary":"한의사라는 말에 진짜? 상상도 못했다 반응.",
    "characters":["지연","민경"],"hook":"감정고조","is_complete":true}},
  {{"start":118.0,"end":132.0,"title":"지연 인터뷰룸 · 원규 첫인상 회상",
    "summary":"지연이 인터뷰룸에서 원규 지적으로 보였다고 회상.",
    "characters":["지연"],"hook":"공감","is_complete":true}}
]}}

**시간 필드는 초 단위 숫자만**. "1:30" 같은 콜론 문자열 절대 금지.
반환 beat들의 시각은 **주어진 구간 안에서만** ({seg_start:.1f}s ~ {seg_end:.1f}s).
목표 beat 개수: 이 구간이 M초라면 대략 **M/20 ~ M/10 개** (촘촘히).
"""

    prompt = f"""=== 구간 메타 ===
시각: {_mmss(seg_start)}~{_mmss(seg_end)} ({seg_start:.1f}s~{seg_end:.1f}s)
제목: {seg_title}
요약: {seg_summary}
key_moments:
{moments_str}

=== shot boundary (프레임 diff 기반 장면 전환점) ===
{shot_str}

=== shot type (프레임 분석 · 현장 vs 인터뷰룸) ===
{st_block}

=== 자막 (이 구간) ===
""" + "\n".join(lines)

    return system, prompt


def _parse_beats_response(raw: str, seg_start: float, seg_end: float) -> list[dict]:
    if not raw or not raw.strip():
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        # partial 복구
        lc = raw.rfind("}")
        data = None
        if lc > 0:
            for suffix in ("]}", "}]}"):
                try:
                    data = json.loads(raw[: lc + 1] + suffix)
                    break
                except json.JSONDecodeError:
                    continue
    if not isinstance(data, dict):
        return []
    beats = data.get("beats") if isinstance(data.get("beats"), list) else []
    cleaned = []
    for b in beats:
        try:
            st = float(b.get("start", 0))
            en = float(b.get("end", 0))
        except (TypeError, ValueError):
            continue
        # 구간 밖 clamp
        st = max(st, seg_start - 1.0)
        en = min(en, seg_end + 1.0)
        if en <= st:
            continue
        hook = (b.get("hook") or "기타").strip()
        if hook not in HOOK_KEYS:
            hook = "기타"
        cleaned.append({
            "start": round(st, 1),
            "end": round(en, 1),
            "title": (b.get("title") or "").strip() or "무제",
            "summary": (b.get("summary") or "").strip(),
            "characters": [str(c).strip() for c in (b.get("characters") or []) if str(c).strip()],
            "hook": hook,
            "is_complete": bool(b.get("is_complete", True)),
        })
    return cleaned


def _merge_small_beats(beats: list[dict], transcript: list[dict] | None = None) -> list[dict]:
    """MIN_BEAT_SEC 미만은 인접 beat와 병합. summary/characters 합치기.
    2026-07-29 speaker-aware: transcript 있으면 · 인접 beat 과 dominant speaker 가 다르면 병합 안 함
    (다중 화자 beat 생성 방지). auto_split_speaker=True 마킹된 조각은 특히 보호.
    """
    if not beats:
        return []

    def _dominant_speaker(b: dict) -> str | None:
        if not transcript:
            return None
        counts: dict[str, float] = {}
        for u in transcript:
            try:
                us = float(u.get("start", 0)); ue = float(u.get("end", 0))
            except (TypeError, ValueError):
                continue
            if ue <= b["start"] or us >= b["end"]:
                continue
            sp = (u.get("speaker") or "").strip()
            if not sp:
                continue
            counts[sp] = counts.get(sp, 0) + (ue - us)
        if not counts:
            return None
        return max(counts.items(), key=lambda kv: kv[1])[0]

    beats = sorted(beats, key=lambda b: b["start"])
    out: list[dict] = []
    for b in beats:
        length = b["end"] - b["start"]
        if length >= MIN_BEAT_SEC:
            out.append(b)
            continue
        # 짧음 → 앞 beat와 병합. 단 speaker 다르면 스킵 (mixed beat 생성 방지).
        if out:
            prev = out[-1]
            prev_sp = _dominant_speaker(prev)
            cur_sp = _dominant_speaker(b)
            can_merge = (
                not transcript
                or prev_sp is None or cur_sp is None
                or prev_sp == cur_sp
            )
            if can_merge:
                prev["end"] = max(prev["end"], b["end"])
                prev["summary"] = (prev["summary"] + " · " + b["summary"]).strip(" ·")
                for c in b["characters"]:
                    if c not in prev["characters"]:
                        prev["characters"].append(c)
            else:
                # speaker 다르면 병합 안 함 · 짧은 조각 그대로 유지 (recommend 가 조합 시 활용)
                out.append(b)
        else:
            out.append(b)  # 첫 beat면 일단 넣고 다음 반복에서 뒤와 병합될 수 있음
    # 뒤 병합 통과 후에도 짧은 첫 beat가 남을 수 있음 · 두 번째 beat와 병합 (speaker 체크)
    if len(out) >= 2 and (out[0]["end"] - out[0]["start"]) < MIN_BEAT_SEC:
        first, second = out[0], out[1]
        first_sp = _dominant_speaker(first)
        second_sp = _dominant_speaker(second)
        if not transcript or first_sp is None or second_sp is None or first_sp == second_sp:
            merged = {
                "start": first["start"], "end": second["end"],
                "title": second["title"],
                "summary": (first["summary"] + " · " + second["summary"]).strip(" ·"),
                "characters": list(dict.fromkeys(first["characters"] + second["characters"])),
                "hook": second["hook"], "is_complete": True,
            }
            out = [merged] + out[2:]
    return out


def _enforce_min_beat_sec(beats: list[dict], min_sec: float = HARD_MIN_BEAT_SEC) -> list[dict]:
    """min_sec 미만 beat 을 **화자와 무관하게** 인접에 병합한다. 마지막 안전장치.

    사용자 요청 (2026-08-07): "너무 짧은 거 있음. 최소 6초 필터는 걸자."

    `_merge_small_beats` 는 speaker-aware 라서 "인접과 dominant speaker 가 다르면 병합 안 함"
    이다. 그런데 `_split_beats_on_speaker_change` 는 **화자가 바뀌는 지점을 골라** 자르므로
    조각은 정의상 이웃과 화자가 다르다 → 둘이 서로 싸워 **아무것도 병합되지 않았다.**
    실측(드라마 58.6분): 413 beat 중 215개(52%)가 6초 미만, 최소 1.0초.

    여기서는 화자 규칙보다 하한을 우선한다 — 1초짜리 beat 은 화자가 순수해도 편집 단위로
    못 쓴다. 짧은 쪽을 **더 짧은 이웃** 에 붙여 길이 편차를 키우지 않는다.
    """
    if not beats:
        return []
    out = [dict(b) for b in sorted(beats, key=lambda x: float(x["start"]))]
    merged_n = 0
    changed = True
    while changed and len(out) > 1:
        changed = False
        for i, b in enumerate(out):
            if float(b["end"]) - float(b["start"]) >= min_sec:
                continue
            prev_b = out[i - 1] if i > 0 else None
            next_b = out[i + 1] if i + 1 < len(out) else None
            if prev_b is None and next_b is None:
                continue
            # 더 짧은 이웃에 붙인다 (긴 beat 을 더 길게 만들지 않음)
            def _len(x):
                return float(x["end"]) - float(x["start"]) if x else float("inf")
            tgt_i = i - 1 if _len(prev_b) <= _len(next_b) else i + 1
            tgt = out[tgt_i]
            tgt["start"] = min(float(tgt["start"]), float(b["start"]))
            tgt["end"] = max(float(tgt["end"]), float(b["end"]))
            tgt["summary"] = ((tgt.get("summary") or "") + " · " + (b.get("summary") or "")).strip(" ·")
            for c in (b.get("characters") or []):
                if c not in (tgt.get("characters") or []):
                    tgt.setdefault("characters", []).append(c)
            # 화자 순수성이 깨졌음을 남긴다 — 뒤 단계·검수에서 구분할 수 있게
            if b.get("auto_split_speaker") or tgt.get("auto_split_speaker"):
                tgt["speaker_mixed"] = True
            out.pop(i)
            merged_n += 1
            changed = True
            break
    if merged_n:
        print(f"   [beats] 최소 {min_sec:g}초 강제: {merged_n}개 조각 병합 → {len(out)}개")
    return out


def _subdivide_large_beat(client, beat: dict, transcript: list[dict],
                          shots: list[float], shot_types: list[dict] | None = None) -> list[dict]:
    """SUBDIVIDE_SEC 초과 beat 재분해 시도. 실패하면 원 beat 유지."""
    seg_meta = {
        "start": beat["start"], "end": beat["end"],
        "title": beat["title"], "summary": beat["summary"], "key_moments": [],
    }
    lines = _segments_in_range(transcript, beat["start"], beat["end"], max_lines=200)
    shots_in = _shots_in_range(shots, beat["start"], beat["end"])
    shot_types_in = _shot_types_in_range(shot_types, beat["start"], beat["end"])
    if len(lines) < 4:  # 대사 너무 적으면 재분해 의미 없음
        return [beat]
    system, prompt = _build_prompt(seg_meta, lines, shots_in, shot_types_in)
    system += (
        f"\n\n**⚠️ 이 구간({beat['end']-beat['start']:.0f}s)은 이미 하나의 beat로 정의됐지만 소주제가 "
        "여러 개일 가능성이 높다. 반드시 2개 이상으로 분해하라. 특히 화자·인물이 바뀌는 지점에서 "
        "반드시 자른다. 한 사람의 자기소개는 그 사람 발화만 하나 beat. 다른 사람 언급 시작하면 새 beat."
    )
    try:
        resp = call_with_retry(lambda: client.models.generate_content(
            model=MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=system, temperature=0,
                response_mime_type="application/json",
                max_output_tokens=4096,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        ))
        subs = _parse_beats_response(resp.text or "", beat["start"], beat["end"])
        subs = [s for s in subs if s["end"] - s["start"] >= MIN_BEAT_SEC]
        if len(subs) >= 2:
            return subs
    except Exception as e:
        print(f"   (beat 재분해 실패 · 유지: {str(e)[:80]})")
    return [beat]


def _process_segment(client, seg: dict, transcript: list[dict],
                     shots: list[float], shot_types: list[dict] | None = None) -> list[dict]:
    """narrative segment 하나에 대해 beat 리스트 생성. 짧으면 병합, 크면 재분해."""
    try:
        seg_start = float(seg.get("start", 0))
        seg_end = float(seg.get("end", 0))
    except (TypeError, ValueError):
        return []
    if seg_end <= seg_start:
        return []
    lines = _segments_in_range(transcript, seg_start, seg_end)
    if len(lines) < 3:  # 대사가 거의 없으면 통째로 하나의 beat
        return [{
            "start": round(seg_start, 1), "end": round(seg_end, 1),
            "title": seg.get("title", "무제"), "summary": seg.get("summary", ""),
            "characters": seg.get("characters", []),
            "hook": "기타", "is_complete": True,
        }]
    shots_in = _shots_in_range(shots, seg_start, seg_end)
    shot_types_in = _shot_types_in_range(shot_types, seg_start, seg_end)
    system, prompt = _build_prompt(seg, lines, shots_in, shot_types_in)
    try:
        resp = call_with_retry(lambda: client.models.generate_content(
            model=MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=system, temperature=0,
                response_mime_type="application/json",
                max_output_tokens=8192,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        ))
        beats = _parse_beats_response(resp.text or "", seg_start, seg_end)
    except Exception as e:
        print(f"   (segment {_mmss(seg_start)} beat 생성 실패: {str(e)[:80]})")
        return []
    if not beats:
        # 폴백: 세그먼트 통째로 하나의 beat
        return [{
            "start": round(seg_start, 1), "end": round(seg_end, 1),
            "title": seg.get("title", "무제"), "summary": seg.get("summary", ""),
            "characters": seg.get("characters", []),
            "hook": "기타", "is_complete": True,
        }]
    beats = _merge_small_beats(beats, transcript)
    # 재분해: SUBDIVIDE_SEC 초과 beat
    expanded: list[dict] = []
    for b in beats:
        if b["end"] - b["start"] > SUBDIVIDE_SEC:
            subs = _subdivide_large_beat(client, b, transcript, shots, shot_types)
            expanded.extend(subs)
        else:
            expanded.append(b)
    return expanded


def build_beats(
    narrative: dict | None,
    transcript: list[dict],
    shots: list[float] | None,
    duration: float,
    shot_types: list[dict] | None = None,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> dict:
    """narrative segments 단위 병렬 콜로 beat 리스트 생성. narrative 없으면 5분 청크로 폴백."""
    if not transcript:
        return {"beats": []}
    shots = shots or []
    client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)

    # 세그먼트 소스: narrative.segments 우선, 없으면 5분 청크
    segments: list[dict] = []
    if isinstance(narrative, dict) and isinstance(narrative.get("segments"), list):
        for s in narrative["segments"]:
            try:
                st = float(s.get("start", 0))
                en = float(s.get("end", 0))
            except (TypeError, ValueError):
                continue
            if en > st:
                segments.append({
                    "start": st, "end": en,
                    "title": s.get("title", ""), "summary": s.get("summary", ""),
                    "key_moments": s.get("key_moments", []),
                    "characters": s.get("characters", []),
                })
    if not segments and duration > 0:
        # narrative 폴백: 5분 청크
        chunk = 300.0
        t = 0.0
        while t < duration:
            segments.append({
                "start": t, "end": min(t + chunk, duration),
                "title": "", "summary": "", "key_moments": [], "characters": [],
            })
            t += chunk

    if not segments:
        return {"beats": []}

    n_st = len(shot_types or [])
    print(f"   beat 생성: {len(segments)} 세그먼트 · shot_types {n_st}개 · 병렬 처리")
    workers = min(len(segments), 4)
    all_beats: list[dict] = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(_process_segment, client, s, transcript, shots, shot_types) for s in segments]
        for i, f in enumerate(futures):
            try:
                bts = f.result()
            except Exception as e:
                print(f"   (세그먼트 처리 실패: {str(e)[:80]})")
                bts = []
            all_beats.extend(bts)
            if on_progress:
                on_progress(i + 1, len(futures))

    # 정렬 · **word 경계 + 화자 monologue** 스냅 · id 부여.
    # 2026-07-27: (1) beat.end가 대사 끝난 뒤 1-2초 더 가서 다음 발화 잘라오는 문제 word 스냅으로 fix.
    #             (2) 같은 화자 monologue 중간에서 잘리는 문제 → speaker block 끝까지 확장.
    all_beats.sort(key=lambda b: b["start"])
    for b in all_beats:
        snapped_start = _snap_to_word_start(b["start"], transcript)
        snapped_end = _snap_to_word_end(b["end"], transcript)
        # word 스냅이 없으면 (words 데이터 없거나 tolerance 밖) shot 스냅으로 폴백
        if snapped_start is None:
            snapped_start = _snap_start(b["start"], shots)
        if snapped_end is None:
            snapped_end = _snap_end(b["end"], shots)
        # 같은 화자 monologue 중간이면 그 화자 발화 끝까지 확장 (사용자 지적 · 2026-07-27).
        snapped_start = _extend_start_to_speaker_block(snapped_start, transcript)
        snapped_end = _extend_end_to_speaker_block(snapped_end, transcript)
        b["start"] = round(snapped_start, 3)
        b["end"] = round(snapped_end, 3)
        if duration > 0:
            b["end"] = min(b["end"], duration)
        if b["end"] <= b["start"]:
            b["end"] = b["start"] + MIN_BEAT_SEC
    # 겹침 정리: 인접 beat가 겹치면 뒤 beat.start를 앞 beat.end로 스냅
    for i in range(1, len(all_beats)):
        if all_beats[i]["start"] < all_beats[i - 1]["end"]:
            all_beats[i]["start"] = all_beats[i - 1]["end"]
        if all_beats[i]["end"] <= all_beats[i]["start"]:
            all_beats[i]["end"] = all_beats[i]["start"] + MIN_BEAT_SEC

    # 최종 짧은 beat 병합 (전체 리스트 단위)
    all_beats = _merge_small_beats(all_beats, transcript)

    # 2026-07-27 gap fill: 자막 있는데 beat 없는 구간(>=8s)을 자동 beat로 채운다.
    # AI가 리액션·인터뷰 짧은 컷을 놓치는 케이스 방지 (실측: 스페인 음식점 얘기 후 리액션 46s
    # gap이 통째로 skip → shorts에서 정보 손실).
    all_beats = _fill_dialogue_gaps(all_beats, transcript, duration)

    # 2026-07-28 안전망: 45s 초과 beat을 speaker 전환점에서 강제 분할 (model이 큰 beat 반환할
    # 때 최후 방어). 화자 정보 없거나 전환점 없으면 원본 유지.
    all_beats = _force_split_large_beats(all_beats, transcript, max_beat_sec=45.0)

    # 2026-07-29 화자 전환 강제 split: beat 안에 speaker 전환이 있으면 크기 무관 split.
    # 사용자 지적 (b26): 발화자 2 짧은 리액션 3s + 발화자 1 13s 가 한 beat 에 섞임. 화자 원칙 위반.
    # min_beat_sec=3.0 (기본보다 낮게) 로 잔 리액션도 분리 · 조각이 인접 beat 과 same speaker 면 merge.
    all_beats = _split_beats_on_speaker_change(all_beats, transcript)
    # 다시 짧은 beat 병합 (split 후 잔조각 처리)
    all_beats = _merge_small_beats(all_beats, transcript)
    # 마지막 안전장치 — 화자 규칙 예외로 살아남은 파편까지 하한 강제
    all_beats = _enforce_min_beat_sec(all_beats)

    # id 부여
    for i, b in enumerate(all_beats):
        b["id"] = i

    print(f"   beat {len(all_beats)}개 (평균 {sum(b['end']-b['start'] for b in all_beats)/max(1,len(all_beats)):.0f}s)")
    return {"beats": all_beats}


def _force_split_large_beats(beats: list[dict], transcript: list[dict],
                             max_beat_sec: float = 45.0) -> list[dict]:
    """max_beat_sec 초과 beat을 speaker 전환점에서 잘라 여러 개로 분할.
    speaker 정보 없거나 전환점 없으면 원본 유지 (안전).
    2026-07-28 사용자 지적: 모델이 185s 짜리 beat 반환하는 케이스 fallback fix."""
    if not beats or not transcript:
        return beats
    out: list[dict] = []
    for b in beats:
        try:
            st = float(b["start"]); en = float(b["end"])
        except (KeyError, TypeError, ValueError):
            out.append(b); continue
        if en - st <= max_beat_sec:
            out.append(b); continue
        # 이 beat 안 speaker 전환점 찾기
        in_range = [
            s for s in transcript
            if isinstance(s.get("start"), (int, float)) and float(s["start"]) >= st
            and isinstance(s.get("end"), (int, float)) and float(s["end"]) <= en + 0.1
        ]
        boundaries: list[float] = []
        prev_sp = None
        for s in in_range:
            sp = (s.get("speaker") or "").strip()
            if prev_sp is not None and sp and sp != prev_sp:
                boundaries.append(float(s["start"]))
            prev_sp = sp or prev_sp
        # 최소 MIN_BEAT_SEC 이상 되게 boundary 필터링
        useful = [x for x in boundaries if x - st >= MIN_BEAT_SEC and en - x >= MIN_BEAT_SEC]
        if not useful:
            out.append(b); continue
        # 균등 분할 목적: 45s 넘는 만큼 여러 조각. useful 중 가장 균등에 가까운 것부터.
        cuts = [st] + sorted(set(useful)) + [en]
        pieces: list[dict] = []
        for i in range(len(cuts) - 1):
            p_st = cuts[i]; p_en = cuts[i + 1]
            if p_en - p_st < MIN_BEAT_SEC:
                continue
            pieces.append({
                **{k: v for k, v in b.items() if k not in ("start", "end", "id")},
                "start": round(p_st, 3),
                "end": round(p_en, 3),
                "title": (b.get("title") or "") + f" (part {len(pieces)+1})",
                "auto_split": True,
            })
        if len(pieces) >= 2:
            print(f"   [beats] 큰 beat {en-st:.0f}s → {len(pieces)}조각 강제 분할 (화자 전환점 {len(useful)}개)")
            out.extend(pieces)
        else:
            out.append(b)
    return out


def _split_beats_on_speaker_change(beats: list[dict], transcript: list[dict],
                                   min_piece_sec: float = MIN_BEAT_SEC) -> list[dict]:
    """Beat 안에 speaker 전환이 있으면 그 지점에서 split. 단 **양쪽 조각이 모두
    min_piece_sec 이상일 때만** 자른다.

    사용자 지적 (2026-07-29 · b26): AI 가 화자 원칙 무시하고 여러 화자 담음 → 후처리 강제.

    ⚠️ min_piece_sec 기본값이 3.0 이던 시절, 이 함수와 `_merge_small_beats` 가 서로 싸웠다.
    여기서 **화자가 바뀌는 지점을 골라** 자르니 조각은 정의상 이웃과 dominant speaker 가
    다르고, `_merge_small_beats` 는 "화자 다르면 병합 안 함" 이라 **영영 병합되지 않았다.**
    실측 2026-08-07(드라마): 413 beat 중 215개(52%)가 6초 미만이고 최소 1.0초였다 —
    그중 210개가 이 분할 산물이다. 기본값을 MIN_BEAT_SEC 으로 올려 애초에 안 만든다.
    """
    if not beats or not transcript:
        return beats
    out: list[dict] = []
    n_split = 0
    for b in beats:
        try:
            st = float(b["start"]); en = float(b["end"])
        except (KeyError, TypeError, ValueError):
            out.append(b); continue
        # 이 beat 안 utterance 수집 (시간순)
        in_range: list[tuple[float, float, str]] = []
        for u in transcript:
            try:
                us = float(u.get("start", 0)); ue = float(u.get("end", 0))
            except (TypeError, ValueError):
                continue
            if ue <= st or us >= en:
                continue
            sp = (u.get("speaker") or "").strip()
            in_range.append((us, ue, sp))
        in_range.sort(key=lambda x: x[0])
        # 화자 전환점 (previous → current 가 다른 speaker) · 시작 시각 = 새 speaker 첫 발화 시작
        boundaries: list[float] = []
        prev_sp = None
        for us, ue, sp in in_range:
            if prev_sp is not None and sp and sp != prev_sp:
                boundaries.append(us)
            if sp:
                prev_sp = sp
        # min_piece_sec 만큼 앞뒤 여유 있는 경계만 유효
        useful = [x for x in boundaries if x - st >= min_piece_sec and en - x >= min_piece_sec]
        if not useful:
            out.append(b); continue
        cuts = [st] + sorted(set(useful)) + [en]
        pieces: list[dict] = []
        for i in range(len(cuts) - 1):
            p_st = cuts[i]; p_en = cuts[i + 1]
            if p_en - p_st < 1.0:  # 완전 파편 (<1s) 은 제외
                continue
            pieces.append({
                **{k: v for k, v in b.items() if k not in ("start", "end", "id")},
                "start": round(p_st, 3),
                "end": round(p_en, 3),
                "title": (b.get("title") or "") + f" (spk-part {len(pieces)+1})",
                "auto_split_speaker": True,
            })
        if len(pieces) >= 2:
            n_split += 1
            out.extend(pieces)
        else:
            out.append(b)
    if n_split:
        print(f"   [beats] 화자 전환 split: {n_split} beat 분할")
    return out


def _fill_dialogue_gaps(beats: list[dict], transcript: list[dict],
                        duration: float, min_gap_sec: float = 8.0) -> list[dict]:
    """인접 beat 사이 자막 있는 gap(>=min_gap_sec)을 fallback beat로 채운다.
    자막이 없는 gap은 그대로 (침묵·BGM 구간)."""
    if not beats or not transcript:
        return beats
    beats_sorted = sorted(beats, key=lambda b: b["start"])
    filled: list[dict] = []
    prev_end = 0.0
    for b in beats_sorted:
        gap_start = prev_end
        gap_end = float(b["start"])
        if gap_end - gap_start >= min_gap_sec:
            filler = _make_gap_beat(transcript, gap_start, gap_end)
            if isinstance(filler, list):
                filled.extend(filler)
            elif filler:
                filled.append(filler)
        filled.append(b)
        prev_end = float(b["end"])
    # 마지막 beat 이후 tail gap
    if duration - prev_end >= min_gap_sec:
        filler = _make_gap_beat(transcript, prev_end, duration)
        if isinstance(filler, list):
            filled.extend(filler)
        elif filler:
            filled.append(filler)
    return filled


def _make_gap_beat(transcript: list[dict], lo: float, hi: float) -> dict | list[dict] | None:
    """gap 구간 [lo, hi]에서 자막이 있으면 fallback beat(들) 생성. 없으면 None.
    2026-07-28: 화자 전환점에서 여러 beat로 나눈다 (이전엔 통째 하나 · 원균 여운 + 지아 예상
    놀이가 한 beat에 담겨 shorts title이 payoff만 반영하는 문제).
    """
    # 이 gap 안의 자막 세그 수집 (시간순)
    in_range: list[dict] = []
    for t in transcript:
        try:
            ts = float(t.get("start", 0)); te = float(t.get("end", 0))
        except (TypeError, ValueError):
            continue
        if te <= lo or ts >= hi:
            continue
        if not (t.get("text") or "").strip():
            continue
        in_range.append(t)
    if not in_range:
        return None

    # 화자 전환·큰 침묵(2s+) 기준으로 chunk 나누기
    chunks: list[list[dict]] = [[in_range[0]]]
    for prev, cur in zip(in_range, in_range[1:]):
        prev_sp = (prev.get("speaker") or "").strip()
        cur_sp = (cur.get("speaker") or "").strip()
        gap = float(cur.get("start", 0)) - float(prev.get("end", 0))
        if (prev_sp and cur_sp and prev_sp != cur_sp) or gap > 2.0:
            chunks.append([cur])
        else:
            chunks[-1].append(cur)

    # 각 chunk를 beat로 변환. 짧은(3s 미만) 것은 인접에 병합.
    def _mk(chunk: list[dict]) -> dict | None:
        st = max(lo, float(chunk[0].get("start", 0)))
        en = min(hi, float(chunk[-1].get("end", 0)))
        if en - st < 3.0:
            return None
        joined = " ".join((c.get("text") or "").strip() for c in chunk)
        speakers = list({(c.get("speaker") or "").strip() for c in chunk if (c.get("speaker") or "").strip()})
        return {
            "start": round(st, 1), "end": round(en, 1),
            "title": f"[자동] {joined[:30]}",
            "summary": joined[:200],
            "characters": speakers,
            "hook": "기타",
            "is_complete": True,
            "auto_fill": True,
        }
    beats: list[dict] = []
    for c in chunks:
        b = _mk(c)
        if b:
            beats.append(b)
    if not beats:
        return None
    return beats if len(beats) > 1 else beats[0]


# ─────────────────────────────────────────────────────────────────────────────
# v2 (2026-07-30): GEBD 경계 기반 beat 생성.
# LLM 자유 시각 뽑기 → GEBD boundary window 로 대체.
# 후처리 (word/speaker 스냅, 화자 전환 split, gap fill) 은 기존 것 재사용.
# 계획서: docs/plans (GEBD 경계 기반 Beat 분석) · v1 은 boundaries.json 입력 받기.
# ─────────────────────────────────────────────────────────────────────────────

def _snap_start_to_utterance(t: float, transcript: list[dict] | None) -> float:
    """t 시각이 STT utterance 중간에 있으면 그 utterance.start 로 앞당김 (대사 처음부터 시작).

    사용자 방향 (2026-07-31): "beat.start 시각에 대사가 있으면 그 대사 시작으로 당김".
    word timing 없을 때 utterance-level 폴백. word snap 실패 시 이 함수 호출.
    """
    if not transcript:
        return t
    for u in transcript:
        try:
            us = float(u.get("start", 0)); ue = float(u.get("end", 0))
        except (TypeError, ValueError):
            continue
        if us < t < ue and (u.get("text") or "").strip():
            return us
    return t


def _snap_end_to_utterance(t: float, transcript: list[dict] | None) -> float:
    """t 시각이 STT utterance 중간에 있으면 그 utterance.end 로 뒤로 늘림 (말 끝까지 들리게).

    사용자 방향: "말 끊기는 거 방지를 위해 그 대사까지 늘림". word snap 폴백.
    """
    if not transcript:
        return t
    for u in transcript:
        try:
            us = float(u.get("start", 0)); ue = float(u.get("end", 0))
        except (TypeError, ValueError):
            continue
        if us < t < ue and (u.get("text") or "").strip():
            return ue
    return t


def _continuity_gate_speaker(t: float, transcript: list[dict], tol: float = 0.5) -> bool:
    """True 면 이 시각 앞뒤가 **같은 화자의 연속 발화** 안 (경계로 안 쓰는 게 안전).

    tol 이내에 화자 전환 없고, t 를 포함하는 발화가 있으면 True.
    계획서 3번 (STT 기반 후처리) · 같은 화자 연속 발화 안 boundary 억제.
    """
    if not transcript:
        return False
    containing = None
    for s in transcript:
        try:
            st = float(s.get("start", 0)); en = float(s.get("end", 0))
        except (TypeError, ValueError):
            continue
        if st <= t <= en:
            containing = s
            break
    if not containing:
        return False
    sp = (containing.get("speaker") or "").strip()
    if not sp:
        return False
    # 앞뒤 인접 발화 화자 비교
    prev_sp = next_sp = None
    for s in transcript:
        try:
            st = float(s.get("start", 0)); en = float(s.get("end", 0))
        except (TypeError, ValueError):
            continue
        if en <= t and (t - en) <= tol:
            prev_sp = (s.get("speaker") or "").strip()
        elif st >= t and (st - t) <= tol:
            next_sp = (s.get("speaker") or "").strip()
            break
    # 앞뒤 모두 같은 화자면 continuity → gate ON
    if prev_sp and next_sp and prev_sp == sp and next_sp == sp:
        return True
    return False


def build_beats_from_boundaries(
    boundaries: list[dict],
    transcript: list[dict],
    duration: float,
    program_context: dict | None = None,
    min_beat_sec: float = 6.0,
    include_grades: tuple[str, ...] = ("hard", "soft"),
    apply_continuity_gate: bool = True,
) -> dict:
    """GEBD boundary 리스트 → beat 리스트.

    입력:
      boundaries: [{t, kind, score, source}] (core/boundaries.py 로 로드 · dedup 된 것 권장)
      transcript: refined STT segments
      duration:   원 영상 duration (초)

    출력: {"beats": [{id, start, end, duration, transcript, characters, boundary, is_complete, ...}]}

    후처리:
      1) boundaries.to_windows() 로 [start, end] 조각 생성 (min_beat_sec 미만은 병합)
      2) 각 window 를 word/speaker 스냅으로 STT 문장 경계에 정렬
      3) 화자 전환점 강제 split (기존 헬퍼)
      4) 짧은 조각 병합 · 대사 gap fill (기존)
      5) transcript slice + boundary 소스 붙여서 beat 객체 완성

    title/summary/scene_summary/hook 은 여기서 채우지 않음 (annotate stage 몫).
    """
    from core.scenes.boundaries import to_windows, dedup_boundaries  # 로컬 import (순환 방지)

    if duration <= 0:
        return {"beats": []}

    # dedup + grade 부여 (score 있으면). 계획서 1번 · noise 자동 제거.
    graded = dedup_boundaries(boundaries or [], duration=duration)
    # continuity gate: 같은 화자 연속 발화 안 boundary 는 등급 강등 (soft만 · hard 는 유지)
    if apply_continuity_gate and transcript:
        for b in graded:
            if b.get("grade") == "soft" and _continuity_gate_speaker(float(b["t"]), transcript):
                b["grade"] = "noise"

    windows = to_windows(graded, duration, min_beat_sec=min_beat_sec,
                          include_grades=include_grades)
    if not windows:
        return {"beats": []}

    # 로그: 등급별 통계 (계획서 · 로그 강화)
    counts = {"hard": 0, "soft": 0, "noise": 0}
    for b in graded:
        counts[b.get("grade", "soft")] = counts.get(b.get("grade", "soft"), 0) + 1
    print(f"   boundary 등급 hard={counts['hard']} soft={counts['soft']} noise={counts['noise']} · windows={len(windows)}")

    beats: list[dict] = []
    for w in windows:
        st = float(w["start"]); en = float(w["end"])

        # word/speaker 스냅 (기존 헬퍼) — words 데이터 있을 때만 유효
        snap_st = _snap_to_word_start(st, transcript)
        snap_en = _snap_to_word_end(en, transcript)
        # words 없으면 (VAD 실패 등) utterance-level 폴백 · 대사 중간 끊김 방지 (2026-07-31)
        if snap_st is None:
            snap_st = _snap_start_to_utterance(st, transcript)
        if snap_en is None:
            snap_en = _snap_end_to_utterance(en, transcript)
        # 화자 monologue 중간이면 그 화자 발화 끝까지 확장
        snap_st = _extend_start_to_speaker_block(snap_st, transcript)
        snap_en = _extend_end_to_speaker_block(snap_en, transcript)

        if snap_en <= snap_st:
            snap_en = snap_st + min_beat_sec
        if snap_en > duration:
            snap_en = duration

        beats.append({
            "start": round(snap_st, 3),
            "end": round(snap_en, 3),
            "duration": round(snap_en - snap_st, 3),
            "title": "",
            "summary": "",
            "transcript": "",  # 아래에서 채움
            "characters": [],
            "hook": "",
            "scene_summary": "",
            "boundary": {
                "start_source": w.get("start_source", "gebd"),
                "end_source": w.get("end_source", "gebd"),
                "start_kind": w.get("start_kind", "unknown"),
                "end_kind": w.get("end_kind", "unknown"),
                "start_frame": "",
                "end_frame": "",
            },
            "is_complete": True,
        })

    # 후처리: 겹침 방지
    for i in range(1, len(beats)):
        if beats[i]["start"] < beats[i - 1]["end"]:
            beats[i]["start"] = beats[i - 1]["end"]
        if beats[i]["end"] <= beats[i]["start"]:
            beats[i]["end"] = beats[i]["start"] + min_beat_sec

    # 짧은 조각 병합 · gap fill · 화자 전환 split (기존 로직 그대로)
    beats = _merge_small_beats(beats, transcript)
    beats = _fill_dialogue_gaps(beats, transcript, duration)
    beats = _split_beats_on_speaker_change(beats, transcript)
    beats = _merge_small_beats(beats, transcript)
    # 마지막 안전장치 — 화자 규칙 예외로 살아남은 파편까지 하한 강제
    beats = _enforce_min_beat_sec(beats)

    # transcript slice · dominant speaker 채우기 · id 부여
    for i, b in enumerate(beats):
        st = float(b["start"]); en = float(b["end"])
        lines = _segments_in_range(transcript, st, en, max_lines=80)
        b["transcript"] = "\n".join(lines)
        # dominant speaker(s)
        speakers: dict[str, float] = {}
        for t in transcript or []:
            try:
                tst = float(t.get("start", 0)); ten = float(t.get("end", 0))
            except (TypeError, ValueError):
                continue
            if ten <= st or tst >= en:
                continue
            sp = (t.get("speaker") or "").strip()
            if not sp:
                continue
            overlap = max(0.0, min(ten, en) - max(tst, st))
            speakers[sp] = speakers.get(sp, 0.0) + overlap
        if speakers:
            b["characters"] = [s for s, _ in sorted(speakers.items(), key=lambda x: -x[1])][:6]
        b["id"] = i

    # ⚠️ "GEBD 기반"이라고 못 박으면 안 된다 — 이 함수는 GEBD 산출물이든 shots+STT gap
    # fallback 이든 같은 boundary 리스트를 받는다. 실측(2026-08-06) 두 회차 모두 fallback
    # 이었는데 로그만 "GEBD 기반"이라 학습모델이 도는 줄 알았다. 근거를 그대로 찍는다.
    _src = (boundaries[0].get("source") if boundaries and isinstance(boundaries[0], dict) else None) or "unknown"
    print(f"   beat {len(beats)}개 (평균 {sum(b['end']-b['start'] for b in beats)/max(1,len(beats)):.0f}s · boundary source={_src})")
    return {"beats": beats, "source": "gebd_boundaries"}
