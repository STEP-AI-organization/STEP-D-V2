"""
STEP D Core — full content analysis orchestrator (production entrypoint)

Runs the whole GPU-free pipeline on one video and emits a single result JSON:

    영상 → STT(관리형) → 자막정제 → 장면분할+프레임 → 프레임분석(시각채점+이름자막) → 쇼츠추천(2단계)

This is what the worker invokes for a `content.analyze` job. Everything is
Gemini/Vertex + ffmpeg + scenedetect — no GPU. Auth via ADC.

Checkpointed: every stage persists its output into --out as it completes
(stt.json → refined.json → scenes.json → shorts.json → analysis.json), and a re-run
over the same out dir resumes from the last finished stage instead of starting over
— a vision crash at scene 180/200 no longer throws away 30 minutes of STT. The
frame-analysis stage even checkpoints mid-stage (scenes.json is saved every ~20
frames). manifest.json pins the checkpoints to one video (name+size); pointing
--out at leftovers from a different video wipes them first.

Progress: lines starting with `@@PROGRESS {json}` carry {stage, pct, note} for the
worker to surface in the UI. Everything else on stdout is human logging.

Run:
    python -m core.analyze <video> --out <dir> [--shorts N] [--genre auto|variety|…] [--no-resume]
    python -m core.analyze core/TpQgkCs0TzE.mp4          # writes analysis.json next to it
"""
import json
import os
import shutil
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
from .scenes import build_scenes, extract_frame
from .vision import analyze_frames, _frame_done
from .recommend import recommend

CHECKPOINTS = ("stt.json", "refined.json", "scenes.json", "cast.json", "shorts.json", "analysis.json")


# ── checkpoint plumbing ─────────────────────────────────────────────────────────

def _save_json(path: Path, obj) -> None:
    """Atomic write — a crash mid-write must not leave a truncated checkpoint."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _prepare_checkpoints(out_dir: Path, video_path: str, resume: bool) -> None:
    """Keep checkpoints only if they belong to THIS video (and resume is wanted)."""
    manifest_path = out_dir / "manifest.json"
    try:
        st = Path(video_path).stat()
        manifest = {"video_name": Path(video_path).name, "video_size": st.st_size}
    except OSError:
        manifest = {"video_name": Path(video_path).name, "video_size": None}

    prior = _load_json(manifest_path)
    if not resume or prior != manifest:
        if prior is not None and prior != manifest:
            print("체크포인트가 다른 영상의 것 — 초기화")
        for name in CHECKPOINTS:
            (out_dir / name).unlink(missing_ok=True)
        shutil.rmtree(out_dir / "scene_frames", ignore_errors=True)
    _save_json(manifest_path, manifest)


# ── progress reporting (worker parses @@PROGRESS lines) ─────────────────────────

def _progress(stage: str, pct: float, note: str = "") -> None:
    payload = json.dumps({"stage": stage, "pct": round(pct), "note": note}, ensure_ascii=False)
    # Single write (not print) — progress fires from thread-pool callbacks, and an
    # interleaved half-line would corrupt the marker the worker greps for.
    sys.stdout.write(f"@@PROGRESS {payload}\n")
    sys.stdout.flush()


# ── pipeline ────────────────────────────────────────────────────────────────────

def analyze(
    video_path: str,
    out_dir: Path,
    shorts_n: int = 5,
    genre: str = "auto",
    resume: bool = True,
    profile: dict | None = None,
    cast_registry: list[dict] | None = None,
    channels: list[str] | None = None,
) -> dict:
    """Run all stages (skipping checkpointed ones). Returns the analysis dict.
    `cast_registry` (프로그램 출연자 목록) normalizes on-screen name captions into a
    per-person timeline; `channels` selects the 배포처 fit matrix. Both are optional —
    absent, the run behaves exactly as before plus the new (empty/candidate-only) fields."""
    out_dir.mkdir(parents=True, exist_ok=True)
    frames_dir = out_dir / "scene_frames"
    t0 = time.time()
    stage_took: dict[str, float] = {}

    def step(label: str) -> None:
        print(f"[{time.time() - t0:5.0f}s] {label}")

    def timed(name: str, t_start: float) -> None:
        stage_took[name] = round(time.time() - t_start, 1)

    _prepare_checkpoints(out_dir, video_path, resume)

    # 1) STT ------------------------------------------------------------------
    _progress("stt", 3, "음성 인식 준비")
    ts = time.time()
    stt = _load_json(out_dir / "stt.json")
    if stt and "segments" in stt:
        step(f"STT — 체크포인트 재사용 ({len(stt['segments'])} 세그먼트)")
    else:
        step("STT (관리형)…")
        stt = transcribe(
            video_path, language="ko",
            on_progress=lambda done, total: _progress("stt", 3 + 27 * done / max(1, total), f"음성 인식 {done}/{total} 윈도우"),
        )
        _save_json(out_dir / "stt.json", stt)
    segments = get_segments(stt)
    step(f"  {len(segments)} 세그먼트")
    timed("stt", ts)
    _progress("stt", 30, f"음성 인식 완료 · {len(segments)} 세그먼트")

    # 2) refine ----------------------------------------------------------------
    ts = time.time()
    refined = _load_json(out_dir / "refined.json")
    if refined:
        step(f"자막 정제 — 체크포인트 재사용 ({len(refined)} 세그먼트)")
    else:
        step("자막 정제…")
        _progress("refine", 31, "자막 정제 중")
        refined = refine_segments(segments)
        _save_json(out_dir / "refined.json", refined)
    timed("refine", ts)
    _progress("refine", 38, "자막 정제 완료")

    # 3) scenes + frames ---------------------------------------------------------
    ts = time.time()
    scenes = _load_json(out_dir / "scenes.json")
    if scenes:
        step(f"장면 분할 — 체크포인트 재사용 ({len(scenes)} 장면)")
        # Frames live next to the checkpoint; re-extract any that went missing.
        frames_dir.mkdir(parents=True, exist_ok=True)
        repaired = 0
        for sc in scenes:
            if sc.get("frame") and not (out_dir / sc["frame"]).exists():
                mid = (sc["start"] + sc["end"]) / 2
                if extract_frame(video_path, mid, str(out_dir / sc["frame"])):
                    repaired += 1
                else:
                    sc["frame"] = None
        if repaired:
            step(f"  누락 프레임 {repaired}개 재추출")
    else:
        step("장면 분할 + 프레임…")
        _progress("scenes", 39, "장면 분할 중")
        scenes = build_scenes(video_path, refined, frames_dir)
        _save_json(out_dir / "scenes.json", scenes)
    step(f"  {len(scenes)} 장면")
    timed("scenes", ts)
    _progress("scenes", 45, f"장면 분할 완료 · {len(scenes)} 장면")

    # 4) frame analysis (vision score + name captions, one call per frame) -------
    ts = time.time()
    pending = sum(1 for s in scenes if s.get("frame") and not _frame_done(s))
    if pending:
        # 4a) OCR baseline — PaddleOCR reads burned-in text off ALL frames locally (cheap).
        # Gemini (top-N below) then re-reads only the frames it also scores = validation.
        # No-op when OCR_PROVIDER=off or PaddleOCR is missing (Gemini-only OCR, as before).
        try:
            from .ocr import ocr_scenes, enabled as ocr_enabled
            if ocr_enabled():
                step("프레임 OCR 사전추출 (PaddleOCR)…")
                scenes = ocr_scenes(
                    scenes, out_dir,
                    on_progress=lambda d, t: _progress("frames", 45 + 2 * d / max(1, t), f"OCR 사전추출 {d}/{t}"),
                )
                _save_json(out_dir / "scenes.json", scenes)
        except Exception as e:
            step(f"  (OCR 사전추출 건너뜀: {str(e)[:70]})")

        # 4b) algorithmic pre-filter — score every scene cheaply (faces/motion/audio/
        # caption/dialogue) and send only the top-N frames to Gemini. The rest keep a
        # heuristic vision_score (+ the PaddleOCR text above) and are skipped, cutting
        # Gemini image calls ~85%. No-op when VISION_PREFILTER=off or OpenCV is missing.
        try:
            from .prefilter import select_for_vision
            sent = select_for_vision(
                scenes, str(video_path), out_dir,
                on_progress=lambda d, t: _progress("frames", 47 + 2 * d / max(1, t), f"장면 사전필터 {d}/{t}"),
            )
            if sent is not None:
                _save_json(out_dir / "scenes.json", scenes)  # persist heur + prefilled scores
                step(f"  사전필터 — Gemini 투입 {sent} 장면 (나머지 휴리스틱 스킵)")
                pending = sum(1 for s in scenes if s.get("frame") and not _frame_done(s))
        except Exception as e:
            step(f"  (사전필터 건너뜀: {str(e)[:70]})")

    if pending:
        step(f"프레임 분석 (시각채점+이름자막, {pending} 장면)…")
        scenes = analyze_frames(
            scenes, out_dir,
            save_cb=lambda: _save_json(out_dir / "scenes.json", scenes),
            on_progress=lambda done, total: _progress("frames", 49 + 26 * done / max(1, total), f"프레임 분석 {done}/{total}"),
        )
        _save_json(out_dir / "scenes.json", scenes)
    else:
        step("프레임 분석 — 체크포인트 재사용")
    timed("frames", ts)
    _progress("frames", 75, "프레임 분석 완료")

    # 4c) cast timeline — lower-third name captions × the program's cast registry.
    # Reads scenes[].on_screen_names only (no extra model calls, no face recognition), so
    # it's cheap and safe to run every time. Registry-less runs still produce candidates.
    ts = time.time()
    cast = _load_json(out_dir / "cast.json")
    if cast and isinstance(cast, dict) and cast.get("people") is not None:
        step(f"캐스트 타임라인 — 체크포인트 재사용 ({len(cast['people'])}명)")
    else:
        try:
            from .cast import build_cast_timeline
            _progress("cast", 75, "출연자 타임라인 구성")
            cast = build_cast_timeline(scenes, cast_registry or [])
            _save_json(out_dir / "cast.json", cast)
            step(f"캐스트 타임라인 — 확정 {cast['matchedCount']}명 · 후보 {cast['candidateCount']}명")
        except Exception as e:
            step(f"  (캐스트 타임라인 건너뜀: {str(e)[:70]})")
            cast = None
    timed("cast", ts)

    # 5) shorts recommendation (two-phase, genre-aware) ---------------------------
    ts = time.time()
    rec = _load_json(out_dir / "shorts.json")
    if not (isinstance(rec, dict) and isinstance(rec.get("shorts"), list)):
        step("쇼츠 추천…")
        _progress("recommend", 76, "쇼츠 추천 중")
        rec = recommend(
            scenes, n=shorts_n, genre=genre, profile=profile, channels=channels,
            on_progress=lambda done, total: _progress("recommend", 76 + 16 * done / max(1, total), f"후보 추출 {done}/{total} 구간"),
        )
        _save_json(out_dir / "shorts.json", rec)
    else:
        step(f"쇼츠 추천 — 체크포인트 재사용 ({len(rec['shorts'])}개)")
    shorts = rec["shorts"]
    step(f"  {len(shorts)} 쇼츠 (장르: {rec.get('genre')})")
    timed("recommend", ts)
    _progress("recommend", 95, f"쇼츠 추천 완료 · {len(shorts)}개")

    # 6) final result --------------------------------------------------------------
    duration = scenes[-1]["end"] if scenes else (refined[-1]["end"] if refined else 0)
    result = {
        "video": str(video_path),
        "duration": duration,
        "genre": rec.get("genre"),
        "transcript": refined,
        "scenes": scenes,
        "cast": cast,
        "shorts": shorts,
        "took_sec": round(time.time() - t0, 1),
        "stage_sec": stage_took,
    }
    _save_json(out_dir / "analysis.json", result)
    step(f"완료 → {out_dir / 'analysis.json'}")
    _progress("done", 100, "분석 완료")
    return result


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python -m core.analyze <video> [--out <dir>] [--shorts N] [--genre auto|variety|talk|drama|sports|news|music|documentary] [--profile <profile.json>] [--cast <registry.json>] [--channels youtube_shorts,instagram_reels,smr] [--no-resume]")
        sys.exit(1)

    video = sys.argv[1]
    out_dir = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else Path(video).parent
    n = int(sys.argv[sys.argv.index("--shorts") + 1]) if "--shorts" in sys.argv else 5
    genre = sys.argv[sys.argv.index("--genre") + 1] if "--genre" in sys.argv else "auto"
    resume = "--no-resume" not in sys.argv

    # Optional program understanding profile (--profile <path.json>) → program-fit prior.
    profile = None
    if "--profile" in sys.argv:
        try:
            profile = json.loads(Path(sys.argv[sys.argv.index("--profile") + 1]).read_text(encoding="utf-8"))
        except Exception as e:
            print(f"   (프로파일 로드 실패, 무시: {str(e)[:80]})")

    # Optional cast registry (--cast <registry.json>) → on-screen name captions get
    # normalized onto registered people; without it every name stays a candidate.
    cast_registry = None
    if "--cast" in sys.argv:
        from .cast import load_registry
        cast_registry = load_registry(sys.argv[sys.argv.index("--cast") + 1])

    # Optional destination filter (--channels a,b) → per-channel fit matrix. Default: all.
    channels = None
    if "--channels" in sys.argv:
        channels = [c.strip() for c in sys.argv[sys.argv.index("--channels") + 1].split(",") if c.strip()]

    result = analyze(video, out_dir, shorts_n=n, genre=genre, resume=resume, profile=profile,
                     cast_registry=cast_registry, channels=channels)
    cast = result.get("cast") or {}
    print(f"\n=== 요약 ===")
    print(f"  {len(result['transcript'])} 자막 · {len(result['scenes'])} 장면 · {len(result['shorts'])} 쇼츠 · "
          f"출연자 {cast.get('matchedCount', 0)}확정/{cast.get('candidateCount', 0)}후보 · "
          f"장르 {result['genre']} · {result['took_sec']}초")
    for s in sorted(result["shorts"], key=lambda x: x.get("rank", 99))[:5]:
        print(f"  #{s.get('rank')} [{int(s['start']//60)}:{int(s['start']%60):02d}] appeal {s.get('appeal')} 『{s.get('title','')}』")


if __name__ == "__main__":
    main()
