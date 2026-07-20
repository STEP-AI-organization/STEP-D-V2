"""쇼츠 추천 품질 채점 — "편집자가 실제로 고른 곳을 찾아내는가".

정답지는 채널이 **실제로 발행한 숏폼**이다. Lab의 숏폼↔롱폼 매칭이 그걸 (롱폼, 구간)으로
복원해 놓았고 연령보정 성과 tier까지 붙어 있다. 이 스크립트는 추천기가 뽑은 구간과 그 정답을
맞춰 세 가지를 잰다(docs/plans/shorts-quality-eval.md):

  Hit@N        상위 N개 중 정답과 IoU≥0.5로 겹치는 정답의 비율 (재현율)
  고성과 순위   tier=high 정답의 평균 추천 순위 (낮을수록 좋다)
  경계 오차     맞힌 구간의 시작·끝 시간차 중앙값(초)

IoU 0.5를 쓰는 이유: 숏폼은 40~60초라 10초만 어긋나도 사실상 다른 클립이다.

사용:
  python -m core.evaluate --shorts analysis.json --truth truth.json
    analysis.json : content.analyze 산출물(또는 shorts 배열만) — 추천 결과
    truth.json    : /api/lab/match/export 응답에서 해당 롱폼 pairs만 추린 것
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from typing import Any


def iou(a: tuple[float, float], b: tuple[float, float]) -> float:
    """두 구간의 Intersection over Union."""
    inter = max(0.0, min(a[1], b[1]) - max(a[0], b[0]))
    if inter <= 0:
        return 0.0
    union = (a[1] - a[0]) + (b[1] - b[0]) - inter
    return inter / union if union > 0 else 0.0


def _spans_from_shorts(obj: Any) -> list[dict]:
    """analysis.json / shorts.json / [shorts] 어느 형태든 받아 추천 순위대로 돌려준다."""
    shorts = obj.get("shorts") if isinstance(obj, dict) else obj
    if not isinstance(shorts, list):
        return []
    out = []
    for i, s in enumerate(shorts):
        try:
            out.append({
                "rank": int(s.get("rank") or (i + 1)),
                "start": float(s.get("start", 0)),
                "end": float(s.get("end", 0)),
                "title": s.get("title") or "",
            })
        except (TypeError, ValueError):
            continue
    out.sort(key=lambda x: x["rank"])
    return out


def _truth_from_export(obj: Any, long_video_id: str | None) -> list[dict]:
    """export 응답(또는 pairs 배열) → 정답 구간 목록."""
    pairs = obj.get("pairs") if isinstance(obj, dict) else obj
    if not isinstance(pairs, list):
        return []
    out = []
    for p in pairs:
        src = p.get("source") or {}
        if long_video_id and src.get("longVideoId") != long_video_id:
            continue
        try:
            out.append({
                "id": p.get("pair_id"),
                "start": float(src.get("segStart", 0)),
                "end": float(src.get("segEnd", 0)),
                "tier": (p.get("performance") or {}).get("tier", "mid"),
                "title": (p.get("short") or {}).get("title") or "",
            })
        except (TypeError, ValueError):
            continue
    return out


def evaluate(shorts: list[dict], truth: list[dict], n_list=(5, 10, 20), min_iou=0.5) -> dict:
    """정답마다 '가장 잘 겹치는 추천'을 찾아 순위·IoU·경계오차를 기록한다.

    정답 기준으로 도는 이유: 우리가 알고 싶은 건 "편집자가 고른 곳을 찾았는가"(재현율)다.
    추천 기준으로 돌면 정답에 없는 추천을 오답으로 세게 되는데, 발행되지 않았다고 나쁜
    구간인 건 아니라서 그 방향은 의미가 약하다.
    """
    matched = []
    for t in truth:
        best = None
        for s in shorts:
            v = iou((t["start"], t["end"]), (s["start"], s["end"]))
            if v >= min_iou and (best is None or v > best["iou"]):
                best = {"iou": v, "rank": s["rank"], "short": s}
        matched.append({"truth": t, "best": best})

    total = len(truth) or 1
    hits = {f"hit@{n}": round(
        sum(1 for m in matched if m["best"] and m["best"]["rank"] <= n) / total, 3
    ) for n in n_list}

    high = [m for m in matched if m["truth"]["tier"] == "high"]
    high_found = [m for m in high if m["best"]]
    high_rank = round(statistics.mean(m["best"]["rank"] for m in high_found), 2) if high_found else None

    found = [m for m in matched if m["best"]]
    edge = []
    for m in found:
        edge.append(abs(m["truth"]["start"] - m["best"]["short"]["start"]))
        edge.append(abs(m["truth"]["end"] - m["best"]["short"]["end"]))

    return {
        "truth_count": len(truth),
        "shorts_count": len(shorts),
        "found": len(found),
        "recall": round(len(found) / total, 3),
        **hits,
        "high_tier_total": len(high),
        "high_tier_found": len(high_found),
        "high_tier_mean_rank": high_rank,
        "edge_error_median_sec": round(statistics.median(edge), 2) if edge else None,
        "detail": [
            {
                "tier": m["truth"]["tier"],
                "truth": [round(m["truth"]["start"], 1), round(m["truth"]["end"], 1)],
                "rank": m["best"]["rank"] if m["best"] else None,
                "iou": round(m["best"]["iou"], 3) if m["best"] else 0.0,
                "short_title": m["truth"]["title"][:40],
            }
            for m in matched
        ],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shorts", required=True, help="analysis.json / shorts.json")
    ap.add_argument("--truth", required=True, help="/api/lab/match/export 응답 JSON")
    ap.add_argument("--long", default=None, help="정답을 이 longVideoId로 한정")
    ap.add_argument("--iou", type=float, default=0.5)
    a = ap.parse_args()

    with open(a.shorts, encoding="utf-8") as f:
        shorts = _spans_from_shorts(json.load(f))
    with open(a.truth, encoding="utf-8") as f:
        truth = _truth_from_export(json.load(f), a.long)

    if not truth:
        print("정답이 비어 있습니다 (--long 필터를 확인하세요)", file=sys.stderr)
        raise SystemExit(2)
    print(json.dumps(evaluate(shorts, truth, min_iou=a.iou), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
