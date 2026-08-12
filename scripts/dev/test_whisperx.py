"""WhisperX 배선 스모크. STT_PROVIDER=whisperx + HF_TOKEN env 로 실행.

사용법:
  $env:HF_TOKEN = "hf_..."
  core/.venv310/Scripts/python.exe tmp/gebd/scripts/test_whisperx.py <audio_or_mp4>
"""
import sys, os, json, time
os.environ.setdefault("STT_PROVIDER", "whisperx")
sys.path.insert(0, os.getcwd())

from core.stt.asr import transcribe

if len(sys.argv) < 2:
    print("usage: test_whisperx.py <path> [expected_speakers]")
    sys.exit(1)

src = sys.argv[1]
expected = int(sys.argv[2]) if len(sys.argv) > 2 else None

print(f"[test] STT_PROVIDER={os.environ.get('STT_PROVIDER')}  HF_TOKEN={'set' if os.environ.get('HF_TOKEN') else 'MISSING'}")
print(f"[test] src={src}  expected_speakers={expected}")

t0 = time.time()
r = transcribe(src, expected_speakers=expected)
dt = time.time() - t0

segs = r.get("segments", [])
speakers = sorted({s.get("speaker") or "(empty)" for s in segs})
print(f"\n[done] {dt:.1f}s · {len(segs)} 세그 · speakers={speakers}")
print(f"\n--- 처음 5 세그 ---")
for s in segs[:5]:
    ws = s.get("words") or []
    w0 = ws[0] if ws else {}
    print(f"  [{s['start']:.2f} → {s['end']:.2f}] spk={s.get('speaker'):>10s} "
          f"words={len(ws)} first_word_ts={w0.get('start', '?')}  text={s['text'][:60]}")
