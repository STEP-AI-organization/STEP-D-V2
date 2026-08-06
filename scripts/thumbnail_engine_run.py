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


def detect_person_candidates(frames: list[dict], out_dir: pathlib.Path) -> list[dict]:
    """프레임에서 얼굴을 찾아 상반신 crop 을 만든다.

    등록 cast 가 없으면 이름을 확정할 수 없다 — 성별·크기·시선만 채우고
    castName 은 비워 둔다. 여기서 이름을 추측하면 잘못된 인물이 조용히 들어간다.
    """
    os.environ.setdefault("FACES_ALLOW_CPU", "1")
    import cv2
    from core.faces import _get_app, _detect

    out_dir.mkdir(parents=True, exist_ok=True)
    _get_app()
    cands: list[dict] = []
    for fr in frames:
        img = cv2.imread(fr["path"])
        if img is None:
            continue
        h, w = img.shape[:2]
        for i, d in enumerate(_detect(img)):
            x1, y1, x2, y2 = d["bbox"]
            fw, fh = x2 - x1, y2 - y1
            # 상반신: 얼굴 기준 좌우 1.2배·위 0.8배·아래 3.2배
            cx0 = max(0, int(x1 - fw * 1.2)); cx1 = min(w, int(x2 + fw * 1.2))
            cy0 = max(0, int(y1 - fh * 0.8)); cy1 = min(h, int(y2 + fh * 3.2))
            crop = img[cy0:cy1, cx0:cx1]
            if crop.size == 0:
                continue
            dest = out_dir / f"p_{fr['sec']:.1f}_{i}.png"
            cv2.imwrite(str(dest), crop)
            face_cx = (x1 + x2) / 2 / w
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
    print("[1/5] 썸네일 기획 (Gemini)")
    plan = build_plan(summary=summary[:6000], cast_names=cast_names)
    (out / "plan.json").write_text(
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
    ranked = rank(to_match_context(plan), load_registry())
    if not ranked:
        print("   ! 맞는 템플릿 없음 — 중단"); return 1
    for r in ranked:
        print(f"   {r['templateId']:<24} {r['score']:>6} {r['breakdown']}")
    template = get_template(ranked[0]["templateId"])

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
    secs = sample_secs(windows, per_window=2)
    if not secs:
        at = bg.get("atSec") or 0.0
        secs = [max(0.0, float(at) + off) for off in (-3, 0, 3)]
        print("   ! 검색 결과 없음 — 기획 지목 시점으로 폴백")
    frames = []
    for i, sec in enumerate(secs[:14]):
        dest = out / "frames" / f"f_{i:02d}_{sec:.1f}.jpg"
        if extract_frame(video, sec, dest):
            frames.append(frame_meta(dest, sec, logo_windows))
    print(f"   후보 {len(frames)}장 추출")
    bg_picks = find_background(frames, bg, top=3)
    for p in bg_picks:
        print(f"   {pathlib.Path(p['path']).name:<22} {p['score']:>6} {p['breakdown']}")

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
        for c in person_cands[:6]:
            print(f"   {pathlib.Path(c['path']).name:<26} area={c['frameArea']:.3f} "
                  f"det={c['face']['det_score']:.2f} g={c.get('gender')} facing={c.get('facing')}")

    # 배경과 인물이 다른 장면에서 나오면 의상·조명이 어긋나 합성이 티가 난다.
    # 선택된 배경 프레임과 같은 장면(±12초) 안의 인물만 후보로 둔다.
    if person_cands and bg_picks:
        anchor = bg_picks[0]["sec"] or 0.0
        same_scene = [c for c in person_cands
                      if c.get("sec") is not None and abs(c["sec"] - anchor) <= 12.0]
        if len(same_scene) >= len(briefs):
            print(f"   장면 일치 필터: {len(person_cands)} → {len(same_scene)}명 "
                  f"(배경 {anchor:.1f}s 기준 ±12s)")
            person_cands = same_scene
        else:
            print(f"   ! 배경 장면({anchor:.1f}s) 안에 인물이 {len(same_scene)}명뿐 "
                  f"— 장면 일치를 포기하고 전체 후보 사용 (의상·조명 불일치 위험)")
    people = find_people(person_cands, briefs) if person_cands else {}
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

    # ── 5) 합성 ────────────────────────────────────────────────────────────
    print("\n[5/5] 합성")
    if not args.compose:
        print("   --compose 없음 → 여기서 멈춤 (이미지 생성 비용 없음)")
        print(f"   결과: {out}")
        return 0
    if gaps:
        print("   ! 에셋이 빠졌다 — 합성하면 모델이 지어낸다. 중단.")
        return 1

    from core.thumbnail.compose import compose
    tpl_bytes = (ROOT / template["imagePath"]).read_bytes()
    bg_bytes = pathlib.Path(bg_picks[0]["path"]).read_bytes()
    person_bytes = [pathlib.Path(people[b["slotId"]][0]["path"]).read_bytes()
                    for b in briefs]
    for n in range(args.candidates):
        img = compose(
            template_image=tpl_bytes, background_image=bg_bytes,
            person_images=person_bytes,
            summary=plan.get("concept") or "", mood=", ".join(plan.get("mood") or []),
        )
        if not img:
            print(f"   후보 {n + 1}: 생성 실패"); continue
        dest = out / f"composed_{n + 1}.png"
        dest.write_bytes(img)
        print(f"   후보 {n + 1}: {dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
