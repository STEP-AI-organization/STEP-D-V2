#!/bin/bash
# GEBD GPU VM 부팅 스크립트 — GCE metadata `startup-script` 로 넣는다.
#
# 이 VM 이 하는 일:
#   1) 프로덕션 큐에서 `gebd.detect` 잡만 claim (WORKER_JOBS=gebd)
#   2) GCS 에서 영상 받아 Docker(GPU) 로 boundaries.json 생성 → GCS 업로드
#   3) content.analyze 재큐 → Cloud Run 이 beats 이후를 재생성
#   4) **할 일이 없으면 스스로 종료** (IDLE_SHUTDOWN_MIN)
#
# 비용 구조상 idle 종료가 핵심이다. 상시로 켜두면 n1-standard-8 + T4 가 월 $530 이다.
# 정지 중에는 부팅 디스크만 과금된다(60GB pd-standard ≈ 월 $2.4).
#
# 베이스 이미지는 Deep Learning VM (NVIDIA 드라이버 + Docker + nvidia-container-toolkit 내장)
# 을 쓴다 — 드라이버를 직접 깔면 부팅마다 수 분이 더 든다.
set -uo pipefail
exec > >(tee -a /var/log/gebd-startup.log) 2>&1
echo "[gebd-vm] $(date -u) 부팅 시작"

PROJECT="${PROJECT:-step-d}"
REGION="us-central1"
REPO_DIR=/opt/stepd
IDLE_SHUTDOWN_MIN="${IDLE_SHUTDOWN_MIN:-10}"

md() { curl -s -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" 2>/dev/null; }

GEBD_IMAGE="$(md gebd-image)"
GEBD_MODEL_GCS="$(md gebd-model-gcs)"
REPO_URL="$(md repo-url)"
REPO_BRANCH="$(md repo-branch)"
: "${GEBD_IMAGE:=us-central1-docker.pkg.dev/step-d/stepd/gebd-mmaction2:latest}"
: "${GEBD_MODEL_GCS:=gs://stepd-media/models/gebd/model_cla_f_0_s_-1_7728.pt}"
: "${REPO_BRANCH:=main}"

# ── 1. 드라이버 확인 ─────────────────────────────────────────────────────────
if ! nvidia-smi >/dev/null 2>&1; then
  echo "[gebd-vm] NVIDIA 드라이버 설치 중…"
  /opt/deeplearning/install-driver.sh || {
    echo "[gebd-vm] ⚠️ 드라이버 설치 실패 — GPU 없이는 GEBD 가 못 돈다"; exit 1; }
fi
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader

# ── 2. Docker (+GPU 런타임) ─────────────────────────────────────────────────
# ⚠️ `common-cu129-ubuntu-2204-nvidia-580` 이미지에는 **Docker 가 없다.**
# NVIDIA 드라이버는 들어 있지만(실측: L4 인식됨) docker 는 `command not found` 로 죽었다.
# DLVM 계열이라 다 있을 거라 가정하면 안 된다 — 없으면 깐다.
if ! command -v docker >/dev/null 2>&1; then
  echo "[gebd-vm] Docker 설치 중…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq docker.io || { echo "[gebd-vm] ⚠️ docker 설치 실패"; exit 1; }
  systemctl enable --now docker
fi
# 컨테이너에서 GPU 를 쓰려면 nvidia-container-toolkit 이 필요하다 (`--gpus all`)
if ! docker info 2>/dev/null | grep -qi nvidia; then
  echo "[gebd-vm] nvidia-container-toolkit 설치 중…"
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
    | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    > /etc/apt/sources.list.d/nvidia-container-toolkit.list
  apt-get update -qq && apt-get install -y -qq nvidia-container-toolkit
  nvidia-ctk runtime configure --runtime=docker && systemctl restart docker
fi
docker run --rm --gpus all "$GEBD_IMAGE" true 2>/dev/null || true   # 워밍업 (실패해도 아래서 재시도)

gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
echo "[gebd-vm] 이미지 pull: $GEBD_IMAGE"
docker pull "$GEBD_IMAGE" || { echo "[gebd-vm] ⚠️ pull 실패"; exit 1; }

# ── 3. 가중치 (1.58GB · 이미지에 없다) ───────────────────────────────────────
MODEL_LOCAL=/opt/gebd-model/model_cla_f_0_s_-1_7728.pt
if [ ! -f "$MODEL_LOCAL" ]; then
  mkdir -p /opt/gebd-model
  echo "[gebd-vm] 가중치 다운로드: $GEBD_MODEL_GCS"
  gcloud storage cp "$GEBD_MODEL_GCS" "$MODEL_LOCAL" || {
    echo "[gebd-vm] ⚠️ 가중치 다운로드 실패"; exit 1; }
fi

# ── 4. 리포 (worker.ts + deploy/gebd 자산) ───────────────────────────────────
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "[gebd-vm] 리포 클론 ($REPO_BRANCH)"
  git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$REPO_DIR" || {
    echo "[gebd-vm] ⚠️ 클론 실패 — repo-url 메타데이터 확인"; exit 1; }
else
  # ⚠️ `reset --hard origin/$BRANCH` 를 쓰면 안 된다. shallow clone(`--depth 1 --branch X`)은
  # 다른 브랜치의 원격 추적 ref 를 갖고 있지 않아서, repo-branch 메타데이터를 바꾸면
  # `unknown revision origin/main` 으로 실패한다. `&&` 체인이 끊기고 낡은 코드로 계속 돈다
  # (실측 2026-08-08: 이것 때문에 VM 이 24분간 켜져 있으면서 잡을 하나도 claim 하지 않았다).
  # FETCH_HEAD 를 쓰면 브랜치를 바꿔도 확실히 최신을 집는다.
  echo "[gebd-vm] 리포 갱신 ($REPO_BRANCH)"
  # ⚠️ **갱신 실패를 경고만 하고 넘어가면 안 된다.** 예전엔 `|| echo 경고` 였고, 그래서
  # checkout 이 한 번 실패한 뒤로 **낡은 코드에 영구히 고정**됐다 — 그 낡은 코드의
  # seedIfEmpty 가 kv RLS 를 위반해 워커가 1초 만에 죽었고, GEBD 가 한 달 넘게 죽어
  # 있었다(2026-09-14 조사). 고정된 커밋이 하필 "VM 이 리포 갱신에 실패해…" 를 고치려던
  # 커밋이었다는 게 이 실패 모드의 성격을 말해준다 — **조용하고, 스스로 낫지 않는다.**
  #
  # 그래서 3단으로 간다: ① 평소 경로 ② 실패하면 **통째로 재클론**(자가치유)
  # ③ 그것도 실패하면 **크게 실패한다**. 낡은 코드로 계속 도는 것보다 안 도는 게 낫다 —
  # 어차피 낡은 코드는 잡을 못 집으면서 VM 요금만 태운다.
  #
  # dirty 트리가 checkout 을 막는 게 가장 흔한 원인이라 reset·clean 을 먼저 태운다.
  if git -C "$REPO_DIR" fetch --depth 1 origin "$REPO_BRANCH" \
     && git -C "$REPO_DIR" reset --hard >/dev/null 2>&1 \
     && git -C "$REPO_DIR" clean -fd >/dev/null 2>&1 \
     && git -C "$REPO_DIR" checkout -B "$REPO_BRANCH" FETCH_HEAD; then
    :
  else
    echo "[gebd-vm] ⚠️ 리포 갱신 실패 — 재클론한다 (낡은 코드로 진행하지 않는다)"
    rm -rf "$REPO_DIR"
    git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$REPO_DIR" || {
      echo "[gebd-vm] ⚠️ 재클론도 실패 — 중단한다. 낡은 코드로 도는 것보다 안 도는 게 낫다"
      echo "[gebd-vm] ⚠️ repo-url 메타데이터·디스크 용량(df -h)·네트워크를 확인할 것"
      df -h "$(dirname "$REPO_DIR")" || true
      exit 1; }
  fi
fi
echo "[gebd-vm] HEAD: $(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null) $(git -C "$REPO_DIR" log -1 --format=%s 2>/dev/null | cut -c1-50)"

command -v node >/dev/null || {
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs; }
# ⚠️ frozen — no-frozen 은 부팅마다 의존성이 클라우드와 다르게 풀릴 수 있다(버전 드리프트).
# GEBD 크래시루프(2026-08-25) 조사에서 이 드리프트가 유일한 환경 차이 축이었다.
# ⚠️ pnpm 도 **버전을 박는다**(package.json packageManager 와 동일). 2026-09-15 실측:
# 무지정 `npm i -g pnpm` 이 pnpm 12 를 깔았고, v9 lockfile 을 재해석하며 devDeps
# (playwright)를 빼고 설치 → worker.ts 임포트 그래프가 naver-tv 를 당겨 **부팅마다 1초
# 크래시루프**. CI=true 는 pnpm 이 남의 버전이 만든 modules 를 지울 때 TTY 확인을
# 요구하며 죽는 것(ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY)을 막는다.
(cd "$REPO_DIR/apps/server" && npm i -g pnpm@10.33.2 >/dev/null 2>&1; CI=true pnpm install --frozen-lockfile || CI=true pnpm install --no-frozen-lockfile)

# ── 5. 시크릿 ───────────────────────────────────────────────────────────────
sec() { gcloud secrets versions access latest --secret="$1" --project="$PROJECT" 2>/dev/null; }

# ⚠️ **`stepd-db-url` 을 쓰면 안 된다.** 그건 Cloud Run 전용으로 유닉스 소켓
# (`/cloudsql/step-d:us-central1:stepd-db/.s.PGSQL.5432`) 을 가리키는데, GCE VM 에는 그 경로가
# 없어서 `ENOENT connect` 로 죽는다(실측). VM 은 **Cloud SQL Auth Proxy + TCP** 로 붙는다 —
# 그 형식이 `stepd-worker-db-url`(127.0.0.1:5432) 이다.
if ! pgrep -f cloud-sql-proxy >/dev/null 2>&1; then
  echo "[gebd-vm] Cloud SQL Auth Proxy 기동"
  if [ ! -x /usr/local/bin/cloud-sql-proxy ]; then
    curl -fsSL -o /usr/local/bin/cloud-sql-proxy \
      "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.14.0/cloud-sql-proxy.linux.amd64" \
      && chmod +x /usr/local/bin/cloud-sql-proxy
  fi
  nohup /usr/local/bin/cloud-sql-proxy --port 5432 \
    "${PROJECT}:${REGION}:stepd-db" > /var/log/cloud-sql-proxy.log 2>&1 &
  for i in $(seq 1 30); do
    (echo > /dev/tcp/127.0.0.1/5432) >/dev/null 2>&1 && break
    sleep 2
  done
fi

export DATABASE_URL="$(sec stepd-worker-db-url)"
export GOOGLE_CLIENT_ID="$(sec stepd-google-client-id)"
export GOOGLE_CLIENT_SECRET="$(sec stepd-google-client-secret)"
export GCS_BUCKET=stepd-media
export NODE_ENV=production
export WORKER_JOBS=gebd
export WORKER_MODE=drain          # 큐 비면 종료 → 아래에서 VM 을 내린다
export GEBD_IMAGE GEBD_MODEL="$MODEL_LOCAL"
export GEBD_ASSETS="$REPO_DIR/deploy/gebd"

if [ -z "$DATABASE_URL" ]; then
  echo "[gebd-vm] ⚠️ DATABASE_URL 시크릿 접근 실패 — SA 에 secretAccessor 권한 확인"; exit 1
fi

# ── 6. 잡 소진 → 유휴 시 자체 종료 ───────────────────────────────────────────
# drain 모드라 큐가 비면 워커가 끝난다. 잠깐 기다렸다가 한 번 더 확인하고,
# 계속 비어 있으면 VM 을 정지한다. 새 잡이 오면 Cloud Scheduler/서버가 다시 켠다.
IDLE=0
CRASHES=0
while [ "$IDLE" -lt "$IDLE_SHUTDOWN_MIN" ]; do
  cd "$REPO_DIR/apps/server"
  BEFORE=$(date +%s)
  npx tsx src/worker.ts --drain
  RC=$?
  ELAPSED=$(( $(date +%s) - BEFORE ))

  if [ "$ELAPSED" -lt 30 ]; then
    # cast 레인(별도 systemd · setup-cast-lane.sh)이 아직 일하는 중이면 유휴가 아니다 —
    # gebd 큐만 보고 내리면 cast.detect 를 GPU 추론 도중에 죽인다 (2026-09-15).
    # drain 모드라 큐가 비면 서비스가 스스로 끝나므로 is-active 하나로 충분하다.
    if systemctl is-active --quiet stepd-worker-cast 2>/dev/null; then
      IDLE=0
      echo "[gebd-vm] cast 레인 작업 중 — 유휴 카운트 보류"
      sleep 60
      continue
    fi
    IDLE=$((IDLE + 1))
    # ⚠️ **크래시와 유휴를 절대 같은 문구로 찍지 말 것.**
    # 예전엔 둘 다 "처리할 잡 없음" 이었다. 워커가 1초 만에 죽어도 `ELAPSED < 30` 이라
    # 유휴로 세어졌고, 로그에는 "할 일이 없다" 고만 남았다 — 실제로는 큐에 12건이
    # 밀려 있었는데도. 그 한 줄 때문에 GEBD 가 **한 달 넘게 죽어 있는 걸 아무도 몰랐다**
    # (2026-09-14 조사). 실패를 "정상" 처럼 적는 로그는 없느니만 못하다.
    if [ "$RC" -ne 0 ]; then
      CRASHES=$((CRASHES + 1))
      echo "[gebd-vm] ⚠️ 워커가 즉시 죽었다 — **유휴가 아니다** (exit $RC · ${ELAPSED}s · ${CRASHES}회째)"
      echo "[gebd-vm] ⚠️ 큐의 gebd.detect 는 그대로 남는다. 위 스택트레이스를 볼 것."
    else
      echo "[gebd-vm] 처리할 잡 없음 (${IDLE}/${IDLE_SHUTDOWN_MIN}분)"
    fi
    sleep 60
  else
    IDLE=0       # 실제로 일했다 — 카운터 리셋
    CRASHES=0
  fi
done

if [ "$CRASHES" -gt 0 ]; then
  # 유휴가 아니라 **고장**으로 내려간다는 사실을 마지막 줄에 남긴다. 여기가 로그의
  # 끝이라 사람이 제일 먼저 보는 자리다 — "유휴 정지" 로 끝나면 고장이 묻힌다.
  echo "[gebd-vm] ⚠️ 정지한다 — 유휴가 아니라 워커가 ${CRASHES}회 연속 죽었기 때문이다"
else
  echo "[gebd-vm] ${IDLE_SHUTDOWN_MIN}분간 유휴 — VM 정지"
fi
shutdown -h now
