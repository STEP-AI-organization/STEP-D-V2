"""MediaPipe FaceDetector adapter for the reframe planner."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Callable

from core.reframe.planner import FaceBox, FrameObservation, PlanInputError

DEFAULT_MODEL_PATH = Path(__file__).resolve().parents[1] / ".models" / "blaze_face_full_range.tflite"


class ModelConfigurationError(RuntimeError):
    """MediaPipe or its face model is not installed/configured correctly."""


def resolve_model_path(explicit: str | Path | None = None) -> Path:
    raw = explicit or os.environ.get("REFRAME_FACE_MODEL") or DEFAULT_MODEL_PATH
    path = Path(raw).expanduser().resolve()
    if not path.is_file():
        raise ModelConfigurationError(
            f"reframe face model not found: {path}; set REFRAME_FACE_MODEL or run "
            "`python -m core.reframe.download_model`"
        )
    return path


def _mediapipe_detector(model_path: Path):
    try:
        import mediapipe as mp
        from mediapipe.tasks import python
        from mediapipe.tasks.python import vision
    except ImportError as exc:
        raise ModelConfigurationError(
            "mediapipe is not installed; install core/requirements.txt"
        ) from exc

    options = vision.FaceDetectorOptions(
        base_options=python.BaseOptions(model_asset_path=str(model_path)),
        running_mode=vision.RunningMode.VIDEO,
        min_detection_confidence=0.50,
        min_suppression_threshold=0.30,
    )
    return mp, vision.FaceDetector.create_from_options(options)


def analyze_proxy_video(
    video_path: str | Path,
    *,
    clip_start: float,
    clip_end: float,
    model_path: str | Path | None = None,
    sample_fps: float = 5.0,
    progress: Callable[[int, int], None] | None = None,
) -> tuple[list[FrameObservation], int, int]:
    """Sample a clip-only proxy and return master-absolute observations.

    Proxy time zero must represent ``clip_start``.  The worker is expected to
    provide a roughly 640px proxy; this function still caps inference at
    ``sample_fps`` if a higher-frame-rate source is supplied.
    """

    if clip_end <= clip_start:
        raise PlanInputError("clip_end must be greater than clip_start")
    if sample_fps <= 0:
        raise PlanInputError("sample_fps must be positive")
    path = Path(video_path).resolve()
    if not path.is_file():
        raise PlanInputError(f"proxy video not found: {path}")
    resolved_model = resolve_model_path(model_path)

    try:
        import cv2
    except ImportError as exc:
        raise ModelConfigurationError("opencv-python is not installed") from exc

    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        raise PlanInputError(f"cannot open proxy video: {path}")
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
    if fps <= 0:
        fps = 25.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    if width <= 0 or height <= 0:
        capture.release()
        raise PlanInputError("proxy video has invalid dimensions")
    total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    estimated_samples = max(1, int(min((clip_end - clip_start) * sample_fps, total_frames) + 0.5))

    observations: list[FrameObservation] = []
    next_sample = 0.0
    frame_index = 0
    previous_timestamp_ms = -1
    mp = None
    detector = None
    try:
        mp, detector = _mediapipe_detector(resolved_model)
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            relative_t = frame_index / fps
            frame_index += 1
            if relative_t + 1e-9 < next_sample:
                continue
            next_sample += 1.0 / sample_fps
            absolute_t = clip_start + relative_t
            if absolute_t >= clip_end - 1e-6:
                break

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            timestamp_ms = max(previous_timestamp_ms + 1, int(relative_t * 1000.0 + 0.5))
            previous_timestamp_ms = timestamp_ms
            result = detector.detect_for_video(image, timestamp_ms)
            faces: list[FaceBox] = []
            for detection in result.detections:
                bbox = detection.bounding_box
                confidence = (
                    float(detection.categories[0].score)
                    if detection.categories else 0.0
                )
                x = max(0.0, float(bbox.origin_x) / width)
                y = max(0.0, float(bbox.origin_y) / height)
                box_width = min(1.0 - x, max(0.0, float(bbox.width) / width))
                box_height = min(1.0 - y, max(0.0, float(bbox.height) / height))
                if box_width > 0.0 and box_height > 0.0:
                    faces.append(FaceBox(x, y, box_width, box_height, confidence))
            observations.append(FrameObservation(round(absolute_t, 6), tuple(faces)))
            if progress:
                progress(len(observations), estimated_samples)
    finally:
        capture.release()
        if detector is not None:
            detector.close()

    if not observations:
        raise PlanInputError("proxy video yielded no sampled frames")
    return observations, width, height
