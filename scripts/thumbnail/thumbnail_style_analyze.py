"""참고 썸네일 이미지들을 Gemini Vision 으로 분석 · 스타일 프로파일 md 생성.

입력: assets/thumbnail-reference/*.png (사용자 큐레이션)
출력: assets/thumbnail-reference/style_profile.md · style_profile.json

Planner 는 이 프로파일을 프롬프트에 텍스트 블록으로 심어서 톤 학습.
"""
from __future__ import annotations

import json
import os
import pathlib
import sys

from google import genai
from google.genai import types

try:
    from core.common.models import TEXT as MODEL
except ImportError:
    MODEL = "gemini-3.1-flash"
LOCATION = "asia-northeast3"

REF_DIR = pathlib.Path(__file__).resolve().parents[1] / "assets" / "thumbnail-reference"

SYSTEM = """너는 한국 방송사 유튜브 썸네일 아트디렉터다.
아래 첨부된 참고 썸네일 이미지들을 정밀 분석해서, 이 채널/프로그램의 시각 스타일 프로파일을
구조화된 JSON 으로 출력한다.

이 프로파일은 다른 AI (썸네일 기획자) 가 참고해서 같은 톤의 계획을 짜는 데 사용된다.
관찰 가능한 사실만 기술 · 추측·평가·미사여구 X.
"""

SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "program_identity": {
            "type": "OBJECT",
            "description": "프로그램 정체성 시각 신호",
            "properties": {
                "genre_hint": {"type": "STRING", "description": "관찰된 장르 (예: 리얼리티 연애·예능 리액션)"},
                "logo_placement": {"type": "STRING", "description": "채널/프로그램 로고 위치"},
                "logo_style": {"type": "STRING"},
            },
        },
        "composition": {
            "type": "OBJECT",
            "description": "구도 · 레이아웃",
            "properties": {
                "primary_layout": {"type": "STRING", "description": "지배적 구도 (예: 좌우 이등분·중앙 단일·삼각)"},
                "person_placement": {"type": "STRING"},
                "person_count_typical": {"type": "STRING", "description": "1~4명 등"},
                "face_size_ratio": {"type": "STRING", "description": "얼굴이 화면에서 차지하는 크기"},
                "background_treatment": {"type": "STRING", "description": "배경 처리 방식 (blur/gradient/실컷 유지 등)"},
            },
        },
        "emotion_and_contrast": {
            "type": "OBJECT",
            "description": "감정 시각화 · 대비 방식",
            "properties": {
                "expression_style": {"type": "STRING", "description": "표정 (놀람·웃음·긴장 등)"},
                "contrast_method": {"type": "STRING", "description": "감정 대비 방식 (예: 좌우 톤 대비·명암·채도)"},
                "color_palette": {"type": "ARRAY", "items": {"type": "STRING"}, "description": "지배적 색"},
            },
        },
        "caption_system": {
            "type": "OBJECT",
            "description": "자막 계층 · 톤",
            "properties": {
                "hierarchy": {"type": "ARRAY", "items": {"type": "STRING"},
                              "description": "관찰된 자막 계층 (예: 배지→인용→부제→메인)"},
                "main_caption_style": {"type": "STRING", "description": "메인 카피 스타일 (색·굵기·정렬·위치)"},
                "quote_style": {"type": "STRING", "description": "인용문 스타일"},
                "badge_style": {"type": "STRING", "description": "배지·라벨 스타일 (색·형태)"},
                "typical_tone": {"type": "STRING", "description": "자막 어조 (사건 명시/궁금증/인용 등)"},
                "font_hint": {"type": "STRING"},
            },
        },
        "planner_directives": {
            "type": "ARRAY",
            "items": {"type": "STRING"},
            "description": "다른 AI(기획자)에게 줄 실전 지시 5~10개 (구체 지시문). "
                           "예: '자막은 하단 좌측 정렬 · 부제 회색 얇게 위 · 메인 굵은 검정 아래'",
        },
    },
    "required": ["program_identity", "composition", "emotion_and_contrast",
                 "caption_system", "planner_directives"],
}


def analyze() -> dict:
    project = os.environ.get("GOOGLE_CLOUD_PROJECT", "step-d")
    client = genai.Client(vertexai=True, project=project, location=LOCATION)

    refs = sorted(REF_DIR.glob("*.png")) + sorted(REF_DIR.glob("*.jpg"))
    if not refs:
        print(f"[FAIL] no reference images in {REF_DIR}", file=sys.stderr)
        sys.exit(1)
    print(f"[analyze] {len(refs)}개 참고 이미지: {[p.name for p in refs]}")

    parts: list = []
    for r in refs:
        parts.append(types.Part.from_bytes(data=r.read_bytes(), mime_type="image/png"))
    parts.append(types.Part.from_text(text=(
        f"위 {len(refs)}장 썸네일들의 공통 스타일 프로파일을 스키마대로 뽑아라."
    )))

    resp = client.models.generate_content(
        model=MODEL,
        contents=parts,
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM,
            response_mime_type="application/json",
            response_schema=SCHEMA,
            temperature=0.3,
            max_output_tokens=4096,
        ),
    )
    if not resp.text:
        print("[FAIL] empty resp", file=sys.stderr); sys.exit(2)
    return json.loads(resp.text)


def to_markdown(prof: dict) -> str:
    lines = ["# 썸네일 스타일 프로파일 (참고 이미지 기반)\n"]
    lines.append("> AI 분석 자동 생성 · Planner 프롬프트 주입용\n")

    pi = prof.get("program_identity", {})
    lines.append("## 프로그램 정체성")
    lines.append(f"- 장르: {pi.get('genre_hint', '')}")
    lines.append(f"- 로고 위치: {pi.get('logo_placement', '')}")
    lines.append(f"- 로고 스타일: {pi.get('logo_style', '')}\n")

    co = prof.get("composition", {})
    lines.append("## 구도")
    lines.append(f"- 지배적 레이아웃: {co.get('primary_layout', '')}")
    lines.append(f"- 인물 배치: {co.get('person_placement', '')}")
    lines.append(f"- 인물 수: {co.get('person_count_typical', '')}")
    lines.append(f"- 얼굴 크기: {co.get('face_size_ratio', '')}")
    lines.append(f"- 배경: {co.get('background_treatment', '')}\n")

    ec = prof.get("emotion_and_contrast", {})
    lines.append("## 감정 · 대비")
    lines.append(f"- 표정: {ec.get('expression_style', '')}")
    lines.append(f"- 대비 방식: {ec.get('contrast_method', '')}")
    lines.append(f"- 색: {', '.join(ec.get('color_palette', []))}\n")

    cs = prof.get("caption_system", {})
    lines.append("## 자막 계층")
    for h in cs.get("hierarchy", []) or []:
        lines.append(f"- {h}")
    lines.append(f"\n- 메인 카피: {cs.get('main_caption_style', '')}")
    lines.append(f"- 인용문: {cs.get('quote_style', '')}")
    lines.append(f"- 배지: {cs.get('badge_style', '')}")
    lines.append(f"- 어조: {cs.get('typical_tone', '')}")
    lines.append(f"- 폰트: {cs.get('font_hint', '')}\n")

    lines.append("## Planner 실전 지시")
    for i, d in enumerate(prof.get("planner_directives", []) or [], 1):
        lines.append(f"{i}. {d}")
    return "\n".join(lines)


if __name__ == "__main__":
    prof = analyze()
    (REF_DIR / "style_profile.json").write_text(
        json.dumps(prof, ensure_ascii=False, indent=2), encoding="utf-8")
    md = to_markdown(prof)
    (REF_DIR / "style_profile.md").write_text(md, encoding="utf-8")
    print("\n=== 저장 완료 ===")
    print(f"  {REF_DIR / 'style_profile.json'}")
    print(f"  {REF_DIR / 'style_profile.md'}")
    print("\n--- 프로파일 요약 ---")
    print(md[:1500])
