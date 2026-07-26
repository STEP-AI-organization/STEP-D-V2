"""Photoshop-MCP 도구 구현 (§2.3, §14).

각 도구는 순수 함수 · 세션 컨텍스트(SessionContext)를 받아 실행 · JSON-safe 결과 반환.
AI(Gemini function calling)가 호출 · 시스템이 실행 · 결과는 다시 AI에게 tool_response.
"""
from __future__ import annotations

import base64
import dataclasses as dc
import io
import json
import pathlib
from typing import Any, Optional

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from .canvas import (
    ASPECT_SIZE, LAYER_ORDER, SAFE_MARGIN, Document, Layer, LayerTransform,
    bbox_iou,
)
from .contrast import ensure_min_contrast, sample_bg_color

FONT_ROOT = pathlib.Path(__file__).resolve().parents[2] / "assets" / "thumbnail-fonts"

# font_role → 파일 (§3.2, §14.3)
FONT_PRESETS: dict[str, str] = {
    "variety":     "NotoSansKR-Black.otf",
    "drama":       "NotoSerifKR-Black.otf",
    "news":        "Pretendard-ExtraBold.otf",
    "documentary": "Pretendard-Bold.otf",
    "_default":    "Pretendard-Black.otf",
}

SIZE_PX: dict[str, int] = {"XL": 120, "L": 90, "M": 70}


@dc.dataclass
class SessionContext:
    """세션 전역 상태 (도구들이 공유). ai_session 이 세팅."""
    media_dir: pathlib.Path         # workdir (shot_frames·cast_photos·program_context)
    doc: Optional[Document] = None  # create_document 후 활성 문서
    shorts_ctx: dict = dc.field(default_factory=dict)  # {title, description, cast, ...}
    # 캐시 (프레임/얼굴 여러 번 조회 안 하려고)
    _frames_cache: Optional[list[dict]] = None


# ── Discovery ──────────────────────────────────────────────────
def get_shorts_context(ctx: SessionContext) -> dict:
    return ctx.shorts_ctx or {"warning": "shorts_ctx 미세팅 (session runner 확인)"}


def list_candidate_frames(ctx: SessionContext, top_k: int = 5) -> dict:
    if ctx._frames_cache is not None:
        return {"frames": ctx._frames_cache[:top_k]}

    shot_dir = ctx.media_dir / "shot_frames"
    if not shot_dir.exists():
        return {"frames": [], "warning": f"shot_frames 없음: {shot_dir}"}

    frames: list[dict] = []
    faces_path = ctx.media_dir / "faces.json"
    faces_data = json.loads(faces_path.read_text(encoding="utf-8")) if faces_path.exists() else {}
    face_by_frame = _index_faces_by_frame(faces_data)

    for p in sorted(shot_dir.glob("shot_*.jpg")):
        try:
            with Image.open(p) as im:
                w, h = im.size
        except Exception:
            continue
        faces = face_by_frame.get(p.name, [])
        largest = max((f.get("bbox", [0, 0, 0, 0]) for f in faces),
                      key=lambda b: (b[2] - b[0]) * (b[3] - b[1]),
                      default=None)
        largest_area_ratio = 0.0
        if largest:
            fw, fh = largest[2] - largest[0], largest[3] - largest[1]
            largest_area_ratio = (fw * fh) / max(1, w * h)
        frames.append({
            "id": p.stem,               # e.g. "shot_0009"
            "path": str(p),
            "size": [w, h],
            "faces": faces,
            "largest_face_area_ratio": round(largest_area_ratio, 4),
            "has_face": bool(faces),
        })
    ctx._frames_cache = frames
    # 얼굴 큰 순으로 정렬해서 top_k
    frames_sorted = sorted(frames, key=lambda f: -f["largest_face_area_ratio"])
    return {"frames": frames_sorted[:top_k], "total": len(frames)}


def inspect_frame(ctx: SessionContext, frame_id: str) -> dict:
    fr = _find_frame(ctx, frame_id)
    if not fr:
        return {"error": f"frame {frame_id} not found"}
    with Image.open(fr["path"]) as im:
        rgb = im.convert("RGB").resize((16, 16), Image.LANCZOS)
        pixels = list(rgb.getdata())
        r = sum(p[0] for p in pixels) // len(pixels)
        g = sum(p[1] for p in pixels) // len(pixels)
        b = sum(p[2] for p in pixels) // len(pixels)
        brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0
    return {
        "id": frame_id,
        "size": fr["size"],
        "dominant_rgb": [r, g, b],
        "brightness": round(brightness, 3),
        "faces": fr["faces"],
        "has_face": fr["has_face"],
    }


# ── Document ────────────────────────────────────────────────────
def create_document(ctx: SessionContext, aspect: str = "16:9") -> dict:
    ctx.doc = Document(aspect=aspect)
    return {"aspect": aspect, "size": list(ctx.doc.size), "safe_zone": list(ctx.doc.safe_zone)}


def list_layers(ctx: SessionContext) -> dict:
    _require_doc(ctx)
    out = []
    for role in LAYER_ORDER:
        L = ctx.doc.layers[role]
        out.append({
            "role": role,
            "has_source": L.source is not None,
            "bbox": list(L.transform.bbox()) if L.source else None,
            "visible": L.visible,
        })
    return {"layers": out}


def clear_layer(ctx: SessionContext, role: str) -> dict:
    _require_doc(ctx)
    if role not in LAYER_ORDER:
        return {"error": f"invalid role: {role}"}
    ctx.doc.clear_layer(role)  # type: ignore[arg-type]
    return {"cleared": role}


# ── Layer 0 · Background (Phase 1 = blur only) ────────────────
def set_background_from_frame(ctx: SessionContext, frame_id: str,
                              filter: str = "blur", blur_px: int = 24) -> dict:
    _require_doc(ctx)
    fr = _find_frame(ctx, frame_id)
    if not fr:
        return {"error": f"frame {frame_id} not found"}
    img = Image.open(fr["path"]).convert("RGB")
    cw, ch = ctx.doc.size
    # cover fit (16:9 canvas 에 맞게 crop + resize)
    img = _cover_resize(img, (cw, ch))
    if filter == "blur":
        img = img.filter(ImageFilter.GaussianBlur(radius=blur_px))
    tr = LayerTransform(x=0, y=0, width=cw, height=ch, opacity=1.0)
    ctx.doc.set_layer("background", img.convert("RGBA"), tr,
                      meta={"source_frame": frame_id, "filter": filter, "blur_px": blur_px})
    return {"applied": True, "bbox": list(tr.bbox())}


# ── Layer 2 · Person (rembg 세그) ─────────────────────────────
def set_person_from_frame(ctx: SessionContext, frame_id: str,
                          subject: str = "largest_face",
                          side: str = "left", scale: float = 0.9) -> dict:
    _require_doc(ctx)
    fr = _find_frame(ctx, frame_id)
    if not fr:
        return {"error": f"frame {frame_id} not found"}

    # 1) 얼굴 bbox 결정
    face_bbox = _resolve_face_bbox(fr, subject)
    if face_bbox is None:
        return {"error": f"subject '{subject}' not resolvable in {frame_id}"}

    src = Image.open(fr["path"]).convert("RGB")
    src_w, src_h = src.size

    # 2) crop (§14.2)
    fx1, fy1, fx2, fy2 = face_bbox
    fw, fh = fx2 - fx1, fy2 - fy1
    crop_top    = max(0, int(fy1 - fh * 0.3))
    crop_bottom = min(src_h, int(fy2 + fh * 4.0))
    crop_left   = max(0, int((fx1 + fx2) / 2 - fw * 1.5))
    crop_right  = min(src_w, int((fx1 + fx2) / 2 + fw * 1.5))
    cropped = src.crop((crop_left, crop_top, crop_right, crop_bottom))

    # 3) rembg segmentation → alpha PNG
    try:
        from rembg import new_session, remove
        session = new_session("isnet-general-use")
        seg = remove(cropped, session=session)   # RGBA
    except Exception as e:
        return {"error": f"rembg failed: {str(e)[:200]}"}

    # 4) resize (인물 높이 = 캔버스 높이 * scale)
    cw, ch = ctx.doc.size
    target_h = int(ch * scale)
    ratio = target_h / seg.height
    target_w = int(seg.width * ratio)
    seg = seg.resize((target_w, target_h), Image.LANCZOS)

    # 5) 배치
    sx1, sy1, sx2, sy2 = ctx.doc.safe_zone
    if side == "left":
        x = sx1 + 20
    elif side == "right":
        x = sx2 - target_w - 20
    else:
        x = (cw - target_w) // 2
    y = ch - target_h  # 캔버스 하단 정렬 (인물 발은 화면 밖으로 살짝)

    # 얼굴이 세로 40% 근처 되도록 조정
    face_center_in_crop = (fy1 + fh / 2) - crop_top
    face_center_in_seg = int(face_center_in_crop * ratio)
    ideal_face_y = int(ch * 0.4)
    y_adj = ideal_face_y - face_center_in_seg
    # 인물이 캔버스 밖으로 너무 밀리지 않게 clamp
    y = max(ch - target_h - 40, min(y_adj, 20))

    tr = LayerTransform(x=x, y=y, width=target_w, height=target_h)
    face_bbox_canvas = [
        x + int((fx1 - crop_left) * ratio),
        y + int((fy1 - crop_top) * ratio),
        x + int((fx2 - crop_left) * ratio),
        y + int((fy2 - crop_top) * ratio),
    ]
    ctx.doc.set_layer("person", seg, tr, meta={
        "source_frame": frame_id, "subject": subject, "side": side, "scale": scale,
        "face_bbox_canvas": face_bbox_canvas,
    })
    return {"applied": True, "bbox": list(tr.bbox()), "face_bbox_canvas": face_bbox_canvas}


# ── Layer 4 · Caption (자동 wrap · 대비 보정) ─────────────────
def add_caption(ctx: SessionContext, text: str, position: str = "bottom",
                text_color: str = "#ffffff", outline_color: str = "#000000",
                size_hint: str = "XL", font_role: str = "variety",
                tone_tag: str = "기본") -> dict:
    _require_doc(ctx)
    cw, ch = ctx.doc.size
    sx1, sy1, sx2, sy2 = ctx.doc.safe_zone

    font_file = FONT_PRESETS.get(font_role, FONT_PRESETS["_default"])
    font_path = FONT_ROOT / font_file
    if not font_path.exists():
        return {"error": f"font not found: {font_path} · run scripts/download-fonts.ps1"}

    # 폰트 크기: XL/L/M · 3줄 넘으면 축소 재시도 (§14.3 2~3)
    size_px = SIZE_PX.get(size_hint, SIZE_PX["XL"])
    max_w = int((sx2 - sx1) * 0.55)

    wrapped, size_px = _wrap_by_width(text, str(font_path), size_px, max_w, max_lines=3)
    font = ImageFont.truetype(str(font_path), size_px)

    # 자막 전체 bbox (개행 반영 · outline 두께 포함 · line spacing 1.15)
    lines = wrapped.split("\n")
    line_h = int(size_px * 1.15)
    txt_w = 0
    for ln in lines:
        l, t, r, b = font.getbbox(ln)
        txt_w = max(txt_w, r - l)
    txt_h = line_h * len(lines)

    # 위치 결정
    outline_w_est = 8
    pad = outline_w_est + 6
    if position == "top":
        cx = (cw - txt_w) // 2
        cy = sy1 + 20
    elif position == "middle":
        cx = (cw - txt_w) // 2
        cy = (ch - txt_h) // 2
    elif position == "bottom" or position == "auto":
        cx = (cw - txt_w) // 2
        cy = sy2 - txt_h - 20
    else:
        # bracket "top-left" 등 (Phase 3+)
        cx = (cw - txt_w) // 2
        cy = sy2 - txt_h - 20

    # 인물 반대편 (side 있으면 자막을 반대편으로)
    person = ctx.doc.layers["person"]
    if person.source:
        px1, _, px2, _ = person.transform.bbox()
        person_center = (px1 + px2) / 2
        if person_center < cw / 2:  # 인물이 왼쪽 → 자막 오른쪽 반쪽
            cx = int((cw / 2 + sx2) / 2 - txt_w / 2)
        else:                        # 인물이 오른쪽 → 자막 왼쪽 반쪽
            cx = int((sx1 + cw / 2) / 2 - txt_w / 2)

    # 대비 보정 — 배경 샘플
    canvas_now = ctx.doc.composite()
    bg_rgb = sample_bg_color(canvas_now,
                             (cx - pad, cy - pad, cx + txt_w + pad, cy + txt_h + pad))
    text_color_f, outline_color_f, outline_w, adjusted = ensure_min_contrast(
        text_color, outline_color, bg_rgb, min_contrast=4.5)

    # 실 렌더 (별도 alpha 레이어)
    caption_layer = Image.new("RGBA", ctx.doc.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(caption_layer)
    for i, ln in enumerate(lines):
        _draw_text_with_outline(draw, (cx, cy + i * line_h), ln, font,
                                fill=text_color_f, outline=outline_color_f,
                                outline_w=outline_w)

    caption_bbox = (cx - outline_w, cy - outline_w,
                    cx + txt_w + outline_w, cy + txt_h + outline_w)

    tr = LayerTransform(x=0, y=0, width=cw, height=ch, opacity=1.0)
    ctx.doc.set_layer("caption", caption_layer, tr, meta={
        "text": text, "wrapped": wrapped, "font_role": font_role, "size_px": size_px,
        "position_used": position, "caption_bbox": list(caption_bbox),
        "text_color": text_color_f, "outline_color": outline_color_f,
        "outline_w": outline_w, "was_adjusted": adjusted, "tone_tag": tone_tag,
    })
    return {
        "applied": True,
        "caption_bbox": list(caption_bbox),
        "size_px_used": size_px,
        "wrap_lines": len(lines),
        "was_adjusted": adjusted,
        "used_text_color": text_color_f,
    }


# ── Coordinate helpers (§14) ───────────────────────────────────
def get_canvas_info(ctx: SessionContext) -> dict:
    _require_doc(ctx)
    return {
        "size": list(ctx.doc.size),
        "safe_zone": list(ctx.doc.safe_zone),
        "aspect": ctx.doc.aspect,
        "layers": [
            {"role": r, "bbox": (list(ctx.doc.layers[r].transform.bbox())
                                 if ctx.doc.layers[r].source else None),
             "visible": ctx.doc.layers[r].visible}
            for r in LAYER_ORDER
        ],
    }


def suggest_caption_position(ctx: SessionContext, text: str, size_hint: str = "XL",
                             prefer: str = "opposite_person") -> dict:
    _require_doc(ctx)
    cw, ch = ctx.doc.size
    sx1, sy1, sx2, sy2 = ctx.doc.safe_zone
    person = ctx.doc.layers["person"]
    if person.source and prefer == "opposite_person":
        px1, py1, px2, py2 = person.transform.bbox()
        # 인물 반대편 x + 세로 중앙
        if (px1 + px2) / 2 < cw / 2:
            x = int((cw / 2 + sx2) / 2)
            side = "right"
        else:
            x = int((sx1 + cw / 2) / 2)
            side = "left"
        return {"position": [x, ch // 2], "side": side, "reason": "opposite person"}
    # 기본: bottom 중앙
    return {"position": "bottom", "side": "center", "reason": "no person or explicit prefer"}


def check_overlap(ctx: SessionContext, a: str, b: str) -> dict:
    _require_doc(ctx)
    ba = _resolve_bbox_arg(ctx, a)
    bb = _resolve_bbox_arg(ctx, b)
    if not ba or not bb:
        return {"error": "invalid bbox arg", "a": a, "b": b}
    iou = bbox_iou(ba, bb)
    return {"iou": round(iou, 3), "a_bbox": list(ba), "b_bbox": list(bb)}


# ── Reflection / Control ───────────────────────────────────────
def render_preview(ctx: SessionContext) -> dict:
    _require_doc(ctx)
    img = ctx.doc.render_preview(max_edge=720)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    # 충돌 warning
    warnings: list[str] = []
    L = ctx.doc.layers
    if L["person"].source and L["caption"].source:
        pbb = L["person"].transform.bbox()
        cbb = tuple(L["caption"].meta.get("caption_bbox", L["caption"].transform.bbox()))
        iou = bbox_iou(pbb, cbb)
        if iou > 0.10:
            warnings.append(f"caption overlaps person (IoU={iou:.2f}) — consider undo + reposition")
        face_bb = L["person"].meta.get("face_bbox_canvas")
        if face_bb and bbox_iou(tuple(face_bb), cbb) > 0.05:
            warnings.append("caption crosses face bbox — check")
    return {
        "preview_png_b64": b64,
        "size": list(img.size),
        "layers": get_canvas_info(ctx)["layers"],
        "warnings": warnings,
    }


def undo_last(ctx: SessionContext) -> dict:
    _require_doc(ctx)
    role = ctx.doc.undo_last()
    return {"undone_role": role}


def export_thumbnail(ctx: SessionContext, out_dir: pathlib.Path,
                     variant_id: str = "v1") -> dict:
    _require_doc(ctx)
    out_dir = pathlib.Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    img = ctx.doc.composite()
    dest = out_dir / f"{variant_id}_{ctx.doc.aspect.replace(':', 'x')}.png"
    img.save(dest, format="PNG", optimize=True)
    return {"exported": True, "path": str(dest), "size": list(img.size)}


# ── 내부 헬퍼 ──────────────────────────────────────────────────
def _require_doc(ctx: SessionContext) -> None:
    if ctx.doc is None:
        raise RuntimeError("create_document 먼저 호출해야 함")


def _find_frame(ctx: SessionContext, frame_id: str) -> Optional[dict]:
    if ctx._frames_cache is None:
        list_candidate_frames(ctx, top_k=999)
    for f in ctx._frames_cache or []:
        if f["id"] == frame_id:
            return f
    return None


def _index_faces_by_frame(faces_data: Any) -> dict[str, list[dict]]:
    """faces.json 구조 다양 · 프레임 파일명 → [{bbox, name?, cluster?}] 로 인덱스."""
    idx: dict[str, list[dict]] = {}
    if isinstance(faces_data, dict):
        # 후보 1: {"clusters": [...], "detections": [...]}
        for det in faces_data.get("detections", []) or []:
            fname = det.get("frame") or det.get("file") or det.get("path", "")
            if isinstance(fname, str):
                fname = pathlib.Path(fname).name
            if not fname:
                continue
            idx.setdefault(fname, []).append({
                "bbox": det.get("bbox") or det.get("xyxy") or [0, 0, 0, 0],
                "name": det.get("name") or det.get("label"),
                "cluster": det.get("cluster") or det.get("cluster_id"),
            })
    return idx


def _resolve_face_bbox(frame_dict: dict, subject: str) -> Optional[list[int]]:
    faces = frame_dict.get("faces", [])
    if not faces:
        # 얼굴 정보 없으면 전체 프레임 중앙 상단 30% 근사 (rembg 는 어차피 전체 인물 잡음)
        w, h = frame_dict["size"]
        return [int(w * 0.3), int(h * 0.1), int(w * 0.7), int(h * 0.5)]
    if subject == "largest_face":
        return max(faces, key=lambda f: _area(f.get("bbox", [0, 0, 0, 0])))["bbox"]
    if subject.startswith("name:"):
        want = subject[5:]
        for f in faces:
            if (f.get("name") or "") == want:
                return f["bbox"]
        return max(faces, key=lambda f: _area(f.get("bbox", [0, 0, 0, 0])))["bbox"]
    if subject.startswith("bbox:"):
        parts = subject[5:].split(",")
        if len(parts) == 4:
            return [int(float(x)) for x in parts]
    return None


def _area(b: list[int]) -> int:
    return max(0, (b[2] - b[0])) * max(0, (b[3] - b[1]))


def _cover_resize(img: Image.Image, target: tuple[int, int]) -> Image.Image:
    tw, th = target
    sw, sh = img.size
    scale = max(tw / sw, th / sh)
    nw, nh = int(sw * scale), int(sh * scale)
    resized = img.resize((nw, nh), Image.LANCZOS)
    x = (nw - tw) // 2
    y = (nh - th) // 2
    return resized.crop((x, y, x + tw, y + th))


def _wrap_by_width(text: str, font_path: str, size_px: int, max_w: int,
                   max_lines: int = 3) -> tuple[str, int]:
    """어절 단위 자동 개행 · max_lines 넘으면 폰트 축소."""
    words = text.replace("\n", " ").split()
    while size_px >= 40:
        font = ImageFont.truetype(font_path, size_px)
        lines: list[str] = []
        cur: list[str] = []
        for w in words:
            trial = " ".join(cur + [w])
            l, _, r, _ = font.getbbox(trial)
            if r - l <= max_w or not cur:
                cur.append(w)
            else:
                lines.append(" ".join(cur))
                cur = [w]
        if cur:
            lines.append(" ".join(cur))
        if len(lines) <= max_lines:
            return ("\n".join(lines), size_px)
        size_px -= 20
    return ("\n".join(words), max(40, size_px))


def _draw_text_with_outline(draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str,
                            font: ImageFont.FreeTypeFont, fill: str, outline: str,
                            outline_w: int) -> None:
    x, y = xy
    # 8방향 outline
    for dx in range(-outline_w, outline_w + 1):
        for dy in range(-outline_w, outline_w + 1):
            if dx == 0 and dy == 0:
                continue
            draw.text((x + dx, y + dy), text, font=font, fill=outline)
    draw.text((x, y), text, font=font, fill=fill)


def _resolve_bbox_arg(ctx: SessionContext, arg: str) -> Optional[tuple[int, int, int, int]]:
    if arg in LAYER_ORDER:
        L = ctx.doc.layers[arg]  # type: ignore[index]
        if L.source is None:
            return None
        return L.transform.bbox()
    if arg.startswith("bbox:"):
        parts = arg[5:].split(",")
        if len(parts) == 4:
            return tuple(int(float(x)) for x in parts)  # type: ignore[return-value]
    return None
