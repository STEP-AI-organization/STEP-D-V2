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
    """심플: (배경/배치/제목) + 프레임 하나 → Gemini nano banana."""
    from . import nano_banana as NB, planner as PL
    media = pathlib.Path(args.media_dir).resolve()
    out = pathlib.Path(args.out).resolve() if args.out else \
          pathlib.Path("logs/thumbnail-run") / time.strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    print(f"[nano] media = {media}")
    print(f"[nano] out   = {out}\n")

    # 1) 컨텍스트
    pc = json.loads((media / "program_context.json").read_text(encoding="utf-8")) \
        if (media / "program_context.json").exists() else {}
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
        shorts_ctx["shorts"] = {"start": s0.get("start", 0), "end": s0.get("end", 60)}

    # 2) Planner (variant 1 개)
    plans = PL.generate_variant_prompts(media_dir=media, n=1, shorts_context=shorts_ctx)
    if not plans:
        print("[FAIL] planner returned no variants", file=sys.stderr)
        return 2
    plan_v = plans[0]
    print(f"[nano] background = {plan_v.get('background')}")
    print(f"[nano] layout     = {plan_v.get('layout')}")
    print(f"[nano] caption    = {plan_v.get('caption')}")

    # 3) 프레임
    shot_dir = media / "shot_frames"
    frames = sorted(shot_dir.glob("shot_*.jpg"))[:1] if shot_dir.exists() else []
    if not frames:
        print("[FAIL] no frames in workdir", file=sys.stderr)
        return 2

    from . import caption_overlay as OV
    img_bytes = NB.generate_thumbnail(
        background=plan_v.get("background", "원본 프레임 그대로"),
        layout=plan_v.get("layout", "인물 중앙 · 자막 하단"),
        caption_position=plan_v.get("caption_position", "bottom-left"),
        frame=frames[0],
    )
    if not img_bytes:
        print("[FAIL] nano banana returned no image", file=sys.stderr)
        return 2
    img_bytes = OV.render_caption(
        img_bytes=img_bytes,
        caption=plan_v.get("caption", ""),
        position=plan_v.get("caption_position", "bottom-left"),
        size=plan_v.get("caption_size", "L"),
    )

    dest = out / f"{args.variant_id}_nano_16x9.png"
    dest.write_bytes(img_bytes)
    print(f"\n=== 세션 결과 ===\nstatus : completed\nexport : {dest}")
    (out / f"{args.variant_id}_nano_meta.json").write_text(json.dumps({
        "plan": plan_v, "frame": str(frames[0]), "shorts_ctx": shorts_ctx,
    }, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
