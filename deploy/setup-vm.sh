#!/usr/bin/env bash
# Run ON the GCP VM (Ubuntu 22.04) after `gcloud compute ssh`. Idempotent.
# Installs Docker, mounts the persistent data disk at /data, and starts the prod
# stack. Edit apps/api/.env.production BEFORE the final `up` (the script pauses).
set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/app}"
DATA_DEV="${DATA_DEV:-/dev/disk/by-id/google-data}"   # device-name=data on the attached disk

echo "==> Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  echo "Re-login (or run: newgrp docker) so the docker group applies, then re-run."
fi

echo "==> Mount data disk at /data"
sudo mkdir -p /data
if ! mountpoint -q /data; then
  if ! sudo blkid "$DATA_DEV" >/dev/null 2>&1; then
    echo "Formatting $DATA_DEV (first time only)…"
    sudo mkfs.ext4 -F "$DATA_DEV"
  fi
  grep -q "$DATA_DEV /data " /etc/fstab || \
    echo "$DATA_DEV /data ext4 discard,defaults,nofail 0 2" | sudo tee -a /etc/fstab
  sudo mount -a
fi
sudo chmod 777 /data

echo "==> Env file"
cd "$REPO_DIR"
if [ ! -f apps/api/.env.production ]; then
  cp apps/api/.env.production.example apps/api/.env.production
  chmod 600 apps/api/.env.production
  echo "Created apps/api/.env.production — EDIT IT NOW (keys, DB pass, INSTANCE_CONNECTION_NAME, BUCKET)."
  echo "Then re-run this script to start the stack."
  exit 0
fi

echo "==> Start stack"
docker compose --env-file apps/api/.env.production -f docker-compose.prod.yml up -d --build
echo "==> Done. Watch certs:  docker compose -f docker-compose.prod.yml logs -f caddy"
echo "    Health:  curl -fsS https://\$API_DOMAIN/api/health"
