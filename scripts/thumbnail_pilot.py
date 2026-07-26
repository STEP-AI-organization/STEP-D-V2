"""
썸네일 엔진 파일럿 — 배경 이미지 소스별 실측 (docs/plans/thumbnail-engine-plan.md §13.4).

목표: Gemini 2.5 flash image가 어떤 인풋 조합에서 가장 좋은 배경을 만드는지 조정 축 실측.
5가지 실험:
  A. 텍스트 프롬프트만 (기준선)
  B. 프롬프트 + 원본 프레임 1장 (reference)
  C. 프롬프트 + 원본 프레임 + 인물 사진 1장
  D. 프롬프트 + 프레임 2장 + 인물 사진 2장
  E. D + 시놉시스 문장

결과: logs/thumbnail-pilot/<seed>/<experiment>.png · docs/research/thumbnail-source-experiments.md에 요약.

사용:
  python scripts/thumbnail_pilot.py --frames path/frame1.jpg,path/frame2.jpg --cast path/cast1.jpg,path/cast2.jpg
  or 인자 없이 실행 = 기본 A만 실행 (텍스트 프롬프트 검증)
"""
from __future__ import annotations
import argparse, os, sys, time, pathlib, base64
from typing import Iterable

from google import genai
from google.genai import types

MODEL = "gemini-2.5-flash-image"
LOCATION = "us-central1"  # asia-northeast3 에는 이미지 모델 없음 (실측 완료)
PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "step-d")
OUT_ROOT = pathlib.Path("logs/thumbnail-pilot")

SYSTEM_PREFIX = """목표: 참고 이미지들의 장면 톤·조명·색을 유지한 배경 이미지 생성.
제약:
- 사람 얼굴·전신 그리지 마 (인물은 별도 레이어에서 원본 사진으로 처리)
- 텍스트·자막·글자 그리지 마 (자막은 별도 레이어)
- 참고 이미지의 인테리어·야외성·시간대 유지
- 16:9 가로 · 시네마틱
"""

DEFAULT_PROMPT = "밤 · 카페 창가 · 도시 야경 은은한 반사 · 따뜻한 조명"
DEFAULT_SYNOPSIS = (
    "환승연애: 헤어진 연인들이 새로운 사랑을 찾으면서 옛 연인과 마주치는 감정의 실험.\n"
    "톤: 감성적 · 저녁·밤 위주 · 카페·바 등 실내 인테리어 · 도시 야경."
)

def load_image(path: str) -> types.Part:
    p = pathlib.Path(path)
    if not p.exists():
        raise FileNotFoundError(p)
    mime = "image/jpeg" if p.suffix.lower() in {".jpg", ".jpeg"} else "image/png"
    return types.Part.from_bytes(data=p.read_bytes(), mime_type=mime)

def run_generation(client: genai.Client, parts: list) -> bytes:
    r = client.models.generate_content(
        model=MODEL,
        contents=parts,
        config=types.GenerateContentConfig(response_modalities=["IMAGE", "TEXT"]),
    )
    for p in r.candidates[0].content.parts:
        if getattr(p, "inline_data", None) and p.inline_data.data:
            return p.inline_data.data
    raise RuntimeError("no image in response")

def save(out: pathlib.Path, name: str, data: bytes) -> pathlib.Path:
    out.mkdir(parents=True, exist_ok=True)
    dest = out / f"{name}.png"
    dest.write_bytes(data)
    return dest

def experiment(client: genai.Client, out: pathlib.Path, name: str, parts: list) -> tuple[bool, str]:
    t0 = time.time()
    try:
        data = run_generation(client, parts)
        dest = save(out, name, data)
        return True, f"[{name}] OK · {len(data)/1024:.0f} KB · {time.time()-t0:.1f}s · {dest}"
    except Exception as e:
        return False, f"[{name}] FAIL · {time.time()-t0:.1f}s · {str(e)[:200]}"

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", default="", help="쉼표 구분 참고 프레임 파일 경로들")
    ap.add_argument("--cast", default="", help="쉼표 구분 인물 사진 경로들")
    ap.add_argument("--prompt", default=DEFAULT_PROMPT)
    ap.add_argument("--synopsis", default=DEFAULT_SYNOPSIS)
    args = ap.parse_args()

    frames = [p for p in args.frames.split(",") if p.strip()]
    cast = [p for p in args.cast.split(",") if p.strip()]

    client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)
    run_id = time.strftime("%Y%m%d-%H%M%S")
    out = OUT_ROOT / run_id
    print(f"[pilot] out dir = {out}")

    text_only = f"{SYSTEM_PREFIX}\n[프롬프트]\n{args.prompt}"

    ok, msg = experiment(client, out, "A_text_only", [text_only])
    print(msg)

    if frames:
        parts_b = [load_image(frames[0]), text_only + "\n(위 참고 이미지의 톤·조명 유지)"]
        ok, msg = experiment(client, out, "B_text_frame1", parts_b)
        print(msg)

    if frames and cast:
        parts_c = [load_image(frames[0]), load_image(cast[0]),
                   text_only + "\n(참고: 프레임 톤 유지 + 인물 사진 의상·컬러 반영 · 얼굴 재현 금지)"]
        ok, msg = experiment(client, out, "C_frame1_cast1", parts_c)
        print(msg)

    if len(frames) >= 2 and len(cast) >= 2:
        parts_d = [load_image(frames[0]), load_image(frames[1]),
                   load_image(cast[0]), load_image(cast[1]),
                   text_only + "\n(참고: 프레임 2장 톤 + 인물 2명 스타일 · 얼굴 재현 금지)"]
        ok, msg = experiment(client, out, "D_frame2_cast2", parts_d)
        print(msg)

        parts_e = list(parts_d)
        parts_e[-1] = text_only + f"\n\n[시놉시스]\n{args.synopsis}\n\n(참고: 프레임·인물 스타일 + 시놉시스 톤 · 얼굴 재현 금지)"
        ok, msg = experiment(client, out, "E_full_context", parts_e)
        print(msg)

    return 0

if __name__ == "__main__":
    sys.exit(main())
