"""
WhisperX 실측 — wav2vec2 forced alignment로 word timestamp 정확도 검증.

사용: python scripts/whisperx_probe.py <video>
결과: /c/tmp/whisperx_result.json (asr.py와 동형: {segments:[{start,end,text,words:[{word,start,end}]}]})
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

os.add_dll_directory  # noqa — 인터프리터 확인용

# cuDNN DLL 로드 (asr.py의 whisper 경로에서 배운 함정)
if os.name == "nt":
    try:
        import ctypes, importlib
        for pkg_name in ("nvidia.cudnn", "nvidia.cublas"):
            try:
                pkg = importlib.import_module(pkg_name)
                bin_dir = os.path.join(os.path.dirname(pkg.__file__), "bin")
                if not os.path.isdir(bin_dir):
                    continue
                for fn in os.listdir(bin_dir):
                    if fn.endswith(".dll"):
                        try:
                            ctypes.CDLL(os.path.join(bin_dir, fn))
                        except OSError:
                            pass
            except Exception:
                continue
    except Exception:
        pass


def extract_audio(video: str) -> str:
    """16kHz mono wav — whisperx는 wav 파일 경로를 받음."""
    wav = str(Path(video).with_suffix(".stt.wav"))
    if not os.path.exists(wav):
        subprocess.run(
            ["ffmpeg", "-y", "-v", "quiet", "-i", video,
             "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", wav],
            check=True,
        )
    return wav


def main(video: str, out_path: str = "C:/tmp/whisperx_result.json") -> None:
    import whisperx
    import torch

    device = "cuda" if torch.cuda.is_available() else "cpu"
    compute_type = "float16" if device == "cuda" else "int8"
    print(f"[whisperx] device={device} compute_type={compute_type}")

    wav = extract_audio(video)
    print(f"[whisperx] audio → {wav}")

    # 1) transcribe with whisper (자체 timestamp — 부정확, 다음 단계에서 정정)
    t0 = time.time()
    print(f"[whisperx] loading large-v3 (batch base) …")
    model = whisperx.load_model("large-v3", device, compute_type=compute_type, language="ko")
    audio = whisperx.load_audio(wav)
    print(f"[whisperx] transcribing {len(audio)/16000:.1f}s audio (batch)…")
    result = model.transcribe(audio, batch_size=16, language="ko")
    print(f"[whisperx] transcribe {time.time()-t0:.1f}s · {len(result['segments'])} segs")
    del model
    torch.cuda.empty_cache()

    # 2) load alignment model (wav2vec2 한국어)
    t1 = time.time()
    print(f"[whisperx] loading alignment model for ko …")
    model_a, meta = whisperx.load_align_model(language_code="ko", device=device)
    print(f"[whisperx] align {time.time()-t1:.1f}s (load)")

    # 3) forced alignment — word-level timestamp 정확도의 핵심
    t2 = time.time()
    result_a = whisperx.align(
        result["segments"], model_a, meta, audio, device,
        return_char_alignments=False,
    )
    print(f"[whisperx] align {time.time()-t2:.1f}s (compute)")

    # asr.py와 동형으로 저장
    segs_out = []
    for s in result_a["segments"]:
        segs_out.append({
            "start": round(float(s["start"]), 3),
            "end": round(float(s["end"]), 3),
            "text": (s.get("text") or "").strip(),
            "words": [
                {
                    "word": w.get("word", ""),
                    "start": round(float(w.get("start", 0)), 3),
                    "end": round(float(w.get("end", 0)), 3),
                }
                for w in (s.get("words") or [])
                if w.get("start") is not None and w.get("end") is not None
            ],
        })

    # fps는 sync_burn.mjs와 호환용 (asr.py 실측 대비)
    fps = 29.97
    try:
        r = subprocess.check_output(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=r_frame_rate",
             "-of", "default=nw=1:nk=1", video], text=True,
        ).strip()
        n, d = r.split("/") if "/" in r else (r, "1")
        fps = float(n) / float(d) if float(d) else fps
    except Exception:
        pass

    Path(out_path).write_text(
        json.dumps({"fps": fps, "segments": segs_out}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"\n[whisperx] {len(segs_out)} segs, fps={fps:.3f} → {out_path}")
    if segs_out:
        wct = sum(len(s.get("words") or []) for s in segs_out)
        print(f"[whisperx] words total={wct} · first {segs_out[0]['start']:.2f}s · last {segs_out[-1]['end']:.2f}s")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: python scripts/whisperx_probe.py <video> [out.json]")
        sys.exit(1)
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "C:/tmp/whisperx_result.json")
