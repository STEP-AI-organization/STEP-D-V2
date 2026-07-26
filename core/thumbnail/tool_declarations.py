"""Vertex Gemini function calling 을 위한 도구 declarations (§12.2).

각 도구는 tools.py 의 함수 이름과 1:1 매칭. AI 가 이 스키마 보고 호출 · ai_session 이
디스패치.
"""
from __future__ import annotations
from google.genai import types


def build_tool() -> types.Tool:
    decls: list[types.FunctionDeclaration] = [
        # ── Discovery ─────────────────────────────────────────
        types.FunctionDeclaration(
            name="get_shorts_context",
            description="쇼츠 제목·설명·장면 요약·출연자·프로그램 정보 반환.",
            parameters={"type": "OBJECT", "properties": {}},
        ),
        types.FunctionDeclaration(
            name="list_candidate_frames",
            description="후보 프레임 리스트 (scene_frames + faces bbox · 얼굴 큰 순).",
            parameters={
                "type": "OBJECT",
                "properties": {
                    "top_k": {"type": "INTEGER", "description": "기본 5"},
                },
            },
        ),
        types.FunctionDeclaration(
            name="inspect_frame",
            description="특정 프레임의 도미넌트 컬러·밝기·얼굴 상세.",
            parameters={
                "type": "OBJECT",
                "required": ["frame_id"],
                "properties": {"frame_id": {"type": "STRING"}},
            },
        ),

        # ── Document ──────────────────────────────────────────
        types.FunctionDeclaration(
            name="create_document",
            description="레이어 캔버스 초기화 (Layer 0~5 예약).",
            parameters={
                "type": "OBJECT",
                "required": ["aspect"],
                "properties": {
                    "aspect": {"type": "STRING", "enum": ["16:9", "9:16", "1:1"]},
                },
            },
        ),
        types.FunctionDeclaration(
            name="list_layers",
            description="현재 문서의 레이어 상태.",
            parameters={"type": "OBJECT", "properties": {}},
        ),
        types.FunctionDeclaration(
            name="clear_layer",
            description="특정 레이어의 소스 제거.",
            parameters={
                "type": "OBJECT",
                "required": ["role"],
                "properties": {"role": {"type": "STRING",
                    "enum": ["background", "backfx", "person", "personfx", "caption", "frontfx"]}},
            },
        ),

        # ── Layer 0 · Background (Phase 1 = blur 만) ─────────
        types.FunctionDeclaration(
            name="set_background_from_frame",
            description="선택한 프레임을 캔버스에 cover-fit · Gaussian blur 배경.",
            parameters={
                "type": "OBJECT",
                "required": ["frame_id"],
                "properties": {
                    "frame_id": {"type": "STRING"},
                    "filter": {"type": "STRING", "enum": ["blur", "none"]},
                    "blur_px": {"type": "INTEGER", "description": "기본 24"},
                },
            },
        ),

        # ── Layer 2 · Person ─────────────────────────────────
        types.FunctionDeclaration(
            name="set_person_from_frame",
            description="프레임 → 얼굴 bbox crop → rembg alpha → 캔버스 배치.",
            parameters={
                "type": "OBJECT",
                "required": ["frame_id", "subject", "side"],
                "properties": {
                    "frame_id": {"type": "STRING"},
                    "subject": {"type": "STRING",
                        "description": "'largest_face' | 'name:XXX' | 'bbox:x1,y1,x2,y2'"},
                    "side": {"type": "STRING", "enum": ["left", "right", "center"]},
                    "scale": {"type": "NUMBER", "description": "0.5~1.2, 기본 0.9"},
                },
            },
        ),

        # ── Layer 4 · Caption ────────────────────────────────
        types.FunctionDeclaration(
            name="add_caption",
            description="메인 자막. 자동 개행·폰트·WCAG 대비 보정은 시스템 자동.",
            parameters={
                "type": "OBJECT",
                "required": ["text", "position", "tone_tag"],
                "properties": {
                    "text": {"type": "STRING"},
                    "position": {"type": "STRING",
                        "enum": ["top", "middle", "bottom", "auto"]},
                    "text_color": {"type": "STRING", "description": "hex, 기본 #ffffff"},
                    "outline_color": {"type": "STRING", "description": "hex, 기본 #000000"},
                    "size_hint": {"type": "STRING", "enum": ["XL", "L", "M"]},
                    "font_role": {"type": "STRING",
                        "enum": ["variety", "drama", "news", "documentary"]},
                    "tone_tag": {"type": "STRING",
                        "enum": ["인용", "훅", "의문", "충격", "기본"]},
                },
            },
        ),

        # ── Coordinate helpers ──────────────────────────────
        types.FunctionDeclaration(
            name="get_canvas_info",
            description="캔버스 크기·안전 영역·현재 레이어 실 bbox.",
            parameters={"type": "OBJECT", "properties": {}},
        ),
        types.FunctionDeclaration(
            name="suggest_caption_position",
            description="자막 텍스트·인물 bbox·safe zone 감안 자동 위치 제안.",
            parameters={
                "type": "OBJECT",
                "required": ["text", "size_hint"],
                "properties": {
                    "text": {"type": "STRING"},
                    "size_hint": {"type": "STRING", "enum": ["XL", "L", "M"]},
                    "prefer": {"type": "STRING",
                        "enum": ["opposite_person", "top", "bottom", "auto"]},
                },
            },
        ),
        types.FunctionDeclaration(
            name="check_overlap",
            description="두 레이어(또는 'bbox:x1,y1,x2,y2')의 IoU · safe zone 침범.",
            parameters={
                "type": "OBJECT",
                "required": ["a", "b"],
                "properties": {
                    "a": {"type": "STRING"},
                    "b": {"type": "STRING"},
                },
            },
        ),

        # ── Reflection / Control ────────────────────────────
        types.FunctionDeclaration(
            name="render_preview",
            description="현재 조합된 미리보기 (720px 축소 · PNG base64) + 레이어 bbox + 충돌 warning.",
            parameters={"type": "OBJECT", "properties": {}},
        ),
        types.FunctionDeclaration(
            name="undo_last",
            description="마지막 레이어 변경 되돌리기.",
            parameters={"type": "OBJECT", "properties": {}},
        ),
        types.FunctionDeclaration(
            name="export_thumbnail",
            description="세션 종료 · 최종 composite · 파일 저장.",
            parameters={"type": "OBJECT", "properties": {}},
        ),
    ]
    return types.Tool(function_declarations=decls)
