"""라벨링 결과 + TSN feature → GEBD 학습 데이터셋.

label-boundaries.py 가 내보낸 annotation(NIA `trigger_info` 스키마)과 이미 뽑아둔
청크 feature 를 **300초 학습 샘플**로 재조립한다.

왜 300초로 잘라야 하나: `cla/dataset.py:45-50` 이 FEATURE_LEN(=300)보다 긴 feature 를
`resizeFeature(..., 'nearest')` 로 **다운샘플**한다. 58.6분 회차를 통째로 넣으면 300 프레임에
욱여넣어져 1프레임 = 11.7초가 되고 경계 시간 해상도가 통째로 날아간다.
`TIME_UNIT=1` 이므로 **1 샘플 = 300초 = feature 300행** 이 정확한 단위다.

feature 재사용: run-local.sh 가 만든 60초 청크 feature(`c000_tsn.pkl` …)를 5개씩 이어
붙이면 300행이 된다. **다시 뽑을 필요가 없다** (58.6분 재추출 = GPU 12.3분).

산출 (`cla/config.py` 가 기대하는 경로 구조):
  <out>/features/<clip_id>_tsn.pkl
  <out>/annotations/<clip_id>.json
  <out>/all_data.json
  <out>/dataset_split_list.json

사용:
  python deploy/gebd/build-dataset.py \
      --annotation <labeled.json> --features-dir <chunks feature dir> \
      --out <dataset dir> [--chunk-sec 60] [--clip-sec 300] [--val-ratio 0.2]
"""
from __future__ import annotations

import argparse
import json
import pickle
import re
import sys
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

FEATURE_LEN = 300   # cla/config.py 고정값 — 바꾸지 말 것
TIME_UNIT = 1


def parse_ts(s: str) -> float:
    """'01:07.500' 또는 '67.5' → 초."""
    s = str(s).strip()
    if ":" in s:
        parts = s.split(":")
        return sum(float(p) * (60 ** i) for i, p in enumerate(reversed(parts)))
    return float(s)


def load_chunk_features(fdir: Path) -> list[tuple[int, "object"]]:
    """cNNN_tsn.pkl → [(index, ndarray)] 정렬본."""
    import numpy as np
    out = []
    for p in sorted(fdir.glob("*_tsn.pkl")):
        m = re.search(r"c(\d+)_tsn\.pkl$", p.name)
        if not m:
            continue
        with p.open("rb") as f:
            arr = pickle.load(f)
        arr = np.asarray(arr)
        if arr.ndim == 3 and arr.shape[0] == 1:
            arr = arr[0]
        out.append((int(m.group(1)), arr))
    out.sort(key=lambda x: x[0])
    return out


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="라벨 + feature → GEBD 학습 데이터셋")
    ap.add_argument("--annotation", required=True, help="label-boundaries.py Export JSON")
    ap.add_argument("--features-dir", required=True, help="cNNN_tsn.pkl 들이 있는 폴더")
    ap.add_argument("--out", required=True)
    ap.add_argument("--chunk-sec", type=float, default=60.0)
    ap.add_argument("--clip-sec", type=float, default=300.0)
    ap.add_argument("--val-ratio", type=float, default=0.2)
    ap.add_argument("--append", action="store_true", help="기존 out 에 이어붙이기(여러 회차 누적)")
    a = ap.parse_args(argv)

    import numpy as np

    ann = json.loads(Path(a.annotation).read_text(encoding="utf-8"))
    vname = ann.get("video_name") or Path(a.annotation).stem
    vid = re.sub(r"\.[^.]+$", "", vname)
    fps = float(ann.get("frame_rate") or 29.97)

    cuts, acts = [], []
    for ti in ann.get("trigger_info") or []:
        tgt = cuts if "cut" in str(ti.get("trigger", "")).lower() else acts
        tgt.extend(parse_ts(t) for t in (ti.get("timestamps") or []))
    if not (cuts or acts):
        print("경계 라벨이 비어 있습니다 — 라벨링을 먼저 완료하세요", file=sys.stderr)
        return 2

    feats = load_chunk_features(Path(a.features_dir))
    if not feats:
        print(f"feature 없음: {a.features_dir}", file=sys.stderr)
        return 2
    rows_per_chunk = int(round(a.chunk_sec / TIME_UNIT))
    chunks_per_clip = int(round(a.clip_sec / a.chunk_sec))
    print(f"[dataset] {vid} · 청크 {len(feats)}개 · 클립당 청크 {chunks_per_clip}개 "
          f"· 컷 {len(cuts)} · 행동 {len(acts)}")

    out = Path(a.out)
    (out / "features").mkdir(parents=True, exist_ok=True)
    (out / "annotations").mkdir(parents=True, exist_ok=True)
    all_data = {}
    if a.append and (out / "all_data.json").exists():
        all_data = json.loads((out / "all_data.json").read_text(encoding="utf-8"))

    made = 0
    for ci in range(0, len(feats), chunks_per_clip):
        group = feats[ci:ci + chunks_per_clip]
        if len(group) < chunks_per_clip:
            # 꼬리 클립은 300행을 못 채운다 → dataset.py 가 padding 하지만 라벨 밀도가
            # 달라 학습 편향이 된다. 버리는 편이 낫다.
            print(f"  (꼬리 청크 {len(group)}개 < {chunks_per_clip} · 클립 미생성)")
            break
        t0 = group[0][0] * a.chunk_sec
        t1 = t0 + a.clip_sec
        mat = np.concatenate([g[1] for g in group], axis=0)

        # ── 시간축을 정확히 FEATURE_LEN(=clip_sec 초) 행으로 리샘플 ──────────────
        # 왜 필요한가: 참조구현은 **1행 = 1초**(TIME_UNIT=1)를 전제하고 `dataset.py` 가
        # 경계 초를 그대로 행 인덱스로 쓴다. 그런데 `module.video_segmentation` 이
        # `ffmpeg -c copy -segment_time 1` 로 자르는데, `-c copy` 는 **키프레임에서만**
        # 자를 수 있다. 이 소스는 GOP 가 ~5초라 60초 청크가 60조각이 아니라 42조각이 되고,
        # 실측 **초당 0.555행**이 나온다(1949행 / 3514초).
        #
        # 그대로 두면 클립당 ~167행이라 dataset.py 가 resize 가 아니라 **paddingFeature**
        # 경로를 타서 뒤 133행이 0으로 채워진다. 라벨은 0~300 인덱스를 가리키므로
        # **경계가 통째로 어긋난다**(끝으로 갈수록 130초 이상).
        #
        # 여기서 미리 300행으로 맞추면 dataset.py 가 아무 변형도 하지 않고,
        # 경계 초 → 행 인덱스 매핑이 정확해진다. 재추출(GPU 2시간)도 필요 없다.
        n_rows = mat.shape[0]
        if n_rows != FEATURE_LEN:
            if n_rows < 2:
                print(f"  (clip {ci}: feature {n_rows}행 — 너무 적어 스킵)")
                continue
            x_old = np.linspace(0.0, 1.0, n_rows)
            x_new = np.linspace(0.0, 1.0, FEATURE_LEN)
            mat = np.stack([np.interp(x_new, x_old, mat[:, d]) for d in range(mat.shape[1])],
                           axis=1).astype("float32")
        clip_id = f"{vid}_c{ci//chunks_per_clip:03d}"

        # 클립 구간 라벨만 추려 **클립 기준 상대 초**로 옮긴다
        c_in = sorted(round(t - t0, 3) for t in cuts if t0 <= t < t1)
        a_in = sorted(round(t - t0, 3) for t in acts if t0 <= t < t1)
        events = sorted(set(c_in) | set(a_in))
        if not events:
            continue  # 경계가 없는 클립은 학습 신호가 없다

        # ⚠️ ndarray 를 그대로 pickle 하면 컨테이너(numpy 1.x)가 못 읽는다 —
        # 호스트 numpy 2.x pickle 은 `numpy._core` 를 참조한다. 버전 무관한
        # {bytes, shape, dtype} 로 저장하고 cla/dataset.py:pickle2numpy 가 되살린다.
        mat = np.ascontiguousarray(mat, dtype="float32")
        with (out / "features" / f"{clip_id}_tsn.pkl").open("wb") as f:
            pickle.dump({"__ndarray__": mat.tobytes(), "shape": mat.shape,
                         "dtype": str(mat.dtype)}, f, protocol=4)
        (out / "annotations" / f"{clip_id}.json").write_text(json.dumps({
            "video_name": f"{clip_id}.mp4", "duration": a.clip_sec, "frame_rate": fps,
            "total_frame": int(a.clip_sec * fps), "f1_consis": 1.0, "f1_consis_avg": 1.0,
            "source_video": vname, "source_offset_sec": t0,
            "trigger_info": [
                {"trigger": "Change due to cut", "timestamps": [f"{t:.3f}" for t in c_in]},
                {"trigger": "Change of action", "timestamps": [f"{t:.3f}" for t in a_in]},
            ],
        }, ensure_ascii=False, indent=1), encoding="utf-8")

        # prepare_dataset.py 와 같은 레코드 구조 (cla/dataset.py 가 직접 읽는다)
        all_data[clip_id] = {
            "path_feature": str((out / "features" / f"{clip_id}_tsn.pkl").as_posix()),
            "fps": fps, "duration": a.clip_sec, "num_frames": int(a.clip_sec * fps),
            "f1_consis": 1.0, "f1_consis_avg": 1.0,
            "change_event": [a_in], "change_shot": [c_in],
            "substages_myframeidx": [[t * fps for t in events]],
            "substages_timestamps": [events],
        }
        made += 1

    (out / "all_data.json").write_text(json.dumps(all_data, ensure_ascii=False, indent=1),
                                       encoding="utf-8")
    # train/validation 분할 — 재현성을 위해 **정렬 후 결정론적으로** 자른다(무작위 X).
    # ⚠️ fold 중첩 금지. `cla/dataset.py:145` 가 `json.load(f)[mode]` 로 **최상위에서 바로**
    # 'train'/'validation' 을 찾는다. {"0": {...}} 로 감싸면 KeyError 가 난다.
    keys = sorted(all_data.keys())
    n_val = max(1, int(len(keys) * a.val_ratio))
    split = {"train": keys[n_val:], "validation": keys[:n_val], "test": keys[:n_val]}
    (out / "dataset_split_list.json").write_text(json.dumps(split, ensure_ascii=False, indent=1),
                                                 encoding="utf-8")

    print(f"[dataset] 이번 회차 클립 {made}개 · 누적 샘플 {len(keys)}개 "
          f"(train {len(keys)-n_val} / val {n_val}) → {out}")
    if len(keys) < 50:
        print(f"[dataset] ⚠️ 샘플 {len(keys)}개는 파인튜닝에도 적습니다. "
              f"--append 로 회차를 더 쌓으세요 (권장 170~310)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
