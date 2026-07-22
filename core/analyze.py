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
import hashlib
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
from .scenes import scenes_from_transcript, scenes_from_duration_chunks
from .recommend import recommend
from .narrative import build_narrative

CHECKPOINTS = ("stt.json", "refined.json", "faces.json", "scenes.json", "cast.json", "timeline.json", "narrative.json", "shorts.json", "analysis.json")


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


def _fingerprint(*parts) -> str:
    """Stable short hash of the params a stage's output depends on."""
    raw = json.dumps(parts, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def _prepare_checkpoints(
    out_dir: Path,
    video_path: str,
    resume: bool,
    *,
    genre: str = "auto",
    shorts_n: int = 5,
    profile: dict | None = None,
    channels: list[str] | None = None,
    cast_registry: list[dict] | None = None,
) -> None:
    """Keep checkpoints only if they belong to THIS video AND were produced with the same
    params. Two independent invalidations:

    1. Video identity — if the source video differs, wipe everything. A transient stat()
       failure must NOT count as "different video": we only wipe on a *known* mismatch
       (name differs, or both sizes are known and differ), never on an unknown size.
    2. Params — genre/profile/channels/cast changing between runs must not silently return
       a stale cast/shorts timeline. Each param-dependent checkpoint carries a fingerprint;
       only the ones whose params changed are dropped, so the expensive STT/scene/frame work
       is preserved.
    """
    manifest_path = out_dir / "manifest.json"
    try:
        video_size = Path(video_path).stat().st_size
    except OSError:
        video_size = None  # unknown — do NOT treat as a mismatch
    video_name = Path(video_path).name
    # Per-stage param fingerprints. STT는 영상만 의존, scenes(5분 청크)도 refined 의존.
    # refine은 cast_registry를 프롬프트에 넣으므로(speaker 라벨링) cast 바뀌면 무효화 필요.
    params = {
        "refined.json": _fingerprint(cast_registry),
        "cast.json": _fingerprint(cast_registry),
        "narrative.json": _fingerprint(cast_registry),
        "shorts.json": _fingerprint(genre, shorts_n, profile, channels),
        "analysis.json": _fingerprint(genre, shorts_n, profile, channels, cast_registry),
    }
    manifest = {"video_name": video_name, "video_size": video_size, "params": params}

    prior = _load_json(manifest_path) or {}
    prior_name = prior.get("video_name")
    prior_size = prior.get("video_size")
    video_changed = (
        prior_name is not None
        and (prior_name != video_name
             or (prior_size is not None and video_size is not None and prior_size != video_size))
    )

    if not resume or video_changed:
        if video_changed:
            print("체크포인트가 다른 영상의 것 — 초기화")
        for name in CHECKPOINTS:
            (out_dir / name).unlink(missing_ok=True)
        shutil.rmtree(out_dir / "scene_frames", ignore_errors=True)
    else:
        # Same video, resuming — drop only the checkpoints whose params changed.
        prior_params = prior.get("params", {})
        for name, fp in params.items():
            if prior_params.get(name) != fp:
                if (out_dir / name).exists():
                    print(f"파라미터 변경 — {name} 재생성")
                (out_dir / name).unlink(missing_ok=True)
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
    fast: bool = False,
) -> dict:
    """Run all stages (skipping checkpointed ones). Returns the analysis dict.
    `cast_registry` (프로그램 출연자 목록) normalizes on-screen name captions into a
    per-person timeline; `channels` selects the 배포처 fit matrix. Both are optional —
    absent, the run behaves exactly as before plus the new (empty/candidate-only) fields."""
    out_dir.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    stage_took: dict[str, float] = {}

    def step(label: str) -> None:
        print(f"[{time.time() - t0:5.0f}s] {label}")

    def timed(name: str, t_start: float) -> None:
        stage_took[name] = round(time.time() - t_start, 1)

    _prepare_checkpoints(
        out_dir, video_path, resume,
        genre=genre, shorts_n=shorts_n, profile=profile,
        channels=channels, cast_registry=cast_registry,
    )

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

    # ── 빠른 모드 (fast) — 자막만으로 바로 추천. 시각 장면감지·프레임·비전·정제·서사를 스킵해
    # 긴 영상 분석 시간의 최대 74%(장면감지+프레임)를 절감한다. 대사 기반 콘텐츠에 적합.
    # fast=False(기본)면 이 블록을 건너뛰고 기존 풀 파이프라인이 그대로 돈다 — 아무것도 안 바뀐다.
    if fast:
        step("빠른 모드 — 자막 세그먼트로 추천 (시각 분석 스킵)")
        scenes = scenes_from_transcript(segments)
        step(f"  {len(scenes)} 자막 장면")
        _progress("recommend", 50, "쇼츠 추천 중 (빠른 모드)")
        ts = time.time()
        rec = recommend(
            scenes, n=shorts_n, genre=genre, profile=profile, channels=channels,
            transcript=segments,
            on_progress=lambda done, total: _progress("recommend", 50 + 45 * done / max(1, total), f"후보 추출 {done}/{total} 구간"),
        )
        timed("recommend", ts)
        shorts = rec["shorts"]
        duration = scenes[-1]["end"] if scenes else (segments[-1]["end"] if segments else 0)
        result = {
            "video": str(video_path), "duration": duration, "genre": rec.get("genre"),
            "transcript": segments, "scenes": scenes, "cast": [], "timeline": [],
            "narrative": {}, "shorts": shorts, "fast": True,
            "took_sec": round(time.time() - t0, 1), "stage_sec": stage_took,
        }
        _save_json(out_dir / "analysis.json", result)
        step(f"완료 (빠른 모드) — {len(shorts)} 쇼츠 · {result['took_sec']}s")
        _progress("done", 100, "분석 완료 (빠른 모드)")
        return result

    # 2) refine ----------------------------------------------------------------
    ts = time.time()
    refined = _load_json(out_dir / "refined.json")
    if refined:
        step(f"자막 정제 — 체크포인트 재사용 ({len(refined)} 세그먼트)")
    else:
        step("자막 정제…")
        _progress("refine", 31, "자막 정제 중")
        refined = refine_segments(segments, cast_registry=cast_registry)
        _save_json(out_dir / "refined.json", refined)
    timed("refine", ts)
    _progress("refine", 38, "자막 정제 완료")

    # 2.5) 얼굴 검출·클러스터링 (2026-07-22 신설).
    # 각 세그먼트 중간 프레임에서 얼굴 검출 → 임베딩 → HDBSCAN 무감독 클러스터링 →
    # 클러스터별 M1/F1/M2/F2 라벨을 refined[].speaker에 덮어씀. 배치 독립성 문제(refine의
    # per-batch M1이 서로 다른 사람) 자동 해결 — 클러스터링은 전역이므로 M1은 항상 같은 얼굴.
    # 사용자가 UI에서 "M2=정숙" 매핑 저장하면 rename만으로 끝남 (apply_mapping).
    # 실패해도 파이프라인 계속 (refined는 텍스트 기반 speaker 유지).
    ts = time.time()
    faces = _load_json(out_dir / "faces.json")
    if faces and isinstance(faces, dict) and faces.get("clusters") is not None:
        step(f"얼굴 클러스터 — 체크포인트 재사용 ({len(faces.get('clusters', {}))} 클러스터)")
        # 저장된 매핑이 있으면 refined에 적용 (재실행 시 사용자 라벨 유지)
        try:
            from .faces import apply_mapping
            refined = apply_mapping(refined, faces.get("mapping") or {})
            _save_json(out_dir / "refined.json", refined)
        except Exception as e:
            step(f"  (매핑 적용 스킵: {str(e)[:70]})")
    else:
        try:
            from .faces import build_face_index
            _progress("faces", 40, "얼굴 검출·클러스터링 중")
            step("얼굴 검출·클러스터링…")
            refined, faces = build_face_index(
                video_path, refined, out_dir,
                on_progress=lambda done, total: _progress("faces", 40 + 12 * done / max(1, total), f"얼굴 검출 {done}/{total} 프레임"),
            )
            _save_json(out_dir / "refined.json", refined)  # speaker 라벨 덮어써졌으므로 재저장
            _save_json(out_dir / "faces.json", faces)
            step(f"  클러스터 {len(faces.get('clusters', {}))}개 · 라벨링 {faces.get('labeled_segments', 0)}/{len(refined)} 세그먼트")
        except Exception as e:
            step(f"  (얼굴 클러스터링 스킵: {str(e)[:120]})")
            import traceback
            traceback.print_exc()
            faces = None
    timed("faces", ts)
    _progress("faces", 52, "얼굴 클러스터링 완료")

    # 3) 5분 청크 분할 — 옛 AI-driven 씬 분할 + frames 스테이지 삭제 (2026-07-22).
    # 청크는 (a) 다음 단계들의 병렬 유닛(예정), (b) 요약·상세 단위. 쇼츠 recommend는 청크 경계
    # 무시하고 자유 start/end로 뽑으므로 청크가 30초 하이라이트를 갈라도 무방. ±5초 padding으로
    # 발화 중간 절단은 완화됨.
    ts = time.time()
    scenes = _load_json(out_dir / "scenes.json")
    if scenes:
        step(f"청크 분할 — 체크포인트 재사용 ({len(scenes)} 청크)")
    else:
        step("5분 청크 분할…")
        _progress("scenes", 40, "5분 청크 분할 중")
        scenes = scenes_from_duration_chunks(refined)
        _save_json(out_dir / "scenes.json", scenes)
    step(f"  {len(scenes)} 청크")
    timed("scenes", ts)
    _progress("scenes", 50, f"청크 분할 완료 · {len(scenes)} 청크")

    # 4) cast timeline (+ portraits merged in same stage) --------------------------
    # 옛 파이프라인은 cast(75%) → portraits(79%)를 별도 스테이지로 굴렸음. 이제 한 스텝으로
    # 합침. cast.py가 scenes[].on_screen_names에 의존했었지만, frames 스테이지 삭제로 그 필드가
    # 사라짐 → 지금은 정보 부족 시 empty cast로 fall through. Phase C에서 refined[].speaker 라벨
    # 기반으로 재작성 + 화자 불명 씬만 on-demand vision(1~2 프레임)으로 보강.
    ts = time.time()
    cast = _load_json(out_dir / "cast.json")
    if cast and isinstance(cast, dict) and cast.get("people") is not None and cast.get("portraitsGenerated"):
        step(f"출연자 타임라인·포트레이트 — 체크포인트 재사용 ({len(cast['people'])}명)")
    else:
        try:
            from .cast import build_cast_timeline
            _progress("cast", 55, "출연자 타임라인 구성")
            cast = build_cast_timeline(scenes, cast_registry or [])
            step(f"  캐스트 확정 {cast.get('matchedCount', 0)}명 · 후보 {cast.get('candidateCount', 0)}명")
            _save_json(out_dir / "cast.json", cast)
            # 포트레이트는 people이 있을 때만. 실패해도 cast 자체는 살아있음.
            if isinstance(cast, dict) and cast.get("people"):
                try:
                    from .portraits import build_portraits
                    _progress("cast", 65, "출연진 포트레이트 생성")
                    cast = build_portraits(
                        cast, scenes, out_dir,
                        on_progress=lambda done, total: _progress("cast", 65 + 5 * done / max(1, total), f"포트레이트 {done}/{total}"),
                    )
                    _save_json(out_dir / "cast.json", cast)
                    made = sum(1 for p in cast["people"] if p.get("thumbnail"))
                    step(f"  포트레이트 {made}명 생성")
                except Exception as e:
                    step(f"  (포트레이트 건너뜀: {str(e)[:70]})")
        except Exception as e:
            step(f"  (캐스트 타임라인 건너뜀: {str(e)[:70]})")
            cast = None
    timed("cast", ts)

    # 4d) timeline blocks — N분 단위 구간 요약 (scenes만 의존, 실패해도 파이프라인 계속)
    ts = time.time()
    timeline = _load_json(out_dir / "timeline.json")
    if isinstance(timeline, dict) and timeline.get("blocks"):
        step(f"타임라인 — 체크포인트 재사용 ({len(timeline['blocks'])} 블록)")
    else:
        try:
            from .timeline import build_timeline
            _progress("timeline", 76, "구간 요약 생성")
            timeline = build_timeline(
                scenes,
                on_progress=lambda done, total: _progress("timeline", 76 + 3 * done / max(1, total), f"구간 요약 {done}/{total} 배치"),
            )
            _save_json(out_dir / "timeline.json", timeline)
            step(f"타임라인 — {len(timeline['blocks'])} 블록 ({timeline['block_minutes']}분 단위)")
        except Exception as e:
            step(f"  (타임라인 건너뜀: {str(e)[:70]})")
            timeline = None
    timed("timeline", ts)

    # 4e) narrative summary — 전체 서사 요약 + 구간별/인물/갈등 분석 (timeline 없어도 refined만으로 동작)
    # (portraits는 cast 스테이지에 병합됨 — 위 참조)
    ts = time.time()
    narrative = _load_json(out_dir / "narrative.json")
    # A completed checkpoint has at least one non-empty output. Requiring full_summary AND
    # segments both truthy re-ran the whole (expensive) stage on every resume whenever the
    # summary came back empty (Gemini block) or the episode had no timeline blocks (segments
    # legitimately []). Only a fully-empty result (every Gemini call failed) is worth retrying.
    if isinstance(narrative, dict) and (
        narrative.get("full_summary")
        or narrative.get("segments")
        or narrative.get("characters")
        or narrative.get("key_conflicts")
    ):
        step(f"서사 요약 — 체크포인트 재사용 ({len(narrative.get('segments') or [])} 구간)")
    else:
        try:
            _progress("narrative", 82, "서사 요약 생성")
            narrative = build_narrative(
                refined, scenes, cast, timeline,
                on_progress=lambda done, total: _progress("narrative", 82 + 3 * done / max(1, total), f"서사 요약 {done}/{total} 배치"),
            )
            _save_json(out_dir / "narrative.json", narrative)
            step(f"서사 요약 — {len(narrative.get('segments', []))} 구간 · 갈등 {len(narrative.get('key_conflicts', []))}건")
        except Exception as e:
            step(f"  (서사 요약 건너뜀: {str(e)[:70]})")
            import traceback
            traceback.print_exc()
            narrative = None
    timed("narrative", ts)

    # 5) shorts recommendation (two-phase, genre-aware) ---------------------------
    ts = time.time()
    rec = _load_json(out_dir / "shorts.json")
    # An EMPTY shorts checkpoint is not a valid "done" — regenerate it. Otherwise a single
    # empty pick (old bug) would be reused on every resume and the board would stay at 0
    # forever. recommend() now guarantees a non-empty result, so this only re-runs the
    # genuinely-empty leftovers.
    if not (isinstance(rec, dict) and isinstance(rec.get("shorts"), list) and rec.get("shorts")):
        step("쇼츠 추천…")
        _progress("recommend", 85, "쇼츠 추천 중")
        rec = recommend(
            scenes, n=shorts_n, genre=genre, profile=profile, channels=channels,
            transcript=refined,
            on_progress=lambda done, total: _progress("recommend", 85 + 10 * done / max(1, total), f"후보 추출 {done}/{total} 구간"),
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
        "timeline": timeline,
        "narrative": narrative,
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
        print("Usage: python -m core.analyze <video> [--out <dir>] [--shorts N] [--genre auto|variety|talk|drama|sports|news|music|documentary] [--profile <profile.json>] [--cast <registry.json>] [--channels youtube_shorts,instagram_reels,smr] [--no-resume] [--fast]")
        sys.exit(1)

    video = sys.argv[1]
    out_dir = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else Path(video).parent
    n = int(sys.argv[sys.argv.index("--shorts") + 1]) if "--shorts" in sys.argv else 5
    genre = sys.argv[sys.argv.index("--genre") + 1] if "--genre" in sys.argv else "auto"
    resume = "--no-resume" not in sys.argv
    fast = "--fast" in sys.argv  # 자막만으로 빠른 추천 (시각 분석 스킵, ~10배 빠름)

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
                     cast_registry=cast_registry, channels=channels, fast=fast)
    cast = result.get("cast") or {}
    print(f"\n=== 요약 ===")
    print(f"  {len(result['transcript'])} 자막 · {len(result['scenes'])} 장면 · {len(result['shorts'])} 쇼츠 · "
          f"출연자 {cast.get('matchedCount', 0)}확정/{cast.get('candidateCount', 0)}후보 · "
          f"장르 {result['genre']} · {result['took_sec']}초")
    for s in sorted(result["shorts"], key=lambda x: x.get("rank", 99))[:5]:
        print(f"  #{s.get('rank')} [{int(s['start']//60)}:{int(s['start']%60):02d}] appeal {s.get('appeal')} 『{s.get('title','')}』")


if __name__ == "__main__":
    main()
