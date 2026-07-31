#!/usr/bin/env bash
# Create the STEP-D GEBD VM (spot T4, on-demand).
#
# 이 스크립트는 한 번만 실행한다 (인스턴스 생성). 이후엔 큐 트리거 (POST /api/admin/gebd-vm/wake)
# 로 부팅·shutdown 만 반복. VM 자체는 그대로 유지 (부팅 디스크 pd-standard 20GB).
#
# 사전 필요:
# - Artifact Registry 에 GEBD Docker 이미지 push 완료 (deploy/gebd-docker/ 별도)
# - GEBD_IMAGE env 로 이미지 태그 지정 (기본값 asia-northeast3-docker.pkg.dev/...)
# - Cloud Run SA 에 compute.instanceAdmin.v1 부여 (VM wake 라우트가 gcloud start 호출)
#
# 실행:
#   bash deploy/gebd-vm-create.sh
#
# 확인:
#   gcloud compute instances describe stepd-gebd --zone=asia-northeast3-c

set -euo pipefail

PROJECT="${PROJECT:-step-d}"
ZONE="${ZONE:-asia-northeast3-c}"
INSTANCE="${INSTANCE:-stepd-gebd}"
SA_EMAIL="${SA_EMAIL:-stepd-gebd@step-d.iam.gserviceaccount.com}"
GEBD_IMAGE="${GEBD_IMAGE:-asia-northeast3-docker.pkg.dev/step-d/stepd/gebd-mmaction2:latest}"

# T4 spot instance · deep-learning-vm 이미지 (nvidia-driver·CUDA 12.1 프리설치)
# --instance-termination-action=STOP: spot 선점 시 종료 대신 STOP (디스크 유지 · 재부팅 가능)
gcloud compute instances create "$INSTANCE" \
  --project="$PROJECT" \
  --zone="$ZONE" \
  --machine-type=n1-standard-4 \
  --accelerator=type=nvidia-tesla-t4,count=1 \
  --provisioning-model=SPOT \
  --instance-termination-action=STOP \
  --boot-disk-size=20GB \
  --boot-disk-type=pd-standard \
  --image-family=common-cu121-debian-11 \
  --image-project=deeplearning-platform-release \
  --service-account="$SA_EMAIL" \
  --scopes=cloud-platform \
  --metadata="enable-oslogin=TRUE,gebd-image=${GEBD_IMAGE}" \
  --metadata-from-file=startup-script=deploy/gebd-startup.sh \
  --tags=stepd-gebd

echo
echo "==> stepd-gebd 인스턴스 생성 완료."
echo "    다음: startup-script 가 자동으로 gebd-vm.sh 실행 (5-10분)"
echo "    로그 확인:  gcloud compute instances get-serial-port-output ${INSTANCE} --zone=${ZONE}"
echo "    SSH:      gcloud compute ssh ${INSTANCE} --zone=${ZONE}"
