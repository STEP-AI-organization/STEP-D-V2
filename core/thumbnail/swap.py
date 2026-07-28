"""썸네일 face/text swap · 기존 방송사 썸네일 구도 그대로 · 얼굴·제목만 교체.

사용자 지시 (2026-07-28):
"우리 유튜브에 있는 썸네일 가지고 거기서 제목이랑 얼굴만 바꿔달라고 해서 해볼까"

접근:
- reference: 실제 방송사 썸네일 (SOLO/환승연애 등 · 구도·색·타이포 완성됨)
- cast: 교체할 얼굴 (castPhoto 또는 derive_person_source 결과)
- caption: 새 자막 텍스트
- Gemini gemini-3-pro-image 에 지시:
  "이 썸네일 톤·구도·타이포·색·로고 유지 · 얼굴만 첨부 사진 인물로 · 자막을 새 문장으로"

장점: composition 재발명 필요 X · 방송사 급 완성도 자동 확보
"""
from __future__ import annotations

import mimetypes
import os
import pathlib
from typing import Optional

from google import genai
from google.genai import types

MODEL = "gemini-3-pro-image"
LOCATION = "global"


def _client(project: Optional[str] = None) -> genai.Client:
    project = project or os.environ.get("GOOGLE_CLOUD_PROJECT", "step-d")
    return genai.Client(vertexai=True, project=project, location=LOCATION)


def _mime(p: pathlib.Path) -> str:
    m, _ = mimetypes.guess_type(str(p))
    return m or "image/jpeg"


def swap_thumbnail(
    reference: pathlib.Path,
    cast_photos: list[pathlib.Path],
    caption: str,
    cast_names: Optional[list[str]] = None,
    project: Optional[str] = None,
) -> Optional[bytes]:
    """reference 썸네일에 castPhoto 얼굴 + 새 caption 교체.

    - reference: 실제 방송사 썸네일 (템플릿 역할)
    - cast_photos: 얼굴 교체용 이미지들 (2~4장)
    - caption: 새 자막 문장 (기존 자막 위치 유지 · 문장만 교체)
    """
    cast_names = cast_names or []
    who = " · ".join(cast_names) if cast_names else f"{len(cast_photos)}명"

    prompt = (
        f"이 방송사 유튜브 썸네일의 **구도·배경·색상·타이포그래피·로고·장식 요소**는 완벽히 유지.\n\n"
        f"**변경 사항 2가지만**:\n"
        f"1. **인물 얼굴 교체**: 원본 인물의 얼굴을 아래 첨부된 인물 사진으로 정확히 교체.\n"
        f"   - 첨부 인물: {who}\n"
        f"   - **얼굴 identity 100% 유지** · 원본 스타일·표정 방향은 참고하되 얼굴은 첨부 인물\n"
        f"   - 배치·크기·조명은 원본 자리 그대로\n\n"
        f"2. **자막 텍스트 교체**: 원본 자막(카피/제목) 을 이 문장으로 교체:\n"
        f"   \"{caption}\"\n"
        f"   - 폰트·색상·크기·위치·배지는 원본 그대로 · 오직 문장만 교체\n"
        f"   - **오타 X · 이모지 X · 한글 그대로**\n\n"
        f"**절대 변경 X**: 배경 · 색 톤 · 하트/장식 · 로고 · 밝기 · 프레임 비율 · 다른 텍스트."
    )

    client = _client(project)
    try:
        cfg = types.GenerateContentConfig(
            response_modalities=["IMAGE", "TEXT"],
            image_config=types.ImageConfig(aspect_ratio="16:9"),
        )
    except Exception:
        cfg = types.GenerateContentConfig(response_modalities=["IMAGE", "TEXT"])

    parts: list = [
        types.Part.from_bytes(data=reference.read_bytes(), mime_type=_mime(reference)),
    ]
    for cp in cast_photos:
        try:
            parts.append(types.Part.from_bytes(data=cp.read_bytes(), mime_type=_mime(cp)))
        except Exception:
            pass
    parts.append(types.Part.from_text(text=prompt))

    resp = client.models.generate_content(model=MODEL, contents=parts, config=cfg)
    for c in resp.candidates or []:
        for p in (c.content.parts or []):
            if getattr(p, "inline_data", None) and p.inline_data.data:
                return p.inline_data.data
    return None


if __name__ == "__main__":
    import argparse, sys, time
    ap = argparse.ArgumentParser()
    ap.add_argument("--reference", required=True, help="레퍼런스 썸네일 이미지 경로")
    ap.add_argument("--media-dir", required=True, help="workdir · cast_photos/derived_cast 조회")
    ap.add_argument("--cast", required=True, help="교체할 인물 이름 comma-separated (예: 민경,백현)")
    ap.add_argument("--caption", required=True, help="새 자막 문장")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    from . import person_compositor as PC

    ref = pathlib.Path(args.reference).resolve()
    if not ref.exists():
        print(f"[FAIL] ref 없음: {ref}", file=sys.stderr); sys.exit(1)
    media = pathlib.Path(args.media_dir).resolve()

    names = [n.strip() for n in args.cast.split(",") if n.strip()]
    photos: list[pathlib.Path] = []
    resolved: list[str] = []
    for nm in names:
        derived = PC.derive_person_source(nm, media)
        if derived and derived.exists():
            photos.append(derived); resolved.append(nm); continue
        # cast_photos 폴백
        cd = media / "cast_photos"
        if cd.exists():
            for ext in ("jpg","jpeg","png","webp"):
                p = cd / f"{nm}.{ext}"
                if p.exists():
                    photos.append(p); resolved.append(nm); break
    print(f"[swap] ref={ref.name} · cast requested={names} resolved={resolved}")
    if not photos:
        print("[FAIL] 매칭되는 인물 사진 없음", file=sys.stderr); sys.exit(2)

    out_dir = pathlib.Path(args.out).resolve() if args.out else \
              pathlib.Path("logs/thumbnail-swap") / time.strftime("%Y%m%d-%H%M%S")
    out_dir.mkdir(parents=True, exist_ok=True)

    img = swap_thumbnail(reference=ref, cast_photos=photos, cast_names=resolved,
                         caption=args.caption)
    if not img:
        print("[FAIL] swap 응답 없음", file=sys.stderr); sys.exit(2)
    dest = out_dir / "swap.png"
    dest.write_bytes(img)
    print(f"[ok] {dest}")
