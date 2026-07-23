"""Exp 8 — 편집자 미발견 · 리텐션 인정 클립 발굴.

파이프라인:
1) 3홀드아웃 각각에 recommend(n=20, profile=None) → top-20 픽 (60개)
2) 편집자 정답지(발행 숏폼)와 IoU 계산 → IoU ≤ 0.1인 픽만 남김 (편집자 미발견)
3) 롱폼 리텐션 커브(Exp 6 DB)와 조인 → 픽 구간 평균 유지율 산출
4) 롱폼 평균 대비 rel_vs_whole ≥ 1.1 (10%+ 더 잘 본 구간)만 남김
5) Gemini judge에 재판정 요청 → 점수 4+ 후보 정리
6) CSV 저장 + 상위 mp4 트림 준비 (별도)

산출: exp8_missed_gems.csv (전 후보) + exp8_top_gems.json (final)
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.stdout.reconfigure(encoding="utf-8") if hasattr(sys.stdout, "reconfigure") else None

from core.recommend import recommend  # type: ignore
from google import genai  # type: ignore
from google.genai import types  # type: ignore


DATA = Path(r"C:\Users\STEPAI05\STEPD-repo\바우처_결과보고_2026\증빙_데이터셋\실험자료")
OUT_CSV = DATA / "exp8_missed_gems.csv"
OUT_TOP = DATA / "exp8_top_gems.json"

HOLDOUTS = {
    "JppILjNTCok": "/tmp/ho5_coarse.json",  # 원정대5 · 61분 · 정답 18
    "NtXLj7xOeE8": "/tmp/ho4_coarse.json",  # 원정대4 · 35분 · 정답 5
    "LcMolKaPcrw": "/tmp/ho_coarse.json",   # 경주 PC방 · 13분 · 정답 3
}
TRUTH_PATH = "/tmp/truth_all.json"


def iou(a: tuple[float, float], b: tuple[float, float]) -> float:
    inter = max(0.0, min(a[1], b[1]) - max(a[0], b[0]))
    if inter <= 0:
        return 0.0
    uni = (a[1] - a[0]) + (b[1] - b[0]) - inter
    return inter / uni if uni > 0 else 0.0


def published_ranges(export: dict, longid: str) -> list[dict[str, Any]]:
    out = []
    pairs = export.get("pairs") if isinstance(export, dict) else export
    for p in pairs or []:
        src = p.get("source") or {}
        if src.get("longVideoId") != longid:
            continue
        seg = src.get("segStart"), src.get("segEnd")
        if seg[0] is None or seg[1] is None:
            continue
        out.append({
            "seg": (float(seg[0]), float(seg[1])),
            "title": (p.get("short") or {}).get("title") or "",
            "views": (p.get("short") or {}).get("views") or 0,
            "tier": (p.get("performance") or {}).get("tier") or "",
        })
    return out


def load_retention_from_json(path: Path) -> dict[str, list[dict]]:
    """exp6_retention_join.json이 아니라, 원본 curve가 필요.
    대신 exp6_retention_join.json에서 whole_avg_watch만 뽑고, 각 롱폼의 curve는 DB 조회.
    여기선 간단하게: exp8은 리텐션을 직접 DB에서 가져와야 함. 하지만 시간 절약 위해
    exp6_retention_join.json으로부터 각 롱폼의 whole_avg_watch만 계산.
    실제 픽 구간 유지율은 DB curve 없이는 못 뽑음 → 이 스크립트는 DB 재조회 필요.
    → 별도 스텝(scripts/exp8_retention_join.cjs)에서 DB 조회 후 파일로 저장.
    """
    return {}


def call_gemini_judge(client, program_context: str, pick: dict) -> dict:
    """엔진 픽 하나를 그 채널 프로파일에 비추어 1~5로 재판정. 정답 정보 노출 X."""
    prompt = f"""너는 유튜브 숏폼 편집자다. 아래 롱폼 구간을 이 채널이 숏폼으로 발행한다고 가정하고 판단하라.

[채널 특성]
{program_context}

[해당 구간 정보]
- 시작·끝: {pick['start']:.1f}s ~ {pick['end']:.1f}s (총 {pick['end']-pick['start']:.0f}초)
- 엔진 픽 제목: {pick.get('title', '')}
- 이유: {pick.get('reason', '')[:200]}
- 대사 발췌: {pick.get('text_snippet', '')[:250]}

[요청]
1) 이 구간을 이 채널이 숏폼으로 뽑을 만한가? 1(비추천) ~ 5(확실히 터진다) 로 판정.
2) 이유를 한 줄로.

JSON만: {{"score": 4, "reason": "..."}}"""
    resp = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=prompt,
        config=types.GenerateContentConfig(
            temperature=0,
            response_mime_type="application/json",
            response_schema={
                "type": "OBJECT",
                "properties": {"score": {"type": "INTEGER"}, "reason": {"type": "STRING"}},
                "required": ["score", "reason"],
            },
        ),
    )
    return json.loads(resp.text)


def get_text_snippet(scenes: list[dict], start: float, end: float) -> str:
    parts = [str(s.get("text") or "") for s in scenes
             if float(s.get("end", 0)) > start and float(s.get("start", 0)) < end]
    return " ".join(p for p in parts if p.strip())[:300]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", choices=["pick", "judge"], required=True)
    ap.add_argument("--picks-out", default="/tmp/exp8_picks.json")
    ap.add_argument("--retention", help="DB에서 뽑은 롱폼 curve JSON", default="/tmp/exp8_retention.json")
    ap.add_argument("--judge-out", default=str(OUT_TOP))
    ap.add_argument("--gems-csv", default=str(OUT_CSV))
    ap.add_argument("--min-rel", type=float, default=1.05, help="롱폼 평균 대비 유지율 최소 배수")
    ap.add_argument("--iou-max", type=float, default=0.1, help="편집자 정답과의 최대 IoU")
    a = ap.parse_args()

    truth = json.load(open(TRUTH_PATH, encoding="utf-8"))

    if a.stage == "pick":
        # 3홀드아웃 각각 top-20 픽
        result: dict[str, dict] = {}
        for longid, path in HOLDOUTS.items():
            sc = json.load(open(path, encoding="utf-8"))
            if isinstance(sc, dict):
                sc = sc.get("scenes", sc)
            print(f"\n=== {longid} ({path}) ===")
            print(f"장면 {len(sc)}개, 총 길이 {sc[-1]['end']:.0f}s")
            res = recommend(sc, n=20, genre="variety", profile=None)
            shorts = res.get("shorts", [])
            print(f"픽 {len(shorts)}개")
            # 편집자 정답 구간
            pub = published_ranges(truth, longid)
            print(f"편집자 정답 {len(pub)}개")
            # 각 픽에 IoU 최대값 계산
            enriched = []
            for s in shorts:
                st, en = float(s.get("start", 0)), float(s.get("end", 0))
                pick_seg = (st, en)
                ious = [(iou(pick_seg, p["seg"]), p) for p in pub]
                max_iou, best_pub = (max(ious, key=lambda x: x[0]) if ious else (0.0, None))
                enriched.append({
                    "rank": s.get("rank"),
                    "start": st,
                    "end": en,
                    "title": s.get("title", ""),
                    "reason": s.get("reason", ""),
                    "hook": s.get("hook", ""),
                    "appeal": s.get("appeal"),
                    "final_score": s.get("final_score"),
                    "max_iou_with_truth": round(max_iou, 3),
                    "text_snippet": get_text_snippet(sc, st, en),
                })
            result[longid] = {"picks": enriched, "long_dur": sc[-1]["end"]}
        json.dump(result, open(a.picks_out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print(f"\n저장: {a.picks_out}")
        return

    # judge stage
    picks = json.load(open(a.picks_out, encoding="utf-8"))
    retention = json.load(open(a.retention, encoding="utf-8"))  # {longid: {curve: [...], dur: X}}

    # 1) IoU 필터
    candidates = []  # 편집자 미발견
    for longid, data in picks.items():
        dur = data["long_dur"]
        for p in data["picks"]:
            if p["max_iou_with_truth"] <= a.iou_max:
                candidates.append({**p, "long": longid, "long_dur": dur})
    print(f"편집자 미발견 후보 (IoU<={a.iou_max}): {len(candidates)}개")

    # 2) 리텐션 조인
    def seg_ret(longid: str, st: float, en: float) -> tuple[float, float]:
        r = retention.get(longid)
        if not r:
            return (0.0, 0.0)
        curve = r["curve"]
        dur = r["dur"]
        pts = [float(p["watchRatio"]) for p in curve
               if st <= float(p["ratio"]) * dur <= en]
        if not pts:
            return (0.0, 0.0)
        avg = sum(pts) / len(pts)
        whole = sum(float(p["watchRatio"]) for p in curve) / len(curve)
        return (avg, whole)

    for c in candidates:
        avg, whole = seg_ret(c["long"], c["start"], c["end"])
        c["seg_avg_watch"] = round(avg, 3)
        c["whole_avg_watch"] = round(whole, 3)
        c["rel_vs_whole"] = round(avg / whole, 2) if whole > 0 else 0.0

    # 3) rel_vs_whole 필터
    strong = [c for c in candidates if c["rel_vs_whole"] >= a.min_rel]
    print(f"리텐션 인정 후보 (rel_vs_whole >= {a.min_rel}): {len(strong)}개")

    # 4) Gemini judge
    client = genai.Client(vertexai=True, project=os.environ.get("GOOGLE_CLOUD_PROJECT", "step-d"),
                          location=os.environ.get("VERTEX_LOCATION", "asia-northeast3"))
    program_ctx = ("하하PD 채널 — 예능/토크. 이 채널이 잘 뽑아온 순간: "
                   "돌직구·솔직한 발언, 초반 기대와 다른 반전, 통념 깨는 소신 발언. "
                   "리액션 표정·화면 텍스트가 살아있는 오프닝 우대. 잔잔한 상황설정 회피.")
    for i, c in enumerate(strong, 1):
        try:
            j = call_gemini_judge(client, program_ctx, c)
            c["judge_score"] = j.get("score")
            c["judge_reason"] = j.get("reason", "")[:200]
        except Exception as e:
            c["judge_score"] = None
            c["judge_reason"] = f"error: {str(e)[:80]}"
        print(f"[{i}/{len(strong)}] {c['long']} @{c['start']:.0f}s → score {c.get('judge_score')} · {c.get('title','')[:40]}")

    # 5) 저장 (전체 후보 CSV + 상위 판정 JSON)
    fields = ["long", "start", "end", "title", "hook", "appeal", "max_iou_with_truth",
              "seg_avg_watch", "whole_avg_watch", "rel_vs_whole", "judge_score", "judge_reason",
              "reason", "text_snippet"]
    all_records = candidates  # 전체 (필터 전) CSV로
    for c in all_records:
        c.setdefault("judge_score", "")
        c.setdefault("judge_reason", "")
    with open(a.gems_csv, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(all_records)
    print(f"\nCSV 저장: {a.gems_csv} ({len(all_records)}행 - 편집자 미발견 후보 전체)")

    top = sorted([c for c in strong if isinstance(c.get("judge_score"), int) and c["judge_score"] >= 4],
                 key=lambda x: (-x["judge_score"], -x["rel_vs_whole"]))
    json.dump(top, open(a.judge_out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"상위 판정 (score>=4): {len(top)}개 → {a.judge_out}")


if __name__ == "__main__":
    main()
