"""GEBD inference-only · mp4 하나에서 경계 초 리스트 뽑기.

전제: TSN feature (.pkl · shape=[N,2048]) 가 이미 추출되어 있음.
      feature 추출은 mmaction2 CLI 로 별도 수행 (도커 안에서).

사용:
  python infer_single.py \
    --model ../models/model_cla_f_0_s_-1_7728.pt \
    --feature /path/to/tsn.pkl \
    --duration 592.6 \
    --out /path/to/boundaries.json
"""
from __future__ import annotations

import argparse
import json
import os
import pickle
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from scipy.interpolate import interp1d

# cla/ 를 import path 에 (config·network 참조)
CLA_DIR = Path(__file__).resolve().parent.parent / "cla"
sys.path.insert(0, str(CLA_DIR))

from config import FEATURE_LEN, FEATURE_DIM, THRESHOLD  # noqa: E402
from network import SJNET  # noqa: E402 · torch.load unpickle 위해 필요


def resize_feature(x: np.ndarray, new_size: int, kind: str = "nearest") -> np.ndarray:
    n = len(x)
    if n == new_size:
        return x
    if n == 1:
        return np.stack([x[0]] * new_size)
    idx = np.arange(n)
    f = interp1d(idx, x, axis=0, kind=kind)
    new_idx = [i * float(n - 1) / (new_size - 1) for i in range(new_size)]
    return f(new_idx)


def load_feature(pkl_path: str) -> np.ndarray:
    with open(pkl_path, "rb") as f:
        data = pickle.load(f)
    feat = np.array(data)
    if feat.ndim != 2 or feat.shape[1] != FEATURE_DIM:
        raise ValueError(f"feature shape mismatch: got {feat.shape}, expect (*, {FEATURE_DIM})")
    if feat.shape[0] > FEATURE_LEN:
        feat = resize_feature(feat, FEATURE_LEN, "nearest")
    elif feat.shape[0] < FEATURE_LEN:
        pad = np.zeros((FEATURE_LEN - feat.shape[0], feat.shape[1]))
        feat = np.concatenate([feat, pad], axis=0)
    return feat


def infer(model_path: str, feature_pkl: str, duration_sec: float, out_json: str) -> dict:
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"[gebd] device={device}")

    t0 = time.time()
    # weight-only 가 아닌 full pickle 이므로 network.SJNET 클래스 임포트가 반드시 앞서야 함.
    model = torch.load(model_path, map_location=device)
    model.eval()
    print(f"[gebd] model loaded in {time.time()-t0:.2f}s")

    feat = load_feature(feature_pkl)
    feat_t = torch.from_numpy(feat).float().unsqueeze(0).to(device)  # [1, 300, 2048]
    print(f"[gebd] feature shape={tuple(feat_t.shape)}")

    # Gaussian smoothing + max-pool peak · test.py 동일 로직.
    k = 3
    sigma = 0.4  # SIGMA_LIST 의 non-negative 대표값
    gauss = torch.FloatTensor(
        [np.exp(-z * z / (2 * sigma * sigma)) / np.sqrt(2 * np.pi * sigma * sigma)
         for z in range(-k, k + 1)]
    ).to(device)
    gauss = gauss.unsqueeze(0).unsqueeze(0)
    gauss /= torch.max(gauss)
    gauss = gauss.repeat(1, FEATURE_LEN, 1)
    max_pool = nn.MaxPool1d(5, stride=1, padding=2)

    t1 = time.time()
    with torch.no_grad():
        pred1, _pred2, _, _, _ = model(feat_t)
        p = torch.sigmoid(pred1).reshape(1, FEATURE_LEN)
        out = p.unsqueeze(-1)
        eye = torch.eye(FEATURE_LEN).to(device)
        out = out * eye
        out = nn.functional.conv1d(out, gauss, padding=k)
        peak = (out == max_pool(out))
        peak[out < THRESHOLD] = False
        peak = peak.squeeze()
        idx = torch.nonzero(peak).cpu().numpy().flatten()
    infer_sec = time.time() - t1
    print(f"[gebd] inference {infer_sec:.3f}s · {len(idx)} peaks")

    # 300-length 스코어 → 원 영상 시각 매핑.
    # duration <= 300s 면 test.py 원 로직 (j*TIME_UNIT + 0.5) 이 맞지만,
    # duration > 300s 인 경우 feature 를 downsample 했으므로 배율 적용.
    scale = duration_sec / FEATURE_LEN
    boundaries = sorted({round(float(j) * scale + scale / 2, 3) for j in idx.tolist()})

    result = {
        "video_duration_sec": duration_sec,
        "feature_len": FEATURE_LEN,
        "scale_sec_per_step": round(scale, 4),
        "num_boundaries": len(boundaries),
        "boundaries_sec": boundaries,
        "inference_sec": round(infer_sec, 3),
        "threshold": THRESHOLD,
        "sigma": sigma,
    }
    Path(out_json).parent.mkdir(parents=True, exist_ok=True)
    with open(out_json, "w") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"[ok] {len(boundaries)} boundaries → {out_json}")
    return result


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--feature", required=True, help="TSN feature .pkl")
    ap.add_argument("--duration", type=float, required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    infer(args.model, args.feature, args.duration, args.out)
