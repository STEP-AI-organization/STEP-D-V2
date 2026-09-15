"""Standalone GPU-lane entrypoint for the registered-cast stage.

The regular content worker can leave this stage disabled and enqueue ``cast.detect``
instead.  Keeping the CLI small also lets the existing L4 VM run a separate image
without importing the Node worker or the GEBD container.
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from core.vision.yolo_cast import apply_beat_cast, detect_beat_cast


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--beats", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--cast-registry")
    ap.add_argument("--program-context")
    ap.add_argument("--photos-dir", required=True)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    photos = out / "cast_photos"
    if photos.resolve() != Path(args.photos_dir).resolve():
        shutil.copytree(args.photos_dir, photos, dirs_exist_ok=True)
    beats_data = json.loads(Path(args.beats).read_text(encoding="utf-8"))
    registry = json.loads(Path(args.cast_registry).read_text(encoding="utf-8")) if args.cast_registry else None
    context = json.loads(Path(args.program_context).read_text(encoding="utf-8")) if args.program_context else None
    result = detect_beat_cast(
        args.video,
        beats_data.get("beats") or [],
        out,
        cast_registry=(registry.get("cast") if isinstance(registry, dict) else registry),
        program_context=context if isinstance(context, dict) else None,
    )
    (out / "cast_detections.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    apply_beat_cast(beats_data.get("beats") or [], result, context if isinstance(context, dict) else None)
    (out / "beats.json").write_text(json.dumps(beats_data, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"status": result.get("status"), "frames": result.get("frames", 0)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
