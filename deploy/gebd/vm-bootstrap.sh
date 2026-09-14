#!/usr/bin/env bash
# ⚠️ **이 스크립트는 프로덕션에 쓰이지 않는다 (2026-09-14 메타데이터 실측).**
#
# 프로덕션 GEBD VM 의 startup-script 는 `vm-startup.sh` 다. 둘 다 "부팅 스크립트" 라
# 오래 헷갈렸는데(deploy/README.md 참조), 메타데이터를 직접 읽어 확인했다.
# 이 파일은 systemd 기반의 **다른 설계**다 — 참고용으로 남겨 두지만 따라가지 말 것.
# 프로덕션을 고치려면 `vm-startup.sh` 를 고치고 `vm-push-startup.sh` 로 올린다.
# GEBD VM 부팅 시 자동 실행 (startup-script). 매 부팅마다 재실행됨 · idempotent 유지 필수.
#
# 흐름:
#   1. 최신 소스 pull (git reset --hard origin/main)
#   2. vm.sh 재실행 (Docker · systemd 유닛 재적용)
#   3. gebd worker + auto-shutdown daemon 상시 실행
#
# 로그는 /var/log/gebd-startup.log 와 시리얼 콘솔에 남는다.

set -euo pipefail

LOG=/var/log/gebd-startup.log
mkdir -p "$(dirname "$LOG")"
exec > >(tee -a "$LOG") 2>&1
echo "==== GEBD startup-script $(date -u +%FT%TZ) ===="

APP_DIR="${APP_DIR:-/opt/stepd}"
REPO_URL="${REPO_URL:-https://github.com/STEP-AI-organization/STEP-D-V2.git}"

# Instance metadata 로 GEBD_IMAGE 오버라이드 가능 (vm-create.sh 참조)
if META_IMAGE=$(curl -sf -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/gebd-image" 2>/dev/null); then
  export GEBD_IMAGE="$META_IMAGE"
fi

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

echo "==> Running deploy/gebd/vm.sh (idempotent provision)"
bash "$APP_DIR/deploy/gebd/vm.sh"

echo "==== GEBD startup-script done $(date -u +%FT%TZ) ===="
