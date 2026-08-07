"""여러 TSN feature .pkl 을 한 번 로드된 SJNET 로 순차 inference.

인자:
  --model            .pt 경로
  --features-list    파일 · 각 줄 "chunk_idx TAB pkl_path TAB duration_sec"
  --out-dir          청크별 boundaries.json 저장 위치

각 청크당 산출: {out-dir}/c{idx}.json (infer_single 과 동일 스키마).
모델 로드는 한 번만.
"""
from __future__ import annotations

import argparse
import json
import pickle
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from scipy.interpolate import interp1d

CLA_DIR = Path(__file__).resolve().parent.parent / "cla"
sys.path.insert(0, str(CLA_DIR))

from config import FEATURE_LEN, FEATURE_DIM, THRESHOLD  # noqa
from network import SJNET  # noqa


def _resize(x, n):
    if len(x) == n:
        return x
    if len(x) == 1:
        return np.stack([x[0]] * n)
    idx = np.arange(len(x))
    f = interp1d(idx, x, axis=0, kind="nearest")
    return f([i * (len(x) - 1) / (n - 1) for i in range(n)])


def _load_feat(path):
    """(패딩된 [300,D] 특징, 패딩 전 실제 행 수) 를 반환.

    ⚠️ 실제 행 수를 반드시 같이 돌려줘야 한다. 예전에는 이걸 버리고
    `scale = dur / FEATURE_LEN` 로 시간을 매핑했는데, 짧은 청크는 대부분이 0 패딩이라
    **경계 시각이 청크 앞쪽으로 압축**됐다(실측: 60초 청크 17.7행 → 256개 경계가 전부
    각 분의 앞 11.4초에 몰림 · 타임라인 81% 탐지 불가).
    """
    feat = np.array(pickle.load(open(path, "rb")))
    if feat.shape[1] != FEATURE_DIM:
        raise ValueError(f"dim mismatch: {feat.shape}")
    n_real = int(feat.shape[0])
    if n_real > FEATURE_LEN:
        feat = _resize(feat, FEATURE_LEN)
        n_real = FEATURE_LEN
    elif n_real < FEATURE_LEN:
        pad = np.zeros((FEATURE_LEN - n_real, feat.shape[1]))
        feat = np.concatenate([feat, pad], axis=0)
    return feat, n_real


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--features-list", required=True)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"[batch] device={device}")
    t0 = time.time()
    model = torch.load(args.model, map_location=device)
    model.eval()
    print(f"[batch] model loaded in {time.time() - t0:.2f}s")

    # 스무딩 + peak
    k = 3
    sigma = 0.4
    gauss = torch.FloatTensor(
        [np.exp(-z * z / (2 * sigma * sigma)) / np.sqrt(2 * np.pi * sigma * sigma)
         for z in range(-k, k + 1)]
    ).to(device)
    gauss = gauss.unsqueeze(0).unsqueeze(0) / gauss.max()
    gauss = gauss.repeat(1, FEATURE_LEN, 1)
    max_pool = nn.MaxPool1d(5, stride=1, padding=2)
    eye = torch.eye(FEATURE_LEN).to(device)  # outer scope · 반복마다 재생성 방지

    out_dir = Path(args.out_dir); out_dir.mkdir(parents=True, exist_ok=True)
    entries = []
    for line in Path(args.features_list).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        entries.append((int(parts[0]), parts[1], float(parts[2])))

    print(f"[batch] {len(entries)} chunks to infer")
    total_infer = 0.0
    for idx, pkl, dur in entries:
        try:
            feat, n_real = _load_feat(pkl)
        except Exception as e:
            print(f"  #{idx} feat FAIL: {e}"); continue
        feat_t = torch.from_numpy(feat).float().unsqueeze(0).to(device)
        t1 = time.time()
        with torch.no_grad():
            pred1, _, _, _, _ = model(feat_t)
            p = torch.sigmoid(pred1).reshape(1, FEATURE_LEN)
            out = p.unsqueeze(-1) * eye
            out = nn.functional.conv1d(out, gauss, padding=(int(k),))
            peak = (out == max_pool(out))
            peak[out < THRESHOLD] = False
            peak = peak.squeeze()
            hits = torch.nonzero(peak).cpu().numpy().flatten()
        infer_sec = time.time() - t1
        total_infer += infer_sec
        # ⚠️ 나누는 값은 FEATURE_LEN(300) 이 아니라 **패딩 전 실제 행 수** 다.
        # 300 으로 나누면 0 패딩 구간까지 영상 길이에 포함시키는 셈이라
        # 경계가 청크 앞쪽으로 압축된다.
        scale = dur / max(1, n_real)
        # score 추출: sigmoid(pred1) 그대로 저장 (peak position 만)
        p_np = p.squeeze().cpu().numpy()
        bs_scored = []
        n_pad_drop = 0
        for j in hits.tolist():
            # 0 패딩 구간(j >= n_real)의 peak 는 내용이 없는 자리의 허깨비다 — 버린다.
            if j >= n_real:
                n_pad_drop += 1
                continue
            t_real = round(float(j) * scale + scale / 2, 3)
            if t_real > dur:
                continue
            score = float(p_np[j])
            bs_scored.append({"t": t_real, "score": round(score, 4), "kind": "unknown", "source": "gebd"})
        # dedup 같은 시각
        # ⚠️ 여기서 `k` 를 쓰면 안 된다 — 위 가우시안 커널 반폭 `k` 를 덮어써서
        # 다음 청크의 conv1d padding 이 "마지막 경계 시각"으로 오염된다.
        seen = set(); bs_uniq = []
        for b in sorted(bs_scored, key=lambda x: x["t"]):
            key = round(b["t"], 2)
            if key in seen:
                continue
            seen.add(key); bs_uniq.append(b)
        Path(out_dir / f"c{idx}.json").write_text(
            json.dumps({
                "video_duration_sec": dur,
                "feature_len": FEATURE_LEN,
                "feature_rows_real": n_real,          # 패딩 전 실제 행 수
                "rows_per_sec": round(n_real / max(1e-6, dur), 3),
                "scale_sec_per_step": round(scale, 4),
                "padding_peaks_dropped": n_pad_drop,
                "num_boundaries": len(bs_uniq),
                "boundaries_sec": [b["t"] for b in bs_uniq],  # 하위호환
                "boundaries": bs_uniq,  # 신규 · score 포함
                "inference_sec": round(infer_sec, 3),
            }, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"  #{idx:3d} · {len(bs_uniq):3d} boundaries · rows {n_real}/{FEATURE_LEN} "
              f"({n_real/max(1e-6,dur):.2f}/s) · scale {scale:.3f}s · pad버림 {n_pad_drop} · {infer_sec:.2f}s")
    print(f"[batch] done · total infer {total_infer:.2f}s · avg {total_infer/max(1,len(entries)):.2f}s/chunk")


if __name__ == "__main__":
    main()
