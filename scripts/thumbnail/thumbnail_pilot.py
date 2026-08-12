"""
썸네일 엔진 파일럿 — 배경 이미지 소스별 실측 (docs/plans/thumbnail-engine-plan.md §13.4).

**목적**: 우리 파이프라인이 이미 만들어둔 산출물만 재활용해서 Gemini 2.5 flash image가
어느 인풋 조합에서 가장 좋은 배경을 만드는지 조정 축 실측. 별도 분석 X.

**재활용하는 산출물** (media workdir 안 · content-pipeline이 이미 씀):
  program_context.json   → title / section / mood / synopsis / cast
  shot_frames/*.jpg      → 후보 프레임 (전부 아님 · 인덱스로 2장만)
  cast_photos/*.jpg      → 인물 사진 (cast 순서대로 최대 2명)

**실험 5가지** (같은 media에서 다른 소스 조합 · 다른 결과 비교):
  A. 텍스트 프롬프트만 (기준선 · 시놉시스 없이 짧은 hint만)
  B. + 프레임 1장
  C. + 프레임 + 인물 사진 1장
  D. + 프레임 2장 + 인물 2명
  E. D + 시놉시스 텍스트 (전체 컨텍스트)

**사용**:
  python scripts/thumbnail_pilot.py --media-dir "C:/Users/STEPAI05/AppData/Local/Temp/stepd-content/m_5ec98a5a"
  python scripts/thumbnail_pilot.py --media-dir <path> --prompt "다른 hint"
결과: logs/thumbnail-pilot/<seed>/[A_..~E_..].png
"""
from __future__ import annotations
import argparse, json, os, sys, time, pathlib
from typing import Optional

from google import genai
from google.genai import types

try:
    from core.models import IMAGE_FLASH as MODEL
except ImportError:
    MODEL = "gpt-image-2"  # 2026-07-30 Gemini→OpenAI 전환. pilot 은 실측 스크립트이므로 별도 리팩터 필요 시 openai_client 사용.
LOCATION = "us-central1"       # asia-northeast3 이미지 모델 없음 (실측 완료)
PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "step-d")
OUT_ROOT = pathlib.Path("logs/thumbnail-pilot")

SYSTEM_PREFIX = """목표: 참고 이미지들의 장면 톤·조명·색을 유지한 배경 이미지 생성 (16:9 시네마틱).
제약:
- 사람 얼굴·전신 그리지 마 (인물은 별도 레이어에서 원본 사진으로 처리)
- 텍스트·자막·글자 그리지 마 (자막은 별도 레이어)
- 참고 이미지의 인테리어·야외성·시간대 유지
"""

DEFAULT_PROMPT = "장면의 톤과 조명을 유지한 배경"

def load_workdir(media_dir: pathlib.Path) -> dict:
    """content-pipeline이 만들어둔 산출물에서 썸네일이 필요한 것만 쏙 뽑는다.
    영상 분석 전체 로드 X · shot_frames·cast_photos·program_context 3개면 충분."""
    ctx_path = media_dir / "program_context.json"
    ctx = json.loads(ctx_path.read_text(encoding="utf-8")) if ctx_path.exists() else {}

    shot_dir = media_dir / "shot_frames"
    frames = sorted([p for p in shot_dir.glob("shot_*.jpg")]) if shot_dir.exists() else []

    cast_dir = media_dir / "cast_photos"
    # cast 순서를 program_context.cast에 맞추면 좋지만 · 파일명이 이름 그대로면 그대로 매치
    cast_photos = sorted([p for p in cast_dir.glob("*.jpg")]) if cast_dir.exists() else []

    return {
        "context": ctx,
        "frames": frames,
        "cast": cast_photos,
    }

def load_image(p: pathlib.Path) -> types.Part:
    mime = "image/jpeg" if p.suffix.lower() in {".jpg", ".jpeg"} else "image/png"
    return types.Part.from_bytes(data=p.read_bytes(), mime_type=mime)

def build_prompt(hint: str, extra: str = "") -> str:
    body = f"{SYSTEM_PREFIX}\n[프롬프트]\n{hint}"
    if extra:
        body += f"\n\n{extra}"
    return body

def run(client: genai.Client, parts: list) -> bytes:
    r = client.models.generate_content(
        model=MODEL,
        contents=parts,
        config=types.GenerateContentConfig(response_modalities=["IMAGE", "TEXT"]),
    )
    for p in r.candidates[0].content.parts:
        if getattr(p, "inline_data", None) and p.inline_data.data:
            return p.inline_data.data
    raise RuntimeError("no image in response")

def experiment(client: genai.Client, out: pathlib.Path, name: str, parts: list) -> str:
    t0 = time.time()
    try:
        data = run(client, parts)
        out.mkdir(parents=True, exist_ok=True)
        dest = out / f"{name}.png"
        dest.write_bytes(data)
        return f"[{name}] OK · {len(data)/1024:.0f} KB · {time.time()-t0:.1f}s · {dest}"
    except Exception as e:
        return f"[{name}] FAIL · {time.time()-t0:.1f}s · {str(e)[:200]}"

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--media-dir", required=True,
                    help="content-pipeline workdir (예: .../stepd-content/m_XXXX)")
    ap.add_argument("--prompt", default=DEFAULT_PROMPT,
                    help="배경 hint (AI가 여기 위에 자동으로 컨텍스트 붙임)")
    ap.add_argument("--frame-idx", default="9,10",
                    help="쉼표 구분 · shot_frames 인덱스 (기본 9,10)")
    args = ap.parse_args()

    media = pathlib.Path(args.media_dir).resolve()
    if not media.exists():
        print(f"[FAIL] media dir 없음: {media}")
        return 1

    src = load_workdir(media)
    ctx = src["context"]
    print(f"[pilot] media = {media.name}")
    print(f"[pilot] title = {ctx.get('title')} · section = {ctx.get('section')}")
    print(f"[pilot] cast  = {ctx.get('cast')}")
    print(f"[pilot] shot_frames = {len(src['frames'])}장 · cast_photos = {len(src['cast'])}장")

    # 선택할 프레임
    idxs = [int(x) for x in args.frame-idx.split(",") if x.strip()] if False else \
           [int(x) for x in args.frame_idx.split(",") if x.strip()]
    picked_frames = [src["frames"][i] for i in idxs if 0 <= i < len(src["frames"])]
    if not picked_frames:
        print("[warn] 선택된 프레임 없음 → A만 실행")

    picked_cast = src["cast"][:2]   # 최대 2명

    client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)
    run_id = time.strftime("%Y%m%d-%H%M%S")
    out = OUT_ROOT / run_id
    print(f"[pilot] out = {out}\n")

    synopsis = ctx.get("synopsis", "")
    section = ctx.get("section", "예능")
    mood = ctx.get("mood", "")
    title = ctx.get("title", "")

    # 실험 A: 텍스트만
    print(experiment(client, out, "A_text_only",
                     [build_prompt(args.prompt)]))

    # 실험 B: + 프레임 1장
    if len(picked_frames) >= 1:
        parts = [load_image(picked_frames[0]),
                 build_prompt(args.prompt, "(위 참고 프레임의 톤·조명·인테리어 유지)")]
        print(experiment(client, out, "B_frame1", parts))

    # 실험 C: + 프레임 + 인물 사진 1
    if len(picked_frames) >= 1 and len(picked_cast) >= 1:
        parts = [load_image(picked_frames[0]),
                 load_image(picked_cast[0]),
                 build_prompt(args.prompt,
                              f"참고: 위 프레임 톤 + {picked_cast[0].stem} 스타일 · 얼굴 재현 금지")]
        print(experiment(client, out, "C_frame1_cast1", parts))

    # 실험 D: + 프레임 2장 + 인물 2명
    if len(picked_frames) >= 2 and len(picked_cast) >= 2:
        parts = [load_image(picked_frames[0]),
                 load_image(picked_frames[1]),
                 load_image(picked_cast[0]),
                 load_image(picked_cast[1]),
                 build_prompt(args.prompt,
                              f"참고: 프레임 2장 톤 + {picked_cast[0].stem}·{picked_cast[1].stem} "
                              "스타일 · 얼굴 재현 금지")]
        print(experiment(client, out, "D_frame2_cast2", parts))

    # 실험 E: D + 시놉시스·프로그램 톤 (전체 컨텍스트)
    if len(picked_frames) >= 2 and len(picked_cast) >= 2:
        extra = (
            f"[프로그램]\n제목: {title} ({section}"
            + (f", mood: {mood})" if mood else ")")
            + f"\n\n[시놉시스]\n{synopsis[:300]}"
            + "\n\n(참고: 위 프레임·인물 스타일 + 프로그램 톤 반영 · 얼굴 재현 금지)"
        )
        parts = [load_image(picked_frames[0]),
                 load_image(picked_frames[1]),
                 load_image(picked_cast[0]),
                 load_image(picked_cast[1]),
                 build_prompt(args.prompt, extra)]
        print(experiment(client, out, "E_full_context", parts))

    print(f"\n결과 {out}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
