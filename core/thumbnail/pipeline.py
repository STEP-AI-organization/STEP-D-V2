"""썸네일 7단계 파이프라인 (사용자 구조 2026-07-27):

②클립 생성 (이미 있음 · shorts)
   ↓
③클립 분석 (대사·씬·narrative 슬라이싱)
   ↓
④썸네일 기획 AI (Planner · caption·preset·layout)
   ↓
⑤대표 프레임 추출 (얼굴 큰 shot + 감정 절정)
   ↓
⑥이미지 생성/합성 (nano banana · variant N개 병렬)
   ↓
⑦CTR 점수 예측 (Gemini vision · 각 variant 평가)
   ↓
Best Thumbnail

실행:
  python -m core.thumbnail.pipeline --media-dir X --variants 3
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from . import planner as PL
from . import nano_banana as NB
from . import ctr_predictor as CTR
from . import caption_overlay as OV


def run_pipeline(
    media_dir: pathlib.Path,
    out_dir: pathlib.Path,
    n_variants: int = 3,
    shorts: dict | None = None,   # {"start", "end", ...} 지정 X 면 narrative 첫 segment
) -> dict:
    """7단계 실행 → Best 썸네일 반환."""
    out_dir.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    log: dict = {"stages": {}, "took": {}}

    # ─── ③ 클립 분석 ────────────────────────────────────────────
    t = time.time()
    pc_path = media_dir / "program_context.json"
    pc = json.loads(pc_path.read_text(encoding="utf-8")) if pc_path.exists() else {}
    shorts_ctx = {
        "title": pc.get("title", "쇼츠"),
        "description": "",
        "cast_names": pc.get("cast", []),
    }
    # narrative 첫 segment 를 shorts로 (편의)
    if not shorts:
        nar = json.loads((media_dir / "narrative.json").read_text(encoding="utf-8")) \
            if (media_dir / "narrative.json").exists() else {}
        if isinstance(nar, dict) and nar.get("segments"):
            s0 = nar["segments"][0]
            shorts = {"start": s0.get("start", 0), "end": s0.get("end", 180)}
            shorts_ctx["title"] = s0.get("title", shorts_ctx["title"])
            shorts_ctx["description"] = s0.get("summary", "")
    shorts_slice = PL.load_shorts_slice(media_dir, shorts) if shorts else None
    log["stages"]["3_clip_analysis"] = {
        "shorts_range": [shorts.get("start"), shorts.get("end")] if shorts else None,
        "transcript_lines": len(shorts_slice.get("transcript_lines", [])) if shorts_slice else 0,
        "key_moments": len(shorts_slice.get("key_moments", [])) if shorts_slice else 0,
    }
    log["took"]["3_clip_analysis"] = round(time.time() - t, 2)

    # ─── ④ 썸네일 기획 AI (Planner · variant N 세트) ─────────
    # 각 variant 마다 (background/layout/caption) 다르게. AI 에 넘길 필드 오직 이 3개.
    t = time.time()
    shorts_ctx_with_shorts = dict(shorts_ctx); shorts_ctx_with_shorts["shorts"] = shorts
    variant_plans = PL.generate_variant_prompts(
        media_dir=media_dir,
        n=n_variants,
        shorts_context=shorts_ctx_with_shorts,
    )
    log["stages"]["4_planner"] = {
        "requested": n_variants,
        "returned": len(variant_plans),
        "variants": variant_plans,
    }
    log["took"]["4_planner"] = round(time.time() - t, 2)
    if not variant_plans:
        return {"status": "planner_failed", "log": log}

    # ─── ⑤ 대표 프레임 추출 ─────────────────────────────────────
    t = time.time()
    cast_dir = media_dir / "cast_photos"
    cast_photos = sorted(cast_dir.glob("*")) if cast_dir.exists() else []
    shot_dir = media_dir / "shot_frames"
    all_frames = sorted(shot_dir.glob("shot_*.jpg")) if shot_dir.exists() else []
    # 얼굴 큰 프레임 우선 · faces.json 활용
    picked_frames = _pick_top_frames(media_dir, all_frames, top_k=5)
    log["stages"]["5_frames"] = {
        "cast_photos": len(cast_photos),
        "total_frames": len(all_frames),
        "picked": [p.stem for p in picked_frames],
    }
    log["took"]["5_frames"] = round(time.time() - t, 2)

    # ─── ⑥ 이미지 생성 (variant N개 병렬 · 각각 다른 plan + 다른 프레임) ─
    # 사용자 원칙: nano banana 에 (배경/배치/제목) + 프레임 하나 · 그 외 X
    t = time.time()
    if not picked_frames:
        return {"status": "no_frames", "log": log}

    variant_images: dict[str, bytes] = {}
    variant_paths: dict[str, str] = {}

    cast_dir = media_dir / "cast_photos"

    def _resolve_cast_photos(names: list[str]) -> tuple[list[pathlib.Path], list[str]]:
        """이름 리스트 → 등록된 castPhoto 경로. 없는 이름은 조용히 스킵."""
        if not cast_dir.exists():
            return [], []
        photos: list[pathlib.Path] = []
        found: list[str] = []
        for nm in names or []:
            for ext in ("jpg", "jpeg", "png", "webp"):
                p = cast_dir / f"{nm}.{ext}"
                if p.exists():
                    photos.append(p); found.append(nm); break
        return photos, found

    def _gen_one(vid: str, plan_v: dict, frame: pathlib.Path) -> tuple[str, bytes | None]:
        try:
            # (a) 계획된 인물 사진 조회
            featured = plan_v.get("featured_cast", []) or []
            cast_photos, cast_names_found = _resolve_cast_photos(featured)
            # captions 배열 (신규) 또는 단일 caption (구) 정규화
            captions = plan_v.get("captions") or []
            if not captions and plan_v.get("caption"):
                captions = [{
                    "text": plan_v["caption"],
                    "role": "main",
                    "position": plan_v.get("caption_position", "bottom-left"),
                    "size": plan_v.get("caption_size", "L"),
                }]
            # nano banana 힌트용 · main 자막 위치를 자리 비우기 지시로 전달
            main_pos = "bottom-left"
            for c in captions:
                if c.get("role") == "main":
                    main_pos = c.get("position", main_pos); break
            print(f"  [{vid}] featured_cast={featured} · resolved={cast_names_found} · "
                  f"captions={[c.get('role') for c in captions]}")
            # (b) 자막 없는 이미지 생성 (frame + castPhotos)
            img = NB.generate_thumbnail(
                background=plan_v.get("background", "원본 프레임 그대로"),
                layout=plan_v.get("layout", "인물 중앙 · 자막 하단"),
                caption_position=main_pos,
                frame=frame,
                cast_photos=cast_photos,
                cast_names=cast_names_found,
            )
            if not img:
                return vid, None
            # (c) 시스템 오버레이 · role 별 계층 렌더
            img = OV.render_captions(img_bytes=img, captions=captions)
            return vid, img
        except Exception as e:
            print(f"[gen {vid}] fail: {str(e)[:200]}", file=sys.stderr)
            return vid, None

    # 각 variant 는 다른 plan · 다른 프레임 (부족하면 순환)
    with ThreadPoolExecutor(max_workers=n_variants) as ex:
        futs = [ex.submit(_gen_one, f"v{i+1}", variant_plans[i],
                          picked_frames[i % len(picked_frames)])
                for i in range(n_variants)]
        for f in as_completed(futs):
            vid, img_bytes = f.result()
            if img_bytes:
                dest = out_dir / f"{vid}.png"
                dest.write_bytes(img_bytes)
                variant_images[vid] = img_bytes
                variant_paths[vid] = str(dest)
                print(f"  [ok] {vid} → {dest.name}")
    log["stages"]["6_generation"] = {
        "requested": n_variants, "succeeded": len(variant_images),
        "paths": variant_paths,
    }
    log["took"]["6_generation"] = round(time.time() - t, 2)
    if not variant_images:
        return {"status": "generation_failed", "log": log}

    # ─── ⑦ CTR 점수 예측 · Best 선택 ────────────────────────
    t = time.time()
    scores = CTR.score_variants(variant_images)
    best_id = CTR.pick_best(scores)
    log["stages"]["7_ctr"] = {"scores": scores, "best": best_id}
    log["took"]["7_ctr"] = round(time.time() - t, 2)

    # Best 이미지를 복사
    if best_id and best_id in variant_paths:
        best_src = pathlib.Path(variant_paths[best_id])
        best_dst = out_dir / f"BEST_{best_id}.png"
        best_dst.write_bytes(best_src.read_bytes())
        log["best_path"] = str(best_dst)

    log["total_took"] = round(time.time() - t0, 2)
    (out_dir / "pipeline_log.json").write_text(
        json.dumps(log, ensure_ascii=False, indent=2, default=str), encoding="utf-8")

    return {"status": "completed", "log": log,
            "best": log.get("best_path"), "variants": variant_paths, "scores": scores}


def _pick_top_frames(media_dir: pathlib.Path,
                     all_frames: list[pathlib.Path], top_k: int = 5) -> list[pathlib.Path]:
    """얼굴 큰 프레임 top-K. faces.json 활용."""
    if not all_frames:
        return []
    faces_p = media_dir / "faces.json"
    if not faces_p.exists():
        return all_frames[:top_k]
    try:
        fd = json.loads(faces_p.read_text(encoding="utf-8"))
        # faces.json에 detections 없으면 · 그냥 앞 top_k
        detections = fd.get("detections", []) if isinstance(fd, dict) else []
        if not detections:
            return all_frames[:top_k]
        # 프레임별 얼굴 크기 합계
        from collections import defaultdict
        scores: dict[str, float] = defaultdict(float)
        for d in detections:
            fname = d.get("frame") or d.get("file") or ""
            fname = pathlib.Path(fname).name
            bb = d.get("bbox") or d.get("xyxy") or [0, 0, 0, 0]
            area = max(0, bb[2] - bb[0]) * max(0, bb[3] - bb[1])
            scores[fname] += area
        # 정렬
        picked = sorted(all_frames, key=lambda p: -scores.get(p.name, 0))
        return picked[:top_k]
    except Exception:
        return all_frames[:top_k]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--media-dir", required=True)
    ap.add_argument("--out", default="")
    ap.add_argument("--variants", type=int, default=3)
    args = ap.parse_args()

    media = pathlib.Path(args.media_dir).resolve()
    out = pathlib.Path(args.out).resolve() if args.out else \
          pathlib.Path("logs/thumbnail-pipeline") / time.strftime("%Y%m%d-%H%M%S")

    print(f"[pipeline] media = {media}")
    print(f"[pipeline] out   = {out}")
    print(f"[pipeline] variants = {args.variants}\n")

    result = run_pipeline(media_dir=media, out_dir=out, n_variants=args.variants)
    print("\n=== 결과 ===")
    print(f"status: {result['status']}")
    if result.get("scores"):
        print("CTR scores:")
        for s in result["scores"]:
            print(f"  {s.get('variant'):>3s} · total {s.get('total')} · {s.get('reason','')[:60]}")
    print(f"BEST: {result.get('best')}")
    return 0 if result["status"] == "completed" else 2


if __name__ == "__main__":
    sys.exit(main())
