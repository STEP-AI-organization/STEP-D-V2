#!/usr/bin/env bash
# stepd-worker VM 부팅 시 자동 실행 (startup-script). 매 부팅마다 재실행됨 · idempotent.
#
# 흐름:
#   1. 최신 소스 pull (git reset --hard origin/main)
#   2. worker-vm.sh 재실행 (systemd 유닛 재적용 · content/youtube 2 lane + auto-shutdown daemon)
#   3. 서비스 상시 실행 · pending 잡 처리 · idle 지속 시 auto-shutdown
#
# 로그: /var/log/worker-startup.log 와 시리얼 콘솔.

set -euo pipefail

LOG=/var/log/worker-startup.log
mkdir -p "$(dirname "$LOG")"
exec > >(tee -a "$LOG") 2>&1
echo "==== stepd-worker startup-script $(date -u +%FT%TZ) ===="

APP_DIR="${APP_DIR:-/opt/stepd}"
REPO_URL="${REPO_URL:-https://github.com/STEP-AI-organization/STEP-D-V2.git}"

if [ ! -d "$APP_DIR/.git" ]; then
  echo "==> First boot · cloning repo"
  sudo mkdir -p "$APP_DIR"
  sudo chown -R "$USER":"$USER" "$APP_DIR" 2>/dev/null || true
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
else
  echo "==> Existing repo · fetching latest"
  git -C "$APP_DIR" fetch --depth 1 origin main
  git -C "$APP_DIR" reset --hard origin/main
fi

echo "==> Running worker-vm.sh (idempotent provision)"
bash "$APP_DIR/deploy/worker-vm.sh"

echo "==== stepd-worker startup-script done $(date -u +%FT%TZ) ===="
