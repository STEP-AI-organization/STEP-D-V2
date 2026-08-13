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
import sys
import time
from concurrent.futures import ThreadPoolExecutor, Future
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

from core.analyze_utils import (
    save_json as _save_json,
    load_json as _load_json,
    prepare_checkpoints as _prepare_checkpoints,
    progress as _progress,
)
# 스테이지 함수는 전부 analyze_stages 로. 여기는 orchestrator 만.
from core.analyze_stages import (
    run_fast_mode, load_viewer_signals, index_search_segments, dump_usage,
    run_stt, run_refine, run_chyron_per_seg, run_speaker_postproc, run_detect_genre,
    join_ppl, run_scenes, run_cast_timeline, run_timeline, run_narrative,
    run_shot_boundary, run_scene_type, run_beats, run_beat_signals, run_beat_annot,
    run_speaker_identity, run_recommend,
)


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
    program_context: dict | None = None,
    media_id: str = "",
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

    # ── PPL 병렬 시작 (2026-07-23 A1 최적화) ────────────────────────────────
    # PPL은 video만 참조하고 refined는 안 씀. 순차로 STT→refine→faces 뒤에 돌리는 대신 STT와
    # 동시에 백그라운드 스레드로 시작해 wall clock을 압축한다. 원래 PPL 자리에서 join.
    # duration은 cv2로 직접 산정 (refined 대기 불필요). 캐시 있으면 스킵.
    # PPL(간접광고 검출) — **2026-08-06 기본 off.** 검출이 과다·부정확해 실효가 없는데
    # (사용자 판단) 파이프라인 시간의 절반 이상을 먹는다(축구 109분에서 3787초 전례,
    # docs/research/pipeline-optimization-findings.md). 되살리려면 RUN_PPL=1.
    # 코드는 그대로 두므로 스위치 하나로 복귀 가능하다.
    ppl_future: Future | None = None
    ppl_executor: ThreadPoolExecutor | None = None
    _ppl_on = os.environ.get("RUN_PPL", "0") == "1"
    _ppl_cached = _load_json(out_dir / "ppl.json")
    if not _ppl_on:
        step("PPL 스킵 (RUN_PPL=1 로 활성화)")
    elif not (isinstance(_ppl_cached, dict) and _ppl_cached.get("detections") is not None) and not fast:
        try:
            from core.vision.ppl import build_ppl_index
            import cv2
            cap = cv2.VideoCapture(str(video_path))
            fps = cap.get(cv2.CAP_PROP_FPS) or 30
            fn = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
            _dur_est = fn / fps if fps > 0 else 0
            cap.release()
            if _dur_est > 0:
                ppl_executor = ThreadPoolExecutor(max_workers=1)
                # progress는 원래 스테이지(ppl 53-60%) 자리에서 fire하도록 join 시점에서 재계산
                # (병렬 실행 중에는 UI에 이중 갱신 방지 위해 조용히 진행)
                # on_progress 안 넘김 (STT 진행률과 UI 충돌 방지 · join 시점에서 완료 로그)
                ppl_future = ppl_executor.submit(
                    build_ppl_index, video_path, _dur_est, out_dir,
                )
                step(f"[병렬] PPL 백그라운드 시작 (duration={int(_dur_est)}s)")
        except Exception as e:
            step(f"  (PPL 병렬 시작 실패, 순차 폴백: {str(e)[:70]})")
            ppl_future = None

    # 1) STT — analyze_stages.run_stt 로 이동
    stt, segments = run_stt(
        video_path=video_path, out_dir=out_dir, cast_registry=cast_registry,
        step=step, timed=timed,
    )

    # ── faces 병렬 시작 (2026-07-29 최적화) ────────────────────────────────
    # 옛 파이프라인: STT → refine → faces (10m 완전 직렬). faces는 세그의 start/end 타이밍만
    # 쓰고 (텍스트 X · speaker 라벨 X · refined 를 mutate 하지도 않음), stt segments 는 refined 와
    # 동일한 timing 을 가진다. 따라서 STT 끝나면 즉시 faces 를 백그라운드로 돌리고 refine 과
    # 병렬 실행. 원래 faces 자리에서 join. 절감 wall time 5-8m.
    # cast_photos_dir 는 out_dir/cast_photos (서버가 프로그램 castPhotos 를 파일로 풀어놓음).
    faces_future: Future | None = None
    faces_executor: ThreadPoolExecutor | None = None
    _faces_cached = _load_json(out_dir / "faces.json")
    # 2026-07-30 사용자 방향: 기본 skip · 나중에 살릴 수 있게 삭제 X.
    # RUN_FACES=1 env 또는 --faces 인자 지정 시에만 실행 (insightface 무거움 · 8-15분).
    _run_faces = (os.environ.get("RUN_FACES") == "1") or ("--faces" in sys.argv)
    if _run_faces and not (isinstance(_faces_cached, dict) and _faces_cached.get("clusters") is not None) and not fast:
        try:
            from core.vision.faces import build_face_index
            _cast_photos_dir = out_dir / "cast_photos"
            faces_executor = ThreadPoolExecutor(max_workers=1)
            # on_progress 안 넘김 (refine 진행률과 UI 충돌 방지)
            faces_future = faces_executor.submit(
                build_face_index, video_path, segments, out_dir,
                None,  # on_progress
                _cast_photos_dir if _cast_photos_dir.exists() else None,
            )
            step(f"[병렬] 얼굴 검출·클러스터링 백그라운드 시작 ({len(segments)} 세그)")
        except Exception as e:
            step(f"  (faces 병렬 시작 실패, 순차 폴백: {str(e)[:70]})")
            faces_future = None
    elif not _run_faces:
        step("faces — 기본 skip (RUN_FACES=1 또는 --faces 로 활성화)")

    # 시청자 신호 (comments.json → viewer_signals → profile 병합). load_viewer_signals 로 이동.
    profile = load_viewer_signals(
        out_dir=out_dir, segments=segments, profile=profile,
        step=step, timed=timed,
    )

    # 빠른 모드 (fast) — 자막만으로 바로 추천. 시각·서사·비전 스킵. run_fast_mode 로 이동.
    if fast:
        return run_fast_mode(
            video_path=video_path, out_dir=out_dir, segments=segments,
            shorts_n=shorts_n, genre=genre, profile=profile, channels=channels,
            cast_registry=cast_registry, program_context=program_context,
            t0=t0, stage_took=stage_took, step=step, timed=timed,
        )

    # 2) refine — analyze_stages.run_refine 로 이동
    refined = run_refine(
        segments=segments, out_dir=out_dir, cast_registry=cast_registry,
        program_context=program_context, step=step, timed=timed,
    )

    # 2.4) chyron per-seg — analyze_stages.run_chyron_per_seg 로 이동
    refined = run_chyron_per_seg(
        video_path=video_path, refined=refined, out_dir=out_dir,
        step=step, timed=timed, cast_registry=cast_registry,
    )

    # 2.5) speaker 후처리 — analyze_stages.run_speaker_postproc 로 이동
    refined = run_speaker_postproc(
        refined=refined, out_dir=out_dir, step=step, timed=timed,
    )

    # 2.5) 얼굴 검출·클러스터링 (2026-07-22 신설 · 2026-07-29 STT 후 병렬).
    # 백그라운드 시작한 faces_future 가 있으면 여기서 join. 없으면 캐시 재사용 또는 실패 처리.
    # faces 는 세그 start/end 만 쓰고 refined 를 mutate 하지 않으므로 refine 과 병렬 안전.
    ts = time.time()
    faces = _load_json(out_dir / "faces.json")
    if faces and isinstance(faces, dict) and faces.get("clusters") is not None:
        step(f"얼굴 클러스터 — 체크포인트 재사용 ({len(faces.get('clusters', {}))} 클러스터)")
        # 저장된 매핑이 있으면 refined에 적용 (재실행 시 사용자 라벨 유지)
        try:
            from core.vision.faces import apply_mapping
            refined = apply_mapping(refined, faces.get("mapping") or {})
            _save_json(out_dir / "refined.json", refined)
        except Exception as e:
            step(f"  (매핑 적용 스킵: {str(e)[:70]})")
    elif faces_future is not None:
        _progress("faces", 55, "얼굴 검출 병렬 결과 대기")
        step("얼굴 검출·클러스터링 (병렬 join)…")
        try:
            _returned_refined, faces = faces_future.result()
            # apply_mapping 은 mapping 이 있을 때만 refined mutate. build_face_index 는 mapping 을
            # 비워서 반환하므로 (line 444) refined 는 실질 그대로. 저장은 스킵 (변경 없음).
            _save_json(out_dir / "faces.json", faces)
            step(f"  클러스터 {len(faces.get('clusters', {}))}개 · 라벨링 {faces.get('labeled_segments', 0)}/{len(refined)} 세그먼트")
        except Exception as e:
            step(f"  (얼굴 클러스터링 실패: {str(e)[:120]})")
            import traceback
            traceback.print_exc()
            faces = None
        finally:
            if faces_executor is not None:
                faces_executor.shutdown(wait=False)
    elif not _run_faces:
        # 위(159행)에서 "기본 skip" 을 이미 찍었다. 아래 순차 폴백으로 새면 RUN_FACES 게이트가
        # 무의미해지고, insightface/onnxruntime 이 없는 워커 이미지에서 매 회차 ModuleNotFoundError
        # 트레이스백만 남긴다 (실측 2026-08-08 · 잡은 안 죽지만 로그가 오염된다).
        faces = None
    else:
        # 병렬 시작 실패 폴백 — 순차 실행
        try:
            from core.vision.faces import build_face_index
            _progress("faces", 40, "얼굴 검출·클러스터링 중 (순차)")
            step("얼굴 검출·클러스터링…")
            _cast_photos_dir = out_dir / "cast_photos"
            refined, faces = build_face_index(
                video_path, refined, out_dir,
                on_progress=lambda done, total: _progress("faces", 40 + 12 * done / max(1, total), f"얼굴 검출 {done}/{total} 프레임"),
                cast_photos_dir=_cast_photos_dir if _cast_photos_dir.exists() else None,
            )
            _save_json(out_dir / "refined.json", refined)
            _save_json(out_dir / "faces.json", faces)
            step(f"  클러스터 {len(faces.get('clusters', {}))}개 · 라벨링 {faces.get('labeled_segments', 0)}/{len(refined)} 세그먼트")
        except Exception as e:
            step(f"  (얼굴 클러스터링 스킵: {str(e)[:120]})")
            import traceback
            traceback.print_exc()
            faces = None

    # 2.6) 얼굴 클러스터와 익명 화자의 시각적 연결만 저장한다.
    # Vision·등록 cast·대사 문맥으로 실명을 자동 추론하지 않는다. 이름 지정은 프론트 운영자만 한다.
    if isinstance(faces, dict) and faces.get("clusters"):
        # 화자↔얼굴 크로스매칭 (PyAnnote diarization 결과 있을 때만).
        # STT에 diarization_turns 있으면 시각 겹침 기반으로 익명 화자↔얼굴 클러스터만 연결한다.
        try:
            stt_data = _load_json(out_dir / "stt.json") or {}
            turns = stt_data.get("diarization_turns") or []
            if turns and faces and refined:
                from core.stt.speaker_face_map import map_speakers_to_face_clusters
                sf_map = map_speakers_to_face_clusters(faces, refined, turns)
                if sf_map.get("map"):
                    faces["speaker_face_map"] = sf_map
                    _save_json(out_dir / "faces.json", faces)
                    step(f"  화자↔얼굴 매핑 {len(sf_map['map'])}건: " +
                         ", ".join(f"{s}→{c}" for s, c in list(sf_map['map'].items())[:5]))


        except Exception as e:
            step(f"  (화자-얼굴 매핑 스킵: {str(e)[:80]})")

    timed("faces", ts)
    _progress("faces", 60, "얼굴 처리 완료")

    # 2.7) PPL join — analyze_stages.join_ppl 로 이동
    ppl = join_ppl(
        ppl_future=ppl_future, ppl_executor=ppl_executor,
        out_dir=out_dir, step=step, timed=timed,
    )

    # 2.9) 장르 확정 — **scenes·shots 앞에서** 해야 한다. 이 두 스테이지가 장르로 파라미터가
    #      갈리는데(청크 180s/300s · shot 임계 0.55/0.35), 예전엔 recommend(스테이지 18)에서야
    #      감지해서 앞 스테이지들이 "auto" 를 받아 폴백값으로 돌았다 — 드라마·예능 둘 다 틀린 값.
    #      비용 순증 0 (뒤에서 나가던 콜을 앞으로 옮김 · recommend 는 확정 장르 받으면 스킵).
    genre = run_detect_genre(
        refined=refined, genre=genre, out_dir=out_dir, step=step, timed=timed,
    )

    # 3) scenes 청크 분할 → analyze_stages.run_scenes
    scenes = run_scenes(refined=refined, out_dir=out_dir, genre=genre, step=step, timed=timed)

    # 4) cast + portraits → analyze_stages.run_cast_timeline
    cast = run_cast_timeline(
        scenes=scenes, out_dir=out_dir, cast_registry=cast_registry,
        step=step, timed=timed,
    )

    # 4d) timeline blocks — 2026-08-06 제거. UI 소비처 0 · narrative 도 scenes+refined 로 충분.
    # run_timeline 함수는 analyze_stages 에 남겨둠 (다시 살릴 수 있게).
    timeline = None

    # 4e) narrative → analyze_stages.run_narrative
    narrative = run_narrative(
        refined=refined, scenes=scenes, cast=cast, timeline=timeline, out_dir=out_dir,
        cast_registry=cast_registry, program_context=program_context, step=step, timed=timed,
    )

    # 4f) shot boundary → analyze_stages.run_shot_boundary (ffmpeg scene 필터 · narrative.segments 창만)
    shots_data = run_shot_boundary(
        video_path=video_path, refined=refined, narrative=narrative,
        out_dir=out_dir, genre=genre, step=step, timed=timed,
    )

    # 4g) scene_type → analyze_stages.run_scene_type (shot 대표 프레임 → Vision 분류)
    scene_type_data = run_scene_type(
        video_path=video_path, shots_data=shots_data, scenes=scenes,
        refined=refined, out_dir=out_dir, step=step, timed=timed,
    )

    # 4h) beats → analyze_stages.run_beats (GEBD or shots+STT gap fallback)
    beats_data = run_beats(
        scenes=scenes, refined=refined, shots_data=shots_data,
        out_dir=out_dir, step=step, timed=timed,
    )

    # 4h-2) beat 저수준 신호 → analyze_stages.run_beat_signals
    #       API ₩0 (ffmpeg 오디오 1패스 · 실측 4.5초/32분). beat_annot 앞에 둔다 — 신호가
    #       beats.json 에 먼저 실려야 이후 단계·인덱서가 같은 파일에서 읽는다.
    beats_data = run_beat_signals(
        video_path=video_path, beats_data=beats_data, refined=refined,
        shots_data=shots_data, out_dir=out_dir, step=step, timed=timed,
    )

    # 4i) beat annotate → analyze_stages.run_beat_annot
    beats_data = run_beat_annot(
        beats_data=beats_data, video_path=video_path, out_dir=out_dir,
        program_context=program_context, cast_registry=cast_registry,
        step=step, timed=timed,
    )

    # 4j) speaker identity → analyze_stages.run_speaker_identity (refined/beats_data in-place mutate)
    run_speaker_identity(
        refined=refined, beats_data=beats_data, out_dir=out_dir,
        step=step, timed=timed,
    )

    # 5) shorts recommend → analyze_stages.run_recommend
    rec = run_recommend(
        scenes=scenes, refined=refined, cast_registry=cast_registry,
        narrative=narrative, faces=faces, ppl=ppl, beats_data=beats_data,
        profile=profile, channels=channels, video_path=video_path,
        program_context=program_context, shorts_n=shorts_n, genre=genre,
        out_dir=out_dir, step=step, timed=timed,
    )
    shorts = rec["shorts"]

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
        "ppl": ppl or {},
        # viewer_signals — from-youtube 경로에서만 존재 (comments.json 있는 케이스). Lab 이 별도
        # GCS 파일 read 없이 analysis blob 한 번으로 시청자 목소리에 접근할 수 있게 함께 저장.
        "viewer_signals": (profile or {}).get("viewer_signals"),
        "took_sec": round(time.time() - t0, 1),
        "stage_sec": stage_took,
    }
    _save_json(out_dir / "analysis.json", result)
    step(f"완료 → {out_dir / 'analysis.json'}")

    # 검색 세그먼트 인덱싱 → segments.json. analyze_stages.index_search_segments 로 이동.
    index_search_segments(
        out_dir=out_dir, media_id=media_id,
        genre=rec.get("genre") or genre, resume=resume, step=step,
    )

    # Gemini usage 실측 dump. analyze_stages.dump_usage 로 이동.
    dump_usage(out_dir=out_dir, step=step)

    _progress("done", 100, "분석 완료")
    # 완료 마커 — 워커가 이걸 감지 즉시 DB write 시작. python close 이벤트 대기 안 함
    # (Windows에서 native library cleanup crash로 subprocess exit code non-zero 되어
    # 워커가 결과 무시하는 문제 우회). 2026-07-23.
    sys.stdout.write(f"@@COMPLETE {out_dir / 'analysis.json'}\n")
    sys.stdout.flush()
    return result


if __name__ == "__main__":
    from core.analyze_cli import main
    # Native library (InsightFace ONNX/DirectML) teardown 에서 Windows access violation
    # (0xC0000005 = -1073741819) 이 관찰됨 — 정상 완료 후에도 exit code non-zero가 되어
    # 워커가 결과를 무시하고 DB write 스킵. main() 정상 반환 즉시 os._exit(0)로 native
    # cleanup 건너뛰고 성공 exit code 보장. flush는 os._exit 전에 위험(flush 자체가 native
    # 콜 트리거)해 skip — 파이프라인 로그는 print()가 즉시 write 하므로 손실 없음.
    try:
        main()
        os._exit(0)
    except SystemExit as se:
        os._exit(int(se.code) if isinstance(se.code, int) else 0)
    except BaseException:
        import traceback
        traceback.print_exc()
        os._exit(1)
