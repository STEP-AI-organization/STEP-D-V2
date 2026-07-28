"""썸네일 템플릿 registry · 인물/자막 zone 고정 · Planner 자유도 축소.

사용자 지시 (2026-07-28):
"자유 너무 주면 안 되고 · 인물 영역/글씨 영역/캡션 영역 딱 고정한 여러 템플릿"
"내가 좌표 고정을 해줄게 · HTML 로 · 그 좌표를 그대로 사용"

각 템플릿:
- person_zones: 인물 슬롯 (id + xywh 정규화 [x,y,w,h])
- caption_zones: 자막 슬롯 (id + role + xywh)
- background: 배경 처리 힌트

Planner 는 template_id 선택 + slot_fills (id→이름/텍스트) 만 함.
xywh 는 HTML 디자이너에서 사용자가 직접 배치 (docs/tools/template-designer.html).
"""
from __future__ import annotations
from typing import Any

TEMPLATES: dict[str, dict[str, Any]] = {

    # ── T1 · 1인 클로즈업 ────────────────────────────────────
    "T1_closeup": {
        "description": "1인 클로즈업",
        "person_zones": [
            {"id": "hero", "xywh": [0.305, 0.13, 0.406, 0.752], "z_index": 0},
        ],
        "caption_zones": [
            {"id": "cap_sub",  "role": "subtitle", "xywh": [0.281, 0.018, 0.45, 0.1]},
            {"id": "cap_main", "role": "main",     "xywh": [0.224, 0.781, 0.55, 0.2]},
        ],
        "background": {"mode": "source_blur", "blur": "medium",
                       "nano_hint": "원본 프레임 blur · 인물 없이 배경 톤만"},
    },

    # ── T2 · 2인 대립 (좌우) ────────────────────────────────
    "T2_split": {
        "description": "2인 대립",
        "person_zones": [
            {"id": "left",  "xywh": [0.02, 0.4, 0.4, 0.58], "z_index": 0},
            {"id": "right", "xywh": [0.58, 0.4, 0.4, 0.58], "z_index": 1},
        ],
        "caption_zones": [
            {"id": "cap_main", "role": "main", "xywh": [0.165, 0.048, 0.7, 0.18]},
        ],
        "background": {"mode": "source_blur", "blur": "medium",
                       "nano_hint": "원본 프레임 blur · 인물 없이 배경 톤만"},
    },

    # ── T3 · 명대사 (인용 hero) ─────────────────────────────
    "T3_quote": {
        "description": "명대사",
        "person_zones": [
            {"id": "hero", "xywh": [0.6, 0.4, 0.35, 0.58], "z_index": 0},
        ],
        "caption_zones": [
            {"id": "cap_quote", "role": "quote",    "xywh": [0.0,  0.426, 0.55, 0.25]},
            {"id": "cap_sub",   "role": "subtitle", "xywh": [0.03, 0.85,  0.35, 0.1]},
        ],
        "background": {"mode": "source_blur", "blur": "medium",
                       "nano_hint": "원본 프레임 blur · 인물 없이 배경 톤만"},
    },

    # ── T4 · 리액션·반전 (메인 + 원인) ──────────────────────
    "T4_reaction": {
        "description": "리액션·반전",
        "person_zones": [
            {"id": "reactor", "xywh": [0.033, 0.392, 0.36,  0.55],  "z_index": 0},
            {"id": "cause",   "xywh": [0.625, 0.042, 0.339, 0.496], "z_index": 1},
        ],
        "caption_zones": [
            {"id": "cap_badge", "role": "badge", "xywh": [0.017, 0.027, 0.28, 0.09]},
            {"id": "cap_main",  "role": "main",  "xywh": [0.478, 0.778, 0.48, 0.15]},
        ],
        "background": {"mode": "source_blur", "blur": "medium",
                       "nano_hint": "원본 프레임 blur · 인물 없이 배경 톤만"},
    },

    # ── T5 · 3인 나란히 · 하단 메인 카피 ────────────────────
    "T5_trio": {
        "description": "3인 나란히 · 하단 메인 카피",
        "person_zones": [
            {"id": "p1", "xywh": [0.655, 0.245, 0.345, 0.755], "z_index": 0},
            {"id": "p2", "xywh": [0.0,   0.249, 0.337, 0.751], "z_index": 1},
            {"id": "p3", "xywh": [0.319, 0.188, 0.363, 0.812], "z_index": 2},
        ],
        "caption_zones": [
            {"id": "cap_main", "role": "main", "xywh": [0.193, 0.795, 0.637, 0.168]},
        ],
        "background": {"mode": "source_blur", "blur": "medium",
                       "nano_hint": "원본 프레임 blur · 인물 없이 배경 톤만"},
    },
}


def list_templates_summary() -> str:
    """Planner 프롬프트에 넣을 템플릿 요약."""
    lines = ["[사용 가능한 템플릿]"]
    for tid, t in TEMPLATES.items():
        pz = t["person_zones"]; cz = t["caption_zones"]
        person_slots = " · ".join(p["id"] for p in pz)
        cap_slots = " · ".join(f"{c['id']}[{c['role']}]" for c in cz)
        lines.append(f"- **{tid}**: {t['description']}")
        lines.append(f"    person_slots: [{person_slots}]")
        lines.append(f"    caption_slots: [{cap_slots}]")
    return "\n".join(lines)


def get(tid: str) -> dict[str, Any] | None:
    return TEMPLATES.get(tid)


def collect_all_slot_ids() -> tuple[list[str], list[str]]:
    """모든 template 의 zone id 수집 → Planner 스키마 properties 자동 생성용."""
    p_ids: set[str] = set(); c_ids: set[str] = set()
    for t in TEMPLATES.values():
        for z in t.get("person_zones", []) or []:
            p_ids.add(z["id"])
        for z in t.get("caption_zones", []) or []:
            c_ids.add(z["id"])
    return sorted(p_ids), sorted(c_ids)
