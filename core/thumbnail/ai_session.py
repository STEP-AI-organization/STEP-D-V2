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

SYSTEM_INSTRUCTION = """너는 한국 방송사 편집팀의 썸네일 디자이너다. 도구를 순차 호출해서
"이 쇼츠가 클릭될 만한 썸네일" 하나를 조립한다.

**필수 최종 상태** (모두 있어야 export 가능):
  - Layer 0 Background (배경)
  - Layer 2 Person (인물)         ← 반드시 · 자막만 있는 배경은 실패
  - Layer 4 Caption (자막)

권장 순서:
  1) get_shorts_context() · list_candidate_frames() · inspect_frame() 로 파악
  2) create_document(aspect="16:9")
  3) [배경] 다음 중 하나:
       (a) set_background_from_frame(frame_id=..., filter="blur")   ← 빠름·안전
       (b) generate_and_set_background(prompt=..., style="cinematic",
                                       context_frame_ids=["shot_00XX","shot_00YY"])
                                                                   ← 톤 살리려면
  4) [인물 반드시] 다음 중 하나 선택:
       (a) set_person_from_cast_photo(cast_name="...", side="left"|"right",
                                      style_prompt="...")
           → castPhoto 를 참고로 AI 재생성 (얼굴 identity 유지 강제).
             썸네일용 포즈·표정·조명 최적화.
       (b) set_person_from_frame(frame_id=..., subject="name:XXX"|"largest_face",
                                 side="left"|"right")
           → 원본 프레임 rembg (실 프레임 그대로 · 안전 · 빠름).
       두 방법 다 시도해서 render_preview() 로 비교 후 좋은 것 선택 가능.
  5) add_caption(text=..., position="bottom"|"auto", tone_tag="인용"|"훅"|"의문"|"기본",
                 size_hint="XL", font_role="variety"|"drama")
     - 2~4어절 · 큰 폰트 · clickbait 어휘 금칙 (담백·여운·인용)
  6) render_preview() → warnings 확인 · 겹치면 undo_last() + 재배치
  7) 최종 확인 후 export_thumbnail()

규칙:
- 자막은 시스템 폰트로 렌더 (이미지로 만들지 마).
- 인물 얼굴은 절대 다른 얼굴로 바꾸지 마 (set_person_from_cast_photo 도 identity 유지 강제).
- 최대 12 turn · 넘으면 시스템 자동 export.
- 인물 없이 export 하지 마 (사용자가 인물을 원함).
"""


TOOL_DISPATCH: dict[str, Callable] = {
    "get_shorts_context":            T.get_shorts_context,
    "list_candidate_frames":         T.list_candidate_frames,
    "inspect_frame":                 T.inspect_frame,
    "create_document":               T.create_document,
    "list_layers":                   T.list_layers,
    "clear_layer":                   T.clear_layer,
    "set_background_from_frame":     T.set_background_from_frame,
    "generate_and_set_background":   T.generate_and_set_background,
    "set_person_from_frame":         T.set_person_from_frame,
    "set_person_from_cast_photo":    T.set_person_from_cast_photo,
    "add_caption":                   T.add_caption,
    "get_canvas_info":               T.get_canvas_info,
    "suggest_caption_position":      T.suggest_caption_position,
    "check_overlap":                 T.check_overlap,
    "render_preview":                T.render_preview,
    "undo_last":                     T.undo_last,
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
            # AI가 함수 안 부르고 텍스트만 뱉었을 때: 재프롬프트 시도 (1회) → 그래도 없으면 강제 export
            turns_log.append({"turn": turn_i, "type": "text_no_call", "text": " ".join(text_parts)[:400]})
            has_person = ctx.doc is not None and ctx.doc.layers["person"].source is not None
            has_caption = ctx.doc is not None and ctx.doc.layers["caption"].source is not None
            nudge_parts: list[str] = []
            if not has_person:
                nudge_parts.append("인물이 없다. set_person_from_cast_photo(cast_name='...') 를 지금 호출하라.")
            if not has_caption:
                nudge_parts.append("자막이 없다. add_caption(...) 을 지금 호출하라.")
            if not nudge_parts:
                nudge_parts.append("export_thumbnail() 을 호출해서 세션 종료하라.")
            nudge = "함수만 호출하라 (설명 텍스트 없이). " + " ".join(nudge_parts)
            history.append(types.Content(role="user", parts=[types.Part.from_text(text=nudge)]))
            # 다음 turn 으로 계속
            continue

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
