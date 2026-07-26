"""Layer Canvas · Photoshop 스타일 문서 (docs/plans/thumbnail-engine-plan.md §2.1, §14).

Document = 고정 6-레이어 스택 (background · backfx · person · personfx · caption · frontfx).
각 Layer 는 source(PIL.Image) + transform(bbox, opacity) + blend + mask 를 가진다.
Composite = Pillow 로 순차 alpha_composite.

시스템 몫: 좌표 계산·개행·충돌 감지·최종 렌더 (§14).
"""
from __future__ import annotations

import dataclasses as dc
from typing import Literal, Optional
from PIL import Image, ImageDraw, ImageFilter

LayerRole = Literal["background", "backfx", "person", "personfx", "caption", "frontfx"]
LAYER_ORDER: tuple[LayerRole, ...] = (
    "background", "backfx", "person", "personfx", "caption", "frontfx"
)
BlendMode = Literal["normal", "multiply", "screen", "overlay"]

# 캔버스 프리셋 (§14.1)
ASPECT_SIZE: dict[str, tuple[int, int]] = {
    "16:9": (1280, 720),
    "9:16": (1080, 1920),
    "1:1":  (1080, 1080),
}
SAFE_MARGIN = 60  # 화면 가장자리 60px 안쪽이 safe zone


@dc.dataclass
class LayerTransform:
    """레이어의 캔버스 상 위치·크기."""
    x: int = 0
    y: int = 0
    width: int = 0    # source의 렌더 폭 (0 = 원본 폭)
    height: int = 0   # 0 = 원본 높이
    opacity: float = 1.0

    def bbox(self) -> tuple[int, int, int, int]:
        return (self.x, self.y, self.x + self.width, self.y + self.height)


@dc.dataclass
class Layer:
    role: LayerRole
    source: Optional[Image.Image] = None   # RGBA 권장 (alpha 포함)
    transform: LayerTransform = dc.field(default_factory=LayerTransform)
    blend: BlendMode = "normal"
    mask: Optional[Image.Image] = None     # 별도 alpha 마스크 (선택)
    visible: bool = True
    # 디버그·자기수정용 메타
    meta: dict = dc.field(default_factory=dict)

    def clear(self) -> None:
        self.source = None
        self.mask = None
        self.transform = LayerTransform()
        self.meta = {}


class Document:
    """캔버스 · 6-레이어 스택 · Pillow 합성."""

    def __init__(self, aspect: str = "16:9"):
        if aspect not in ASPECT_SIZE:
            raise ValueError(f"aspect must be one of {list(ASPECT_SIZE)}")
        self.aspect = aspect
        self.size: tuple[int, int] = ASPECT_SIZE[aspect]
        self.layers: dict[LayerRole, Layer] = {role: Layer(role=role) for role in LAYER_ORDER}
        # undo 스택: 각 항목 = (role, prev_layer_snapshot)
        self._undo_stack: list[tuple[LayerRole, Layer]] = []

    # ── 안전 영역 ──────────────────────────────────────────────
    @property
    def safe_zone(self) -> tuple[int, int, int, int]:
        w, h = self.size
        return (SAFE_MARGIN, SAFE_MARGIN, w - SAFE_MARGIN, h - SAFE_MARGIN)

    def in_safe(self, bbox: tuple[int, int, int, int]) -> bool:
        sx1, sy1, sx2, sy2 = self.safe_zone
        x1, y1, x2, y2 = bbox
        return sx1 <= x1 and sy1 <= y1 and x2 <= sx2 and y2 <= sy2

    # ── 레이어 조작 (undo 스냅샷 취함) ────────────────────────
    def set_layer(self, role: LayerRole, source: Image.Image,
                  transform: LayerTransform, blend: BlendMode = "normal",
                  mask: Optional[Image.Image] = None, meta: Optional[dict] = None) -> None:
        self._snapshot(role)
        L = self.layers[role]
        L.source = source.convert("RGBA") if source.mode != "RGBA" else source
        L.transform = transform
        L.blend = blend
        L.mask = mask
        L.visible = True
        L.meta = meta or {}

    def clear_layer(self, role: LayerRole) -> None:
        self._snapshot(role)
        self.layers[role].clear()

    def set_visible(self, role: LayerRole, visible: bool) -> None:
        self._snapshot(role)
        self.layers[role].visible = visible

    def _snapshot(self, role: LayerRole) -> None:
        prev = self.layers[role]
        # shallow copy (source 는 PIL.Image · 재사용해도 안전 · 새로 set 시 대체됨)
        snap = Layer(role=prev.role, source=prev.source, transform=dc.replace(prev.transform),
                     blend=prev.blend, mask=prev.mask, visible=prev.visible, meta=dict(prev.meta))
        self._undo_stack.append((role, snap))
        # undo 스택 무한 증가 방지 (최근 30개만)
        if len(self._undo_stack) > 30:
            self._undo_stack = self._undo_stack[-30:]

    def undo_last(self) -> Optional[LayerRole]:
        if not self._undo_stack:
            return None
        role, snap = self._undo_stack.pop()
        self.layers[role] = snap
        return role

    # ── 상태 조회 (도구 응답용) ────────────────────────────────
    def layer_bboxes(self) -> dict[str, tuple[int, int, int, int] | None]:
        out: dict[str, tuple[int, int, int, int] | None] = {}
        for role in LAYER_ORDER:
            L = self.layers[role]
            if L.source is None or not L.visible:
                out[role] = None
            else:
                out[role] = L.transform.bbox()
        return out

    # ── Composite ──────────────────────────────────────────────
    def composite(self) -> Image.Image:
        """모든 레이어를 순차 alpha_composite. 결과는 RGB (alpha 평탄화)."""
        w, h = self.size
        canvas = Image.new("RGBA", self.size, (0, 0, 0, 255))  # 검은 바탕
        for role in LAYER_ORDER:
            L = self.layers[role]
            if L.source is None or not L.visible:
                continue
            img = L.source
            # transform: resize
            tw = L.transform.width or img.width
            th = L.transform.height or img.height
            if (tw, th) != (img.width, img.height):
                img = img.resize((max(1, tw), max(1, th)), Image.LANCZOS)
            # opacity
            if L.transform.opacity < 0.999:
                a = img.split()[-1]
                a = a.point(lambda v, o=L.transform.opacity: int(v * o))
                img = img.copy()
                img.putalpha(a)
            # place: create full-canvas layer with img at (x, y)
            place = Image.new("RGBA", self.size, (0, 0, 0, 0))
            place.paste(img, (L.transform.x, L.transform.y), img if img.mode == "RGBA" else None)
            # blend
            if L.blend == "normal":
                canvas = Image.alpha_composite(canvas, place)
            elif L.blend in ("multiply", "screen", "overlay"):
                canvas = _blend_mode(canvas, place, L.blend)
            else:
                canvas = Image.alpha_composite(canvas, place)
        return canvas.convert("RGB")

    def render_preview(self, max_edge: int = 720) -> Image.Image:
        """AI 재판단용 축소 미리보기 (토큰 절약)."""
        img = self.composite()
        if max(img.size) > max_edge:
            ratio = max_edge / max(img.size)
            img = img.resize((int(img.width * ratio), int(img.height * ratio)), Image.LANCZOS)
        return img


def _blend_mode(base: Image.Image, top: Image.Image, mode: BlendMode) -> Image.Image:
    """multiply/screen/overlay 간단 구현. base/top 은 같은 크기 RGBA."""
    from PIL import ImageChops
    base_rgb = base.convert("RGB")
    top_rgb = top.convert("RGB")
    top_a = top.split()[-1]
    if mode == "multiply":
        blended = ImageChops.multiply(base_rgb, top_rgb)
    elif mode == "screen":
        blended = ImageChops.screen(base_rgb, top_rgb)
    else:  # overlay
        blended = ImageChops.overlay(base_rgb, top_rgb)
    blended_rgba = blended.convert("RGBA")
    blended_rgba.putalpha(top_a)
    return Image.alpha_composite(base, blended_rgba)


# ── 유틸: bbox 계산 ────────────────────────────────────────────
def bbox_iou(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
    inter = iw * ih
    area_a = max(0, ax2 - ax1) * max(0, ay2 - ay1)
    area_b = max(0, bx2 - bx1) * max(0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0
