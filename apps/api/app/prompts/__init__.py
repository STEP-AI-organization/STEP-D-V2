"""Centralized LLM prompts and their response schemas.

All natural-language prompts sent to Gemini / OpenAI live in this package so they
are easy to find, review, and tweak in one place. Each module pairs a prompt
builder with the JSON response schema it expects back.
"""

from app.prompts.caption_detection import (
    CAPTION_DETECTION_SCHEMA,
    build_caption_detection_prompt,
)
from app.prompts.clip_evaluation import EVALUATION_SCHEMA, build_evaluation_prompt
from app.prompts.ppl_detection import PPL_DETECTION_SCHEMA, build_ppl_prompt
from app.prompts.title_options import TITLE_OPTION_SCHEMA, build_title_options_prompt
from app.prompts.transcription import TRANSCRIPTION_PROMPT

__all__ = [
    "EVALUATION_SCHEMA",
    "build_evaluation_prompt",
    "CAPTION_DETECTION_SCHEMA",
    "build_caption_detection_prompt",
    "PPL_DETECTION_SCHEMA",
    "build_ppl_prompt",
    "TITLE_OPTION_SCHEMA",
    "build_title_options_prompt",
    "TRANSCRIPTION_PROMPT",
]
