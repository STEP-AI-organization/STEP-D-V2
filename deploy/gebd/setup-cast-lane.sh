#!/usr/bin/env bash
# Install and register the YOLO/ArcFace cast lane on the existing L4 VM.
# GEBD stays in its own Docker image; this lane uses a separate Python venv.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/stepd}"
CAST_VENV="${CAST_VENV:-/opt/stepd-cast-venv}"
sudo apt-get update -qq
sudo apt-get install -y -qq python3-venv python3-dev build-essential

sudo python3 -m venv "$CAST_VENV"
sudo "$CAST_VENV/bin/pip" install --no-cache-dir --upgrade pip
sudo "$CAST_VENV/bin/pip" install --no-cache-dir \
  "numpy==2.4.6" "opencv-contrib-python-headless==4.14.0.94" \
  -r "$APP_DIR/core/requirements-yolo.txt"

sudo tee /etc/systemd/system/stepd-worker-cast.service >/dev/null <<EOF
[Unit]
Description=STEP-D queue worker (registered cast YOLO lane · L4 GPU)
After=cloud-sql-proxy.service network-online.target
Requires=cloud-sql-proxy.service

[Service]
WorkingDirectory=${APP_DIR}/apps/server
EnvironmentFile=/etc/stepd/worker.env
Environment=WORKER_JOBS=cast
Environment=WORKER_MODE=drain
Environment=CORE_PYTHON=${CAST_VENV}/bin/python
Environment=CORE_DIR=${APP_DIR}
Environment=YOLO_CAST_MODE=gpu
Environment=RUN_YOLO_CAST=1
Environment=YOLO_CAST_DEVICE=0
Environment=YOLO_CAST_FACE_PROVIDERS=CUDAExecutionProvider,CPUExecutionProvider
ExecStart=/usr/bin/npx tsx src/worker.ts --drain
Restart=on-failure
RestartSec=10
TimeoutStopSec=2700
StandardOutput=journal
StandardError=journal
SyslogIdentifier=stepd-worker-cast

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now stepd-worker-cast.service
echo "cast lane ready: $CAST_VENV"
echo "logs: sudo journalctl -u stepd-worker-cast -f"
