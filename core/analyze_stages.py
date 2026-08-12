"""core.analyze 의 스테이지 helper 함수들 (2단계 분리).

analyze() 본체가 900줄 근처로 커진 걸 관리 가능한 조각으로 뽑는다. 여기 있는 helper 들은
`analyze()` 안에서 호출된다. 로컬 변수 공유가 심한 부분(refined·faces·beats·shorts)은 아직
`analyze()` 안에 두고, **자기완결적인 큰 블록만** 여기로.

포함:
- `run_fast_mode`     — --fast 경로 (자막만으로 완주)
- `load_viewer_signals` — comments.json → viewer_signals · profile 병합
- `dump_usage`        — Gemini usage 실측 로그·usage.json 저장

`docs/plans/analyze-py-split-plan.md` 의 스테이지 완전분리는 여전히 다음 세션.
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Callable

from core.analyze_utils import save_json, load_json, progress


# ── STT / refine / chyron / speaker_postproc ─────────────────────────────────
# 자기완결적 · refined 는 각자 output 을 반환해 caller 가 assign 하는 스타일.


def run_stt(
    *,
    video_path: str,
    out_dir: Path,
    cast_registry: list[dict] | None,
    step: Callable[[str], None],
    timed: Callable[[str, float], None],
) -> tuple[dict, list]:
    """관리형 STT (Soniox/Gemini/whisper). 반환: (stt_dict, segments_list).
    cast_registry 크기를 화자분리 KMeans 힌트로 사용 (실측 정확도↑)."""
    from core.stt.asr import transcribe, get_segments

    progress("stt", 3, "음성 인식 준비")
    ts = time.time()
    stt = load_json(out_dir / "stt.json")
    # ⚠️ 체크포인트는 **비어 있지 않을 때만** 재사용한다.
    # 예전 조건은 `if stt and "segments" in stt:` 였는데 `{"segments": []}` 도 통과했다.
    # Soniox 가 0토큰을 돌려주거나(무음·잘못된 오디오 트랙) Gemini 예외가 빈 결과로 강등되면
    # 빈 stt.json 이 저장되고, 그 뒤 scenes·beats 가 전부 비면서 @@COMPLETE 로 **성공 종료**했다.
    # 지문이 그대로라 **모든 재시도가 같은 빈 파일을 재사용** — ₩270 은 이미 나갔는데
    # 영원히 회복되지 않는다. 이웃 스테이지(scenes·beats·recommend)는 전부 비어있지 않음을
    # 요구한다. STT 만 예외였다.
    if stt and stt.get("segments"):
        step(f"STT — 체크포인트 재사용 ({len(stt['segments'])} 세그먼트)")
    else:
        if stt is not None:
            step("STT — 체크포인트가 비어 있어 다시 인식한다")
        step("STT (관리형)…")
        expected_speakers = len(cast_registry) if isinstance(cast_registry, list) and cast_registry else None
        stt = transcribe(
            video_path, language="ko",
            expected_speakers=expected_speakers,
            on_progress=lambda done, total: progress(
                "stt", 3 + 27 * done / max(1, total), f"음성 인식 {done}/{total} 윈도우"),
        )
        # 빈 결과를 체크포인트로 굳히지 않는다 — 굳으면 위와 같은 영구 고착이 된다.
        if not stt or not stt.get("segments"):
            raise RuntimeError(
                "STT 결과가 비어 있습니다 — 오디오 트랙이 없거나 인식이 실패했습니다. "
                "영상의 오디오를 확인하고 다시 시도하세요(빈 결과를 체크포인트로 저장하지 않았습니다)."
            )
        save_json(out_dir / "stt.json", stt)
    segments = get_segments(stt)
    step(f"  {len(segments)} 세그먼트")
    timed("stt", ts)
    progress("stt", 30, f"음성 인식 완료 · {len(segments)} 세그먼트")
    return stt, segments


def run_refine(
    *,
    segments: list,
    out_dir: Path,
    cast_registry: list[dict] | None,
    program_context: dict | None,
    step: Callable[[str], None],
    timed: Callable[[str, float], None],
) -> list:
    """자막 정제. 2026-07-31 축소 — STT_PROVIDER=soniox 일 땐 default skip (정확도 up 이라
    Gemini refine 대부분 불필요). RUN_REFINE=on 명시하면 강제 실행. 반환: refined 세그 리스트."""
    import os
    from core.stt.refine import refine_segments

    ts = time.time()
    refined = load_json(out_dir / "refined.json")
    stt_provider = (os.environ.get("STT_PROVIDER") or "soniox").lower()
    run_flag = (os.environ.get("RUN_REFINE") or "auto").lower()
    should_refine = (run_flag == "on") or (run_flag == "auto" and stt_provider != "soniox")
    if refined:
        step(f"자막 정제 — 체크포인트 재사용 ({len(refined)} 세그먼트)")
    elif not should_refine:
        step(f"자막 정제 — 스킵 (STT_PROVIDER={stt_provider} · RUN_REFINE={run_flag})")
        refined = segments  # raw STT 그대로 사용 (Soniox 는 이미 정확)
        save_json(out_dir / "refined.json", refined)
    else:
        step("자막 정제…")
        progress("refine", 31, "자막 정제 중")
        refined = refine_segments(segments, cast_registry=cast_registry, program_context=program_context)
        save_json(out_dir / "refined.json", refined)
    timed("refine", ts)
    progress("refine", 38, "자막 정제 완료")
    return refined


def run_chyron_per_seg(
    *,
    video_path: str,
    refined: list,
    out_dir: Path,
    step: Callable[[str], None],
    timed: Callable[[str, float], None],
    cast_registry: list[dict] | None = None,
) -> list:
    """chyron per-seg + speaker 실명 rewrite. env RUN_CHYRON_PER_SEG=0 로 스킵.
    실패해도 refined 원상태 유지."""
    import os
    if os.environ.get("RUN_CHYRON_PER_SEG", "1") == "0":
        return refined
    ts = time.time()

    # ⚠️ 체크포인트 게이트. 이웃 스테이지와 달리 이 함수는 **아무것도 확인하지 않고 매번
    # 다시 돌았다**(2026-08-12 발견). STT 세그먼트당 Vision 1회라 실측 662회 · 회차당 ≈₩150 이고,
    # content-pipeline 은 그 비용 때문에 chyron.json 을 GCS 로 왕복시켜 복원까지 해두는데
    # **읽는 게이트가 없어 그 복원이 무의미**했다. 재시도할 때마다 다시 샀다.
    #
    # chyron.json 은 refined.json 에 실명 rewrite 를 반영한 **뒤에만** 저장된다(아래 순서 참고).
    # 따라서 이 파일의 존재 = "이 미디어의 rewrite 는 이미 끝났다" 로 읽어도 안전하다.
    # 중간에 죽으면 chyron.json 이 없으므로 다시 돈다 — 안전한 방향이다.
    prior = load_json(out_dir / "chyron.json")
    if isinstance(prior, dict) and isinstance(prior.get("hits"), list):
        step(f"chyron per-seg — 체크포인트 재사용 ({len(prior['hits'])}건 · 재스캔 안 함)")
        timed("chyron_per_seg", ts)
        return refined

    try:
        from core.scenes.chyron_scan import scan_per_seg
        progress("chyron", 38, "화면 이름 태그 세그별 스캔")
        step("chyron per-seg (화면 이름 태그 → speaker 실명 rewrite)…")
        # roster = 프로그램 cast 사전등록 이름 **+ aliases**. 있으면 1회 등장이라도 실명으로
        # 인정한다 (등록이 primary · 빈도 휴리스틱은 등록이 없을 때의 보루).
        # aliases 를 빼면 안 된다 — 드라마는 배역명/본명/별명이 갈리고 화면 태그가 그중
        # 어느 쪽으로 뜰지 모른다. cast.load_registry 가 이미 aliases 를 파싱해 둔다.
        roster: list[str] = []
        for c in (cast_registry or []):
            if not isinstance(c, dict):
                continue
            for n in [c.get("name"), *(c.get("aliases") or [])]:
                n = str(n or "").strip()
                if n and n not in roster:
                    roster.append(n)
        refined, ps_stats = scan_per_seg(video_path, refined, workers=6, prefer_start=True,
                                         roster=roster or None)
        step(f"  {ps_stats.get('assigned', 0)}/{ps_stats.get('scanned', 0)} 세그에 실명 부여 · "
             f"unique={ps_stats.get('unique_names', 0)} · roster={len(roster)}")
        if ps_stats.get("dropped_low_vote"):
            step(f"  저빈도 컷(상황자막 오탐 추정): {ps_stats['dropped_low_vote']}")
        save_json(out_dir / "refined.json", refined)
        # 원 감지를 chyron.json 으로 남긴다 — core.index_segments 가 읽어 characters 근거로
        # 쓴다(검색 인물 필터). speaker 필드에만 두면 익명 화자 라벨과 구분이 안 된다.
        hits = ps_stats.get("hits") or []
        save_json(out_dir / "chyron.json", {"version": 1, "hits": hits})
        step(f"  chyron.json — 화면 이름 감지 {len(hits)}건")
    except Exception as e:
        step(f"  (chyron per-seg 스킵: {str(e)[:120]})")
    timed("chyron_per_seg", ts)
    return refined


def run_detect_genre(
    *,
    refined: list,
    genre: str,
    out_dir: Path,
    step: Callable[[str], None],
    timed: Callable[[str, float], None],
) -> str:
    """`--genre auto` 일 때만 도는 **폴백**. 정답 경로는 사람이 지정한 `program.pipelineGenre` 다.

    ⚠️ **장르는 사람 몫이다** (2026-08-06 방침). 프로그램당 1회 선택이고 운영자가 확실히 아는데,
    LLM 추측이 틀리면 청크 크기·shot 임계가 통째로 어긋나 하류 전체가 조용히 망가진다.
    `content-pipeline.ts` 가 `pipelineGenre` 를 넘기면 이 함수는 그대로 통과한다 — 그게 정상 경로고,
    여기 도달했다는 건 **프로그램에 장르가 미지정이라는 뜻**이라 UI 에서 채우는 게 근본 해결이다.

    왜 (폴백이라도) 여기냐: shot 임계값(shots.py `_SHOT_THRESHOLD_BY_GENRE`)과 청크 크기
    (scenes.py `_CHUNK_SEC_BY_GENRE`)가 장르로 갈리는데, 기존에는 `detect_genre` 가
    recommend(스테이지 18)에서야 돌아서 그 앞 스테이지들은 `"auto"` 를 받았다.
    `"auto"` 는 두 dict 어디에도 없어서 `.get()` 폴백이 걸린다:

        shot threshold → 항상 0.55  (드라마용 0.35 미도달 → 씬 컷을 못 잡음)
        scene chunk    → 항상 300s  (예능용 180s 미도달 → 코너 여러 개가 한 청크에 뭉개짐)

    **드라마·예능 둘 다 틀린 값으로 돌고 있었다** — 정확히 우리가 특화하려는 두 장르다.

    비용: Gemini flash 1콜(thinking_budget=0 · 대사 50줄). 뒤에서 어차피 나가던 콜을
    앞으로 옮기는 것이고, recommend 는 확정된 장르를 받으면 자기 감지를 건너뛴다
    (`recommend.py:3685` 의 `genre == "auto"` 가드) → **순증 0, 실질 콜 1회 감소.**

    입력이 scenes 가 아니라 refined 인 이유: scenes 는 genre 로 잘리므로 순환이다.
    `detect_genre` 는 `text` 키만 필수로 쓰고 나머지(vision·on_screen)는 없으면 빈 값으로
    처리한다 — 대사만으로도 드라마/예능 판별은 된다(극중 대사 vs 리액션·패널 코멘트).
    """
    if genre and genre != "auto":
        return genre
    ts = time.time()
    resolved = genre
    try:
        from google import genai
        from core.recommend.recommend import detect_genre, PROJECT, LOCATION
        progress("genre", 39, "장르 자동 감지")
        client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)
        resolved = detect_genre(client, refined)
        step(f"장르 미지정 → 자동판정 폴백 '{resolved}' "
             f"(⚠️ 프로그램에 장르를 지정하면 추측 없이 정확해집니다)")
        save_json(out_dir / "genre.json", {"genre": resolved, "source": "auto_fallback"})
    except Exception as e:
        step(f"  (장르 감지 스킵 → auto 유지: {str(e)[:100]})")
    timed("detect_genre", ts)
    return resolved


def run_speaker_postproc(
    *,
    refined: list,
    out_dir: Path,
    step: Callable[[str], None],
    timed: Callable[[str, float], None],
) -> list:
    """짧은 세그 흡수·empty 인접 계승·접속사 계승. env RUN_SPEAKER_POSTPROC=0 로 스킵."""
    import os
    if os.environ.get("RUN_SPEAKER_POSTPROC", "1") == "0":
        return refined
    ts = time.time()
    try:
        from core.stt.speaker_postproc import postprocess as _sp_postproc
        refined, pp_stats = _sp_postproc(refined)
        step(f"  speaker 후처리 (짧은 흡수·empty 계승·접속사): {pp_stats}")
        save_json(out_dir / "refined.json", refined)
    except Exception as e:
        step(f"  (speaker 후처리 스킵: {str(e)[:120]})")
    timed("speaker_postproc", ts)
    return refined



def run_fast_mode(
    *,
    video_path: str,
    out_dir: Path,
    segments: list,
    shorts_n: int,
    genre: str,
    profile: dict | None,
    channels: list[str] | None,
    cast_registry: list[dict] | None,
    program_context: dict | None,
    t0: float,
    stage_took: dict[str, float],
    step: Callable[[str], None],
    timed: Callable[[str, float], None],
) -> dict:
    """--fast 경로. 자막 세그먼트만으로 shorts 추천. 시각 분석·서사·비전 스킵 · 긴 영상
    분석 시간의 최대 74% 절감. 대사 기반 콘텐츠에 적합. analyze() 가 fast=True 일 때만 호출."""
    from core.scenes.scenes import scenes_from_transcript
    from core.recommend.recommend import recommend

    step("빠른 모드 — 자막 세그먼트로 추천 (시각 분석 스킵)")
    scenes = scenes_from_transcript(segments)
    step(f"  {len(scenes)} 자막 장면")
    progress("recommend", 50, "쇼츠 추천 중 (빠른 모드)")
    ts = time.time()
    rec = recommend(
        scenes, n=shorts_n, genre=genre, profile=profile, channels=channels,
        transcript=segments, cast_registry=cast_registry,
        program_context=program_context,
        on_progress=lambda done, total: progress(
            "recommend", 50 + 45 * done / max(1, total), f"후보 추출 {done}/{total} 구간"),
    )
    timed("recommend", ts)
    shorts = rec["shorts"]
    duration = scenes[-1]["end"] if scenes else (segments[-1]["end"] if segments else 0)
    result = {
        "video": str(video_path), "duration": duration, "genre": rec.get("genre"),
        "transcript": segments, "scenes": scenes, "cast": [], "timeline": [],
        "narrative": {}, "shorts": shorts, "fast": True,
        "viewer_signals": (profile or {}).get("viewer_signals"),
        "took_sec": round(time.time() - t0, 1), "stage_sec": stage_took,
    }
    save_json(out_dir / "analysis.json", result)
    step(f"완료 (빠른 모드) — {len(shorts)} 쇼츠 · {result['took_sec']}s")
    progress("done", 100, "분석 완료 (빠른 모드)")
    return result


def load_viewer_signals(
    *,
    out_dir: Path,
    segments: list,
    profile: dict | None,
    step: Callable[[str], None],
    timed: Callable[[str, float], None],
) -> dict | None:
    """comments.json 이 있으면 build_viewer_signals 로 신호 뽑고 · profile 에 병합해 반환.
    없으면 원본 profile 그대로. 실패해도 파이프라인은 원상태 계속."""
    viewer_signals_path = out_dir / "comments.json"
    if not viewer_signals_path.exists():
        return profile

    ts = time.time()
    vs = load_json(out_dir / "viewer_signals.json")
    if isinstance(vs, dict) and (vs.get("top_moments") or vs.get("explicit_timestamps") or vs.get("dominant_emotion")):
        step(f"시청자 신호 — 체크포인트 재사용 (moments {len(vs.get('top_moments') or [])})")
    else:
        try:
            from core.recommend.comment_signal import build_viewer_signals
            comments = load_json(viewer_signals_path) or []
            dur = float(segments[-1].get("end") or 0) if segments else None
            step(f"시청자 신호 생성 (댓글 {len(comments)}개)…")
            vs = build_viewer_signals(comments, duration_sec=dur)
            save_json(out_dir / "viewer_signals.json", vs)
            step(f"  moments {len(vs.get('top_moments') or [])}"
                 f" · timestamps {len(vs.get('explicit_timestamps') or [])}"
                 f" · emotion '{vs.get('dominant_emotion') or '-'}'")
        except Exception as e:
            step(f"  (viewer_signals 생성 스킵: {str(e)[:80]})")
            vs = None
    timed("viewer_signals", ts)

    if isinstance(vs, dict) and (vs.get("top_moments") or vs.get("explicit_timestamps") or vs.get("dominant_emotion")):
        merged = dict(profile or {})
        merged["viewer_signals"] = vs
        return merged
    return profile


def index_search_segments(
    *,
    out_dir: Path,
    media_id: str,
    genre: str,
    resume: bool,
    step: Callable[[str], None],
) -> None:
    """beats 등 산출을 검색 레코드로 재조립(+임베딩) → segments.json.
    content-pipeline 이 pgvector(search_segments)에 적재. best-effort — 실패해도 분석 결과는
    성립(검색만 비게 됨). 임베딩 실패는 embed 내부에서 None 처리."""
    try:
        from core.search.index_segments import build_segments
        _existing = load_json(out_dir / "segments.json")
        _has_emb = isinstance(_existing, dict) and any(
            s.get("emb_dialogue") for s in (_existing.get("segments") or []))
        # ⚠️ 임베딩 유무만 보면 안 된다 — beats 가 바뀌어도 "재사용"해 버린다.
        # segments 는 beat 단위 레코드이므로 beat 개수가 다르면 통째로 낡은 것이다
        # (2026-08-07: beats 413개인데 segments 는 182개로 남아 있었다).
        _beats = load_json(out_dir / "beats.json") or {}
        _n_beats = len(_beats.get("beats") or [])
        _stale = _n_beats > 0 and int(_existing.get("count") or 0) != _n_beats \
            if isinstance(_existing, dict) else False
        if resume and _has_emb and not _stale:
            step(f"검색 인덱스 — 체크포인트 재사용 ({_existing.get('count')} 세그먼트)")
            return
        if _stale:
            step(f"검색 인덱스 — beats {_n_beats}개 ≠ segments {_existing.get('count')}개 → 재생성")
        step("검색 세그먼트 인덱싱…")
        seg_result = build_segments(out_dir, media_id=media_id, genre=genre, embed=True)
        save_json(out_dir / "segments.json", seg_result)
        step(f"  {seg_result['count']} 검색 세그먼트 → segments.json")
    except Exception as e:
        step(f"검색 인덱싱 실패(무시): {str(e)[:120]}")


def join_ppl(
    *,
    ppl_future,
    ppl_executor,
    out_dir: Path,
    step: Callable[[str], None],
    timed: Callable[[str, float], None],
) -> dict | None:
    """백그라운드 PPL future join · 없으면 캐시 사용. 반환: ppl dict 또는 None."""
    ts = time.time()
    ppl: dict | None = None
    if ppl_future is not None:
        progress("ppl", 53, "PPL 병렬 결과 대기 중")
        step("PPL·브랜드 검출 (병렬 join)…")
        try:
            ppl = ppl_future.result()
            save_json(out_dir / "ppl.json", ppl)
            step(f"  검출 구간 {len(ppl.get('detections', []))}개 · 브랜드 {len(ppl.get('brand_summary', {}))}종")
        except Exception as e:
            step(f"  (PPL 검출 스킵: {str(e)[:120]})")
            import traceback
            traceback.print_exc()
            ppl = None
        finally:
            if ppl_executor is not None:
                ppl_executor.shutdown(wait=False)
    else:
        cached = load_json(out_dir / "ppl.json")
        if cached and isinstance(cached, dict) and cached.get("detections") is not None:
            ppl = cached
            step(f"PPL 검출 — 체크포인트 재사용 ({len(ppl['detections'])} 구간 · {len(ppl.get('brand_summary', {}))} 브랜드)")
    timed("ppl", ts)
    progress("ppl", 60, "PPL 검출 완료")
    return ppl


def run_scenes(
    *,
    refined: list,
    out_dir: Path,
    genre: str,
    step: Callable[[str], None],
    timed: Callable[[str, float], None],
) -> list:
    """장르별 5분 청크 (variety 180s · drama 300s). 반환: scenes list."""
    from core.scenes.scenes import scenes_from_duration_chunks

    ts = time.time()
    scenes = load_json(out_dir / "scenes.json")
    if scenes:
        step(f"청크 분할 — 체크포인트 재사용 ({len(scenes)} 청크)")
    else:
        step(f"청크 분할 (genre={genre})…")
        progress("scenes", 40, "청크 분할 중")
        scenes = scenes_from_duration_chunks(refined, genre=genre)
        save_json(out_dir / "scenes.json", scenes)
    step(f"  {len(scenes)} 청크")
    timed("scenes", ts)
    progress("scenes", 50, f"청크 분할 완료 · {len(scenes)} 청크")
    return scenes


def run_cast_timeline(
    *,
    scenes: list,
    out_dir: Path,
    cast_registry: list[dict] | None,
    step: Callable[[str], None],
    timed: Callable[[str, float], None],
) -> dict | None:
    """cast timeline + portraits (한 스텝으로 병합). 반환: cast dict 또는 None."""
    ts = time.time()
    cast = load_json(out_dir / "cast.json")
    if cast and isinstance(cast, dict) and cast.get("people") is not None and cast.get("portraitsGenerated"):
        step(f"출연자 타임라인·포트레이트 — 체크포인트 재사용 ({len(cast['people'])}명)")
        timed("cast", ts)
        return cast
    try:
        from core.vision.cast import build_cast_timeline
        progress("cast", 55, "출연자 타임라인 구성")
        cast = build_cast_timeline(scenes, cast_registry or [])
        step(f"  캐스트 확정 {cast.get('matchedCount', 0)}명 · 후보 {cast.get('candidateCount', 0)}명")
        save_json(out_dir / "cast.json", cast)
        if isinstance(cast, dict) and cast.get("people"):
            try:
                from core.vision.portraits import build_portraits
                progress("cast", 65, "출연진 포트레이트 생성")
                cast = build_portraits(
                    cast, scenes, out_dir,
                    on_progress=lambda done, total: progress(
                        "cast", 65 + 5 * done / max(1, total), f"포트레이트 {done}/{total}"),
                )
                save_json(out_dir / "cast.json", cast)
                made = sum(1 for p in cast["people"] if p.get("thumbnail"))
                step(f"  포트레이트 {made}명 생성")
            except Exception as e:
                step(f"  (포트레이트 건너뜀: {str(e)[:70]})")
    except Exception as e:
        step(f"  (캐스트 타임라인 건너뜀: {str(e)[:70]})")
        cast = None
    timed("cast", ts)
    return cast


def run_timeline(
    *,
    scenes: list,
    out_dir: Path,
    step: Callable[[str], None],
    timed: Callable[[str, float], None],
) -> dict | None:
    """N분 단위 블록 요약. 반환: timeline dict 또는 None."""
    ts = time.time()
    timeline = load_json(out_dir / "timeline.json")
    if isinstance(timeline, dict) and timeline.get("blocks"):
        step(f"타임라인 — 체크포인트 재사용 ({len(timeline['blocks'])} 블록)")
    else:
        try:
            from core.scenes.timeline import build_timeline
            progress("timeline", 76, "구간 요약 생성")
            timeline = build_timeline(
                scenes,
                on_progress=lambda done, total: progress(
                    "timeline", 76 + 3 * done / max(1, total), f"구간 요약 {done}/{total} 배치"),
            )
            save_json(out_dir / "timeline.json", timeline)
            step(f"타임라인 — {len(timeline['blocks'])} 블록 ({timeline['block_minutes']}분 단위)")
        except Exception as e:
            step(f"  (타임라인 건너뜀: {str(e)[:70]})")
            timeline = None
    timed("timeline", ts)
    return timeline


def run_narrative(
    *,
    refined: list,
    scenes: list,
    cast: dict | None,
    timeline: dict | None,
    out_dir: Path,
    cast_registry: list[dict] | None,
    program_context: dict | None,
    step: Callable[[str], None],
    timed: Callable[[str, float], None],
) -> dict | None:
    """서사 요약 · 구간별 · 인물 · 갈등. 반환: narrative dict 또는 None."""
    from core.beats.narrative import build_narrative

    ts = time.time()
    narrative = load_json(out_dir / "narrative.json")
    if isinstance(narrative, dict) and (
        narrative.get("full_summary") or narrative.get("segments")
        or narrative.get("characters") or narrative.get("key_conflicts")
    ):
        step(f"서사 요약 — 체크포인트 재사용 ({len(narrative.get('segments') or [])} 구간)")
    else:
        try:
            progress("narrative", 82, "서사 요약 생성")
            narrative = build_narrative(
                refined, scenes, cast, timeline,
                on_progress=lambda done, total: progress(
                    "narrative", 82 + 3 * done / max(1, total), f"서사 요약 {done}/{total} 배치"),
                cast_registry=cast_registry, program_context=program_context,
            )
            save_json(out_dir / "narrative.json", narrative)
            step(f"서사 요약 — {len(narrative.get('segments', []))} 구간 · 갈등 {len(narrative.get('key_conflicts', []))}건")
        except Exception as e:
            step(f"  (서사 요약 건너뜀: {str(e)[:70]})")
            import traceback
            traceback.print_exc()
            narrative = None
    timed("narrative", ts)
    return narrative


def run_shot_boundary(
    *,
    video_path: str,
    refined: list,
    narrative: dict | None,
    out_dir: Path,
    genre: str,
    step: Callable[[str], None],
    timed: Callable[[str, float], None],
) -> dict:
    """프레임 diff 기반 shot boundary detection. narrative.segments 창만 스캔.
    반환: {"shots": [...], "windows": N, "threshold": T, "fps": 1, "genre": g}"""
    from core.scenes.shots import detect_shots

    ts = time.time()
    shots_data = load_json(out_dir / "shots.json")
    if isinstance(shots_data, dict) and isinstance(shots_data.get("shots"), list):
        step(f"shot boundary — 체크포인트 재사용 ({len(shots_data['shots'])}개)")
        timed("shots", ts)
        return shots_data

    progress("shots", 83, "shot boundary 감지")
    windows: list[tuple[float, float]] = []
    if isinstance(narrative, dict) and isinstance(narrative.get("segments"), list):
        for s in narrative["segments"]:
            try:
                st = float(s.get("start", 0)); en = float(s.get("end", 0))
                if en > st:
                    windows.append((st, en))
            except (TypeError, ValueError):
                continue
    if not windows and refined:
        try:
            total = float(refined[-1].get("end", 0))
            if total > 0:
                windows = [(0.0, total)]
        except (TypeError, ValueError, IndexError):
            pass
    try:
        shots_list = detect_shots(str(video_path), windows, fps=1, genre=genre) if windows else []
        from core.scenes.shots import _SHOT_THRESHOLD_BY_GENRE, _DEFAULT_SHOT_THRESHOLD
        used_th = _SHOT_THRESHOLD_BY_GENRE.get(genre or "", _DEFAULT_SHOT_THRESHOLD)
        # windows_sec = **실제 스캔한 구간**. 이게 없으면 스캔 밖 구간의 "컷 0개"를
        # "컷 없음"으로 오독하게 된다(core.signals 의 cut_rate 가 거짓 0이 됨).
        # 실측(m_981d7c08): 창 7개만 스캔해 beat 74%가 미스캔이었다. (2026-08-06)
        covered = round(sum(e - s for s, e in windows), 1)
        shots_data = {"shots": shots_list, "windows": len(windows),
                      "windows_sec": [[round(s, 2), round(e, 2)] for s, e in windows],
                      "covered_sec": covered,
                      "threshold": used_th, "fps": 1, "genre": genre}
        save_json(out_dir / "shots.json", shots_data)
        step(f"shot boundary — {len(shots_list)}개 (창 {len(windows)}개 · {covered:.0f}s 스캔, "
             f"threshold={used_th}, genre={genre})")
    except Exception as e:
        # 이번 회차는 빈 값으로 진행한다(전체를 실패시키지 않는다) — 여기까지는 의도대로다.
        # ⚠️ 다만 **체크포인트로 저장하지 않는다.** 저장하면 위 게이트(`isinstance(list)`)가
        #    빈 리스트도 통과시켜서, ffmpeg/Vertex 가 한 번 딸꾹질한 미디어는 shots 가
        #    **영구히 빈 채로 고정**되고 어떤 재시도로도 회복되지 않는다.
        step(f"  (shot boundary 실패 · 이번 회차만 빈 리스트로 진행 · 체크포인트 미저장: {str(e)[:70]})")
        shots_data = {"shots": [], "windows": 0, "threshold": 0.55, "fps": 1}
    timed("shots", ts)
    return shots_data


def run_scene_type(
    *,
    video_path: str,
    shots_data: dict,
    scenes: list,
    refined: list,
    out_dir: Path,
    step: Callable[[str], None],
    timed: Callable[[str, float], None],
) -> dict:
    """shot 대표 프레임 → Gemini Vision batch → interview/on_scene/other 분류."""
    from core.scenes.scene_type import classify_shot_types

    ts = time.time()
    scene_type_data = load_json(out_dir / "scene_type.json")
    if isinstance(scene_type_data, dict) and isinstance(scene_type_data.get("shot_types"), list):
        step(f"scene_type — 체크포인트 재사용 ({len(scene_type_data['shot_types'])} shot)")
        timed("scene_type", ts)
        return scene_type_data

    progress("scene_type", 83, "shot 유형 분류 (interview/on_scene)")
    try:
        duration_for_st = float(scenes[-1]["end"]) if scenes else (float(refined[-1]["end"]) if refined else 0.0)
        shot_types = classify_shot_types(
            str(video_path),
            (shots_data or {}).get("shots") or [],
            duration_for_st,
            out_dir / "shot_frames",
        )
        scene_type_data = {"shot_types": shot_types}
        save_json(out_dir / "scene_type.json", scene_type_data)
        step(f"scene_type — {len(shot_types)} shot 분류 완료")
    except Exception as e:
        # shots 와 같은 이유로 **저장하지 않는다** — 빈 체크포인트는 게이트를 통과해 고착된다.
        step(f"  (scene_type 실패 · 이번 회차만 빈 리스트로 진행 · 체크포인트 미저장: {str(e)[:70]})")
        scene_type_data = {"shot_types": []}
    timed("scene_type", ts)
    return scene_type_data


def run_beats(
    *,
    scenes: list,
    refined: list,
    shots_data: dict,
    out_dir: Path,
    step: Callable[[str], None],
    timed: Callable[[str, float], None],
) -> dict:
    """GEBD boundary (있으면) · 없으면 shots+STT gap fallback → beats."""
    from core.beats.beats import build_beats_from_boundaries
    from core.scenes.boundaries import load_boundaries, dedup_boundaries, build_fallback_boundaries, save_boundaries, merge_boundaries

    ts = time.time()
    beats_data = load_json(out_dir / "beats.json")
    if isinstance(beats_data, dict) and isinstance(beats_data.get("beats"), list) and beats_data["beats"]:
        step(f"beat — 체크포인트 재사용 ({len(beats_data['beats'])}개)")
        timed("beats", ts)
        return beats_data

    progress("beats", 84, "편집 단위(beat) 생성")
    try:
        duration_for_beats = float(scenes[-1]["end"]) if scenes else (float(refined[-1]["end"]) if refined else 0.0)
        gebd_boundaries = load_boundaries(out_dir / "boundaries.json")
        if gebd_boundaries:
            import os as _os
            _from_model = any(str(b.get("source", "")).startswith("gebd") for b in gebd_boundaries)
            # ffmpeg 컷 병합은 **옵트인**(`GEBD_MERGE_SHOTS=1`). 기본은 GEBD 단독이다.
            #
            # 2026-08-06 실측으로 고른 기본값이다. 학습 스키마의 주 타깃은
            # `Change due to cut ∪ Change of action` 이라 병합이 이론상 맞아 보이지만,
            # 실제로 재보니 **beat 을 크게 잡고 싶다는 목적에는 GEBD 단독이 낫다**:
            #
            #   경계 소스            beat 수  평균   p50    max     분포
            #   fallback(346)         239    30.3   18.2  137.6   심한 치우침
            #   GEBD∪ffmpeg(296)      218    41.0   40.1   71.5   중간
            #   GEBD 단독(132)        182    63.2   63.1   75.1   ← 가장 균일
            #
            # GEBD 단독이 p90 70.6·max 75.1 로 가장 고르고, 최종 쇼츠 길이는 어느 쪽이든
            # 중앙 41~42초로 같다(beat 은 출력 길이가 아니라 조립 단위다).
            # 컷까지 필요하면 GEBD_MERGE_SHOTS=1, 크기는 min_beat_sec 로 따로 조절할 것.
            if _from_model and _os.environ.get("GEBD_MERGE_SHOTS") == "1":
                _before = len(gebd_boundaries)
                gebd_boundaries = merge_boundaries(
                    gebd_boundaries, (shots_data or {}).get("shots") or [], duration_for_beats)
                step(f"boundary 병합(GEBD_MERGE_SHOTS=1) — GEBD {_before}개 + ffmpeg 컷 "
                     f"{len((shots_data or {}).get('shots') or [])}개 → {len(gebd_boundaries)}개")
            else:
                gebd_boundaries = dedup_boundaries(gebd_boundaries, duration=duration_for_beats)
            # ⚠️ 파일이 있다고 GEBD 가 아니다 — 직전 실행의 **fallback 산출물**도 여기 저장된다.
            # "GEBD boundary N개 기반"이라고 못 박으면 학습모델이 도는 줄 오해한다(실측 2회 오인).
            # source 를 그대로 찍어 근거를 드러낸다. `gebd*` 면 진짜 모델, 아니면 fallback 재사용.
            _srcs = {b.get("source") for b in gebd_boundaries if isinstance(b, dict)}
            _src = "/".join(sorted(s for s in _srcs if s)) or "unknown"
            _is_model = any(str(s).startswith("gebd") for s in _srcs if s)
            step(f"beat — boundary {len(gebd_boundaries)}개 재사용 · source={_src}"
                 f"{' (학습모델)' if _is_model else ' (fallback 산출물)'}")
        else:
            fallback = build_fallback_boundaries(
                (shots_data or {}).get("shots") or [], refined, duration_for_beats,
            )
            save_boundaries(out_dir / "boundaries.json", fallback,
                             source="shots+stt_gap", model="fallback", time_unit=1.0)
            gebd_boundaries = fallback
            step(f"beat — GEBD 없음 · shots+STT gap fallback {len(fallback)}개")
        beats_data = build_beats_from_boundaries(gebd_boundaries, refined, duration_for_beats)
        save_json(out_dir / "beats.json", beats_data)
        step(f"beat — {len(beats_data.get('beats') or [])}개 생성")
    except Exception as e:
        step(f"  (beat 생성 실패 · 빈 리스트로 진행: {str(e)[:70]})")
        import traceback
        traceback.print_exc()
        beats_data = {"beats": []}
        save_json(out_dir / "beats.json", beats_data)
    timed("beats", ts)
    return beats_data


def run_beat_signals(
    *,
    video_path: str,
    beats_data: dict,
    refined: list,
    shots_data: dict,
    out_dir: Path,
    step: Callable[[str], None],
    timed: Callable[[str, float], None],
) -> dict:
    """beat 단위 저수준 신호(오디오·컷·대사) → signals.json + beats.json 병합.

    **비용 API ₩0** — ffmpeg 오디오 1패스 + 이미 메모리에 있는 shots·refined 산술.
    실측(m_981d7c08 · 32분): 4.5초.

    왜 필요한가: 이게 없으면 하이라이트 판정에 LLM 감 말고 근거가 없다.
    `index_segments._highlight_score` 가 순환 정의(LLM 이 고른 것만 점수 높음)로 남는다.
    상세는 `core/signals.py` 도크스트링.
    """
    ts = time.time()
    beats_list = (beats_data or {}).get("beats") or []
    if not beats_list:
        return beats_data
    existing = load_json(out_dir / "signals.json")
    if isinstance(existing, dict) and existing.get("signals"):
        sig = existing
        step(f"beat signals — 체크포인트 재사용 ({len(sig['signals'])}개)")
    else:
        try:
            from core.recommend.signals import beat_signals
            progress("signals", 86, "저수준 신호(오디오·컷·대사)")
            sig = beat_signals(
                str(video_path), beats_list, refined,
                (shots_data or {}).get("shots") or [],
                (shots_data or {}).get("windows_sec"),
            )
            save_json(out_dir / "signals.json", sig)
            st = sig["stats"]
            # 미스캔 0 과 "판정 불가"를 구분해서 찍는다 — 구버전 shots.json(windows_sec 없음)
            # 에서 "미스캔 0"이라고 하면 cut_rate 를 믿어도 된다고 오독하게 된다.
            cut_note = (f"cut 미스캔 {st['cut_rate_unscanned']}" if st["shot_windows_known"]
                        else "cut 스캔범위 미상(구버전 shots.json)")
            step(f"beat signals — {st['beats']}개 (audio={st['audio']} · {cut_note})")
        except Exception as e:
            step(f"  (beat signals 스킵: {str(e)[:100]})")
            timed("beat_signals", ts)
            return beats_data

    # beats.json 에 병합 — index_segments 가 beat 에서 바로 읽어 세그먼트 레코드에 싣는다.
    table = sig.get("signals") or {}
    for b in beats_list:
        s = table.get(str(b.get("id")))
        if s:
            b["signals"] = s
    save_json(out_dir / "beats.json", beats_data)
    timed("beat_signals", ts)
    return beats_data


def run_beat_annot(
    *,
    beats_data: dict,
    video_path: str,
    out_dir: Path,
    program_context: dict | None,
    step: Callable[[str], None],
    timed: Callable[[str, float], None],
) -> dict:
    """각 beat 프레임 3장 + STT + program_context → Gemini → title/summary/characters."""
    import os
    from core.beats.beat_annot import annotate_beats

    ts = time.time()
    beats_list = (beats_data or {}).get("beats") or []
    already = sum(1 for b in beats_list if (b.get("title") or "").strip())
    if beats_list and already < len(beats_list):
        progress("beat_annot", 85, f"beat 서사 캡션 · Vision × {len(beats_list) - already}")
        try:
            annotate_beats(
                beats_list, video_path=str(video_path), out_dir=out_dir,
                program_context=program_context,
                workers=int(os.environ.get("BEAT_ANNOT_WORKERS") or 4),
                on_progress=lambda done, total: progress(
                    "beat_annot", 85 + 1 * done / max(1, total), f"beat annotate {done}/{total}"),
            )
            beats_data["beats"] = beats_list
            save_json(out_dir / "beats.json", beats_data)
            step(f"beat annotate — 완료")
        except Exception as e:
            step(f"  (beat annotate 실패 · title/summary 없이 진행: {str(e)[:70]})")
    elif beats_list:
        step(f"beat annotate — 체크포인트 재사용 ({already}/{len(beats_list)})")
    timed("beat_annot", ts)
    return beats_data


def run_speaker_identity(
    *,
    refined: list,
    beats_data: dict,
    out_dir: Path,
    step: Callable[[str], None],
    timed: Callable[[str, float], None],
) -> None:
    """짧은 발화 상속 (2s 미만 · 앞뒤 같은 화자면 상속) → S1/S2/… 익명 라벨 부여.
    실명(한글 2자 이상)은 그대로 speaker_name 보존. beats.characters 도 S 라벨로 갱신.
    반환값 없음 · refined/beats_data in-place mutate + speaker_identity_map.json 저장."""
    import re as _re

    if not refined:
        return
    ts = time.time()
    beats_list = (beats_data or {}).get("beats") or []

    # (a) 짧은 발화 상속: duration < 2s 이고 앞뒤 speaker 가 같으면 상속.
    _MIN_STABLE_SEC = 2.0
    swaps = 0
    for i, seg in enumerate(refined):
        try:
            dur = float(seg.get("end", 0)) - float(seg.get("start", 0))
        except (TypeError, ValueError):
            continue
        if dur >= _MIN_STABLE_SEC:
            continue
        cur = (seg.get("speaker") or "").strip()
        if not cur:
            continue
        prev = (refined[i - 1].get("speaker") or "").strip() if i > 0 else ""
        nxt = (refined[i + 1].get("speaker") or "").strip() if i + 1 < len(refined) else ""
        new_sp = cur
        if prev and nxt and prev == nxt and prev != cur:
            new_sp = prev
        elif prev == cur or nxt == cur:
            pass
        elif prev and (not nxt or prev):
            candidates = []
            if prev:
                p_dur = float(refined[i - 1].get("end", 0)) - float(refined[i - 1].get("start", 0))
                candidates.append((prev, p_dur))
            if nxt:
                n_dur = float(refined[i + 1].get("end", 0)) - float(refined[i + 1].get("start", 0))
                candidates.append((nxt, n_dur))
            candidates.sort(key=lambda x: -x[1])
            if candidates and candidates[0][1] >= _MIN_STABLE_SEC:
                new_sp = candidates[0][0]
        if new_sp != cur:
            seg["speaker"] = new_sp
            swaps += 1
    if swaps:
        step(f"  짧은 발화 상속 · {swaps} seg 병합")

    # (b) 익명 라벨 → S1/S2/... 정규화. chyron 실명(한글) 은 speaker_name 유지.
    _KOREAN_NAME = _re.compile(r"^[가-힯]{2,}$")
    id_map: dict[str, str] = {}
    for seg in refined:
        sp = (seg.get("speaker") or "").strip()
        if not sp:
            seg["speaker_id"] = ""
            seg["speaker_name"] = ""
            continue
        if sp not in id_map:
            id_map[sp] = f"S{len(id_map) + 1}"
        seg["speaker_id"] = id_map[sp]
        seg["speaker_name"] = sp if _KOREAN_NAME.match(sp) else ""
    for b in beats_list:
        chars = b.get("characters") or []
        b["speaker_ids"] = [id_map.get(c, c) for c in chars if c]
        b["speaker_names"] = [c for c in chars if c and _KOREAN_NAME.match(c)]
    save_json(out_dir / "refined.json", refined)
    if beats_list:
        save_json(out_dir / "beats.json", beats_data)
    identity_map = {
        "version": 1,
        "speakers": [
            {"speaker_id": sid, "raw_label": raw, "name": "", "confidence": 0.0,
             "evidence": [], "status": "unconfirmed"}
            for raw, sid in id_map.items()
        ],
    }
    save_json(out_dir / "speaker_identity_map.json", identity_map)
    step(f"speaker identity — {len(id_map)}명 익명 (S1~S{len(id_map)}) · 실명 미확정 (편집자 검수 후 확정)")
    timed("speaker_rename", ts)


def run_recommend(
    *,
    scenes: list,
    refined: list,
    cast_registry: list[dict] | None,
    narrative: dict | None,
    faces: dict | None,
    ppl: dict | None,
    beats_data: dict,
    profile: dict | None,
    channels: list[str] | None,
    video_path: str,
    program_context: dict | None,
    shorts_n: int,
    genre: str,
    out_dir: Path,
    step: Callable[[str], None],
    timed: Callable[[str, float], None],
) -> dict:
    """두 파이프라인 스위칭 (RECOMMEND_MODE=narrative_first default · chunk_scan fallback).
    반환: {"shorts": [...], "genre": ...}"""
    import os
    from core.recommend.recommend import recommend, recommend_narrative_first

    ts = time.time()
    rec = load_json(out_dir / "shorts.json")
    if not (isinstance(rec, dict) and isinstance(rec.get("shorts"), list) and rec.get("shorts")):
        step("쇼츠 추천…")
        progress("recommend", 85, "쇼츠 추천 중")
        mode = os.environ.get("RECOMMEND_MODE") or "narrative_first"
        if mode == "narrative_first":
            rec = recommend_narrative_first(
                scenes, n=shorts_n, genre=genre, profile=profile, channels=channels,
                transcript=refined, cast_registry=cast_registry,
                narrative=narrative if isinstance(narrative, dict) else None,
                faces=faces if isinstance(faces, dict) else None,
                ppl_detections=(ppl or {}).get("detections") if isinstance(ppl, dict) else None,
                video_path=str(video_path), program_context=program_context,
                beats=(beats_data or {}).get("beats") or [],
                on_progress=lambda done, total: progress(
                    "recommend", 85 + 10 * done / max(1, total), f"쇼츠 pool·선정 {done}/{total}"),
            )
        else:
            rec = recommend(
                scenes, n=shorts_n, genre=genre, profile=profile, channels=channels,
                transcript=refined, cast_registry=cast_registry,
                narrative_segments=(narrative or {}).get("segments") if isinstance(narrative, dict) else None,
                key_conflicts=(narrative or {}).get("key_conflicts") if isinstance(narrative, dict) else None,
                ppl_detections=(ppl or {}).get("detections") if isinstance(ppl, dict) else None,
                program_context=program_context,
                on_progress=lambda done, total: progress(
                    "recommend", 85 + 10 * done / max(1, total), f"후보 추출 {done}/{total} 구간"),
            )
        save_json(out_dir / "shorts.json", rec)
    else:
        step(f"쇼츠 추천 — 체크포인트 재사용 ({len(rec['shorts'])}개)")
    shorts = rec["shorts"]
    step(f"  {len(shorts)} 쇼츠 (장르: {rec.get('genre')})")
    timed("recommend", ts)
    progress("recommend", 95, f"쇼츠 추천 완료 · {len(shorts)}개")
    return rec


def dump_usage(*, out_dir: Path, step: Callable[[str], None]) -> None:
    """Gemini usage 실측 dump — 회당 실비 관측 (2026-08-06). retry.py 가 hook 해서 누적.
    호출은 analyze() 마지막에서 한 번."""
    try:
        from core.common.retry import usage_summary
        u = usage_summary()
        step(f"[usage] calls={u['calls']} · in={u['in_tokens']:,} out={u['out_tokens']:,} "
             f"토큰 · 대략 ₩{u['est_krw']:.0f}")
        for m, v in u.get("by_model", {}).items():
            step(f"  · {m}: {v['calls']} calls · in={v['in']:,} out={v['out']:,}")
        save_json(out_dir / "usage.json", u)
    except Exception as e:
        step(f"[usage] dump 실패(무시): {str(e)[:120]}")
