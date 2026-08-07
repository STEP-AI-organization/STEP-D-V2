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
# 300 = FEATURE_LEN. prepare/module.py 가 1초 세그먼트를 보장하므로 300초 청크는
# 정확히 300행이 되어 **0 패딩이 사라진다**. 모델이 학습된 입력 형태와 같아진다.
# (예전 기본값 60 은 패딩 240행 + scale 오매핑이 겹쳐 경계가 청크 앞으로 몰렸다.)
CHUNK_SEC="${CHUNK_SEC:-300}"
CORES="${CORES:-1}"  # ⚠️ 1 로 둘 것. 아래 참조
# parmap 병렬(--core 2)이 신뢰할 수 없다 — 실측: 드라마 12청크에서 19분 돌고 **feature 0개**,
# 그 전 실행은 8/12 만 성공했다. 같은 청크를 --core 1 로 돌리면 **27초에 (300,2048) 정상 산출**.
# 즉 느린 원인도 실패 원인도 TSN 이 아니라 병렬화였다. 1 이면 12청크 ≈ 5분이라 병렬 이득도 없다.

# 컨테이너 내장 prepare/ 를 리포 버전으로 덮어쓴다 (있을 때만).
# module.py 의 `-c copy` → 재인코딩 수정이 여기 들어 있다.
if [ -f /gebd/prepare/module.py ]; then
  cp -f /gebd/prepare/*.py /root/workspace/prepare/
  echo "[prep] /gebd/prepare → /root/workspace/prepare 덮어씀"
fi

CHUNKS_DIR="$OUT/chunks_flat"  # 모든 청크 mp4 를 한 폴더에
FEAT_DIR="$OUT/features_flat"
PARTS_DIR="$OUT/parts"
mkdir -p "$CHUNKS_DIR" "$FEAT_DIR" "$PARTS_DIR"

log() { echo "[$(date +%H:%M:%S)] $*"; }

DURATION=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$VIDEO")
# ⚠️ ceil 만 쓰면 마지막에 **0.03초짜리 꼬리 청크**가 생겨 feature 추출이 실패한다
# (실측: 300.034초 영상 → chunks=2, 두 번째가 0.034초 → "feature pkls: 1 / 2").
# MIN_TAIL_SEC 미만의 꼬리는 아예 만들지 않는다 — 1행/초라 몇 초짜리는 어차피 못 쓴다.
MIN_TAIL_SEC="${MIN_TAIL_SEC:-5}"
N=$(python -c "
import math
d, c, m = float('$DURATION'), $CHUNK_SEC, $MIN_TAIL_SEC
n = math.ceil(d / c)
if n > 1 and d - (n - 1) * c < m:
    n -= 1
print(n)")
log "video=$VIDEO · dur=${DURATION}s · chunk=${CHUNK_SEC}s · chunks=$N · cores=$CORES"

T_TOTAL_S=$(date +%s.%N)

# ── Stage A · 1회 정규화 인코딩 → 정확한 CHUNK_SEC 청크 ────────────────────
#
# ⚠️ 예전에는 `-ss START -t CHUNK_SEC -c copy` 로 청크를 떴다. 스트림 복사는 **키프레임에서만**
# 자를 수 있어서 청크가 요청 지점보다 **앞에서 시작**한다. 실측(드라마): 청크 길이가
# 300.1 ~ 302.2초로 들쭉날쭉했고, 병합은 `off = i*CHUNK_SEC` 를 그대로 써서 경계가
# **청크마다 최대 2.2초씩 밀렸다.** 보정해 보니 tol 0.5s 적중 28% → 35% 로 올랐다.
#
# 그래서 여기서 **한 번만** 정규화 인코딩한다:
#   · `scale=-2:256`        — TSN 은 224px 로 보므로 이 이상은 낭비. 뒷단 디코딩도 싸진다
#   · `-force_key_frames`   — 매 1초 키프레임 → 세그먼터가 1초/300초 어디서든 정확히 자른다
#   · `-segment_time`       — 그 결과 청크는 정확히 CHUNK_SEC. 드리프트 0
# 이러면 prepare/module.py 의 1초 분할도 **스트림 복사로 정확**해진다 (재인코딩 불필요).
#
# ⚠️ `-map 0:v:0 -dn -write_tmcd 0` 는 유지할 것. 일부 마스터(clean_* 계열)에 타임코드(tmcd)
# 스트림이 있는데, 남으면 module.py 의 video_segmentation 이 "Could not write header" 로 죽고
# → 그 함수가 영상 경로를 리스트 경로로 반환 → delete_temporary_file 이 **청크 자체를 지운다**
# → feature 0개인데 파일은 생겨 조용히 성공처럼 보인다. `-dn` 만으로는 부족하다 (muxer 가 다시 씀).
log "STAGE A · 정규화 인코딩 + $N 청크 (256p · 1초 키프레임 · 정확 분할)"
T_CUT_S=$(date +%s.%N)
if [ ! -f "$CHUNKS_DIR/c000.mp4" ]; then
  ffmpeg -y -v error -i "$VIDEO" -an -sn -dn -map 0:v:0 -write_tmcd 0 \
    -vf "scale=-2:256" -c:v libx264 -preset ultrafast -crf 30 \
    -force_key_frames "expr:gte(t,n_forced*1)" \
    -f segment -segment_time "$CHUNK_SEC" -reset_timestamps 1 \
    "$CHUNKS_DIR/c%03d.mp4"
fi
# 실제 생성 개수로 N 을 다시 잡는다 (꼬리 청크가 MIN_TAIL_SEC 미만이면 버린다).
python - "$CHUNKS_DIR" "$CHUNK_SEC" "$MIN_TAIL_SEC" << 'PY'
import sys, os, glob, subprocess
d, cs, mt = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
for p in sorted(glob.glob(os.path.join(d, "c*.mp4"))):
    out = subprocess.run(["ffprobe","-v","error","-show_entries","format=duration",
                          "-of","default=nw=1:nk=1",p], capture_output=True, text=True)
    try:
        dur = float(out.stdout.strip())
    except ValueError:
        continue
    if dur < mt:
        os.remove(p)
        print(f"[cut] 꼬리 청크 제거: {os.path.basename(p)} ({dur:.2f}s < {mt}s)")
PY
N=$(find "$CHUNKS_DIR" -name 'c*.mp4' | wc -l)
T_CUT=$(python -c "print(f'{$(date +%s.%N) - ${T_CUT_S}:.2f}')")
log "STAGE A done · ${T_CUT}s · 청크 $N개"
# 정확성 점검 — 마지막 청크를 뺀 전부가 CHUNK_SEC 이어야 한다 (드리프트 0 확인)
python - "$CHUNKS_DIR" "$CHUNK_SEC" << 'PY'
import sys, os, glob, subprocess
d, cs = sys.argv[1], float(sys.argv[2])
ps = sorted(glob.glob(os.path.join(d, "c*.mp4")))
durs = []
for p in ps:
    o = subprocess.run(["ffprobe","-v","error","-show_entries","format=duration",
                        "-of","default=nw=1:nk=1",p], capture_output=True, text=True)
    durs.append(float(o.stdout.strip()))
if len(durs) > 1:
    body = durs[:-1]
    worst = max(abs(x - cs) for x in body)
    print(f"[check] 청크 길이 편차 최대 {worst:.3f}s "
          f"({'정상 · 드리프트 없음' if worst < 0.15 else '⚠️ 드리프트 발생 — 병합 오프셋이 어긋난다'})")
PY

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
# 행/초 점검 — 1.0 근처여야 한다. 0.3 이면 module.py 의 `-c copy` 회귀다.
python - "$FEAT_DIR" "$CHUNK_SEC" << 'PY'
import sys, glob, pickle, os
import numpy as np
d, cs = sys.argv[1], float(sys.argv[2])
ps = sorted(glob.glob(os.path.join(d, "*_tsn.pkl")))
if ps:
    rows = [np.array(pickle.load(open(p, "rb"))).shape[0] for p in ps]
    rps = np.mean(rows) / cs
    print(f"[check] feature 행수 min {min(rows)} · max {max(rows)} · 평균 {np.mean(rows):.1f} "
          f"→ {rps:.2f} 행/초")
    if rps < 0.8:
        print(f"[check] ⚠️ 1행/초에 크게 미달한다. prepare/module.py 재인코딩이 안 먹었을 수 있다.")
PY

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
