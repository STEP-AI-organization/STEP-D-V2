"""
Alignment 정확도 audit — Gemini 텍스트 vs 매칭된 whisper words가 실제 같은 대사인지 확인.

측정 지표:
- 정확: word concat이 Gemini 텍스트와 90%+ 유사 (difflib SequenceMatcher, 공백·구두점 무시)
- 오배정: 유사도 <60% — 다른 대사가 붙었을 가능성
- 팽창: matched_chars / gemini_chars 비율 (>2.0이면 word 범위 너무 넓음)
- 중복: seg[i].start == seg[j].start (동일 시각에 두 세그)
"""
import json
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path


def norm(s: str) -> str:
    return re.sub(r"[\s\.,\?!\-…·'\"]+", "", (s or "")).lower()


def audit(path: str) -> None:
    raw = Path(path).read_bytes()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("cp949")  # probe 스크립트가 encoding 안 준 경우
    data = json.loads(text)
    segs = data["segments"]
    fps = data["fps"]

    print(f"=== Alignment Audit: {len(segs)} segs · fps={fps:.2f} ===\n")

    # 중복 감지
    by_start: dict = {}
    for i, s in enumerate(segs):
        k = round(s["start"], 1)
        by_start.setdefault(k, []).append(i)
    dups = [(k, v) for k, v in by_start.items() if len(v) > 1]
    if dups:
        print("[중복 세그] 같은 시각에 2개 이상:")
        for k, v in dups:
            print(f"  @{k}s: seg {v}")
        print()

    good = mid = bad = kept = 0
    for i, s in enumerate(segs):
        text = s.get("text", "").strip()
        words = s.get("words") or []
        src = s.get("align_source", "-")

        if not words:
            kept += 1
            marker = "❌ KEPT"
            print(f"{marker} #{i:2d} [{s['start']:6.2f}→{s['end']:6.2f}] src={src}")
            print(f"    text: {text[:70]}")
            print(f"    (words 없음 · Gemini 텍스트 그대로 · 컷 스냅 불가)")
            print()
            continue

        gt = norm(text)
        wt = norm("".join(w.get("word", "") for w in words))
        sim = SequenceMatcher(None, gt, wt).ratio() if gt and wt else 0.0
        expansion = len(wt) / max(len(gt), 1)

        if sim >= 0.90:
            marker = "✅ GOOD"; good += 1
        elif sim >= 0.60:
            marker = "⚠️  MID "; mid += 1
        else:
            marker = "❌ BAD "; bad += 1

        print(f"{marker} #{i:2d} [{s['start']:6.2f}→{s['end']:6.2f}] src={src} sim={sim:.2f} exp={expansion:.2f}x")
        print(f"    gemini : {text[:70]}")
        wtext = " ".join(w.get("word", "").strip() for w in words)
        print(f"    words  : {wtext[:70]}")
        print()

    total = len(segs)
    print(f"=== 요약 ===")
    print(f"  ✅ GOOD (sim≥0.90) : {good}/{total} ({100*good/total:.0f}%)")
    print(f"  ⚠️  MID  (0.60~0.90): {mid}/{total} ({100*mid/total:.0f}%)")
    print(f"  ❌ BAD  (sim<0.60) : {bad}/{total} ({100*bad/total:.0f}%)")
    print(f"  ❌ KEPT (words 없음): {kept}/{total} ({100*kept/total:.0f}%)")


if __name__ == "__main__":
    audit(sys.argv[1] if len(sys.argv) > 1 else "/c/tmp/stt_probe_result.json")
