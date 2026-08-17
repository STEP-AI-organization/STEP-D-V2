"""core.analyze 의 체크포인트·진행률·지문 유틸.

2026-08-06 분리 · analyze.py 1019줄 정리 1단계. `analyze()` 본체·스테이지 함수는 아직
analyze.py 안에 있고, 이 파일은 상태 없는 유틸만 담는다. `docs/plans/analyze-py-split-plan.md`
의 안정 브랜치 리팩터를 이 파일 하나로 시작 · 스테이지 이동은 별도 단계.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
from pathlib import Path


CHECKPOINTS = (
    "stt.json", "refined.json", "faces.json", "ppl.json", "scenes.json",
    "cast.json", "timeline.json", "narrative.json", "shots.json",
    "boundaries.json", "scene_type.json", "beats.json", "viewer_signals.json",
    "shorts.json", "analysis.json", "segments.json",
    # 2026-08-06 추가 — 빠져 있으면 "다른 영상" 초기화 때 살아남아 오염된다
    "signals.json", "genre.json", "chyron.json",
)


def save_json(path: Path, obj) -> None:
    """Atomic write — a crash mid-write must not leave a truncated checkpoint."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def fingerprint(*parts) -> str:
    """Stable short hash of the params a stage's output depends on."""
    raw = json.dumps(parts, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def prepare_checkpoints(
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
    # refine·recommend는 cast_registry를 프롬프트에 넣으므로 cast 바뀌면 재실행.
    # 2026-08-06: score100 을 LLM 3축 → _deterministic_score(signal·hook·length·closure) 로 교체.
    # 코드만 바꾸면 지문이 그대로라 shorts.json 이 재사용돼 변경이 반영되지 않는다 — 그래서 올린다.
    # 2026-08-16: 쇼츠만 내던 것에 **클립(롱폼·가로형)** 을 추가(build_clips_from_beats).
    # 여기를 안 올리면 이미 분석한 회차는 옛 shorts.json 을 그대로 재사용해 **클립이 영영
    # 안 나온다** — 코드는 고쳤는데 결과가 안 바뀌는 정확히 그 함정.
    # 2026-08-16b: 점수 개편 — 길이축 제거(변별력 0) · hook 을 beat 라벨로(LLM 의존 제거) ·
    # 신호축 가중 + 죽은 축 자동 제외 + 음악 방어 · 시청자 지목 가산 · 클립 눈금 재보정.
    RECOMMEND_VER = "2026-08-17-hookquote"
    REFINE_VER = "2026-07-27-speaker-preserve"
    FACES_VER = "2026-07-29-sample-10s"
    SHOTS_VER = "2026-07-24a"
    SCENE_TYPE_VER = "2026-07-24a"
    BEATS_VER = "2026-08-07-min6-domino"   # 6초 하한 강제 + beat_annot 맥락 누적
    SIGNALS_VER = "2026-08-06-init"
    INDEX_VER = "2026-08-07-init"   # segments.json (검색 인덱스) 재조립 로직 버전
    STT_VER = "2026-07-27-word-normalize"
    VIEWER_SIGNALS_VER = "2026-07-28-init"
    # ⚠️ 이 값이 stt.json 지문에 들어간다 — 기본값이 다른 곳과 어긋나면 체크포인트가
    #    무효화돼 STT 를 다시 산다(≈₩270). 확정 스택인 "soniox" 로 통일한다.
    STT_PROVIDER_ENV = (os.environ.get("STT_PROVIDER") or "soniox").lower()
    RECOMMEND_MODE = os.environ.get("RECOMMEND_MODE") or "narrative_first"
    _comments_path = out_dir / "comments.json"
    _comments_hash = ""
    if _comments_path.exists():
        try:
            _comments_hash = hashlib.sha1(_comments_path.read_bytes()).hexdigest()[:16]
        except OSError:
            pass
    # boundaries.json 해시 — **GEBD 배선의 핵심**.
    # GEBD(gebd.detect)는 fallback 실행이 끝난 뒤 boundaries.json 을 새로 얹고 content.analyze 를
    # 재큐한다. 그런데 beats.json 지문에 boundaries 가 없으면 재실행이 **fallback beats 를 그대로
    # 재사용**해서 GEBD 결과가 영영 소비되지 않는다(2026-08-06 발견). 해시를 넣어 boundaries 가
    # 바뀔 때만 beats·signals·shorts 를 다시 만든다 — STT·refine·narrative 는 그대로 보존되므로
    # 재실행 비용은 ₩270(STT) 이 아니라 beats 이후만 든다.
    #
    # 주의: 첫 실행은 지문 계산 시점에 boundaries.json 이 없어 ""로 잡히고, 실행 중 fallback 이
    # 파일을 쓴다. 그래서 **바로 다음 재실행 1회는 beats 를 한 번 더 만든다**(그 뒤로는 안정).
    _boundaries_path = out_dir / "boundaries.json"
    _boundaries_hash = ""
    if _boundaries_path.exists():
        try:
            _boundaries_hash = hashlib.sha1(_boundaries_path.read_bytes()).hexdigest()[:16]
        except OSError:
            pass
    params = {
        "stt.json": fingerprint(STT_VER, STT_PROVIDER_ENV),
        "refined.json": fingerprint(cast_registry, REFINE_VER, STT_VER, STT_PROVIDER_ENV),
        "faces.json": fingerprint(cast_registry, FACES_VER),
        "cast.json": fingerprint(cast_registry, REFINE_VER, STT_VER),
        "narrative.json": fingerprint(cast_registry, REFINE_VER, STT_VER),
        "shots.json": fingerprint(SHOTS_VER),
        "scene_type.json": fingerprint(SCENE_TYPE_VER, SHOTS_VER),
        "beats.json": fingerprint(BEATS_VER, REFINE_VER, SHOTS_VER, SCENE_TYPE_VER, STT_VER, _boundaries_hash),
        # signals 는 beat 구간에 매달린 값이라 beats 가 바뀌면 통째로 무효다 (beat id 가 달라진다).
        "signals.json": fingerprint(SIGNALS_VER, BEATS_VER, SHOTS_VER, STT_VER, _boundaries_hash),
        "viewer_signals.json": fingerprint(VIEWER_SIGNALS_VER, _comments_hash),
        # ⚠️ segments.json 은 CHECKPOINTS 에는 있었지만 여기 params 에 **없었다**.
        # 무효화 루프가 params.items() 만 돌기 때문에 이 파일은 **한 번 만들어지면 영영
        # 갱신되지 않았다.** 2026-08-07 실측: 경계 교체로 beats 가 182 → 413 개가 됐는데
        # segments.json 은 182개(beat 0~181 참조)로 남아, 검색 인덱스가 존재하지도 않는
        # beat 을 가리켰다. 검색이 이 리포의 목적물인데 그게 통째로 낡아 있었다.
        "segments.json": fingerprint(genre, INDEX_VER, BEATS_VER, SIGNALS_VER,
                                     SCENE_TYPE_VER, REFINE_VER, STT_VER, _boundaries_hash),
        "shorts.json": fingerprint(genre, shorts_n, profile, channels, cast_registry, RECOMMEND_VER, RECOMMEND_MODE, REFINE_VER, FACES_VER, BEATS_VER, STT_VER, _comments_hash, _boundaries_hash),
        "analysis.json": fingerprint(genre, shorts_n, profile, channels, cast_registry, RECOMMEND_VER, RECOMMEND_MODE, REFINE_VER, FACES_VER, BEATS_VER, STT_VER, _comments_hash, _boundaries_hash),
    }
    manifest = {"video_name": video_name, "video_size": video_size, "params": params}

    prior = load_json(manifest_path) or {}
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
        prior_params = prior.get("params", {})
        for name, fp in params.items():
            if prior_params.get(name) != fp:
                src = out_dir / name
                if src.exists():
                    print(f"파라미터 변경 — {name} 재생성 (이전본은 .invalidated/ 로 보관)")
                    _archive_checkpoint(out_dir, src)
                else:
                    src.unlink(missing_ok=True)
    save_json(manifest_path, manifest)


def _archive_checkpoint(out_dir: Path, src: Path) -> None:
    """무효해진 체크포인트를 **지우지 말고** out_dir/.invalidated/ 로 옮긴다.

    2026-08-07: 지문이 어긋나면 곧바로 unlink 했는데, 그 뒤 단계가 크래시하면
    되살릴 방법이 없다. 실제로 `STT_PROVIDER` 를 안 넘긴 채 실행해서 stt.json ·
    refined.json 이 지워졌고, 바로 다음 줄에서 "SONIOX_API_KEY 미설정" 으로 죽어
    ₩270 짜리 STT 를 다시 사야 했다. 재생성은 어차피 덮어쓰므로 보관해도 지장 없다.
    """
    dest_dir = out_dir / ".invalidated"
    try:
        dest_dir.mkdir(exist_ok=True)
        dest = dest_dir / src.name
        if dest.exists():
            dest.unlink()
        src.replace(dest)
    except OSError:
        # 보관에 실패해도 파이프라인은 진행해야 한다 (원래 동작으로 폴백)
        src.unlink(missing_ok=True)


def progress(stage: str, pct: float, note: str = "") -> None:
    """Worker parses @@PROGRESS lines. Single write (not print) — progress fires from
    thread-pool callbacks, and an interleaved half-line would corrupt the marker."""
    payload = json.dumps({"stage": stage, "pct": round(pct), "note": note}, ensure_ascii=False)
    sys.stdout.write(f"@@PROGRESS {payload}\n")
    sys.stdout.flush()
