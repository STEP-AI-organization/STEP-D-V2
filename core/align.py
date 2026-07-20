"""숏폼 → 롱폼 구간 자동 추적 (오디오 정렬).

숏폼은 대부분 롱폼의 오디오를 그대로 잘라 쓴다. 그래서 "어디서 잘렸나"는 음성 인식이나
Gemini 없이 **오디오 상호상관**으로 정확히 찾을 수 있다. 대사가 없는 구간(음악·리액션)에도
동작하고, 비용은 CPU뿐이다.

방법:
  1. 두 오디오를 16kHz 모노로 통일 → 로그-멜 스펙트로그램(저해상도, 초당 ~31프레임)
  2. 프레임별 평균 제거(=BGM/음량 차이에 둔감하게) 후 FFT 기반 정규화 상호상관
  3. 최댓값 위치 = 숏폼이 시작하는 롱폼 상의 오프셋

신뢰도는 "최고점 / 차순위점"(peak ratio)로 낸다. 같은 오디오면 최고점이 압도적으로 튀고,
무관한 오디오면 고만고만한 봉우리가 여러 개 나온다. 이 비율이 임계값 미만이면 자동 결과를
버리고 사람이 찍게 둔다 — 틀린 구간을 조용히 저장하는 것이 최악이다.

한계(그래서 신뢰도로 걸러야 하는 이유):
  - 숏폼에 BGM/효과음을 크게 덧입혔거나 배속을 걸었으면 상관이 무너진다.
  - 여러 구간을 이어 붙인 편집본은 첫 구간만 잡힌다.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from dataclasses import dataclass, asdict
from pathlib import Path

import numpy as np

SR = 16_000
N_FFT = 1024
HOP = 512            # 초당 31.25 프레임 — 구간 정확도 ±0.03초면 충분하고 25분도 가볍다
N_MELS = 40
MIN_PEAK_RATIO = 2.0  # 최고점이 차순위의 2배는 돼야 채택


@dataclass
class AlignResult:
    ok: bool
    offset_sec: float
    duration_sec: float
    score: float          # 정규화 상관 최고값 (0~1 근처)
    peak_ratio: float     # 최고점 / 차순위점
    reason: str = ""

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False)


def _decode(path: str, sr: int = SR) -> np.ndarray:
    """ffmpeg으로 어떤 컨테이너든 16kHz 모노 float32 PCM으로."""
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(sr), "-"],
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(out, dtype=np.float32)


def _mel_filters(sr: int, n_fft: int, n_mels: int) -> np.ndarray:
    """librosa 없이 쓰는 최소 멜 필터뱅크 (워커에 의존성 추가하지 않기 위해)."""
    def hz_to_mel(f):
        return 2595.0 * np.log10(1.0 + f / 700.0)

    def mel_to_hz(m):
        return 700.0 * (10.0 ** (m / 2595.0) - 1.0)

    n_bins = n_fft // 2 + 1
    edges = mel_to_hz(np.linspace(hz_to_mel(50), hz_to_mel(sr / 2), n_mels + 2))
    bins = np.floor((n_fft + 1) * edges / sr).astype(int)
    bins = np.clip(bins, 0, n_bins - 1)
    fb = np.zeros((n_mels, n_bins), dtype=np.float32)
    for i in range(n_mels):
        lo, mid, hi = bins[i], bins[i + 1], bins[i + 2]
        if mid > lo:
            fb[i, lo:mid] = np.linspace(0, 1, mid - lo, endpoint=False)
        if hi > mid:
            fb[i, mid:hi] = np.linspace(1, 0, hi - mid, endpoint=False)
    return fb


_FB = _mel_filters(SR, N_FFT, N_MELS)


FRAME_BLOCK = 2048  # 한 번에 STFT할 프레임 수


def _feature(y: np.ndarray) -> np.ndarray:
    """로그-멜 스펙트로그램 → 프레임별 평균 제거·정규화한 (n_mels, T) 행렬.

    프레임별 정규화가 핵심이다. 숏폼은 라우드니스 노멀라이즈를 거치거나 BGM이 얹혀 음량·
    스펙트럼 기울기가 달라지는데, 여기서 그 성분을 빼야 '같은 소리'로 매칭된다.

    STFT는 블록 단위로 돌린다. 25분 롱폼이면 프레임이 5만 개를 넘어서, 한 번에 인덱싱하면
    인덱스 배열만 400MB를 넘겨 워커가 OOM으로 죽는다(실제로 죽었다).
    """
    if y.size < N_FFT:
        return np.zeros((N_MELS, 0), dtype=np.float32)
    n_frames = 1 + (y.size - N_FFT) // HOP
    win = np.hanning(N_FFT).astype(np.float32)
    base = np.arange(N_FFT, dtype=np.int64)
    mel = np.empty((N_MELS, n_frames), dtype=np.float32)

    for s in range(0, n_frames, FRAME_BLOCK):
        e = min(s + FRAME_BLOCK, n_frames)
        idx = base[None, :] + HOP * np.arange(s, e, dtype=np.int64)[:, None]
        spec = np.fft.rfft(y[idx] * win, axis=1)
        power = (np.abs(spec) ** 2).astype(np.float32)
        mel[:, s:e] = np.log1p(power @ _FB.T).T
        del idx, spec, power

    mel -= mel.mean(axis=0, keepdims=True)     # 프레임별 스펙트럼 기울기 제거
    norm = np.linalg.norm(mel, axis=0, keepdims=True)
    return mel / np.maximum(norm, 1e-8)


def _xcorr(long_f: np.ndarray, short_f: np.ndarray) -> np.ndarray:
    """FFT 기반 상호상관 — 숏폼 특징을 롱폼 위로 미끄러뜨리며 내적."""
    n_long, n_short = long_f.shape[1], short_f.shape[1]
    size = 1 << int(np.ceil(np.log2(n_long + n_short)))
    corr = np.zeros(n_long - n_short + 1, dtype=np.float32)
    for band in range(long_f.shape[0]):
        fa = np.fft.rfft(long_f[band], size)
        fb = np.fft.rfft(short_f[band][::-1], size)
        full = np.fft.irfft(fa * fb, size)[n_short - 1 : n_long]
        corr += full.astype(np.float32)
    return corr / n_short


def align(long_path: str, short_path: str, min_peak_ratio: float = MIN_PEAK_RATIO) -> AlignResult:
    """숏폼이 롱폼의 몇 초 지점에서 시작하는지 추정한다."""
    long_y = _decode(long_path)
    short_y = _decode(short_path)
    dur = float(short_y.size) / SR

    lf, sf = _feature(long_y), _feature(short_y)
    if sf.shape[1] < 8 or lf.shape[1] <= sf.shape[1]:
        return AlignResult(False, 0.0, dur, 0.0, 0.0, "오디오가 너무 짧거나 롱폼보다 깁니다")

    corr = _xcorr(lf, sf)
    best = int(np.argmax(corr))
    peak = float(corr[best])

    # 차순위 봉우리는 최고점 주변(숏폼 길이의 절반)을 제외하고 찾는다 — 바로 옆 프레임은
    # 같은 봉우리의 어깨라 비교 대상이 아니다.
    guard = max(1, sf.shape[1] // 2)
    masked = corr.copy()
    masked[max(0, best - guard) : best + guard + 1] = -np.inf
    runner = float(np.max(masked)) if np.isfinite(masked).any() else 0.0
    ratio = peak / runner if runner > 1e-6 else float("inf")

    offset = best * HOP / SR
    if peak <= 0 or ratio < min_peak_ratio:
        return AlignResult(
            False, offset, dur, peak, ratio,
            f"신뢰도 부족 (최고점 {peak:.3f}, 차순위 대비 {ratio:.2f}배) — 배속·BGM 덧입힘·재편집 가능성",
        )
    return AlignResult(True, round(offset, 2), round(dur, 2), round(peak, 4), round(ratio, 2))


def align_urls(long_url: str, short_url: str) -> AlignResult:
    """yt-dlp로 오디오만 받아서 정렬 (워커 경로)."""
    with tempfile.TemporaryDirectory() as td:
        paths = []
        for name, url in (("long", long_url), ("short", short_url)):
            out = str(Path(td) / f"{name}.m4a")
            subprocess.run(
                ["yt-dlp", "-q", "--no-playlist", "-f", "bestaudio/best", "-o", out, url],
                check=True,
            )
            paths.append(out)
        return align(paths[0], paths[1])


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: python -m core.align <longform> <short>", file=sys.stderr)
        raise SystemExit(2)
    print(align(sys.argv[1], sys.argv[2]).to_json())
