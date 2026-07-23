"""Exp 9 ENA — 로컬 매칭 (D:/STEPD-experiments의 오디오 활용, 서버 부담 X).

- 롱폼 5편(오디오+분석 있음) 각각에 대해 29 shorts 전부 대조 (145회)
- 롱폼당 1회 디코딩 (align_many가 캐시)
- 결과: 어느 short가 어느 long의 몇초에서 왔는지 (short_source_map 로컬 재구성)

산출:
- D:/STEPD-experiments/results/exp9_ena_matches.json — 매칭 결과 (short, long, offset, dur, score, ratio)
- D:/STEPD-experiments/results/exp9_ena_truth.json — score≥0.8 & ratio≥1.25 만 남긴 truth
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
sys.stdout.reconfigure(encoding="utf-8")

from core.align import align_many, MIN_SCORE, MIN_PEAK_RATIO

LONG_DIR = Path("D:/STEPD-experiments/ena_longs_audio")
SHORT_DIR = Path("D:/STEPD-experiments/ena_shorts_audio")
OUT_DIR = Path("D:/STEPD-experiments/results")
OUT_DIR.mkdir(exist_ok=True, parents=True)

longs = sorted(p.stem for p in LONG_DIR.glob("*.m4a"))
shorts = sorted(p.stem for p in SHORT_DIR.glob("*.m4a"))

print(f"매칭 대상: longs={len(longs)}, shorts={len(shorts)}, 조합={len(longs)*len(shorts)}\n")

matches = []
truth = []
for li, long_id in enumerate(longs, 1):
    long_path = str(LONG_DIR / f"{long_id}.m4a")
    short_paths = [str(SHORT_DIR / f"{s}.m4a") for s in shorts]
    print(f"[{li}/{len(longs)}] {long_id} 처리…", flush=True)
    results = align_many(long_path, short_paths)
    for short_id, r in zip(shorts, results):
        rec = {
            "short": short_id,
            "long": long_id,
            "ok": r.ok,
            "offset_sec": r.offset_sec,
            "duration_sec": r.duration_sec,
            "score": r.score,
            "peak_ratio": r.peak_ratio,
        }
        matches.append(rec)
        if r.ok:
            truth.append({
                "shortVideoId": short_id,
                "longVideoId": long_id,
                "segStart": r.offset_sec,
                "segEnd": round(r.offset_sec + r.duration_sec, 2),
                "segLenSec": r.duration_sec,
                "match_score": r.score,
                "match_peak_ratio": r.peak_ratio,
            })
    print(f"    → 이 롱폼에서 매칭된 숏폼: {sum(1 for r in results if r.ok)}", flush=True)

# 저장
(OUT_DIR / "exp9_ena_matches.json").write_text(
    json.dumps(matches, ensure_ascii=False, indent=2), encoding="utf-8")
(OUT_DIR / "exp9_ena_truth.json").write_text(
    json.dumps({
        "channelId": "UCAP8OK0GHFbnL5OkY3j04Xw",
        "channelName": "ENA",
        "n_longs": len(longs),
        "n_shorts_candidates": len(shorts),
        "n_matched": len(truth),
        "threshold": {"min_score": MIN_SCORE, "min_peak_ratio": MIN_PEAK_RATIO},
        "pairs": truth,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

print(f"\n=== 매칭 완료 ===")
print(f"전체 조합: {len(matches)}")
print(f"인정 매칭: {len(truth)} (score≥{MIN_SCORE} & ratio≥{MIN_PEAK_RATIO})")

# 롱폼별 매칭 개수
from collections import Counter
cnt = Counter(t["longVideoId"] for t in truth)
print("\n롱폼별 매칭:")
for lid in longs:
    print(f"  {lid}: {cnt.get(lid, 0)}개")

# 매칭 안 된 shorts
matched_shorts = {t["shortVideoId"] for t in truth}
unmatched = [s for s in shorts if s not in matched_shorts]
print(f"\n미매칭 shorts: {len(unmatched)} — 이 채널 다른 롱폼에서 나왔거나 배속·BGM 덧입힘")
