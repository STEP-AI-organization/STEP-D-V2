"""Prompt + response schema for PPL (product placement) brand/product detection.

Given an ordered list of frames sampled from a rendered Short, Gemini returns,
per frame, the consumer products / brand logos it can identify together with a
2D bounding box. Boxes follow Gemini's convention: ``[ymin, xmin, ymax, xmax]``
normalized to 0-1000, relative to the frame the detection belongs to.
"""

from __future__ import annotations

from typing import Any


PPL_DETECTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "frames": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "frame_index": {"type": "integer", "minimum": 0},
                    "detections": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "brand": {"type": "string"},
                                "product": {"type": "string"},
                                "category": {"type": "string"},
                                "box": {
                                    "type": "array",
                                    "items": {"type": "integer"},
                                    "minItems": 4,
                                    "maxItems": 4,
                                },
                                "confidence": {"type": "number"},
                            },
                            "required": ["brand", "product", "category", "box", "confidence"],
                        },
                    },
                },
                "required": ["frame_index", "detections"],
            },
        }
    },
    "required": ["frames"],
}


def build_ppl_prompt(frame_times: list[float]) -> str:
    """Build the detection prompt. ``frame_times`` are the clip-relative seconds
    of each frame, in the same order the images are attached."""
    frame_lines = "\n".join(
        f"- Frame {index}: t = {seconds:.2f}s into the clip"
        for index, seconds in enumerate(frame_times)
    )
    return f"""
You are a product-placement (PPL) analyst for a short-form video. You receive
{len(frame_times)} frames sampled in order from ONE vertical Short. Return JSON only.

Frames (attached in this exact order):
{frame_lines}

For EACH frame, detect every clearly identifiable commercial product or brand
that is visible in the image — drinks, snacks, electronics, phones, cars,
clothing/shoes with a visible logo, cosmetics, packaged goods, restaurant/cafe
branding, etc.

For each detection return:
- brand: the brand/company name if recognizable (e.g. "코카콜라", "삼성", "나이키").
  Use "노브랜드" only when it is clearly a product but no brand is identifiable.
- product: what the item is (e.g. "콜라", "스마트폰", "운동화"). Korean if natural.
- category: a short category (예: 음료, 전자기기, 의류, 화장품, 식품, 자동차).
- box: bounding box as [ymin, xmin, ymax, xmax], integers normalized 0-1000,
  relative to THAT frame (0,0 is top-left, 1000,1000 is bottom-right).
- confidence: 0.0 to 1.0 — how sure you are about the brand/product identity.

Rules:
- Return one entry per input frame, with the matching frame_index, even if its
  detections array is empty.
- Do NOT report channel logos, app UI, burned-in captions/titles, watermarks,
  generic unbranded background objects, people, or scenery.
- Be conservative: if you cannot tell the brand, lower the confidence rather than
  guessing a famous brand. Only include real, on-screen products.
"""
