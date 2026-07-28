"""CLI · 서버 (`apps/server/src/content-pipeline.ts`) 가 호출하는 진입점.

호출 계약 (변경 금지 · 서버가 이 형식 파싱):
  python -m core.thumbnail --media-dir <workdir> --out <shortThumbOutDir> --multi 3

  → <shortThumbOutDir>/multi_session.json 생성
  → [{status, variant_id, exported_paths: {"16:9": path}, plan?, error?}, ...]

기본 실행: hybrid pipeline (bg gen + castPhoto 세그 + 자막 오버레이)
"""
from __future__ import annotations
import argparse
import json
import pathlib
import sys
import time


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--media-dir", required=True,
                    help="content-pipeline workdir (예: .../stepd-content/m_XXXX)")
    ap.add_argument("--out", default="",
                    help="출력 폴더 · 없으면 logs/thumbnail-run/<타임스탬프>")
    ap.add_argument("--multi", type=int, default=3,
                    help="variant 개수 (기본 3)")
    ap.add_argument("--variant-id", default="v1",
                    help="(레거시 single 모드용 · --multi 0 일 때만 사용)")
    ap.add_argument("--legacy-layer", action="store_true",
                    help="(디버그) 구식 Layer 방식 · canvas·rembg")
    args = ap.parse_args()

    media = pathlib.Path(args.media_dir).resolve()
    if not media.exists():
        print(f"[FAIL] media dir 없음: {media}", file=sys.stderr)
        return 1
    out = pathlib.Path(args.out).resolve() if args.out else \
          pathlib.Path("logs/thumbnail-run") / time.strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True, exist_ok=True)

    if args.legacy_layer:
        return _run_legacy_layer(media, out, args)

    # 기본: hybrid pipeline · variant N개 · multi_session.json 서버 규격 출력
    return _run_pipeline_multi(media, out, n_variants=max(1, args.multi))


def _run_pipeline_multi(media: pathlib.Path, out: pathlib.Path, n_variants: int) -> int:
    """새 hybrid pipeline · 서버 규격 multi_session.json 저장."""
    from . import pipeline as PP

    print(f"[thumb] media = {media}")
    print(f"[thumb] out   = {out}")
    print(f"[thumb] variants = {n_variants}\n")

    result = PP.run_pipeline(media_dir=media, out_dir=out, n_variants=n_variants)

    # 서버 규격 매핑: [{status, variant_id, exported_paths, plan, error}]
    plans = (result.get("log") or {}).get("stages", {}).get("4_planner", {}).get("variants", []) or []
    plans_by_vid: dict[str, dict] = {}
    for i, pl in enumerate(plans):
        plans_by_vid[f"v{i+1}"] = pl

    paths = (result.get("variants") or {})  # {vid: str path}
    scores = {s.get("variant"): s for s in (result.get("scores") or [])}
    best_id = None
    if result.get("best"):
        # best_path: .../BEST_vX.png
        try:
            best_id = pathlib.Path(result["best"]).stem.replace("BEST_", "")
        except Exception:
            pass

    session_results: list[dict] = []
    all_vids = sorted(plans_by_vid.keys() | paths.keys(),
                       key=lambda x: int(x.lstrip("v") or 0) if x.lstrip("v").isdigit() else 999)
    if not all_vids:
        all_vids = [f"v{i+1}" for i in range(n_variants)]

    for vid in all_vids:
        exported = paths.get(vid)
        entry: dict = {"variant_id": vid, "plan": plans_by_vid.get(vid, {})}
        if exported:
            entry["status"] = "completed"
            entry["exported_paths"] = {"16:9": exported}
        else:
            entry["status"] = "failed"
            entry["error"] = "no image (gen fail or quota)"
        if vid in scores:
            entry["ctr"] = scores[vid]
        if best_id == vid:
            entry["best"] = True
        session_results.append(entry)

    log_path = out / "multi_session.json"
    log_path.write_text(json.dumps(session_results, ensure_ascii=False,
                                    indent=2, default=str), encoding="utf-8")

    print(f"\n=== 서버 계약 출력 ===")
    for r in session_results:
        vid = r["variant_id"]
        if r["status"] == "completed":
            print(f"  {vid}: OK · {r['exported_paths']['16:9']}")
        else:
            print(f"  {vid}: FAIL · {r.get('error')}")
    print(f"log: {log_path}")

    return 0 if any(r["status"] == "completed" for r in session_results) else 2


def _run_legacy_layer(media: pathlib.Path, out: pathlib.Path, args) -> int:
    """구식 Layer 방식 (canvas·rembg 조립) · 디버그용만."""
    from .ai_session import run_session, run_multi_variant
    print(f"[legacy] media = {media}\n[legacy] out = {out}\n")
    if args.multi > 0:
        results = run_multi_variant(media_dir=media, out_dir=out, n_variants=args.multi)
        log_path = out / "multi_session.json"
        log_path.write_text(json.dumps(results, ensure_ascii=False, indent=2, default=str),
                             encoding="utf-8")
        return 0 if any(r.get("exported_paths") for r in results) else 2
    else:
        result = run_session(media_dir=media, out_dir=out, variant_id=args.variant_id)
        log_path = out / f"{args.variant_id}_session.json"
        log_path.write_text(json.dumps(result, ensure_ascii=False, indent=2, default=str),
                             encoding="utf-8")
        return 0 if result.get("exported_paths") else 2


if __name__ == "__main__":
    sys.exit(main())
