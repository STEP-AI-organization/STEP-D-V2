"""CLI: python -m core.thumbnail --media-dir <workdir> [--out logs/thumbnail-run/<id>]

스모크: 환승연애 workdir 하나로 세션 하나 돌려서 이미지 나오는지 확인.
"""
from __future__ import annotations
import argparse
import json
import pathlib
import sys
import time

from .ai_session import run_session


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--media-dir", required=True,
                    help="content-pipeline workdir (예: .../stepd-content/m_XXXX)")
    ap.add_argument("--out", default="",
                    help="출력 폴더 · 없으면 logs/thumbnail-run/<타임스탬프>")
    ap.add_argument("--hint", default="쇼츠 썸네일 · 프로그램 톤 유지",
                    help="AI 힌트 프롬프트")
    ap.add_argument("--variant-id", default="v1")
    args = ap.parse_args()

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

    result = run_session(
        media_dir=media,
        out_dir=out,
        variant_id=args.variant_id,
        hint_prompt=args.hint,
    )

    print("\n=== 세션 결과 ===")
    print(f"status : {result['status']}")
    print(f"turns  : {len(result['turns'])}")
    print(f"export : {result.get('exported_path')}")

    # turn 로그 파일로
    log_path = out / f"{args.variant_id}_session.json"
    out.mkdir(parents=True, exist_ok=True)
    log_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"log    : {log_path}")

    return 0 if result.get("exported_path") else 2


if __name__ == "__main__":
    sys.exit(main())
