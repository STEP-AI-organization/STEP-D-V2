"""썸네일 스타일 프리셋 (docs/plans/thumbnail-engine-plan.md §14.6 확장 · 2026-07-27).

프로그램 성격/편집 톤별 프리셋. planner가 컨텍스트 보고 선택 · generator가 룩업.

프리셋 = font_role + 색 팔레트 + 자막 톤 힌트 + 배치 hint 세트.
같은 인물·프레임·자막이어도 프리셋만 다르면 완전 다른 결과.
"""
from __future__ import annotations
from typing import TypedDict


class StylePreset(TypedDict):
    id: str
    description: str      # planner 프롬프트에 노출
    font_role: str        # generator FONT_PRESETS 매핑 (variety/drama/news/documentary)
    text_color: str
    outline_color: str
    caption_tone_pool: list[str]   # "인용"|"훅"|"의문"|"충격"|"기본"
    person_side_default: str       # "left"|"right"|"center"
    person_scale_default: float
    caption_position_default: str  # "top"|"middle"|"bottom"|"auto"
    caption_size_default: str      # "XL"|"L"|"M"
    background_style_default: str  # "cinematic"|"illustration"|"photo"|"abstract"
    background_prompt_hint: str    # generate_background prompt에 접두


PRESETS: dict[str, StylePreset] = {
    # ─────────────────────────────────────────────────────────
    "broadcast_official": {
        "id": "broadcast_official",
        "description": ("방송사 공식 채널(tvN·JTBC·MBC) 톤. 인물 크게·짧고 임팩트 자막·"
                        "정돈된 컬러. 요즘 유튜브 스타일. 예: '[EP.4] 폭탄 발언', '드디어 만남', '표정 봐'."),
        "font_role": "variety",
        "text_color": "#ffffff",
        "outline_color": "#000000",
        "caption_tone_pool": ["인용", "기본"],
        "person_side_default": "left",
        "person_scale_default": 0.95,
        "caption_position_default": "auto",
        "caption_size_default": "XL",
        "background_style_default": "cinematic",
        "background_prompt_hint": "차분한 시네마틱 톤 · 정돈된 조명 · 방송 세트 느낌",
    },
    # ─────────────────────────────────────────────────────────
    "magazine": {
        "id": "magazine",
        "description": ("매체 리뷰/에세이 톤. 감성적·잔잔·시네마틱. 자막 짧고 여운·인용부호 O. "
                        "예: '\"그 말은 하지 마\"', '01. 흘러간 시간', '…라고 씁니다'."),
        "font_role": "drama",
        "text_color": "#f5f5f0",
        "outline_color": "#1a1a1a",
        "caption_tone_pool": ["인용", "의문"],
        "person_side_default": "center",
        "person_scale_default": 0.85,
        "caption_position_default": "bottom",
        "caption_size_default": "L",
        "background_style_default": "photo",
        "background_prompt_hint": "필름 감성 · 부드러운 조명 · 명도 낮은 파스텔",
    },
    # ─────────────────────────────────────────────────────────
    "reaction": {
        "id": "reaction",
        "description": ("이슈·리액션 채널 톤. 짧고 임팩트·강한 색 대비·물음표·기호. "
                        "예: '이거 실화?', '결국 터짐', '표정 봐', '설마 진짜?'. clickbait 남용 금지."),
        "font_role": "variety",
        "text_color": "#ffee00",
        "outline_color": "#000000",
        "caption_tone_pool": ["훅", "충격", "의문"],
        "person_side_default": "right",
        "person_scale_default": 1.0,
        "caption_position_default": "auto",
        "caption_size_default": "XL",
        "background_style_default": "photo",
        "background_prompt_hint": "강한 조명 대비 · vibrant · 진한 채도",
    },
    # ─────────────────────────────────────────────────────────
    "music_show": {
        "id": "music_show",
        "description": ("음악 방송/무대 클립 톤. 밝은 조명·컬러풀·인물 강조. "
                        "예: '무대 첫 공개', '팬미팅 실황'."),
        "font_role": "variety",
        "text_color": "#ffffff",
        "outline_color": "#7c2ae8",
        "caption_tone_pool": ["훅", "기본"],
        "person_side_default": "center",
        "person_scale_default": 1.0,
        "caption_position_default": "top",
        "caption_size_default": "L",
        "background_style_default": "illustration",
        "background_prompt_hint": "무대 조명 · 색색의 조명빔 · 화려한 배경",
    },
    # ─────────────────────────────────────────────────────────
    "news": {
        "id": "news",
        "description": ("뉴스·시사 클립. 인물 인터뷰 위주·정확한 정보성 자막. "
                        "예: '전문가가 말하다', '단독 인터뷰'."),
        "font_role": "news",
        "text_color": "#ffffff",
        "outline_color": "#003366",
        "caption_tone_pool": ["기본", "인용"],
        "person_side_default": "right",
        "person_scale_default": 0.9,
        "caption_position_default": "auto",
        "caption_size_default": "L",
        "background_style_default": "photo",
        "background_prompt_hint": "뉴스 스튜디오 느낌 · 청색 톤 · 정보성",
    },
    # ─────────────────────────────────────────────────────────
    "documentary": {
        "id": "documentary",
        "description": ("다큐멘터리·휴먼. 잔잔·중후한 톤. 자막 최소·서정적. "
                        "예: '한 사람의 이야기', '기록되지 않은 시간'."),
        "font_role": "documentary",
        "text_color": "#f0e8d0",
        "outline_color": "#1a1a1a",
        "caption_tone_pool": ["인용", "기본"],
        "person_side_default": "center",
        "person_scale_default": 0.9,
        "caption_position_default": "bottom",
        "caption_size_default": "M",
        "background_style_default": "photo",
        "background_prompt_hint": "자연광 · 무드 있는 · 낮은 채도 · 필름 그레인",
    },
}


DEFAULT_PRESET = "broadcast_official"


def get_preset(preset_id: str | None) -> StylePreset:
    """Planner가 넘긴 preset_id 검증 · 없으면 default."""
    if preset_id and preset_id in PRESETS:
        return PRESETS[preset_id]
    return PRESETS[DEFAULT_PRESET]


def prompt_summary() -> str:
    """Planner 프롬프트에 넣을 프리셋 목록 텍스트."""
    lines = ["[사용 가능한 스타일 프리셋 (하나 선택)]"]
    for p in PRESETS.values():
        lines.append(f"- {p['id']}: {p['description']}")
    return "\n".join(lines)
