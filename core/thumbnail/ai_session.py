"""Vertex Gemini function calling multi-turn 오케스트레이션 (§2.4, §12).

시스템 프롬프트 · turn 한도 12 · 각 turn 마다 시스템이 함수 실행 → tool response → AI 다음 turn.
"""
from __future__ import annotations

import base64
import json
import os
import pathlib
import time
from typing import Any, Callable

from google import genai
from google.genai import types

from . import tools as T
from .tool_declarations import build_tool

MODEL_TEXT = "gemini-2.5-flash"                 # function calling · Vision (asia-northeast3 지원)
MODEL_IMAGE = "gemini-2.5-flash-image"          # 배경 이미지 생성 (us-central1 만)
DEFAULT_LOCATION = "us-central1"                # 이미지 모델 접근성 · text 도 여기서 문제 X
MAX_TURNS = 12

SYSTEM_INSTRUCTION = """너는 한국 방송사 편집팀의 썸네일 디자이너다. 아래 도구를 순차 호출해서
"이 쇼츠가 클릭될 만한 썸네일" 하나를 조립한다.

권장 순서 (참고 · 필수 아님):
  1) get_shorts_context() 로 무슨 쇼츠인지 파악
  2) list_candidate_frames() + inspect_frame() 로 프레임 골라
  3) create_document(aspect="16:9")
  4) set_background_from_frame(frame_id=..., filter="blur")  ← Phase 1 은 blur 고정
  5) set_person_from_frame(frame_id=..., subject="largest_face"|"name:XXX", side="left"|"right")
  6) add_caption(text=..., position="bottom"|"top"|"auto", tone_tag="인용"|"훅"|"의문"|"충격"|"기본",
                 size_hint="XL", font_role="variety")
     - 2~4어절 · 큰 폰트에 들어갈 짧은 문장
     - clickbait 어휘 금칙 · 담백·여운 · 인용/훅/의문 중 하나 톤
  7) render_preview() 로 warnings 확인 · 겹치면 undo_last() + 다시
  8) export_thumbnail() 로 완료 · 세션 종료

규칙:
- 인물·자막은 절대 이미지로 만들지 마 (인물은 원본 프레임 · 자막은 시스템 폰트).
- 최대 12 turn · 넘으면 시스템 자동 export.
- 자막은 clickbait 어휘 금칙 (예: "충격", "레전드", "역대급", "미쳤다" 남용 X).
"""


TOOL_DISPATCH: dict[str, Callable] = {
    "get_shorts_context":         T.get_shorts_context,
    "list_candidate_frames":      T.list_candidate_frames,
    "inspect_frame":              T.inspect_frame,
    "create_document":            T.create_document,
    "list_layers":                T.list_layers,
    "clear_layer":                T.clear_layer,
    "set_background_from_frame":  T.set_background_from_frame,
    "set_person_from_frame":      T.set_person_from_frame,
    "add_caption":                T.add_caption,
    "get_canvas_info":            T.get_canvas_info,
    "suggest_caption_position":   T.suggest_caption_position,
    "check_overlap":              T.check_overlap,
    "render_preview":             T.render_preview,
    "undo_last":                  T.undo_last,
    # export_thumbnail 은 out_dir 필요 · run_session 이 wrap
}


def run_session(
    media_dir: pathlib.Path,
    out_dir: pathlib.Path,
    variant_id: str = "v1",
    shorts_context: dict | None = None,
    hint_prompt: str = "쇼츠 썸네일 조립",
    project: str | None = None,
    location: str = DEFAULT_LOCATION,
) -> dict:
    """한 variant 하나 만드는 세션. 반환: {status, turns[], exported_path?}."""
    project = project or os.environ.get("GOOGLE_CLOUD_PROJECT", "step-d")

    # 세션 컨텍스트
    ctx = T.SessionContext(media_dir=pathlib.Path(media_dir))
    if shorts_context:
        ctx.shorts_ctx = shorts_context
    else:
        # workdir에서 최소 컨텍스트 로드 (program_context.json)
        pc = pathlib.Path(media_dir) / "program_context.json"
        if pc.exists():
            data = json.loads(pc.read_text(encoding="utf-8"))
            ctx.shorts_ctx = {
                "program": {"title": data.get("title"), "section": data.get("section"),
                            "mood": data.get("mood"), "synopsis": (data.get("synopsis") or "")[:400]},
                "cast_names": data.get("cast") or [],
                "title": data.get("title", "쇼츠"),
                "description": "",
            }

    # export 는 세션 종료 처리 · 여기 미리 wrapping
    def _dispatch_export(_ctx: T.SessionContext) -> dict:
        return T.export_thumbnail(_ctx, out_dir=out_dir, variant_id=variant_id)

    dispatch = dict(TOOL_DISPATCH)
    dispatch["export_thumbnail"] = _dispatch_export

    # Vertex 클라이언트
    client = genai.Client(vertexai=True, project=project, location=location)
    tool = build_tool()
    cfg = types.GenerateContentConfig(
        tools=[tool],
        system_instruction=SYSTEM_INSTRUCTION,
        temperature=1.0,
    )

    # 첫 user message
    first_user = _build_first_user(ctx.shorts_ctx, hint_prompt)
    history: list[types.Content] = [
        types.Content(role="user", parts=[types.Part.from_text(text=first_user)])
    ]

    turns_log: list[dict] = []
    exported_path: str | None = None
    finish_reason: str = "completed"

    for turn_i in range(MAX_TURNS):
        resp = client.models.generate_content(
            model=MODEL_TEXT,
            contents=history,
            config=cfg,
        )
        if not resp.candidates:
            finish_reason = "no_candidate"
            break
        cand = resp.candidates[0]
        history.append(cand.content)   # model turn 추가

        # 함수 호출 파싱
        function_calls = [p.function_call for p in (cand.content.parts or [])
                          if getattr(p, "function_call", None)]
        text_parts = [p.text for p in (cand.content.parts or []) if getattr(p, "text", None)]

        if not function_calls:
            turns_log.append({"turn": turn_i, "type": "text", "text": " ".join(text_parts)[:300]})
            finish_reason = "model_stopped_no_call"
            break

        # 각 함수 호출 실행 → tool response 추가
        tool_response_parts: list[types.Part] = []
        for fc in function_calls:
            name = fc.name
            args = dict(fc.args) if fc.args else {}
            try:
                fn = dispatch.get(name)
                if not fn:
                    result: dict = {"error": f"unknown tool: {name}"}
                else:
                    result = fn(ctx, **args)
            except Exception as e:
                result = {"error": f"{type(e).__name__}: {str(e)[:200]}"}

            turns_log.append({"turn": turn_i, "type": "tool_call", "name": name,
                              "args": args, "result_summary": _summarize(result)})

            # render_preview 는 이미지가 크니 · b64 를 inline_data 로 넘겨 AI 가 실제로 보게
            if name == "render_preview" and "preview_png_b64" in result:
                img_bytes = base64.b64decode(result["preview_png_b64"])
                summary = {k: v for k, v in result.items() if k != "preview_png_b64"}
                tool_response_parts.append(types.Part.from_function_response(
                    name=name, response=summary))
                tool_response_parts.append(types.Part.from_bytes(
                    data=img_bytes, mime_type="image/png"))
            else:
                tool_response_parts.append(types.Part.from_function_response(
                    name=name, response=result))

            if name == "export_thumbnail" and result.get("exported"):
                exported_path = result.get("path")

        history.append(types.Content(role="user", parts=tool_response_parts))

        if exported_path:
            finish_reason = "exported"
            break
    else:
        # turn 한도 도달 · 강제 export
        try:
            result = _dispatch_export(ctx)
            exported_path = result.get("path")
            turns_log.append({"turn": MAX_TURNS, "type": "forced_export",
                              "result_summary": _summarize(result)})
            finish_reason = "forced_export"
        except Exception as e:
            finish_reason = f"forced_export_fail: {e}"

    return {
        "status": finish_reason,
        "turns": turns_log,
        "exported_path": exported_path,
        "variant_id": variant_id,
    }


def _build_first_user(shorts_ctx: dict, hint_prompt: str) -> str:
    prog = shorts_ctx.get("program", {})
    return (
        f"[힌트] {hint_prompt}\n\n"
        f"[프로그램] {prog.get('title','?')} ({prog.get('section','')})"
        + (f" mood: {prog.get('mood')}" if prog.get('mood') else "")
        + f"\n[출연자] {', '.join(shorts_ctx.get('cast_names', []))}\n"
        f"[시놉시스] {prog.get('synopsis','')}\n\n"
        f"[쇼츠 제목] {shorts_ctx.get('title','')}\n"
        f"[쇼츠 설명] {shorts_ctx.get('description','')}\n\n"
        "위 컨텍스트로 썸네일을 조립해라. 도구를 순차 호출하고, 마지막에 export_thumbnail 로 완료."
    )


def _summarize(result: dict) -> str:
    """AI turn 로그에 저장할 짧은 요약 (전체 dict은 크니까)."""
    if isinstance(result, dict):
        if "error" in result:
            return f"ERROR: {result['error']}"
        keys = list(result.keys())[:5]
        return f"OK · keys={keys}"
    return str(result)[:120]
