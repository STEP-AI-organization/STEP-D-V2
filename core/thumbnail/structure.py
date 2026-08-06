"""완성 썸네일 → 구조 전용 템플릿 (structure-only template).

사용자 계획 (2026-08-06) ① 단계.

기존 `swap.py` 계열과의 차이:
- swap: 방송사 완성작을 그대로 두고 얼굴·자막만 교체 (배경/장식을 원본에서 빌려옴)
- structure: 배경을 통째로 지우고 인물을 회색 실루엣으로 치환 → **배치 정보만** 남긴 청사진.
  배경·조명·합성 품질을 우리가 책임지는 대신, 어떤 프로그램에도 재사용된다.

산출물은 2개다. 둘 다 있어야 엔진이 돈다:
- 청사진 이미지 : 생성 모델에 "구도 참고"로 넣는다 (compose.py)
- 슬롯 좌표 JSON: 서버가 결정론적으로 쓰는 값 (제목 렌더 위치·검증·매칭)
  좌표는 픽셀이 아니라 0~1 정규화. 해상도가 바뀌어도 그대로 쓰기 위함.
"""
from __future__ import annotations

import json
import pathlib
from typing import Any, Literal, Optional, TypedDict

from core.models import IMAGE_PRO

STRUCTURE_DIR = pathlib.Path(__file__).resolve().parents[2] / "assets" / "thumbnail-structure"
REGISTRY = STRUCTURE_DIR / "registry.json"


# ── 슬롯 스키마 ────────────────────────────────────────────────────────────────
# bbox 는 [x, y, w, h] · 전부 0~1 정규화 (캔버스 좌상단 기준).

class PersonSlot(TypedDict):
    id: str
    bbox: list[float]
    facing: Literal["left", "right", "center"]
    crop: Literal["face", "upper_body", "full_body"]
    zIndex: int


class TextSlot(TypedDict):
    id: str
    bbox: list[float]
    maxLines: int
    maxCharacters: int


class BackgroundStyle(TypedDict, total=False):
    blur: float
    brightness: float
    saturation: float
    vignette: float


class StructureTemplate(TypedDict, total=False):
    templateId: str
    category: str
    aspectRatio: str
    personCount: int
    moods: list[str]
    personSlots: list[PersonSlot]
    textSlots: list[TextSlot]
    backgroundStyle: BackgroundStyle
    imagePath: str
    sourceRef: str


# ── ① 템플릿 가공 프롬프트 (원본 · 사용자 작성) ───────────────────────────────
# 문구를 임의로 다듬지 않는다. 결과가 바뀌면 원인 추적이 안 된다.
EXTRACT_PROMPT = """Use case: precise-object-edit
Asset type: reusable structural layout template for a 16:9 Korean broadcast YouTube thumbnail

Input image:
The supplied finished thumbnail is only a reference for element positions, approximate sizes, overlap, visual hierarchy, border/safe margins, and facing directions.

Primary request:
Rebuild the supplied thumbnail as an unmistakable STRUCTURE-ONLY TEMPLATE.

Completely remove the original background and do not reconstruct it.

Replace the entire background with one flat, muted blue-gray placeholder field. Keep it visually simple and uniform, with a subtle centered label:

"영상 배경"

It must clearly look like a replaceable background slot, not a real scene.

Person slots:

- Replace the original person on the left with a simple, solid medium-gray head-and-shoulders silhouette.
- Preserve approximately the original person's size, position, crop, body direction, and facing direction.
- Label the silhouette "인물 1".

- Replace the original person on the right with a simple, solid medium-gray head-and-shoulders silhouette.
- Preserve approximately the original person's size, position, crop, body direction, and facing direction.
- Label the silhouette "인물 2".

- All silhouettes must be generic placeholders.
- Do not include facial features, realistic faces, detailed hair, clothing details, identities, photographic textures, realistic shadows, or realistic lighting.

Text slots:

- Replace the original small subtitle or supporting headline area with a clean yellow rectangular placeholder labeled "제목 1".
- Replace the original large main headline area with a clean white rectangular placeholder labeled "제목 2".
- If the original main headline supports two lines, preserve enough vertical space for two lines.
- Preserve the approximate original placement, size, margins, alignment, and hierarchy.
- Both areas must clearly look like editable placeholder boxes, not finished thumbnail typography.

Style layer:

- Preserve only simplified, non-identifying decorative elements that help communicate the original layout.
- If the original has an outer border, preserve it as a simplified thin off-white border.
- Do not preserve brand-specific graphics, logos, program identities, or unique copyrighted decorations.

Composition:

- Exact landscape 16:9 YouTube thumbnail format.
- Preserve the original safe margins.
- Preserve the approximate positions and relative proportions of all major elements.
- Preserve the original composition between the people, including overlap and facing directions.
- Produce a clean, professional layout blueprint suitable for reuse as an AI thumbnail template.

Exact visible text only:

"영상 배경"
"인물 1"
"인물 2"
"제목 1"
"제목 2"

Constraints:

- No original background
- No reconstructed original background
- No realistic scene
- No real faces
- No identifiable people
- No detailed clothing
- No network logo
- No program logo
- No show title
- No episode label
- No original phrases
- No original Korean copy
- No watermark
- No additional symbols
- No additional text"""


def build_extract_prompt(person_count: int = 2) -> str:
    """인물이 1명뿐인 원본이면 '인물 2' 지시를 떼어낸다.

    프롬프트에 없는 슬롯을 요구하면 모델이 없는 인물을 지어내므로,
    원본 인물 수에 맞춰 잘라내는 편이 안전하다.
    """
    if person_count >= 2:
        return EXTRACT_PROMPT
    start = EXTRACT_PROMPT.index('- Replace the original person on the right')
    end = EXTRACT_PROMPT.index('- All silhouettes must be generic placeholders.')
    trimmed = EXTRACT_PROMPT[:start] + EXTRACT_PROMPT[end:]
    return trimmed.replace('"인물 1"\n"인물 2"\n', '"인물 1"\n')


def extract_structure_image(
    source: bytes,
    person_count: int = 2,
    model: str = IMAGE_PRO,
) -> Optional[bytes]:
    """완성 썸네일 1장 → 구조 청사진 이미지. 실패 시 None."""
    # 지연 import: 프롬프트 조립·스키마 검증은 OpenAI SDK 없이도 돼야 한다.
    from core.openai_client import edit as openai_edit

    return openai_edit(
        images=[source],
        prompt=build_extract_prompt(person_count),
        model=model,
        size="1536x1024",  # 16:9
    )


# ── 레지스트리 ────────────────────────────────────────────────────────────────
# 좌표 JSON 은 사람이 넣는다. 모델이 뽑은 bbox 를 신뢰하면 제목이 얼굴을 덮는
# 사고가 조용히 지나가므로, 청사진 이미지를 보고 확정한 값만 등록한다.

def load_registry() -> list[StructureTemplate]:
    if not REGISTRY.exists():
        return []
    return json.loads(REGISTRY.read_text(encoding="utf-8"))


def save_registry(templates: list[StructureTemplate]) -> None:
    STRUCTURE_DIR.mkdir(parents=True, exist_ok=True)
    REGISTRY.write_text(
        json.dumps(templates, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def upsert_template(template: StructureTemplate) -> list[StructureTemplate]:
    """templateId 기준 갱신. 없으면 추가."""
    templates = load_registry()
    for i, t in enumerate(templates):
        if t.get("templateId") == template.get("templateId"):
            templates[i] = {**t, **template}
            break
    else:
        templates.append(template)
    save_registry(templates)
    return templates


def get_template(template_id: str) -> Optional[StructureTemplate]:
    for t in load_registry():
        if t.get("templateId") == template_id:
            return t
    return None


def validate_template(t: StructureTemplate) -> list[str]:
    """등록 전 스키마 점검. 문제 목록을 돌려준다 (빈 리스트면 통과).

    좌표가 캔버스를 벗어나거나 슬롯 수가 personCount 와 어긋나면 합성 단계가
    아니라 여기서 걸려야 한다 — 나중에 걸리면 이미지 생성 비용을 이미 쓴 뒤다.
    """
    problems: list[str] = []
    if not t.get("templateId"):
        problems.append("templateId 없음")
    slots = t.get("personSlots") or []
    if t.get("personCount") is not None and len(slots) != t["personCount"]:
        problems.append(f"personCount={t['personCount']} 인데 personSlots={len(slots)}")
    for slot in [*slots, *(t.get("textSlots") or [])]:
        bbox = slot.get("bbox") or []
        if len(bbox) != 4:
            problems.append(f"{slot.get('id')}: bbox 는 [x,y,w,h] 4개여야 함")
            continue
        x, y, w, h = bbox
        if not all(0.0 <= v <= 1.0 for v in bbox):
            problems.append(f"{slot.get('id')}: bbox 값이 0~1 범위 밖")
        if x + w > 1.0001 or y + h > 1.0001:
            problems.append(f"{slot.get('id')}: bbox 가 캔버스를 벗어남")
    return problems
