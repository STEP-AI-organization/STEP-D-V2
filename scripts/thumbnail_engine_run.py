"""썸네일 엔진 관통 실행 — 기획 → 배경 검색 → 등록 인물 → 생성.

사용자 지시 (2026-08-06~07):
  "먼저 영상 내용 보고 썸네일 기획 → 그거에 맞춰서 필요한 배경 프레임·인물을 찾아야 함"
  "영상 검색엔진을 이용"
  "이건 사람이 캐스팅 등록해주는 게 맞다 · face 는 좀 과하다, 파이프라인에서 빼도 된다"

그래서 이 스크립트는 얼굴 검출·누끼·합성을 하지 않는다. 인물은 등록부에서
사진을 그대로 꺼내 쓰고, 배경 프레임 1장만 영상에서 고른 뒤, 생성 모델에
사진 몇 장과 한국어 한 줄을 준다.

이미지 생성은 비용이 든다. 기본은 검색까지만 돌고, 생성은 --compose 를 명시해야 한다.

사용:
  python scripts/thumbnail_engine_run.py m_981d7c08 --program "나는솔로"
  python scripts/thumbnail_engine_run.py m_981d7c08 --program "나는솔로" --compose
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

STORAGE = ROOT / "tmp" / "local-storage"
OUT_ROOT = ROOT / "tmp" / "thumbnail-engine"


def load_env(path: pathlib.Path) -> None:
    """apps/server/.env 를 프로세스 env 로. 이미 있는 값은 덮지 않는다."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"'))


def extract_frame(video: pathlib.Path, sec: float, dest: pathlib.Path) -> bool:
    dest.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(
        ["ffmpeg", "-y", "-ss", str(sec), "-i", str(video),
         "-frames:v", "1", "-q:v", "2", str(dest)],
        capture_output=True,
    )
    return r.returncode == 0 and dest.exists()


def frame_meta(path: pathlib.Path, sec: float, logo_windows: list[tuple[float, float]]) -> dict:
    """배경 후보 1장의 판단 재료. 선명도는 라플라시안 분산(정규화)."""
    import numpy as np
    from PIL import Image

    im = Image.open(path)
    w, h = im.size
    a = np.asarray(im.convert("L")).astype(float)
    lap = (-4 * a[1:-1, 1:-1] + a[:-2, 1:-1] + a[2:, 1:-1]
           + a[1:-1, :-2] + a[1:-1, 2:])
    return {
        "path": str(path), "sec": sec,
        "sharpness": round(float(min(lap.var() / 2000.0, 1.0)), 3),
        "hasLogo": any(s <= sec <= e for s, e in logo_windows),
        "hasCaption": False,          # caption_detect 가 아래에서 채운다
        "width": w, "height": h, "faces": [],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("media_id")
    ap.add_argument("--program", default="", help="프로그램명 (등록부·스타일 프로파일 키)")
    ap.add_argument("--compose", action="store_true", help="실제 이미지 생성 (유료)")
    ap.add_argument("--candidates", type=int, default=1, help="생성 후보 장수")
    ap.add_argument("--reuse-plan", action="store_true",
                    help="저장된 plan.json 재사용 (Gemini 호출 없이 반복 실행)")
    args = ap.parse_args()

    load_env(ROOT / "apps" / "server" / ".env")

    from core.thumbnail.caption_detect import annotate as annotate_captions
    from core.thumbnail.cast_registry import how_to_register, resolve_plan_people
    from core.thumbnail.plan import build_plan
    from core.thumbnail.sourcing import find_background, sample_secs, search_windows

    adir = STORAGE / "analysis" / args.media_id
    video = STORAGE / "uploads" / f"{args.media_id}.mp4"
    out = OUT_ROOT / args.media_id
    out.mkdir(parents=True, exist_ok=True)

    narrative = json.loads((adir / "narrative.json").read_text(encoding="utf-8"))
    summary = narrative.get("full_summary") or ""
    characters = narrative.get("characters") or []
    cast_names = [c.get("name") for c in characters if isinstance(c, dict) and c.get("name")]

    # ── 1) 기획 ────────────────────────────────────────────────────────────
    plan_path = out / "plan.json"
    if args.reuse_plan and plan_path.exists():
        print("[1/4] 썸네일 기획 (저장본 재사용 — Gemini 호출 없음)")
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
    else:
        print("[1/4] 썸네일 기획 (Gemini)")
        plan = build_plan(summary=summary[:6000], cast_names=cast_names)
        plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2),
                             encoding="utf-8")
    print(f"   concept : {plan.get('concept')}")
    print(f"   제목1   : {plan.get('title1')}")
    print(f"   제목2   : {plan.get('title2')}")
    print(f"   mood    : {plan.get('mood')}")
    for p in plan.get("people") or []:
        print(f"   인물    : {p.get('castName')} ({p.get('expression')})")
    bg = plan.get("background") or {}
    print(f"   배경    : {bg.get('scene')} @ {bg.get('atSec')}s")

    # ── 2) 인물 — 등록부에서 읽기만 한다 ────────────────────────────────────
    # 얼굴 검출·임베딩·클러스터링을 하지 않는다. 누가 누구인지는 사람이
    # 폴더명으로 이미 답했으므로, 기계가 다시 판정할 이유가 없다.
    print("\n[2/4] 인물 (등록부)")
    briefs = plan.get("people") or []
    person_paths, missing = resolve_plan_people(args.program, briefs)
    for path in person_paths:
        print(f"   {path.parent.name}: {path.name}")
    if missing:
        print("   ! 등록 안 된 인물: " + ", ".join(missing))
        print(how_to_register(args.program))

    # ── 3) 배경 프레임 — 검색엔진이 찾아준 구간에서 ─────────────────────────
    print("\n[3/4] 배경 프레임")
    ppl = json.loads((adir / "ppl.json").read_text(encoding="utf-8"))
    logo_windows = [(d.get("start", 0.0), d.get("end", 0.0))
                    for d in (ppl.get("detections") or [])]

    query = bg.get("scene") or plan.get("concept") or ""
    try:
        windows = search_windows(query, media_id=args.media_id, limit=8)
        print(f'   검색: "{query[:40]}" → 구간 {len(windows)}개')
        for w in windows[:3]:
            print(f"   {w['start']:8.1f}s vec={w['vec']:.3f} | {w['summary'][:46]}")
    except Exception as e:
        # 검색 서버·DB 가 내려가도 파이프라인 전체가 죽으면 안 된다.
        # 기획이 지목한 시점으로 좁게 폴백하고, 그 사실을 로그에 남긴다.
        windows = []
        print(f"   ! 검색 실패 ({type(e).__name__}) — 기획 지목 시점만 사용")
    if not windows:
        at = float(bg.get("atSec") or 0.0)
        windows = [{"start": max(0.0, at - 4), "end": at + 4}]
        print(f"   폴백 구간: {max(0.0, at - 4):.1f}~{at + 4:.1f}s")

    frames = []
    for i, sec in enumerate(sample_secs(windows, per_window=2)[:14]):
        dest = out / "frames" / f"f_{i:02d}_{sec:.1f}.jpg"
        if extract_frame(video, sec, dest):
            frames.append(frame_meta(dest, sec, logo_windows))
    annotate_captions(frames)
    n_cap = sum(1 for f in frames if f.get("hasCaption"))
    print(f"   후보 {len(frames)}장 · 화면자막 {n_cap}장 (감점)")

    bg_picks = find_background(frames, bg, top=3)
    for pk in bg_picks:
        print(f"   {pathlib.Path(pk['path']).name:<22} {pk['score']:>6} {pk['breakdown']}")

    gaps = list(missing)
    if not bg_picks:
        gaps.append("배경 프레임 후보 없음")

    (out / "sourcing.json").write_text(json.dumps(
        {"background": bg_picks, "people": [str(p) for p in person_paths], "gaps": gaps},
        ensure_ascii=False, indent=2), encoding="utf-8")

    # ── 4) 생성 ────────────────────────────────────────────────────────────
    print("\n[4/4] 썸네일 생성")
    if not args.compose:
        print("   --compose 없음 → 여기서 멈춤 (이미지 생성 비용 없음)")
        print(f"   결과: {out}")
        return 0
    if gaps:
        print("   ! 빠진 게 있다 — 없는 채로 생성하면 모델이 지어낸다. 중단.")
        print("     " + " · ".join(gaps))
        return 1

    from core.thumbnail.simple_gen import build_prompt, generate, load_style

    bg_path = pathlib.Path(bg_picks[0]["path"])
    style_block, style_refs = load_style(args.program)
    prompt = build_prompt(plan, args.program, True, style_block, len(style_refs))
    print(f"   프롬프트: {prompt}")
    print(f"   입력: 인물 {len(person_paths)}장 + 배경 {bg_path.name}"
          + (f" + 스타일 참고 {len(style_refs)}장" if style_refs else " (스타일 프로파일 없음)"))

    imgs = generate(person_paths, plan, background_path=bg_path,
                    program_title=args.program, n=args.candidates)
    if not imgs:
        print("   ! 생성 실패")
        return 1
    for k, img in enumerate(imgs, 1):
        dest = out / f"thumb_{k}.png"
        dest.write_bytes(img)
        print(f"   후보 {k}: {dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
