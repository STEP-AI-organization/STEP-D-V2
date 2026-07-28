"""썸네일 파이프라인 · swap 기반 (2026-07-28 확정 방향).

사용자 지시:
"이런 템플릿 EDIT 하는 방향 썸네일 생성을 바꾸자"

흐름 (각 shorts 마다):
  ① 컨텍스트 로드 (shorts_context.json or narrative 첫 segment)
  ② Reference pool 로드 (assets/thumbnail-reference/*.png|jpg)
  ③ Planner (mini): 이 shorts 에 최적 reference N개 + 각 caption + featured_cast
  ④ 병렬 swap (gemini-3-pro-image · face+text edit) · N variant
  ⑤ CTR 채점 · Best 자동
  ⑥ multi_session.json (서버 규격)

기존 composition 접근 (bg gen + castPhoto 세그 합성) 은 pipeline_compose.py 로 보존.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from google import genai
from google.genai import types

from . import swap as SW
from . import ctr_predictor as CTR
from . import person_compositor as PC
from .planner import load_shorts_slice

REF_DIR = pathlib.Path(__file__).resolve().parents[2] / "assets" / "thumbnail-reference"
MODEL = "gemini-2.5-flash"
LOCATION = "asia-northeast3"


PLAN_SYSTEM = """너는 한국 방송사 유튜브 썸네일 배분 기획자다.

주어진 것:
- 하나의 shorts segment (하이라이트 구간)
- 여러 reference 썸네일 (실제 방송사 완성작 · 각각 다른 구도)
- 등록 인물 목록 (썸네일 사용 가능)

너의 일: 이 shorts 를 표현할 variant **N개**를 짜라. 각 variant 는:
- reference_id: 위 후보 중 하나 (variant 마다 다른 reference 선호 · 다양성)
- featured_cast: 등록 목록에서만 · reference 인물 수와 근접
- caption: 이 shorts 를 대표할 **하단 메인 카피 한 문장**
  · 원본 reference 자막은 통째 교체됨 (원본 문장 재사용 X)
  · 핵심 + 어그로 · 감상형 X · 이모지 X
  · 10~18자 · 정보 충분 (5자 이하 X)
  · 실제 shorts 대사·순간 근거

variant 간 다양성:
- 서로 다른 reference · 서로 다른 각도의 caption (사건 명시 / 인용 / 질문 등)
- featured_cast 조합 다르게 가능

출력 JSON: {"hook_summary": "...", "variants": [{reference_id, featured_cast, caption}, ...]}
"""


def _plan_variants(shorts_meta: dict, references: list[dict],
                    available_cast: list[str], n: int,
                    project: str | None = None) -> tuple[str, list[dict]]:
    lines = [f"[이 shorts]"]
    lines.append(f"  [{shorts_meta.get('start',0):.0f}-{shorts_meta.get('end',0):.0f}s] title={shorts_meta.get('title','')}")
    lines.append(f"  summary: {(shorts_meta.get('summary') or '')[:250]}")
    if shorts_meta.get("key_moments"):
        lines.append("  핵심 순간:")
        for k in shorts_meta["key_moments"][:6]:
            lines.append(f"    · {k}")
    if shorts_meta.get("transcript_sample"):
        lines.append("  실제 대사:")
        for t in shorts_meta["transcript_sample"][:12]:
            lines.append(f"    · {t}")
    lines.append("")
    lines.append("[reference 후보]")
    for r in references:
        meta_parts = []
        if r.get("person_count"): meta_parts.append(f"{r['person_count']}인")
        if r.get("composition"):  meta_parts.append(r["composition"])
        if r.get("mood"):         meta_parts.append(r["mood"])
        meta = " · ".join(meta_parts)
        lines.append(f"  - {r['id']}: {meta} · {r.get('description','')[:80]}")
    lines.append("")
    lines.append(f"[등록 인물] {', '.join(available_cast) if available_cast else '(없음)'}")
    lines.append("")
    lines.append(f"variant **{n}개** 짜라.")
    lines.append("")
    lines.append("**reference 선택 원칙**:")
    lines.append("- reference person_count 와 featured_cast 배열 길이 매칭 (2인 reference → cast 2명)")
    lines.append("- reference mood 와 shorts 톤 정합 (충격 shorts → 충격 reference)")
    lines.append("- variant 마다 다른 reference (다양성)")

    schema = {
        "type": "OBJECT",
        "properties": {
            "hook_summary": {"type": "STRING"},
            "variants": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "reference_id": {"type": "STRING", "enum": [r["id"] for r in references]},
                        "featured_cast": {"type": "ARRAY", "items": {"type": "STRING"}},
                        "caption": {"type": "STRING"},
                    },
                    "required": ["reference_id", "featured_cast", "caption"],
                },
            },
        },
        "required": ["hook_summary", "variants"],
    }
    client = genai.Client(vertexai=True,
                          project=project or os.environ.get("GOOGLE_CLOUD_PROJECT", "step-d"),
                          location=LOCATION)
    resp = client.models.generate_content(
        model=MODEL,
        contents=[types.Content(role="user", parts=[types.Part.from_text(text="\n".join(lines))])],
        config=types.GenerateContentConfig(
            system_instruction=PLAN_SYSTEM,
            response_mime_type="application/json",
            response_schema=schema,
            temperature=0.9,
            max_output_tokens=4096,
        ),
    )
    if not resp.text:
        return "", []
    try:
        data = json.loads(resp.text)
        return data.get("hook_summary", ""), (data.get("variants") or [])[:n]
    except Exception:
        return "", []


def _load_references() -> list[dict]:
    """assets/thumbnail-reference/manifest.json 우선 · 없으면 파일 스캔."""
    if not REF_DIR.exists():
        return []
    manifest_p = REF_DIR / "manifest.json"
    if manifest_p.exists():
        try:
            data = json.loads(manifest_p.read_text(encoding="utf-8"))
            refs = []
            for m in data:
                if not m.get("_analyzed", True):
                    continue
                p = REF_DIR.parent / m["path"]
                if not p.exists():
                    continue
                # cleaned_path 우선 (사전 가공된 template)
                use_p = p
                if m.get("cleaned_path"):
                    cp = REF_DIR.parent / m["cleaned_path"]
                    if cp.exists():
                        use_p = cp
                refs.append({
                    "id": m["id"], "path": use_p,
                    "orig_path": p,
                    "cleaned": bool(m.get("cleaned_path") and use_p != p),
                    "person_count": m.get("person_count", 0),
                    "mood": m.get("mood", ""),
                    "composition": m.get("composition", ""),
                    "style_tags": m.get("style_tags", []),
                    "caption_style": m.get("caption_style", ""),
                    "description": m.get("description", ""),
                    "program": m.get("program", ""),           # 프로그램 필터용
                    "custom_tags": m.get("custom_tags", []),   # 사용자 태그
                })
            if refs:
                return refs
        except Exception:
            pass
    # 폴백: 파일 스캔 · 메타 없음
    refs: list[dict] = []
    for p in sorted(REF_DIR.glob("*")):
        if p.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
            continue
        refs.append({"id": p.stem, "path": p, "description": ""})
    return refs


def run_pipeline(
    media_dir: pathlib.Path,
    out_dir: pathlib.Path,
    n_variants: int = 3,
    shorts: dict | None = None,
) -> dict:
    """swap 기반 파이프라인 · variant N개 · multi_session.json 호환 결과."""
    out_dir.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    log: dict = {"stages": {}, "took": {}}

    # ─── ① 컨텍스트 ─────────────────────────
    t = time.time()
    if not shorts:
        # narrative 첫 segment 를 shorts 로
        nar = _safe_load(media_dir / "narrative.json", {})
        if isinstance(nar, dict) and nar.get("segments"):
            s0 = nar["segments"][0]
            shorts = {"start": s0.get("start", 0), "end": s0.get("end", 180),
                      "title": s0.get("title", ""), "summary": s0.get("summary", "")}
    if not shorts:
        return {"status": "no_shorts", "log": log}
    shorts_slice = load_shorts_slice(media_dir, shorts) or {}
    shorts_meta = dict(shorts)
    shorts_meta["key_moments"] = shorts_slice.get("key_moments") or []
    shorts_meta["transcript_sample"] = (shorts_slice.get("transcript_lines") or [])[:12]
    log["stages"]["1_context"] = {"start": shorts.get("start"), "end": shorts.get("end"),
                                   "title": shorts.get("title", "")}
    log["took"]["1_context"] = round(time.time() - t, 2)

    # ─── ② Reference pool ─── 프로그램 필터 우선 ─────
    t = time.time()
    all_refs = _load_references()
    # 프로그램 컨텍스트 (workdir program_context.json)
    program_ctx = _safe_load(media_dir / "program_context.json", {})
    program_id = (program_ctx.get("title") if isinstance(program_ctx, dict) else "") or ""
    # program 태그 매칭 우선 · 매칭 X 이면 전체
    if program_id:
        matched = [r for r in all_refs if (r.get("program") or "") == program_id]
        references = matched or all_refs
        filter_note = f"program='{program_id}' matched {len(matched)}/{len(all_refs)}"
    else:
        references = all_refs
        filter_note = "no program filter (global pool)"
    log["stages"]["2_references"] = {"count": len(references), "total": len(all_refs),
                                       "filter": filter_note,
                                       "ids": [r["id"] for r in references]}
    log["took"]["2_references"] = round(time.time() - t, 2)
    if not references:
        return {"status": "no_references", "log": log}

    # 등록 인물
    cast_dir = media_dir / "cast_photos"
    available_cast: list[str] = []
    if cast_dir.exists():
        exts = {".jpg", ".jpeg", ".png", ".webp"}
        available_cast = sorted({p.stem for p in cast_dir.iterdir() if p.suffix.lower() in exts})

    # ─── ③ Planner ──────────────────────────
    t = time.time()
    hook, plans = _plan_variants(shorts_meta, references, available_cast, n_variants)
    print(f"[pipeline] hook: {hook}")
    print(f"[pipeline] variants: {len(plans)}")
    for i, p in enumerate(plans):
        print(f"  v{i+1}: ref={p.get('reference_id')} · cast={p.get('featured_cast')} · caption={p.get('caption')}")
    if not plans:
        # 폴백 · round-robin references
        plans = [{
            "reference_id": references[i % len(references)]["id"],
            "featured_cast": available_cast[:2],
            "caption": (shorts.get("title") or "")[:18],
        } for i in range(n_variants)]

    # ─── ③.5 cast count vs person_count fallback ───
    # cast 부족하면 · person_count 작은 reference 로 downgrade
    ref_by_id_pre = {r["id"]: r for r in references}
    for i, plan in enumerate(plans):
        ref = ref_by_id_pre.get(plan.get("reference_id"))
        if not ref:
            continue
        need = int(ref.get("person_count") or 0)
        have = len(plan.get("featured_cast") or [])
        if need > 0 and have > 0 and have < need:
            # 더 작은 person_count reference 찾기
            candidates = sorted(
                [r for r in references if int(r.get("person_count") or 0) <= have],
                key=lambda r: -int(r.get("person_count") or 0))
            if candidates:
                new_ref = candidates[0]
                print(f"  [fallback v{i+1}] cast {have} < ref person {need} → {ref['id']} → {new_ref['id']} (person {new_ref.get('person_count')})")
                plan["reference_id"] = new_ref["id"]
                plan["_fallback_from"] = ref["id"]
        elif need > 0 and have > need:
            # 초과분 잘라내기 (선택)
            plan["featured_cast"] = (plan.get("featured_cast") or [])[:need]
    log["stages"]["3_planner"] = {"hook_summary": hook, "variants": plans}
    log["took"]["3_planner"] = round(time.time() - t, 2)

    # ─── ④ 병렬 swap ────────────────────────
    t = time.time()
    ref_by_id = {r["id"]: r for r in references}
    variant_images: dict[str, bytes] = {}
    variant_paths: dict[str, str] = {}

    def _do(vid: str, plan: dict) -> tuple[str, bytes | None]:
        ref = ref_by_id.get(plan.get("reference_id"))
        if not ref:
            print(f"  [{vid}] fail · unknown reference", file=sys.stderr); return vid, None
        # 인물 사진 조회 (derived_cast 우선)
        names = plan.get("featured_cast") or []
        photos: list[pathlib.Path] = []
        resolved: list[str] = []
        for nm in names:
            d = PC.derive_person_source(nm, media_dir)
            if d and d.exists():
                photos.append(d); resolved.append(nm); continue
            if cast_dir.exists():
                for ext in ("jpg", "jpeg", "png", "webp"):
                    pp = cast_dir / f"{nm}.{ext}"
                    if pp.exists():
                        photos.append(pp); resolved.append(nm); break
        if not photos:
            print(f"  [{vid}] fail · no cast photos", file=sys.stderr); return vid, None
        try:
            img = SW.swap_thumbnail(reference=ref["path"], cast_photos=photos,
                                     cast_names=resolved, caption=plan.get("caption", ""))
        except Exception as e:
            print(f"  [{vid}] fail · {str(e)[:200]}", file=sys.stderr); return vid, None
        return vid, img

    with ThreadPoolExecutor(max_workers=max(1, min(3, len(plans)))) as ex:
        futs = [ex.submit(_do, f"v{i+1}", p) for i, p in enumerate(plans)]
        for f in as_completed(futs):
            vid, img = f.result()
            if img:
                dest = out_dir / f"{vid}.png"
                dest.write_bytes(img)
                variant_images[vid] = img
                variant_paths[vid] = str(dest)
                print(f"  [ok] {vid} → {dest.name}")

    log["stages"]["4_swap"] = {"requested": len(plans), "succeeded": len(variant_images),
                                 "paths": variant_paths}
    log["took"]["4_swap"] = round(time.time() - t, 2)
    if not variant_images:
        return {"status": "swap_failed", "log": log}

    # ─── ⑤ CTR + Best ───────────────────────
    t = time.time()
    scores = CTR.score_variants(variant_images) or []
    best_id = CTR.pick_best(scores)
    log["stages"]["5_ctr"] = {"scores": scores, "best": best_id}
    log["took"]["5_ctr"] = round(time.time() - t, 2)
    best_path = None
    if best_id and best_id in variant_paths:
        best_dst = out_dir / f"BEST_{best_id}.png"
        best_dst.write_bytes(pathlib.Path(variant_paths[best_id]).read_bytes())
        best_path = str(best_dst)
    log["best_path"] = best_path
    log["total_took"] = round(time.time() - t0, 2)
    (out_dir / "pipeline_log.json").write_text(
        json.dumps(log, ensure_ascii=False, indent=2, default=str), encoding="utf-8")

    return {"status": "completed", "log": log,
            "best": best_path, "variants": variant_paths, "scores": scores}


def _safe_load(p: pathlib.Path, default):
    try:
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default
    except Exception:
        return default


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--media-dir", required=True)
    ap.add_argument("--out", default="")
    ap.add_argument("--variants", type=int, default=3)
    args = ap.parse_args()

    media = pathlib.Path(args.media_dir).resolve()
    out = pathlib.Path(args.out).resolve() if args.out else \
          pathlib.Path("logs/thumbnail-pipeline") / time.strftime("%Y%m%d-%H%M%S")

    print(f"[pipeline] media = {media}")
    print(f"[pipeline] out   = {out}")
    print(f"[pipeline] variants = {args.variants}\n")

    result = run_pipeline(media_dir=media, out_dir=out, n_variants=args.variants)
    print(f"\n=== 결과 ===\nstatus: {result['status']}")
    if result.get("scores"):
        print("CTR:")
        for s in result["scores"]:
            print(f"  {s.get('variant'):>3s} · {s.get('total')} · {s.get('reason','')[:60]}")
    print(f"BEST: {result.get('best')}")
    return 0 if result["status"] == "completed" else 2


if __name__ == "__main__":
    sys.exit(main())
