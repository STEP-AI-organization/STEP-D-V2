"""여러 홀드아웃 롱폼을 한 번에 채점하고 before/after를 집계한다.

쓰임: 개선(recommend 프롬프트·길이 하한 등)이 여러 영상에서 재현되는지 보기 위함.
단일 영상 결과는 우연일 수 있으므로, 홀드아웃을 모아 Hit@N을 합산·평균낸다.

입력:
  --truth   /api/lab/match/export 응답 (전체 채널 pairs — long_video_id로 분리)
  --shorts  "longVideoId=analysis.json" 를 여러 개 (분석 산출물의 shorts를 각 롱폼에 대응)
예:
  python -m core.eval_batch --truth export.json \
    --shorts LcMolKaPcrw=ho1.json JppILjNTCok=ho2.json NtXLj7xOeE8=ho3.json

정직성: 홀드아웃 롱폼의 매칭은 학습 입력에서 제외돼야 한다(영상 단위 hold-out).
여기서는 채점만 하므로 그 원칙은 학습 단계에서 지켜야 한다.
"""

from __future__ import annotations

import argparse
import json
import statistics

from .evaluate import _spans_from_shorts, _truth_from_export, evaluate


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--truth", required=True)
    ap.add_argument("--shorts", nargs="+", required=True, help="longVideoId=analysis.json ...")
    ap.add_argument("--iou", type=float, default=0.5)
    a = ap.parse_args()

    with open(a.truth, encoding="utf-8") as f:
        export = json.load(f)

    rows = []
    agg = {"truth": 0, "found": 0, "hit5": 0, "hit10": 0, "high": 0, "high_found": 0}
    edge_all = []
    for spec in a.shorts:
        if "=" not in spec:
            print(f"  건너뜀(형식오류): {spec}")
            continue
        long_id, path = spec.split("=", 1)
        with open(path, encoding="utf-8") as f:
            shorts = _spans_from_shorts(json.load(f))
        truth = _truth_from_export(export, long_id)
        if not truth:
            print(f"  {long_id}: 정답 없음 — 건너뜀")
            continue
        r = evaluate(shorts, truth, min_iou=a.iou)
        rows.append({"long": long_id, **{k: r[k] for k in ("truth_count", "found", "hit@5", "hit@10",
                                                            "high_tier_total", "high_tier_found",
                                                            "high_tier_mean_rank", "edge_error_median_sec")}})
        agg["truth"] += r["truth_count"]
        agg["found"] += r["found"]
        agg["hit5"] += round(r["hit@5"] * r["truth_count"])
        agg["hit10"] += round(r["hit@10"] * r["truth_count"])
        agg["high"] += r["high_tier_total"]
        agg["high_found"] += r["high_tier_found"]
        if r["edge_error_median_sec"] is not None:
            edge_all.append(r["edge_error_median_sec"])

    t = max(1, agg["truth"])
    summary = {
        "holdouts": len(rows),
        "truth_total": agg["truth"],
        "found_total": agg["found"],
        "recall": round(agg["found"] / t, 3),
        "hit@5_micro": round(agg["hit5"] / t, 3),
        "hit@10_micro": round(agg["hit10"] / t, 3),
        "high_tier_recall": round(agg["high_found"] / max(1, agg["high"]), 3),
        "edge_error_median_sec": round(statistics.median(edge_all), 2) if edge_all else None,
        "per_holdout": rows,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
