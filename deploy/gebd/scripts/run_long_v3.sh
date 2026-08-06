#!/usr/bin/env bash
# GEBD 롱폼 v3 · GPU 병렬 극대화.
# v2 대비:
#  · mmaction2 subprocess 매 청크마다 → **1회 호출 + --core N 병렬**
#  · 모든 청크 mp4 를 한 폴더에 놓고 extract_feature.py 를 한 번에.
#  · infer 는 batched (v2 방식 그대로).
set -euo pipefail

VIDEO="${VIDEO:-/gebd/input/source.mp4}"
MODEL="/gebd/models/model_cla_f_0_s_-1_7728.pt"
OUT="/gebd/out"
CHUNK_SEC="${CHUNK_SEC:-60}"
CORES="${CORES:-4}"  # GPU 병렬 subprocess 수 (VRAM · 청크당 ~500MB, 4개=2GB)

CHUNKS_DIR="$OUT/chunks_flat"  # 모든 청크 mp4 를 한 폴더에
FEAT_DIR="$OUT/features_flat"
PARTS_DIR="$OUT/parts"
mkdir -p "$CHUNKS_DIR" "$FEAT_DIR" "$PARTS_DIR"

log() { echo "[$(date +%H:%M:%S)] $*"; }

DURATION=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$VIDEO")
N=$(python -c "import math; print(math.ceil(float('$DURATION') / $CHUNK_SEC))")
log "video=$VIDEO · dur=${DURATION}s · chunk=${CHUNK_SEC}s · chunks=$N · cores=$CORES"

T_TOTAL_S=$(date +%s.%N)

# ── Stage A · 청크 자르기 (stream copy · 한 폴더에 c000.mp4 ~ c104.mp4) ────
log "STAGE A · cut $N chunks (stream copy)"
T_CUT_S=$(date +%s.%N)
for ((i=0; i<N; i++)); do
  START=$((i * CHUNK_SEC))
  CHUNK="$CHUNKS_DIR/$(printf 'c%03d' $i).mp4"
  if [ ! -f "$CHUNK" ]; then
    ffmpeg -y -v error -ss "$START" -t "$CHUNK_SEC" -i "$VIDEO" -c copy -an "$CHUNK"
  fi
done
T_CUT=$(python -c "print(f'{$(date +%s.%N) - ${T_CUT_S}:.2f}')")
log "STAGE A done · ${T_CUT}s"

# ── Stage B · TSN feature (mmaction2 1회 호출 · parmap --core N) ───────────
log "STAGE B · TSN features (mmaction2 batch, cores=$CORES)"
T_FEAT_S=$(date +%s.%N)
cd /root/workspace/prepare
python extract_feature.py \
  --video_root_path "$CHUNKS_DIR" \
  --feature_root_path "$FEAT_DIR" \
  --gpu 0 --core "$CORES" 2>&1 | tail -6
T_FEAT=$(python -c "print(f'{$(date +%s.%N) - ${T_FEAT_S}:.2f}')")
log "STAGE B done · ${T_FEAT}s"
N_PKL=$(find "$FEAT_DIR" -name '*_tsn.pkl' | wc -l)
log "feature pkls: $N_PKL / $N"

# ── Stage C · infer batch (모델 1회 로드) ──────────────────────────────────
log "STAGE C · SJNET batch infer"
FEAT_LIST="$OUT/features_list.tsv"
: > "$FEAT_LIST"
for ((i=0; i<N; i++)); do
  NAME=$(printf 'c%03d' $i)
  FPKL="$FEAT_DIR/${NAME}_tsn.pkl"
  [ ! -f "$FPKL" ] && continue
  CDUR=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$CHUNKS_DIR/${NAME}.mp4")
  printf "%d\t%s\t%s\n" "$i" "$FPKL" "$CDUR" >> "$FEAT_LIST"
done
T_INFER_S=$(date +%s.%N)
python /gebd/scripts/infer_batch.py \
  --model "$MODEL" \
  --features-list "$FEAT_LIST" \
  --out-dir "$PARTS_DIR" 2>&1 | tail -5
T_INFER=$(python -c "print(f'{$(date +%s.%N) - ${T_INFER_S}:.2f}')")
log "STAGE C done · ${T_INFER}s"

T_TOTAL=$(python -c "print(f'{$(date +%s.%N) - ${T_TOTAL_S}:.2f}')")

log "MERGE parts → boundaries.json"
python << PY
import json, glob, re, os
OUT = "$OUT"; CHUNK_SEC = $CHUNK_SEC
DURATION = float("$DURATION")
parts = sorted(glob.glob(f"{OUT}/parts/c*.json"))
all_b = []
for p in parts:
    i = int(re.search(r"c(\d+)\.json", p).group(1))
    off = i * CHUNK_SEC
    d = json.load(open(p, encoding="utf-8"))
    if isinstance(d.get("boundaries"), list) and d["boundaries"] and isinstance(d["boundaries"][0], dict):
        for b in d["boundaries"]:
            t = off + float(b["t"])
            if t <= DURATION:
                all_b.append({"t": round(t, 3), "score": b.get("score"),
                               "kind": b.get("kind","unknown"), "source": "gebd"})
    else:
        for t in d.get("boundaries_sec", []):
            real = off + float(t)
            if real <= DURATION:
                all_b.append({"t": round(real,3), "score": None,
                               "kind": "unknown", "source": "gebd"})
all_b.sort(key=lambda x: x["t"])
dedup = []
for b in all_b:
    if not dedup or b["t"] - dedup[-1]["t"] > 1.0:
        dedup.append(b)
merged = {
  "source": "gebd", "model": "model_cla_f_0_s_-1_7728.pt", "time_unit": 1,
  "video_duration_sec": DURATION, "chunk_sec": CHUNK_SEC,
  "num_chunks": len(parts), "num_boundaries": len(dedup),
  "boundaries": dedup, "boundaries_sec": [b["t"] for b in dedup],
  "stage_cut_sec": float("$T_CUT"),
  "stage_feat_sec": float("$T_FEAT"),
  "stage_infer_sec": float("$T_INFER"),
  "wall_clock_sec": float("$T_TOTAL"),
  "cores": $CORES,
}
json.dump(merged, open(f"{OUT}/boundaries.json","w",encoding="utf-8"), indent=2, ensure_ascii=False)
n_hi = sum(1 for b in dedup if (b.get("score") or 0) >= 0.35)
n_mid = sum(1 for b in dedup if 0.18 <= (b.get("score") or 0) < 0.35)
print(f"[merge] {len(dedup)} boundaries · hard={n_hi} soft={n_mid} · total ${T_TOTAL}s (cut={float('$T_CUT'):.0f}s feat={float('$T_FEAT'):.0f}s infer={float('$T_INFER'):.0f}s)")
PY

log "DONE"
