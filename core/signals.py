"""STEP D Core — beat 단위 저수준 신호 (audio · cut · dialogue).

**왜 필요한가.** 지금 하이라이트 판정에 LLM 판단 말고는 아무 근거가 없다. 삭제된
`prefilter.py` 의 5개 원신호(오디오 에너지·모션·컷속도·자막밴드·대사밀도)가 사라진 뒤로
`recommend.py:1142` 가 `heur_score` 를 읽지만 그걸 **쓰는 코드가 리포에 0건**이다.

그래서 `index_segments._highlight_score` 가 순환 정의로 남았다 — 쇼츠에 걸렸으면
`appeal/5`, 아니면 `hook` 문자열 상수 lookup. 즉 **LLM 이 이미 고른 구간만 점수가 높다.**
"쇼츠 후보가 아닌 좋은 구간"(= 아카이브 재활용 질의)을 그 점수로는 영영 못 찾는다.

여기서 만드는 신호는 **LLM 이 뭘 골랐든 무관하게** 계산된다. 그게 요점이다.

**비용: API ₩0.** ffmpeg 오디오 단일 패스 + 이미 메모리에 있는 shots·refined 의 산술뿐.
GPU 도 안 쓴다.

**성능 주의.** 오디오는 반드시 **전 구간 1패스**로 뽑아 슬라이스한다. 구간마다 ffmpeg 를
부르면 PPL 이 축구 109분에서 3787초 걸린 그 함정에 그대로 빠진다
(`docs/research/pipeline-optimization-findings.md`). 32분 영상 기준 디코드 ~10-30초.

산출(beat 하나당):
  audio_pct          회차 내 백분위(0..1) — **스코어러가 쓸 축**. 원 RMS 는 마스터링
                     레벨이 회차마다 달라 그대로 비교하면 안 된다
  audio_rms          구간 평균 RMS (0..1, 트랙 최대 기준 정규화)
  audio_delta        구간 내 최대 순간 상승폭 — 웃음·환호·고성의 대리 지표
  silence_ratio      정적 창 비율 (드라마의 긴 정적 = 긴장 구간)
  cut_rate           초당 컷 수 (shots.json 밀도 · 추가 I/O 0)
  dialogue_density   초당 글자수 (refined · 추가 I/O 0)
  speaker_turn_rate  초당 화자 전환 수 (refined · 추가 I/O 0)

Run (단독 검증):
    python -m core.signals <video> <workdir> [--out signals.json]
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Optional

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

# 오디오 해상도. 8kHz 모노면 에너지 포락선에 충분하고(음성 대역), 32분 = 약 15M 샘플 ~30MB.
_SR = 8000
# RMS 창 — 0.1초. beat 하한이 초 단위라 이보다 잘게 쪼갤 이유가 없다.
_HOP_SEC = 0.1
# 정적 판정 임계 — 트랙 중앙값 대비 비율. 절대값은 마스터링마다 달라 쓸 수 없다.
_SILENCE_REL = 0.15


def _f(x: object, default: float = 0.0) -> float:
    try:
        return float(x)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _overlap(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


# ── 오디오 포락선 (ffmpeg 1패스) ─────────────────────────────────────────────
def rms_envelope(video_path: str, *, sr: int = _SR, hop_sec: float = _HOP_SEC):
    """전 구간 RMS 포락선을 한 번에 뽑는다. 반환 (numpy 1D array, hop_sec) 또는 (None, hop).

    numpy 나 ffmpeg 가 없으면 (None, hop) — 오디오 축만 죽고 나머지 신호는 그대로 계산된다.
    """
    try:
        import numpy as np
    except ImportError:
        print("[signals] numpy 없음 — 오디오 축 skip (cut·dialogue 신호는 계산됨)", flush=True)
        return None, hop_sec

    cmd = ["ffmpeg", "-v", "error", "-i", video_path,
           "-vn", "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"]
    try:
        proc = subprocess.run(cmd, capture_output=True, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError, OSError) as e:
        print(f"[signals] ffmpeg 오디오 디코드 실패 — 오디오 축 skip: {str(e)[:120]}", flush=True)
        return None, hop_sec

    pcm = np.frombuffer(proc.stdout, dtype="<i2")
    if pcm.size == 0:
        return None, hop_sec
    x = pcm.astype("float32") / 32768.0

    win = max(1, int(sr * hop_sec))
    n = x.size // win
    if n == 0:
        return None, hop_sec
    # (n, win) 로 잘라 창별 RMS. 남는 꼬리는 버린다(마지막 0.1초 미만).
    env = np.sqrt((x[: n * win].reshape(n, win) ** 2).mean(axis=1))
    return env, hop_sec


# ── 무료 신호 (이미 메모리에 있는 데이터의 산술) ─────────────────────────────
def _covered(windows: Optional[list], start: float, end: float, min_frac: float = 0.5) -> bool:
    """이 구간이 shot 스캔 범위에 실제로 들어갔나. windows 가 없으면 (구버전 shots.json)
    판단 불가 → True 로 둔다(하위호환)."""
    if not windows:
        return True
    dur = max(1e-6, end - start)
    cov = sum(_overlap(start, end, _f(w[0]), _f(w[1])) for w in windows if len(w) >= 2)
    return (cov / dur) >= min_frac


def _cut_rate(shots: list[float], start: float, end: float,
              windows: Optional[list]) -> Optional[float]:
    """초당 컷 수. **스캔 안 된 구간은 0이 아니라 None** 이다.

    `run_shot_boundary` 는 narrative 창만 스캔한다(전 구간이 아님). 실측 m_981d7c08 에서는
    창 7개뿐이라 beat 의 74%가 미스캔이었다. 그걸 0으로 채우면 스코어러가 "컷이 없는
    조용한 구간"으로 읽어 정확히 반대로 학습한다 — 없는 값은 없다고 해야 한다.
    """
    if not _covered(windows, start, end):
        return None
    dur = max(1e-6, end - start)
    return round(sum(1 for t in shots if start <= t < end) / dur, 4)


def _dialogue_stats(refined: list[dict], start: float, end: float) -> tuple[float, float]:
    """(초당 글자수, 초당 화자전환수). 구간에 겹치는 발화만."""
    dur = max(1e-6, end - start)
    chars = 0
    speakers: list[str] = []
    for s in refined:
        if _overlap(_f(s.get("start")), _f(s.get("end")), start, end) <= 0:
            continue
        chars += len((s.get("text") or "").strip())
        sp = (s.get("speaker") or "").strip()
        if sp and (not speakers or speakers[-1] != sp):
            speakers.append(sp)
    turns = max(0, len(speakers) - 1)
    return round(chars / dur, 3), round(turns / dur, 4)


# ── 메인 ─────────────────────────────────────────────────────────────────────
def beat_signals(video_path: str, beats: list[dict], refined: list[dict],
                 shots: list[float], shot_windows: Optional[list] = None) -> dict:
    """beat 별 저수준 신호. 반환 {"version":1, "signals": {beat_id: {...}}, "stats": {...}}.

    shot_windows = shots.json 의 `windows_sec` (실제 스캔 구간). 넘기면 미스캔 beat 의
    cut_rate 가 0 대신 None 이 된다 — 거짓 0 방지.
    """
    env, hop = rms_envelope(video_path)

    # 오디오 축 전처리 — 회차 전체 기준으로 정규화해야 회차 간 비교가 성립한다.
    peak = None
    median = None
    if env is not None:
        import numpy as np
        peak = float(env.max()) or 1.0
        median = float(np.median(env)) or 1e-6

    per_beat: dict[str, dict] = {}
    raw_means: list[tuple[str, float]] = []

    for b in beats:
        bid = str(b.get("id", len(per_beat)))
        start, end = _f(b.get("start")), _f(b.get("end"))
        if end <= start:
            continue
        dens, turn = _dialogue_stats(refined, start, end)
        rec: dict[str, Optional[float]] = {
            "cut_rate": _cut_rate(shots, start, end, shot_windows),
            "dialogue_density": dens,
            "speaker_turn_rate": turn,
            "audio_rms": None, "audio_delta": None, "silence_ratio": None, "audio_pct": None,
        }
        if env is not None and peak:
            i0 = max(0, int(start / hop))
            i1 = min(env.size, max(i0 + 1, int(end / hop)))
            seg = env[i0:i1]
            if seg.size:
                mean = float(seg.mean())
                rec["audio_rms"] = round(mean / peak, 4)
                # 순간 상승폭 — 웃음·환호는 평균보다 "튀는 정도"로 드러난다
                if seg.size > 1:
                    import numpy as np
                    rec["audio_delta"] = round(float(np.diff(seg).max()) / peak, 4)
                else:
                    rec["audio_delta"] = 0.0
                rec["silence_ratio"] = round(float((seg < median * _SILENCE_REL).mean()), 4)
                raw_means.append((bid, mean))
        per_beat[bid] = rec

    # 백분위 — 회차 내 상대 위치. 마스터링 레벨 차이를 흡수하는 유일한 방법이라
    # **스코어러는 audio_rms 가 아니라 이걸 써야 한다.**
    if raw_means:
        order = sorted(raw_means, key=lambda kv: kv[1])
        n = len(order)
        for rank, (bid, _v) in enumerate(order):
            per_beat[bid]["audio_pct"] = round(rank / max(1, n - 1), 4) if n > 1 else 0.5

    n_cut_null = sum(1 for v in per_beat.values() if v["cut_rate"] is None)
    stats = {
        "beats": len(per_beat),
        "audio": env is not None,
        "envelope_windows": int(env.size) if env is not None else 0,
        "hop_sec": hop,
        # 미스캔 비율이 높으면 cut_rate 를 스코어에 쓰기 전에 shot 스캔 범위부터 넓혀야 한다
        "cut_rate_unscanned": n_cut_null,
        "shot_windows_known": bool(shot_windows),
    }
    return {"version": 1, "signals": per_beat, "stats": stats}


def _main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    video, workdir = argv[0], Path(argv[1])
    out = ""
    if "--out" in argv:
        out = argv[argv.index("--out") + 1]

    def _load(p: Path):
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None

    bd = _load(workdir / "beats.json") or {}
    beats = bd.get("beats") if isinstance(bd, dict) else bd
    refined = _load(workdir / "refined.json") or []
    if isinstance(refined, dict):
        refined = refined.get("segments") or refined.get("refined") or []
    sd = _load(workdir / "shots.json") or {}
    shots = sd.get("shots", []) if isinstance(sd, dict) else sd
    windows = sd.get("windows_sec") if isinstance(sd, dict) else None

    if not beats:
        print("beats.json 없음 — beat 단위 신호를 만들 수 없다", file=sys.stderr)
        return 2

    res = beat_signals(video, beats, refined, shots, windows)
    path = Path(out) if out else workdir / "signals.json"
    path.write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    st = res["stats"]
    print(f"[signals] {st['beats']} beat · audio={st['audio']} → {path}")
    if not st["shot_windows_known"]:
        print("  ⚠️ shots.json 에 windows_sec 없음(구버전) — cut_rate 미스캔 판정 불가")
    elif st["cut_rate_unscanned"]:
        print(f"  ⚠️ cut_rate 미스캔 {st['cut_rate_unscanned']}/{st['beats']} beat → None")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
