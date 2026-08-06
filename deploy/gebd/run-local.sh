#!/usr/bin/env bash
# GEBD 학습모델 로컬 실행 — 영상 1개 → boundaries.json
#
# 사용: bash deploy/gebd/run-local.sh <video.mp4> <out_dir> [CHUNK_SEC] [CORES]
#
# 왜 래퍼가 필요한가: 원본 run_long_v3.sh 는 컨테이너 내부 경로(/gebd/…, /root/workspace/prepare)를
# 하드코딩한다. 여기서 호스트 경로를 그 자리에 마운트해 준다.
#
# 실측 제약 (memory: gebd-model-limits · gebd-gpu-parallel):
#   · CHUNK_SEC=60 이 정답 — 참조구현이 5분 하드코드라 그보다 길면 뒤가 잘린다
#   · RTX 3060 Ti 는 CORES=2 가 안전 (4는 VRAM 91% 로 렉)
#   · AV1 코덱은 못 읽는다 → h264 로 먼저 변환할 것
set -euo pipefail

VIDEO_HOST="${1:?사용: run-local.sh <video.mp4> <out_dir> [CHUNK_SEC] [CORES]}"
OUT_HOST="${2:?출력 디렉토리를 지정하세요}"
CHUNK_SEC="${3:-60}"
CORES="${4:-2}"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# 가중치는 **리포 밖**에 둔다 (1.5GB · .gitignore 로도 막지만 애초에 안 넣는 게 맞다).
# 위치를 바꾸려면 GEBD_MODEL 로 덮어쓸 것.
MODEL_HOST="${GEBD_MODEL:-$HOME/stepd-models/gebd/model_cla_f_0_s_-1_7728.pt}"
SCRIPTS_HOST="$REPO/deploy/gebd/scripts"

if [ ! -f "$MODEL_HOST" ]; then
  echo "모델 가중치 없음: $MODEL_HOST"
  echo "  원본: '비디오 전환 경계 추론 데이터/2.학습모델파일/model_cla_f_0_s_-1_7728.pt'"
  echo "  배치: mkdir -p ~/stepd-models/gebd && cp <원본> ~/stepd-models/gebd/"
  exit 1
fi
if ! docker image inspect "${GEBD_IMAGE:-event-boundary-detection:latest}" >/dev/null 2>&1; then
  echo "도커 이미지 없음: ${GEBD_IMAGE:-event-boundary-detection:latest}"
  echo "  로드: docker load -i '비디오 전환 경계 추론 데이터/5.도커이미지/event-boundary-detection.tar'"
  exit 1
fi
mkdir -p "$OUT_HOST"

# 컨테이너 안에서 /gebd 하나로 보이도록 스테이징 디렉토리를 만든다.
# mktemp 대신 고정 위치를 쓴다 — 실패 시 중간 산출물(청크·feature)을 들여다볼 수 있고,
# Docker 마운트에 넘길 Windows 절대경로도 안정적으로 얻는다.
STAGE="$REPO/tmp/gebd-stage"
# out/ 은 지우지 않는다 — Stage B(TSN feature)가 58.6분 영상에서 12.3분 걸린다.
# extract_feature.py 가 이미 있는 *_tsn.pkl 을 건너뛰므로, 뒷단만 고쳐 재실행할 때
# 그 12분을 다시 쓰지 않는다. 처음부터 다시 하려면 GEBD_FRESH=1.
if [ "${GEBD_FRESH:-0}" = "1" ]; then rm -rf "$STAGE"; fi
rm -rf "$STAGE/scripts" "$STAGE/cla"
mkdir -p "$STAGE/input" "$STAGE/models" "$STAGE/out"
# Docker 는 호스트 쪽 경로를 Windows 형식으로 받아야 한다 (Git Bash 의 /c/... 는 못 알아본다)
STAGE_WIN="$(cd "$STAGE" && pwd -W 2>/dev/null || echo "$STAGE")"
cp "$MODEL_HOST" "$STAGE/models/"
cp -r "$SCRIPTS_HOST" "$STAGE/scripts"
# cla/ 도 같이 올린다 — infer_batch.py 가 `CLA_DIR = <script>/../cla` 로 config·network 를
# 찾는다. 특히 network.SJNET 은 **필수**다: 가중치가 torch.save(network) 로 저장된 전체 객체라
# torch.load 가 클래스 정의를 import 할 수 있어야 한다. 없으면 Stage C 에서 죽는다.
cp -r "$REPO/deploy/gebd/cla" "$STAGE/cla"
cp "$VIDEO_HOST" "$STAGE/input/source.mp4"

echo "[gebd] video=$(basename "$VIDEO_HOST") · chunk=${CHUNK_SEC}s · cores=$CORES"
# ⚠️ MSYS_NO_PATHCONV=1 필수 (Git Bash/MSYS).
# 안 붙이면 컨테이너 내부 경로 `/gebd/...` 를 MSYS 가 호스트 경로로 번역해서
# `C:/Program Files/Git/gebd/...` 가 컨테이너로 넘어간다 — 2026-08-06 실제로 이걸로 실패했다.
# -v 의 호스트 쪽은 번역이 필요하므로 미리 변환해 둔 $STAGE_WIN 을 쓴다.
MSYS_NO_PATHCONV=1 docker run --rm --gpus all \
  -v "$STAGE_WIN":/gebd \
  -e VIDEO=/gebd/input/source.mp4 \
  -e CHUNK_SEC="$CHUNK_SEC" \
  -e CORES="$CORES" \
  "${GEBD_IMAGE:-event-boundary-detection:latest}" \
  bash /gebd/scripts/run_long_v3.sh

if [ -f "$STAGE/out/boundaries.json" ]; then
  cp "$STAGE/out/boundaries.json" "$OUT_HOST/boundaries.json"
  echo "[gebd] → $OUT_HOST/boundaries.json"
else
  echo "[gebd] ⚠️ boundaries.json 생성 실패 — 중간 산출물: $STAGE/out"; exit 1
fi
# 성공 시에도 스테이지는 남긴다 (청크·feature 재사용 · 재실행 시 rm -rf 로 정리됨)
