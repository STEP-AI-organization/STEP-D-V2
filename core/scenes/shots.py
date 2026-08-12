"""
STEP D Core — Shot boundary detection (frame-diff)

STT-only scene splits catch dialogue pauses but miss visual cuts (angle change, spatial
move, silent reaction shot). This module runs ffmpeg's `select=gt(scene,T)` filter on
targeted windows and returns shot boundary timestamps. Used by recommend.py to snap
setup_start / payoff_end to the nearest visual cut.

Design (2026-07-24):
- 60-min full-scan is wasted; narrative-first already pins candidate windows.
- Scan only union of candidate windows at fps=1 with threshold 0.55 (loose, so only
  clear space/angle transitions surface — jump cuts within a single conversation are
  intentionally ignored).
- Fallback: if ffmpeg not present, return empty list — snap chain skips silently.
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

_SHOWINFO_PTS = re.compile(r"pts_time:([0-9]+\.?[0-9]*)")


def _merge_windows(windows: list[tuple[float, float]], pad: float = 5.0,
                   min_gap: float = 10.0) -> list[tuple[float, float]]:
    if not windows:
        return []
    padded = sorted((max(0.0, s - pad), e + pad) for s, e in windows if e > s)
    merged: list[list[float]] = []
    for s, e in padded:
        if merged and s - merged[-1][1] <= min_gap:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return [(s, e) for s, e in merged]


def _run_ffmpeg_scene(video_path: str, start: float, end: float,
                      threshold: float, fps: int) -> list[float]:
    """단일 창에 대해 ffmpeg scene detect. 반환은 창 절대 시각(sec) 리스트."""
    if end <= start:
        return []
    dur = end - start
    cmd = [
        "ffmpeg", "-hide_banner", "-nostats", "-loglevel", "info",
        "-ss", f"{start:.3f}", "-t", f"{dur:.3f}",
        "-i", str(video_path),
        "-vf", f"fps={fps},select='gt(scene,{threshold})',showinfo",
        "-an", "-sn",
        "-f", "null", "-",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=max(30, int(dur * 2)))
    except FileNotFoundError:
        return []
    except subprocess.TimeoutExpired:
        return []
    boundaries: list[float] = []
    # showinfo prints on stderr
    for line in (proc.stderr or "").splitlines():
        m = _SHOWINFO_PTS.search(line)
        if m:
            try:
                rel = float(m.group(1))
            except ValueError:
                continue
            boundaries.append(round(start + rel, 2))
    return boundaries


# 장르별 shot 임계 — snap 대상이 완전히 다름.
# 예능: 잔컷 폭포 · 큰 공간/앵글 전환에만 스냅하려면 0.55 이상. 인터뷰룸<->세트 같은 큰 컷만.
# 드라마: 씬 컷 자체가 훨씬 드묾. 0.35까지 낮춰야 씬 경계에 정확히 스냅. 롱테이크 안의 미세
#        움직임은 원래 안 잡히니 노이즈 우려 낮음.
_SHOT_THRESHOLD_BY_GENRE = {
    "variety": 0.55,
    "drama": 0.35,
}
_DEFAULT_SHOT_THRESHOLD = 0.55


def detect_shots(video_path: str, windows: list[tuple[float, float]],
                 threshold: float | None = None, fps: int = 1,
                 genre: str | None = None) -> list[float]:
    """windows 리스트(각 (start, end))의 union을 스캔해 shot boundary 절대 시각 리스트 반환.

    threshold — 명시 값이 우선. None이면 genre에서 결정("variety"=0.55·"drama"=0.35·기본 0.55).
    fps=1 = 초당 1프레임만 봐서 30~60배 가속. 실패(ffmpeg 없음/타임아웃)는 조용히 빈 리스트."""
    if threshold is None:
        threshold = _SHOT_THRESHOLD_BY_GENRE.get(genre or "", _DEFAULT_SHOT_THRESHOLD)
    if not video_path or not Path(video_path).exists():
        return []
    merged = _merge_windows(windows)
    if not merged:
        return []
    boundaries: list[float] = []
    for s, e in merged:
        boundaries.extend(_run_ffmpeg_scene(video_path, s, e, threshold, fps))
    boundaries.sort()
    # dedupe within 0.5s
    dedup: list[float] = []
    for b in boundaries:
        if not dedup or b - dedup[-1] >= 0.5:
            dedup.append(b)
    return dedup


def nearest_shot(t: float, shots: list[float], max_shift: float = 3.0) -> float:
    """t에 가장 가까운 shot boundary 반환 · max_shift 초과 시 원래 t 유지."""
    if not shots:
        return t
    best = min(shots, key=lambda x: abs(x - t))
    return best if abs(best - t) <= max_shift else t
