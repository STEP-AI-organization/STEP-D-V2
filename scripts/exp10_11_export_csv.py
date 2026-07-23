"""Exp 10·11 댓글 데이터 CSV 보존.

산출 CSV (증빙_데이터셋/실험자료/):
  1) 댓글원본_Exp10_15롱폼.csv        (1500 rows) — 원본 댓글
  2) 댓글Gemini추출_Exp10_15롱폼.csv  (1500 rows) — 8필드 분류
  3) 댓글원본_Exp11_하하과거8편.csv    (~400 rows) — 프로파일 학습 원본
  4) 댓글Gemini추출_Exp11_하하과거8편.csv (~350 rows) — 학습용 추출
  5) 시청자지목시간_Exp10B안.csv       (12 rows) — explicit timestamps
  6) v2winner_시청자매칭_Exp10.5.csv   (26 rows) — winner vs voice
"""
import csv
import json
import re
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

BASE = Path("D:/STEPD-experiments")
RES = BASE / "results"
REPORT = Path(r"C:\Users\STEPAI05\STEPD-repo\바우처_결과보고_2026\증빙_데이터셋\실험자료")

CH_MAP = {
    "LcMolKaPcrw": "하하", "NtXLj7xOeE8": "하하", "JppILjNTCok": "하하",
    "dnIaj6L3t1E": "ENA", "DPclbGO1F9g": "ENA", "Lj_tFgRqqEI": "ENA", "MjWwq8bBwJE": "ENA", "QNtoQ4zI8mc": "ENA",
    "rhX9po-DBZI": "드나드나", "NUM1zfQujWY": "드나드나", "OuvpspSaAUQ": "드나드나",
    "k8BHuiKF0rk": "드나드나", "ALuFb_TqHPU": "드나드나", "a9O8d0zLfTg": "드나드나", "sT9KQTLg2Cs": "드나드나",
}


def sanitize(text: str) -> str:
    """CSV 안전 · 줄바꿈 · 탭 → 공백 · 컬럼 폭 유지"""
    if not text:
        return ""
    return re.sub(r'[\r\n\t]+', ' ', text).strip()


# ─────────────────────────────────────────────────────────
# 1) 댓글원본_Exp10_15롱폼.csv
# ─────────────────────────────────────────────────────────
print("[1] Exp 10 원본 댓글 CSV 생성…")
comments = json.load(open(RES / "exp10_all_comments.json", encoding="utf-8"))
rows = []
for lid, items in comments.items():
    for i, c in enumerate(items):
        rows.append({
            "channel": CH_MAP.get(lid, "?"),
            "longVideoId": lid,
            "comment_idx": i,
            "likes": c.get("likes", 0),
            "is_pinned": c.get("is_pinned", False),
            "text": sanitize(c.get("text", "")),
        })
out1 = REPORT / "댓글원본_Exp10_15롱폼.csv"
with open(out1, "w", newline="", encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=["channel", "longVideoId", "comment_idx", "likes", "is_pinned", "text"])
    w.writeheader()
    w.writerows(rows)
print(f"  → {out1.name} ({len(rows)} rows)")


# ─────────────────────────────────────────────────────────
# 2) 댓글Gemini추출_Exp10_15롱폼.csv
# ─────────────────────────────────────────────────────────
print("\n[2] Exp 10 Gemini 8필드 추출 CSV 생성…")
extracted = json.load(open(RES / "exp10_all_extracted.json", encoding="utf-8"))
rows = []
for lid, items in extracted.items():
    for x in items:
        rows.append({
            "channel": CH_MAP.get(lid, "?"),
            "longVideoId": lid,
            "comment_idx": x.get("idx"),
            "likes": x.get("likes", 0),
            "text": sanitize(x.get("text", "")),
            "moment_ref": x.get("moment_ref"),
            "moment_hint": sanitize(x.get("moment_hint", "")),
            "emotion": x.get("emotion", ""),
            "quote_ref": x.get("quote_ref"),
            "demand": x.get("demand"),
            "demand_text": sanitize(x.get("demand_text", "")),
            "sentiment": x.get("sentiment", ""),
        })
out2 = REPORT / "댓글Gemini추출_Exp10_15롱폼.csv"
with open(out2, "w", newline="", encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)
print(f"  → {out2.name} ({len(rows)} rows)")


# ─────────────────────────────────────────────────────────
# 3) 댓글원본_Exp11_하하과거8편.csv
# ─────────────────────────────────────────────────────────
print("\n[3] Exp 11 원본 댓글 CSV 생성 (하하 과거 8편)…")
per_long_dir = RES / "exp11_per_long"
exp11_lids = ["jIln8ZrGmZo", "Q_ykKveo2vQ", "qaR20yPyWsE", "OM1w-8sHRE0",
              "6zT46PSP950", "-EK8NWSRoUA", "RjQV-MAefZE"]
long_titles = {}
rows = []
for lid in exp11_lids:
    p = per_long_dir / f"{lid}.json"
    if not p.exists():
        print(f"  · {lid} skip (파일 없음)")
        continue
    d = json.load(open(p, encoding="utf-8"))
    long_titles[lid] = d.get("title", "")
    for x in d.get("extracted", []):
        rows.append({
            "channel": "하하",
            "longVideoId": lid,
            "long_title": sanitize(d.get("title", "")),
            "comment_idx": x.get("idx"),
            "likes": x.get("likes", 0),
            "text": sanitize(x.get("text", "")),
        })
out3 = REPORT / "댓글원본_Exp11_하하과거8편.csv"
with open(out3, "w", newline="", encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)
print(f"  → {out3.name} ({len(rows)} rows · 롱폼 {len(long_titles)}편)")


# ─────────────────────────────────────────────────────────
# 4) 댓글Gemini추출_Exp11_하하과거8편.csv
# ─────────────────────────────────────────────────────────
print("\n[4] Exp 11 Gemini 추출 CSV 생성…")
rows = []
for lid in exp11_lids:
    p = per_long_dir / f"{lid}.json"
    if not p.exists():
        continue
    d = json.load(open(p, encoding="utf-8"))
    for x in d.get("extracted", []):
        rows.append({
            "channel": "하하",
            "longVideoId": lid,
            "long_title": sanitize(d.get("title", "")),
            "comment_idx": x.get("idx"),
            "likes": x.get("likes", 0),
            "text": sanitize(x.get("text", "")),
            "moment_ref": x.get("moment_ref"),
            "moment_type": x.get("moment_type", ""),
            "emotion": x.get("emotion", ""),
            "quote_ref": x.get("quote_ref"),
            "demand": x.get("demand"),
            "demand_category": x.get("demand_category", ""),
            "sentiment": x.get("sentiment", ""),
        })
out4 = REPORT / "댓글Gemini추출_Exp11_하하과거8편.csv"
with open(out4, "w", newline="", encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)
print(f"  → {out4.name} ({len(rows)} rows)")


# ─────────────────────────────────────────────────────────
# 5) 시청자지목시간_Exp10B안.csv
# ─────────────────────────────────────────────────────────
print("\n[5] Exp 10 B안 explicit timestamps CSV 생성…")
ts = json.load(open(RES / "exp10_timestamps.json", encoding="utf-8"))
rows = []
for lid, d in ts.items():
    for h in d.get("hits", []):
        rows.append({
            "channel": d.get("channel", "?"),
            "longVideoId": lid,
            "sec": h.get("sec"),
            "mmss": f"{h.get('sec',0)//60}:{h.get('sec',0)%60:02d}",
            "raw_time_notation": h.get("raw", ""),
            "likes": h.get("likes", 0),
            "context_text": sanitize(h.get("text", "")),
        })
rows.sort(key=lambda r: -r["likes"])
out5 = REPORT / "시청자지목시간_Exp10B안.csv"
with open(out5, "w", newline="", encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)
print(f"  → {out5.name} ({len(rows)} rows)")


# ─────────────────────────────────────────────────────────
# 6) v2winner_시청자매칭_Exp10.5.csv
# ─────────────────────────────────────────────────────────
print("\n[6] Exp 10.5 winner 매칭 판정 CSV 생성…")
wvm = json.load(open(REPORT / "exp105_winner_voice_match.json", encoding="utf-8"))
rows = []
for ch, items in wvm.items():
    for x in items:
        rows.append({
            "channel": ch,
            "winner_idx": x.get("winner_idx"),
            "longVideoId": x.get("long"),
            "title": sanitize(x.get("title", "")),
            "hook": x.get("hook"),
            "matched": x.get("matched"),
            "best_viewer_hint": sanitize(x.get("best_hint") or "" or ""),
            "hint_likes": x.get("best_hint_likes"),
            "reasoning": sanitize(x.get("reasoning") or ""),
        })
out6 = REPORT / "v2winner_시청자매칭_Exp10.5.csv"
with open(out6, "w", newline="", encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)
print(f"  → {out6.name} ({len(rows)} rows)")


# ─────────────────────────────────────────────────────────
# 요약
# ─────────────────────────────────────────────────────────
print("\n=== 총 6개 CSV 생성 완료 ===")
print(f"위치: {REPORT}")
for out in [out1, out2, out3, out4, out5, out6]:
    size_kb = out.stat().st_size / 1024
    print(f"  · {out.name} ({size_kb:.0f} KB)")
