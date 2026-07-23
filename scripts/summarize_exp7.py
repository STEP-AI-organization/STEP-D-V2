"""Exp 7 결과 요약 — off / base / base+visual 3조건 대조."""
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

REPO = Path(r"C:\Users\STEPAI05\STEPD-repo")
DATA = REPO / "바우처_결과보고_2026" / "증빙_데이터셋" / "실험자료"

result = json.load(open(DATA / "exp7_visual_ab.json", encoding="utf-8"))

print("=" * 70)
print(f"Exp 7 · 시각훅 A/B 결과 (홀드아웃 {result['holdouts']}편 · 정답 {result['published_total']} · runs {result['runs']})")
print("=" * 70)

conds = [
    ("off (학습 없음)", result.get("profile_off")),
    ("base (기존 학습 규칙)", result.get("profile_a")),
    ("base+시각훅 (Exp 5 반영)", result.get("profile_b")),
]

print(f"\n{'조건':<32} {'Topic@5':>12} {'Topic@10':>12} {'Topic@20':>12}")
print("-" * 70)
for label, d in conds:
    if d is None:
        continue
    def fmt(n):
        m, s = d[n]["mean"], d[n]["stdev"]
        return f"{m:.3f}±{s:.2f}"
    print(f"{label:<32} {fmt(5):>12} {fmt(10):>12} {fmt(20):>12}")

print()
print("퍼-런 상세 (변동성 확인):")
for label, d in conds:
    if d is None:
        continue
    print(f"  {label}: @10 per_run = {d[10]['per_run']}")

print()
print("HEADLINE:", result.get("headline", ""))

# 반전/개선 판정
off = result.get("profile_off")
base = result.get("profile_a")
vis = result.get("profile_b")
if off and base and vis:
    b10 = base[10]["mean"]
    v10 = vis[10]["mean"]
    o10 = off[10]["mean"]
    print()
    print("=== 판정 (Topic-Hit@10) ===")
    print(f"  base → base+visual: {b10:.3f} → {v10:.3f} (diff {(v10-b10)*100:+.1f}%p, 상대 {(v10/b10-1)*100 if b10>0 else 0:+.1f}%)")
    print(f"  off → base+visual: {o10:.3f} → {v10:.3f} (diff {(v10-o10)*100:+.1f}%p)")
    if v10 > b10 and (v10 - b10) > base[10]["stdev"]:
        print("  ✅ 시각훅 프로파일이 base 대비 σ 밖 개선 — 통계 확정")
    elif v10 > b10:
        print("  ⚠️  base 대비 개선이나 σ 안, 통계 미확정")
    else:
        print("  ❌ base 대비 개선 없음 or 악화")
