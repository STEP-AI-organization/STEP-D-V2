"""마스크 보호 마감 — 얼굴은 API 차원에서 잠그고 나머지만 생성형이 다듬는다.

사용자 지시 (2026-08-06): "얼굴 지키는 게 이리 어렵나."

프롬프트로 "얼굴을 바꾸지 마라"고 쓰는 건 원리상 안 통한다. 생성 모델은 출력의
모든 픽셀을 새로 만들고, 눈 간격이 2px만 달라져도 사람은 다른 사람으로 읽는다.

images.edit 의 mask 는 부탁이 아니라 보장이다 — **불투명하게 가린 영역은 원본
픽셀이 그대로 남는다.** 그래서 순서를 이렇게 둔다:

    1) paste.build() 로 결정론 판을 만든다 (인물 원본 픽셀)
    2) 얼굴 영역만 불투명 마스크로 잠근다
    3) 생성 모델이 배경·조명·그림자·누끼 경계만 다시 그린다

얼굴은 1픽셀도 바뀌지 않고, "오려 붙인 티"만 사라진다.
"""
from __future__ import annotations

import io
import pathlib
from typing import Any, Optional

POLISH_PROMPT = """Use case: photo compositing polish
Asset type: 16:9 Korean broadcast YouTube thumbnail

The supplied image is a rough composite: people were cut out and pasted onto a
background. Make it look like one photograph taken at the same moment.

Do:
- Blend the cutout edges naturally. Remove halos, jagged edges, and leftover
  fringe pixels around the people.
- Add believable contact shadows and ambient occlusion where the people meet
  the background.
- Unify lighting direction, color temperature, and contrast between the people
  and the background.
- Add subtle depth: keep the background slightly softer and darker than the people.
- Keep the composition, the position and scale of every person, and the two
  solid title bars exactly where they are.

Do not:
- Do not change anyone's face, facial features, expression, hairstyle, skin
  tone, age, or identity.
- Do not add or remove people.
- Do not render any text, letters, numbers, logos, or watermarks.
- Do not fill the title bars with anything — keep them clean and solid.
- Do not change the aspect ratio or crop the image."""


def face_mask(
    size: tuple[int, int],
    face_boxes: list[tuple[int, int, int, int]],
    pad: float = 0.35,
) -> bytes:
    """얼굴만 잠그는 마스크 PNG.

    OpenAI 규약: **투명한 곳이 편집 대상**이고 불투명한 곳은 보존된다.
    따라서 캔버스 전체를 투명하게 두고 얼굴 타원만 불투명하게 칠한다.
    pad 는 머리카락·턱선까지 여유를 준다 — 경계가 얼굴에 딱 붙으면 그 주변을
    모델이 다시 그리면서 윤곽이 어긋난다.
    """
    from PIL import Image, ImageDraw

    m = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(m)
    for (x1, y1, x2, y2) in face_boxes:
        w, h = x2 - x1, y2 - y1
        box = (int(x1 - w * pad), int(y1 - h * pad),
               int(x2 + w * pad), int(y2 + h * pad))
        d.ellipse(box, fill=(255, 255, 255, 255))
    buf = io.BytesIO()
    m.save(buf, "PNG")
    return buf.getvalue()


def detect_faces_in(image_path: pathlib.Path) -> list[tuple[int, int, int, int]]:
    """합성 판에서 얼굴 위치를 찾는다 (마스크를 씌울 자리)."""
    import os

    os.environ.setdefault("FACES_ALLOW_CPU", "1")
    import cv2

    from core.faces import _detect, _get_app

    _get_app()
    img = cv2.imread(str(image_path))
    if img is None:
        return []
    out = []
    for d in _detect(img):
        x1, y1, x2, y2 = d["bbox"]
        out.append((int(x1), int(y1), int(x2), int(y2)))
    return out


def polish(
    plate_path: pathlib.Path,
    face_boxes: Optional[list[tuple[int, int, int, int]]] = None,
    model: Optional[str] = None,
    size: str = "1536x1024",
) -> Optional[bytes]:
    """결정론 판 → 마감본. 얼굴은 마스크로 잠근 채 나머지만 다시 그린다."""
    from PIL import Image

    from core.models import IMAGE_PRO
    from core.openai_client import edit as openai_edit

    plate = Image.open(plate_path)
    boxes = face_boxes if face_boxes is not None else detect_faces_in(plate_path)
    if not boxes:
        # 얼굴을 못 찾으면 잠글 곳이 없다 — 마감을 걸면 얼굴이 바뀐다. 중단.
        raise RuntimeError("합성 판에서 얼굴을 찾지 못했다 — 마스크 없이는 마감하지 않는다")

    return openai_edit(
        images=[plate_path.read_bytes()],
        prompt=POLISH_PROMPT,
        model=model or IMAGE_PRO,
        size=size,
        mask=face_mask(plate.size, boxes),
    )
