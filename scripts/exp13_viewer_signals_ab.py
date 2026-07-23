"""Exp 13 · viewer_signals A/B 파일럿.

각 하하 3 홀드아웃에 대해 recommend()를 두 번 실행:
  OFF: profile without viewer_signals
  ON:  profile with viewer_signals (Exp 10 추출 결과 + explicit timestamps)

비교: 픽 개수·시청자 지목 커버율·v2 5신호 통과율.
"""
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, r"C:\Users\STEPAI05\STEPD-repo")

BASE = Path("D:/STEPD-experiments")
HOLDOUTS = BASE / "holdouts"
RES = BASE / "results"
REPORT = Path(r"C:\Users\STEPAI05\STEPD-repo\바우처_결과보고_2026\증빙_데이터셋\실험자료")

os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = r"C:\Users\STEPAI05\STEPD-repo\gcp-keys\stepd-service-account-key.json"
os.environ["GOOGLE_CLOUD_PROJECT"] = "step-d"
os.environ["VERTEX_LOCATION"] = "asia-northeast3"

# 3 하하 홀드아웃 (Exp 8 대상)
HOLDOUT_MAP = {
    "LcMolKaPcrw": ("ho_scenes.json", "ho_coarse.json"),   # 경주PC방
    "NtXLj7xOeE8": ("ho4_scenes.json", "ho4_coarse.json"),  # 원정대4
    "JppILjNTCok": ("ho5_scenes.json", "ho5_coarse.json"),  # 원정대5
}

# Exp 10 추출 결과 (하하 3편)
extracted = json.load(open(RES / "exp10_all_extracted.json", encoding="utf-8"))
# 원본 댓글 (좋아요 참조용)
raw_comments = json.load(open(RES / "exp10_all_comments.json", encoding="utf-8"))

# 시청자 명시 시간
ts_data = json.load(open(RES / "exp10_timestamps.json", encoding="utf-8"))


def build_viewer_signals(lid):
    """롱폼 lid의 viewer_signals dict 생성."""
    items = extracted.get(lid, [])
    if not items:
        return None
    # top_moments (좋아요 순)
    moments = [(x.get("moment_hint"), x.get("likes", 0)) for x in items if x.get("moment_ref") and x.get("moment_hint") not in ("", "없음", None)]
    moments.sort(key=lambda t: -t[1])
    # top_demands
    demands = [(x.get("demand_text"), x.get("likes", 0)) for x in items if x.get("demand") and x.get("demand_text") not in ("", "없음", None)]
    demands.sort(key=lambda t: -t[1])
    # dominant emotion (좋아요 가중, 없음 제외)
    emo_weight = Counter()
    for x in items:
        e = x.get("emotion", "없음")
        if e in ("없음", ""):
            continue
        emo_weight[e] += x.get("likes", 0) + 1
    dominant = emo_weight.most_common(1)[0][0] if emo_weight else None
    # explicit timestamps
    ts_hits = (ts_data.get(lid) or {}).get("hits") or []
    ts_hits = [{"sec": h["sec"], "mmss": f'{h["sec"]//60}:{h["sec"]%60:02d}', "likes": h["likes"], "raw": h["raw"]}
               for h in sorted(ts_hits, key=lambda h: -h["likes"])[:5]]
    return {
        "top_moments": moments[:8],
        "top_demands": demands[:5],
        "explicit_timestamps": ts_hits,
        "dominant_emotion": dominant,
    }


def scenes_to_transcript(scenes):
    """scenes에 text가 있으면 transcript 리스트로 변환."""
    return [{"start": s["start"], "end": s["end"], "text": s.get("text", "")} for s in scenes if s.get("text")]


# ── recommend 실행 ──
from core.recommend import recommend

results = {}  # lid → {off: [picks], on: [picks], viewer_signals: {...}}
for lid, (scenes_f, coarse_f) in HOLDOUT_MAP.items():
    print(f"\n{'='*70}")
    print(f"[{lid}] 실행 시작")
    print('='*70, flush=True)

    scenes = json.load(open(HOLDOUTS / scenes_f, encoding="utf-8"))
    coarse = json.load(open(HOLDOUTS / coarse_f, encoding="utf-8"))
    transcript = scenes_to_transcript(scenes)

    vs = build_viewer_signals(lid)
    print(f"  viewer_signals: moments={len(vs['top_moments'])} · demands={len(vs['top_demands'])} · ts={len(vs['explicit_timestamps'])} · emotion={vs['dominant_emotion']}")

    # OFF 실행
    print(f"  [OFF] recommend 실행…", flush=True)
    try:
        off_result = recommend(scenes=scenes, n=6, genre="auto", transcript=transcript, profile=None)
        off_picks = off_result.get("shorts", [])
        print(f"    → {len(off_picks)}개 픽")
    except Exception as e:
        print(f"    OFF 실패: {str(e)[:200]}")
        off_picks = []

    # ON 실행 (viewer_signals가 담긴 profile)
    print(f"  [ON]  recommend 실행 (viewer_signals 주입)…", flush=True)
    try:
        on_profile = {"viewer_signals": vs}
        on_result = recommend(scenes=scenes, n=6, genre="auto", transcript=transcript, profile=on_profile)
        on_picks = on_result.get("shorts", [])
        print(f"    → {len(on_picks)}개 픽")
    except Exception as e:
        print(f"    ON 실패: {str(e)[:200]}")
        on_picks = []

    results[lid] = {
        "off": off_picks,
        "on": on_picks,
        "viewer_signals": vs,
        "duration": scenes[-1]["end"] if scenes else 0,
    }
    # 즉시 저장 (재개용)
    json.dump(results, open(RES / "exp13_ab_picks.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)


print(f"\n\n{'='*70}")
print("=== A/B 결과 요약 ===")
print('='*70)

for lid, d in results.items():
    off, on = d["off"], d["on"]
    print(f"\n[{lid}] OFF={len(off)}픽 · ON={len(on)}픽")
    # viewer_signals 시간 커버
    ts_secs = [t["sec"] for t in d["viewer_signals"]["explicit_timestamps"]]

    def covers(picks, target_sec, tol=30):
        return any(p.get("start", 0) - tol <= target_sec <= p.get("end", 0) + tol for p in picks)

    if ts_secs:
        off_cov = sum(covers(off, s) for s in ts_secs)
        on_cov = sum(covers(on, s) for s in ts_secs)
        print(f"  시청자 명시 시간({len(ts_secs)}개) 커버율: OFF {off_cov}/{len(ts_secs)} · ON {on_cov}/{len(ts_secs)}")

    print(f"  OFF picks:")
    for p in off:
        print(f"    {p.get('start',0):.0f}~{p.get('end',0):.0f}s · {p.get('hook','?')} · {p.get('title','')[:60]}")
    print(f"  ON picks:")
    for p in on:
        print(f"    {p.get('start',0):.0f}~{p.get('end',0):.0f}s · {p.get('hook','?')} · {p.get('title','')[:60]}")

# 저장
json.dump(results, open(RES / "exp13_ab_picks.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
import shutil
shutil.copy2(RES / "exp13_ab_picks.json", REPORT / "exp13_ab_picks.json")
print(f"\n저장: {RES / 'exp13_ab_picks.json'}")
