"""Exp 9 드나드나 — v2 결정론 필터 (LLM 판정 X). Exp 8 v2·ENA와 동일 5신호 AND."""
import csv
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

BASE = Path("D:/STEPD-experiments")
RES = BASE / "results"
ANALYSIS_DIR = BASE / "dna_longs_analysis"
REPORT_DIR = Path(r"C:\Users\STEPAI05\STEPD-repo\바우처_결과보고_2026\증빙_데이터셋\실험자료")

truth_bundle = json.load(open(RES / "exp9_dna_truth.json", encoding="utf-8"))
truth_pairs = truth_bundle["pairs"]
TRUTH_BY_LONG = {}
for p in truth_pairs:
    TRUTH_BY_LONG.setdefault(p["longVideoId"], []).append((float(p["segStart"]), float(p["segEnd"])))

RET = json.load(open(RES / "exp9_dna_retention.json", encoding="utf-8"))

GOOD_HOOKS = {"돌직구", "반전", "감정고조", "갈등", "웃음", "공감"}
IOU_MAX = 0.1
REL_MIN = 1.05
LEN_MIN, LEN_MAX = 30.0, 60.0
DENSITY_MIN = 3.0


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


def text_within(long_stt, st, en):
    total = 0
    for s in long_stt.get("segments", []):
        s_st = float(s.get("start", 0))
        s_en = float(s.get("end", 0))
        mid = (s_st + s_en) / 2
        if st <= mid <= en:
            total += len(s.get("text", ""))
    return total


long_data = {}
for lid_dir in ANALYSIS_DIR.iterdir():
    if not lid_dir.is_dir():
        continue
    lid = lid_dir.name
    try:
        analysis = json.load(open(lid_dir / "analysis.json", encoding="utf-8"))
        stt = json.load(open(lid_dir / "stt.json", encoding="utf-8"))
        long_data[lid] = {"analysis": analysis, "stt": stt}
    except FileNotFoundError:
        continue

print(f"롱폼 로드: {len(long_data)}편")

all_records = []
for lid, d in long_data.items():
    analysis = d["analysis"]
    stt = d["stt"]
    shorts = analysis.get("shorts", [])
    truth_segs = TRUTH_BY_LONG.get(lid, [])
    for p in shorts:
        st = float(p.get("start", 0))
        en = float(p.get("end", 0))
        length = en - st
        max_iou = max((iou((st, en), t) for t in truth_segs), default=0.0)
        avg, whole = seg_ret(lid, st, en)
        rel = (avg / whole) if whole > 0 else 0.0
        chars = text_within(stt, st, en)
        density = (chars / length) if length > 0 else 0.0

        pass_iou = max_iou <= IOU_MAX
        pass_ret = rel >= REL_MIN
        pass_len = LEN_MIN <= length <= LEN_MAX
        pass_dense = density >= DENSITY_MIN
        pass_hook = str(p.get("hook", "")).strip() in GOOD_HOOKS
        all_pass = pass_iou and pass_ret and pass_len and pass_dense and pass_hook

        all_records.append({
            "long": lid,
            "start": round(st, 1),
            "end": round(en, 1),
            "seg_len": round(length, 1),
            "title": p.get("title", ""),
            "hook": p.get("hook", ""),
            "appeal": p.get("appeal"),
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

all_records.sort(key=lambda r: (-int(r["all_pass"]), -r["rel_vs_whole"]))

print("\n=== Exp 9 드나드나 · 결정론 필터 (LLM 판정 X) ===\n")
print(f"전체 픽: {len(all_records)}개")
passes = {
    "IoU ≤ 0.1 (편집자 미발견)": sum(r["pass_iou_le_0.1"] for r in all_records),
    "리텐션 rel ≥ 1.05": sum(r["pass_ret_ge_1.05"] for r in all_records),
    "길이 30~60초": sum(r["pass_len_30_60"] for r in all_records),
    "텍스트 밀도 ≥ 3.0/s": sum(r["pass_density_ge_3"] for r in all_records),
    "훅 ∈ 학습 우수 카테고리": sum(r["pass_hook_learned"] for r in all_records),
}
for k, v in passes.items():
    pct = int(100 * v / max(1, len(all_records)))
    print(f"  {k}: {v}/{len(all_records)} ({pct}%)")

winners = [r for r in all_records if r["all_pass"]]
print(f"\n🎯 **5개 신호 전부 통과: {len(winners)}개** ({int(100*len(winners)/max(1,len(all_records)))}%)")
for i, r in enumerate(winners, 1):
    print(f"\n[{i}] {r['long']} @{r['start']:.0f}s-{r['end']:.0f}s ({r['seg_len']:.0f}s)")
    print(f"    제목: {r['title'][:60]}")
    print(f"    훅: {r['hook']} · rel {r['rel_vs_whole']}배 · 밀도 {r['text_density_chars_per_s']}자/s · IoU {r['max_iou_with_truth']}")

CSV_OUT = RES / "exp9_dna_deterministic_picks.csv"
if all_records:
    fields = list(all_records[0].keys())
    with open(CSV_OUT, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(all_records)
    print(f"\nCSV: {CSV_OUT} ({len(all_records)}행)")

JSON_OUT = RES / "exp9_dna_confirmed_gems.json"
json.dump(winners, open(JSON_OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"JSON: {JSON_OUT} ({len(winners)}개)")

if REPORT_DIR.exists():
    import shutil
    shutil.copy2(CSV_OUT, REPORT_DIR / CSV_OUT.name)
    shutil.copy2(JSON_OUT, REPORT_DIR / JSON_OUT.name)
    print(f"증빙 사본: {REPORT_DIR}")

# 3채널 대조
print("\n=== 3채널 v2 재현 대조 ===")
print(f"{'채널':<12} | {'전체픽':>6} | {'통과':>4} | {'통과율':>6}")
print(f"{'하하':<12} | {46:>6} | {8:>4} | {'17%':>6}")
print(f"{'ENA':<12} | {32:>6} | {9:>4} | {'28%':>6}")
print(f"{'드나드나':<10} | {len(all_records):>6} | {len(winners):>4} | {str(int(100*len(winners)/max(1,len(all_records))))+'%':>6}")
