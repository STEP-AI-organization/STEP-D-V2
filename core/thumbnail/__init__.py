"""썸네일 엔진 (docs/plans/thumbnail-engine-plan.md).
Layer Canvas + Photoshop-MCP 도구 API + Vertex Gemini function calling.

이 패키지가 노출하는 진입점:
  - core.thumbnail.__main__ 로 CLI (media-dir 하나 주면 스모크 실행)
  - core.thumbnail.ai_session.run_session(context) 로 프로그램적 호출 (3-phase: Planner→Generator→Compositor)

Phase 분리:
  - Phase 1 Planner (AI): core.thumbnail.planner.generate_plan()
  - Phase 2 Generator (System): core.thumbnail.generator.generate_all_layers()
  - Phase 3 Compositor (System): core.thumbnail.compositor.compose_thumbnail()
"""
from .canvas import Document, Layer, LayerRole
from .contrast import wcag_contrast, ensure_min_contrast
from .ai_session import run_session, run_multi_variant

__all__ = [
    "Document", "Layer", "LayerRole",
    "wcag_contrast", "ensure_min_contrast",
    "run_session", "run_multi_variant",
]
