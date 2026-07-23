"""Exp 10 B안 검증 — 시청자 지목 픽 후보에 v2 5신호 적용.

MjWwq8bBwJE의 시청자 명시 시간 4개를 픽 후보로 삼고 v2 필터 통과 여부 실측.
효과: 우리 파이프라인이 놓친 시청자 반응 순간 중 실제 히든젬 몇 개인가.
"""
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

BASE = Path("D:/STEPD-experiments")
RES = BASE / "results"
REPORT_DIR = Path(r"C:\Users\STEPAI05\STEPD-repo\바우처_결과보고_2026\증빙_데이터셋\실험자료")

viewer_cands = json.load(open(RES / "exp10_viewer_pick_candidates.json", encoding="utf-8"))

# 리텐션 커브 (ENA·하하 이미 로컬 있음)
ret_ena = json.load(open(RES / "exp9_ena_retention.json", encoding="utf-8"))
ret_dna = json.load(open(RES / "exp9_dna_retention.json", encoding="utf-8"))
# 하하 리텐션은 하하 exp8_retention.json 있음
haha_ret_path = REPORT_DIR / "exp8_retention.json"
ret_haha = json.load(open(haha_ret_path, encoding="utf-8")) if haha_ret_path.exists() else {}

RET = {**ret_haha, **ret_ena, **ret_dna}

# STT (밀도 계산용)
STT = {}
for lid in list(RET.keys()):
    # ENA
    for base_dir in ("ena_longs_analysis", "dna_longs_analysis"):
        p = BASE / base_dir / lid / "stt.json"
        if p.exists():
            STT[lid] = json.load(open(p, encoding="utf-8"))
            break

# 하하 STT는 원본 exp8_picks.json에서 text_snippet 재활용 안 됨, 로컬에 없음
# → 하하는 밀도 대략 스킵 (STT 없으면 판정 부분 관대)

# Exp 8 v2 하하 winners 픽 범위 (겹침 체크용)
HAHA_V2 = {
    "LcMolKaPcrw": [(0, 57)],
    "NtXLj7xOeE8": [(90, 126), (360, 412), (430, 480), (737, 770)],
    "JppILjNTCok": [(990, 1026), (1150, 1206), (1350, 1404)],
}
# Exp 9 ENA winners
ENA_V2 = {}
for w in json.load(open(REPORT_DIR / "exp9_ena_confirmed_gems.json", encoding="utf-8")):
    ENA_V2.setdefault(w["long"], []).append((w["start"], w["end"]))

V2_BY_LONG = {**HAHA_V2, **ENA_V2}

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


def seg_ret(lid, st, en):
    r = RET.get(lid)
    if not r:
        return (0.0, 0.0)
    curve = r["curve"]; dur = r["dur"]
    pts = [float(p["watchRatio"]) for p in curve if st <= float(p["ratio"]) * dur <= en]
    if not pts:
        return (0.0, 0.0)
    avg = sum(pts) / len(pts)
    whole = sum(float(p["watchRatio"]) for p in curve) / len(curve)
    return (avg, whole)


def text_within(lid, st, en):
    s = STT.get(lid)
    if not s:
        return 0
    total = 0
    for seg in s.get("segments", []):
        s_st = float(seg.get("start", 0)); s_en = float(seg.get("end", 0))
        mid = (s_st + s_en) / 2
        if st <= mid <= en:
            total += len(seg.get("text", ""))
    return total


def check_candidate(lid, sec, likes, raw, text_ctx):
    """시청자 지목 시간(sec)을 (sec-5, sec+55) 픽 후보로 만들고 v2 5신호 판정."""
    st = max(0, sec - 5)
    en = sec + 55
    length = en - st
    # 우리 v2 winners와 IoU (편집자=우리 파이프라인이라 취급, 다른 승자와 겹치면 miss가 덜 흥미)
    ours = V2_BY_LONG.get(lid, [])
    max_iou = max((iou((st, en), t) for t in ours), default=0.0)
    avg, whole = seg_ret(lid, st, en)
    rel = (avg / whole) if whole > 0 else 0.0
    chars = text_within(lid, st, en)
    density = (chars / length) if length > 0 else 0.0
    # hook 없음 (댓글 신호에는 hook 없음)
    # → 규칙: pass_hook은 skip. 4신호(IoU·리텐션·길이·밀도)로만 판정
    pass_iou = max_iou <= IOU_MAX
    pass_ret = rel >= REL_MIN
    pass_len = LEN_MIN <= length <= LEN_MAX
    pass_dense = density >= DENSITY_MIN
    # hook 신호는 후보 자체 hook 없어 skip (사람이 나중에 확인)
    return {
        "long": lid, "sec": sec, "start": st, "end": en, "seg_len": length,
        "likes": likes, "raw": raw, "text": text_ctx[:150],
        "max_iou_with_ours": round(max_iou, 3),
        "rel_vs_whole": round(rel, 2),
        "text_density": round(density, 2),
        "pass_iou_le_0.1": pass_iou,
        "pass_ret_ge_1.05": pass_ret,
        "pass_len_30_60": pass_len,
        "pass_density_ge_3": pass_dense,
        "n_passed_4signals": sum([pass_iou, pass_ret, pass_len, pass_dense]),
    }


# === 시청자 지목 후보 전부 판정 ===
results = []
for lid, d in viewer_cands.items():
    ch = d["channel"]
    for cand in d["candidates"]:
        # cand.raw 원 시간 표기 → sec 다시 파싱 (start-5로 저장돼있으니 +5)
        sec = cand["start"] + 5
        r = check_candidate(lid, sec, cand["likes"], cand["raw"], cand["text"])
        r["channel"] = ch
        r["source"] = "viewer_hint"
        results.append(r)

results.sort(key=lambda r: (-r["n_passed_4signals"], -r["rel_vs_whole"]))

print("=== 시청자 지목 픽 후보 · v2 4신호 판정 ===\n")
print(f"전체 시청자 지목 후보: {len(results)}개\n")

# 4신호 전부 통과 (진짜 히든젬)
winners = [r for r in results if r["n_passed_4signals"] == 4]
partial = [r for r in results if 2 <= r["n_passed_4signals"] < 4]
fail = [r for r in results if r["n_passed_4signals"] < 2]

print(f"🎯 4신호 전부 통과: {len(winners)}개")
print(f"⚠️ 부분 통과 (2~3신호): {len(partial)}개")
print(f"❌ 미통과 (0~1신호): {len(fail)}개\n")

# 강조 · MjWwq8bBwJE
print("=== 특히 · ENA MjWwq8bBwJE (우리 파이프라인이 놓친 시청자 지목 4개) ===")
mjw = [r for r in results if r["long"] == "MjWwq8bBwJE"]
for r in mjw:
    ok_marks = []
    ok_marks.append("✅IoU" if r["pass_iou_le_0.1"] else "❌IoU")
    ok_marks.append("✅rel" if r["pass_ret_ge_1.05"] else "❌rel")
    ok_marks.append("✅len" if r["pass_len_30_60"] else "❌len")
    ok_marks.append("✅density" if r["pass_density_ge_3"] else "❌density")
    m, s = divmod(r["sec"], 60)
    print(f"\n  [{r['likes']}❤] {m}:{s:02d} '{r['raw']}'")
    print(f"     맥락: {r['text'][:80]}")
    print(f"     신호: {' · '.join(ok_marks)}")
    print(f"     rel={r['rel_vs_whole']} · 밀도={r['text_density']}자/s · IoU={r['max_iou_with_ours']} · 길이={r['seg_len']:.0f}s")
    print(f"     → {r['n_passed_4signals']}/4 통과 {'🎯 확정 히든젬' if r['n_passed_4signals']==4 else ''}")

print("\n\n=== 전체 4신호 통과 winner 목록 ===")
for w in winners:
    m, s = divmod(w["sec"], 60)
    print(f"[{w['channel']}/{w['long']}] {m}:{s:02d} [{w['likes']}❤]")
    print(f"  '{w['text'][:100]}'")
    print(f"  rel={w['rel_vs_whole']} · 밀도={w['text_density']}자/s")

json.dump(results, open(RES / "exp10_viewer_pick_v2check.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
import shutil
shutil.copy2(RES / "exp10_viewer_pick_v2check.json", REPORT_DIR / "exp10_viewer_pick_v2check.json")
print(f"\n저장: {RES / 'exp10_viewer_pick_v2check.json'}")
