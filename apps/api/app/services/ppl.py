"""On-demand PPL (product placement) analysis for a rendered Short.

Samples frames from the rendered clip, asks Gemini to detect branded products
with bounding boxes, then aggregates the per-frame detections into a product
list (for sponsorship reporting + affiliate tagging) plus a per-frame overlay
track (for drawing boxes synced to playback). Boxes are normalized to 0..1 of
the rendered frame so the frontend can position them as percentages.
"""

import math
from datetime import datetime
from typing import Any

from app.core.config import get_settings
from app.core.database import session_scope
from app.models import Clip
from app.services.ffmpeg import extract_frames
from app.services.gemini import detect_ppl
from app.services.storage import ensure_job_dirs, media_path_from_url


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def _norm_box(box: Any) -> list[float] | None:
    """Gemini returns [ymin, xmin, ymax, xmax] in 0-1000. Convert to
    [x, y, w, h] normalized 0..1, or None if the box is unusable."""
    if not isinstance(box, (list, tuple)) or len(box) != 4:
        return None
    try:
        ymin, xmin, ymax, xmax = (float(v) / 1000.0 for v in box)
    except (TypeError, ValueError):
        return None
    x, y = _clamp(xmin), _clamp(ymin)
    w, h = _clamp(xmax) - x, _clamp(ymax) - y
    if w <= 0.005 or h <= 0.005:
        return None
    return [round(x, 4), round(y, 4), round(w, 4), round(h, 4)]


def _sample_times(duration: float, settings) -> list[float]:
    interval = max(0.1, float(settings.ppl_sample_interval_seconds))
    if duration <= 0:
        return [0.0]
    count = max(1, min(int(settings.ppl_max_frames), math.ceil(duration / interval)))
    step = duration / count
    # Sample the centre of each segment so the first/last frames aren't black.
    return [round(min(duration - 0.05, (i + 0.5) * step), 2) for i in range(count)]


def _product_key(brand: str, product: str) -> str:
    return f"{brand.strip().lower()}|{product.strip().lower()}"


def build_ppl_analysis(clip: Clip, settings) -> dict[str, Any]:
    short_path = media_path_from_url(settings, clip.video_url)
    if not short_path.exists():
        raise FileNotFoundError(f"Rendered short not found for clip {clip.id}")

    duration = max(0.0, float(clip.end_time) - float(clip.start_time))
    times = _sample_times(duration, settings)

    dirs = ensure_job_dirs(settings, clip.job_id)
    prefix = f"ppl_{clip.rank:03d}"
    frame_paths = extract_frames(short_path, dirs["frames"], times, settings, prefix)
    try:
        raw_frames = detect_ppl(frame_paths, times, settings)
    finally:
        for path in frame_paths:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass

    min_conf = float(settings.ppl_min_confidence)
    overlay_frames: list[dict[str, Any]] = []
    products: dict[str, dict[str, Any]] = {}
    step = duration / len(times) if times else 0.0

    for frame in raw_frames:
        if not isinstance(frame, dict):
            continue
        index = frame.get("frame_index")
        if not isinstance(index, int) or index < 0 or index >= len(times):
            continue
        timestamp = times[index]
        frame_dets: list[dict[str, Any]] = []
        for det in frame.get("detections") or []:
            if not isinstance(det, dict):
                continue
            confidence = _clamp(float(det.get("confidence") or 0.0))
            if confidence < min_conf:
                continue
            brand = str(det.get("brand") or "").strip()
            product = str(det.get("product") or "").strip()
            if not product and not brand:
                continue
            box = _norm_box(det.get("box"))
            if box is None:
                continue
            category = str(det.get("category") or "").strip()
            key = _product_key(brand or "노브랜드", product or category or "상품")

            entry = products.get(key)
            if entry is None:
                entry = {
                    "id": f"ppl_{len(products) + 1}",
                    "brand": brand or "노브랜드",
                    "product": product or category or "상품",
                    "category": category,
                    "confidence": confidence,
                    "first_seen": timestamp,
                    "last_seen": timestamp,
                    "frames_seen": 0,
                    "best_box": box,
                    "affiliate_url": "",
                }
                products[key] = entry
            entry["confidence"] = max(entry["confidence"], confidence)
            entry["first_seen"] = min(entry["first_seen"], timestamp)
            entry["last_seen"] = max(entry["last_seen"], timestamp)
            entry["frames_seen"] += 1
            if confidence >= entry["confidence"]:
                entry["best_box"] = box
            if category and not entry["category"]:
                entry["category"] = category

            frame_dets.append({
                "product_id": entry["id"],
                "brand": entry["brand"],
                "product": entry["product"],
                "box": box,
                "confidence": round(confidence, 3),
            })
        overlay_frames.append({"timestamp": timestamp, "detections": frame_dets})

    product_list = []
    for entry in products.values():
        entry["exposure_seconds"] = round(entry["frames_seen"] * step, 2)
        entry["confidence"] = round(entry["confidence"], 3)
        product_list.append(entry)
    product_list.sort(key=lambda item: (item["exposure_seconds"], item["confidence"]), reverse=True)

    overlay_frames.sort(key=lambda item: item["timestamp"])

    return {
        "status": "done",
        "model": settings.gemini_model,
        "analyzed_at": datetime.utcnow().isoformat(),
        "duration_seconds": round(duration, 2),
        "frame_count": len(times),
        "products": product_list,
        "frames": overlay_frames,
    }


def analyze_clip_ppl(clip_id: str) -> dict[str, Any]:
    """Run PPL analysis for a clip and persist the result on the clip."""
    settings = get_settings()
    with session_scope() as db:
        clip = db.get(Clip, clip_id)
        if not clip:
            raise ValueError("Clip not found")
        analysis = build_ppl_analysis(clip, settings)
        clip.ppl_analysis_json = analysis
        return analysis


def update_ppl_affiliate_links(clip_id: str, links: dict[str, str]) -> dict[str, Any]:
    """Patch affiliate URLs for already-detected products (tagging workflow)."""
    with session_scope() as db:
        clip = db.get(Clip, clip_id)
        if not clip:
            raise ValueError("Clip not found")
        analysis = dict(clip.ppl_analysis_json or {})
        products = [dict(item) for item in analysis.get("products") or []]
        for product in products:
            if product.get("id") in links:
                product["affiliate_url"] = str(links[product["id"]] or "").strip()
        analysis["products"] = products
        clip.ppl_analysis_json = analysis
        return analysis
