"""썸네일 — **프레임 + 자막** 방식 (AI 생성 없이).

두 갈래 중 무난한 쪽이다(사용자 확정 2026-08-16).

| 방식 | 무엇 | 필요한 것 | 실패 조건 |
|---|---|---|---|
| `ai` (generate.py) | 서사 기획 + 인물 누끼 → 모델이 그린다 | **등록 출연자 사진** · 이미지 생성 API | 인물 미등록이면 아예 못 만든다 |
| `frame` (여기) | 영상 프레임 한 장 + 자막 오버레이 | 원본 영상 하나 | 사실상 없다 |

왜 나눴나: AI 방식은 그림이 좋을 때 아주 좋지만 **인물 등록이 선행돼야** 하고 생성 API 가
붙는다. 방송사 아카이브처럼 캐스트가 안 채워진 회차가 대량으로 들어오면 그쪽은 한 장도 못
만든다. 프레임 방식은 실제 화면이라 **얼굴 identity 가 100% 보존**되고(합성이 아니다),
자막만 Pillow 로 얹으므로 한글 오타도 원천적으로 없다.

자막 원칙은 그대로다 — **핵심 + 어그로**, 감상형 금지, 이모지 금지(caption_overlay 가 뗀다).
"""
from __future__ import annotations

import json
import pathlib
from typing import Any, Optional

#: 프레임 후보를 몇 장 뽑아 볼지. 이 중에서 선명하고 번인 자막이 적은 것을 고른다.
FRAME_POOL = 12
#: 후보끼리 이만큼은 떨어져야 한다. 실측(2026-08-16)에서 260.03s·260.07s 가 함께 뽑혀
#: 후보 3장 중 2장이 사실상 같은 그림이었다 — 고를 이유가 없는 목록이 된다.
MIN_GAP_SEC = 20.0
#: 유튜브 권장 규격. 원본 1920x1080 PNG 로 두면 1~1.3MB 라 2MB 상한에 붙는다(실측).
OUT_W, OUT_H = 1280, 720
JPEG_QUALITY = 88


def _pick_caption(analysis_dir: pathlib.Path, fallback: str) -> str:
    """썸네일에 얹을 한 줄.

    새로 짓지 않는다 — 추천 단계가 이미 어그로 톤으로 뽑아 둔 제목·훅 자막을 그대로 쓴다
    (LLM 을 또 부르면 비용도 들고 회차마다 문구가 달라진다).
    """
    for name, keys in (
        ("analysis.json", ("hook_intro_caption", "title_line1", "title")),
        ("shorts.json", ("hook_intro_caption", "title_line1", "title")),
    ):
        p = analysis_dir / name
        if not p.exists():
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        shorts = data.get("shorts") if isinstance(data, dict) else data
        if not isinstance(shorts, list):
            continue
        # 점수 높은 것부터 — 그 회차에서 가장 세게 미는 문구가 썸네일에도 맞다.
        for s in sorted(
            [x for x in shorts if isinstance(x, dict)],
            key=lambda x: -(x.get("score100") or 0),
        ):
            for k in keys:
                v = str(s.get(k) or "").strip()
                if v:
                    return v[:22]
    return (fallback or "").strip()[:22]


def _frame_score(path: pathlib.Path) -> float:
    """선명도 × 밝기 적정 × **번인 자막 없음** — 셋 다 실측에서 문제가 된 축이다.

    얼굴 검출까지 하지 않는다(모델 로딩 비용이 이 방식의 장점을 깎는다). 실무에서
    문제가 되는 것은 '컷 전환 순간의 흐릿한 프레임'·'암전', 그리고 방송 아카이브 특유의
    **화면에 구워진 자막**이다 — 그 위에 우리 자막을 또 얹으면 둘 다 안 읽힌다
    (2026-08-16 실측: 나는 SOLO 프레임에서 정면충돌).
    """
    import numpy as np
    from PIL import Image

    im = Image.open(path).convert("L")
    a = np.asarray(im).astype(float)
    if a.size == 0:
        return 0.0
    lap = (-4 * a[1:-1, 1:-1] + a[:-2, 1:-1] + a[2:, 1:-1] + a[1:-1, :-2] + a[1:-1, 2:])
    sharp = float(lap.var())
    mean = float(a.mean())
    # 너무 어둡거나(<35) 너무 밝은(>225) 프레임은 자막을 얹어도 안 읽힌다.
    bright_fit = 1.0 if 35 <= mean <= 225 else 0.2
    # 번인 자막이 짙을수록 감점. 0(없음)~1(가득) → 배수 1.0~0.25.
    try:
        from core.thumbnail.caption_detect import caption_score
        cap = float(caption_score(path))
    except Exception:
        cap = 0.0
    caption_fit = max(0.25, 1.0 - cap)
    return sharp * bright_fit * caption_fit


def _save_jpeg(img_bytes: bytes, dest: pathlib.Path) -> None:
    """1280x720 JPEG 로 저장 — 유튜브 권장 규격이자 2MB 상한에서 여유를 만든다."""
    import io

    from PIL import Image

    im = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    if im.size != (OUT_W, OUT_H):
        im = im.resize((OUT_W, OUT_H), Image.LANCZOS)
    im.save(dest, format="JPEG", quality=JPEG_QUALITY, optimize=True)


def _caption_position(path: pathlib.Path) -> str:
    """우리 자막을 어디에 놓을지 — 번인 자막을 피한다.

    방송 자막은 대개 하단에 깔린다. 그 자리에 또 얹으면 둘 다 못 읽으므로, 하단에
    자막 띠가 잡히면 위로 올린다.
    """
    try:
        from core.thumbnail.caption_detect import caption_band
        band = caption_band(path)
    except Exception:
        band = None
    if not band:
        return "bottom-left"
    top, bottom = band
    # 띠가 화면 아래쪽(중앙보다 아래)에 걸쳐 있으면 상단으로 피한다.
    return "top-left" if bottom > 0.55 else "bottom-left"


def run_frame(
    media_id: str,
    program_id: str,
    analysis_dir: pathlib.Path,
    out_dir: pathlib.Path,
    program_title: str = "",
    video_path: Optional[pathlib.Path] = None,
    candidates: int = 3,
    api_base: Optional[str] = None,
    caption: str = "",
) -> dict[str, Any]:
    """영상 프레임 + 자막으로 썸네일 후보를 만든다."""
    from core.thumbnail.caption_overlay import render_captions
    from core.thumbnail.generate import _extract_frame
    from core.thumbnail.sourcing import sample_secs, search_windows

    out_dir.mkdir(parents=True, exist_ok=True)
    if not video_path or not video_path.exists():
        return {"ok": False, "mediaId": media_id, "mode": "frame",
                "error": "video_required",
                "hint": "프레임 방식은 원본 영상이 있어야 한다 — --video 를 넘길 것"}

    text = caption or _pick_caption(analysis_dir, program_title)

    # 1) 어디서 뽑을까 — 검색엔진이 살아 있으면 의미로 고르고, 아니면 영상 전체에서 고르게 샘플.
    windows: list[dict] = []
    try:
        query = text or program_title
        if query:
            windows = search_windows(query, media_id=media_id, limit=8, api_base=api_base)
    except Exception:
        windows = []          # 검색이 죽어도 썸네일은 나와야 한다
    if not windows:
        dur = 0.0
        try:
            info = json.loads((analysis_dir / "analysis.json").read_text(encoding="utf-8"))
            dur = float(info.get("duration") or 0.0)
        except Exception:
            dur = 0.0
        if dur <= 0:
            dur = 600.0       # 길이를 모르면 앞 10분에서 고른다
        # 앞뒤 10% 는 오프닝·엔딩이라 피한다.
        lo, hi = dur * 0.1, dur * 0.9
        step = max(1.0, (hi - lo) / FRAME_POOL)
        windows = [{"start": lo + i * step, "end": lo + i * step + 0.1} for i in range(FRAME_POOL)]

    # 2) 프레임을 뽑아 점수순으로 정렬.
    picks: list[dict] = []
    for i, sec in enumerate(sample_secs(windows, per_window=2)[:FRAME_POOL]):
        dest = out_dir / "frames" / f"f_{i:02d}_{sec:.1f}.jpg"
        if not _extract_frame(video_path, sec, dest):
            continue
        try:
            picks.append({"path": dest, "sec": sec, "score": _frame_score(dest)})
        except Exception:
            continue
    if not picks:
        return {"ok": False, "mediaId": media_id, "mode": "frame",
                "error": "no_frame", "hint": "ffmpeg 로 프레임을 한 장도 못 뽑았다"}
    picks.sort(key=lambda p: -p["score"])

    # 점수순으로 고르되 **서로 떨어진 시각**만 남긴다 — 안 그러면 0.04초 차이로 사실상
    # 같은 그림이 후보 목록을 채운다(실측). 고를 이유가 없는 목록은 없는 것과 같다.
    chosen: list[dict] = []
    for p in picks:
        if any(abs(p["sec"] - q["sec"]) < MIN_GAP_SEC for q in chosen):
            continue
        chosen.append(p)
        if len(chosen) >= max(1, candidates):
            break

    # 3) 자막을 얹는다. 문구가 없으면 프레임 그대로 — 없는 문구를 지어내지 않는다.
    files: list[str] = []
    used: list[dict] = []
    for k, pick in enumerate(chosen, 1):
        src = pathlib.Path(pick["path"])
        pos = _caption_position(src)
        raw = src.read_bytes()
        img = render_captions(raw, [{
            "text": text, "role": "main", "position": pos, "size": "L",
        }]) if text else raw
        # 유튜브 권장 규격(1280x720)으로 줄이고 JPEG 로 저장한다. 원본 해상도 PNG 는
        # 1~1.3MB 라 2MB 상한에 붙어 있어, 화면이 복잡한 프레임 하나면 그대로 초과한다.
        dest = out_dir / f"thumb_{k}.jpg"
        _save_jpeg(img, dest)
        files.append(str(dest))
        used.append({"sec": round(float(pick["sec"]), 2), "score": round(float(pick["score"]), 1),
                     "captionAt": pos, "bytes": dest.stat().st_size})

    return {
        "ok": True, "mediaId": media_id, "programId": program_id, "mode": "frame",
        "caption": text,
        "frames": used,
        "files": files,
    }
