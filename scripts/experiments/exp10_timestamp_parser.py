"""Exp 10 B안 — explicit timestamp 파싱 프로토타입.

1500 원본 댓글에서 "M:SS", "H:MM:SS", "몇분 몇초" 등 자동 추출.
시청자가 롱폼 특정 초를 명시한 언급 = 정확한 (start, end) 픽 후보.
"""
import json
import re
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

BASE = Path("D:/STEPD-experiments")
RES = BASE / "results"
REPORT_DIR = Path(r"C:\Users\STEPAI05\STEPD-repo\바우처_결과보고_2026\증빙_데이터셋\실험자료")

comments = json.load(open(RES / "exp10_all_comments.json", encoding="utf-8"))
extracted = json.load(open(RES / "exp10_all_extracted.json", encoding="utf-8"))

# 정규식 패턴 (엄격순)
PATTERNS = [
    # H:MM:SS 또는 M:SS (00:00 ~ 99:59)
    re.compile(r'(?<![\d\-])(\d{1,2}):(\d{2})(?::(\d{2}))?(?![\d\-])'),
]

# 한국어 시간 표기
KOR_PATTERNS = [
    # "3분 20초"
    re.compile(r'(\d{1,3})\s*분\s*(\d{1,2})?\s*초?'),
    # "3분"
    re.compile(r'(\d{1,3})\s*분(?!\d)'),
]


def parse_timestamps(text):
    """텍스트에서 (초, 원본표기) 튜플 리스트 추출."""
    results = []
    for pat in PATTERNS:
        for m in pat.finditer(text):
            g = m.groups()
            if g[2]:  # H:MM:SS
                h = int(g[0]); mi = int(g[1]); s = int(g[2])
                sec = h*3600 + mi*60 + s
            else:  # M:SS
                mi = int(g[0]); s = int(g[1])
                if mi >= 60:  # 실제 시:분일 가능성 낮음, skip
                    continue
                if s >= 60:
                    continue
                sec = mi*60 + s
            if sec < 30 or sec > 7200:  # 30초 미만·2시간 초과는 오탐 가능성
                continue
            results.append((sec, m.group()))
    # 한국어
    for pat in KOR_PATTERNS[:1]:  # "3분 20초"만 (부정확 낮음)
        for m in pat.finditer(text):
            g = m.groups()
            mi = int(g[0])
            s = int(g[1]) if g[1] else 0
            if mi >= 60 or s >= 60:
                continue
            sec = mi*60 + s
            if sec < 30 or sec > 7200:
                continue
            results.append((sec, m.group()))
    return results


# 채널·롱폼 그룹핑
HAHA_LIDS = {"LcMolKaPcrw", "NtXLj7xOeE8", "JppILjNTCok"}
ENA_LIDS = {"dnIaj6L3t1E", "DPclbGO1F9g", "Lj_tFgRqqEI", "MjWwq8bBwJE", "QNtoQ4zI8mc"}
DNA_LIDS = {"rhX9po-DBZI", "NUM1zfQujWY", "OuvpspSaAUQ", "k8BHuiKF0rk", "ALuFb_TqHPU", "a9O8d0zLfTg", "sT9KQTLg2Cs"}
CH = {**{l:"하하" for l in HAHA_LIDS}, **{l:"ENA" for l in ENA_LIDS}, **{l:"드나드나" for l in DNA_LIDS}}


# === 추출 ===
all_ts = {}  # lid -> list of {sec, raw, text, likes, channel}
for lid, cmts in comments.items():
    ch = CH.get(lid)
    if not ch: continue
    hits = []
    for c in cmts:
        text = c.get("text", "")
        likes = c.get("likes", 0)
        for sec, raw in parse_timestamps(text):
            hits.append({
                "sec": sec, "raw": raw, "text": text[:200],
                "likes": likes,
            })
    all_ts[lid] = {"channel": ch, "hits": hits}


# === 요약 ===
print("=== Exp 10 B안 · explicit timestamp 파싱 ===\n")

by_ch = {"하하": [], "ENA": [], "드나드나": []}
for lid, d in all_ts.items():
    by_ch[d["channel"]].append((lid, d["hits"]))

print(f"{'채널':<10} | {'롱폼':>4} | {'시간표기 댓글':>12} | {'시간표기 개수':>12}")
for ch, longs in by_ch.items():
    total_hits = sum(len(hits) for _, hits in longs)
    with_ts = sum(1 for _, hits in longs if hits)
    print(f"{ch:<10} | {len(longs):>4} | {with_ts:>12} | {total_hits:>12}")

print("\n=== 롱폼별 상세 ===")
for ch, longs in by_ch.items():
    for lid, hits in longs:
        if not hits:
            print(f"\n[{ch}/{lid}] 시간표기 없음")
            continue
        # sec으로 정렬 후 겹치는 것 그룹핑
        hits.sort(key=lambda h: h["sec"])
        print(f"\n[{ch}/{lid}] {len(hits)}개 시간표기")
        # 좋아요순 상위 10
        top = sorted(hits, key=lambda h: -h["likes"])[:10]
        for h in top:
            m, s = divmod(h["sec"], 60)
            print(f"  [{h['likes']}❤] {m}:{s:02d} · '{h['raw']}' · {h['text'][:80]}")

# 저장
json.dump(all_ts, open(RES / "exp10_timestamps.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
import shutil
shutil.copy2(RES / "exp10_timestamps.json", REPORT_DIR / "exp10_timestamps.json")

# 시청자 지목 픽 후보 생성 (규모 무관 signal)
print("\n\n=== 시청자 지목 픽 후보 (viewer_hint_ranges) ===")
candidates = {}
for lid, d in all_ts.items():
    if not d["hits"]:
        continue
    ch = d["channel"]
    # 좋아요 가중 밀도 계산 (초당)
    marks = []
    for h in d["hits"]:
        marks.append({
            "start": max(0, h["sec"] - 5),  # -5초 여유
            "end": h["sec"] + 55,           # 60초 픽 후보로
            "likes": h["likes"],
            "raw": h["raw"],
            "text": h["text"][:150],
        })
    marks.sort(key=lambda m: -m["likes"])
    candidates[lid] = {"channel": ch, "candidates": marks[:5]}
    print(f"\n[{ch}/{lid}] 상위 시청자 지목 픽 후보:")
    for c in marks[:3]:
        m, s = divmod(c["start"], 60)
        print(f"  [{c['likes']}❤] {m}:{s:02d} ~ +60s (원 시간 '{c['raw']}')")
        print(f"     맥락: {c['text']}")

json.dump(candidates, open(RES / "exp10_viewer_pick_candidates.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
shutil.copy2(RES / "exp10_viewer_pick_candidates.json", REPORT_DIR / "exp10_viewer_pick_candidates.json")

print(f"\n저장: {RES / 'exp10_timestamps.json'} · {RES / 'exp10_viewer_pick_candidates.json'}")
