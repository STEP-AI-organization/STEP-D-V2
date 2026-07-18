"""
STEP D Core — On-frame OCR (PaddleOCR primary, Gemini validates)

Philosophy: algorithms do the grunt work, AI makes the judgment call. PaddleOCR (Korean,
Apache-2.0) reads burned-in text off EVERY scene frame locally and cheaply — the 1st pass.
Gemini then only sees the top-N frames (via the scene pre-filter, prefilter.py) and re-reads
their text in its merged vision call, i.e. it validates/corrects OCR exactly where it also
scores. Net effect: Gemini OCR load drops to the top-N, while the ~170 pre-filtered frames
still carry real OCR text instead of nothing.

Output shape matches the Gemini pass (vision.py) so downstream is unchanged:
    scene["on_screen_names"]  : person name captions (short Hangul in the lower third)
    scene["on_screen_text"]   : all detected on-screen strings

Non-destructive: if PaddleOCR isn't installed (or OCR_PROVIDER=off), ocr_scenes() is a
no-op and OCR falls back to the Gemini-only path exactly as before. Tesseract is a possible
alternative engine, but PaddleOCR's Korean model is stronger on broadcast lower-thirds.

Env:
    OCR_PROVIDER  paddle|off   (default paddle)
"""
import os
import re
from pathlib import Path
from typing import Callable, Optional

OCR_PROVIDER = (os.environ.get("OCR_PROVIDER") or "paddle").lower()
_ENABLED = OCR_PROVIDER in ("paddle", "paddleocr", "on", "1", "true")

# A name caption is a 2–4 char Hangul name, optionally preceded by a season/rank prefix
# — the broadcast lower-third convention ("23기 영숙", "12호 철수"). The old pure-Hangul
# pattern rejected every prefixed caption, so on PaddleOCR-only frames (the ~85% majority)
# the product's headline "23기 영숙" example never populated on_screen_names. We keep the
# original token; cast.normalize_name handles the prefix downstream. Combined with a
# lower-third position test, this still separates 이름표 from program titles / meme captions.
_HANGUL_NAME = re.compile(r"^(?:\d{1,3}(?:기|호|대|년|월|회)?)?[가-힣]{2,4}$")

_reader = None
_reader_tried = False


def _available() -> bool:
    try:
        import paddleocr  # noqa: F401
        return True
    except Exception:
        return False


def enabled() -> bool:
    """True only when OCR_PROVIDER selects paddle AND the library imports."""
    return _ENABLED and _available()


def _get_reader():
    """Lazy PaddleOCR singleton (model load is expensive). None if init fails."""
    global _reader, _reader_tried
    if _reader_tried:
        return _reader
    _reader_tried = True
    try:
        from paddleocr import PaddleOCR
        _reader = PaddleOCR(lang="korean", use_angle_cls=False, show_log=False)
    except Exception as e:
        print(f"   (PaddleOCR 초기화 실패 → OCR 스킵: {str(e)[:80]})")
        _reader = None
    return _reader


def _img_height(path) -> Optional[float]:
    try:
        import cv2
        im = cv2.imread(str(path))
        if im is not None:
            return float(im.shape[0])
    except Exception:
        pass
    return None


def _parse(result, height: Optional[float]) -> tuple[list[str], list[str]]:
    """PaddleOCR raw result → (names, text). names = short Hangul in the lower third."""
    names: list[str] = []
    text: list[str] = []
    dets = result[0] if (result and isinstance(result, list)) else []
    if not dets:
        return names, text
    if not height:  # infer frame height from box coordinates when cv2 wasn't available
        ys = [pt[1] for d in dets if d and d[0] for pt in d[0]]
        height = (max(ys) * 1.1) if ys else 1.0
    for d in dets:
        try:
            box, (t, _conf) = d[0], d[1]
            t = (t or "").strip()
            if not t:
                continue
            if t not in text:
                text.append(t)
            cy = sum(pt[1] for pt in box) / len(box)
            if (cy / height) > 0.6 and _HANGUL_NAME.match(t.replace(" ", "")) and t not in names:
                names.append(t)
        except Exception:
            continue
    return names, text


def extract(frame_path) -> Optional[dict]:
    """OCR one frame → {names, text}. None if the reader is unavailable."""
    reader = _get_reader()
    if reader is None:
        return None
    try:
        result = reader.ocr(str(frame_path), cls=False)
    except TypeError:
        result = reader.ocr(str(frame_path))  # signature varies across PaddleOCR versions
    except Exception as e:
        return {"names": [], "text": [], "error": str(e)[:80]}
    names, text = _parse(result, _img_height(frame_path))
    return {"names": names, "text": text}


def ocr_scenes(
    scenes: list[dict],
    base_dir: Path,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> list[dict]:
    """Fill on_screen_names / on_screen_text for every frame scene (PaddleOCR baseline).
    Resume-aware via `_ocr_done`. No-op when OCR is disabled/unavailable (Gemini-only OCR)."""
    if not enabled() or _get_reader() is None:
        return scenes
    targets = [s for s in scenes if s.get("frame") and not s.get("_ocr_done")]
    total = len(targets)
    for i, s in enumerate(targets):
        try:
            r = extract(base_dir / s["frame"])
            if r is not None:
                s["on_screen_names"] = r.get("names", [])
                s["on_screen_text"] = r.get("text", [])
                s["_ocr_done"] = True
        except Exception as e:
            s["_ocr_error"] = str(e)[:80]
        if on_progress:
            on_progress(i + 1, total)
    return scenes
