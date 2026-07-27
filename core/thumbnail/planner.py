"""Phase 1: Thumbnail Planner — AI가 '계획'만 JSON으로 출력.

입력: shorts_ctx, candidate_frames, program_info, cast_photos
출력: ThumbnailPlan JSON (배경/인물/자막/레이아웃 완전 명세)
AI는 '이미지 생성/합성' 도구 호출 안 함 · 계획만 세움.
"""

from __future__ import annotations

import json
import os
import pathlib
from typing import Any, Optional

from google import genai
from google.genai import types

from .presets import PRESETS, prompt_summary as presets_prompt_summary, get_preset

MODEL = "gemini-2.5-flash"
DEFAULT_LOCATION = "us-central1"

SYSTEM_INSTRUCTION = """너는 한국 방송사 편집팀의 썸네일 **기획자(Planner)**다.
입력(쇼츠 컨텍스트·후보 프레임·출연자 사진)을 보고, **최종 썸네일의 완전한 설계도(ThumbnailPlan JSON)**를 하나만 출력한다.
이미지 생성·합성 도구는 **없다**. 너의 일은 "어떤 배경, 어떤 인물, 어떤 자막, 어디에 배치"를 JSON으로 확정하는 것뿐.

──────────────────
[필수 포함 요소] (누락 시 계획 불완전 → 재시도)
1. **preset_id**: 아래 스타일 프리셋 중 하나 (프로그램 성격에 맞게 선택)
2. background: {mode: "frame_blur"|"ai_generate"|"gradient"|"solid", ...상세 파라미터}
3. person: {source: "frame"|"cast_photo", frame_id?, cast_name?, subject?, side, scale}
4. caption: {text, position, tone_tag, size_hint, font_role}
5. layout_hints: {person_side, caption_position, safe_zone_respected: true}
──────────────────

[배경 모드 선택 가이드]
- frame_blur: 가장 안전·빠름. 원본 프레임 블러 → 인물과 톤 일치. "원본 느낌 살리기" 좋음.
- ai_generate: 컨셉추얼한 배경 필요 시(감정·분위기 강조). 프롬프트에 **사람·텍스트 언급 금지**.
- gradient/solid: 브랜드 컬러·단색 강조 필요 시.

[인물 소스 선택 가이드]
- source="frame": 원본 프레임에서 rembg로 컷아웃. 실제 방송 화면 그대로 → 신뢰도 높음.
- source="cast_photo": castPhotos 폴더의 인물 사진 → Gemini로 썸네일용 포즈/조명 재생성(얼굴 identity 강제 유지) → rembg. 더 멋진 포즈/표정 가능.

[자막 톤 가이드]
- 인용: 실제 대사 발췌 ("제가 결혼할래요?")
- 훅: 궁금증 유발 ("이게 진짜 된다고?")
- 의문: 시청자 질문 던지기 ("너라면 어떡해?")
- 충격: 반전·놀람 ("사실은... 그는")
- 기본: 상황 요약 ("첫 만남의 순간")

[레이아웃 규칙]
- 인물 좌측 → 자막 우측 (반대도 가능)
- 자막은 안전영역(60px 마진) 내에, 인물 얼굴 bbox와 IoU < 0.1
- 폰트: 예능=굴림/검정 계열(variety), 드라마=명조(drama), 뉴스=고딕(news)

[출력 형식] **오직 JSON 하나만** 출력. 마크다운 코드블록 금지. 설명 텍스트 금지.
```json
{
  "background": {"mode": "frame_blur", "frame_id": "shot_0042", "blur_px": 24},
  "person": {"source": "frame", "frame_id": "shot_0042", "subject": "largest_face", "side": "left", "scale": 0.9},
  "caption": {"text": "제가\n결혼할래요?", "position": "right", "tone_tag": "인용", "size_hint": "XL", "font_role": "variety"},
  "layout_hints": {"person_side": "left", "caption_position": "right", "safe_zone_respected": true}
}
```"""


def build_planner_prompt(
    shorts_ctx: dict,
    candidate_frames: list[dict],
    program_info: dict,
    cast_photos: list[str],
) -> str:
    """Planner에게 줄 첫 user 프롬프트 구성."""
    frames_summary = []
    for f in candidate_frames[:8]:
        faces = f.get("faces", [])
        largest = max(
            (f2.get("bbox", [0, 0, 0, 0]) for f2 in faces),
            key=lambda b: (b[2] - b[0]) * (b[3] - b[1]),
            default=None,
        )
        frames_summary.append({
            "id": f["id"],
            "size": f["size"],
            "has_face": f["has_face"],
            "largest_face_ratio": f.get("largest_face_area_ratio", 0),
            "face_count": len(faces),
        })

    cast_list = ", ".join(cast_photos) if cast_photos else "없음"
    prog = program_info or {}

    return (
        f"[쇼츠 정보]\n"
        f"  제목: {shorts_ctx.get('title', '')}\n"
        f"  설명: {shorts_ctx.get('description', '')}\n"
        f"  출연자: {', '.join(shorts_ctx.get('cast_names', [])) or '미상'}\n\n"
        f"[프로그램]\n"
        f"  제목: {prog.get('title', '')}\n"
        f"  코너: {prog.get('section', '')}\n"
        f"  분위기: {prog.get('mood', '')}\n"
        f"  시놉시스: {(prog.get('synopsis', '') or '')[:300]}\n\n"
        f"[후보 프레임 Top-{len(frames_summary)}]\n"
        f"{json.dumps(frames_summary, ensure_ascii=False, indent=2)}\n\n"
        f"[사용 가능 캐스트 사진]\n"
        f"{cast_list}\n\n"
        f"{presets_prompt_summary()}\n\n"
        "위 정보를 종합해 **최적의 스타일 프리셋을 선택**하고 (preset_id) "
        "그 프리셋 톤에 맞는 **ThumbnailPlan JSON**을 하나만 출력하라. "
        "프리셋의 font_role·tone·position은 그대로 따르되 · text 는 쇼츠 컨텍스트에 맞게 새로 작성. "
        "출력은 JSON만. 마크다운/설명 금지."
    )


# ── JSON 스키마 (function calling이 아닌 구조화 출력용) ──────────────
THUMBNAIL_PLAN_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "preset_id": {
            "type": "STRING",
            "enum": list(PRESETS.keys()),
            "description": "스타일 프리셋 선택 (broadcast_official/magazine/reaction/music_show/news/documentary)",
        },
        "background": {
            "type": "OBJECT",
            "properties": {
                "mode": {"type": "STRING", "enum": ["frame_blur", "ai_generate", "gradient", "solid"]},
                "frame_id": {"type": "STRING"},
                "blur_px": {"type": "INTEGER", "minimum": 0, "maximum": 100},
                "prompt": {"type": "STRING"},
                "style": {"type": "STRING", "enum": ["cinematic", "illustration", "photo", "abstract"]},
                "palette_hint": {"type": "ARRAY", "items": {"type": "STRING"}},
                "colors": {"type": "ARRAY", "items": {"type": "STRING"}},
                "angle": {"type": "INTEGER"},
                "color": {"type": "STRING"},
            },
            "required": ["mode"],
        },
        "person": {
            "type": "OBJECT",
            "properties": {
                "source": {"type": "STRING", "enum": ["frame", "cast_photo"]},
                "frame_id": {"type": "STRING"},
                "cast_name": {"type": "STRING"},
                "subject": {"type": "STRING"},
                "side": {"type": "STRING", "enum": ["left", "right", "center"]},
                "scale": {"type": "NUMBER", "minimum": 0.5, "maximum": 1.5},
                "style_prompt": {"type": "STRING"},
            },
            "required": ["source", "side", "scale"],
        },
        "caption": {
            "type": "OBJECT",
            "properties": {
                "text": {"type": "STRING"},
                "position": {"type": "STRING", "enum": ["top", "middle", "bottom", "auto"]},
                "tone_tag": {"type": "STRING", "enum": ["인용", "훅", "의문", "충격", "기본"]},
                "size_hint": {"type": "STRING", "enum": ["XL", "L", "M"]},
                "font_role": {"type": "STRING", "enum": ["variety", "drama", "news", "documentary"]},
                "text_color": {"type": "STRING"},
                "outline_color": {"type": "STRING"},
            },
            "required": ["text", "position", "tone_tag", "size_hint", "font_role"],
        },
        "layout_hints": {
            "type": "OBJECT",
            "properties": {
                "person_side": {"type": "STRING", "enum": ["left", "right", "center"]},
                "caption_position": {"type": "STRING", "enum": ["top", "middle", "bottom", "left", "right", "auto"]},
                "safe_zone_respected": {"type": "BOOLEAN"},
            },
        },
    },
    "required": ["preset_id", "background", "person", "caption", "layout_hints"],
}


def generate_plan(
    media_dir: pathlib.Path,
    variant_id: str = "v1",
    shorts_context: dict | None = None,
    project: str | None = None,
    location: str = DEFAULT_LOCATION,
) -> dict:
    """Planner 단일 호출 → ThumbnailPlan dict 반환."""
    project = project or os.environ.get("GOOGLE_CLOUD_PROJECT", "step-d")

    # 컨텍스트 로드
    shorts_path = media_dir / "shorts_context.json"
    if shorts_context is not None:
        shorts_ctx = shorts_context
    elif shorts_path.exists():
        shorts_ctx = json.loads(shorts_path.read_text(encoding="utf-8"))
    else:
        # workdir에서 최소 컨텍스트 구성
        pc = media_dir / "program_context.json"
        if pc.exists():
            prog = json.loads(pc.read_text(encoding="utf-8"))
            shorts_ctx = {
                "program": prog,
                "cast_names": prog.get("cast", []),
                "title": prog.get("title", "쇼츠"),
                "description": "",
            }
        else:
            shorts_ctx = {"title": "쇼츠", "description": "", "cast_names": []}

    # 후보 프레임 로드 (tools.list_candidate_frames와 같은 로직)
    shot_dir = media_dir / "shot_frames"
    faces_path = media_dir / "faces.json"
    faces_data = json.loads(faces_path.read_text(encoding="utf-8")) if faces_path.exists() else {}
    face_by_frame = _index_faces_by_frame(faces_data)

    candidate_frames = []
    if shot_dir.exists():
        for p in sorted(shot_dir.glob("shot_*.jpg")):
            try:
                from PIL import Image
                with Image.open(p) as im:
                    w, h = im.size
            except Exception:
                continue
            faces = face_by_frame.get(p.name, [])
            largest = max(
                (f.get("bbox", [0, 0, 0, 0]) for f in faces),
                key=lambda b: (b[2] - b[0]) * (b[3] - b[1]),
                default=None,
            )
            largest_area_ratio = 0.0
            if largest:
                fw, fh = largest[2] - largest[0], largest[3] - largest[1]
                largest_area_ratio = (fw * fh) / max(1, w * h)
            candidate_frames.append({
                "id": p.stem,
                "path": str(p),
                "size": [w, h],
                "faces": faces,
                "largest_face_area_ratio": round(largest_area_ratio, 4),
                "has_face": bool(faces),
            })

    # 얼굴 큰 순 정렬
    candidate_frames.sort(key=lambda f: -f["largest_face_area_ratio"])

    # 캐스트 사진 목록
    cast_photos_dir = media_dir / "cast_photos"
    cast_photos = [p.stem for p in cast_photos_dir.glob("*")] if cast_photos_dir.exists() else []

    # 프로그램 정보
    program_info = shorts_ctx.get("program", {})

    # 프롬프트 구성
    user_prompt = build_planner_prompt(shorts_ctx, candidate_frames, program_info, cast_photos)

    # Vertex Gemini 호출 (structured output)
    client = genai.Client(vertexai=True, project=project, location=location)
    cfg = types.GenerateContentConfig(
        system_instruction=SYSTEM_INSTRUCTION,
        response_mime_type="application/json",
        response_schema=THUMBNAIL_PLAN_SCHEMA,
        temperature=1.0,
        max_output_tokens=4096,
    )
    resp = client.models.generate_content(
        model=MODEL,
        contents=[types.Content(role="user", parts=[types.Part.from_text(text=user_prompt)])],
        config=cfg,
    )

    if not resp.text:
        raise RuntimeError("Planner returned empty response")

    plan = json.loads(resp.text)

    # 계획 저장 (디버깅/재현용)
    out_dir = media_dir / "thumbnails" / variant_id
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")

    return plan


def _index_faces_by_frame(faces_data: Any) -> dict[str, list[dict]]:
    """faces.json 다양한 구조 → frame 파일명 기준 인덱스."""
    idx: dict[str, list[dict]] = {}
    if isinstance(faces_data, dict):
        for det in faces_data.get("detections", []) or []:
            fname = det.get("frame") or det.get("file") or det.get("path", "")
            if isinstance(fname, str):
                fname = pathlib.Path(fname).name
            if not fname:
                continue
            idx.setdefault(fname, []).append({
                "bbox": det.get("bbox") or det.get("xyxy") or [0, 0, 0, 0],
                "name": det.get("name") or det.get("label"),
                "cluster": det.get("cluster") or det.get("cluster_id"),
            })
    return idx


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python -m core.thumbnail.planner <media_dir> [variant_id]")
        sys.exit(1)
    media_dir = pathlib.Path(sys.argv[1])
    variant_id = sys.argv[2] if len(sys.argv) > 2 else "v1"
    plan = generate_plan(media_dir, variant_id)
    print(json.dumps(plan, ensure_ascii=False, indent=2))