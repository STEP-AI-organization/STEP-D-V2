"""castPhoto 를 배경 이미지 위에 합성 · 얼굴 identity 100% 유지.

사용자 원칙 (2026-07-28):
"실제 프로그램인데 사람들 얼굴이 너무 변형되는 이슈"
"인물 누끼 따는거 이제 폰에서도 완벽하게 · 잘해봐"
"누끼 딸 때는 자막 없는 프레임 해야 함 · 자막이 같이 딸려옴"
"캔바 같은 거만 해도 잘 되던데 · 뭐 상용 API 쓰던가"

세그 우선순위:
1. REMOVEBG_API_KEY 환경변수 있으면 → remove.bg API (상용 · 품질 최고)
2. 없으면 → rembg birefnet-portrait (로컬 폴백)
"""
from __future__ import annotations

import io
import os
import pathlib
from typing import Optional

from PIL import Image

REMOVEBG_URL = "https://api.remove.bg/v1.0/removebg"

_LOCAL_SESSION = None
def _get_local_session():
    global _LOCAL_SESSION
    if _LOCAL_SESSION is None:
        from rembg import new_session
        _LOCAL_SESSION = new_session("birefnet-portrait")
    return _LOCAL_SESSION


def _cutout_removebg(img_path: pathlib.Path) -> Image.Image:
    """remove.bg API 로 배경 제거 · RGBA."""
    import urllib.request, urllib.error
    api_key = os.environ.get("REMOVEBG_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("REMOVEBG_API_KEY 없음")
    # multipart/form-data 수동 구성
    import uuid
    boundary = "----stepd" + uuid.uuid4().hex
    lines = [
        f"--{boundary}",
        'Content-Disposition: form-data; name="image_file"; filename="in.jpg"',
        "Content-Type: application/octet-stream",
        "",
    ]
    body_prefix = "\r\n".join(lines).encode("utf-8") + b"\r\n"
    body_middle = img_path.read_bytes()
    body_suffix = (
        f"\r\n--{boundary}\r\n"
        f'Content-Disposition: form-data; name="size"\r\n\r\nauto\r\n'
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="type"\r\n\r\nperson\r\n'
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="format"\r\n\r\npng\r\n'
        f"--{boundary}--\r\n"
    ).encode("utf-8")
    body = body_prefix + body_middle + body_suffix
    req = urllib.request.Request(REMOVEBG_URL, data=body, method="POST", headers={
        "X-Api-Key": api_key,
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"remove.bg HTTP {e.code} · {e.read()[:200]!r}") from e
    return Image.open(io.BytesIO(data)).convert("RGBA")


def _cutout_local(img_path: pathlib.Path) -> Image.Image:
    """rembg 로컬 세그 · RGBA."""
    from rembg import remove
    out = remove(img_path.read_bytes(), session=_get_local_session())
    return Image.open(io.BytesIO(out)).convert("RGBA")


# 9 슬롯 앵커 (caption_overlay 와 동일 좌표계)
POSITION_ANCHORS: dict[str, tuple[float, float, str, str]] = {
    "top-left":       (0.05, 0.05, "left",   "top"),
    "top-center":     (0.50, 0.05, "center", "top"),
    "top-right":      (0.95, 0.05, "right",  "top"),
    "middle-left":    (0.05, 0.50, "left",   "middle"),
    "middle-center":  (0.50, 0.50, "center", "middle"),
    "middle-right":   (0.95, 0.50, "right",  "middle"),
    "bottom-left":    (0.05, 1.00, "left",   "bottom"),
    "bottom-center":  (0.50, 1.00, "center", "bottom"),
    "bottom-right":   (0.95, 1.00, "right",  "bottom"),
}

# 인물 크기 · 배경 이미지 높이 대비 인물 최종 높이 비율
PERSON_SIZE_RATIO = {"S": 0.45, "M": 0.60, "L": 0.75, "XL": 0.95}


def cutout_person(img_path: pathlib.Path) -> Image.Image:
    """배경 제거 → RGBA · remove.bg 우선 · 로컬 폴백."""
    if os.environ.get("REMOVEBG_API_KEY", "").strip():
        try:
            return _cutout_removebg(img_path)
        except Exception as e:
            import sys as _sys
            print(f"[cutout] remove.bg fail · fallback local · {str(e)[:150]}", file=_sys.stderr)
    return _cutout_local(img_path)


# ═════════════════════════════════════════════════════════════════════
# faces.json full_frames 에서 상반신 자동 crop (자막 배제)
# ═════════════════════════════════════════════════════════════════════
# 사용자 지시 (2026-07-28):
# "누끼 딸 때는 자막 없는 프레임 해야 함 · 자막이 같이 딸려옴"
# full_frame 은 자막 있음 → 하단 CAPTION_BAND_RATIO 만큼 자르고 세그

CAPTION_BAND_RATIO = 0.25  # 하단 25% = 자막 영역 heuristic (한국 방송 통상)
_DERIVED_CACHE: dict[tuple[str, str], pathlib.Path] = {}


def derive_person_source(name: str, media_dir: pathlib.Path) -> Optional[pathlib.Path]:
    """cast name → faces.json cluster mapping → 상반신 crop 파일 경로.

    - faces.json.mapping[cluster_id] == name 인 cluster 찾음
    - clusters[cid].full_frames 목록의 첫 이미지 사용
    - 하단 25% (자막 밴드) 제거한 upper body crop 을 workdir/derived_cast/ 에 저장
    - 이미 캐시 있으면 재사용
    """
    import json
    cache_key = (str(media_dir), name)
    if cache_key in _DERIVED_CACHE:
        cached = _DERIVED_CACHE[cache_key]
        if cached.exists():
            return cached

    faces_path = media_dir / "faces.json"
    if not faces_path.exists():
        return None
    try:
        faces_data = json.loads(faces_path.read_text(encoding="utf-8"))
    except Exception:
        return None

    mapping = faces_data.get("mapping", {}) or {}
    clusters = faces_data.get("clusters", {}) or {}
    matched_cids = [cid for cid, nm in mapping.items() if nm == name]
    if not matched_cids:
        return None

    # 첫 매칭 cluster 의 full_frames 사용 (선호: 가장 큰 count)
    matched_cids.sort(key=lambda c: -int((clusters.get(c) or {}).get("count", 0)))
    for cid in matched_cids:
        cluster = clusters.get(cid) or {}
        full_frames = cluster.get("full_frames") or []
        for rel in full_frames:
            fp = media_dir / rel
            if not fp.exists():
                continue
            # 상반신 crop 저장
            out_dir = media_dir / "derived_cast"
            out_dir.mkdir(parents=True, exist_ok=True)
            out_path = out_dir / f"{name}_upper.jpg"
            try:
                img = Image.open(fp).convert("RGB")
                w, h = img.size
                # 하단 자막 밴드 제거
                cropped_h = int(h * (1.0 - CAPTION_BAND_RATIO))
                img.crop((0, 0, w, cropped_h)).save(out_path, quality=92)
                _DERIVED_CACHE[cache_key] = out_path
                return out_path
            except Exception:
                continue
    return None


def _crop_to_content(rgba: Image.Image) -> Image.Image:
    """alpha 채널의 bbox 로 여백 크롭."""
    bbox = rgba.getbbox()
    if bbox:
        return rgba.crop(bbox)
    return rgba


def composite_persons(
    bg_bytes: bytes,
    person_layouts: list[dict],
    cast_photo_paths: dict[str, pathlib.Path],
) -> bytes:
    """배경 이미지 위에 계획된 인물들 합성.

    person_layouts: [{name, position, size}]
    cast_photo_paths: {name: Path} · 매핑되지 않는 이름은 스킵
    """
    bg = Image.open(io.BytesIO(bg_bytes)).convert("RGBA")
    W, H = bg.size

    # z_index 낮은 순 (뒤부터) 렌더 · 없으면 배열 순서
    layouts = sorted(person_layouts or [], key=lambda p: p.get("z_index", 0))

    for pl in layouts:
        name = pl.get("name", "")
        photo = cast_photo_paths.get(name)
        if not photo or not photo.exists():
            continue
        try:
            cutout = cutout_person(photo)
            cutout = _crop_to_content(cutout)
        except Exception as e:
            import sys as _sys
            print(f"[person_compositor] cutout fail · {name} · {str(e)[:120]}", file=_sys.stderr)
            continue
        # 크기 조정 (인물 높이 기준)
        target_h = max(1, int(H * PERSON_SIZE_RATIO.get(pl.get("size", "L"), PERSON_SIZE_RATIO["L"])))
        src_w, src_h = cutout.size
        scale = target_h / src_h
        new_w = max(1, int(src_w * scale))
        cutout = cutout.resize((new_w, target_h), Image.LANCZOS)

        # 앵커 위치
        ax, ay, ha, va = POSITION_ANCHORS.get(
            pl.get("position", "middle-center"), POSITION_ANCHORS["middle-center"])
        px, py = int(W * ax), int(H * ay)
        if ha == "left":   x = px
        elif ha == "center": x = px - new_w // 2
        else:              x = px - new_w
        if va == "top":    y = py
        elif va == "middle": y = py - target_h // 2
        else:              y = py - target_h

        bg.alpha_composite(cutout, (x, y))

    out = io.BytesIO()
    bg.convert("RGB").save(out, format="PNG", optimize=True)
    return out.getvalue()
