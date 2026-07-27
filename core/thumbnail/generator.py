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
from .presets import get_preset


FONT_ROOT = pathlib.Path(__file__).resolve().parents[2] / "assets" / "thumbnail-fonts"

FONT_PRESETS: dict[str, str] = {
    # 예능 · 리얼리티 · 임팩트 (검은고딕 · 통통 · 붓)
    "variety":     "BlackHanSans-Regular.ttf",  # 검은고딕 · 예능 표준
    "impact":      "BlackHanSans-Regular.ttf",  # alias
    "reaction":    "BlackHanSans-Regular.ttf",  # 렉카·리액션
    "cute":        "DoHyeon-Regular.ttf",       # 통통 · 유쾌
    "handwrite":   "Jua-Regular.ttf",           # 손글씨 · 캐주얼
    "brush":       "Gugi-Regular.ttf",          # 붓글씨 · 예능 스페셜

    # 드라마 · 감성 (명조 · 잔잔)
    "drama":       "GowunBatang-Bold.ttf",      # 감성 명조 (Gowun)
    "magazine":    "GowunBatang-Bold.ttf",      # 매체 리뷰

    # 뉴스 · 정보성 (고딕 · 정갈)
    "news":        "Pretendard-ExtraBold.otf",
    "documentary": "GothicA1-Black.ttf",        # 다큐 · 무게감

    # 음악 · 무대 (밝은 통통)
    "music_show":  "DoHyeon-Regular.ttf",

    # 기본
    "_default":    "Pretendard-Black.otf",
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
        # 프리셋 룩업 · plan 필드가 비어있으면 프리셋 default로 채움
        self.preset = get_preset(plan.get("preset_id"))
        self._apply_preset_defaults()

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
        elif mode == "frame_original":
            # 원본 프레임 그대로 (blur 없이 cover-fit)
            return self._bg_from_frame({**bg_plan, "blur_px": 0})
        elif mode == "ai_generate":
            # 사용자 결정 2026-07-27: AI 배경 폐기 · frame_blur 로 강제 전환
            return self._bg_from_frame({**bg_plan, "blur_px": bg_plan.get("blur_px", 24)})
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
        """Planner가 ai_generate 요청 시 실제 Gemini 2.5 flash image 호출 (§13 default).
        시스템이 자동으로 프레임 2장(있으면) + 시놉시스 첨부 · 인물 사진은 첨부 X.
        실패 시 그라디언트 → 프레임 blur → 단색 순 폴백.
        """
        from . import image_gen

        prompt = plan.get("prompt", "쇼츠 썸네일 배경 · 사람 없이 톤만")
        style = plan.get("style", "cinematic")
        palette = plan.get("palette_hint")
        context_frame_ids = plan.get("context_frame_ids") or []

        # 컨텍스트 프레임 자동 선택 (있는 프레임 앞 2개)
        if not context_frame_ids:
            first = self._get_first_face_frame()
            if first:
                context_frame_ids = [first]
        frames_bytes: list[bytes] = []
        for fid in context_frame_ids[:2]:
            fr = self._find_frame(fid)
            if fr:
                frames_bytes.append(pathlib.Path(fr["path"]).read_bytes())

        # 프로그램 정보 (planner가 넘긴 shorts_context 있으면 활용 · 없으면 workdir 로드)
        prog_info = ""
        synopsis = ""
        pc = self.media_dir / "program_context.json"
        if pc.exists():
            try:
                import json as _json
                data = _json.loads(pc.read_text(encoding="utf-8"))
                prog_info = f"{data.get('title','')} ({data.get('section','')})".strip(" ()")
                synopsis = (data.get("synopsis") or "")[:300]
            except Exception:
                pass

        try:
            img_bytes = image_gen.generate_background(
                prompt=prompt, style=style, palette_hint=palette,
                context_frames=frames_bytes, synopsis=synopsis, program_info=prog_info,
            )
        except Exception as e:
            img_bytes = None
            gen_error = str(e)[:200]
        else:
            gen_error = None

        if img_bytes:
            from PIL import Image as _Im
            import io as _io
            bg = _Im.open(_io.BytesIO(img_bytes)).convert("RGB")
            # cover fit
            tw, th = self.size
            sw, sh = bg.size
            scale_r = max(tw / sw, th / sh)
            nw, nh = int(sw * scale_r), int(sh * scale_r)
            bg = bg.resize((nw, nh), _Im.LANCZOS)
            x = (nw - tw) // 2; y = (nh - th) // 2
            bg = bg.crop((x, y, x + tw, y + th))
            tr = LayerTransform(x=0, y=0, width=tw, height=th)
            return LayerResult(
                role="background", image=bg.convert("RGBA"), transform=tr,
                meta={"planned_mode": "ai_generate", "generated": True,
                      "prompt": prompt, "style": style,
                      "used_frames": context_frame_ids},
            )

        # 폴백 체인: gradient → frame blur → solid
        if isinstance(palette, list) and len(palette) >= 2:
            result = self._bg_gradient({"colors": palette[:2], "angle": plan.get("angle", 45)})
        elif context_frame_ids:
            result = self._bg_from_frame({"frame_id": context_frame_ids[0], "blur_px": 24})
        else:
            result = self._bg_solid({"color": "#1a1a2e"})
        result.meta["planned_mode"] = "ai_generate"
        result.meta["ai_gen_error"] = gen_error or "no_image_returned"
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
    def _apply_preset_defaults(self) -> None:
        """Plan에 지정 안 된 필드를 프리셋 default로 채운다 (있는 값은 덮어쓰지 않음).
        persons 배열이 있으면 person 단일 필드는 건드리지 않음."""
        p = self.preset
        if not (isinstance(self.plan.get("persons"), list) and len(self.plan["persons"]) >= 1):
            pers = self.plan.setdefault("person", {})
            pers.setdefault("side", p["person_side_default"])
            pers.setdefault("scale", p["person_scale_default"])
        cap = self.plan.setdefault("caption", {})
        cap.setdefault("position", p["caption_position_default"])
        cap.setdefault("size_hint", p["caption_size_default"])
        cap.setdefault("font_role", p["font_role"])
        cap.setdefault("text_color", p["text_color"])
        cap.setdefault("outline_color", p["outline_color"])
        bg = self.plan.setdefault("background", {"mode": "ai_generate"})
        if bg.get("mode") == "ai_generate":
            bg.setdefault("style", p["background_style_default"])
            # 프리셋 힌트를 프롬프트에 접두
            hint = p["background_prompt_hint"]
            existing = bg.get("prompt", "")
            if hint and hint not in existing:
                bg["prompt"] = f"{hint} · {existing}" if existing else hint

    def generate_person(self) -> LayerResult:
        # persons 배열 우선 (여러 인물 합성 · 한블리·연애전쟁 스타일)
        persons = self.plan.get("persons")
        if isinstance(persons, list) and len(persons) >= 2:
            return self._persons_composite(persons)

        person_plan = self.plan["person"]
        source = person_plan["source"]

        if source == "frame":
            return self._person_from_frame(person_plan)
        elif source == "cast_photo":
            return self._person_from_cast_photo(person_plan)
        else:
            raise ValueError(f"Unknown person source: {source}")

    def _persons_composite(self, persons: list[dict]) -> LayerResult:
        """여러 인물 alpha 를 하나의 캔버스 크기 person layer 로 합성.
        각 인물은 side/scale/z_index 기준 배치. 얼굴 identity 유지 (castPhoto 우선).
        """
        # side 문자열 → 상대 x 위치 (0.0=왼쪽 · 1.0=오른쪽)
        SIDE_X: dict[str, float] = {
            "left": 0.12, "left-mid": 0.30, "center": 0.50,
            "right-mid": 0.70, "right": 0.88,
        }
        canvas = Image.new("RGBA", self.size, (0, 0, 0, 0))
        placed: list[dict] = []
        # z_index 오름차순 (작은 것 먼저 · 큰 것 뒤에 = 앞쪽)
        for i, p in enumerate(persons):
            p.setdefault("z_index", i)
        for p in sorted(persons, key=lambda x: x.get("z_index", 0)):
            try:
                sub = self._one_person_layer(p)  # LayerResult · alpha 이미지 + transform
            except Exception as e:
                # 하나 실패는 skip · 다른 인물은 살림
                placed.append({"skipped": True, "reason": str(e)[:200]})
                continue

            side = p.get("side", "center")
            sx = SIDE_X.get(side, 0.5)
            person_img = sub.image
            pw, ph = person_img.size
            x = int(self.cw * sx - pw / 2)
            # 세로: 얼굴 40% 위치 (frame/cast 규칙 재활용)
            face_bb = sub.meta.get("face_bbox_canvas")
            if face_bb:
                # sub.transform 안에 이미 얼굴 y가 세로 40% 되도록 조정됨 · 그대로 사용
                y = sub.transform.y
            else:
                y = self.ch - ph
            # 캔버스 밖으로 나가지 않게 clamp
            x = max(-int(pw * 0.15), min(x, self.cw - int(pw * 0.85)))
            y = max(0, min(y, self.ch - int(ph * 0.85)))

            canvas.alpha_composite(person_img, (x, y))
            placed.append({
                "source": p.get("source"),
                "id": p.get("cast_name") or p.get("frame_id"),
                "side": side, "scale": p.get("scale"),
                "bbox_on_canvas": [x, y, x + pw, y + ph],
            })

        tr = LayerTransform(x=0, y=0, width=self.cw, height=self.ch)
        return LayerResult(
            role="person", image=canvas, transform=tr,
            meta={"multi_persons": True, "count": len(persons), "placed": placed},
        )

    def _one_person_layer(self, plan: dict) -> LayerResult:
        """persons 배열 안 하나의 인물 → 원본 rembg (alpha 이미지). scale은 캔버스 대비 상대."""
        src_plan = dict(plan)
        source = src_plan.get("source", "frame")
        if source == "cast_photo":
            return self._person_from_cast_photo(src_plan)
        return self._person_from_frame(src_plan)

    def _person_from_frame(self, plan: dict) -> LayerResult:
        frame_id = plan["frame_id"]
        subject = plan.get("subject", "largest_face")
        side = plan.get("side", "left")
        scale = plan.get("scale", 0.9)

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
        # 여러 인물 프레임에서 옆 인물 배제하려고 crop 여유 좁게 (얼굴 중심 · 상반신)
        crop_top = max(0, int(fy1 - fh * 0.3))
        crop_bottom = min(src_h, int(fy2 + fh * 2.5))
        crop_left = max(0, int((fx1 + fx2) / 2 - fw * 1.0))
        crop_right = min(src_w, int((fx1 + fx2) / 2 + fw * 1.0))
        cropped = src.crop((crop_left, crop_top, crop_right, crop_bottom))

        # 인물 세그 (birefnet-portrait 우선 · 얼굴 alpha 강제 · edge feather)
        face_in_crop = (int(fx1 - crop_left), int(fy1 - crop_top),
                        int(fx2 - crop_left), int(fy2 - crop_top))
        seg = _segment_person(cropped, face_bbox_in_img=face_in_crop)

        # 리사이즈 (인물 높이 = 캔버스 높이 * scale)
        target_h = int(self.ch * scale)
        ratio = target_h / seg.height
        target_w = int(seg.width * ratio)
        seg = seg.resize((target_w, target_h), Image.LANCZOS)

        # 배치 (aspect 별 · 9:16은 중앙+얼굴 33% · 16:9은 side+얼굴 40%)
        is_vertical = self.aspect == "9:16"
        sx1, sy1, sx2, sy2 = self.safe_zone
        if is_vertical:
            x = (self.cw - target_w) // 2
            ideal_face_ratio = 0.33
        else:
            if side == "left":
                x = sx1 + 20
            elif side == "right":
                x = sx2 - target_w - 20
            else:
                x = (self.cw - target_w) // 2
            ideal_face_ratio = 0.4

        face_center_in_crop = (fy1 + fh / 2) - crop_top
        face_center_in_seg = int(face_center_in_crop * ratio)
        ideal_face_y = int(self.ch * ideal_face_ratio)
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
            if cand:
                photo = cand[0]
            else:
                # narrative 대사 화자 ↔ 등록 castPhoto 이름 매핑 어긋남 흔함.
                # 폴백: frame source 로 자동 전환 (얼굴 큰 shot 하나 골라 원본 rembg).
                first_face_frame = self._get_first_face_frame()
                if first_face_frame:
                    return self._person_from_frame({
                        "frame_id": first_face_frame,
                        "subject": "largest_face",
                        "side": side, "scale": scale,
                    })
                raise ValueError(f"Cast photo not found: {cast_name} · no face frame either")

        # castPhoto 원본 그대로 사용 (얼굴 100퍼센트 유지). AI 재생성은 얼굴이 바뀌는 문제로 폐기.
        # 스타일 조정은 다음 개선(Phase 3+)에서 face-swap 없이 rembg + 후처리로.
        used_ai_gen = False
        style_prompt = plan.get("style_prompt", "")
        src = Image.open(photo).convert("RGB")
        src_w, src_h = src.size

        # (§14.2) 얼굴 bbox 검출 · 못 찾으면 이미지 상단 중앙 30~70% 근사
        face_bbox = _detect_face_bbox(src)
        if face_bbox is None:
            # 폴백: 상단 중앙 (portrait 사진 일반적 얼굴 위치)
            face_bbox = (int(src_w * 0.25), int(src_h * 0.08),
                         int(src_w * 0.75), int(src_h * 0.45))

        # crop 규칙 · 얼굴 위 30% 여유 · 얼굴 아래 4배 (상반신) · 좌우 1.5배
        fx1, fy1, fx2, fy2 = face_bbox
        fw, fh = fx2 - fx1, fy2 - fy1
        crop_top    = max(0, int(fy1 - fh * 0.3))
        crop_bottom = min(src_h, int(fy2 + fh * 4.0))
        crop_left   = max(0, int((fx1 + fx2) / 2 - fw * 1.5))
        crop_right  = min(src_w, int((fx1 + fx2) / 2 + fw * 1.5))
        cropped = src.crop((crop_left, crop_top, crop_right, crop_bottom))

        # 인물 세그 (birefnet-portrait 우선 · 얼굴 alpha 강제 · edge feather)
        face_in_crop = (int(fx1 - crop_left), int(fy1 - crop_top),
                        int(fx2 - crop_left), int(fy2 - crop_top))
        seg = _segment_person(cropped, face_bbox_in_img=face_in_crop)

        # 리사이즈
        target_h = int(self.ch * scale)
        ratio = target_h / seg.height
        target_w = int(seg.width * ratio)
        seg = seg.resize((target_w, target_h), Image.LANCZOS)

        # 배치 · 9:16은 인물 중앙 강제 · 얼굴 세로 위치도 aspect 별 다르게
        is_vertical = self.aspect == "9:16"
        sx1, _, sx2, _ = self.safe_zone
        if is_vertical:
            # 세로: 인물 중앙 고정 · 얼굴은 세로 33% (자막 하단 큰 자리 확보)
            x = (self.cw - target_w) // 2
            ideal_face_ratio = 0.33
        else:
            if side == "left":
                x = sx1 + 20
            elif side == "right":
                x = sx2 - target_w - 20
            else:
                x = (self.cw - target_w) // 2
            ideal_face_ratio = 0.4

        face_center_in_crop = (fy1 + fh / 2) - crop_top
        face_center_in_seg = int(face_center_in_crop * ratio)
        ideal_face_y = int(self.ch * ideal_face_ratio)
        y_adj = ideal_face_y - face_center_in_seg
        y = max(self.ch - target_h - 40, min(y_adj, 20))

        tr = LayerTransform(x=x, y=y, width=target_w, height=target_h)
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
                "source_cast": cast_name,
                "generated": used_ai_gen,
                "side": side if not is_vertical else "center",
                "scale": scale,
                "style_prompt": style_prompt,
                "face_bbox_used": list(face_bbox),
                "face_bbox_canvas": face_bbox_canvas,
                "aspect": self.aspect,
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

        # 인물 반대편 배치 로직 (aspect 반영)
        is_vertical = self.aspect == "9:16"
        person_layer = self.plan.get("_person_layer_result")
        if position == "auto" and is_vertical:
            # 세로: 자막은 하단 큰 자리 (인물 중앙 아래)
            cx = (self.cw - txt_w) // 2
            cy = sy2 - txt_h - 40
            position_used = "bottom(auto·9:16)"
        elif position == "auto" and person_layer:
            px1, _, px2, _ = person_layer.transform.bbox()
            person_center = (px1 + px2) / 2
            if person_center < self.cw / 2:
                cx = int((self.cw / 2 + sx2) / 2 - txt_w / 2)
                position_used = "right(opposite-person)"
            else:
                cx = int((sx1 + self.cw / 2) / 2 - txt_w / 2)
                position_used = "left(opposite-person)"
            cy = (self.ch - txt_h) // 2
        elif position == "top":
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
            position_used = "bottom(fallback)"

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


# ──────────────────────────────────────────────────────────────
# 인물 세그 유틸 (birefnet-portrait 우선 · 얼굴 alpha 강제 · edge feather)
# ──────────────────────────────────────────────────────────────
_REMBG_SESSIONS: dict[str, object] = {}

def _get_rembg(model: str):
    """rembg 세션 캐시 · 최초 1회만 load."""
    if model not in _REMBG_SESSIONS:
        from rembg import new_session
        _REMBG_SESSIONS[model] = new_session(model)
    return _REMBG_SESSIONS[model]


def _radial_feather_fallback(img: "Image.Image",
                             face_bbox: Optional[tuple[int, int, int, int]]) -> "Image.Image":
    """세그 완전 실패시 · 얼굴 중심 radial gradient (타원)로 부드럽게 fade.
    사각형 배경 튀는 것 방지."""
    from PIL import Image as _Im, ImageDraw as _D
    W, H = img.size
    # 얼굴 중심 · 반경
    if face_bbox:
        cx = (face_bbox[0] + face_bbox[2]) / 2
        cy = (face_bbox[1] + face_bbox[3]) / 2
        fw = face_bbox[2] - face_bbox[0]
        fh = face_bbox[3] - face_bbox[1]
        # 얼굴 크기의 2.5배 반경 (상반신 커버)
        rx = int(max(fw, fh) * 2.5)
        ry = int(max(fw, fh) * 3.0)
    else:
        cx, cy = W / 2, H * 0.4
        rx, ry = int(W * 0.4), int(H * 0.5)

    # 큰 마스크 캔버스에 타원 그림 · Gaussian blur 로 부드럽게
    mask = _Im.new("L", (W, H), 0)
    d = _D.Draw(mask)
    d.ellipse((int(cx - rx), int(cy - ry), int(cx + rx), int(cy + ry)), fill=255)
    from PIL import ImageFilter as _F
    mask = mask.filter(_F.GaussianBlur(radius=max(20, min(W, H) // 20)))
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def _segment_person(img: "Image.Image",
                    face_bbox_in_img: Optional[tuple[int, int, int, int]] = None,
                    ) -> "Image.Image":
    """인물 세그 · 여러 모델 폴백 · 얼굴 영역 alpha 강제 · edge feather.

    반환: RGBA (alpha 채널 정제됨). 실패해도 원본 RGBA로 폴백 (얼굴 살림).
    """
    from rembg import remove
    from PIL import Image as _Im, ImageFilter as _F
    import numpy as _np

    # 1) 세그 시도 (birefnet-portrait → u2net_human_seg → isnet-general-use 폴백)
    seg = None
    best_avg = 0.0
    for model in ("birefnet-portrait", "u2net_human_seg", "isnet-general-use"):
        try:
            session = _get_rembg(model)
            r = remove(img, session=session)
            if r and r.mode == "RGBA":
                a = _np.array(r.split()[-1], dtype=_np.uint8)
                avg = float(a.mean()) / 255.0
                # 0.15~0.85 사이 · 유효한 세그 (너무 낮으면 인물 못잡음 · 너무 높으면 배경도 다 남음)
                if 0.15 <= avg <= 0.85:
                    seg = r; best_avg = avg
                    break
                if avg > best_avg:
                    best_avg = avg
        except Exception:
            continue

    # 유효한 세그 실패 (alpha 극단) · radial feather fallback (얼굴 중심 부드럽게)
    if seg is None:
        return _radial_feather_fallback(img, face_bbox_in_img)

    # 2) 얼굴 bbox 있으면 얼굴 영역 alpha=255 강제 (rembg가 얼굴 부분 놓치는 경우 방지)
    if face_bbox_in_img:
        fx1, fy1, fx2, fy2 = face_bbox_in_img
        # 얼굴 위 20퍼센트 여유 · 이마 살림
        fh = fy2 - fy1
        fy1 = max(0, int(fy1 - fh * 0.2))
        alpha = _np.array(seg.split()[-1], dtype=_np.uint8)
        # 얼굴 영역 alpha 값 낮으면 255로 강제
        H, W = alpha.shape
        x1 = max(0, min(int(fx1), W - 1))
        y1 = max(0, min(int(fy1), H - 1))
        x2 = max(0, min(int(fx2), W))
        y2 = max(0, min(int(fy2), H))
        if x2 > x1 and y2 > y1:
            face_region = alpha[y1:y2, x1:x2]
            face_region[face_region < 200] = 255
            alpha[y1:y2, x1:x2] = face_region
            rgb = seg.convert("RGB")
            seg = _Im.merge("RGBA", (*rgb.split(), _Im.fromarray(alpha)))

    # 3) Edge feather (alpha 채널에 살짝 blur → 뾰족한 경계 완화)
    try:
        alpha = seg.split()[-1]
        alpha_smooth = alpha.filter(_F.GaussianBlur(radius=1.5))
        rgb = seg.convert("RGB")
        seg = _Im.merge("RGBA", (*rgb.split(), alpha_smooth))
    except Exception:
        pass

    return seg


# ──────────────────────────────────────────────────────────────
# 얼굴 검출 유틸 (castPhoto 얼굴 앵커 crop 용 · insightface)
# ──────────────────────────────────────────────────────────────
_FACE_APP = None

def _detect_face_bbox(img: Image.Image) -> Optional[tuple[int, int, int, int]]:
    """PIL 이미지 → 가장 큰 얼굴 bbox (x1,y1,x2,y2). 실패/미검출 시 None."""
    global _FACE_APP
    try:
        import numpy as np
        if _FACE_APP is None:
            from insightface.app import FaceAnalysis
            _FACE_APP = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
            _FACE_APP.prepare(ctx_id=-1, det_size=(640, 640))
        arr = np.array(img.convert("RGB"))[:, :, ::-1]  # RGB→BGR
        faces = _FACE_APP.get(arr)
        if not faces:
            return None
        # 가장 큰 얼굴
        largest = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
        x1, y1, x2, y2 = largest.bbox.astype(int)
        return (int(x1), int(y1), int(x2), int(y2))
    except Exception:
        return None


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