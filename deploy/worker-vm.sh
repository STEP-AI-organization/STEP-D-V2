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

PROJECT="${PROJECT:-step-d}"
REGION="${REGION:-us-central1}"
SQL_INSTANCE="${SQL_INSTANCE:-step-d:us-central1:stepd-db}"
REPO_URL="${REPO_URL:-https://github.com/STEP-AI-official/STEP-D-V2.git}"
APP_DIR="${APP_DIR:-/opt/stepd}"

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
pnpm install --filter @stepd/server... --frozen-lockfile

echo "==> Secrets → /etc/stepd/worker.env"
# Pulled from Secret Manager at provision time (VM SA needs secretmanager.secretAccessor).
# WORKER_DB_URL points at the local proxy, unlike Cloud Run's unix-socket DATABASE_URL.
sudo mkdir -p /etc/stepd
{
  echo "DATABASE_URL=$(gcloud secrets versions access latest --secret=stepd-worker-db-url --project="$PROJECT")"
  echo "GOOGLE_CLIENT_ID=$(gcloud secrets versions access latest --secret=stepd-google-client-id --project="$PROJECT")"
  echo "GOOGLE_CLIENT_SECRET=$(gcloud secrets versions access latest --secret=stepd-google-client-secret --project="$PROJECT")"
} | sudo tee /etc/stepd/worker.env >/dev/null
sudo chmod 600 /etc/stepd/worker.env

echo "==> Worker service"
sudo tee /etc/systemd/system/stepd-worker.service >/dev/null <<EOF
[Unit]
Description=STEP-D queue worker
After=cloud-sql-proxy.service
Requires=cloud-sql-proxy.service

[Service]
WorkingDirectory=${APP_DIR}/apps/server
EnvironmentFile=/etc/stepd/worker.env
ExecStart=/usr/bin/npx tsx src/worker.ts
Restart=always
RestartSec=10
# The worker finishes its current job on SIGTERM; give it room before SIGKILL.
TimeoutStopSec=120
StandardOutput=journal
StandardError=journal
SyslogIdentifier=stepd-worker

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now cloud-sql-proxy.service
sudo systemctl restart stepd-worker.service
sudo systemctl enable stepd-worker.service

echo
echo "==> Done."
echo "    logs:    sudo journalctl -u stepd-worker -f"
echo "    status:  sudo systemctl status stepd-worker"
