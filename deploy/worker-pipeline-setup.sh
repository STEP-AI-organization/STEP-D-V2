#!/usr/bin/env bash
# Install the core CONTENT pipeline (Python) on the worker VM so the Node worker can
# invoke it. Additive to worker-vm.sh (which set up the Node queue worker).
#
# The pipeline is GPU-free: STT_PROVIDER=gemini uses Gemini audio on Vertex AI, and
# every other stage (refine/scenes/vision/names/recommend) is Gemini too. Auth is the
# VM's service account via ADC — it already holds roles/aiplatform.user, so there is
# NO key to install. This VM (e2-small, no GPU) can therefore run the whole thing.
#
# Run ON the VM after worker-vm.sh:
#   gcloud compute ssh stepd-worker --zone us-central1-a --command "sudo bash /opt/stepd/deploy/worker-pipeline-setup.sh"
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/stepd}"
VENV="${VENV:-$APP_DIR/core/.venv}"

echo "==> System deps (ffmpeg, python venv)"
sudo apt-get update -qq
sudo apt-get install -y -qq ffmpeg python3-venv python3-pip

echo "==> Python venv for the content pipeline"
# Ubuntu 24.04 ships python3.12; the core code is 3.10+ compatible. faster-whisper is
# NOT installed here (that's the local-GPU-only provider) — production uses Gemini STT.
if [ ! -d "$VENV" ]; then
  python3 -m venv "$VENV"
fi
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet -r "$APP_DIR/core/requirements.txt"

echo "==> yt-dlp (YouTube URL ingest — worker's youtube.download job spawns \`yt-dlp\`)"
# NIGHTLY, not stable. YouTube rotates its 'n' challenge (a JS puzzle gating media formats);
# a stable yt-dlp that predates the current puzzle fails with "n challenge solving failed →
# Only images are available", and NO media downloads at all (hit 2026-07-21). Nightly tracks
# the puzzle. Pin nightly + keep it updated on every provisioning run.
"$VENV/bin/pip" install --quiet --upgrade --pre "yt-dlp[default]"
sudo ln -sf "$VENV/bin/yt-dlp" /usr/local/bin/yt-dlp

echo "==> deno (JS runtime for yt-dlp's n-challenge solver — EJS)"
# yt-dlp needs a JS runtime to run the challenge solver. Without it, same "Only images"
# failure as an outdated yt-dlp. deno is the runtime yt-dlp enables by default.
if ! command -v deno >/dev/null 2>&1; then
  sudo apt-get install -y -qq unzip
  curl -fsSL -o /tmp/deno.zip \
    https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip
  sudo unzip -oq /tmp/deno.zip -d /usr/local/bin && sudo chmod +x /usr/local/bin/deno
fi
deno --version | head -1

# Optional "reduce-Gemini" extras — the algorithmic pre-processing stack that lets the
# pipeline lean less on Gemini (STT fallback, richer scene pre-filter, real OCR). All are
# OPTIONAL: the pipeline degrades gracefully to the Gemini path without them, so this block
# is OPT-IN. Enable with:  INSTALL_PIPELINE_EXTRAS=1 sudo -E bash worker-pipeline-setup.sh
#   - faster-whisper : STT_FALLBACK — CPU int8 transcript when Gemini STT fails
#   - librosa        : audio onset signal for the scene pre-filter (else numpy RMS)
#   - paddleocr      : real 1st-pass OCR (Gemini validates the top-N only)
if [ "${INSTALL_PIPELINE_EXTRAS:-0}" = "1" ]; then
  echo "==> Optional pipeline extras (faster-whisper, librosa, paddleocr)"
  "$VENV/bin/pip" install --quiet faster-whisper librosa paddleocr paddlepaddle
else
  echo "==> Skipping optional extras (set INSTALL_PIPELINE_EXTRAS=1 to install"
  echo "    faster-whisper + librosa + paddleocr — pipeline runs Gemini-only without them)"
fi

echo "==> Smoke test: Vertex reachable via the VM service account (ADC, no key)"
"$VENV/bin/python" - <<'PY'
from google import genai
from google.genai import types
c = genai.Client(vertexai=True, project="step-d", location="asia-northeast3")
r = c.models.generate_content(model="gemini-2.5-flash", contents="'ok'만 답해",
    config=types.GenerateContentConfig(max_output_tokens=50,
        thinking_config=types.ThinkingConfig(thinking_budget=0)))
print("   Vertex OK ->", (r.text or "").strip()[:10])
PY

echo
echo "==> Done. Pipeline python: $VENV/bin/python"
echo "   The Node worker invokes it as: python -m core.pipeline <video> (cwd=$APP_DIR)"
echo "   Env for content jobs: STT_PROVIDER=gemini (default), GOOGLE_CLOUD_PROJECT=step-d,"
echo "                         VERTEX_LOCATION=asia-northeast3, CORE_PYTHON=$VENV/bin/python"
