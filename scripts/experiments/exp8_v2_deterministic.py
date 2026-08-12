"""Exp 8 v2 — LLM 판정 제거 · 순수 실측·규칙 필터.

사용자 방법론 지적 반영: 1~5 LLM score는 통계적으로 취약 (5단계 이산·프롬프트 흔들림·중상단 편향).
전면 제거하고 **재현 가능한 결정론적 신호**만 사용.

필터 파이프라인 (모두 실측 or 산술, LLM 판정 X):
  1) IoU ≤ 0.1 (편집자 미발견)                        - 산술
  2) rel_vs_whole ≥ 1.05 (리텐션 유지율 실측 인정)     - 실측
  3) seg_len ∈ [30, 60]s (플랫폼 최적 길이)            - 산술
  4) 텍스트 밀도 ≥ 3.0 chars/s (침묵 아님 · 대사 있음) - 실측
  5) hook ∈ 학습된 우수 훅 카테고리 (Exp 2 실증)       - 태그 규칙

각 후보에 4개 통과 지표(부울) + 4개 실측 값 기록.
최종 통과 = 4개 모두 True. rel 순 정렬.
"""
import csv
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

DATA = Path(r"C:\Users\STEPAI05\STEPD-repo\바우처_결과보고_2026\증빙_데이터셋\실험자료")
PICKS = json.load(open("C:/tmp/exp8_picks.json", encoding="utf-8"))
RET = json.load(open("C:/tmp/exp8_retention.json", encoding="utf-8"))

# Exp 2·3에서 실증된 하하 채널 상위 훅 (hookWeights > 1.0)
GOOD_HOOKS = {"돌직구", "반전", "감정고조", "갈등", "웃음", "공감"}

# 규칙 임계
IOU_MAX = 0.1
REL_MIN = 1.05
LEN_MIN, LEN_MAX = 30.0, 60.0
TEXT_DENSITY_MIN = 3.0  # chars/second


def iou(a, b):
    inter = max(0.0, min(a[1], b[1]) - max(a[0], b[0]))
    if inter <= 0:
        return 0.0
    uni = (a[1] - a[0]) + (b[1] - b[0]) - inter
    return inter / uni if uni > 0 else 0.0


def seg_ret(longid, st, en):
    r = RET.get(longid)
    if not r:
        return (0.0, 0.0)
    curve, dur = r["curve"], r["dur"]
    pts = [float(p["watchRatio"]) for p in curve if st <= float(p["ratio"]) * dur <= en]
    if not pts:
        return (0.0, 0.0)
    avg = sum(pts) / len(pts)
    whole = sum(float(p["watchRatio"]) for p in curve) / len(curve)
    return (avg, whole)


all_records = []
for longid, data in PICKS.items():
    long_dur = data["long_dur"]
    for p in data["picks"]:
        st, en = float(p["start"]), float(p["end"])
        length = en - st
        max_iou = float(p["max_iou_with_truth"])
        # 리텐션 계산
        avg, whole = seg_ret(longid, st, en)
        rel = (avg / whole) if whole > 0 else 0.0
        # 텍스트 밀도 (chars/s)
        snip = p.get("text_snippet") or ""
        density = (len(snip) / length) if length > 0 else 0.0

        pass_iou = max_iou <= IOU_MAX
        pass_ret = rel >= REL_MIN
        pass_len = LEN_MIN <= length <= LEN_MAX
        pass_dense = density >= TEXT_DENSITY_MIN
        pass_hook = str(p.get("hook", "")).strip() in GOOD_HOOKS
        all_pass = pass_iou and pass_ret and pass_len and pass_dense and pass_hook

        all_records.append({
            "long": longid,
            "start": st,
            "end": en,
            "seg_len": round(length, 1),
            "title": p.get("title", ""),
            "hook": p.get("hook", ""),
            "appeal": p.get("appeal"),
            "text_snippet": snip[:200],
            "max_iou_with_truth": round(max_iou, 3),
            "seg_avg_watch": round(avg, 3),
            "whole_avg_watch": round(whole, 3),
            "rel_vs_whole": round(rel, 2),
            "text_density_chars_per_s": round(density, 2),
            "pass_iou_le_0.1": pass_iou,
            "pass_ret_ge_1.05": pass_ret,
            "pass_len_30_60": pass_len,
            "pass_density_ge_3": pass_dense,
            "pass_hook_learned": pass_hook,
            "all_pass": all_pass,
        })

# 정렬: all_pass 우선, 그 다음 rel 내림차순
all_records.sort(key=lambda r: (-int(r["all_pass"]), -r["rel_vs_whole"]))

# 통계
print("=== Exp 8 v2 · 결정론적 필터 (LLM 판정 제거) ===\n")
print(f"전체 픽: {len(all_records)}개")
passes = {
    "IoU ≤ 0.1 (편집자 미발견)": sum(r["pass_iou_le_0.1"] for r in all_records),
    "리텐션 rel ≥ 1.05": sum(r["pass_ret_ge_1.05"] for r in all_records),
    "길이 30~60초": sum(r["pass_len_30_60"] for r in all_records),
    "텍스트 밀도 ≥ 3.0/s": sum(r["pass_density_ge_3"] for r in all_records),
    "훅 ∈ 학습 우수 카테고리": sum(r["pass_hook_learned"] for r in all_records),
}
for k, v in passes.items():
    print(f"  {k}: {v}/{len(all_records)}")

winners = [r for r in all_records if r["all_pass"]]
print(f"\n🎯 **5개 신호 전부 통과: {len(winners)}개**")
for i, r in enumerate(winners, 1):
    print(f"\n[{i}] {r['long']} @{r['start']:.0f}s-{r['end']:.0f}s ({r['seg_len']:.0f}s)")
    print(f"    제목: {r['title'][:60]}")
    print(f"    훅: {r['hook']} · rel {r['rel_vs_whole']}배 · 밀도 {r['text_density_chars_per_s']}자/s · IoU {r['max_iou_with_truth']}")

# CSV
CSV_OUT = DATA / "exp8_v2_deterministic_gems.csv"
fields = list(all_records[0].keys()) if all_records else []
with open(CSV_OUT, "w", newline="", encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=fields)
    w.writeheader()
    w.writerows(all_records)
print(f"\nCSV 저장: {CSV_OUT} ({len(all_records)}행)")

# 최종 인정 JSON
JSON_OUT = DATA / "exp8_v2_confirmed_gems.json"
json.dump(winners, open(JSON_OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"인정 JSON: {JSON_OUT} ({len(winners)}개)")
