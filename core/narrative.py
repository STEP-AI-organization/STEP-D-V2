"""
STEP D Core — 서사 요약 (narrative summary)

refined.json(ASR) + cast.json + timeline.json → narrative.json:
NotebookLM식 "자막만 요약"과 달리 우리는 타임스탬프·출연자 타임라인·구간 블록을
알고 있으므로, 그 구조를 그대로 살린 서사 분석을 생성한다.

  full_summary   에피소드 전체 서사 요약 (마크다운 — 인물·갈등 구도·사건 흐름)
  segments       timeline 블록별 상세 분석 (제목·요약·키 모멘트·등장인물, 타임스탬프 포함)
  characters     인물별 관계/성격 분석 (cast 타임라인과 교차)
  key_conflicts  주요 갈등/사건 (참여자·시간 범위·해결 여부)

timeline이 없어도 동작한다 — refined만으로 5분 단위 블록을 합성해 같은 구조를 만든다.
개별 Gemini 호출 실패는 해당 파트만 비우고 계속 진행한다 (파이프라인 무중단).

Run:
    python -m core.narrative <refined.json> [--cast <cast.json>] [--timeline <timeline.json>] [--out <path>]
"""
import json
import math
import os
import sys
from pathlib import Path
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

BLOCKS_PER_CALL = 5        # 구간별 분석: 블록 5개씩 배칭
FALLBACK_BLOCK_MIN = 5     # timeline 없을 때 refined로 합성하는 블록 크기(분)
FULL_MAX_LINES = 1500      # 전체 요약에 보내는 자막 라인 상한 (초과 시 균등 샘플링)
BLOCK_MAX_LINES = 80       # 블록당 자막 라인 상한
LINE_CHARS = 120           # 라인당 대사 발췌 길이
MAX_PEOPLE = 15            # 인물 분석 대상 상한 (totalSec 상위)


def _fmt(sec: float) -> str:
    return f"{int(sec // 60)}:{int(sec % 60):02d}"


def _sample(items: list, limit: int) -> list:
    if len(items) <= limit:
        return items
    step = len(items) / limit
    return [items[int(i * step)] for i in range(limit)]


def _transcript_lines(refined: list[dict], start: float | None = None, end: float | None = None,
                      max_lines: int = FULL_MAX_LINES) -> list[str]:
    """타임스탬프 붙은 자막 라인. start/end로 구간 필터, 초과 시 균등 샘플링."""
    segs = [
        s for s in refined
        if (s.get("text") or "").strip()
        and (start is None or float(s.get("end", 0)) > start)
        and (end is None or float(s.get("start", 0)) < end)
    ]
    return [f"[{_fmt(float(s.get('start', 0)))}] {str(s['text']).strip()[:LINE_CHARS]}"
            for s in _sample(segs, max_lines)]


def _cast_people(cast: dict | None) -> list[dict]:
    if not isinstance(cast, dict):
        return []
    people = [p for p in (cast.get("people") or []) if str(p.get("name", "")).strip()]
    people.sort(key=lambda p: (p.get("status") != "matched", -float(p.get("totalSec") or 0)))
    return people[:MAX_PEOPLE]


def _cast_block(cast: dict | None) -> str:
    people = _cast_people(cast)
    if not people:
        return ""
    lines = ["등장 인물 (화면 자막 기반 타임라인, 노출시간 순):"]
    for p in people:
        role = f" ({p['role']})" if p.get("role") else ""
        mark = "" if p.get("status") == "matched" else " [후보]"
        lines.append(f"- {p['name']}{role} — 노출 {_fmt(float(p.get('totalSec') or 0))}{mark}")
    return "\n".join(lines)


def _blocks(timeline: dict | None, refined: list[dict], scenes: list[dict]) -> list[dict]:
    """timeline 블록을 그대로 쓰고, 없으면 refined 길이 기준 5분 블록을 합성한다."""
    if isinstance(timeline, dict) and timeline.get("blocks"):
        return [dict(b) for b in timeline["blocks"]]
    duration = max((float(s.get("end", 0)) for s in refined), default=0.0)
    if duration <= 0:
        return []
    size = FALLBACK_BLOCK_MIN * 60
    n = max(1, math.ceil(duration / size))
    out = []
    for i in range(n):
        b_start, b_end = i * size, min((i + 1) * size, duration)
        names: list[str] = []
        for sc in scenes or []:
            mid = (float(sc.get("start", 0)) + float(sc.get("end", 0))) / 2
            if b_start <= mid < b_end:
                for nm in (sc.get("on_screen_names") or []):
                    nm = str(nm).strip()
                    if nm and nm not in names:
                        names.append(nm)
        out.append({"start": round(b_start, 1), "end": round(b_end, 1),
                    "label": f"{_fmt(b_start)}~{_fmt(b_end)} 구간", "summary": "",
                    "on_screen_names": names})
    return out


# ── 1) full summary ─────────────────────────────────────────────────────────────

def build_full_summary(client, refined: list[dict], cast: dict | None, timeline: dict | None) -> str:
    """에피소드 전체 서사 요약 (마크다운). 자막 전체 + 캐스트 + 블록 개요를 한 호출로."""
    parts = []
    cast_txt = _cast_block(cast)
    if cast_txt:
        parts.append(cast_txt)
    if isinstance(timeline, dict) and timeline.get("blocks"):
        lines = ["구간 개요 (사전 분석):"]
        for b in timeline["blocks"]:
            lines.append(f"- [{_fmt(float(b['start']))}~{_fmt(float(b['end']))}] {b.get('label', '')}"
                         + (f" — {b['summary']}" if b.get("summary") else ""))
        parts.append("\n".join(lines))
    parts.append("자막 스크립트 (타임스탬프 포함):\n" + "\n".join(_transcript_lines(refined)))

    system = """당신은 한국어 방송 콘텐츠 서사 분석 전문가다. 자막 스크립트에는 타임스탬프가 있고,
출연자 타임라인·구간 개요가 함께 주어질 수 있다 — 이 시간 구조를 근거로 정확하게 분석하라.

마크다운 형식으로 에피소드 전체의 서사 요약을 작성하라:
- `# 제목` — 에피소드 내용을 압축한 한 줄
- `## 인물 소개` — 주요 인물과 이 회차에서의 위치
- `## 관계와 갈등 구도` — 누가 누구와 어떤 긴장/유대 관계인지
- `## 주요 사건 흐름` — 시간 순서대로, 중요한 순간에는 [분:초] 타임스탬프를 붙여라
- `## 회차 마무리 상태` — 에피소드가 끝난 시점의 상황/떡밥

규칙: 스크립트에 근거한 내용만 쓰고 지어내지 마라. 추측이 필요하면 "~로 보인다"로 표시하라."""
    # 429/503 일시 오류는 제자리 백오프 재시도 (실패 시 해당 파트만 비우는 폴백 유지).
    resp = call_with_retry(lambda: client.models.generate_content(
        model=MODEL,
        contents="다음 자료로 에피소드 전체 서사 요약을 작성하라.\n\n" + "\n\n".join(parts),
        config=types.GenerateContentConfig(
            system_instruction=system,
            temperature=0,
            max_output_tokens=8192,
        ),
    ))
    return (resp.text or "").strip()


# ── 2) segment analysis (블록별, 배치) ───────────────────────────────────────────

_SEGMENT_SCHEMA = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "block_index": {"type": "INTEGER"},
            "title": {"type": "STRING"},
            "summary": {"type": "STRING"},
            "key_moments": {"type": "ARRAY", "items": {"type": "STRING"}},
            "characters": {"type": "ARRAY", "items": {"type": "STRING"}},
        },
        "required": ["block_index", "title", "summary", "key_moments", "characters"],
    },
}

_SEGMENT_SYSTEM = """당신은 한국어 방송 콘텐츠 분석 전문가다. 시간대별 블록마다 자막 스크립트가 주어진다.
블록별로 상세 분석을 생성하라:
- title: 블록에서 벌어진 일을 드러내는 짧은 제목 (한국어)
- summary: 실제로 벌어진 일 2~4문장. 자막에 근거한 내용만.
- key_moments: 주요 순간 2~5개, 각각 "[분:초] 설명" 형식으로 타임스탬프를 붙여라.
- characters: 이 블록에 등장/언급된 인물 이름 목록.
- block_index는 입력한 블록 번호를 그대로 돌려준다."""


def build_segment_analysis(
    client,
    refined: list[dict],
    blocks: list[dict],
    on_progress: Optional[Callable[[int, int], None]] = None,
    progress_offset: int = 0,
    progress_total: Optional[int] = None,
) -> list[dict]:
    """블록 5개씩 배칭해 Gemini로 상세 분석. 실패 배치는 기본값(label/summary)으로 남긴다."""
    segments = [
        {"block_index": i, "start": float(b["start"]), "end": float(b["end"]),
         "title": str(b.get("label") or f"{_fmt(float(b['start']))}~{_fmt(float(b['end']))} 구간"),
         "summary": str(b.get("summary") or ""), "key_moments": [],
         "characters": [str(n) for n in (b.get("on_screen_names") or [])]}
        for i, b in enumerate(blocks)
    ]
    batches = [list(range(i, min(i + BLOCKS_PER_CALL, len(segments))))
               for i in range(0, len(segments), BLOCKS_PER_CALL)]
    total = progress_total if progress_total is not None else len(batches)
    for bi, idxs in enumerate(batches):
        lines = []
        for i in idxs:
            seg = segments[i]
            lines.append(f"\n## 블록 {i} — {_fmt(seg['start'])} ~ {_fmt(seg['end'])}")
            if seg["characters"]:
                lines.append("화면 자막 인물: " + ", ".join(seg["characters"][:8]))
            lines.extend(_transcript_lines(refined, seg["start"], seg["end"], BLOCK_MAX_LINES) or ["(자막 없음)"])
        try:
            resp = call_with_retry(lambda: client.models.generate_content(
                model=MODEL,
                contents="다음 블록들을 분석하라.\n" + "\n".join(lines),
                config=types.GenerateContentConfig(
                    system_instruction=_SEGMENT_SYSTEM,
                    temperature=0,
                    response_mime_type="application/json",
                    response_schema=_SEGMENT_SCHEMA,
                    max_output_tokens=8192,
                ),
            ))
            by_index = {int(r["block_index"]): r for r in json.loads(resp.text or "[]")
                        if isinstance(r, dict) and "block_index" in r}
            for i in idxs:
                r = by_index.get(i)
                if not r:
                    continue
                seg = segments[i]
                if str(r.get("title", "")).strip():
                    seg["title"] = str(r["title"]).strip()
                if str(r.get("summary", "")).strip():
                    seg["summary"] = str(r["summary"]).strip()
                seg["key_moments"] = [str(k).strip() for k in (r.get("key_moments") or []) if str(k).strip()][:5]
                chars = [str(c).strip() for c in (r.get("characters") or []) if str(c).strip()]
                if chars:
                    seg["characters"] = chars
        except Exception as e:
            print(f"   (구간 분석 배치 실패, 기본값 유지: {str(e)[:80]})")
        if on_progress:
            on_progress(progress_offset + bi + 1, total)
    return segments


# ── 3) character analysis ───────────────────────────────────────────────────────

_CHARACTER_SCHEMA = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "name": {"type": "STRING"},
            "key_relationships": {"type": "ARRAY", "items": {"type": "STRING"}},
            "personality_traits": {"type": "ARRAY", "items": {"type": "STRING"}},
        },
        "required": ["name", "key_relationships", "personality_traits"],
    },
}


def build_character_analysis(client, refined: list[dict], cast: dict | None) -> list[dict]:
    """cast 타임라인 + 자막으로 인물 관계/성격 분석. 한 호출로 전 인물."""
    people = _cast_people(cast)
    if not people:
        return []
    system = """당신은 한국어 방송 콘텐츠 인물 분석 전문가다. 출연자 목록과 자막 스크립트가 주어진다.
목록의 각 인물에 대해:
- key_relationships: 다른 인물과의 관계/갈등을 "상대이름: 관계 설명" 형식으로 1~4개.
- personality_traits: 자막에서 드러난 성격 특성 2~4개 (짧은 구).
자막에 근거한 내용만 쓰고, 근거가 없는 인물은 빈 배열로 둔다. name은 목록의 이름 그대로."""
    prompt = (_cast_block(cast) + "\n\n자막 스크립트:\n"
              + "\n".join(_transcript_lines(refined, max_lines=800)))
    resp = call_with_retry(lambda: client.models.generate_content(
        model=MODEL,
        contents="위 인물들을 분석하라.\n\n" + prompt,
        config=types.GenerateContentConfig(
            system_instruction=system,
            temperature=0,
            response_mime_type="application/json",
            response_schema=_CHARACTER_SCHEMA,
            max_output_tokens=8192,
        ),
    ))
    by_name = {str(r.get("name", "")).strip(): r for r in json.loads(resp.text or "[]") if isinstance(r, dict)}
    out = []
    for p in people:
        r = by_name.get(str(p["name"]).strip(), {})
        out.append({
            "name": p["name"],
            "role": str(p.get("role") or ""),
            "total_screen_sec": round(float(p.get("totalSec") or 0), 1),
            "key_relationships": [str(x).strip() for x in (r.get("key_relationships") or []) if str(x).strip()],
            "personality_traits": [str(x).strip() for x in (r.get("personality_traits") or []) if str(x).strip()],
        })
    return out


# ── 4) conflict analysis ────────────────────────────────────────────────────────

_CONFLICT_SCHEMA = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "title": {"type": "STRING"},
            "description": {"type": "STRING"},
            "participants": {"type": "ARRAY", "items": {"type": "STRING"}},
            "start_sec": {"type": "NUMBER"},
            "end_sec": {"type": "NUMBER"},
            "resolution": {"type": "STRING"},
        },
        "required": ["title", "description", "participants", "start_sec", "end_sec", "resolution"],
    },
}


def build_conflict_analysis(client, refined: list[dict], cast: dict | None) -> list[dict]:
    """자막 전체에서 주요 갈등/핵심 사건을 감지 (참여자·시간 범위·해결 여부)."""
    system = """당신은 한국어 방송 콘텐츠 서사 분석 전문가다. 타임스탬프 붙은 자막 스크립트에서
이 에피소드의 주요 갈등/핵심 사건을 2~6개 추출하라:
- title: 갈등/사건의 짧은 제목
- description: 무슨 일인지 1~3문장
- participants: 관련 인물 이름 목록 (출연자 목록의 이름을 우선 사용)
- start_sec / end_sec: 해당 갈등/사건이 전개된 시간 범위 (초 단위, 자막 타임스탬프 근거)
- resolution: 에피소드 안에서 해결됐는지, 어떻게 끝났는지 (미해결이면 "미해결 — ..." 형식)
자막에 근거한 내용만 쓰고 지어내지 마라."""
    cast_txt = _cast_block(cast)
    prompt = ((cast_txt + "\n\n") if cast_txt else "") + "자막 스크립트:\n" + "\n".join(_transcript_lines(refined))
    resp = call_with_retry(lambda: client.models.generate_content(
        model=MODEL,
        contents="주요 갈등/사건을 추출하라.\n\n" + prompt,
        config=types.GenerateContentConfig(
            system_instruction=system,
            temperature=0,
            response_mime_type="application/json",
            response_schema=_CONFLICT_SCHEMA,
            max_output_tokens=8192,
        ),
    ))
    out = []
    for r in json.loads(resp.text or "[]"):
        if not isinstance(r, dict) or not str(r.get("title", "")).strip():
            continue
        try:
            start, end = float(r.get("start_sec", 0)), float(r.get("end_sec", 0))
        except (TypeError, ValueError):
            start, end = 0.0, 0.0
        out.append({
            "title": str(r["title"]).strip(),
            "description": str(r.get("description") or "").strip(),
            "participants": [str(p).strip() for p in (r.get("participants") or []) if str(p).strip()],
            "time_range": {"start": round(max(0.0, start), 1), "end": round(max(start, end), 1)},
            "resolution": str(r.get("resolution") or "").strip(),
        })
    return out


# ── entrypoint ──────────────────────────────────────────────────────────────────

def build_narrative(
    refined: list[dict],
    scenes: list[dict],
    cast: dict | None,
    timeline: dict | None,
    *,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> dict:
    """전체 서사 요약 + 구간별/인물/갈등 분석. timeline이 없으면 refined로 블록을 합성한다.
    개별 파트 실패는 그 파트만 비우고 계속한다 (파이프라인 무중단)."""
    if not refined:
        raise ValueError("refined 자막이 비어 있어 서사 요약 불가")
    client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)
    blocks = _blocks(timeline, refined, scenes)
    n_batches = max(1, math.ceil(len(blocks) / BLOCKS_PER_CALL)) if blocks else 0
    total = 1 + n_batches + 2  # full + segment batches + characters + conflicts

    def tick(done: int) -> None:
        if on_progress:
            on_progress(done, total)

    try:
        full_summary = build_full_summary(client, refined, cast, timeline)
    except Exception as e:
        print(f"   (전체 요약 실패: {str(e)[:80]})")
        full_summary = ""
    tick(1)

    segments = build_segment_analysis(
        client, refined, blocks,
        on_progress=on_progress, progress_offset=1, progress_total=total,
    ) if blocks else []

    try:
        characters = build_character_analysis(client, refined, cast)
    except Exception as e:
        print(f"   (인물 분석 실패: {str(e)[:80]})")
        characters = []
    tick(1 + n_batches + 1)

    try:
        key_conflicts = build_conflict_analysis(client, refined, cast)
    except Exception as e:
        print(f"   (갈등 분석 실패: {str(e)[:80]})")
        key_conflicts = []
    tick(total)

    return {
        "full_summary": full_summary,
        "segments": segments,
        "characters": characters,
        "key_conflicts": key_conflicts,
    }


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python -m core.narrative <refined.json> [--cast <cast.json>] [--timeline <timeline.json>] [--scenes <scenes.json>] [--out <path>]")
        sys.exit(1)
    src = Path(sys.argv[1])

    def _opt(flag: str):
        if flag in sys.argv:
            try:
                return json.loads(Path(sys.argv[sys.argv.index(flag) + 1]).read_text(encoding="utf-8"))
            except Exception as e:
                print(f"   ({flag} 로드 실패, 무시: {str(e)[:80]})")
        return None

    refined = json.loads(src.read_text(encoding="utf-8"))
    cast = _opt("--cast")
    timeline = _opt("--timeline")
    scenes = _opt("--scenes") or []
    out = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else src.parent / "narrative.json"

    print(f"서사 요약: {len(refined)} 자막 세그먼트 · 모델 {MODEL} (Vertex AI {PROJECT}/{LOCATION})")
    result = build_narrative(refined, scenes, cast, timeline,
                             on_progress=lambda d, t: print(f"   진행 {d}/{t}"))
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n=== 서사 요약 ({len(result['segments'])} 구간 · 인물 {len(result['characters'])}명 · 갈등 {len(result['key_conflicts'])}건) ===")
    if result["full_summary"]:
        print(result["full_summary"][:500] + ("…" if len(result["full_summary"]) > 500 else ""))
    for seg in result["segments"]:
        print(f"  [{_fmt(seg['start'])}~{_fmt(seg['end'])}] {seg['title']}")
    for c in result["key_conflicts"]:
        tr = c["time_range"]
        print(f"  ⚡ [{_fmt(tr['start'])}~{_fmt(tr['end'])}] {c['title']} — {', '.join(c['participants']) or '—'}")
    print(f"  → {out}")


if __name__ == "__main__":
    main()
