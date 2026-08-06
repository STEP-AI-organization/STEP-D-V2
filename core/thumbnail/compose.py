"""구조 템플릿 + 배경 + 인물 → 최종 썸네일 합성.

사용자 계획 (2026-08-06) ② 단계.

입력 순서는 고정이다. 프롬프트가 "Image 1/2/3/4" 로 지칭하므로 순서가 어긋나면
배경 자리에 얼굴이 들어가는 식으로 조용히 망가진다.

    1) 구조 템플릿(청사진)  2) 영상 배경 프레임  3) 인물 1  4) 인물 2

제목은 생성 모델이 그리지 않는다 (계획 5단계 · 2026-07-27 확정 원칙).
한글 타이포를 이미지 모델에 맡기면 오타를 막을 방법이 없어서, 여기서는
**제목 자리를 비워둔 합성본**만 만들고 글자는 caption_overlay 가 얹는다.
AI 가 제목까지 그리게 하려면 render_titles_with_model=True — 검증용으로만 쓸 것.
"""
from __future__ import annotations

from typing import Optional

from core.models import IMAGE_PRO
from core.thumbnail.structure import StructureTemplate

# ── 공통 본문 ─────────────────────────────────────────────────────────────────

_HEADER = """Use case: compositing
Asset type: final high-quality 16:9 Korean broadcast YouTube thumbnail

Input images:

- Image 1: STRUCTURE TEMPLATE
  Use only for composition, element positions, approximate sizes, cropping, overlap, facing directions, safe margins, title zones, border, and visual hierarchy.

- Image 2: VIDEO BACKGROUND
  Use as the actual background of the final thumbnail.
{person_inputs}
Content information:

영상 내용:
{summary}

장면 분위기:
{mood}
{title_info}
Primary request:

Create one polished, professional Korean broadcast YouTube thumbnail using the supplied structure template and source images.

The final result must look like a manually designed Photoshop thumbnail, not an AI-generated collage.

Template interpretation:

- Image 1 is only a structural layout guide.
- Do not include the blue-gray placeholder background from Image 1.
- Do not include any gray silhouettes from Image 1.
- Do not include the words "영상 배경", "인물 1", "인물 2", "제목 1", or "제목 2".
- Replace every placeholder with the corresponding supplied source.
- Preserve the template's approximate composition, relative scale, safe margins, overlap, and visual hierarchy.
- Minor positional adjustments are allowed only when needed to improve balance or prevent faces and text from being cropped.

Background:

- Completely replace the template background with Image 2.
- Preserve the recognizable setting and important visual details from Image 2.
- Expand or crop Image 2 naturally to fill the entire 16:9 canvas.
- Remove any existing subtitles, captions, channel logos, watermarks, timestamps, or UI elements from the background.
- Do not invent a different location.
- Do not reuse or reconstruct the background from Image 1.
- Make the background slightly darker, softer, and less saturated than the people.
- Add subtle depth, blur, vignette, or localized darkening only where necessary.
- Keep the background recognizable but visually subordinate to the people and headline.
"""

_PERSON_BLOCK = """
Person {n}:

- Extract the real person from Image {img} and place them in the "인물 {n}" slot from Image 1.
- Preserve the person's identity, facial features, hairstyle, skin tone, approximate age, and recognizable appearance.
- Do not replace the person with a similar-looking generated person.
- Preserve natural facial anatomy and realistic skin texture.
- Remove the original background cleanly.
- Match the approximate size, crop, body direction, and facing direction shown in the template.
- If necessary, mirror the body direction while keeping the face natural and recognizable.
- Apply clean professional cutout edges, subtle rim light, outline, shadow, and color correction.
"""

_INTEGRATION = """
People integration:

- Match {people_phrase} to the lighting and color temperature of the new background.
- Keep the faces brighter and sharper than the background.
- Preserve believable depth and separation between the people and the background.
- Make the people appear naturally composited, as if edited manually in Photoshop.
- Do not merge the two faces or bodies.
- Do not change their identities.
- Do not add extra people.
"""

# 기본 경로: 제목 자리를 비워둔다. 글자는 서버(caption_overlay)가 렌더한다.
_TITLE_EMPTY = """
Title zones:

- Leave the "제목 1" and "제목 2" areas completely EMPTY.
- Do not render any Korean text, letters, numbers, or typography anywhere in the image.
- Keep those areas visually clean and uncluttered so text can be overlaid later:
  no busy detail, no faces, no high-frequency texture, no bright highlights there.
- Preserve the template's title zone positions, sizes, and hierarchy as empty space.
- Do not draw placeholder boxes, outlines, or labels for the title areas either.
"""

# 검증용 경로: 모델이 제목까지 그린다. 한글 오타 위험을 감수하는 모드.
_TITLE_RENDERED = """
Title 1:

Replace the "제목 1" placeholder with exactly:

"{sub_title}"

- Preserve the approximate position, width, alignment, and hierarchy of the template's Title 1 zone.
- Use bold Korean broadcast-thumbnail typography.
- Maintain high contrast and immediate readability.
- Use the template's yellow emphasis as the primary style cue.
- Keep it smaller than Title 2.

Title 2:

Replace the "제목 2" placeholder with exactly:

"{main_title}"

- Preserve the approximate position, scale, alignment, and hierarchy of the template's Title 2 zone.
- Use extremely bold Korean display typography.
- Allow up to two lines if necessary.
- Use strong contrast, clean spacing, subtle outline, and drop shadow.
- Make it readable at mobile-thumbnail size.
- Do not cover important facial features.
- Do not add, remove, translate, paraphrase, or misspell any characters.
"""

_TAIL = """
Visual direction:

- Premium Korean entertainment and broadcast YouTube thumbnail
- Strong focal hierarchy
- Clear emotional storytelling
- High contrast without excessive saturation
- Clean Photoshop-style compositing
- Sharp and recognizable faces
- Controlled cinematic color grading
- Mobile-first readability
- Professional, clickable, but not visually cluttered

Preserve:

- Identities of the supplied people
- Actual background location from Image 2
- Template composition and title hierarchy
- 16:9 landscape format

Remove:

- All template placeholder labels
- Template silhouette shapes
- Template placeholder background
- Existing text in all source images
- Existing logos and watermarks
- Existing subtitles and captions

Avoid:

- Reusing the template's placeholder background
- Reconstructing the original reference-thumbnail background
- Generic AI-generated faces
- Identity changes
- Face blending
- Duplicate people
- Extra fingers or distorted anatomy
- Plastic skin
- Unnatural facial expressions
- Poor cutout edges
- Visible gray silhouettes
- Extra text
- Tiny text
- Excessive glow
- Excessive outlines
- Excessive HDR
- Random decorations
- Logos
- Watermarks

Output:

- One finished 16:9 YouTube thumbnail
- No empty placeholder areas
- No template instructions visible
- No layout labels visible
- Ready for professional broadcast-channel use"""


def build_compose_prompt(
    summary: str,
    mood: str,
    person_count: int = 2,
    sub_title: str = "",
    main_title: str = "",
    render_titles_with_model: bool = False,
) -> str:
    """② 프롬프트 조립. 인물 수에 따라 Person 블록과 입력 이미지 목록이 바뀐다."""
    person_inputs = ""
    person_blocks = ""
    for n in range(1, person_count + 1):
        img = n + 2  # Image 3 부터 인물
        person_inputs += (
            f"\n- Image {img}: PERSON {n}\n"
            f'  Use this person\'s real face and appearance in the "인물 {n}" slot.\n'
        )
        person_blocks += _PERSON_BLOCK.format(n=n, img=img)

    if render_titles_with_model:
        title_info = (
            f'\n제목 1:\n"{sub_title}"\n\n제목 2:\n"{main_title}"\n'
        )
        title_section = _TITLE_RENDERED.format(sub_title=sub_title, main_title=main_title)
    else:
        # 제목을 안 그릴 것이므로 문구 자체를 넣지 않는다. 넣으면 모델이 그린다.
        title_info = ""
        title_section = _TITLE_EMPTY

    integration = _INTEGRATION.format(
        people_phrase="both people" if person_count >= 2 else "the person"
    )
    if person_count < 2:
        integration = integration.replace("- Do not merge the two faces or bodies.\n", "")

    return (
        _HEADER.format(
            person_inputs=person_inputs,
            summary=summary,
            mood=mood,
            title_info=title_info,
        )
        + person_blocks
        + integration
        + title_section
        + _TAIL
    )


def compose(
    template_image: bytes,
    background_image: bytes,
    person_images: list[bytes],
    summary: str,
    mood: str,
    sub_title: str = "",
    main_title: str = "",
    render_titles_with_model: bool = False,
    model: str = IMAGE_PRO,
) -> Optional[bytes]:
    """제목 없는 합성본 1장. 실패 시 None.

    이미지 순서가 곧 프롬프트의 Image 번호다 — 바꾸지 말 것.
    """
    # 지연 import: 프롬프트 조립만 할 때는 OpenAI SDK 가 없어도 된다.
    from core.openai_client import edit as openai_edit

    prompt = build_compose_prompt(
        summary=summary,
        mood=mood,
        person_count=len(person_images),
        sub_title=sub_title,
        main_title=main_title,
        render_titles_with_model=render_titles_with_model,
    )
    return openai_edit(
        images=[template_image, background_image, *person_images],
        prompt=prompt,
        model=model,
        size="1536x1024",
    )


def title_zones(template: StructureTemplate) -> list[dict]:
    """합성 후 caption_overlay 가 쓸 제목 슬롯. 픽셀 변환은 렌더러가 한다."""
    return [dict(slot) for slot in (template.get("textSlots") or [])]
