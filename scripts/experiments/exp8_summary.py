"""Exp 8 요약 출력."""
import csv
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
DATA = Path(r"C:\Users\STEPAI05\STEPD-repo\바우처_결과보고_2026\증빙_데이터셋\실험자료")

csv_path = DATA / "exp8_missed_gems.csv"
top_path = DATA / "exp8_top_gems.json"

rows = list(csv.DictReader(open(csv_path, encoding="utf-8-sig")))
print(f"=== Exp 8 · 편집자 미발견 리텐션 인정 클립 발굴 ===")
print(f"편집자 미발견 후보 전체: {len(rows)}개")

# 롱폼별
by_long = {}
for r in rows:
    by_long.setdefault(r["long"], []).append(r)
for lid, arr in by_long.items():
    print(f"  {lid}: {len(arr)}개")

# 리텐션 인정
strong = [r for r in rows if float(r.get("rel_vs_whole", 0) or 0) >= 1.05]
print(f"\n리텐션 인정 (rel_vs_whole >= 1.05): {len(strong)}개")

# 판정 우수
top = [r for r in strong if r.get("judge_score") and int(r["judge_score"]) >= 4]
print(f"Gemini 판정 우수 (score >= 4): {len(top)}개")

if top:
    print(f"\n=== 우수 후보 상세 (score >= 4) ===")
    top.sort(key=lambda r: (-int(r["judge_score"]), -float(r.get("rel_vs_whole", 0))))
    for i, r in enumerate(top[:15], 1):
        print(f"\n{i}. [{r['long']}] @{float(r['start']):.0f}s-{float(r['end']):.0f}s ({float(r['end'])-float(r['start']):.0f}초)")
        print(f"   제목: {r['title'][:60]}")
        print(f"   훅: {r.get('hook','')} · 리텐션 rel {float(r.get('rel_vs_whole',0)):.2f}배 · Gemini {r['judge_score']}점")
        print(f"   판정: {r.get('judge_reason','')[:100]}")
        print(f"   대사: {r.get('text_snippet','')[:100]}")
