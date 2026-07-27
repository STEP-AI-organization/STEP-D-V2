"""
STT word-timestamp 실측 — asr.py 하이브리드가 refined 세그에 words를 붙이는지 확인.

사용: python scripts/stt_word_probe.py <video_or_wav>
검증:
  1) 각 세그에 words 배열이 채워졌나 (len > 0)
  2) 세그의 start/end가 words[0].start / words[-1].end와 일치하나
  3) 프레임 스냅용 초 → 프레임 왕복 정확도 (원본 fps)
"""
import json
import os
import subprocess
import sys
from pathlib import Path

os.environ.setdefault("STT_PROVIDER", "hybrid")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.asr import transcribe  # noqa: E402


def probe_fps(path: str) -> float:
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=r_frame_rate", "-of", "default=nw=1:nk=1", path],
        text=True,
    ).strip()
    num, den = out.split("/") if "/" in out else (out, "1")
    return float(num) / float(den) if float(den) else 0.0


def main(src: str) -> None:
    fps = probe_fps(src) or 30.0
    print(f"[probe] source={src}  fps={fps:.3f}")

    r = transcribe(src, language="ko")
    segs = r.get("segments") or []
    print(f"[probe] segments={len(segs)}  provider={os.environ.get('STT_PROVIDER')}")

    with_words = 0
    boundary_ok = 0
    max_bnd_err = 0.0
    frame_step = 1.0 / fps

    for s in segs:
        ws = s.get("words") or []
        if ws:
            with_words += 1
            first_ok = abs(ws[0]["start"] - s["start"]) < 0.02
            last_ok = abs(ws[-1]["end"] - s["end"]) < 0.02
            if first_ok and last_ok:
                boundary_ok += 1
            err = max(abs(ws[0]["start"] - s["start"]), abs(ws[-1]["end"] - s["end"]))
            max_bnd_err = max(max_bnd_err, err)

    print(f"[probe] segs_with_words={with_words}/{len(segs)}")
    print(f"[probe] boundary_ok(word[0]/[-1]==seg)={boundary_ok}/{with_words} · max err {max_bnd_err*1000:.1f}ms")
    print(f"[probe] one frame @ {fps:.2f}fps = {frame_step*1000:.2f}ms")

    # 첫 3개 세그의 words dump
    print("\n[sample] first 3 segments:")
    for i, s in enumerate(segs[:3]):
        ws = s.get("words") or []
        head = ws[:6]
        tail = ws[-3:] if len(ws) > 6 else []
        print(f"  #{i} [{s['start']:.3f}→{s['end']:.3f}] src={s.get('align_source','?')} words={len(ws)}")
        print(f"    text: {s.get('text','')[:80]}")
        for w in head:
            print(f"    · {w['start']:.3f}→{w['end']:.3f}  {w.get('word','')!r}")
        if tail:
            print("    …")
            for w in tail:
                print(f"    · {w['start']:.3f}→{w['end']:.3f}  {w.get('word','')!r}")

    # 결과 JSON도 남겨서 확인
    outp = Path("/tmp/stt_probe_result.json")
    outp.write_text(json.dumps({"fps": fps, "segments": segs}, ensure_ascii=False, indent=2))
    print(f"\n[probe] full result → {outp}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: python scripts/stt_word_probe.py <video_or_wav>")
        sys.exit(1)
    main(sys.argv[1])
