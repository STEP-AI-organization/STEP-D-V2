"""
STEP D Core — 검색 로그 스키마 (§8)

검색을 붙이기 **전에** 설계해야 하는 로그. 나중에 붙이면 몇 달치가 날아간다.
검색·선택 로그는 하루 수십 개씩 쌓여 채널 성과 학습보다 빠른 루프를 만든다 —
특히 편집자가 조정한 **경계값(before→after)** 이 하이라이트 컷 지점의 지도 신호다.

이벤트 4종 (하나의 query_id로 묶임):
  search           쿼리 원문 + 파싱 결과 + 노출 후보(순위 포함)
  click            클릭한 구간
  export           실제 반출한 구간
  boundary_adjust  조정한 경계값 (before→after)  ← 가장 중요

공통 필드: event, ts(ISO), query_id, user, role.
저장: JSONL append (한 줄 = 한 이벤트). 프로덕션은 테이블로 옮기되 스키마 동일.
"""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

EVENTS = ("search", "click", "export", "boundary_adjust")


def new_query_id() -> str:
    return uuid.uuid4().hex


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class SearchLogger:
    """JSONL append 로거. path 미지정 시 SEARCH_LOG_PATH 또는 ./search_log.jsonl."""

    def __init__(self, path: Optional[str | Path] = None):
        self.path = Path(path or os.environ.get("SEARCH_LOG_PATH") or "search_log.jsonl")

    def _append(self, record: dict) -> dict:
        record.setdefault("ts", _now_iso())
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
        return record

    # ── search ────────────────────────────────────────────────────────────
    def log_search(self, query: str, parsed: dict, results: list[dict],
                   user: str = "", role: str = "",
                   query_id: Optional[str] = None) -> str:
        """검색 1회. 노출 후보를 순위와 함께 남긴다(Recall 평가·클릭 조인용).
        반환: query_id (이후 click/export/boundary_adjust가 이 id로 묶임)."""
        qid = query_id or new_query_id()
        candidates = [
            {"rank": i + 1, "segment_id": r.get("segment_id"),
             "score": r.get("score"), "bm25": r.get("bm25"), "cosine": r.get("cosine")}
            for i, r in enumerate(results)
        ]
        self._append({
            "event": "search", "query_id": qid,
            "query": query, "parsed": parsed,
            "candidates": candidates, "result_count": len(results),
            "user": user, "role": role,
        })
        return qid

    # ── click ─────────────────────────────────────────────────────────────
    def log_click(self, query_id: str, segment_id: str, rank: Optional[int] = None,
                  user: str = "", role: str = "") -> None:
        self._append({
            "event": "click", "query_id": query_id,
            "segment_id": segment_id, "rank": rank,
            "user": user, "role": role,
        })

    # ── export (실제 반출) ─────────────────────────────────────────────────
    def log_export(self, query_id: str, segment_id: str,
                   start: Optional[float] = None, end: Optional[float] = None,
                   user: str = "", role: str = "") -> None:
        self._append({
            "event": "export", "query_id": query_id,
            "segment_id": segment_id, "start": start, "end": end,
            "user": user, "role": role,
        })

    # ── boundary_adjust (경계 조정 — 가장 중요) ────────────────────────────
    def log_boundary_adjust(self, query_id: str, segment_id: str,
                            before: dict, after: dict,
                            user: str = "", role: str = "") -> None:
        """before/after = {"start": float, "end": float}. 컷 지점 학습 신호."""
        self._append({
            "event": "boundary_adjust", "query_id": query_id,
            "segment_id": segment_id,
            "before": {"start": before.get("start"), "end": before.get("end")},
            "after": {"start": after.get("start"), "end": after.get("end")},
            "delta_start": _delta(before.get("start"), after.get("start")),
            "delta_end": _delta(before.get("end"), after.get("end")),
            "user": user, "role": role,
        })


def _delta(a, b) -> Optional[float]:
    try:
        return round(float(b) - float(a), 3)
    except (TypeError, ValueError):
        return None


def read_events(path: str | Path) -> list[dict]:
    """JSONL 로그 로드 (평가·분석용). 깨진 줄은 건너뜀."""
    p = Path(path)
    if not p.exists():
        return []
    out = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out
