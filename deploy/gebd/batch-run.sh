#!/usr/bin/env bash
# GEBD 배치 처리 — 영상 폴더 전체를 순차로 boundaries.json 까지.
#
# 사용: bash deploy/gebd/batch-run.sh <video_dir> <out_root> [CHUNK_SEC=300] [CORES=1]
#
# **재개 가능**하다. 각 단계 산출물이 있으면 건너뛴다:
#   chunks_flat/c*.mp4      Stage A (ffmpeg · CPU)
#   features_flat/*_tsn.pkl Stage B (mmaction2 TSN · GPU · 회당 ~12분)
#   boundaries.json         Stage C (SJNET 추론 · ~33초)
# 중간에 끊겨도 다시 실행하면 남은 것부터 이어간다 — 41편 8시간짜리 작업이라 이게 중요하다.
set -u

VDIR="${1:?사용: batch-run.sh <video_dir> <out_root> [CHUNK_SEC] [CORES]}"
OUT="${2:?출력 루트를 지정하세요}"
CHUNK_SEC="${3:-300}"
CORES="${4:-1}"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODEL="${GEBD_MODEL:-$HOME/stepd-models/gebd/model_cla_f_0_s_-1_7728.pt}"
IMAGE="${GEBD_IMAGE:-event-boundary-detection:latest}"
[ -f "$MODEL" ] || { echo "모델 없음: $MODEL"; exit 1; }

mkdir -p "$OUT"
total=$(ls "$VDIR"/*.mp4 2>/dev/null | wc -l)
i=0
for f in "$VDIR"/*.mp4; do
  i=$((i+1))
  name="$(basename "$f" .mp4)"
  w="$OUT/$name"
  mkdir -p "$w/chunks_flat"

  # ⚠️ 파일 존재만으로 "완료" 판정하면 안 된다 — 실패해도 boundaries.json 은 생성되고
  # 안이 비어 있다(실측: clean_* 2편이 0 boundaries 인데 성공으로 처리됐다).
  # 경계 개수를 실제로 세서 판정한다.
  if [ -f "$w/boundaries.json" ]; then
    nb=$(grep -o '"t"' "$w/boundaries.json" 2>/dev/null | wc -l)
    if [ "$nb" -gt 0 ]; then
      echo "[$i/$total] $name — 완료됨(경계 ${nb}개), 건너뜀"; continue
    fi
    echo "[$i/$total] $name — 이전 결과가 비어 있음(경계 0), 재처리"
    rm -f "$w/boundaries.json"
  fi
  echo "[$i/$total] $name  $(date '+%H:%M:%S')"

  # ── 스테이징 ────────────────────────────────────────────────────────────────
  # 원본 run_long_v3.sh 가 /gebd/{input,models,scripts,cla,out} 을 전제한다.
  # ⚠️ 영상을 **복사하지 않는다** — 파일 하나를 read-only 로 직접 마운트한다.
  #    41편 × 1.8GB 를 복사하면 디스크가 터진다(실측 여유 19GB).
  # ⚠️ 청크(회당 ~1.8GB)도 처리 직후 지운다. 남기면 47GB 가 쌓인다(실제로 그랬다).
  stage="$w/_stage"
  rm -rf "$stage"
  mkdir -p "$stage/models" "$stage/out"
  cp -r "$REPO/deploy/gebd/scripts" "$stage/scripts"
  cp -r "$REPO/deploy/gebd/cla" "$stage/cla"
  # prepare/ 필수 — module.py 의 1초 세그먼트 수정이 여기 있다 (없으면 0.3행/초).
  cp -r "$REPO/deploy/gebd/prepare" "$stage/prepare"
  cp "$MODEL" "$stage/models/"

  sw="$(cd "$stage" && pwd -W 2>/dev/null || echo "$stage")"
  vw="$(cd "$(dirname "$f")" && pwd -W 2>/dev/null || dirname "$f")/$(basename "$f")"
  MSYS_NO_PATHCONV=1 docker run --rm --gpus all \
    -v "$sw":/gebd -v "$vw":/gebd/input/source.mp4:ro \
    -e VIDEO=/gebd/input/source.mp4 -e CHUNK_SEC="$CHUNK_SEC" -e CORES="$CORES" \
    "$IMAGE" bash /gebd/scripts/run_long_v3.sh 2>&1 | tail -3

  nb=0
  [ -f "$stage/out/boundaries.json" ] && nb=$(grep -o '"t"' "$stage/out/boundaries.json" | wc -l)
  if [ "$nb" -gt 0 ]; then
    cp "$stage/out/boundaries.json" "$w/boundaries.json"
    # feature 만 보존 (학습 데이터셋 조립에 필요 · 회당 ~30MB), 나머지는 전부 정리
    mkdir -p "$w/features_flat"
    cp -n "$stage/out/features_flat"/*_tsn.pkl "$w/features_flat/" 2>/dev/null
    nf=$(ls "$w/features_flat" 2>/dev/null | wc -l)
    rm -rf "$stage" "$w/chunks_flat"
    echo "    ✅ 경계 ${nb}개 · feature ${nf}개 · 중간물 정리"
  else
    echo "    ⚠️ 실패(경계 0) — $stage/out 보존, 로그 확인 필요"
  fi
done
echo "완료 $(date '+%H:%M:%S')"
