"""프레임에 구워진 화면 자막(burned-in caption) 검출.

사용자 지시 (2026-08-06): "자막 없는 프레임 고르게."

배경으로 쓸 프레임이나 인물 crop 에 방송 자막이 박혀 있으면 누끼로도 안 빠지고
합성 결과에 그대로 남는다. 지우는 것보다 **애초에 없는 프레임을 고르는 편**이 싸다.

Vision 호출을 쓰지 않는다 — 프레임마다 부르면 후보 14장에 14콜이고, 이 판정은
결정론이어야 같은 영상에서 같은 프레임이 선택된다.

한국 예능 자막의 성질을 쓴다:
- 화면 하단~중단에 몰려 있다
- 굵은 외곽선을 두른 고대비 글자 → 국소 gradient 가 매우 높다
- 가로로 길게 이어진 띠 형태로 나타난다

즉 "특정 가로 밴드에서만 edge 밀도가 튀는가"를 본다.
"""
from __future__ import annotations

import pathlib
from typing import Any


def caption_score(path: str | pathlib.Path, band: tuple[float, float] = (0.45, 0.98)) -> float:
    """0~1. 클수록 자막이 있을 가능성이 높다.

    밴드 안에서 edge 밀도가 가장 높은 몇 개 행이 화면 전체 평균 대비 얼마나
    튀는지를 본다. 배경이 원래 복잡한 장면에서도 자막만큼 좁고 강한 띠는
    잘 안 생긴다.
    """
    import numpy as np
    from PIL import Image

    im = Image.open(path).convert("L")
    a = np.asarray(im).astype(np.float32)
    h, w = a.shape
    if h < 32 or w < 32:
        return 0.0

    gx = np.abs(np.diff(a, axis=1))
    edge = (gx > 40).astype(np.float32)      # 외곽선 글자는 급격한 밝기 변화를 만든다
    row = edge.mean(axis=1)[:, ]             # 행별 edge 밀도
    row = row[: gx.shape[0]] if row.shape[0] > gx.shape[0] else row

    base = float(np.median(row)) + 1e-6
    y0, y1 = int(h * band[0]), int(h * band[1])
    sub = row[y0:y1]
    if sub.size == 0:
        return 0.0

    # 밴드 안 상위 5% 행의 평균이 전체 중앙값의 몇 배인가
    k = max(1, int(sub.size * 0.05))
    peak = float(np.sort(sub)[-k:].mean())
    ratio = peak / base

    # 3배를 넘어가면 자막으로 본다. 8배 이상은 확실.
    return float(min(max((ratio - 3.0) / 5.0, 0.0), 1.0))


def has_caption(path: str | pathlib.Path, threshold: float = 0.35) -> bool:
    return caption_score(path) >= threshold


def annotate(frames: list[dict[str, Any]], threshold: float = 0.35) -> list[dict[str, Any]]:
    """frame 목록에 hasCaption·captionScore 를 채워 넣는다 (in-place)."""
    for f in frames:
        p = f.get("path")
        if not p:
            continue
        s = caption_score(p)
        f["captionScore"] = round(s, 3)
        f["hasCaption"] = s >= threshold
    return frames
