#!/usr/bin/env bash
# STEP-D 클라우드 배포 — 한 번에.
#
#   bash deploy/cloud.sh <대상> [옵션]
#
# 대상:
#   server    stepd-server (Cloud Run 서비스) 빌드 + 배포
#   worker    워커 이미지 빌드 + Cloud Run Jobs 2개 갱신 (youtube · content)
#   gebd      GEBD 슬림 이미지 빌드 → Artifact Registry
#   migrate   DB 마이그레이션 적용 (Cloud Run Job 으로 Cloud SQL 접속)
#   status    지금 뭐가 떠 있는지 (배포 안 함)
#   all       server + worker + migrate  (gebd 는 13.8GB 라 명시할 때만)
#
# 왜 스크립트인가: 매번 손으로 하면 (1) 루트 cloudbuild.yaml 이 서버를 재배포한다는 걸
# 잊고 워커만 올리려다 서버까지 건드리거나 (2) `:latest` 태그를 밀어 다음 배포에 섞이거나
# (3) Job 갱신을 빼먹어 새 이미지가 반영 안 되는 실수가 난다. 여기서 한 번에 맞춘다.
set -uo pipefail

PROJECT="${PROJECT:-step-d}"
REGION="${REGION:-us-central1}"
REPO="us-central1-docker.pkg.dev/${PROJECT}/stepd-server/stepd-server"
SA="stepd-deployer@${PROJECT}.iam.gserviceaccount.com"
# gcloud 는 항상 deployer SA 로 — 사용자 계정(hkj)은 토큰이 만료되면 비대화형에서
# 재인증을 못 해 배포가 중간에 죽는다(2026-08-14 실측). 밖에서 준 값이 있으면 존중한다.
export CLOUDSDK_CORE_ACCOUNT="${CLOUDSDK_CORE_ACCOUNT:-$SA}"
SQL="${PROJECT}:${REGION}:stepd-db"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TARGET="${1:-status}"
STAMP="$(date +%Y%m%d-%H%M)"

log() { echo "[deploy] $*"; }
die() { echo "[deploy] ⚠️ $*" >&2; exit 1; }

# 배포될 코드가 커밋된 것과 같은지 — gcloud builds submit 은 **작업 트리**를 올린다.
check_clean() {
  local dirty
  dirty="$(git status --porcelain apps/server core 2>/dev/null | head -5)"
  if [ -n "$dirty" ]; then
    echo "[deploy] ⚠️ apps/server · core 에 미커밋 변경이 있다 — 그대로 배포된다:"
    echo "$dirty" | sed 's/^/    /'
    read -r -p "[deploy] 계속할까? (y/N) " a
    [ "$a" = "y" ] || die "중단"
  fi
}

do_server() {
  check_clean
  log "server 빌드 + 배포 (루트 cloudbuild.yaml · :latest 갱신 · Cloud Run 배포까지)"
  gcloud builds submit --config=cloudbuild.yaml --project="$PROJECT" . || die "server 배포 실패"
  log "server 완료 → $(gcloud run services describe stepd-server --project=$PROJECT --region=$REGION --format='value(status.url)' 2>/dev/null)"
}

do_worker() {
  check_clean
  local tag_y="worker-$STAMP" tag_c="content-$STAMP"
  # 경량 잡 lane 은 core/ 가 필요 없다 (서버 Dockerfile). content lane 은 core/+python 이 필요하다.
  log "worker 이미지 빌드: $tag_y (경량) · $tag_c (content)"
  gcloud builds submit --config=deploy/cloudbuild-worker.yaml \
    --substitutions=_TAG="$tag_y" --project="$PROJECT" . || die "worker 이미지 실패"
  gcloud builds submit --config=deploy/cloudbuild-worker.yaml \
    --substitutions=_TAG="$tag_c",_DOCKERFILE=apps/server/Dockerfile.worker \
    --project="$PROJECT" . || die "content 이미지 실패"

  log "Cloud Run Jobs 갱신"
  gcloud run jobs update stepd-worker-youtube --project="$PROJECT" --region="$REGION" \
    --image="${REPO}:${tag_y}" || die "youtube job 갱신 실패"
  gcloud run jobs update stepd-worker-content --project="$PROJECT" --region="$REGION" \
    --image="${REPO}:${tag_c}" || die "content job 갱신 실패"
  # env 자가 치유 — 깨진 CORE_PYTHON/CORE_DIR(윈도우 경로)이 잡에 눌러앉아 분석이
  # spawn ENOENT 로 전멸하는 사고 실측(2026-08-13·14). ⚠️ jobs 의 --remove-env-vars 는
  # 조용히 무시되는 것까지 실측했다 — 지우지 말고 **정답으로 덮어쓴다**.
  # MSYS2_ARG_CONV_EXCL 이 없으면 Git Bash 가 /opt/... 를 C:\Program Files\Git\... 로
  # 변환해 정확히 이 오염을 재생산한다(애초의 원인). ⚠️ 단 "*" 로 전부 막으면 gcloud
  # 래퍼가 자기 gcloud.py 경로 변환까지 못 해 **아예 안 뜬다**(2026-08-14 실측 — 이
  # 자가치유가 배포마다 조용히 실패하고 있었다). 값이 든 플래그만 좁혀서 막는다.
  MSYS2_ARG_CONV_EXCL="--update-env-vars" gcloud run jobs update stepd-worker-content \
    --project="$PROJECT" --region="$REGION" \
    --update-env-vars=CORE_PYTHON=/opt/corevenv/bin/python,CORE_DIR=/app \
    >/dev/null 2>&1 || log "⚠️ content job env 자가치유 실패 — 수동 확인 필요"
  log "worker 완료"
}

do_gebd() {
  log "GEBD 슬림 이미지 빌드 → AR (13.8GB · 클라우드에서 빌드하므로 업로드는 컨텍스트뿐)"
  gcloud builds submit --config=deploy/gebd/cloudbuild-gebd.yaml \
    --project="$PROJECT" deploy/gebd || die "gebd 이미지 실패"
  log "gebd 완료 → us-central1-docker.pkg.dev/${PROJECT}/stepd/gebd-mmaction2:latest"
}

do_migrate() {
  # 서버는 부팅 시 마이그레이션을 돌리지 않는다. Cloud SQL 은 공인 IP 를 열어두지 않는 편이
  # 안전하므로, Cloud Run Job 으로 붙어서 node-pg-migrate 를 돌린다.
  local img="${REPO}:latest"
  log "마이그레이션 Job 준비 (이미지 $img)"
  local yaml; yaml="$(mktemp)"
  cat > "$yaml" <<YAML
apiVersion: run.googleapis.com/v1
kind: Job
metadata:
  name: stepd-migrate
  namespace: ${PROJECT}
spec:
  template:
    metadata:
      annotations:
        run.googleapis.com/cloudsql-instances: ${SQL}
    spec:
      parallelism: 1
      taskCount: 1
      template:
        spec:
          serviceAccountName: ${SA}
          maxRetries: 0
          timeoutSeconds: 600
          containers:
            - image: ${img}
              command: ["npx"]
              args: ["node-pg-migrate", "--migrations-dir", "migrations",
                     "--migrations-table", "pgmigrations",
                     "--ignore-pattern", "(?!\\\\d{4}_.*\\\\.cjs\$).*", "up"]
              env:
                - name: DATABASE_URL
                  valueFrom:
                    secretKeyRef:
                      name: stepd-db-url
                      key: latest
              resources:
                limits: { cpu: "1", memory: 1Gi }
YAML
  gcloud run jobs replace "$yaml" --project="$PROJECT" --region="$REGION" || die "migrate job 생성 실패"
  rm -f "$yaml"
  gcloud run jobs execute stepd-migrate --project="$PROJECT" --region="$REGION" --wait \
    || die "마이그레이션 실패 — 로그 확인"
  local ex
  ex="$(gcloud run jobs executions list --job=stepd-migrate --project="$PROJECT" \
        --region="$REGION" --limit=1 --format='value(name)' 2>/dev/null)"
  log "마이그레이션 로그:"
  gcloud logging read \
    "resource.type=cloud_run_job AND labels.\"run.googleapis.com/execution_name\"=\"$ex\"" \
    --project="$PROJECT" --limit=30 --format='value(textPayload)' --freshness=10m 2>/dev/null \
    | tac | sed 's/^/    /'
}

do_status() {
  echo "── Cloud Run 서비스 ──"
  gcloud run services list --project="$PROJECT" --region="$REGION" \
    --format='table(metadata.name,status.url)' 2>/dev/null
  echo "── Cloud Run Jobs ──"
  gcloud run jobs list --project="$PROJECT" --region="$REGION" --format='value(metadata.name)' 2>/dev/null | sed 's/^/  /'
  echo "── Scheduler ──"
  gcloud scheduler jobs list --project="$PROJECT" --location="$REGION" \
    --format='table(ID,SCHEDULE,STATE)' 2>/dev/null
  echo "── GEBD VM ──"
  gcloud compute instances list --project="$PROJECT" --filter="name~gebd" \
    --format='table(name,zone,machineType.basename(),status)' 2>/dev/null
  echo "── 큐 ──"
  local url tok
  url="$(gcloud run services describe stepd-server --project=$PROJECT --region=$REGION --format='value(status.url)' 2>/dev/null)"
  tok="$(gcloud auth print-identity-token --audiences="$url" 2>/dev/null | tail -1)"
  [ -n "$tok" ] && curl -s -H "Authorization: Bearer $tok" "$url/api/queue/stats" 2>/dev/null && echo
}

case "$TARGET" in
  server)  do_server ;;
  worker)  do_worker ;;
  gebd)    do_gebd ;;
  migrate) do_migrate ;;
  status)  do_status ;;
  all)     do_server && do_worker && do_migrate ;;
  *)       sed -n '2,20p' "$0"; exit 1 ;;
esac
