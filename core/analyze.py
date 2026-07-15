"""
STEP D Core — full content analysis orchestrator (production entrypoint)

Runs the whole GPU-free pipeline on one video and emits a single result JSON:

    영상 → STT(관리형) → 자막정제 → 장면분할+프레임 → 시각채점 → 이름자막 → 쇼츠추천

This is what the worker invokes for a `content.analyze` job (one command, one output),
instead of chaining the six stage scripts by hand. Everything is Gemini/Vertex +
ffmpeg + scenedetect — no GPU. Auth via ADC.

Run:
    python -m core.analyze <video> --out <dir>
    python -m core.analyze core/TpQgkCs0TzE.mp4          # writes analysis.json next to it
"""
import json
import sys
import time
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

from .asr import transcribe, get_segments
from .refine import refine_segments
from .scenes import build_scenes
from .vision import score_scenes
from .names import run as extract_names
from .recommend import recommend


def analyze(video_path: str, out_dir: Path, shorts_n: int = 5) -> dict:
    """Run all stages. Returns {video, duration, transcript, scenes, shorts}."""
    out_dir.mkdir(parents=True, exist_ok=True)
    frames_dir = out_dir / "scene_frames"
    t0 = time.time()

    def step(label: str) -> None:
        print(f"[{time.time() - t0:5.0f}s] {label}")

    step("STT (관리형)…")
    stt = transcribe(video_path, language="ko")
    segments = get_segments(stt)
    step(f"  {len(segments)} 세그먼트")

    step("자막 정제…")
    refined = refine_segments(segments)

    step("장면 분할 + 프레임…")
    scenes = build_scenes(video_path, refined, frames_dir)
    step(f"  {len(scenes)} 장면")

    step("시각 채점…")
    scenes = score_scenes(scenes, out_dir)

    step("이름자막…")
    scenes = extract_names(scenes, out_dir)

    step("쇼츠 추천…")
    shorts = recommend(scenes, n=shorts_n)
    step(f"  {len(shorts)} 쇼츠")

    duration = scenes[-1]["end"] if scenes else (refined[-1]["end"] if refined else 0)
    result = {
        "video": str(video_path),
        "duration": duration,
        "transcript": refined,
        "scenes": scenes,
        "shorts": shorts,
        "took_sec": round(time.time() - t0, 1),
    }
    (out_dir / "analysis.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    step(f"완료 → {out_dir / 'analysis.json'}")
    return result


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python -m core.analyze <video> [--out <dir>] [--shorts N]")
        sys.exit(1)

    video = sys.argv[1]
    out_dir = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else Path(video).parent
    n = int(sys.argv[sys.argv.index("--shorts") + 1]) if "--shorts" in sys.argv else 5

    result = analyze(video, out_dir, shorts_n=n)
    print(f"\n=== 요약 ===")
    print(f"  {len(result['transcript'])} 자막 · {len(result['scenes'])} 장면 · {len(result['shorts'])} 쇼츠 · {result['took_sec']}초")
    for s in sorted(result["shorts"], key=lambda x: x.get("rank", 99))[:5]:
        print(f"  #{s.get('rank')} [{int(s['start']//60)}:{int(s['start']%60):02d}] 『{s.get('title','')}』")


if __name__ == "__main__":
    main()
