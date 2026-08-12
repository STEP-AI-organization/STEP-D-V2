"""Exp 9 드나드나 — 로컬 전 과정 오케스트레이터.

파이프라인:
  1) yt-dlp로 shorts(30) + longs(7) 오디오 다운로드
  2) 각 long에 `core.analyze --fast` 실행 → shorts 6개 추천 저장
  3) core.align로 shorts↔longs 매칭 (truth 재구성)
  4) 리텐션 조인 + v2 5신호 필터

경로:
  D:/STEPD-experiments/dna_shorts_audio/{videoid}.m4a
  D:/STEPD-experiments/dna_longs_audio/{videoid}.m4a
  D:/STEPD-experiments/dna_longs_analysis/{videoid}/analysis.json

산출:
  D:/STEPD-experiments/results/exp9_dna_deterministic_picks.csv
  D:/STEPD-experiments/results/exp9_dna_confirmed_gems.json
"""
import json
import os
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

BASE = Path("D:/STEPD-experiments")
SHORTS_DIR = BASE / "dna_shorts_audio"
LONGS_DIR = BASE / "dna_longs_audio"
ANALYSIS_DIR = BASE / "dna_longs_analysis"
RES = BASE / "results"

SHORTS_DIR.mkdir(exist_ok=True, parents=True)
LONGS_DIR.mkdir(exist_ok=True, parents=True)
ANALYSIS_DIR.mkdir(exist_ok=True, parents=True)

longs_meta = json.load(open(RES / "exp9_dna_longs.json", encoding="utf-8"))
shorts_meta = json.load(open(RES / "exp9_dna_shorts.json", encoding="utf-8"))

os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = r"C:\Users\STEPAI05\STEPD-repo\gcp-keys\stepd-service-account-key.json"
os.environ["GOOGLE_CLOUD_PROJECT"] = "step-d"
os.environ["VERTEX_LOCATION"] = "asia-northeast3"


def dl_audio(vid, dest_dir):
    out = dest_dir / f"{vid}.m4a"
    if out.exists() and out.stat().st_size > 1024:
        return "cached"
    url = f"https://www.youtube.com/watch?v={vid}"
    try:
        subprocess.run(
            ["yt-dlp", "-q", "--no-playlist", "-f", "bestaudio/best", "-x", "--audio-format", "m4a",
             "-o", str(dest_dir / f"{vid}.%(ext)s"), url],
            check=True, capture_output=True, timeout=180,
        )
        return "ok" if out.exists() else "missing"
    except subprocess.CalledProcessError as e:
        return f"err: {(e.stderr or b'').decode('utf-8', errors='replace')[:100]}"
    except subprocess.TimeoutExpired:
        return "timeout"


def analyze_long(vid):
    """core.analyze --fast로 분석 → analysis.json 생성"""
    audio = LONGS_DIR / f"{vid}.m4a"
    out_dir = ANALYSIS_DIR / vid
    out_dir.mkdir(exist_ok=True, parents=True)
    if (out_dir / "analysis.json").exists():
        return "cached"
    try:
        r = subprocess.run(
            [sys.executable, "-m", "core.analyze", str(audio),
             "--out", str(out_dir), "--fast", "--shorts", "6"],
            cwd=r"C:\Users\STEPAI05\STEPD-repo",
            capture_output=True, timeout=900,
        )
        if (out_dir / "analysis.json").exists():
            return "ok"
        return f"missing (rc={r.returncode}, stderr={(r.stderr or b'').decode('utf-8', errors='replace')[-300:]})"
    except subprocess.TimeoutExpired:
        return "timeout"


# === STAGE 1: 다운로드 ===
print(f"=== STAGE 1: 오디오 다운로드 ===")
print(f"shorts 다운로드…")
for i, s in enumerate(shorts_meta, 1):
    r = dl_audio(s["videoid"], SHORTS_DIR)
    print(f"  [{i}/{len(shorts_meta)}] {s['videoid']}: {r}", flush=True)
print(f"\nlongs 다운로드…")
for i, l in enumerate(longs_meta, 1):
    r = dl_audio(l["videoid"], LONGS_DIR)
    print(f"  [{i}/{len(longs_meta)}] {l['videoid']} ({l['durationsec']}s): {r}", flush=True)

# === STAGE 2: 분석 (Gemini) ===
print(f"\n=== STAGE 2: 각 long에 analyze --fast 실행 ===")
for i, l in enumerate(longs_meta, 1):
    if not (LONGS_DIR / f"{l['videoid']}.m4a").exists():
        print(f"  [{i}/{len(longs_meta)}] {l['videoid']}: 오디오 없음 스킵")
        continue
    print(f"  [{i}/{len(longs_meta)}] {l['videoid']}: 분석 시작…", flush=True)
    r = analyze_long(l["videoid"])
    print(f"    → {r}", flush=True)

# === STAGE 3: 로컬 매칭 ===
print(f"\n=== STAGE 3: 로컬 매칭 (core.align) ===")
sys.path.insert(0, str(Path(r"C:\Users\STEPAI05\STEPD-repo")))
from core.align import align_many, MIN_SCORE, MIN_PEAK_RATIO

longs = [l["videoid"] for l in longs_meta if (LONGS_DIR / f"{l['videoid']}.m4a").exists()]
shorts = [s["videoid"] for s in shorts_meta if (SHORTS_DIR / f"{s['videoid']}.m4a").exists()]
print(f"매칭 대상: longs={len(longs)}, shorts={len(shorts)}, 조합={len(longs)*len(shorts)}")

matches, truth = [], []
for li, long_id in enumerate(longs, 1):
    long_path = str(LONGS_DIR / f"{long_id}.m4a")
    short_paths = [str(SHORTS_DIR / f"{s}.m4a") for s in shorts]
    print(f"  [{li}/{len(longs)}] {long_id}…", flush=True)
    try:
        results = align_many(long_path, short_paths)
    except Exception as e:
        print(f"    align 실패: {str(e)[:100]}")
        continue
    for short_id, r in zip(shorts, results):
        matches.append({"short": short_id, "long": long_id, "ok": r.ok,
                        "offset_sec": r.offset_sec, "duration_sec": r.duration_sec,
                        "score": r.score, "peak_ratio": r.peak_ratio})
        if r.ok:
            truth.append({"shortVideoId": short_id, "longVideoId": long_id,
                          "segStart": r.offset_sec,
                          "segEnd": round(r.offset_sec + r.duration_sec, 2),
                          "segLenSec": r.duration_sec,
                          "match_score": r.score, "match_peak_ratio": r.peak_ratio})
    ok = sum(1 for r in results if r.ok)
    print(f"    → 매칭 {ok}개", flush=True)

(RES / "exp9_dna_matches.json").write_text(json.dumps(matches, ensure_ascii=False, indent=2), encoding="utf-8")
(RES / "exp9_dna_truth.json").write_text(json.dumps({
    "channelName": "드나드나", "n_longs": len(longs), "n_shorts_candidates": len(shorts),
    "n_matched": len(truth), "pairs": truth,
}, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"\n매칭 truth: {len(truth)} pairs 저장")

print("\n=== 완료 ===")
print("다음: exp9_dna_v2_filter.py 실행")
