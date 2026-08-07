"""썸네일 에셋 경로 — 프로그램 단위.

사용자 지시 (2026-08-07): "프로그램별로 나는솔로뿐 아니라 모든 프로그램에서
배선할 수 있게 프로파일링 · 실서비스에 배선."

로컬 스크립트에선 리포의 assets/ 를, 워커/Cloud Run 에선 STEPD_STORAGE_DIR 아래를
쓰도록 루트를 env 로 뺀다. 디렉토리 키는 **프로그램 ID** — 제목은 바뀌고 겹치지만
ID 는 안 그렇다. 사람이 폴더를 열어볼 땐 헷갈리므로 각 프로그램 폴더에
program.json(제목)을 같이 남긴다.

    <root>/thumbnail-style/<programId>/thumbs/*.jpg
                                      /style_profile.json
                                      /style_prompt.txt
                                      /refs.json
                                      /program.json
    <root>/cast/<programId>/<출연자명>/*.jpg
"""
from __future__ import annotations

import json
import os
import pathlib

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]


def assets_root() -> pathlib.Path:
    """에셋 루트. THUMB_ASSETS_DIR > STEPD_STORAGE_DIR/thumbnail > 리포 assets/."""
    explicit = os.environ.get("THUMB_ASSETS_DIR", "").strip()
    if explicit:
        return pathlib.Path(explicit)
    storage = os.environ.get("STEPD_STORAGE_DIR", "").strip()
    if storage:
        return pathlib.Path(storage) / "thumbnail-assets"
    return REPO_ROOT / "assets"


def style_dir(program_id: str) -> pathlib.Path:
    return assets_root() / "thumbnail-style" / (program_id or "_default")


def cast_dir(program_id: str) -> pathlib.Path:
    return assets_root() / "cast" / (program_id or "_default")


def write_program_meta(program_id: str, title: str, channel_url: str = "") -> None:
    """폴더만 보고도 어느 프로그램인지 알 수 있게 남긴다."""
    d = style_dir(program_id)
    d.mkdir(parents=True, exist_ok=True)
    (d / "program.json").write_text(
        json.dumps({"programId": program_id, "title": title,
                    "channelUrl": channel_url}, ensure_ascii=False, indent=2),
        encoding="utf-8")


def program_title(program_id: str, fallback: str = "") -> str:
    p = style_dir(program_id) / "program.json"
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8")).get("title") or fallback
        except Exception:
            pass
    return fallback
