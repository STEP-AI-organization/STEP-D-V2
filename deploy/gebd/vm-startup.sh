#!/bin/bash
# GEBD GPU VM 부팅 스크립트 — GCE metadata `startup-script` 로 넣는다.
#
# 이 VM 이 하는 일:
#   1) 프로덕션 큐에서 `gebd.detect` 잡만 claim (WORKER_JOBS=gebd)
#   2) GCS 에서 영상 받아 Docker(GPU) 로 boundaries.json 생성 → GCS 업로드
#   3) content.analyze 재큐 → Cloud Run 이 beats 이후를 재생성
#   4) **할 일이 없으면 스스로 종료** (IDLE_SHUTDOWN_MIN)
#
# 비용 구조상 idle 종료가 핵심이다. 상시로 켜두면 n1-standard-8 + T4 가 월 $530 이다.
# 정지 중에는 부팅 디스크만 과금된다(60GB pd-standard ≈ 월 $2.4).
#
# 베이스 이미지는 Deep Learning VM (NVIDIA 드라이버 + Docker + nvidia-container-toolkit 내장)
# 을 쓴다 — 드라이버를 직접 깔면 부팅마다 수 분이 더 든다.
set -uo pipefail
exec > >(tee -a /var/log/gebd-startup.log) 2>&1
echo "[gebd-vm] $(date -u) 부팅 시작"

PROJECT="${PROJECT:-step-d}"
REGION="us-central1"
REPO_DIR=/opt/stepd
IDLE_SHUTDOWN_MIN="${IDLE_SHUTDOWN_MIN:-10}"

md() { curl -s -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" 2>/dev/null; }

GEBD_IMAGE="$(md gebd-image)"
GEBD_MODEL_GCS="$(md gebd-model-gcs)"
REPO_URL="$(md repo-url)"
REPO_BRANCH="$(md repo-branch)"
: "${GEBD_IMAGE:=us-central1-docker.pkg.dev/step-d/stepd/gebd-mmaction2:latest}"
: "${GEBD_MODEL_GCS:=gs://stepd-media/models/gebd/model_cla_f_0_s_-1_7728.pt}"
: "${REPO_BRANCH:=main}"

# ── 1. 드라이버 확인 ─────────────────────────────────────────────────────────
if ! nvidia-smi >/dev/null 2>&1; then
  echo "[gebd-vm] NVIDIA 드라이버 설치 중…"
  /opt/deeplearning/install-driver.sh || {
    echo "[gebd-vm] ⚠️ 드라이버 설치 실패 — GPU 없이는 GEBD 가 못 돈다"; exit 1; }
fi
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader

# ── 2. Docker (+GPU 런타임) ─────────────────────────────────────────────────
# ⚠️ `common-cu129-ubuntu-2204-nvidia-580` 이미지에는 **Docker 가 없다.**
# NVIDIA 드라이버는 들어 있지만(실측: L4 인식됨) docker 는 `command not found` 로 죽었다.
# DLVM 계열이라 다 있을 거라 가정하면 안 된다 — 없으면 깐다.
if ! command -v docker >/dev/null 2>&1; then
  echo "[gebd-vm] Docker 설치 중…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq docker.io || { echo "[gebd-vm] ⚠️ docker 설치 실패"; exit 1; }
  systemctl enable --now docker
fi
# 컨테이너에서 GPU 를 쓰려면 nvidia-container-toolkit 이 필요하다 (`--gpus all`)
if ! docker info 2>/dev/null | grep -qi nvidia; then
  echo "[gebd-vm] nvidia-container-toolkit 설치 중…"
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
    | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    > /etc/apt/sources.list.d/nvidia-container-toolkit.list
  apt-get update -qq && apt-get install -y -qq nvidia-container-toolkit
  nvidia-ctk runtime configure --runtime=docker && systemctl restart docker
fi
docker run --rm --gpus all "$GEBD_IMAGE" true 2>/dev/null || true   # 워밍업 (실패해도 아래서 재시도)

gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
echo "[gebd-vm] 이미지 pull: $GEBD_IMAGE"
docker pull "$GEBD_IMAGE" || { echo "[gebd-vm] ⚠️ pull 실패"; exit 1; }

# ── 3. 가중치 (1.58GB · 이미지에 없다) ───────────────────────────────────────
MODEL_LOCAL=/opt/gebd-model/model_cla_f_0_s_-1_7728.pt
if [ ! -f "$MODEL_LOCAL" ]; then
  mkdir -p /opt/gebd-model
  echo "[gebd-vm] 가중치 다운로드: $GEBD_MODEL_GCS"
  gcloud storage cp "$GEBD_MODEL_GCS" "$MODEL_LOCAL" || {
    echo "[gebd-vm] ⚠️ 가중치 다운로드 실패"; exit 1; }
fi

# ── 4. 리포 (worker.ts + deploy/gebd 자산) ───────────────────────────────────
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "[gebd-vm] 리포 클론 ($REPO_BRANCH)"
  git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$REPO_DIR" || {
    echo "[gebd-vm] ⚠️ 클론 실패 — repo-url 메타데이터 확인"; exit 1; }
else
  # ⚠️ `reset --hard origin/$BRANCH` 를 쓰면 안 된다. shallow clone(`--depth 1 --branch X`)은
  # 다른 브랜치의 원격 추적 ref 를 갖고 있지 않아서, repo-branch 메타데이터를 바꾸면
  # `unknown revision origin/main` 으로 실패한다. `&&` 체인이 끊기고 낡은 코드로 계속 돈다
  # (실측 2026-08-08: 이것 때문에 VM 이 24분간 켜져 있으면서 잡을 하나도 claim 하지 않았다).
  # FETCH_HEAD 를 쓰면 브랜치를 바꿔도 확실히 최신을 집는다.
  echo "[gebd-vm] 리포 갱신 ($REPO_BRANCH)"
  git -C "$REPO_DIR" fetch --depth 1 origin "$REPO_BRANCH" \
    && git -C "$REPO_DIR" checkout -B "$REPO_BRANCH" FETCH_HEAD \
    || echo "[gebd-vm] ⚠️ 리포 갱신 실패 — 기존 체크아웃으로 진행"
fi
echo "[gebd-vm] HEAD: $(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null) $(git -C "$REPO_DIR" log -1 --format=%s 2>/dev/null | cut -c1-50)"

command -v node >/dev/null || {
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs; }
(cd "$REPO_DIR/apps/server" && npm i -g pnpm >/dev/null 2>&1; pnpm install --no-frozen-lockfile)

# ── 5. 시크릿 ───────────────────────────────────────────────────────────────
sec() { gcloud secrets versions access latest --secret="$1" --project="$PROJECT" 2>/dev/null; }

# ⚠️ **`stepd-db-url` 을 쓰면 안 된다.** 그건 Cloud Run 전용으로 유닉스 소켓
# (`/cloudsql/step-d:us-central1:stepd-db/.s.PGSQL.5432`) 을 가리키는데, GCE VM 에는 그 경로가
# 없어서 `ENOENT connect` 로 죽는다(실측). VM 은 **Cloud SQL Auth Proxy + TCP** 로 붙는다 —
# 그 형식이 `stepd-worker-db-url`(127.0.0.1:5432) 이다.
if ! pgrep -f cloud-sql-proxy >/dev/null 2>&1; then
  echo "[gebd-vm] Cloud SQL Auth Proxy 기동"
  if [ ! -x /usr/local/bin/cloud-sql-proxy ]; then
    curl -fsSL -o /usr/local/bin/cloud-sql-proxy \
      "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.14.0/cloud-sql-proxy.linux.amd64" \
      && chmod +x /usr/local/bin/cloud-sql-proxy
  fi
  nohup /usr/local/bin/cloud-sql-proxy --port 5432 \
    "${PROJECT}:${REGION}:stepd-db" > /var/log/cloud-sql-proxy.log 2>&1 &
  for i in $(seq 1 30); do
    (echo > /dev/tcp/127.0.0.1/5432) >/dev/null 2>&1 && break
    sleep 2
  done
fi

export DATABASE_URL="$(sec stepd-worker-db-url)"
export GOOGLE_CLIENT_ID="$(sec stepd-google-client-id)"
export GOOGLE_CLIENT_SECRET="$(sec stepd-google-client-secret)"
export GCS_BUCKET=stepd-media
export NODE_ENV=production
export WORKER_JOBS=gebd
export WORKER_MODE=drain          # 큐 비면 종료 → 아래에서 VM 을 내린다
export GEBD_IMAGE GEBD_MODEL="$MODEL_LOCAL"
export GEBD_ASSETS="$REPO_DIR/deploy/gebd"

if [ -z "$DATABASE_URL" ]; then
  echo "[gebd-vm] ⚠️ DATABASE_URL 시크릿 접근 실패 — SA 에 secretAccessor 권한 확인"; exit 1
fi

# ── 6. 잡 소진 → 유휴 시 자체 종료 ───────────────────────────────────────────
# drain 모드라 큐가 비면 워커가 끝난다. 잠깐 기다렸다가 한 번 더 확인하고,
# 계속 비어 있으면 VM 을 정지한다. 새 잡이 오면 Cloud Scheduler/서버가 다시 켠다.
IDLE=0
while [ "$IDLE" -lt "$IDLE_SHUTDOWN_MIN" ]; do
  cd "$REPO_DIR/apps/server"
  BEFORE=$(date +%s)
  npx tsx src/worker.ts --drain
  RC=$?
  ELAPSED=$(( $(date +%s) - BEFORE ))
  # 워커가 즉시 죽으면(의존성·DB·env 문제) 조용히 유휴로 세다 종료해 버린다 —
  # 그럼 "잡을 하나도 안 집었다"는 사실이 로그에 안 남는다. 명시적으로 찍는다.
  [ "$RC" -ne 0 ] && echo "[gebd-vm] ⚠️ 워커 비정상 종료 (exit $RC · ${ELAPSED}s)"
  if [ "$ELAPSED" -lt 30 ]; then
    IDLE=$((IDLE + 1))
    echo "[gebd-vm] 처리할 잡 없음 (${IDLE}/${IDLE_SHUTDOWN_MIN}분)"
    sleep 60
  else
    IDLE=0   # 실제로 일했다 — 카운터 리셋
  fi
done

echo "[gebd-vm] ${IDLE_SHUTDOWN_MIN}분간 유휴 — VM 정지"
shutdown -h now
