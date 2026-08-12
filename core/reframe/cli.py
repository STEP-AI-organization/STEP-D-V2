"""Node worker entrypoint for Beat-based automatic reframe analysis."""
from __future__ import annotations

import argparse
import json
import os
import tempfile
import traceback
from pathlib import Path
from typing import Any

from core.reframe.planner import SAMPLE_FPS, build_reframe_plan
from core.reframe.video import analyze_proxy_video, resolve_model_path


def _load_json(path: str | Path) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _load_shots(path: str | Path | None) -> list[float]:
    if not path:
        return []
    payload = _load_json(path)
    raw = payload.get("shots") if isinstance(payload, dict) else payload
    if not isinstance(raw, list):
        raise ValueError("shots JSON must be a list or an object with a shots list")
    result: list[float] = []
    for value in raw:
        try:
            result.append(float(value))
        except (TypeError, ValueError):
            continue
    return result


def _shots_for_proxy(args: argparse.Namespace) -> list[float]:
    """Use source-analysis shots when supplied; otherwise scan the proxy.

    The fallback keeps tracking from gliding across a hard visual cut even for
    a checkpoint that predates ``shots.json``. ``detect_shots`` returns proxy-
    relative seconds, so rebase them onto the source master timeline.
    """

    if args.shots:
        return _load_shots(args.shots)
    from core.scenes.shots import detect_shots

    duration = args.clip_end - args.clip_start
    relative = detect_shots(
        args.video,
        [(0.0, duration)],
        threshold=0.55,
        fps=max(1, int(args.sample_fps + 0.5)),
    )
    return [args.clip_start + value for value in relative]


def write_json_atomic(path: str | Path, payload: dict[str, Any]) -> None:
    """Durably replace one JSON result without exposing a partial file."""

    destination = Path(path).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def _emit(payload: dict[str, Any]) -> None:
    print("@@RESULT " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="core.reframe",
        description="Analyze a clip-only proxy and create a Beat Fill/Fit plan.",
    )
    parser.add_argument("--video", required=True, help="clip-only proxy; t=0 equals --clip-start")
    parser.add_argument("--clip-start", required=True, type=float, help="master absolute seconds")
    parser.add_argument("--clip-end", required=True, type=float, help="master absolute seconds")
    parser.add_argument("--beats", required=True, help="beats.json from source analysis")
    parser.add_argument("--shots", default="", help="optional shots.json (master absolute seconds)")
    parser.add_argument("--output", required=True, help="atomic JSON result destination")
    parser.add_argument("--model", default="", help="MediaPipe .tflite model; env REFRAME_FACE_MODEL fallback")
    parser.add_argument("--sample-fps", type=float, default=SAMPLE_FPS)
    parser.add_argument("--source-width", type=int, default=0, help="original source width; proxy width fallback")
    parser.add_argument("--source-height", type=int, default=0, help="original source height; proxy height fallback")
    return parser


def run(args: argparse.Namespace) -> dict[str, Any]:
    # Fail before the proxy shot scan when production forgot to install the
    # pinned model. This keeps configuration errors fast and deterministic.
    model_path = resolve_model_path(args.model or None)
    beats = _load_json(args.beats)
    shots = _shots_for_proxy(args)

    last_percent = -1

    def progress(done: int, total: int) -> None:
        nonlocal last_percent
        percent = min(99, int(done * 100 / max(1, total)))
        if percent >= last_percent + 10:
            last_percent = percent
            print(f"@@PROGRESS reframe {percent} face detection", flush=True)

    observations, width, height = analyze_proxy_video(
        args.video,
        clip_start=args.clip_start,
        clip_end=args.clip_end,
        model_path=model_path,
        sample_fps=args.sample_fps,
        progress=progress,
    )
    plan = build_reframe_plan(
        beats_payload=beats,
        observations=observations,
        clip_start=args.clip_start,
        clip_end=args.clip_end,
        source_width=args.source_width or width,
        source_height=args.source_height or height,
        proxy_width=width,
        proxy_height=height,
        shot_boundaries=shots,
        sample_fps=args.sample_fps,
    )
    write_json_atomic(args.output, plan)
    return plan


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        plan = run(args)
        fill_count = sum(beat["layout"] == "fill" for beat in plan["beats"])
        _emit({
            "ok": True,
            "output": str(Path(args.output).resolve()),
            "beatCount": len(plan["beats"]),
            "fillCount": fill_count,
        })
        return 0
    except Exception as exc:
        traceback.print_exc()
        _emit({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
