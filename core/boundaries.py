"""GEBD 경계(boundaries) 입출력 · 검증 · window 변환.

v1 원칙 (docs 참조):
- boundaries.json 을 **입력으로 받는** 구조부터 고정. GEBD 모델 자체 실행은 워커에 넣지 않음.
- 로컬/GPU 워커가 산출한 boundaries.json 을 media workdir 에 두면 pipeline 이 재사용.
- 없으면 fallback (기존 shots.json + STT gap 등) 을 pipeline 쪽에서 결정.

스키마 (표준 파일 / boundaries.json):
    {
      "source": "gebd",
      "model": "model_cla_f_0_s_-1_7728.pt",
      "time_unit": 1,
      "boundaries": [
        {"t": 12.5, "kind": "shot"|"event"|"whole", "score": 0.74, "source": "gebd"}
      ]
    }
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional


MIN_DEDUP_GAP_SEC = 2.0  # 이 이내 인접 경계는 하나로 병합 (계획서 v1: 0.5→2.0 상향 · 과검출 억제)
MIN_BEAT_SEC = 6.0       # 이보다 짧은 window 는 인접과 병합 (계획서: 3→6 상향)

# 등급화 (계획서 5번). GEBD peak 통과 score(0..1) 기준.
GRADE_HARD_SCORE = 0.35   # 이상: 거의 확실 → 즉시 채택
GRADE_SOFT_SCORE = 0.18   # 이상: 후보 → transcript/shot 조건 만족 시 승격
# 그 아래: noise → 무시


def load_boundaries(path: str | Path) -> list[dict]:
    """boundaries.json 로드 · 정규화된 [{t, kind, score, source}] 반환.

    - dict 형태(신규 스키마) · list 형태(과거) 모두 수용
    - t < 0 또는 문자열 파싱 실패 항목은 skip
    - 반환 리스트는 t 오름차순
    """
    p = Path(path)
    if not p.exists():
        return []
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return []

    items = raw.get("boundaries") if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        # legacy: {"boundaries_sec": [t, t, ...]}
        if isinstance(raw, dict) and isinstance(raw.get("boundaries_sec"), list):
            items = [{"t": t} for t in raw["boundaries_sec"]]
        else:
            return []

    out: list[dict] = []
    for it in items:
        if isinstance(it, (int, float)):
            out.append({"t": float(it), "kind": "unknown", "score": None, "source": "unknown"})
            continue
        if not isinstance(it, dict):
            continue
        try:
            t = float(it.get("t"))
        except (TypeError, ValueError):
            continue
        if t < 0:
            continue
        out.append({
            "t": t,
            "kind": it.get("kind") or "unknown",
            "score": it.get("score"),
            "source": it.get("source") or (raw.get("source") if isinstance(raw, dict) else "unknown"),
        })
    out.sort(key=lambda b: b["t"])
    return out


def _grade(score: Optional[float]) -> str:
    """score → hard/soft/noise 등급. score 없으면 soft (알 수 없음 → 조건부 승격)."""
    if score is None:
        return "soft"
    s = float(score)
    if s >= GRADE_HARD_SCORE:
        return "hard"
    if s >= GRADE_SOFT_SCORE:
        return "soft"
    return "noise"


def dedup_boundaries(
    boundaries: list[dict],
    min_gap_sec: float = MIN_DEDUP_GAP_SEC,
    duration: Optional[float] = None,
    min_score: Optional[float] = None,
) -> list[dict]:
    """min_gap_sec 이내 인접 경계 병합 (score 큰 쪽 유지) · duration 밖 제거 · min_score 미만 drop.

    min_score 는 계획서 1번 (score threshold 상향) 을 위한 옵션. GRADE_SOFT_SCORE 를
    기본값처럼 쓰려면 명시적으로 넘겨야 함 (v1 은 하위호환 위해 None).
    각 boundary 에 `grade` 필드 자동 부여.
    """
    if not boundaries:
        return []
    out: list[dict] = []
    for b in sorted(boundaries, key=lambda x: x["t"]):
        t = float(b["t"])
        if duration is not None and t >= float(duration):
            continue
        sc = b.get("score")
        if min_score is not None and sc is not None and float(sc) < min_score:
            continue
        g = _grade(sc)
        b = {**b, "grade": g}
        if out and (t - out[-1]["t"]) < min_gap_sec:
            # 병합: score 높은 쪽 유지
            prev = out[-1]
            cur_score = sc or 0
            prev_score = prev.get("score") or 0
            if cur_score > prev_score:
                out[-1] = {**b, "t": t}
            continue
        out.append(b)
    return out


def to_windows(
    boundaries: list[dict],
    duration: float,
    min_beat_sec: float = MIN_BEAT_SEC,
    include_grades: tuple[str, ...] = ("hard", "soft"),
) -> list[dict]:
    """경계 시각 리스트 → beat window 리스트 [{start, end, start_source, end_source}].

    - 앞뒤에 자동으로 0 과 duration 추가
    - include_grades 에 없는 등급 (기본 "noise") 은 미포함
    - 인접 경계 간격이 min_beat_sec 미만이면 뒤 경계 skip (앞 window 로 흡수)
    - 반환: [{start, end, duration, start_source, end_source, start_kind, end_kind, start_grade, end_grade}]
    """
    if duration <= 0:
        return []
    edges: list[dict] = [{"t": 0.0, "kind": "boundary", "source": "auto", "grade": "hard"}]
    for b in dedup_boundaries(boundaries, duration=duration):
        if (b.get("grade") or "soft") not in include_grades:
            continue
        edges.append({
            "t": float(b["t"]),
            "kind": b.get("kind") or "unknown",
            "source": b.get("source") or "gebd",
            "grade": b.get("grade") or "soft",
        })
    edges.append({"t": float(duration), "kind": "boundary", "source": "auto", "grade": "hard"})

    # min_beat_sec 미만 인접은 skip
    filtered = [edges[0]]
    for e in edges[1:]:
        if e["t"] - filtered[-1]["t"] < min_beat_sec:
            continue
        filtered.append(e)
    # 마지막 edge 가 duration 이 아니면 duration 을 강제 추가 (마지막 조각 유지)
    if filtered[-1]["t"] < duration - 0.1:
        # 마지막이 duration 에 너무 가까우면 대체
        if duration - filtered[-1]["t"] < min_beat_sec:
            filtered[-1] = {"t": float(duration), "kind": "boundary", "source": "auto"}
        else:
            filtered.append({"t": float(duration), "kind": "boundary", "source": "auto"})

    windows: list[dict] = []
    for a, b in zip(filtered[:-1], filtered[1:]):
        start = float(a["t"]); end = float(b["t"])
        if end - start < 0.01:
            continue
        windows.append({
            "start": start,
            "end": end,
            "duration": round(end - start, 3),
            "start_source": a.get("source") or "auto",
            "end_source": b.get("source") or "auto",
            "start_kind": a.get("kind") or "unknown",
            "end_kind": b.get("kind") or "unknown",
            "start_grade": a.get("grade") or "soft",
            "end_grade": b.get("grade") or "soft",
        })
    return windows


def save_boundaries(path: str | Path, boundaries: list[dict],
                     source: str = "gebd", model: str = "",
                     time_unit: float = 1.0) -> None:
    """boundaries 표준 스키마로 저장."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    doc = {
        "source": source,
        "model": model,
        "time_unit": time_unit,
        "boundaries": boundaries,
    }
    p.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
