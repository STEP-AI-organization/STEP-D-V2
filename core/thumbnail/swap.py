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
import pathlib
from typing import Optional

from ..models import IMAGE_PRO as MODEL
from ..openai_client import edit as openai_edit


def _mime(p: pathlib.Path) -> str:
    m, _ = mimetypes.guess_type(str(p))
    return m or "image/jpeg"


def swap_thumbnail(
    reference: pathlib.Path,
    cast_photos: list[pathlib.Path],
    caption: str = "",
    cast_names: Optional[list[str]] = None,
    captions: Optional[dict] = None,  # 신규 · {main, sub, quote, badge} 슬롯별
    project: Optional[str] = None,
) -> Optional[bytes]:
    """reference 썸네일에 castPhoto 얼굴 + 새 caption 교체.

    - reference: 실제 방송사 썸네일 (템플릿 역할)
    - cast_photos: 얼굴 교체용 이미지들 (2~4장)
    - caption (legacy): 단일 자막 문장
    - captions (신규): {main, sub, quote, badge} · cleaned template 슬롯별
    """
    cast_names = cast_names or []
    who = " · ".join(cast_names) if cast_names else f"{len(cast_photos)}명"

    # cleaned template 여부에 따라 프롬프트 다르게
    is_cleaned = "cleaned" in str(reference).lower() or reference.name.endswith("_clean.png")
    if is_cleaned:
        # captions dict 있으면 슬롯별 · 없으면 legacy caption 을 main 으로
        cap = captions if isinstance(captions, dict) else {"main": caption}
        slot_lines = []
        for k in ["main", "sub", "quote", "badge"]:
            v = (cap.get(k) or "").strip()
            if v:
                slot_lines.append(f"   · '{k}' 슬롯 → \"{v}\"")
        slot_text = "\n".join(slot_lines) if slot_lines else f"   · 메인 슬롯 → \"{caption}\""
        prompt = (
            f"이 이미지는 슬롯 라벨이 있는 **template** 이다.\n"
            f"슬롯 안 텍스트/실루엣을 다음으로 정확히 교체:\n\n"
            f"**1) 인물 실루엣 → 실제 얼굴**\n"
            f"   - 회색 사람 실루엣 자리에 첨부 인물 얼굴로 교체\n"
            f"   - 첨부 인물: {who}\n"
            f"   - **얼굴 identity 100% 유지** · 자세·크기·위치·의상은 실루엣 그대로\n\n"
            f"**2) 슬롯 라벨 → 실제 자막 (슬롯별 매핑)**\n"
            f"{slot_text}\n"
            f"   - 슬롯 매칭: '아래 메인'→main · '아래 부제'→sub · '인용'→quote · '배지'→badge\n"
            f"   - 폰트/색/pill 배경/위치는 원본 슬롯 스타일 그대로\n"
            f"   - **원본 라벨 문구('아래 메인' '인용' 등) 한 글자도 남기지 마**\n"
            f"   - 채우지 않는 슬롯 (위 목록에 없는 슬롯) 은 라벨 문구 지우고 비워두거나 제거\n"
            f"   - 오타 X · 이모지 X · 한글 정확\n\n"
            f"**절대 유지**: 배경·색 톤·장식(하트/도형)·pill 배경·프레임 비율."
        )
    else:
        prompt = (
            f"이 방송사 유튜브 썸네일의 **구도·배경·색상·타이포그래피·로고·장식(하트/배지 형태)**은 완벽히 유지.\n\n"
            f"**필수 교체 2가지 · 원본 잔재 절대 남기지 마**:\n\n"
            f"1. **모든 인물 얼굴 교체** · 원본에 나오는 얼굴을 **하나도 빠짐없이** 아래 첨부 인물로 교체.\n"
            f"   - 첨부 인물: {who}\n"
            f"   - **얼굴 identity 100% 유지** (첨부 사진의 얼굴 그대로)\n"
            f"   - 표정 방향·머리 각도는 원본 참고 · 얼굴 자체는 첨부 인물\n"
            f"   - 원본 프로그램의 원래 인물 얼굴은 **하나도 남기지 마** (배경 원경 포함)\n\n"
            f"2. **모든 자막 텍스트 교체** · 원본의 모든 한글 문장(메인 카피·부제·인용문·배지 라벨 등)을\n"
            f"   아래 **이 문장 하나**로 통합·교체:\n"
            f"   \"{caption}\"\n"
            f"   - 원본 자막 문장은 **한 글자도 남기지 마** · 위 문장 딱 하나만 렌더\n"
            f"   - 폰트 스타일·색·굵기·위치는 원본 메인 카피 자리 참고 · 사이즈는 문장 길이에 맞게\n"
            f"   - **오타 절대 X · 이모지 X · 한글 정확**\n\n"
            f"**절대 유지**: 배경 씬 · 색 톤 · 하트/배지 형태 그래픽 · 로고 · 프레임 비율.\n"
            f"**절대 변경**: 원본 인물 얼굴 · 원본 자막 문장."
        )

    # 2026-07-30 OpenAI 전환: reference 썸네일 + castPhoto 여러 장 → images.edit
    images: list[bytes] = [reference.read_bytes()]
    for cp in cast_photos:
        try:
            images.append(cp.read_bytes())
        except Exception:
            pass
    return openai_edit(images=images, prompt=prompt, model=MODEL, size="1536x1024")


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
