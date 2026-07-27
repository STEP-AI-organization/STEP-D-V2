"""CLI: python -m core.thumbnail --media-dir <workdir> [--out logs/thumbnail-run/<id>]

스모크: 환승연애 workdir 하나로 세션 하나 돌려서 이미지 나오는지 확인.
"""
from __future__ import annotations
import argparse
import json
import pathlib
import sys
import time

from .ai_session import run_session, run_multi_variant


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--media-dir", required=True,
                    help="content-pipeline workdir (예: .../stepd-content/m_XXXX)")
    ap.add_argument("--out", default="",
                    help="출력 폴더 · 없으면 logs/thumbnail-run/<타임스탬프>")
    ap.add_argument("--hint", default="쇼츠 썸네일 · 프로그램 톤 유지",
                    help="AI 힌트 프롬프트")
    ap.add_argument("--variant-id", default="v1")
    ap.add_argument("--multi", type=int, default=0,
                    help="여러 개 생성할 때 variant 개수")
    ap.add_argument("--nano-banana", action="store_true",
                    help="[DEFAULT] Gemini nano banana 하이브리드 (인물+배경 통짜 · 자막은 시스템)")
    ap.add_argument("--layer", action="store_true",
                    help="구식 Layer 방식 (canvas·rembg) · 기본은 nano-banana 하이브리드")
    args = ap.parse_args()

    # 사용자 지시: nano banana 하이브리드가 default · --layer 옵션으로만 구식
    if not args.layer:
        return _run_nano_banana(args)

    media = pathlib.Path(args.media_dir).resolve()
    if not media.exists():
        print(f"[FAIL] media dir 없음: {media}", file=sys.stderr)
        return 1

    if args.out:
        out = pathlib.Path(args.out).resolve()
    else:
        out = pathlib.Path("logs/thumbnail-run") / time.strftime("%Y%m%d-%H%M%S")

    print(f"[thumb] media = {media}")
    print(f"[thumb] out   = {out}\n")

    if args.multi > 0:
        results = run_multi_variant(
            media_dir=media,
            out_dir=out,
            n_variants=args.multi,
        )
        print("\n=== 세션 결과 ===")
        for i, r in enumerate(results):
            print(f"variant v{i+1}: status={r['status']}, export={r.get('exported_paths')}")
        
        # turn 로그 파일로
        log_path = out / "multi_session.json"
        out.mkdir(parents=True, exist_ok=True)
        log_path.write_text(json.dumps(results, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
        print(f"log    : {log_path}")
        return 0 if any(r.get("exported_paths") for r in results) else 2
    else:
        result = run_session(
            media_dir=media,
            out_dir=out,
            variant_id=args.variant_id,
            hint_prompt=args.hint,
        )

        print("\n=== 세션 결과 ===")
        print(f"status : {result['status']}")
        print(f"export : {result.get('exported_paths')}")

        # turn 로그 파일로
        log_path = out / f"{args.variant_id}_session.json"
        out.mkdir(parents=True, exist_ok=True)
        log_path.write_text(json.dumps(result, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
        print(f"log    : {log_path}")

        return 0 if result.get("exported_paths") else 2


def _run_nano_banana(args) -> int:
    """하이브리드: nano banana = 인물+배경 통짜 · 시스템 Pillow = 자막 얹기 (한글 오타 방지)."""
    from . import nano_banana as NB, planner as PL, generator as GEN
    from io import BytesIO
    from PIL import Image
    media = pathlib.Path(args.media_dir).resolve()
    out = pathlib.Path(args.out).resolve() if args.out else \
          pathlib.Path("logs/thumbnail-run") / time.strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    print(f"[nano+text] media = {media}")
    print(f"[nano+text] out   = {out}\n")

    # 1) 컨텍스트 로드
    pc = json.loads((media / "program_context.json").read_text(encoding="utf-8")) \
        if (media / "program_context.json").exists() else {}
    program_info = pc
    shorts_ctx = {
        "title": pc.get("title", "쇼츠"),
        "description": "",
        "cast_names": pc.get("cast", []),
    }
    nar = json.loads((media / "narrative.json").read_text(encoding="utf-8")) \
        if (media / "narrative.json").exists() else {}
    if isinstance(nar, dict) and nar.get("segments"):
        s0 = nar["segments"][0]
        shorts_ctx["title"] = s0.get("title", shorts_ctx["title"])
        shorts_ctx["description"] = s0.get("summary", "")

    # 2) Planner 로 자막 · 프리셋 뽑기
    plan = PL.generate_plan(media_dir=media, variant_id=args.variant_id + "_planonly",
                             shorts_context=shorts_ctx)
    caption = plan.get("caption", {})
    caption_text = caption.get("text", "")
    if not caption_text:
        print("[FAIL] Planner caption empty", file=sys.stderr)
        return 2
    print(f"[nano+text] caption = {caption_text}")

    # 3) 자료 수집
    cast_dir = media / "cast_photos"
    cast_photos = sorted(cast_dir.glob("*")) if cast_dir.exists() else []
    shot_dir = media / "shot_frames"
    frames = sorted(shot_dir.glob("shot_*.jpg"))[:3] if shot_dir.exists() else []
    print(f"[nano+text] castPhotos: {len(cast_photos)} · frames: {len(frames)}")

    # 4) nano banana 통짜 (인물+배경 · 자막 X)
    img_bytes = NB.generate_image(
        cast_photos=cast_photos, context_frames=frames,
        shorts_context=shorts_ctx, program_info=program_info,
    )
    if not img_bytes:
        print("[FAIL] nano banana returned no image", file=sys.stderr)
        return 2

    # 5) 시스템 Pillow 로 자막 얹기 (한글 오타 방지)
    from .generator import ThumbnailGenerator
    from .canvas import ASPECT_SIZE, Document, LayerTransform
    base = Image.open(BytesIO(img_bytes)).convert("RGB")
    # 16:9 cover-fit
    canvas_size = ASPECT_SIZE["16:9"]
    tw, th = canvas_size
    sw, sh = base.size
    sc = max(tw / sw, th / sh)
    base = base.resize((int(sw * sc), int(sh * sc)), Image.LANCZOS)
    x = (base.width - tw) // 2; y = (base.height - th) // 2
    base = base.crop((x, y, x + tw, y + th))

    # Document 에 background 로 통짜 이미지 · Planner의 caption plan 사용 · 위치 강제 bottom
    doc = Document(aspect="16:9")
    doc.set_layer("background", base.convert("RGBA"),
                  LayerTransform(x=0, y=0, width=tw, height=th))
    caption_forced = dict(caption)
    caption_forced["position"] = "bottom"    # 하단 40% 자리 강제
    caption_forced.setdefault("size_hint", "XL")
    caption_only_plan = {
        "preset_id": plan.get("preset_id", "reaction"),
        "background": {"mode": "solid", "color": "#000000"},  # dummy · 사용 안 함
        "person": {"source": "frame", "frame_id": "dummy", "side": "center", "scale": 0.5},
        "caption": caption_forced,
        "layout_hints": plan.get("layout_hints", {}),
    }
    # ThumbnailGenerator 로 caption layer만 만들어서 doc 에 얹기
    # 임시 workdir (frame lookup 안 하도록) · caption 단독 렌더 helper 직접 호출
    gen = ThumbnailGenerator(media_dir=media, plan=caption_only_plan, aspect="16:9")
    try:
        cap_layer = gen.generate_caption()
        doc.set_layer("caption", cap_layer.image, cap_layer.transform, meta=cap_layer.meta)
    except Exception as e:
        print(f"[warn] caption render failed: {e}", file=sys.stderr)

    final = doc.composite()
    dest = out / f"{args.variant_id}_nano_16x9.png"
    final.save(dest, format="PNG", optimize=True)
    print(f"\n=== 세션 결과 ===\nstatus : completed\nexport : {dest}")
    (out / f"{args.variant_id}_nano_meta.json").write_text(json.dumps({
        "caption": caption_text, "plan": plan,
        "cast_photos": [str(p) for p in cast_photos],
        "frames": [str(p) for p in frames], "shorts_ctx": shorts_ctx,
    }, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
