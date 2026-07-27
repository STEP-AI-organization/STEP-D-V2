"""Phase 2: Thumbnail Generator — 계획 JSON을 받아 각 레이어 이미지 생성.

입력: ThumbnailPlan dict + media_dir(소스 프레임/캐스트사진)
출력: {layer_role: PIL.Image(RGBA), transform_meta} dict
- AI 호출 없음. 순수 Python(Pillow, rembg) 실행.
- 병렬화 가능: background / person / caption 독립 생성 → 합성은 Phase 3에서.
"""

from __future__ import annotations

import pathlib
from dataclasses import dataclass
from typing import Any, Optional

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from .canvas import ASPECT_SIZE, Document, Layer, LayerRole, LayerTransform, SAFE_MARGIN
from .contrast import ensure_min_contrast, sample_bg_color


FONT_ROOT = pathlib.Path(__file__).resolve().parents[2] / "assets" / "thumbnail-fonts"

FONT_PRESETS: dict[str, str] = {
    "variety": "NotoSansKR-Black.otf",
    "drama": "NotoSerifKR-Black.otf",
    "news": "Pretendard-ExtraBold.otf",
    "documentary": "Pretendard-Bold.otf",
    "_default": "Pretendard-Black.otf",
}

SIZE_PX: dict[str, int] = {"XL": 120, "L": 90, "M": 70}


@dataclass
class LayerResult:
    """생성된 레이어 이미지 + 변환 메타."""
    role: LayerRole
    image: Image.Image  # RGBA
    transform: LayerTransform
    blend: str = "normal"
    mask: Optional[Image.Image] = None
    meta: dict = None  # type: ignore[assignment]

    def __post_init__(self):
        if self.meta is None:
            self.meta = {}


class ThumbnailGenerator:
    """계획 → 레이어 이미지 생성."""

    def __init__(self, media_dir: pathlib.Path, plan: dict, aspect: str = "16:9"):
        self.media_dir = pathlib.Path(media_dir)
        self.plan = plan
        self.aspect = aspect
        self.size = ASPECT_SIZE[aspect]
        self.cw, self.ch = self.size
        self.safe_zone = (SAFE_MARGIN, SAFE_MARGIN, self.cw - SAFE_MARGIN, self.ch - SAFE_MARGIN)

        # 캐시
        self._frames_cache: Optional[list[dict]] = None
        self._faces_cache: Optional[dict] = None

    # ──────────────────────────────────────────────────────────────
    # Background (Layer 0)
    # ──────────────────────────────────────────────────────────────
    def generate_background(self) -> LayerResult:
        bg_plan = self.plan["background"]
        mode = bg_plan["mode"]

        if mode == "frame_blur":
            return self._bg_from_frame(bg_plan)
        elif mode == "ai_generate":
            return self._bg_ai_generate(bg_plan)
        elif mode == "gradient":
            return self._bg_gradient(bg_plan)
        elif mode == "solid":
            return self._bg_solid(bg_plan)
        else:
            raise ValueError(f"Unknown background mode: {mode}")

    def _bg_from_frame(self, plan: dict) -> LayerResult:
        frame_id = plan["frame_id"]
        blur_px = plan.get("blur_px", 24)
        frame = self._find_frame(frame_id)
        if not frame:
            raise ValueError(f"Frame not found: {frame_id}")

        img = Image.open(frame["path"]).convert("RGB")
        img = self._cover_resize(img, self.size)
        if blur_px > 0:
            img = img.filter(ImageFilter.GaussianBlur(radius=blur_px))

        tr = LayerTransform(x=0, y=0, width=self.cw, height=self.ch, opacity=1.0)
        return LayerResult(
            role="background",
            image=img.convert("RGBA"),
            transform=tr,
            meta={"source_frame": frame_id, "filter": "blur", "blur_px": blur_px},
        )

    def _bg_ai_generate(self, plan: dict) -> LayerResult:
        """Deterministic fallback for an AI-planned conceptual background.

        The planner may choose ``ai_generate``, but phase 2 must not make another
        model decision or call an image API.  Prefer a supplied palette gradient;
        otherwise use a blurred source frame so output remains reproducible from
        the plan and analysis work directory.
        """
        palette = plan.get("palette_hint") or plan.get("colors")
        context_frame_ids = plan.get("context_frame_ids", [])
        if isinstance(palette, list) and len(palette) >= 2:
            result = self._bg_gradient({"colors": palette[:2], "angle": plan.get("angle", 45)})
            result.meta["planned_mode"] = "ai_generate"
            return result
        frame_id = context_frame_ids[0] if context_frame_ids else self._get_first_face_frame()
        if frame_id:
            result = self._bg_from_frame({"frame_id": frame_id, "blur_px": 24})
            result.meta["planned_mode"] = "ai_generate"
            return result
        result = self._bg_solid({"color": "#1a1a2e"})
        result.meta["planned_mode"] = "ai_generate"
        return result

    def _bg_gradient(self, plan: dict) -> LayerResult:
        colors_in = plan.get("colors", ["#1a2b3c", "#e8d4a0"])
        # ImageColor.getrgb는 hex(#rrggbb·#rgb) 뿐 아니라 "pink","navy" 같은 CSS 이름도 이해.
        # Planner가 종종 색 이름을 뱉으므로 안전 파싱.
        from PIL import ImageColor, ImageDraw
        def _parse(c):
            try:
                return ImageColor.getrgb(c)
            except Exception:
                return None
        c0 = _parse(colors_in[0]) or (26, 43, 60)
        c1 = _parse(colors_in[1] if len(colors_in) > 1 else colors_in[0]) or (232, 212, 160)
        img = Image.new("RGB", self.size, c0)
        draw = ImageDraw.Draw(img)
        # 세로 선형 그라디언트 (angle 무시 · Phase 3에서 각도 지원)
        for y in range(self.ch):
            ratio = y / max(1, self.ch - 1)
            r = int(c0[0] * (1 - ratio) + c1[0] * ratio)
            g = int(c0[1] * (1 - ratio) + c1[1] * ratio)
            b = int(c0[2] * (1 - ratio) + c1[2] * ratio)
            draw.line([(0, y), (self.cw, y)], fill=(r, g, b))
        tr = LayerTransform(x=0, y=0, width=self.cw, height=self.ch)
        return LayerResult(role="background", image=img.convert("RGBA"), transform=tr,
                           meta={"gradient": list(colors_in), "resolved": [c0, c1]})

    def _bg_solid(self, plan: dict) -> LayerResult:
        color_in = plan.get("color", "#1a1a2e")
        from PIL import ImageColor
        try:
            rgb = ImageColor.getrgb(color_in)
        except Exception:
            rgb = (26, 26, 46)
        img = Image.new("RGB", self.size, rgb)
        tr = LayerTransform(x=0, y=0, width=self.cw, height=self.ch)
        return LayerResult(role="background", image=img.convert("RGBA"), transform=tr,
                           meta={"solid": color_in, "resolved": rgb})

    # ──────────────────────────────────────────────────────────────
    # Person (Layer 2)
    # ──────────────────────────────────────────────────────────────
    def generate_person(self) -> LayerResult:
        person_plan = self.plan["person"]
        source = person_plan["source"]
        side = person_plan["side"]
        scale = person_plan.get("scale", 0.9)

        if source == "frame":
            return self._person_from_frame(person_plan)
        elif source == "cast_photo":
            return self._person_from_cast_photo(person_plan)
        else:
            raise ValueError(f"Unknown person source: {source}")

    def _person_from_frame(self, plan: dict) -> LayerResult:
        frame_id = plan["frame_id"]
        subject = plan.get("subject", "largest_face")

        frame = self._find_frame(frame_id)
        if not frame:
            raise ValueError(f"Frame not found: {frame_id}")

        # 얼굴 bbox 결정
        face_bbox = self._resolve_face_bbox(frame, subject)
        if face_bbox is None:
            raise ValueError(f"Subject '{subject}' not resolvable in {frame_id}")

        # 원본 이미지
        src = Image.open(frame["path"]).convert("RGB")
        src_w, src_h = src.size

        # Crop 영역 계산 (§14.2)
        fx1, fy1, fx2, fy2 = face_bbox
        fw, fh = fx2 - fx1, fy2 - fy1
        crop_top = max(0, int(fy1 - fh * 0.3))
        crop_bottom = min(src_h, int(fy2 + fh * 4.0))
        crop_left = max(0, int((fx1 + fx2) / 2 - fw * 1.5))
        crop_right = min(src_w, int((fx1 + fx2) / 2 + fw * 1.5))
        cropped = src.crop((crop_left, crop_top, crop_right, crop_bottom))

        # rembg 세그멘테이션
        try:
            from rembg import new_session, remove
            session = new_session("isnet-general-use")
            seg = remove(cropped, session=session)  # RGBA
        except Exception as e:
            raise RuntimeError(f"rembg failed: {e}")

        # 리사이즈 (인물 높이 = 캔버스 높이 * scale)
        target_h = int(self.ch * scale)
        ratio = target_h / seg.height
        target_w = int(seg.width * ratio)
        seg = seg.resize((target_w, target_h), Image.LANCZOS)

        # 배치 (좌/우/중앙, 하단 정렬 + 얼굴 위치 보정)
        sx1, sy1, sx2, sy2 = self.safe_zone
        if side == "left":
            x = sx1 + 20
        elif side == "right":
            x = sx2 - target_w - 20
        else:
            x = (self.cw - target_w) // 2

        y = self.ch - target_h  # 하단 정렬

        # 얼굴이 세로 40% 근처 오도록 미세 조정
        face_center_in_crop = (fy1 + fh / 2) - crop_top
        face_center_in_seg = int(face_center_in_crop * ratio)
        ideal_face_y = int(self.ch * 0.4)
        y_adj = ideal_face_y - face_center_in_seg
        y = max(self.ch - target_h - 40, min(y_adj, 20))

        tr = LayerTransform(x=x, y=y, width=target_w, height=target_h)

        # 캔버스 상 얼굴 bbox 계산 (나중 자막 충돌 체크용)
        face_bbox_canvas = [
            x + int((fx1 - crop_left) * ratio),
            y + int((fy1 - crop_top) * ratio),
            x + int((fx2 - crop_left) * ratio),
            y + int((fy2 - crop_top) * ratio),
        ]

        return LayerResult(
            role="person",
            image=seg,
            transform=tr,
            meta={
                "source_frame": frame_id,
                "subject": subject,
                "side": side,
                "scale": scale,
                "face_bbox_canvas": face_bbox_canvas,
            },
        )

    def _person_from_cast_photo(self, plan: dict) -> LayerResult:
        cast_name = plan["cast_name"]
        side = plan["side"]
        scale = plan.get("scale", 0.95)


        cast_dir = self.media_dir / "cast_photos"
        photo = cast_dir / f"{cast_name}.jpg"
        if not photo.exists():
            cand = list(cast_dir.glob(f"{cast_name}.*")) if cast_dir.exists() else []
            if not cand:
                raise ValueError(f"Cast photo not found: {cast_name}")
            photo = cand[0]


        # Phase 2 is deterministic: use the supplied cast asset directly rather
        # than making an image-generation call after the planner has decided.
        gen_img = Image.open(photo).convert("RGB")

        # rembg (배경이 이미 투명이면 no-op)
        try:
            from rembg import new_session, remove
            session = new_session("isnet-general-use")
            seg = remove(gen_img, session=session)
        except Exception as e:
            raise RuntimeError(f"rembg failed: {e}")

        target_h = int(self.ch * scale)
        ratio = target_h / seg.height
        target_w = int(seg.width * ratio)
        seg = seg.resize((target_w, target_h), Image.LANCZOS)

        sx1, _, sx2, _ = self.safe_zone
        if side == "left":
            x = sx1 + 20
        elif side == "right":
            x = sx2 - target_w - 20
        else:
            x = (self.cw - target_w) // 2

        y = self.ch - target_h
        if y < 0:
            y = 0

        tr = LayerTransform(x=x, y=y, width=target_w, height=target_h)

        return LayerResult(
            role="person",
            image=seg,
            transform=tr,
            meta={
                "source_cast": cast_name,
                "generated": False,
                "side": side,
                "scale": scale,
                "style_prompt": plan.get("style_prompt", ""),
            },
        )

    # ──────────────────────────────────────────────────────────────
    # Caption (Layer 4)
    # ──────────────────────────────────────────────────────────────
    def generate_caption(self) -> LayerResult:
        cap_plan = self.plan["caption"]
        text = cap_plan["text"]
        position = cap_plan["position"]
        tone_tag = cap_plan["tone_tag"]
        size_hint = cap_plan.get("size_hint", "XL")
        font_role = cap_plan.get("font_role", "variety")
        text_color = cap_plan.get("text_color", "#ffffff")
        outline_color = cap_plan.get("outline_color", "#000000")

        font_file = FONT_PRESETS.get(font_role, FONT_PRESETS["_default"])
        font_path = FONT_ROOT / font_file
        if not font_path.exists():
            raise FileNotFoundError(f"Font not found: {font_path}")

        size_px = SIZE_PX.get(size_hint, SIZE_PX["XL"])
        max_w = int((self.safe_zone[2] - self.safe_zone[0]) * 0.55)

        # 자동 개행
        wrapped, size_px = self._wrap_by_width(text, str(font_path), size_px, max_w, max_lines=3)
        font = ImageFont.truetype(str(font_path), size_px)

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
        sx1, sy1, sx2, sy2 = self.safe_zone

        # 인물 반대편 배치 로직
        person_layer = self.plan.get("_person_layer_result")
        if position == "auto" and person_layer:
            px1, _, px2, _ = person_layer.transform.bbox()
            person_center = (px1 + px2) / 2
            if person_center < self.cw / 2:
                cx = int((self.cw / 2 + sx2) / 2 - txt_w / 2)
                position_used = "right"
            else:
                cx = int((sx1 + self.cw / 2) / 2 - txt_w / 2)
                position_used = "left"
        else:
            if position == "top":
                cx = (self.cw - txt_w) // 2
                cy = sy1 + 20
                position_used = "top"
            elif position == "middle":
                cx = (self.cw - txt_w) // 2
                cy = (self.ch - txt_h) // 2
                position_used = "middle"
            elif position == "bottom":
                cx = (self.cw - txt_w) // 2
                cy = sy2 - txt_h - 20
                position_used = "bottom"
            elif position in ("left", "right"):
                cx = sx1 + 20 if position == "left" else sx2 - txt_w - 20
                cy = (self.ch - txt_h) // 2
                position_used = position
            else:
                cx = (self.cw - txt_w) // 2
                cy = sy2 - txt_h - 20
                position_used = "bottom"

        # 대비 보정 — 현재 캔버스 상태 필요하므로 합성 후 샘플링하는 방식으로 변경 필요
        # 여기서는 기본값 사용, 합성 단계에서 재보정
        text_color_f = text_color
        outline_color_f = outline_color
        outline_w = 8
        adjusted = False

        # 자막 레이어 렌더링 (전체 캔버스 크기 RGBA)
        caption_layer = Image.new("RGBA", self.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(caption_layer)
        for i, ln in enumerate(lines):
            self._draw_text_with_outline(draw, (cx, cy + i * line_h), ln, font,
                                         fill=text_color_f, outline=outline_color_f, outline_w=outline_w)

        caption_bbox = (cx - outline_w, cy - outline_w,
                        cx + txt_w + outline_w, cy + txt_h + outline_w)

        tr = LayerTransform(x=0, y=0, width=self.cw, height=self.ch, opacity=1.0)
        return LayerResult(
            role="caption",
            image=caption_layer,
            transform=tr,
            meta={
                "text": text,
                "wrapped": wrapped,
                "font_role": font_role,
                "size_px": size_px,
                "position_used": position_used,
                "caption_bbox": list(caption_bbox),
                "text_color": text_color_f,
                "outline_color": outline_color_f,
                "outline_w": outline_w,
                "was_adjusted": adjusted,
                "tone_tag": tone_tag,
            },
        )

    # ──────────────────────────────────────────────────────────────
    # Helpers
    # ──────────────────────────────────────────────────────────────
    def _find_frame(self, frame_id: str) -> Optional[dict]:
        if self._frames_cache is None:
            self._load_frames_cache()
        for f in self._frames_cache:
            if f["id"] == frame_id:
                return f
        return None

    def _load_frames_cache(self) -> None:
        shot_dir = self.media_dir / "shot_frames"
        faces_path = self.media_dir / "faces.json"
        faces_data = {}
        if faces_path.exists():
            import json
            faces_data = json.loads(faces_path.read_text(encoding="utf-8"))
        face_by_frame = self._index_faces_by_frame(faces_data)

        frames = []
        if shot_dir.exists():
            for p in sorted(shot_dir.glob("shot_*.jpg")):
                try:
                    with Image.open(p) as im:
                        w, h = im.size
                except Exception:
                    continue
                faces = face_by_frame.get(p.name, [])
                largest = max(
                    (f.get("bbox", [0, 0, 0, 0]) for f in faces),
                    key=lambda b: (b[2] - b[0]) * (b[3] - b[1]),
                    default=None,
                )
                largest_area_ratio = 0.0
                if largest:
                    fw, fh = largest[2] - largest[0], largest[3] - largest[1]
                    largest_area_ratio = (fw * fh) / max(1, w * h)
                frames.append({
                    "id": p.stem,
                    "path": str(p),
                    "size": [w, h],
                    "faces": faces,
                    "largest_face_area_ratio": round(largest_area_ratio, 4),
                    "has_face": bool(faces),
                })
        frames.sort(key=lambda f: -f["largest_face_area_ratio"])
        self._frames_cache = frames

    def _get_first_face_frame(self) -> Optional[str]:
        if self._frames_cache is None:
            self._load_frames_cache()
        for f in self._frames_cache:
            if f["has_face"]:
                return f["id"]
        return self._frames_cache[0]["id"] if self._frames_cache else None

    def _resolve_face_bbox(self, frame: dict, subject: str) -> Optional[list[int]]:
        faces = frame.get("faces", [])
        if not faces:
            w, h = frame["size"]
            return [int(w * 0.3), int(h * 0.1), int(w * 0.7), int(h * 0.5)]

        if subject == "largest_face":
            return max(faces, key=lambda f: self._area(f.get("bbox", [0, 0, 0, 0])))["bbox"]
        if subject.startswith("name:"):
            want = subject[5:]
            for f in faces:
                if (f.get("name") or "") == want:
                    return f["bbox"]
            return max(faces, key=lambda f: self._area(f.get("bbox", [0, 0, 0, 0])))["bbox"]
        if subject.startswith("bbox:"):
            parts = subject[5:].split(",")
            if len(parts) == 4:
                return [int(float(x)) for x in parts]
        return None

    def _area(self, b: list[int]) -> int:
        return max(0, (b[2] - b[0])) * max(0, (b[3] - b[1]))

    def _cover_resize(self, img: Image.Image, target: tuple[int, int]) -> Image.Image:
        tw, th = target
        sw, sh = img.size
        scale = max(tw / sw, th / sh)
        nw, nh = int(sw * scale), int(sh * scale)
        resized = img.resize((nw, nh), Image.LANCZOS)
        x = (nw - tw) // 2
        y = (nh - th) // 2
        return resized.crop((x, y, x + tw, y + th))

    def _wrap_by_width(self, text: str, font_path: str, size_px: int, max_w: int, max_lines: int = 3) -> tuple[str, int]:
        words = text.replace("\n", " ").split()
        while size_px >= 40:
            font = ImageFont.truetype(font_path, size_px)
            lines = []
            cur = []
            for w in words:
                trial = " ".join(cur + [w])
                l, t, r, b = font.getbbox(trial)
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

    def _draw_text_with_outline(self, draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str,
                                 font: ImageFont.FreeTypeFont, fill: str, outline: str, outline_w: int) -> None:
        x, y = xy
        for dx in range(-outline_w, outline_w + 1):
            for dy in range(-outline_w, outline_w + 1):
                if dx == 0 and dy == 0:
                    continue
                draw.text((x + dx, y + dy), text, font=font, fill=outline)
        draw.text((x, y), text, font=font, fill=fill)

    def _index_faces_by_frame(self, faces_data: Any) -> dict[str, list[dict]]:
        idx: dict[str, list[dict]] = {}
        if isinstance(faces_data, dict):
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


def generate_all_layers(media_dir: pathlib.Path, plan: dict, aspect: str = "16:9") -> dict[LayerRole, LayerResult]:
    """편의 함수: 한 번에 모든 필수 레이어 생성."""
    generator = ThumbnailGenerator(media_dir, plan, aspect)

    results = {}
    results["background"] = generator.generate_background()
    results["person"] = generator.generate_person()
    # caption은 person 결과 참고해서 겹침 피함
    plan["_person_layer_result"] = results["person"]
    results["caption"] = generator.generate_caption()

    return results


if __name__ == "__main__":
    import sys
    import json
    if len(sys.argv) < 3:
        print("Usage: python -m core.thumbnail.generator <media_dir> <plan.json> [aspect]")
        sys.exit(1)
    media_dir = pathlib.Path(sys.argv[1])
    plan = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))
    aspect = sys.argv[3] if len(sys.argv) > 3 else "16:9"

    layers = generate_all_layers(media_dir, plan, aspect)
    for role, lr in layers.items():
        print(f"{role}: {lr.image.size} @ {lr.transform.x},{lr.transform.y} meta={list(lr.meta.keys())}")