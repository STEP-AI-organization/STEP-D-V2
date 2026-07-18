"""
STEP D Core — Scene importance pre-filter (algorithmic, pre-Gemini)

Philosophy: AI makes the creative call; algorithms do the grunt work. Instead of paying
Gemini Vision for all ~200 scene frames, we score every scene with cheap non-AI signals
and send only the top-N to Gemini (≈85% fewer image calls). The rest keep a heuristic
`vision_score` so downstream recommend.py still ranks them — they're just the ones the
algorithm judged least likely to be a payoff moment.

Signals (each isolated + optional; a missing lib or a bad frame contributes 0):
  - faces     : OpenCV Haar cascade face count on the representative frame
  - audio     : librosa onset strength (or numpy RMS fallback) over the scene's audio
  - caption   : Canny edge density in the lower third (broadcast burn-in captions live there)
  - dialogue  : transcript char density (chars / second)

Licenses: OpenCV BSD, librosa ISC — both permissive. OpenCV is already a core dep
(scenedetect); librosa is optional (audio signal degrades to numpy RMS without it).

Non-destructive: if VISION_PREFILTER=off, or OpenCV is unavailable, or there are fewer
frames than the Gemini budget, select_for_vision() is a no-op and every frame goes to
Gemini exactly as before.

Env:
  VISION_PREFILTER   on|off        (default on)
  VISION_GEMINI_MAX  int           (default 30 — max frames sent to Gemini)
"""
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Callable, Optional

VISION_PREFILTER = (os.environ.get("VISION_PREFILTER") or "on").lower() not in ("off", "0", "false", "none", "")
VISION_GEMINI_MAX = int(os.environ.get("VISION_GEMINI_MAX") or 30)

# Signal weights (sum ≈ 1). Faces carry the most: a payoff moment is usually a
# reacting person. Tune via the env-free constant if needed.
WEIGHTS = {"faces": 0.35, "audio": 0.25, "caption": 0.20, "dialogue": 0.20}


# ── optional-dependency guards ──────────────────────────────────────────────────

def _try_cv2():
    try:
        import cv2  # noqa
        return cv2
    except Exception:
        return None


def _try_librosa():
    try:
        import librosa  # noqa
        return librosa
    except Exception:
        return None


# ── per-signal extractors (all defensive → 0.0 on any failure) ──────────────────

def _face_count(clf, cv2, img) -> float:
    try:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        faces = clf.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(40, 40))
        return float(len(faces))
    except Exception:
        return 0.0


def _caption_likeness(cv2, img) -> float:
    """Edge density in the lower third — a proxy for burned-in caption text."""
    try:
        h = img.shape[0]
        band = img[int(h * 0.66):, :]
        gray = cv2.cvtColor(band, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(gray, 100, 200)
        return float((edges > 0).mean())
    except Exception:
        return 0.0


def _extract_wav(video_path: str) -> Optional[str]:
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        out = f.name
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-v", "quiet", "-i", video_path,
             "-vn", "-ac", "1", "-ar", "8000", "-acodec", "pcm_s16le", out],
            check=True,
        )
        return out if os.path.exists(out) else None
    except Exception:
        if os.path.exists(out):
            os.remove(out)
        return None


def _load_wav(wav_path: str):
    import wave
    import numpy as np
    with wave.open(wav_path, "rb") as w:
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
    y = np.frombuffer(raw, dtype=np.int16).astype("float32") / 32768.0
    return y, sr


def _audio_energy(y, sr, env, start: float, end: float) -> float:
    """librosa onset-strength mean over the window, or numpy RMS when librosa is absent."""
    try:
        a = int(start * sr)
        b = int(end * sr)
        if b <= a:
            b = a + 1
        if env is not None:
            hop = 512
            ha = int(a / hop)
            hb = max(ha + 1, int(b / hop))
            e = env[ha:hb]
            return float(e.mean()) if getattr(e, "size", 0) else 0.0
        seg = y[a:b]
        if getattr(seg, "size", 0) == 0:
            return 0.0
        return float((seg ** 2).mean() ** 0.5)
    except Exception:
        return 0.0


# ── scoring ─────────────────────────────────────────────────────────────────────

def score_scenes_heuristic(
    scenes: list[dict],
    video_path: str,
    out_dir: Path,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> None:
    """Annotate each frame-bearing scene with `heur_score` (0-100) + `heur` breakdown.
    Idempotent: scenes that already carry `heur_score` (a checkpoint/resume) are skipped."""
    cv2 = _try_cv2()
    targets = [s for s in scenes if s.get("frame") and s.get("heur_score") is None]
    if not targets:
        return

    raw = {id(s): {"faces": 0.0, "audio": 0.0, "caption": 0.0, "dialogue": 0.0} for s in targets}

    # Visual signals (faces, caption band) — need OpenCV.
    face_clf = None
    if cv2 is not None:
        try:
            face_clf = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        except Exception:
            face_clf = None

    for i, s in enumerate(targets):
        r = raw[id(s)]
        dur = max(0.1, float(s.get("duration") or (float(s.get("end", 0)) - float(s.get("start", 0))) or 1.0))
        r["dialogue"] = len((s.get("text") or "").strip()) / dur
        if cv2 is not None:
            img = None
            try:
                img = cv2.imread(str(out_dir / s["frame"]))
            except Exception:
                img = None
            if img is not None:
                if face_clf is not None:
                    r["faces"] = _face_count(face_clf, cv2, img)
                r["caption"] = _caption_likeness(cv2, img)
        if on_progress:
            on_progress(i + 1, len(targets))

    # Audio signal — one wav extract for the whole video, then per-scene energy.
    librosa = _try_librosa()
    wav = _extract_wav(video_path)
    if wav:
        try:
            y, sr = _load_wav(wav)
            env = None
            if librosa is not None:
                try:
                    env = librosa.onset.onset_strength(y=y, sr=sr)
                except Exception:
                    env = None
            for s in targets:
                raw[id(s)]["audio"] = _audio_energy(y, sr, env, float(s.get("start", 0)), float(s.get("end", 0)))
        except Exception:
            pass
        finally:
            try:
                os.remove(wav)
            except Exception:
                pass

    # Normalize each signal to [0,1] across the batch, then weighted sum → 0-100.
    maxes = {k: max((raw[id(s)][k] for s in targets), default=0.0) or 1.0 for k in WEIGHTS}
    for s in targets:
        r = raw[id(s)]
        score = sum(WEIGHTS[k] * (r[k] / maxes[k]) for k in WEIGHTS)
        s["heur_score"] = round(100.0 * score, 1)
        s["heur"] = {k: round(r[k], 3) for k in WEIGHTS}


def _apply_selection(scenes: list[dict], max_gemini: int) -> int:
    """Rank frame scenes by heur_score, keep the top-N for Gemini, and pre-fill the rest
    with a heuristic vision_score so vision.py's _frame_done() skips them. Returns the
    number left for Gemini. Pure (no I/O) → unit-testable without OpenCV."""
    frame_scenes = [s for s in scenes if s.get("frame")]
    ranked = sorted(frame_scenes, key=lambda s: s.get("heur_score", 0.0), reverse=True)
    top_ids = {id(s) for s in ranked[:max_gemini]}
    for s in ranked:
        if id(s) in top_ids:
            continue
        if s.get("vision_score") is None:  # never clobber a real Gemini score
            s["vision_score"] = int(round(s.get("heur_score", 0.0)))
            s["vision_reason"] = "(사전필터: 휴리스틱 하위 — Gemini 미투입)"
            s.setdefault("vision_tags", [])
            s.setdefault("on_screen_names", [])
            s.setdefault("on_screen_text", [])
            s["_prefiltered"] = True
    return len(top_ids)


def select_for_vision(
    scenes: list[dict],
    video_path: str,
    out_dir: Path,
    max_gemini: Optional[int] = None,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> Optional[int]:
    """Pre-filter the scene set so only the top-N frames reach Gemini. Returns the number
    of scenes left for Gemini, or None when no pre-filtering happened (disabled, OpenCV
    missing, or already within budget → every frame goes to Gemini, unchanged behavior)."""
    if not VISION_PREFILTER:
        return None
    if _try_cv2() is None:
        print("   (사전필터 건너뜀: opencv 없음 → 전량 Gemini)")
        return None
    budget = max_gemini or VISION_GEMINI_MAX
    frame_scenes = [s for s in scenes if s.get("frame")]
    if len(frame_scenes) <= budget:
        return None  # nothing to save — let Gemini score them all

    score_scenes_heuristic(scenes, video_path, out_dir, on_progress=on_progress)
    sent = _apply_selection(scenes, budget)
    prefiltered = len(frame_scenes) - sent
    print(f"   사전필터: Gemini {sent} 장면 투입 / 휴리스틱 {prefiltered} 스킵 (총 {len(frame_scenes)})")
    return sent
