"""썸네일 템플릿 registry · 인물/자막 zone 고정 · Planner 자유도 축소.

사용자 지시 (2026-07-28):
"자유 너무 주면 안 되고 · 인물 영역/글씨 영역/캡션 영역 딱 고정한
 여러 템플릿 만들어서 돌리는게 맞는 것 같음"

각 템플릿은:
- person_zones: 인물 슬롯 (id, position, size, z_index) · Planner 는 이름만 채움
- caption_zones: 자막 슬롯 (id, role, position, size, max_chars) · Planner 는 텍스트만 채움
- background: 배경 처리 스타일 (blur 강도·gradient 등)

Planner 는 template_id 선택 + slot_fills 만 함 · position/size 는 template 이 결정.
"""
from __future__ import annotations
from typing import Any

TEMPLATES: dict[str, dict[str, Any]] = {

    # ── T1 · 1인 클로즈업 · 인물 감정·표정 집중 ──────────────────
    "T1_closeup": {
        "description": "1인 클로즈업 · 감정·표정·독백·리액션 집중",
        "person_zones": [
            # hero L (0.65H) · 상반신 · 화면 우측 절반
            {"id": "hero", "position": "bottom-right", "size": "L", "z_index": 0},
        ],
        "caption_zones": [
            {"id": "cap_sub",  "role": "subtitle", "position": "middle-left",
             "size": "S", "max_chars": 12},
            {"id": "cap_main", "role": "main",     "position": "bottom-left",
             "size": "L", "max_chars": 10},
        ],
        "background": {
            "mode": "source_blur", "blur": "heavy", "vignette": True,
            "nano_hint": "원본 프레임 강한 blur (radius 20~30px) · 인물 없이 배경만 · vignette",
        },
    },

    # ── T2 · 2인 대립·대비 · 좌우 분할 ───────────────────────────
    "T2_split": {
        "description": "2인 대립/대비 · 좌우 분할 · 관계·긴장 프레이밍",
        "person_zones": [
            # 각각 M (0.50H) · 상반신 · 좌우 대칭
            {"id": "left",  "position": "bottom-left",  "size": "M", "z_index": 0},
            {"id": "right", "position": "bottom-right", "size": "M", "z_index": 0},
        ],
        "caption_zones": [
            {"id": "cap_main", "role": "main", "position": "top-center",
             "size": "L", "max_chars": 10},
        ],
        "background": {
            "mode": "source_blur", "blur": "medium", "center_darken": True,
            "nano_hint": "원본 프레임 중간 blur · 중앙 어둡게 gradient · 인물 없이",
        },
    },

    # ── T3 · 명대사 임팩트 · 인용 hero ──────────────────────────
    "T3_quote": {
        "description": "명대사·폭탄 발언 임팩트 · 인용문 hero",
        "person_zones": [
            # hero M (0.50H) · 우측 하단
            {"id": "hero", "position": "bottom-right", "size": "M", "z_index": 0},
        ],
        "caption_zones": [
            {"id": "cap_quote", "role": "quote",    "position": "middle-left",
             "size": "L", "max_chars": 16},
            {"id": "cap_sub",   "role": "subtitle", "position": "bottom-left",
             "size": "S",  "max_chars": 10},
        ],
        "background": {
            "mode": "source_blur", "blur": "light", "bottom_gradient": True,
            "nano_hint": "원본 프레임 약한 blur · 하단 어둡게 gradient · 인물 없이",
        },
    },

    # ── T4 · 리액션·반전 · 메인+원인/상대 ───────────────────────
    "T4_reaction": {
        "description": "리액션·반전·놀람 · 메인 리액션 + 원인/상대 인물 서브",
        "person_zones": [
            # 메인 리액션 M (0.50H) 하단 · 원인 S (0.35H) 상단 우측
            {"id": "reactor", "position": "bottom-left", "size": "M", "z_index": 1},
            {"id": "cause",   "position": "top-right",   "size": "S", "z_index": 0},
        ],
        "caption_zones": [
            {"id": "cap_badge", "role": "badge", "position": "top-left",
             "size": "S", "max_chars": 6},
            {"id": "cap_main",  "role": "main",  "position": "bottom-right",
             "size": "L", "max_chars": 10},
        ],
        "background": {
            "mode": "source_blur", "blur": "medium",
            "nano_hint": "원본 프레임 중간 blur · 인물 없이 배경 톤만",
        },
    },
}


def list_templates_summary() -> str:
    """Planner 프롬프트에 넣을 템플릿 요약 (사람이 읽기 편한)."""
    lines = ["[사용 가능한 템플릿]"]
    for tid, t in TEMPLATES.items():
        pz = t["person_zones"]; cz = t["caption_zones"]
        person_slots = " · ".join(f"{p['id']}({p['position']},{p['size']})" for p in pz)
        cap_slots = " · ".join(f"{c['id']}[{c['role']}]" for c in cz)
        lines.append(f"- **{tid}**: {t['description']}")
        lines.append(f"    person: {person_slots}")
        lines.append(f"    caption: {cap_slots}")
    return "\n".join(lines)


def get(tid: str) -> dict[str, Any] | None:
    return TEMPLATES.get(tid)
