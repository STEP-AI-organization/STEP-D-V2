"""assets/thumbnail-reference/ 의 모든 이미지를 Gemini Vision 으로 분석 · manifest.json 생성.

각 reference:
  id · path · person_count · mood · genre · style_tags · dominant_colors · caption_style · description

Planner 가 shorts 특성 (화자 수·감정 톤) 과 매칭해서 template 선택.
새 template 추가 후 재실행 · manifest 갱신.
"""
from __future__ import annotations

import json
import os
import pathlib
import sys

from google import genai
from google.genai import types

REF_DIR = pathlib.Path(__file__).resolve().parents[1] / "assets" / "thumbnail-reference"
MANIFEST = REF_DIR / "manifest.json"
try:
    from core.common.models import TEXT as MODEL
except ImportError:
    MODEL = "gemini-3.1-flash"
LOCATION = "asia-northeast3"

SYSTEM = """너는 한국 방송사 유튜브 썸네일 큐레이터다.
주어진 썸네일 이미지 하나를 정밀 분석해 구조화된 메타데이터를 뽑는다.
관찰 가능한 사실만 기술 · 추측·평가 X.
"""

SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "person_count": {"type": "INTEGER", "description": "이미지 안 주요 인물 수 (얼굴이 클로즈업으로 명확 · 배경 원경 제외)"},
        "genre_hint": {"type": "STRING", "description": "관찰된 장르 (예: 리얼리티 연애·예능 리액션·다큐 인터뷰)"},
        "mood": {"type": "STRING", "enum": ["긴장", "감정", "충격", "웃음", "일상", "질문", "폭로"],
                 "description": "지배적 감정 톤"},
        "composition": {"type": "STRING", "enum": [
            "single_closeup", "two_person_split", "three_person_row", "four_person_row",
            "reaction_plus_cause", "quote_hero", "other"],
            "description": "구도 카테고리"},
        "style_tags": {"type": "ARRAY", "items": {"type": "STRING"},
                       "description": "스타일 키워드 (예: 밝은톤·다크·비비드·미니멀·decorated)"},
        "dominant_colors": {"type": "ARRAY", "items": {"type": "STRING"},
                            "description": "지배적 색 3개 (핵스 or 이름)"},
        "caption_style": {"type": "STRING", "description": "자막 계층 요약 (예: 하단 청록 pill + 상단 인용 손글씨)"},
        "description": {"type": "STRING", "description": "한 문장 요약 (Planner 가 shorts 매칭에 사용)"},
    },
    "required": ["person_count", "mood", "composition", "description"],
}
# 사용자 수동 태그 (Vision 이 자동 채우지 않는 · 나중에 UI/CLI 로 편집)
# - program: 프로그램 id (예: "환승연애4") · 비었으면 global
# - custom_tags: 사용자 태그 배열


def _client(project: str | None = None) -> genai.Client:
    return genai.Client(vertexai=True,
                         project=project or os.environ.get("GOOGLE_CLOUD_PROJECT", "step-d"),
                         location=LOCATION)


def analyze_one(img_path: pathlib.Path, project: str | None = None) -> dict | None:
    client = _client(project)
    parts = [
        types.Part.from_bytes(data=img_path.read_bytes(),
                              mime_type=f"image/{img_path.suffix[1:].lower()}"),
        types.Part.from_text(text="이 썸네일 메타데이터를 스키마대로 뽑아라."),
    ]
    resp = client.models.generate_content(
        model=MODEL, contents=parts,
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM,
            response_mime_type="application/json",
            response_schema=SCHEMA,
            temperature=0.3,
            max_output_tokens=2048,
        ),
    )
    if not resp.text:
        return None
    try:
        return json.loads(resp.text)
    except Exception:
        return None


def main() -> int:
    if not REF_DIR.exists():
        print(f"[FAIL] {REF_DIR} 없음", file=sys.stderr); return 1

    # 기존 manifest 로드 (이미 분석된 것은 skip 옵션)
    existing = {}
    if MANIFEST.exists():
        try:
            for r in json.loads(MANIFEST.read_text(encoding="utf-8")):
                existing[r["id"]] = r
        except Exception:
            existing = {}

    force = "--force" in sys.argv
    updated: list[dict] = []
    for p in sorted(REF_DIR.iterdir()):
        if p.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
            continue
        rid = p.stem
        if not force and rid in existing and existing[rid].get("_analyzed"):
            updated.append(existing[rid])
            print(f"[skip] {rid} · 기존 유지 (--force 로 재분석)")
            continue
        print(f"[analyze] {rid} ...", end=" ", flush=True)
        meta = analyze_one(p)
        if not meta:
            print("FAIL")
            updated.append({"id": rid, "path": str(p.relative_to(REF_DIR.parent)),
                            "_analyzed": False, "error": "vision_empty"})
            continue
        # 기존 사용자 태그 (program·custom_tags) 는 유지
        preserved = {}
        if rid in existing:
            for k in ("program", "custom_tags", "user_note"):
                if existing[rid].get(k) is not None:
                    preserved[k] = existing[rid][k]
        entry = {"id": rid, "path": str(p.relative_to(REF_DIR.parent)),
                 "_analyzed": True, **meta, **preserved}
        updated.append(entry)
        print(f"OK · {meta.get('composition')} · {meta.get('person_count')}인 · {meta.get('mood')}")

    MANIFEST.write_text(json.dumps(updated, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[ok] manifest → {MANIFEST} · {len(updated)} entries")
    return 0


if __name__ == "__main__":
    sys.exit(main())
