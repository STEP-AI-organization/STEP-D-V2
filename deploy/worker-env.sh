#!/usr/bin/env bash
# Single source of truth for the worker's /etc/stepd/worker.env.
#
# WHY THIS IS ITS OWN SCRIPT
#   worker-vm.sh (full provisioning) is the only thing that used to write this file, but it is
#   far too heavy to re-run against a live worker: it apt-installs, reinstalls node_modules,
#   chowns the app dir, and rewrites systemd units. So in practice nobody re-ran it and the env
#   file silently drifted behind the variables the code expects. On 2026-07-17 the VM was found
#   missing GCS_BUCKET and CORE_PYTHON, which would have made content.analyze fall back to
#   local-file mode with a Windows python path — i.e. broken the moment a real video was queued.
#   This script does ONLY the env reconciliation, so it is cheap enough to run on every deploy.
#
# CONTRACT — non-destructive and idempotent:
#   - adds ONLY missing variables; never edits, reorders, or removes an existing line
#   - never re-fetches a secret whose variable is already present, so a working DATABASE_URL
#     is never touched
#   - a fully-synced file is a pure no-op that makes NO gcloud/network calls at all
#   - backs the file up (timestamped) before the first change only
#   - no apt / pnpm / chown / systemd side effects
#   - does NOT restart the worker — the caller decides when (deploy-server.ps1 restarts after)
#   - prints variable NAMES only, never values (this file holds secrets)
#
# 🔒 UPLOAD GATE: this script never writes YOUTUBE_UPLOAD_ENABLED. Real YouTube uploads stay
#    OFF unless an operator sets that variable deliberately — add_var refuses the name outright
#    so it cannot be added here by accident. See docs/ops/youtube-upload-gate.md.
#
# Run ON the VM. NOT as root: it sudo's only where it must, matching worker-vm.sh's style
# (gcloud then runs as the invoking user, with that user's ADC, exactly as before):
#   bash /opt/stepd/deploy/worker-env.sh
#
# To add a NEW worker variable, add one add_var/add_secret line below — that is the only place
# it needs to exist. worker-vm.sh calls this script, so provisioning and drift-repair can never
# disagree about the values.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Derived from this script's own location (<APP_DIR>/deploy/worker-env.sh) so the install path
# is not hardcoded a second time here. worker-vm.sh passes APP_DIR in explicitly.
APP_DIR="${APP_DIR:-$(dirname "$SCRIPT_DIR")}"

ENV_FILE="${ENV_FILE:-/etc/stepd/worker.env}"
PROJECT="${PROJECT:-step-d}"
GCS_BUCKET="${GCS_BUCKET:-stepd-media}"
VERTEX_LOCATION="${VERTEX_LOCATION:-asia-northeast3}"
STT_PROVIDER="${STT_PROVIDER:-gemini}"

# `sudo` is skipped when already root (worker-vm.sh may be invoked either way, and tests run
# against a temp ENV_FILE as an ordinary user).
SUDO="sudo"
if [ "$(id -u)" = "0" ] || [ "${WORKER_ENV_NO_SUDO:-0}" = "1" ]; then SUDO=""; fi

changed=0
backed_up=0

have_var() { $SUDO grep -q "^$1=" "$ENV_FILE" 2>/dev/null; }

backup_once() {
  [ "$backed_up" -eq 1 ] && return 0
  # Nothing to preserve on a fresh box (file absent or empty) — don't litter an empty .bak.
  if [ ! -s "$ENV_FILE" ]; then backed_up=1; return 0; fi
  local bk
  bk="$ENV_FILE.bak.$(date +%Y%m%d-%H%M%S)"
  $SUDO cp -p "$ENV_FILE" "$bk"
  echo "   backup: $bk"
  backed_up=1
}

# add_var NAME VALUE — appends only if NAME is absent. VALUE is never echoed.
add_var() {
  local name=$1 value=$2
  if [ "$name" = "YOUTUBE_UPLOAD_ENABLED" ]; then
    echo "   REFUSED: worker-env.sh never manages YOUTUBE_UPLOAD_ENABLED (upload gate)" >&2
    return 1
  fi
  if have_var "$name"; then
    echo "   ok (present): $name"
    return 0
  fi
  backup_once
  printf '%s=%s\n' "$name" "$value" | $SUDO tee -a "$ENV_FILE" >/dev/null
  echo "   ADDED: $name"
  changed=1
}

# add_secret NAME SECRET_NAME — resolves the secret ONLY when NAME is missing, so an existing
# (working) value is never re-fetched or overwritten.
add_secret() {
  local name=$1 secret=$2 value
  if have_var "$name"; then
    echo "   ok (present, secret not re-fetched): $name"
    return 0
  fi
  value="$(gcloud secrets versions access latest --secret="$secret" --project="$PROJECT")"
  add_var "$name" "$value"
}

echo "==> Reconciling $ENV_FILE"
$SUDO mkdir -p "$(dirname "$ENV_FILE")"
if [ ! -f "$ENV_FILE" ]; then
  $SUDO touch "$ENV_FILE"
  $SUDO chmod 600 "$ENV_FILE"
fi

# ── THE definitions. Everything the worker needs lives here and nowhere else. ────────────
# Secrets (VM SA needs roles/secretmanager.secretAccessor). stepd-worker-db-url points at the
# local Cloud SQL proxy, unlike Cloud Run's unix-socket stepd-db-url.
add_secret DATABASE_URL         stepd-worker-db-url
add_secret GOOGLE_CLIENT_ID     stepd-google-client-id
add_secret GOOGLE_CLIENT_SECRET stepd-google-client-secret

# Storage + content pipeline. Without GCS_BUCKET the worker runs in local-file mode and cannot
# find the uploaded video; without CORE_PYTHON it falls back to a Windows path that does not
# exist on the VM. The rest mirror the code's own defaults, set explicitly so the config is
# inspectable on the box rather than implied.
add_var GCS_BUCKET           "$GCS_BUCKET"
add_var CORE_PYTHON          "$APP_DIR/core/.venv/bin/python"
add_var GOOGLE_CLOUD_PROJECT "$PROJECT"
add_var VERTEX_LOCATION      "$VERTEX_LOCATION"
add_var STT_PROVIDER         "$STT_PROVIDER"

# ── yt-dlp 쿠키 (선택) ───────────────────────────────────────────────────────────
# 공개 VM IP는 대량 다운로드 시 유튜브에 403/봇차단당한다. 계정 쿠키를 붙이면 지역제한·
# 봇차단·레이트리밋이 한 번에 풀린다. 다른 시크릿과 달리 쿠키는 만료·회전되므로
# **매번 시크릿에서 다시 받아 파일을 갱신**한다(고정값인 DATABASE_URL과 다른 취급).
# 시크릿이 없으면 조용히 건너뛴다 — 쿠키 없이도 지역제한 없는 영상은 받아진다.
COOKIE_FILE="$(dirname "$ENV_FILE")/ytdlp-cookies.txt"
if gcloud secrets describe stepd-ytdlp-cookies --project="$PROJECT" >/dev/null 2>&1; then
  if gcloud secrets versions access latest --secret=stepd-ytdlp-cookies --project="$PROJECT" \
       | $SUDO tee "$COOKIE_FILE" >/dev/null; then
    $SUDO chmod 600 "$COOKIE_FILE"
    add_var YTDLP_COOKIES "$COOKIE_FILE"
    echo "   refreshed: ytdlp-cookies.txt"
  else
    echo "   !! ytdlp-cookies 시크릿 접근 실패 — 쿠키 없이 진행" >&2
  fi
else
  echo "   (ytdlp-cookies 시크릿 없음 — 쿠키 미사용)"
fi

$SUDO chmod 600 "$ENV_FILE"

echo
if [ "$changed" -eq 1 ]; then
  echo "==> worker.env updated. Restart the lanes to pick it up:"
  echo "    sudo systemctl restart stepd-worker-youtube stepd-worker-content"
else
  echo "==> already in sync — no change made"
fi
