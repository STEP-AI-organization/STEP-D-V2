"""주제(의미) 기반 A/B — "엔진이 편집자와 같은 순간을 숏폼감으로 잡았나"를 학습 on/off로 비교.

eval_repeat.py가 IoU(같은 초)로 잰다면, 여기선 eval_topic.topic_hits로 **내용 일치**를 잰다.
발행 숏폼(정답)의 제목·자막 vs 엔진 픽의 제목·구간자막을 Gemini가 "같은 순간인가"로 판정.

사용:
  python -m core.eval_topic_ab --runs 3 \
    --holdout JppILjNTCok=/tmp/ho5_scenes.json \
    --holdout LcMolKaPcrw=/tmp/ho_scenes.json \
    --truth /tmp/truth_all.json --profile /tmp/ab_learned_clean.json --out /tmp/topic_ab.json
"""

from __future__ import annotations

import argparse
import json
import statistics

from .recommend import recommend
from .eval_topic import topic_hits

_N = (5, 10, 20)


def _rec_text(scenes: list[dict], start: float, end: float) -> str:
    """엔진 픽 구간과 겹치는 장면들의 대사를 이어붙여 그 픽의 '내용'을 만든다."""
    parts = [str(s.get("text") or "") for s in scenes
             if float(s.get("end", 0)) > start and float(s.get("start", 0)) < end]
    return " ".join(p for p in parts if p.strip())[:200]


def _published(export: dict, ho: str) -> list[dict]:
    """홀드아웃 ho의 발행 숏폼(정답): 제목 + 소스 구간 자막."""
    pairs = export.get("pairs") if isinstance(export, dict) else export
    out = []
    for p in pairs or []:
        src = p.get("source") or {}
        if src.get("longVideoId") != ho:
            continue
        out.append({
            "title": (p.get("short") or {}).get("title") or "",
            "text": src.get("transcript_slice") or src.get("scene_summary") or "",
        })
    return out


def _run_condition(scenes_by_ho, pub_by_ho, profile, runs, genre) -> dict:
    per_run = {n: [] for n in _N}
    for _ in range(runs):
        tot_pub = 0
        tot = {n: 0 for n in _N}
        for ho, scenes in scenes_by_ho.items():
            pub = pub_by_ho.get(ho, [])
            if not pub:
                continue
            sh = recommend(scenes, n=5, genre=genre, profile=profile)["shorts"]
            recs = [{"rank": s.get("rank"), "title": s.get("title", ""),
                     "text": _rec_text(scenes, float(s.get("start", 0)), float(s.get("end", 0)))}
                    for s in sh]
            r = topic_hits(pub, recs, n_list=_N)
            tot_pub += r["published"]
            for n in _N:
                tot[n] += round(r[f"topic_hit@{n}"] * r["published"])
        for n in _N:
            per_run[n].append(tot[n] / max(1, tot_pub))

    def st(v):
        return {"mean": round(statistics.mean(v), 3),
                "stdev": round(statistics.pstdev(v), 3) if len(v) > 1 else 0.0,
                "per_run": [round(x, 3) for x in v]}
    return {n: st(per_run[n]) for n in _N}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--holdout", action="append", required=True)
    ap.add_argument("--truth", required=True)
    ap.add_argument("--profile", default=None, help="프로파일 A (예: base)")
    ap.add_argument("--profile-b", dest="profile_b", default=None, help="프로파일 B (예: base+few-shot) — 있으면 off/A/B 3조건")
    ap.add_argument("--genre", default="variety")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    export = json.load(open(a.truth, encoding="utf-8"))
    scenes_by_ho, pub_by_ho = {}, {}
    for spec in a.holdout:
        ho, path = spec.split("=", 1)
        sc = json.load(open(path, encoding="utf-8"))
        if isinstance(sc, dict):
            sc = sc.get("scenes", sc)
        scenes_by_ho[ho] = sc
        pub_by_ho[ho] = _published(export, ho)

    result = {"holdouts": list(scenes_by_ho),
              "published_total": sum(len(v) for v in pub_by_ho.values()), "runs": a.runs}
    result["profile_off"] = _run_condition(scenes_by_ho, pub_by_ho, None, a.runs, a.genre)
    head = [f"off {result['profile_off'][10]['mean']}"]
    if a.profile:
        prof = json.load(open(a.profile, encoding="utf-8")).get("recommend_profile")
        result["profile_a"] = _run_condition(scenes_by_ho, pub_by_ho, prof, a.runs, a.genre)
        head.append(f"base {result['profile_a'][10]['mean']}")
    if a.profile_b:
        prof_b = json.load(open(a.profile_b, encoding="utf-8")).get("recommend_profile")
        result["profile_b"] = _run_condition(scenes_by_ho, pub_by_ho, prof_b, a.runs, a.genre)
        head.append(f"base+예시 {result['profile_b'][10]['mean']}")
    result["headline"] = "Topic-Hit@10(내용): " + " → ".join(head)

    txt = json.dumps(result, ensure_ascii=False, indent=2)
    if a.out:
        open(a.out, "w", encoding="utf-8").write(txt)
        print("@@RESULT " + a.out)
        if result.get("headline"):
            print("@@HEADLINE " + result["headline"])
    else:
        print(txt)


if __name__ == "__main__":
    main()
