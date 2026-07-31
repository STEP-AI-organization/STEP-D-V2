#!/usr/bin/env bash
# Provision the STEP-D GEBD (장면 경계) worker on an on-demand GPU VM.
#
# 이 VM 은 mmaction2 (GEBD) inference 만 담당한다. content.analyze 파이프라인이
# gebd.detect 잡을 enqueue 하면 여기서 픽업 → Docker 컨테이너로 boundaries.json 만들어
# GCS 에 올리고, 원 잡을 재개 트리거. idle 10분 지속되면 자기 자신 shutdown.
#
# 왜 별도 VM 인가:
# - Cloud Run: GPU 미지원
# - 기존 worker VM (deploy/worker-vm.sh): 2-lane CPU 워커 · GPU 없음 · nvidia-driver 미설치
# - GEBD 는 하루 20-80분만 필요 → spot T4 로 만들어 idle 시 STOP → 월 $6-10 목표
#
# 실행 순서 (한 번만):
#   1. `bash deploy/gebd-vm-create.sh`  ← spot T4 인스턴스 생성 (startup-script 로 이 파일 자동 실행)
#   2. 인스턴스 부팅 완료 후 · 자동으로 gebd lane 서비스 등록
#   3. 이후: 큐 트리거 (POST /api/admin/gebd-vm/wake) 로만 부팅
#
# Idempotent: 재부팅 · re-provision 안전.

set -euo pipefail

REGION="${REGION:-asia-northeast3}"
SQL_INSTANCE="${SQL_INSTANCE:-step-d:asia-northeast3:stepd-db}"
REPO_URL="${REPO_URL:-https://github.com/STEP-AI-organization/STEP-D-V2.git}"
APP_DIR="${APP_DIR:-/opt/stepd}"
# GEBD Docker 이미지 (GAR · gebd Dockerfile 별도 준비 · deploy/gebd-docker/)
GEBD_IMAGE="${GEBD_IMAGE:-asia-northeast3-docker.pkg.dev/step-d/stepd/gebd-mmaction2:latest}"
# idle 자동 종료 임계 (초). pending gebd.detect == 0 이 이 시간 지속되면 shutdown.
IDLE_SHUTDOWN_SEC="${IDLE_SHUTDOWN_SEC:-600}"

echo "==> Base packages"
sudo apt-get update -qq
sudo apt-get install -y -qq git curl ca-certificates jq

echo "==> Node 24"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
sudo corepack enable || true

echo "==> Docker (GEBD 컨테이너 호스트)"
# deep-learning-vm 이미지엔 이미 Docker 있음 · 없으면 설치
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
fi
# nvidia-container-toolkit (GPU 컨테이너)
if ! dpkg -s nvidia-container-toolkit >/dev/null 2>&1; then
  distribution=$(. /etc/os-release; echo $ID$VERSION_ID)
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -s -L "https://nvidia.github.io/libnvidia-container/${distribution}/libnvidia-container.list" | \
    sudo sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
    sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
  sudo apt-get update -qq
  sudo apt-get install -y -qq nvidia-container-toolkit
  sudo systemctl restart docker
fi

echo "==> Cloud SQL Auth Proxy"
if [ ! -x /usr/local/bin/cloud-sql-proxy ]; then
  curl -fsSL -o /tmp/csp \
    "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.14.1/cloud-sql-proxy.linux.amd64"
  sudo install -m 0755 /tmp/csp /usr/local/bin/cloud-sql-proxy
fi

sudo tee /etc/systemd/system/cloud-sql-proxy.service >/dev/null <<EOF
[Unit]
Description=Cloud SQL Auth Proxy
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/cloud-sql-proxy --address 127.0.0.1 --port 5432 ${SQL_INSTANCE}
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF

echo "==> Source"
sudo mkdir -p "$APP_DIR"
sudo chown -R "$USER":"$USER" "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth 1 origin main
  git -C "$APP_DIR" reset --hard origin/main
else
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
pnpm install --filter @stepd/server... --frozen-lockfile --ignore-scripts
pnpm rebuild esbuild

echo "==> Secrets + config → /etc/stepd/worker.env"
APP_DIR="$APP_DIR" bash "$APP_DIR/deploy/worker-env.sh"

echo "==> Pull GEBD Docker image"
sudo gcloud auth configure-docker asia-northeast3-docker.pkg.dev --quiet || true
sudo docker pull "$GEBD_IMAGE" || {
  echo "!! GEBD 이미지 pull 실패 · GEBD_IMAGE=$GEBD_IMAGE · GAR 권한/이미지 확인" >&2
  exit 1
}

echo "==> GEBD worker service (single lane: gebd)"
# worker.ts 안 gebd.detect 핸들러가 Docker run 을 호출한다 (파일 참조: apps/server/src/worker.ts).
# WORKER_JOBS=gebd 로 이 프로세스는 gebd.* 잡만 픽업 · content/youtube lane 과 격리.
sudo tee /etc/systemd/system/stepd-worker-gebd.service >/dev/null <<EOF
[Unit]
Description=STEP-D queue worker (gebd lane · GPU)
After=cloud-sql-proxy.service docker.service
Requires=cloud-sql-proxy.service docker.service

[Service]
WorkingDirectory=${APP_DIR}/apps/server
EnvironmentFile=/etc/stepd/worker.env
Environment=WORKER_JOBS=gebd
Environment=GEBD_IMAGE=${GEBD_IMAGE}
ExecStart=/usr/bin/npx tsx src/worker.ts
Restart=always
RestartSec=10
TimeoutStopSec=180
StandardOutput=journal
StandardError=journal
SyslogIdentifier=stepd-worker-gebd

[Install]
WantedBy=multi-user.target
EOF

echo "==> Auto-shutdown daemon (idle ${IDLE_SHUTDOWN_SEC}s)"
# pending gebd.detect 잡 == 0 이 IDLE_SHUTDOWN_SEC 지속되면 VM shutdown.
# Cloud Scheduler 가 다시 필요할 때 wake 라우트로 부팅함.
# psql 로 큐 조회 · 무의미 · gebd.detect=0 조건.
sudo tee /usr/local/bin/gebd-idle-shutdown.sh >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
IDLE=${IDLE_SHUTDOWN_SEC:-600}
COUNT_FILE=/var/tmp/gebd-idle-count
touch "$COUNT_FILE"
while true; do
  # pending gebd.detect 잡 수 조회 (queue.ts::queueStats 등가 SQL)
  PENDING=$(psql -h 127.0.0.1 -U stepd -d stepd -tAc \
    "SELECT COUNT(*) FROM job_queue WHERE type = 'gebd.detect' AND status IN ('pending','running')" 2>/dev/null || echo -1)
  if [ "$PENDING" = "0" ]; then
    NOW=$(date +%s)
    IDLE_SINCE=$(cat "$COUNT_FILE" 2>/dev/null || echo "$NOW")
    if [ -z "$IDLE_SINCE" ] || [ "$IDLE_SINCE" = "0" ]; then
      echo "$NOW" > "$COUNT_FILE"
    else
      DIFF=$((NOW - IDLE_SINCE))
      if [ "$DIFF" -ge "$IDLE" ]; then
        logger -t gebd-idle "shutdown after ${DIFF}s idle (threshold ${IDLE}s)"
        /sbin/shutdown -h now
        exit 0
      fi
    fi
  else
    echo "0" > "$COUNT_FILE"
  fi
  sleep 60
done
EOF
sudo chmod +x /usr/local/bin/gebd-idle-shutdown.sh

sudo tee /etc/systemd/system/gebd-idle-shutdown.service >/dev/null <<EOF
[Unit]
Description=GEBD VM auto-shutdown daemon (idle >${IDLE_SHUTDOWN_SEC}s)
After=cloud-sql-proxy.service
Requires=cloud-sql-proxy.service

[Service]
Environment=IDLE_SHUTDOWN_SEC=${IDLE_SHUTDOWN_SEC}
ExecStart=/usr/local/bin/gebd-idle-shutdown.sh
Restart=always
RestartSec=30
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now cloud-sql-proxy.service
sudo systemctl enable --now stepd-worker-gebd.service
sudo systemctl enable --now gebd-idle-shutdown.service

echo
echo "==> Done. GEBD VM provisioned."
echo "    gebd worker logs:   sudo journalctl -u stepd-worker-gebd -f"
echo "    idle daemon logs:   sudo journalctl -u gebd-idle-shutdown -f"
echo "    Docker image:       ${GEBD_IMAGE}"
echo "    idle shutdown:      ${IDLE_SHUTDOWN_SEC}s"
