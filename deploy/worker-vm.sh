#!/usr/bin/env bash
# Provision the STEP-D queue worker on a small GCE VM.
#
#   Cloud Run (API)  →  enqueue  →  job_queue (Cloud SQL)  →  THIS VM  →  YouTube APIs
#
# The worker lives here rather than on Cloud Run because Cloud Run throttles CPU once
# a request ends and caps requests at 600s — neither works for background analysis or
# the long backfills a large channel needs.
#
# Run this ON the VM after `gcloud compute ssh stepd-worker --zone us-central1-a`.
# Idempotent: safe to re-run to pick up new code.
set -euo pipefail

REGION="${REGION:-asia-northeast3}"
SQL_INSTANCE="${SQL_INSTANCE:-step-d:asia-northeast3:stepd-db}"
# On-demand VM 자동 종료 임계 (초). pending 잡 == 0 이 이 시간 지속되면 shutdown.
# Cloud Scheduler wake 라우트가 필요할 때 다시 부팅. 0 으로 두면 상시 모드.
IDLE_SHUTDOWN_SEC="${IDLE_SHUTDOWN_SEC:-600}"
# Repo moved orgs 2026-07-16 (STEP-AI-official → STEP-AI-organization); the old default silently
# broke fresh provisioning. Matches `git remote -v`.
REPO_URL="${REPO_URL:-https://github.com/STEP-AI-organization/STEP-D-V2.git}"
APP_DIR="${APP_DIR:-/opt/stepd}"
# NOTE: worker.env values (PROJECT / GCS_BUCKET / VERTEX_LOCATION / STT_PROVIDER / CORE_PYTHON,
# and the secret names) are defined ONLY in deploy/worker-env.sh — deliberately not repeated
# here, so provisioning and drift-repair can never disagree. Overrides still pass through as
# env vars, e.g. `GCS_BUCKET=other bash worker-vm.sh`.

echo "==> Base packages"
sudo apt-get update -qq
sudo apt-get install -y -qq git curl ca-certificates

echo "==> Node 24"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
sudo corepack enable || true

echo "==> Cloud SQL Auth Proxy"
# The worker talks to Postgres over 127.0.0.1:5432; the proxy authenticates with the
# VM's service account via ADC, so there is no DB password on disk beyond the secret.
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
# esbuild (via tsx) has a postinstall that pnpm 11 refuses to run non-interactively,
# failing the whole install even though onlyBuiltDependencies lists it. Do it the way
# the Dockerfile does: skip all build scripts, then rebuild just the one we need.
pnpm install --filter @stepd/server... --frozen-lockfile --ignore-scripts
pnpm rebuild esbuild

echo "==> Secrets + config → /etc/stepd/worker.env"
# Delegated to worker-env.sh, which owns these definitions and is also what the deploy path
# runs on every deploy — one source of truth, so a provisioned VM and a deployed VM agree.
# It only ADDS missing variables, so re-running this provisioner never clobbers a live value.
APP_DIR="$APP_DIR" bash "$APP_DIR/deploy/worker-env.sh"

echo "==> Worker services (two lanes on one VM: youtube + content)"
# Two processes so a heavy content.analyze (STT/vision, minutes) never blocks the flood of
# light YouTube video.* jobs, and vice versa. WORKER_JOBS tells each process which job types
# to claim from the shared queue (FOR UPDATE SKIP LOCKED keeps them off each other's rows).
write_worker_service() {  # $1 = lane (youtube|content)
  sudo tee "/etc/systemd/system/stepd-worker-$1.service" >/dev/null <<EOF
[Unit]
Description=STEP-D queue worker ($1 lane)
After=cloud-sql-proxy.service
Requires=cloud-sql-proxy.service

[Service]
WorkingDirectory=${APP_DIR}/apps/server
EnvironmentFile=/etc/stepd/worker.env
Environment=WORKER_JOBS=$1
ExecStart=/usr/bin/npx tsx src/worker.ts
Restart=always
RestartSec=10
# The worker finishes its current job on SIGTERM; give it room before SIGKILL.
TimeoutStopSec=120
StandardOutput=journal
StandardError=journal
SyslogIdentifier=stepd-worker-$1

[Install]
WantedBy=multi-user.target
EOF
}
write_worker_service youtube
write_worker_service content

sudo systemctl daemon-reload
sudo systemctl enable --now cloud-sql-proxy.service
# Retire the old single-lane worker if present — its work is now split across the two lanes.
sudo systemctl disable --now stepd-worker.service 2>/dev/null || true
sudo systemctl enable stepd-worker-youtube.service stepd-worker-content.service
sudo systemctl restart stepd-worker-youtube.service stepd-worker-content.service


# On-demand 모드 (IDLE_SHUTDOWN_SEC > 0) · pending 잡 == 0 이 지속되면 VM shutdown.
# Cloud Scheduler → /api/admin/worker-vm/wake → gcloud compute instances start 로 재부팅.
# gebd.detect 는 별 VM (GPU · deploy/gebd-vm.sh) · content/youtube 잡만 감시.
if [ "${IDLE_SHUTDOWN_SEC}" != "0" ]; then
  echo "==> Auto-shutdown daemon (idle ${IDLE_SHUTDOWN_SEC}s)"
  sudo tee /usr/local/bin/worker-idle-shutdown.sh >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
IDLE=${IDLE_SHUTDOWN_SEC:-600}
COUNT_FILE=/var/tmp/worker-idle-count
touch "$COUNT_FILE"
while true; do
  # content · youtube 잡 (GEBD 는 별 VM 이라 제외). status pending or running 있으면 idle 아님.
  PENDING=$(psql -h 127.0.0.1 -U stepd -d stepd -tAc \
    "SELECT COUNT(*) FROM job_queue
     WHERE type IN ('content.analyze','youtube.download','video.analyze','channel.analyze',
                    'video.comments','video.hotwatch','distribution.publish',
                    'match.align','match.segment','match.learn')
     AND status IN ('pending','running')" 2>/dev/null || echo -1)
  if [ "$PENDING" = "0" ]; then
    NOW=$(date +%s)
    IDLE_SINCE=$(cat "$COUNT_FILE" 2>/dev/null || echo "$NOW")
    if [ -z "$IDLE_SINCE" ] || [ "$IDLE_SINCE" = "0" ]; then
      echo "$NOW" > "$COUNT_FILE"
    else
      DIFF=$((NOW - IDLE_SINCE))
      if [ "$DIFF" -ge "$IDLE" ]; then
        logger -t worker-idle "shutdown after ${DIFF}s idle (threshold ${IDLE}s)"
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
  sudo chmod +x /usr/local/bin/worker-idle-shutdown.sh

  sudo tee /etc/systemd/system/worker-idle-shutdown.service >/dev/null <<EOF
[Unit]
Description=stepd-worker VM auto-shutdown daemon (idle >${IDLE_SHUTDOWN_SEC}s)
After=cloud-sql-proxy.service
Requires=cloud-sql-proxy.service

[Service]
Environment=IDLE_SHUTDOWN_SEC=${IDLE_SHUTDOWN_SEC}
ExecStart=/usr/local/bin/worker-idle-shutdown.sh
Restart=always
RestartSec=30
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now worker-idle-shutdown.service
fi

echo
echo "==> Done. Two worker lanes running on this VM."
echo "    youtube logs:      sudo journalctl -u stepd-worker-youtube -f"
echo "    content logs:      sudo journalctl -u stepd-worker-content -f"
echo "    idle daemon logs:  sudo journalctl -u worker-idle-shutdown -f"
echo "    status:            sudo systemctl status 'stepd-worker-*'"
echo "    idle shutdown:     ${IDLE_SHUTDOWN_SEC}s (0 이면 상시 모드)"
