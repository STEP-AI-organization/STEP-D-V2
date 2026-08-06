"""썸네일 생성 — 사진 몇 장 + 한 줄 지시.

사용자 실측 (2026-08-06): 인물 사진 2장에 한국어 한 줄만 주면 방송급 썸네일이
나온다. 반면 템플릿 이미지·배경 지정·영문 40줄 스펙·금지 항목 20개를 붙인
compose.py 경로는 결과가 나빴다. 모델을 돕는 게 아니라 묶고 있었다.

무엇을 **하지 않는지**가 이 모듈의 핵심이다:
- 구조 템플릿 이미지를 넣지 않는다 (회색 실루엣·라벨 해석에 힘을 뺀다)
- 제목 영역을 비우라고 하지 않는다 (완성도 반쯤인 그림이 나온다)
- 누끼·색보정·그림자·림라이트를 우리가 하지 않는다 (모델이 더 잘한다)
- 한글 자막을 Pillow 로 얹지 않는다 (2026-07-27 판단은 당시 모델 기준.
  지금 모델은 한글 제목을 오타 없이 렌더한다 — 재검증 후 이 경로로 전환)

입력 순서는 인물들 → 배경. 배경을 안 주면 모델이 장소를 지어내므로,
회차의 실제 장면을 살리려면 배경 프레임을 함께 준다.
"""
from __future__ import annotations

import pathlib
from typing import Any, Optional


def build_prompt(
    plan: dict[str, Any],
    program_title: str = "",
    with_background: bool = True,
) -> str:
    """기획 → 한국어 지시문. 길게 쓰지 않는다 — 길수록 결과가 나빠졌다."""
    people = plan.get("people") or []
    n = len(people) or int(plan.get("personCount") or 2)
    show = f"'{program_title}' " if program_title else ""

    src = (f"앞의 인물 사진 {n}장과 마지막 배경 사진을 바탕으로"
           if with_background else f"이 인물 사진 {n}장을 바탕으로")

    lines = [
        f"{src}, 인물 {n}명이 나와 있는 {show}유튜브 썸네일을 만들어줘.",
        "인물들의 얼굴과 표정은 그대로 유지해줘.",
    ]
    if with_background:
        lines.append("배경은 마지막 사진의 장소를 살려줘.")

    t1 = (plan.get("title1") or "").strip()
    t2 = (plan.get("title2") or "").strip()
    titles = [t for t in (t1, t2) if t]
    if titles:
        quoted = " 과 ".join(f"'{t}'" for t in titles)
        lines.append(f"제목은 {quoted} {len(titles)}줄로 넣어줘.")

    mood = ", ".join(plan.get("mood") or [])
    if mood:
        lines.append(f"분위기는 {mood}.")
    return " ".join(lines)


def generate(
    person_paths: list[pathlib.Path],
    plan: dict[str, Any],
    background_path: Optional[pathlib.Path] = None,
    program_title: str = "",
    n: int = 1,
    model: Optional[str] = None,
    size: str = "1536x1024",
) -> list[bytes]:
    """썸네일 후보 n장. 실패한 호출은 결과에서 빠진다."""
    from core.models import IMAGE_PRO
    from core.openai_client import edit as openai_edit

    images = [pathlib.Path(p).read_bytes() for p in person_paths]
    if background_path is not None:
        images.append(pathlib.Path(background_path).read_bytes())

    prompt = build_prompt(plan, program_title, with_background=background_path is not None)
    out: list[bytes] = []
    for _ in range(n):
        img = openai_edit(images=images, prompt=prompt,
                          model=model or IMAGE_PRO, size=size)
        if img:
            out.append(img)
    return out
