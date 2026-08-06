"""썸네일 엔진 관통 실행 — 기획 → 템플릿 매칭 → 에셋 검색 → 합성 → 자막.

사용자 지시 (2026-08-06): "먼저 영상 내용 보고 썸네일 기획 → 그거에 맞춰서
필요한 영상 배경 프레임·인물 사진을 찾아야 함."

이미지 생성은 비용이 든다. 기본은 --dry (기획·매칭·검색까지만) 이고,
실제 합성은 --compose 를 명시해야 돈다.

사용:
  python scripts/thumbnail_engine_run.py m_981d7c08            # 기획·검색만
  python scripts/thumbnail_engine_run.py m_981d7c08 --compose  # 합성까지 (유료)
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
    """프레임 1장의 판단 재료. 선명도는 라플라시안 분산(정규화)."""
    from PIL import Image
    import numpy as np

    im = Image.open(path).convert("L")
    a = np.asarray(im).astype(float)
    lap = (
        -4 * a[1:-1, 1:-1] + a[:-2, 1:-1] + a[2:, 1:-1] + a[1:-1, :-2] + a[1:-1, 2:]
    )
    sharp = float(min(lap.var() / 2000.0, 1.0))
    has_logo = any(s <= sec <= e for s, e in logo_windows)
    w, h = Image.open(path).size
    return {
        "path": str(path), "sec": sec, "sharpness": round(sharp, 3),
        "hasLogo": has_logo, "hasCaption": False,   # 화면자막 판정은 아직 없음
        "width": w, "height": h, "faces": [],
    }


CROP_SIDE = 0.9    # 얼굴 폭 대비 좌우 여유
CROP_UP = 0.7      # 머리 위 여유
CROP_DOWN = 1.8    # 턱 아래 (자막 밴드를 피하는 값)


def detect_person_candidates(frames: list[dict], out_dir: pathlib.Path) -> list[dict]:
    """프레임에서 얼굴을 찾아 상반신 crop 을 만든다.

    등록 cast 가 없으면 이름을 확정할 수 없다 — 성별·크기·시선만 채우고
    castName 은 비워 둔다. 여기서 이름을 추측하면 잘못된 인물이 조용히 들어간다.
    """
    os.environ.setdefault("FACES_ALLOW_CPU", "1")
    import cv2
    from core.faces import _get_app, _detect

    from core.thumbnail.caption_detect import caption_band

    out_dir.mkdir(parents=True, exist_ok=True)
    _get_app()
    cands: list[dict] = []
    for fr in frames:
        img = cv2.imread(fr["path"])
        if img is None:
            continue
        h, w = img.shape[:2]
        # 자막이 있어도 프레임을 버리지 않는다 — 띠 위에서 잘라 피한다.
        band = caption_band(fr["path"])
        cap_top = int(band[0] * h) if band else h
        for i, d in enumerate(_detect(img)):
            x1, y1, x2, y2 = d["bbox"]
            fw, fh = x2 - x1, y2 - y1
            # 상반신 crop. 아래로 3.2배까지 잡으면 한국 예능 자막 밴드(가슴~배)가
            # 항상 포함되어, 얼굴이 멀쩡한 큰 클로즈업이 자막 필터에서 통째로 탈락한다.
            # 1.8배로 좁히면 자막을 대부분 피하면서 슬롯을 채우기엔 충분하다.
            cx0 = max(0, int(x1 - fw * CROP_SIDE)); cx1 = min(w, int(x2 + fw * CROP_SIDE))
            cy0 = max(0, int(y1 - fh * CROP_UP))
            cy1 = min(h, int(y2 + fh * CROP_DOWN))
            if cap_top < cy1:
                # 자막 띠 위 8px 여유를 두고 자른다. 턱 아래가 조금이라도 남아야
                # 인물로 보이므로, 얼굴 하단보다 위로는 올라가지 않는다.
                cy1 = max(int(y2 + fh * 0.15), cap_top - 8)
            crop = img[cy0:cy1, cx0:cx1]
            if crop.size == 0:
                continue
            dest = out_dir / f"p_{fr['sec']:.1f}_{i}.png"
            cv2.imwrite(str(dest), crop)
            face_cx = (x1 + x2) / 2 / w
            # 배경 채점의 noBigFace 축이 쓰는 값 — 여기서 안 채우면 항상 만점이 나온다.
            fr.setdefault("faces", []).append(
                {"bbox": [x1, y1, x2, y2], "area": float(d["area"])})
            cands.append({
                "path": str(dest), "sec": fr["sec"], "castName": "",
                "gender": d.get("gender"),
                # 화면 왼쪽에 있으면 보통 오른쪽을 본다 (마주보는 구도의 통상 배치)
                "facing": "right" if face_cx < 0.5 else "left",
                "frameArea": float(d["area"]) / (w * h),
                "sharpness": fr.get("sharpness") or 0.0,
                "face": {"det_score": float(d["det_score"]), "embedding": d.get("embedding")},
            })
    cands.sort(key=lambda c: -c["frameArea"])
    return cands


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("media_id")
    ap.add_argument("--compose", action="store_true", help="실제 이미지 합성 (유료)")
    ap.add_argument("--candidates", type=int, default=1, help="합성 후보 장수")
    ap.add_argument("--reuse-plan", action="store_true",
                    help="저장된 plan.json 재사용 (임계값 비교 시 기획을 고정)")
    ap.add_argument("--min-face", type=float, default=0.03,
                    help="인물 후보 최소 얼굴 면적 비율 (기본 0.03)")
    ap.add_argument("--program", default="", help="프로그램명 (프롬프트에 들어감)")
    args = ap.parse_args()

    load_env(ROOT / "apps" / "server" / ".env")

    from core.thumbnail.plan import build_plan, to_match_context
    from core.thumbnail.match import rank
    from core.thumbnail.structure import load_registry, get_template
    from core.thumbnail.sourcing import (find_background, find_people, missing_assets,
                                        search_windows, sample_secs)

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
        print("[1/5] 썸네일 기획 (저장본 재사용 — Gemini 호출 없음)")
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
    else:
        print("[1/5] 썸네일 기획 (Gemini)")
        plan = build_plan(summary=summary[:6000], cast_names=cast_names)
        plan_path.write_text(
            json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"   concept : {plan.get('concept')}")
    print(f"   hook    : {plan.get('hook')}")
    print(f"   제목1   : {plan.get('title1')}")
    print(f"   제목2   : {plan.get('title2')}")
    print(f"   mood    : {plan.get('mood')} · category={plan.get('category')}")
    for p in plan.get("people") or []:
        print(f"   인물    : {p.get('slotId')} {p.get('castName')} "
              f"({p.get('expression')}, {p.get('facing')})")
    bg = plan.get("background") or {}
    print(f"   배경    : {bg.get('scene')} @ {bg.get('atSec')}s "
          f"busyness={bg.get('busyness')} avoid={bg.get('avoid')}")

    # ── 2) 템플릿 매칭 ─────────────────────────────────────────────────────
    print("\n[2/5] 템플릿 매칭")
    # 템플릿은 이제 생성 입력으로 안 들어간다 — 이미지로 넣으면 모델이 회색
    # 실루엣과 라벨을 해석하느라 힘을 뺀다. 인물 수·제목 줄수 참고용으로만 남긴다.
    ranked = rank(to_match_context(plan), load_registry())
    for r in ranked:
        print(f"   {r['templateId']:<24} {r['score']:>6} {r['breakdown']}")
    template = get_template(ranked[0]["templateId"]) if ranked else None
    if not ranked:
        print("   맞는 템플릿 없음 — 생성에는 영향 없음")

    # ── 3) 배경 프레임 검색 ────────────────────────────────────────────────
    print("\n[3/5] 배경 프레임 검색")
    ppl = json.loads((adir / "ppl.json").read_text(encoding="utf-8"))
    logo_windows = [(d.get("start", 0.0), d.get("end", 0.0))
                    for d in (ppl.get("detections") or [])]
    # 시간축을 훑지 않는다 — 기획 문장을 구간 검색엔진에 던져 장면을 찾는다.
    query = bg.get("scene") or plan.get("concept") or ""
    windows = search_windows(query, media_id=args.media_id, limit=8)
    print(f'   검색: "{query[:40]}" → 구간 {len(windows)}개')
    for w in windows[:3]:
        print(f"   {w['start']:8.1f}s vec={w['vec']:.3f} | {w['summary'][:46]}")
    def collect(per_window: int, limit: int, seen: set) -> list:
        ws = windows if limit <= 8 else search_windows(query, media_id=args.media_id, limit=limit)
        got = []
        for sec in sample_secs(ws, per_window=per_window):
            if sec in seen:
                continue
            seen.add(sec)
            dest = out / "frames" / f"f_{len(seen):03d}_{sec:.1f}.jpg"
            if extract_frame(video, sec, dest):
                got.append(frame_meta(dest, sec, logo_windows))
        return got

    if not windows:
        at = bg.get("atSec") or 0.0
        print("   ! 검색 결과 없음 — 기획 지목 시점으로 폴백")
        windows = [{"start": max(0.0, float(at) - 3), "end": float(at) + 3}]

    seen_secs: set = set()
    frames = collect(2, 8, seen_secs)
    from core.thumbnail.caption_detect import annotate as annotate_captions
    annotate_captions(frames)
    n_cap = sum(1 for f in frames if f.get("hasCaption"))
    print(f"   후보 {len(frames)}장 추출 · 화면자막 검출 {n_cap}장 (감점 대상)")
    # 배경 선택은 인물 확정 뒤로 미룬다 — 아래 [3/5] 참고.

    # ── 4) 인물 후보 ───────────────────────────────────────────────────────
    print("\n[4/5] 인물 후보")
    briefs = plan.get("people") or []
    faces_p = adir / "faces.json"
    person_cands: list[dict] = []
    if faces_p.exists():
        faces = json.loads(faces_p.read_text(encoding="utf-8"))
        print(f"   faces.json 사용 (detections {len(faces)})")
        for f in (faces if isinstance(faces, list) else faces.get("detections") or []):
            person_cands.append({
                "path": f.get("crop") or f.get("path") or "",
                "sec": f.get("sec"), "castName": f.get("name") or "",
                "facing": f.get("facing"), "frameArea": f.get("areaRatio"),
                "sharpness": f.get("sharpness") or 0.0,
                "face": {"det_score": f.get("det_score") or 0.0,
                         "embedding": f.get("embedding")},
            })
    else:
        # faces 스테이지 산출물이 없으면, 검색이 찾아준 프레임에서 직접 검출한다.
        # 회차 전체를 훑지 않는다 — 기획이 원한 장면 안에서만 본다.
        print("   faces.json 없음 → 검색 프레임에서 직접 검출")
        person_cands = detect_person_candidates(frames, out / "people")
        # crop 단계에서 자막 띠를 피해 잘랐으므로, 여기서는 그래도 남은 것만 뺀다.
        from core.thumbnail.caption_detect import caption_score
        kept = [c for c in person_cands if caption_score(c["path"]) < 0.5]
        print(f"   자막 잔존 배제: {len(person_cands)} → {len(kept)}명")
        person_cands = kept
        for c in person_cands[:6]:
            print(f"   {pathlib.Path(c['path']).name:<26} area={c['frameArea']:.3f} "
                  f"det={c['face']['det_score']:.2f} g={c.get('gender')} facing={c.get('facing')}")

    def qualified(cands):
        return [c for c in cands if float(c.get("frameArea") or 0) >= args.min_face]

    # 자격(얼굴 크기)을 통과한 인원이 슬롯 수보다 적으면 후보를 넓혀 다시 뽑는다.
    # 한 번에 끝내면 "좋은 게 없을 때 나쁜 것 중 1등"을 고르게 된다.
    for per_window, limit in ((4, 16), (6, 24)):
        if len(qualified(person_cands)) >= len(briefs):
            break
        more = collect(per_window, limit, seen_secs)
        if not more:
            break
        annotate_captions(more)
        extra = detect_person_candidates(more, out / "people")
        extra = [c for c in extra if caption_score(c["path"]) < 0.35]
        frames.extend(more)
        person_cands.extend(extra)
        print(f"   후보 확장 (per_window={per_window}): 프레임 +{len(more)} · 인물 +{len(extra)}")

    n_ok = len(qualified(person_cands))
    print(f"   얼굴 크기 하한 {args.min_face:.3f}: {len(person_cands)}명 중 {n_ok}명 통과")
    people = (find_people(person_cands, briefs, min_face_area=args.min_face)
              if person_cands else {})

    # ── 3) 배경 프레임 선택 (인물 확정 후) ─────────────────────────────────
    # 인물 crop 을 뜬 프레임을 배경으로 쓰면, 배경에 이미 있는 그 사람 위에
    # 같은 사람을 다시 붙이게 된다 — 밝기·크기가 어긋나 사각형처럼 보인다.
    print("\n[3/5] 배경 프레임 선택")
    person_secs = {p[0]["sec"] for p in people.values() if p and p[0].get("sec") is not None}
    usable = [f for f in frames if f.get("sec") not in person_secs]
    if not usable:
        usable = frames
        print("   ! 인물 소스 아닌 프레임이 없다 — 겹침을 감수하고 전체 사용")
    else:
        print(f"   인물 소스 프레임 제외: {len(frames)} → {len(usable)}장")
    bg_picks = find_background(usable, bg, top=3)
    for p in bg_picks:
        print(f"   {pathlib.Path(p['path']).name:<22} {p['score']:>6} {p['breakdown']}")

    gaps = missing_assets(bg_picks, people, briefs)
    if not person_cands:
        print("   ! faces.json 없음 — 인물 후보를 만들 수 없다.")
    for slot, picks in (people or {}).items():
        print(f"   {slot}: " + ", ".join(f"{pathlib.Path(p['path']).name}({p['score']})"
                                         for p in picks))
    if gaps:
        print("   누락: " + " · ".join(gaps))

    (out / "sourcing.json").write_text(json.dumps(
        {"template": ranked[0], "background": bg_picks, "people": people, "gaps": gaps},
        ensure_ascii=False, indent=2), encoding="utf-8")

    # ── 5) 생성 ────────────────────────────────────────────────────────────
    print("\n[5/5] 합성")
    if not args.compose:
        print("   --compose 없음 → 여기서 멈춤 (이미지 생성 비용 없음)")
        print(f"   결과: {out}")
        return 0
    if gaps:
        print("   ! 에셋이 빠졌다 — 없는 채로 생성하면 모델이 지어낸다. 중단.")
        return 1

    from core.thumbnail.simple_gen import build_prompt, generate

    bg_path = pathlib.Path(bg_picks[0]["path"]) if bg_picks else None
    person_paths = [pathlib.Path(people[b["slotId"]][0]["path"]) for b in briefs]

    prompt = build_prompt(plan, args.program, with_background=bg_path is not None)
    print(f"   프롬프트: {prompt}")
    print(f"   입력: 인물 {len(person_paths)}장"
          + (f" + 배경 {bg_path.name}" if bg_path else " (배경 없음 — 모델이 지어냄)"))

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
