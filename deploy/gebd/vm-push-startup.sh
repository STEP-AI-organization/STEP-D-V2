#!/usr/bin/env bash
# GEBD VM 의 startup-script 메타데이터를 **리포의 vm-startup.sh 로 갱신**한다.
#
# ## 왜 이 스크립트가 필요한가 (2026-09-14)
#
# `vm-startup.sh` 는 GCE 메타데이터에 **복사본으로 박혀 있다.** 리포 파일을 고쳐도 VM 은
# 예전 스냅샷으로 계속 부팅한다 — 그리고 그 사실이 어디에도 안 드러난다.
#
# 실제로 그렇게 갈라져 있었다(실측): 리포는 `pnpm install --frozen-lockfile || …` 인데
# VM 메타데이터는 `--no-frozen-lockfile` 이었다. 누군가 리포만 고치고 끝냈다는 뜻이다.
#
# 그 사이 VM 은 리포 갱신(git checkout)에 실패한 채 **낡은 코드에 고정**돼 워커가 1초 만에
# 죽고 있었고, GEBD 가 **한 달 넘게** 한 건도 처리하지 못했다. 고칠 코드는 리포에 있었지만
# VM 에 닿는 길이 없었다 — 이 리포의 최빈 실패모드(`outputs-dont-reach-consumers`) 그대로다.
#
# **vm-startup.sh 를 고쳤으면 반드시 이걸 돌릴 것.**
#
#   bash deploy/gebd/vm-push-startup.sh
#
# 적용 시점: **다음 부팅부터**. 돌고 있는 VM 에는 즉시 반영되지 않는다.
set -euo pipefail

PROJECT="${PROJECT:-step-d}"
ZONE="${GEBD_VM_ZONE:-us-central1-b}"
INSTANCE="${GEBD_VM_NAME:-stepd-gebd-vm}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/vm-startup.sh"

[ -f "$SCRIPT" ] || { echo "vm-startup.sh 가 없다: $SCRIPT"; exit 1; }
bash -n "$SCRIPT" || { echo "⚠️ vm-startup.sh 구문 오류 — 올리지 않는다"; exit 1; }

echo "==> $INSTANCE ($ZONE) 의 startup-script 를 갱신한다"
gcloud compute instances add-metadata "$INSTANCE" \
  --zone "$ZONE" --project "$PROJECT" \
  --metadata-from-file=startup-script="$SCRIPT"

# 올린 것이 실제로 들어갔는지 되읽어 확인한다 — "올렸다" 와 "들어갔다" 는 다르다.
echo "==> 되읽어 확인"
gcloud compute instances describe "$INSTANCE" --zone "$ZONE" --project "$PROJECT" \
  --format='value(metadata.items.filter("key:startup-script").extract("value"))' \
  | head -c 400
echo
echo "==> 완료. 적용은 **다음 부팅부터**다."
echo "    지금 도는 VM 에 반영하려면 재부팅이 필요하다:"
echo "      gcloud compute instances reset $INSTANCE --zone $ZONE --project $PROJECT"
