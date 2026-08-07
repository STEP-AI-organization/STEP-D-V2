"""출연자 등록부 — 사람이 채우고, 엔진은 읽기만 한다.

사용자 지시 (2026-08-07):
  "이건 사람이 캐스팅 등록해주는 게 맞다. 사람이 하는 걸로 놔둬."
  "face 는 좀 과하다. 파이프라인에서 빼도 된다."

그래서 얼굴 검출·임베딩·클러스터링을 쓰지 않는다. 등록된 사진을 **그대로**
생성기에 넣는다. 누가 영수인지는 사람이 폴더명으로 이미 답했으므로,
기계가 다시 판정할 이유가 없다.

디렉토리 구조 (사람이 만든다):

    assets/cast/<프로그램>/<출연자명>/*.jpg|png    # 1인당 1~3장

    assets/cast/나는솔로/영수/01.jpg
    assets/cast/나는솔로/정숙/01.jpg

등록이 없으면 **아무나 뽑는 대신 멈춘다**. 인물을 잘못 넣은 썸네일은
품질 문제가 아니라 사고다.
"""
from __future__ import annotations

import pathlib
from typing import Optional

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp"}


def registry_dir(program: str) -> pathlib.Path:
    """program 은 프로그램 ID. 루트는 env 로 바뀐다 (paths.assets_root)."""
    from core.thumbnail.paths import cast_dir
    return cast_dir(program)


def list_registered(program: str) -> dict[str, list[pathlib.Path]]:
    """{출연자명: [사진 경로]}. 등록이 없으면 빈 dict."""
    d = registry_dir(program)
    if not d.is_dir():
        return {}
    out: dict[str, list[pathlib.Path]] = {}
    for person in sorted(d.iterdir()):
        if not person.is_dir():
            continue
        photos = sorted(p for p in person.iterdir() if p.suffix.lower() in IMAGE_EXT)
        if photos:
            out[person.name] = photos
    return out


def photo_for(program: str, name: str) -> Optional[pathlib.Path]:
    """그 인물의 대표 사진 1장. 없으면 None."""
    photos = list_registered(program).get((name or "").strip())
    return photos[0] if photos else None


def resolve_plan_people(program: str, plan_people: list[dict]) -> tuple[list[pathlib.Path], list[str]]:
    """기획이 지목한 인물 → (사진 경로들, 빠진 것들).

    빠진 게 하나라도 있으면 생성하지 않는다 — 없는 인물을 넣으면 모델이 지어낸다.
    """
    registered = list_registered(program)
    paths: list[pathlib.Path] = []
    missing: list[str] = []
    for p in plan_people or []:
        name = (p.get("castName") or "").strip()
        if not name:
            missing.append(f"{p.get('slotId') or 'person'}: 기획이 인물을 특정하지 않음")
            continue
        photos = registered.get(name)
        if not photos:
            missing.append(name)
            continue
        paths.append(photos[0])
    return paths, missing


def how_to_register(program: str) -> str:
    d = registry_dir(program)
    return (f"출연자 사진을 등록해 주세요:\n"
            f"  {d}\\<출연자명>\\01.jpg   (1인당 1~3장 · 얼굴이 크게 나온 것)\n"
            f"등록된 이름과 기획의 인물명이 같아야 매칭됩니다.")
