#!/usr/bin/env bash
# Install and register the YOLO/ArcFace cast lane on the existing L4 VM.
# GEBD stays in its own Docker image; this lane uses a separate Python venv.
#
# 2026-09-15 실측 반영 — 처음 설치해 보며 잡은 것 둘:
#  ① 라이브 VM 은 vm-startup.sh(메타데이터) 세대라 systemd cloud-sql-proxy.service 도
#     /etc/stepd/worker.env 도 **없다**. 전제하지 말고 없으면 만든다(있으면 그대로 둔다).
#  ② systemd 는 **EnvironmentFile 이 Environment= 를 덮는다**(man systemd.exec).
#     worker.env 의 CORE_PYTHON(core/.venv)이 cast venv 지정을 조용히 덮어 cast 잡이
#     YOLO 없는 파이썬으로 돌게 된다 → cast 전용 값은 **뒤에 읽히는 두 번째
#     EnvironmentFile(cast.env)** 로 넣는다.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/stepd}"
CAST_VENV="${CAST_VENV:-/opt/stepd-cast-venv}"
SQL_INSTANCE="${SQL_INSTANCE:-step-d:us-central1:stepd-db}"

# ── 0. 전제 조건 — vm-startup.sh 세대 VM 에는 없어서 여기서 채운다 ──────────────
if [ ! -f /etc/systemd/system/cloud-sql-proxy.service ]; then
  echo "==> cloud-sql-proxy.service 없음 — 설치 (vm.sh 와 동일 유닛)"
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
  sudo systemctl daemon-reload
  # vm-startup.sh 가 nohup 으로 띄운 프록시가 5432 를 점유 중이면 systemd 쪽이 못 뜬다
  sudo pkill -f cloud-sql-proxy || true
  sleep 2
  sudo systemctl enable --now cloud-sql-proxy.service
fi

if [ ! -f /etc/stepd/worker.env ]; then
  echo "==> /etc/stepd/worker.env 없음 — env.sh 로 생성"
  APP_DIR="$APP_DIR" bash "$APP_DIR/deploy/worker-vm/env.sh"
fi

# ── 1. cast 전용 venv ───────────────────────────────────────────────────────
# ⚠️ 시스템 python3(잼미 3.10)엔 numpy 2.4 배포판이 아예 없다(Requires-Python >=3.11).
# ⚠️ 그렇다고 **python3.11 을 깔면 안 된다** — jammy universe 의 python3.11 은
#   **3.11.0rc1 프리릴리스**다(2026-09-15 실측). rc1 엔 `sys.get_int_max_str_digits` 가
#   없는데 torch 폴리필 가드는 `>= (3, 11)` 이라 통과 → cast.detect 가 임포트에서 죽는다.
#   deadsnakes 추가가 조용히 실패하면 apt 가 이 rc1 을 잡는다. python3.12 는 jammy 에
#   패키지 자체가 없어 deadsnakes 외엔 출처가 없다 → rc 함정이 원천 차단된다.
sudo apt-get update -qq
if ! command -v python3.12 >/dev/null 2>&1; then
  sudo apt-get install -y -qq software-properties-common
  sudo add-apt-repository -y ppa:deadsnakes/ppa
  sudo apt-get update -qq
fi
# ffmpeg: yolo_cast 의 프레임 샘플링이 쓴다 — cv2 시킹은 인터레이스 방송 마스터에서
# 조용히 첫 프레임만 돌려줘 매칭이 전멸한다(2026-09-15 실측 · yolo_cast.py 주석).
sudo apt-get install -y -qq python3.12 python3.12-venv python3.12-dev build-essential ffmpeg
# 잡히지 말아야 할 빌드가 잡혔으면 여기서 멈춘다 — venv 를 만들고 나서 알면 늦다.
python3.12 -c "import sys; assert hasattr(sys, 'get_int_max_str_digits'), 'python3.12 가 프리릴리스 빌드다 — deadsnakes 확인'"

sudo python3.12 -m venv "$CAST_VENV"
sudo "$CAST_VENV/bin/pip" install --no-cache-dir --upgrade pip
sudo "$CAST_VENV/bin/pip" install --no-cache-dir \
  "numpy==2.4.6" "opencv-contrib-python-headless==4.14.0.94" \
  -r "$APP_DIR/core/requirements-yolo.txt"

# ── 2. cast 전용 env — worker.env 를 덮어야 하는 값은 전부 여기에 ────────────────
sudo tee /etc/stepd/cast.env >/dev/null <<EOF
WORKER_JOBS=cast
WORKER_MODE=drain
CORE_PYTHON=${CAST_VENV}/bin/python
CORE_DIR=${APP_DIR}
YOLO_CAST_MODE=gpu
RUN_YOLO_CAST=1
YOLO_CAST_DEVICE=0
YOLO_CAST_FACE_PROVIDERS=CUDAExecutionProvider,CPUExecutionProvider
EOF
sudo chmod 600 /etc/stepd/cast.env

# ── 3. systemd 유닛 ─────────────────────────────────────────────────────────
sudo tee /etc/systemd/system/stepd-worker-cast.service >/dev/null <<EOF
[Unit]
Description=STEP-D queue worker (registered cast YOLO lane · L4 GPU)
After=cloud-sql-proxy.service network-online.target
Requires=cloud-sql-proxy.service

[Service]
WorkingDirectory=${APP_DIR}/apps/server
EnvironmentFile=/etc/stepd/worker.env
EnvironmentFile=/etc/stepd/cast.env
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
