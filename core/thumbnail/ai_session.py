"""Vertex Gemini 멀티턴 오케스트레이션 — Phase 1+2+3 분리 버전.

Flow:
  1) Planner (AI): shorts_ctx + candidate_frames + cast_photos → ThumbnailPlan JSON
  2) Generator (System): plan + media_dir → {layer: LayerResult}
  3) Compositor (System): layers → final PNG (16:9 + 9:16)

이전 버전은 AI가 도구를 순차 호출하며 직접 합성까지 했음.
이제는 AI=Planner만 담당, 생성/합성은 시스템이 결정론적 수행.
"""

from __future__ import annotations

import json
import os
import pathlib
import time
from typing import Any, Optional


from . import planner as Planner
from . import generator as Generator
from . import compositor as Compositor


from core.common.models import TEXT as MODEL
DEFAULT_LOCATION = "us-central1"
MAX_RETRIES = 2


def run_session(
    media_dir: pathlib.Path,
    out_dir: pathlib.Path,
    variant_id: str = "v1",
    shorts_context: dict | None = None,
    hint_prompt: str = "쇼츠 썸네일 기획",
    project: str | None = None,
    location: str = DEFAULT_LOCATION,
) -> dict:
    """한 variant 생성 세션 실행. 반환: {status, plan, layers_meta, exported_paths, took_sec}."""
    project = project or os.environ.get("GOOGLE_CLOUD_PROJECT", "step-d")
    t0 = time.time()

    # ──────────────────────────────────────────────
    # 0) 컨텍스트 준비 (shorts_context가 없으면 workdir에서 최소 로드)
    # ──────────────────────────────────────────────
    if shorts_context is None:
        pc = media_dir / "program_context.json"
        if pc.exists():
            data = json.loads(pc.read_text(encoding="utf-8"))
            shorts_context = {
                "program": {"title": data.get("title"), "section": data.get("section"),
                            "mood": data.get("mood"), "synopsis": (data.get("synopsis") or "")[:400]},
                "cast_names": data.get("cast") or [],
                "title": data.get("title", "쇼츠"),
                "description": "",
            }
        else:
            shorts_context = {"title": "쇼츠", "description": "", "cast_names": []}

    # ──────────────────────────────────────────────
    # 1) Phase 1: Planner (AI) — 계획 JSON 생성
    # ──────────────────────────────────────────────
    plan = None
    last_error = None

    for attempt in range(MAX_RETRIES + 1):
        try:
            plan = Planner.generate_plan(
                media_dir=media_dir,
                variant_id=f"{variant_id}_plan_attempt{attempt}",
                shorts_context=shorts_context,
                project=project,
                location=location,
            )
            # 계획 검증
            _validate_plan(plan)
            break
        except Exception as e:
            last_error = e
            if attempt < MAX_RETRIES:
                time.sleep(1.5 * (attempt + 1))
                continue
            return {
                "status": "planner_failed",
                "error": str(last_error),
                "took_sec": round(time.time() - t0, 1),
            }

    # ──────────────────────────────────────────────
    # 2+3) Regenerate deterministic layers for each canvas before composition.
    # A 16:9 transform cannot safely be reused for 9:16 (notably captions and
    # subject placement); the AI plan remains one decision shared by both.
    exported_paths: dict[str, str] = {}
    layers_meta: dict[str, Any] = {}
    try:
        # 16:9만 (사용자 결정 2026-07-27 · 세로는 별도 계획으로)
        for aspect in ("16:9",):
            layers = Generator.generate_all_layers(media_dir, plan, aspect=aspect)
            meta = Compositor.compose_thumbnail(
                layers=layers,
                out_dir=out_dir,
                variant_id=variant_id,
                aspects=(aspect,),
            )
            exported_paths.update(meta["aspects"])
            layers_meta[aspect] = {
                k: {"size": v.image.size, "transform": (v.transform.x, v.transform.y, v.transform.width, v.transform.height)}
                for k, v in layers.items()
            }
    except Exception as e:
        return {
            "status": "generator_or_compositor_failed",
            "plan": plan,
            "error": str(e),
            "took_sec": round(time.time() - t0, 1),
        }

    return {
        "status": "completed",
        "variant_id": variant_id,
        "plan": plan,
        "layers_meta": layers_meta,
        "exported_paths": exported_paths,
        "meta_path": str(out_dir / f"{variant_id}_meta.json"),
        "took_sec": round(time.time() - t0, 1),
    }


def run_multi_variant(
    media_dir: pathlib.Path,
    out_dir: pathlib.Path,
    n_variants: int = 3,
    shorts_context: dict | None = None,
    project: str | None = None,
    location: str = DEFAULT_LOCATION,
) -> list[dict]:
    """여러 variant 병렬 생성 (순차 실행, 향후 asyncio/ThreadPool로 병렬화 가능)."""
    results = []
    for i in range(n_variants):
        variant_id = f"v{i+1}"
        print(f"[thumbnail] Generating variant {variant_id}...")
        result = run_session(
            media_dir=media_dir,
            out_dir=out_dir,
            variant_id=variant_id,
            shorts_context=shorts_context,
            project=project,
            location=location,
        )
        results.append(result)
        if result["status"] != "completed":
            print(f"[thumbnail] Variant {variant_id} failed: {result.get('error')}")
    return results


def _validate_plan(plan: dict) -> None:
    """Planner 출력 JSON 필수 필드 검증. persons 배열이면 person 단일 필드는 optional."""
    required = ["background", "caption", "layout_hints"]
    for key in required:
        if key not in plan:
            raise ValueError(f"Plan missing required key: {key}")

    # background
    bg = plan["background"]
    if "mode" not in bg:
        raise ValueError("background.mode required")
    if bg["mode"] == "frame_blur" and "frame_id" not in bg:
        raise ValueError("frame_blur mode requires frame_id")
    if bg["mode"] == "ai_generate" and "prompt" not in bg:
        raise ValueError("ai_generate mode requires prompt")

    # person or persons — 최소 하나 있어야
    has_persons = isinstance(plan.get("persons"), list) and len(plan["persons"]) >= 1
    has_single = isinstance(plan.get("person"), dict)
    if not (has_persons or has_single):
        raise ValueError("either 'person' object or 'persons' array required")
    if has_persons:
        for i, p in enumerate(plan["persons"]):
            if "source" not in p:
                raise ValueError(f"persons[{i}].source required")
            if p["source"] == "frame" and "frame_id" not in p:
                raise ValueError(f"persons[{i}] source=frame requires frame_id")
            if p["source"] == "cast_photo" and "cast_name" not in p:
                raise ValueError(f"persons[{i}] source=cast_photo requires cast_name")
    elif has_single:
        person = plan["person"]
        if "source" not in person:
            raise ValueError("person.source required")
        if person["source"] == "frame" and "frame_id" not in person:
            raise ValueError("person source=frame requires frame_id")
        if person["source"] == "cast_photo" and "cast_name" not in person:
            raise ValueError("person source=cast_photo requires cast_name")

    # caption
    cap = plan["caption"]
    for req in ["text", "position", "tone_tag", "size_hint", "font_role"]:
        if req not in cap:
            raise ValueError(f"caption.{req} required")


# ──────────────────────────────────────────────
# Legacy 호환: 기존 ai_session.run_session 시그니처 유지
# ──────────────────────────────────────────────
def run_session_legacy(
    media_dir: pathlib.Path,
    out_dir: pathlib.Path,
    variant_id: str = "v1",
    shorts_context: dict | None = None,
    hint_prompt: str = "쇼츠 썸네일 조립",
    project: str | None = None,
    location: str = DEFAULT_LOCATION,
) -> dict:
    """기존 코드 호환용 래퍼. 내부적으로 새 3-phase 실행."""
    result = run_session(media_dir, out_dir, variant_id, shorts_context, hint_prompt, project, location)

    # 기존 반환 형식에 맞춤
    return {
        "status": result["status"],
        "turns": [{"phase": "planner", "plan": result.get("plan")},
                  {"phase": "generator", "layers": list(result.get("layers_meta", {}).keys())},
                  {"phase": "compositor", "exported": result.get("exported_paths")}],
        "exported_path": result.get("exported_paths", {}).get("16:9"),
        "variant_id": variant_id,
    }


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 3:
        print("Usage: python -m core.thumbnail.ai_session <media_dir> <out_dir> [variant_id]")
        sys.exit(1)
    media_dir = pathlib.Path(sys.argv[1])
    out_dir = pathlib.Path(sys.argv[2])
    variant_id = sys.argv[3] if len(sys.argv) > 3 else "v1"

    result = run_session(media_dir, out_dir, variant_id)
    print(json.dumps(result, ensure_ascii=False, indent=2))