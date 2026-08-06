"""STEP D Core — 자연어 구간 검색 품질 채점.

`core.evaluate`(쇼츠)의 검색판. 절차·지표 정의는 `docs/research/search-evalset.md`.

**검색은 apps/server 가 판정한다** — `core/search.py` 는 오프라인 참조 구현이라 프로덕션
랭킹과 다르다. 그래서 이 스크립트는 파이썬 안에서 검색하지 않고 `GET /api/search` 를
때린다. 재는 대상이 실제로 운영자가 쓰는 그 경로여야 한다.

정답 판정: gold 와 **같은 media** 이고 IoU ≥ 0.5 (evaluate.py:11 과 같은 기준 —
40~60초 구간에서 10초 어긋나면 사실상 다른 클립).

지표 (전체 + 유형별 분해):
  recall@1 / recall@10   상위 N 안에 정답이 있는 쿼리 비율   ← 주지표
  mrr                    첫 정답 순위의 역수 평균
  edge_error_median_sec  맞힌 결과의 시작·끝 시간차 중앙값
  zero_candidate         후보 0건 비율 — **랭킹이 아니라 필터 문제**의 지표

사용:
  python -m core.eval_search --api http://localhost:8080/api \\
      --evalset docs/research/data/search-evalset.jsonl \\
      [--top-k 20] [--iou 0.5] [--out result.json]
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Any, Optional

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass


# ── 채점 (순수 함수 — HTTP 없이 테스트 가능) ─────────────────────────────────
def iou(a: tuple[float, float], b: tuple[float, float]) -> float:
    """두 구간의 Intersection over Union. core.evaluate.iou 와 같은 정의."""
    inter = max(0.0, min(a[1], b[1]) - max(a[0], b[0]))
    if inter <= 0:
        return 0.0
    union = (a[1] - a[0]) + (b[1] - b[0]) - inter
    return inter / union if union > 0 else 0.0


def _f(x: Any, default: float = 0.0) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


def score_one(results: list[dict], case: dict, min_iou: float = 0.5) -> dict:
    """쿼리 1건 채점. results = /api/search 의 results (순위 순).

    반환: {hit_rank(1부터·미스면 None), iou, edge_start, edge_end, candidates}
    """
    gold = [(_f(g.get("start")), _f(g.get("end"))) for g in (case.get("gold") or [])]
    want_media = case.get("media_id") or ""
    for rank, r in enumerate(results, start=1):
        # media 가 지정된 평가건은 같은 회차 안에서만 정답으로 친다. 다른 회차의 비슷한
        # 구간을 맞혔다고 성공으로 세면 "그 장면을 찾았다"는 주장이 성립하지 않는다.
        if want_media and r.get("mediaId") != want_media:
            continue
        span = (_f(r.get("start")), _f(r.get("end")))
        best_g, best_v = None, 0.0
        for g in gold:
            v = iou(g, span)
            if v > best_v:
                best_g, best_v = g, v
        if best_g is not None and best_v >= min_iou:
            return {
                "hit_rank": rank,
                "iou": round(best_v, 3),
                "edge_start": round(abs(span[0] - best_g[0]), 2),
                "edge_end": round(abs(span[1] - best_g[1]), 2),
                "candidates": len(results),
            }
    return {"hit_rank": None, "iou": 0.0, "edge_start": None, "edge_end": None,
            "candidates": len(results)}


def aggregate(scored: list[dict], n_list=(1, 5, 10)) -> dict:
    """채점 결과 목록 → 지표. scored 원소는 score_one 결과 + {'type': ...}."""
    total = len(scored) or 1
    out: dict[str, Any] = {"queries": len(scored)}
    for n in n_list:
        out[f"recall@{n}"] = round(
            sum(1 for s in scored if s["hit_rank"] and s["hit_rank"] <= n) / total, 3)
    out["mrr"] = round(
        sum(1.0 / s["hit_rank"] for s in scored if s["hit_rank"]) / total, 3)
    edges = [e for s in scored for e in (s["edge_start"], s["edge_end"]) if e is not None]
    out["edge_error_median_sec"] = round(statistics.median(edges), 2) if edges else None
    # 후보 0건 = 필터가 다 걷어냈다는 뜻. 랭킹을 고쳐도 안 낫는 부류라 따로 센다.
    out["zero_candidate"] = round(sum(1 for s in scored if s["candidates"] == 0) / total, 3)
    return out


# ── HTTP ─────────────────────────────────────────────────────────────────────
def run_query(api: str, case: dict, top_k: int, timeout: float = 30.0) -> dict:
    """GET {api}/search 호출. 실패는 빈 결과로 (한 건 실패가 전체를 멈추지 않게)."""
    params = {"q": case.get("query") or "", "top_k": str(top_k)}
    if case.get("program_id"):
        params["program"] = case["program_id"]
    if case.get("allow_spoiler"):
        params["allow_spoiler"] = "true"
    url = f"{api.rstrip('/')}/search?{urllib.parse.urlencode(params)}"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        print(f"  [warn] {case.get('id')} 검색 실패: {str(e)[:120]}", file=sys.stderr)
        return {"results": [], "error": str(e)}


def load_evalset(path: str | Path) -> list[dict]:
    """JSONL 로드. 빈 줄·주석(#)·깨진 줄은 건너뛴다."""
    cases = []
    for i, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            cases.append(json.loads(line))
        except ValueError:
            print(f"  [warn] {path}:{i} JSON 파싱 실패 — 건너뜀", file=sys.stderr)
    return cases


# ── main ─────────────────────────────────────────────────────────────────────
def evaluate_all(api: str, cases: list[dict], top_k: int, min_iou: float) -> dict:
    scored: list[dict] = []
    detail: list[dict] = []
    for case in cases:
        resp = run_query(api, case, top_k)
        results = resp.get("results") or []
        s = score_one(results, case, min_iou=min_iou)
        s["type"] = case.get("type") or "unknown"
        scored.append(s)
        detail.append({
            "id": case.get("id"), "type": s["type"], "query": case.get("query"),
            "hit_rank": s["hit_rank"], "iou": s["iou"],
            "edge": [s["edge_start"], s["edge_end"]],
            "candidates": s["candidates"],
            # 파서가 필터를 과하게 걸어 recall 을 죽였는지 보려면 이게 있어야 한다
            "parsed": resp.get("parsed"),
            "embedded": resp.get("embedded"),
        })

    by_type: dict[str, list[dict]] = defaultdict(list)
    for s in scored:
        by_type[s["type"]].append(s)

    return {
        "top_k": top_k,
        "min_iou": min_iou,
        "overall": aggregate(scored),
        "by_type": {t: aggregate(v) for t, v in sorted(by_type.items())},
        "detail": detail,
    }


def _print_summary(res: dict) -> None:
    o = res["overall"]
    print(f"\n== 전체 ({o['queries']} 쿼리) ==")
    print(f"  recall@1={o['recall@1']}  recall@10={o['recall@10']}  MRR={o['mrr']}")
    print(f"  경계오차 중앙값={o['edge_error_median_sec']}s  후보0건={o['zero_candidate']}")
    print("\n== 유형별 ==")
    print(f"  {'type':<16}{'n':>4}{'R@1':>7}{'R@10':>7}{'MRR':>7}{'후보0':>7}")
    for t, m in res["by_type"].items():
        print(f"  {t:<16}{m['queries']:>4}{m['recall@1']:>7}{m['recall@10']:>7}"
              f"{m['mrr']:>7}{m['zero_candidate']:>7}")
    miss = [d for d in res["detail"] if d["hit_rank"] is None]
    if miss:
        print(f"\n== 미스 {len(miss)}건 (개선 출발점) ==")
        for d in miss[:20]:
            print(f"  [{d['type']}] {d['query'][:50]} · 후보={d['candidates']}")


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="자연어 구간 검색 품질 채점")
    ap.add_argument("--api", required=True, help="서버 API 베이스 (예: http://localhost:8080/api)")
    ap.add_argument("--evalset", required=True, help="평가셋 JSONL")
    ap.add_argument("--top-k", type=int, default=20)
    ap.add_argument("--iou", type=float, default=0.5)
    ap.add_argument("--out", default="", help="결과 JSON 저장 경로")
    a = ap.parse_args(argv)

    cases = load_evalset(a.evalset)
    if not cases:
        print("평가셋이 비어 있습니다", file=sys.stderr)
        return 2
    print(f"[eval_search] {len(cases)} 쿼리 · api={a.api} · top_k={a.top_k} · iou≥{a.iou}")

    res = evaluate_all(a.api, cases, a.top_k, a.iou)
    _print_summary(res)
    if a.out:
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        Path(a.out).write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n→ {a.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
