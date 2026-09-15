"""YOLO-based per-beat cast detection.

YOLO answers *where a person is*.  Identity is resolved separately by comparing an
InsightFace/ArcFace embedding from the detected person crop with the operator-provided
program cast photos.  Keeping the two responsibilities separate gives us a closed-set,
auditable result instead of asking a vision LLM to guess a celebrity name.

The stage is intentionally checkpoint-friendly and has no import-time ML dependency.
``ultralytics`` and ``insightface`` are imported only when a program actually has cast
photos and ``RUN_YOLO_CAST`` is enabled.  Output is written by the caller to
``cast_detections.json`` and merged into ``beats.json`` as:

    beat.characters_visible = [canonical program-cast name, ...]
    beat.cast_visible = [{castId, name, actorName, characterNames, confidence, ...}]
    beat.characters_visible_source = "yolo_cast"

The canonical ``name`` remains compatible with speaker/cast/search code.  ``actorName``
is title-only metadata derived from program.titleCast (character name -> actor name).
"""
from __future__ import annotations

from collections import defaultdict
import os
from pathlib import Path
from typing import Callable, Iterable


VERSION = "2026-09-15-yolo26-beat-cast-v1"
PHOTO_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


def _norm_name(value: object) -> str:
    return str(value or "").strip()


def _safe_stem(value: str) -> str:
    return value.replace("/", "_").replace("\\", "_").replace("\x00", "_").strip()[:60]


def _l2(values) -> "object":
    """Return an L2-normalized numpy vector without importing numpy at module load."""
    import numpy as np

    arr = np.asarray(values, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(arr))
    return arr / norm if norm > 1e-8 else arr


def match_embedding(
    embedding,
    references: list[dict],
    *,
    min_similarity: float = 0.35,
    min_margin: float = 0.05,
) -> dict | None:
    """Closed-set cosine match with an explicit unknown/reject region.

    Each reference is ``{"embedding": vector, ...identity metadata...}``.  Several
    photos may point to the same castId; their best score represents that person.  A
    result is returned only when both the absolute threshold and first-vs-second-person
    margin pass.  This is deliberately precision-first: a missing name is preferable to
    putting the wrong actor in an exported title.
    """
    import numpy as np

    if not references:
        return None
    query = _l2(embedding)
    by_person: dict[str, tuple[float, dict]] = {}
    for ref in references:
        ref_emb = ref.get("embedding")
        if ref_emb is None:
            continue
        score = float(np.dot(query, _l2(ref_emb)))
        key = _norm_name(ref.get("castId")) or _norm_name(ref.get("name"))
        if not key:
            continue
        previous = by_person.get(key)
        if previous is None or score > previous[0]:
            by_person[key] = (score, ref)
    ranked = sorted(by_person.values(), key=lambda item: item[0], reverse=True)
    if not ranked:
        return None
    best_score, best = ranked[0]
    second_score = ranked[1][0] if len(ranked) > 1 else -1.0
    if best_score < min_similarity or best_score - second_score < min_margin:
        return None
    return {
        **{k: v for k, v in best.items() if k != "embedding"},
        "similarity": round(best_score, 4),
        "margin": round(best_score - second_score, 4),
    }


def _title_identity(name: str, program_context: dict | None) -> tuple[str, list[str]]:
    """Return actor title name and all character aliases for one canonical cast name."""
    rows = (program_context or {}).get("titleCast") or []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        actor = _norm_name(row.get("actorName"))
        characters = [_norm_name(n) for n in (row.get("characterNames") or [])]
        characters = [n for n in characters if n]
        if name == actor or name in characters:
            return actor or name, characters
    return name, [name]


def _member_for_photo(stem: str, cast_registry: list[dict] | None) -> dict:
    """Resolve a photo filename to the program roster entry that owns it."""
    clean = stem.split("__", 1)[0]
    for member in cast_registry or []:
        if not isinstance(member, dict):
            continue
        names = [_norm_name(member.get("name")), *[_norm_name(a) for a in (member.get("aliases") or [])]]
        if clean in {_safe_stem(n) for n in names if n}:
            return member
    return {"castId": clean, "name": clean, "aliases": []}


def _face_app():
    """Create the face detector/ArcFace embedder used after YOLO person detection."""
    from insightface.app import FaceAnalysis

    requested = (os.environ.get("YOLO_CAST_FACE_PROVIDERS") or "CUDAExecutionProvider,CPUExecutionProvider")
    providers = [p.strip() for p in requested.split(",") if p.strip()]
    app = FaceAnalysis(
        name=os.environ.get("YOLO_CAST_FACE_MODEL") or "buffalo_l",
        providers=providers,
        root=str(Path(os.environ.get("YOLO_CAST_MODEL_ROOT") or "~/.insightface").expanduser()),
    )
    use_cuda = any(p == "CUDAExecutionProvider" for p in providers)
    app.prepare(ctx_id=0 if use_cuda else -1, det_size=(640, 640))
    return app


def _reference_embeddings(
    photos_dir: Path,
    cast_registry: list[dict] | None,
    program_context: dict | None,
    face_app,
) -> list[dict]:
    import cv2

    references: list[dict] = []
    for photo in sorted(photos_dir.iterdir()):
        if photo.suffix.lower() not in PHOTO_EXTS:
            continue
        image = cv2.imread(str(photo))
        if image is None:
            continue
        faces = list(face_app.get(image) or [])
        if not faces:
            continue
        # Profile photos should have one subject; if not, take the largest face and keep
        # the filename/roster as the identity ground truth.
        face = max(faces, key=lambda f: float((f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1])))
        member = _member_for_photo(photo.stem, cast_registry)
        name = _norm_name(member.get("name")) or photo.stem
        actor_name, character_names = _title_identity(name, program_context)
        references.append({
            "castId": _norm_name(member.get("castId")) or name,
            "name": name,
            "actorName": actor_name,
            "characterNames": character_names,
            "photo": photo.name,
            "embedding": _l2(face.normed_embedding),
        })
    return references


def _sample_times(beat: dict, frames_per_beat: int) -> list[float]:
    try:
        start, end = float(beat.get("start", 0)), float(beat.get("end", 0))
    except (TypeError, ValueError):
        return []
    if end - start < 0.2:
        return []
    pad = min(0.35, (end - start) * 0.1)
    lo, hi = start + pad, end - pad
    if frames_per_beat <= 1 or hi <= lo:
        return [(start + end) / 2]
    return [lo + (hi - lo) * i / (frames_per_beat - 1) for i in range(frames_per_beat)]


def _inside(face_box: Iterable[float], person_box: Iterable[float]) -> bool:
    fx1, fy1, fx2, fy2 = [float(v) for v in face_box]
    px1, py1, px2, py2 = [float(v) for v in person_box]
    cx, cy = (fx1 + fx2) / 2, (fy1 + fy2) / 2
    return px1 <= cx <= px2 and py1 <= cy <= py2


def aggregate_beat_matches(
    frame_matches: list[dict],
    *,
    min_hits: int = 1,
    min_coverage: float = 0.20,
) -> dict[int, list[dict]]:
    """Aggregate accepted face matches into precision-first per-beat identities."""
    frame_totals: dict[int, set[int]] = defaultdict(set)
    hits: dict[tuple[int, str], list[dict]] = defaultdict(list)
    for row in frame_matches:
        beat_id = int(row["beatId"])
        frame_index = int(row["frameIndex"])
        frame_totals[beat_id].add(frame_index)
        for match in row.get("matches") or []:
            cast_id = _norm_name(match.get("castId"))
            if cast_id:
                hits[(beat_id, cast_id)].append({**match, "frameIndex": frame_index, "time": row.get("time")})

    out: dict[int, list[dict]] = defaultdict(list)
    for (beat_id, _cast_id), rows in hits.items():
        unique_frames = {int(r["frameIndex"]) for r in rows}
        coverage = len(unique_frames) / max(1, len(frame_totals[beat_id]))
        if len(unique_frames) < min_hits or coverage < min_coverage:
            continue
        best = max(rows, key=lambda r: float(r.get("similarity") or 0))
        similarities = [float(r.get("similarity") or 0) for r in rows]
        confidence = sum(similarities) / len(similarities)
        out[beat_id].append({
            **{k: v for k, v in best.items() if k not in {"frameIndex", "time", "photo", "margin", "similarity"}},
            "confidence": round(confidence, 4),
            "coverage": round(coverage, 4),
            "hits": len(unique_frames),
            "evidenceTimes": [round(float(r["time"]), 3) for r in rows[:6] if r.get("time") is not None],
            "source": "yolo_cast",
        })
    for beat_id in out:
        out[beat_id].sort(key=lambda r: (-float(r["coverage"]), -float(r["confidence"]), r["name"]))
    return dict(out)


def apply_beat_cast(
    beats: list[dict],
    detections: dict,
    program_context: dict | None = None,
) -> int:
    """Merge checkpoint output into beats. Returns number of beats with known cast."""
    table = detections.get("beats") if isinstance(detections, dict) else None
    table = table if isinstance(table, dict) else {}
    applied = 0
    for index, beat in enumerate(beats or []):
        # A changed roster/photo set must not leave identities from the previous checkpoint.
        if beat.get("characters_visible_source") == "yolo_cast":
            beat.pop("cast_visible", None)
            beat.pop("characters_visible", None)
            beat.pop("characters_visible_source", None)
        beat_id = beat.get("id", index)
        rows = table.get(str(beat_id), table.get(str(index), []))
        if not isinstance(rows, list) or not rows:
            continue
        clean = []
        for source in rows:
            if not isinstance(source, dict):
                continue
            name = _norm_name(source.get("name"))
            if not name:
                continue
            # Face inference can be reused when only the title-only actor/character map
            # changes. Re-derive those labels from today's program context at merge time.
            actor_name, character_names = _title_identity(name, program_context)
            clean.append({
                **source,
                "name": name,
                "actorName": actor_name,
                "characterNames": character_names,
            })
        if not clean:
            continue
        beat["cast_visible"] = clean
        # Keep canonical program-cast names here. Actor names are title-only and remain in
        # cast_visible.actorName so dialogue/speaker facts are never rewritten to a performer.
        beat["characters_visible"] = list(dict.fromkeys(_norm_name(r.get("name")) for r in clean))[:6]
        beat["characters_visible_source"] = "yolo_cast"
        applied += 1
    return applied


def detect_beat_cast(
    video_path: str | Path,
    beats: list[dict],
    out_dir: str | Path,
    *,
    cast_registry: list[dict] | None = None,
    program_context: dict | None = None,
    on_progress: Callable[[int, int], None] | None = None,
) -> dict:
    """Run YOLO person detection + ArcFace matching on representative beat frames."""
    import cv2
    from ultralytics import YOLO

    photos_dir = Path(out_dir) / "cast_photos"
    if not photos_dir.exists():
        return {"version": VERSION, "status": "no_cast_photos", "beats": {}}

    face_app = _face_app()
    references = _reference_embeddings(photos_dir, cast_registry, program_context, face_app)
    if not references:
        return {"version": VERSION, "status": "no_reference_faces", "beats": {}}

    model_name = os.environ.get("YOLO_CAST_MODEL") or "yolo26n.pt"
    model = YOLO(model_name)
    frames_per_beat = max(1, min(5, int(os.environ.get("YOLO_CAST_FRAMES_PER_BEAT") or 3)))
    confidence = float(os.environ.get("YOLO_CAST_PERSON_CONF") or 0.25)
    min_similarity = float(os.environ.get("YOLO_CAST_FACE_SIM") or 0.35)
    min_margin = float(os.environ.get("YOLO_CAST_FACE_MARGIN") or 0.05)
    device = os.environ.get("YOLO_CAST_DEVICE") or None

    samples: list[tuple[int, int, float, object]] = []
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"YOLO cast: video open failed: {video_path}")
    try:
        for index, beat in enumerate(beats or []):
            beat_id = int(beat.get("id", index))
            for timestamp in _sample_times(beat, frames_per_beat):
                cap.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000)
                ok, frame = cap.read()
                if ok and frame is not None:
                    samples.append((beat_id, len(samples), timestamp, frame))
    finally:
        cap.release()

    frame_matches: list[dict] = []
    batch_size = max(1, int(os.environ.get("YOLO_CAST_BATCH") or 16))
    for offset in range(0, len(samples), batch_size):
        batch = samples[offset:offset + batch_size]
        images = [row[3] for row in batch]
        results = model.predict(
            source=images,
            classes=[0],  # COCO person
            conf=confidence,
            imgsz=int(os.environ.get("YOLO_CAST_IMGSZ") or 640),
            device=device,
            verbose=False,
        )
        for sample, result in zip(batch, results):
            beat_id, frame_index, timestamp, frame = sample
            person_boxes = []
            boxes = getattr(result, "boxes", None)
            xyxy = getattr(boxes, "xyxy", None) if boxes is not None else None
            if xyxy is not None:
                if hasattr(xyxy, "detach"):
                    xyxy = xyxy.detach().cpu().numpy()
                person_boxes = xyxy.tolist() if hasattr(xyxy, "tolist") else list(xyxy)
            accepted: dict[str, dict] = {}
            for face in list(face_app.get(frame) or []):
                face_box = [float(v) for v in face.bbox]
                # YOLO is the object gate. A face detector hit without a COCO-person box
                # is not treated as an appearance (prevents background/overlay faces).
                if not person_boxes or not any(_inside(face_box, box) for box in person_boxes):
                    continue
                match = match_embedding(
                    face.normed_embedding,
                    references,
                    min_similarity=min_similarity,
                    min_margin=min_margin,
                )
                if match is None:
                    continue
                cast_id = _norm_name(match.get("castId"))
                previous = accepted.get(cast_id)
                if previous is None or float(match["similarity"]) > float(previous["similarity"]):
                    accepted[cast_id] = match
            frame_matches.append({
                "beatId": beat_id,
                "frameIndex": frame_index,
                "time": timestamp,
                "persons": len(person_boxes),
                "matches": list(accepted.values()),
            })
        if on_progress:
            on_progress(min(offset + len(batch), len(samples)), len(samples))

    min_hits = max(1, int(os.environ.get("YOLO_CAST_MIN_HITS") or 1))
    min_coverage = max(0.0, min(1.0, float(os.environ.get("YOLO_CAST_MIN_COVERAGE") or 0.20)))
    aggregated = aggregate_beat_matches(frame_matches, min_hits=min_hits, min_coverage=min_coverage)
    return {
        "version": VERSION,
        "status": "done",
        "model": model_name,
        "framesPerBeat": frames_per_beat,
        "frames": len(samples),
        "references": [
            {k: v for k, v in ref.items() if k != "embedding"}
            for ref in references
        ],
        "beats": {str(k): v for k, v in aggregated.items()},
    }
