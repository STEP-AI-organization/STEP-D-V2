"""반복·다중 홀드아웃 채점 — 엔진 실행 변동을 상쇄하고 프로파일 효과를 분리한다.

2026-07-21 발견: recommend는 temperature 0인데도 실행마다 결과가 다르다(같은 무프로파일
조건 5회가 Hit@5 0.00~0.67로 요동). 단발 A/B로는 프로파일 효과와 노이즈를 구분할 수 없다.
이 도구는 각 조건을 N회 반복해 **평균 Hit@N과 표준편차**를 내고, 여러 홀드아웃을 합산한다.

핵심 판정 기준: 프로파일 on의 평균이 off의 평균을 **표준편차를 넘어서** 상회해야 "효과 있음".
차이가 노이즈(σ) 안이면 미확정으로 정직하게 보고한다.

사용 (워커에서):
  python -m core.eval_repeat --runs 5 \
    --holdout LcMolKaPcrw=/tmp/ho_scenes.json \
    --holdout JppILjNTCok=/tmp/ho5_scenes.json \
    --truth /tmp/truth_all.json \
    --profile /tmp/ab_learned.json   # (선택) 있으면 on/off 둘 다, 없으면 off만
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys

from .recommend import recommend
from .evaluate import _spans_from_shorts, _truth_from_export, evaluate


_N_LIST = (5, 10, 20)


def _run_condition(scenes_by_ho: dict, truth_by_ho: dict, profile, runs: int, genre: str) -> dict:
    """조건(프로파일 유무) 하나를 runs회 반복. 각 회차는 모든 홀드아웃을 micro-average한다.

    정답 수가 홀드아웃마다 18/5/3으로 크게 다르므로 Hit@5만 보면 왜곡된다(정답 18건이면
    상위 5개로는 최대 5/18=0.28밖에 못 맞춘다). Hit@5/10/20을 모두 micro-average로 집계하고,
    판정은 Hit@10(균형)으로 한다."""
    per_run = {f"hit@{n}": [] for n in _N_LIST}
    for _ in range(runs):
        tot_truth = 0
        tot_hit = {n: 0 for n in _N_LIST}
        for ho, scenes in scenes_by_ho.items():
            truth = truth_by_ho.get(ho, [])
            if not truth:
                continue
            sh = recommend(scenes, n=5, genre=genre, profile=profile)["shorts"]
            r = evaluate(_spans_from_shorts({"shorts": sh}), truth, n_list=_N_LIST)
            tot_truth += r["truth_count"]
            for n in _N_LIST:
                tot_hit[n] += round(r[f"hit@{n}"] * r["truth_count"])
        for n in _N_LIST:
            per_run[f"hit@{n}"].append(tot_hit[n] / max(1, tot_truth))

    def stats(vals: list[float]) -> dict:
        return {
            "mean": round(statistics.mean(vals), 3),
            "stdev": round(statistics.pstdev(vals), 3) if len(vals) > 1 else 0.0,
            "min": round(min(vals), 3), "max": round(max(vals), 3),
            "per_run": [round(x, 3) for x in vals],
        }
    return {"runs": runs, **{f"hit@{n}": stats(per_run[f"hit@{n}"]) for n in _N_LIST}}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--holdout", action="append", required=True, help="longVideoId=scenes.json ...")
    ap.add_argument("--truth", required=True)
    ap.add_argument("--profile", default=None, help="learn 결과 JSON — 있으면 on/off 둘 다 비교")
    ap.add_argument("--genre", default="variety")
    ap.add_argument("--out", default=None, help="결과 JSON을 이 파일에 저장(recommend 로그와 분리)")
    a = ap.parse_args()

    truth_export = json.load(open(a.truth, encoding="utf-8"))
    scenes_by_ho, truth_by_ho = {}, {}
    for spec in a.holdout:
        ho, path = spec.split("=", 1)
        sc = json.load(open(path, encoding="utf-8"))
        if isinstance(sc, dict):
            sc = sc.get("scenes", sc)
        scenes_by_ho[ho] = sc
        truth_by_ho[ho] = _truth_from_export(truth_export, ho)

    truth_total = sum(len(t) for t in truth_by_ho.values())
    result = {"holdouts": list(scenes_by_ho), "truth_total": truth_total, "runs": a.runs}

    off = _run_condition(scenes_by_ho, truth_by_ho, None, a.runs, a.genre)
    result["profile_off"] = off

    if a.profile:
        learned = json.load(open(a.profile, encoding="utf-8"))
        prof = learned.get("recommend_profile")
        on = _run_condition(scenes_by_ho, truth_by_ho, prof, a.runs, a.genre)
        result["profile_on"] = on
        # 판정 기준 = Hit@10 (정답 수 편차에 덜 민감). on 평균이 off 평균을 σ 넘어 상회해야 "효과".
        verdicts = {}
        for n in _N_LIST:
            k = f"hit@{n}"
            diff = on[k]["mean"] - off[k]["mean"]
            noise = max(off[k]["stdev"], on[k]["stdev"], 0.01)
            verdicts[k] = {
                "off_mean": off[k]["mean"], "on_mean": on[k]["mean"],
                "diff": round(diff, 3), "noise_sigma": round(noise, 3),
                "verdict": (
                    "효과 있음 (차이 > 변동)" if diff > noise
                    else "효과 없음 (off가 더 높음)" if diff < -noise
                    else "미확정 (차이가 변동 안에 묻힘)"
                ),
            }
        result["verdicts"] = verdicts
        result["headline"] = f"Hit@10 기준: {verdicts['hit@10']['verdict']} " \
            f"(off {verdicts['hit@10']['off_mean']} → on {verdicts['hit@10']['on_mean']}, σ {verdicts['hit@10']['noise_sigma']})"

    out_json = json.dumps(result, ensure_ascii=False, indent=2)
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(out_json)
        print(f"@@RESULT written to {a.out}")
        if result.get("headline"):
            print("@@HEADLINE " + result["headline"])
    else:
        print(out_json)


if __name__ == "__main__":
    main()
