"""STEP D · Gemini 모델 이름 중앙 관리 (single source of truth).

이후 모델 업그레이드 시 이 파일 한 곳만 수정하면 모든 core/ 모듈이 자동 반영된다.
개별 stage 오버라이드는 각자 env var 로 (예: refine 만 다른 모델 쓰고 싶으면 GEMINI_REFINE_MODEL).

사용:
    from core.models import TEXT
    resp = client.models.generate_content(model=TEXT, ...)

또는 backward-compat:
    from core.models import TEXT as MODEL
"""
from __future__ import annotations

import os

# ────────────────────────────────────────────────────────────
# Default 텍스트/추론 모델 · 모든 stage 의 기본값.
# ENV: GEMINI_MODEL 로 전역 오버라이드 가능.
# ────────────────────────────────────────────────────────────
TEXT: str = os.environ.get("GEMINI_MODEL") or "gemini-3.1-flash"

# ────────────────────────────────────────────────────────────
# Stage 별 오버라이드 (없으면 TEXT 재사용).
# 각각 개별 env var 로 세밀 튜닝 가능.
# ────────────────────────────────────────────────────────────
STT: str = os.environ.get("GEMINI_STT_MODEL") or TEXT
REFINE: str = os.environ.get("GEMINI_REFINE_MODEL") or TEXT
NARRATIVE: str = os.environ.get("GEMINI_NARRATIVE_MODEL") or TEXT
BEATS: str = os.environ.get("GEMINI_BEATS_MODEL") or TEXT
RECOMMEND: str = os.environ.get("GEMINI_RECOMMEND_MODEL") or TEXT
TIMELINE: str = os.environ.get("GEMINI_TIMELINE_MODEL") or TEXT
SCENE_TYPE: str = os.environ.get("GEMINI_SCENE_TYPE_MODEL") or TEXT
SEGMENT: str = os.environ.get("SEGMENT_MODEL") or TEXT
NAMES: str = os.environ.get("GEMINI_NAMES_MODEL") or TEXT
FACES: str = os.environ.get("GEMINI_FACES_MODEL") or TEXT
PPL: str = os.environ.get("GEMINI_PPL_MODEL") or TEXT
VISION: str = os.environ.get("GEMINI_VISION_MODEL") or TEXT
AUTOFILL: str = os.environ.get("GEMINI_AUTOFILL_MODEL") or TEXT
LEARN_PROFILE: str = os.environ.get("GEMINI_LEARN_PROFILE_MODEL") or TEXT
COMMENT_SIGNAL: str = os.environ.get("GEMINI_COMMENT_SIGNAL_MODEL") or TEXT
EVAL_TOPIC: str = os.environ.get("GEMINI_EVAL_TOPIC_MODEL") or TEXT
PORTRAITS: str = os.environ.get("GEMINI_PORTRAITS_MODEL") or TEXT

# ────────────────────────────────────────────────────────────
# Image 생성 모델 · thumbnail 파이프라인 · 별도 라인.
# FLASH 는 빠르고 저렴 · PRO 는 고품질 (템플릿 사전 가공 등에 사용).
# ────────────────────────────────────────────────────────────
IMAGE_FLASH: str = os.environ.get("GEMINI_IMAGE_MODEL") or "gemini-3.1-flash-image"
IMAGE_PRO: str = os.environ.get("GEMINI_IMAGE_PRO_MODEL") or "gemini-3-pro-image"
