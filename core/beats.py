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

from .retry import call_with_retry

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT") or "step-d"
LOCATION = os.environ.get("VERTEX_LOCATION") or "asia-northeast3"
MODEL = os.environ.get("GEMINI_MODEL") or "gemini-2.5-flash"

MIN_BEAT_SEC = 20.0     # 이 미만은 파편 · 인접 beat와 병합
SUBDIVIDE_SEC = 600.0   # 이 초과는 재분해 시도. 예능은 원 신+리액션+인터뷰 다 담으면 자연스럽게
                        # 길어짐 → 임계 완화 (2026-07-24 사용자 지적).
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

    system = f"""너는 한국 예능·방송 편집자다. 아래 구간을 **"그대로 잘라 써도 이상하지 않은 최소
편집 완결 단위(beat)"** 여러 개로 분할한다.

**beat 정의**:
- 하나의 완결된 흐름 = 시작(새 신·화제·발화) → 전개 → 마무리(대사 종결·리액션·다음 신 직전).
- 예: "민경 자기소개 + 다른 출연자 반응 + 인터뷰룸 회상" · "게임 라운드 1 · 시작~결과 발표".
- 이 beat를 통째로 잘라 SNS·클립·하이라이트에 배치해도 자연스러워야 함.

**⚠️ 한국 예능 편집 문법 (필수 규칙)**:
- 한국 예능은 **현장 원 신 + 인서트 인터뷰룸 컷 + 리액션 컷**이 교차 편집됨.
- 하나의 사건(예: "원규 한의사 반전 공개")은 다음 요소로 구성:
    a) 현장 반전 순간 (원 신)
    b) 다른 출연자들의 놀란 리액션 (원 신)
    c) 인터뷰룸에서 회상·소감 (인서트 인터뷰)
    d) 이어지는 원 신 대화·해설
- **위 a~d 전체를 하나의 beat로 묶어라**. 사건 하나에 인터뷰가 껴 있어도 나누지 마라.
- 다음 beat로 넘어가는 지점은 **주제·화제·코너가 완전히 바뀌는 지점**만.
- shot type 정보 참고: 🎤 인터뷰룸 컷 앞뒤가 같은 주제 원 신이면 하나의 beat.
- 인터뷰룸-only 구간이 길게 이어지면 (같은 주제로) 별도 beat로 분리 가능.

**경계 조건**:
- **최소 20초** — 그 미만은 파편이라 안 됨. 짧으면 인접 흐름과 묶어라.
- **최대 없음** — 하나의 코너·긴 대화신이 5~10분이면 그대로 하나의 beat.
- 시작은 **새 주제 첫 발화** (이전 대사 여운 이어지면 그 여운부터).
- 끝은 **주제 마무리 + 마지막 리액션·인터뷰까지** (반응·회상 컷 있으면 포함).
- 가능하면 shot boundary(장면 전환점) 근처에서 시작·끝.

**hook 카테고리** (반드시 다음 중 하나): 반전 / 감정고조 / 돌직구 / 질문 / 정보성 / 웃음 / 갈등 / 공감 / 기타

**반환 형식** (JSON, 다른 문장 없이):
{{"beats":[
  {{"start":90.0,"end":220.0,"title":"원규 한의사 반전 공개 + 리액션 + 인터뷰",
    "summary":"원규가 직업을 한의사라고 공개하자 모두 놀란 반응. 인터뷰룸에서 원규가 반전을 노렸다고 회상. 이어 상세 설명.",
    "characters":["원규","지연","민경"],"hook":"반전","is_complete":true}}
]}}

**시간 필드는 초 단위 숫자만**. "1:30" 같은 콜론 문자열 절대 금지.
반환 beat들의 시각은 **주어진 구간 안에서만** ({seg_start:.1f}s ~ {seg_end:.1f}s).
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


def _merge_small_beats(beats: list[dict]) -> list[dict]:
    """MIN_BEAT_SEC 미만은 인접 beat와 병합. summary/characters 합치기."""
    if not beats:
        return []
    beats = sorted(beats, key=lambda b: b["start"])
    out: list[dict] = []
    for b in beats:
        length = b["end"] - b["start"]
        if length >= MIN_BEAT_SEC:
            out.append(b)
            continue
        # 짧음 → 앞 beat와 병합 (있으면), 아니면 다음 beat와 병합 대기
        if out:
            prev = out[-1]
            prev["end"] = max(prev["end"], b["end"])
            prev["summary"] = (prev["summary"] + " · " + b["summary"]).strip(" ·")
            for c in b["characters"]:
                if c not in prev["characters"]:
                    prev["characters"].append(c)
        else:
            out.append(b)  # 첫 beat면 일단 넣고 다음 반복에서 뒤와 병합될 수 있음
    # 뒤 병합 통과 후에도 짧은 첫 beat가 남을 수 있음 · 두 번째 beat와 병합
    if len(out) >= 2 and (out[0]["end"] - out[0]["start"]) < MIN_BEAT_SEC:
        first, second = out[0], out[1]
        merged = {
            "start": first["start"], "end": second["end"],
            "title": second["title"],
            "summary": (first["summary"] + " · " + second["summary"]).strip(" ·"),
            "characters": list(dict.fromkeys(first["characters"] + second["characters"])),
            "hook": second["hook"], "is_complete": True,
        }
        out = [merged] + out[2:]
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
    system += "\n\n**주의: 이 구간은 이미 하나의 beat로 정의됐지만 길이가 5분 초과라 소주제가 여러 개 있는지 재분해한다. 여전히 하나의 흐름이면 1개만 반환.**"
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
    beats = _merge_small_beats(beats)
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

    # 정렬 · shot boundary 스냅 · id 부여
    all_beats.sort(key=lambda b: b["start"])
    for b in all_beats:
        b["start"] = round(_snap_start(b["start"], shots), 1)
        b["end"] = round(_snap_end(b["end"], shots), 1)
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
    all_beats = _merge_small_beats(all_beats)

    # id 부여
    for i, b in enumerate(all_beats):
        b["id"] = i

    print(f"   beat {len(all_beats)}개 (평균 {sum(b['end']-b['start'] for b in all_beats)/max(1,len(all_beats)):.0f}s)")
    return {"beats": all_beats}
