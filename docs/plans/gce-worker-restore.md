# GCE Spot VM 워커 부활 — 로컬 pm2 → 클라우드 잡 처리 확장

2026-07-31 · 사용자 지시 "이제 잡을 클라우드에서도 처리하게끔". 로컬 pm2 워커만으로 부족·
장기 운영 관점에서 클라우드 워커 필요. 기존 GCE `stepd-worker` VM 이 폐기된 상태에서
Spot n1-standard-4 로 재기동.

## 현 상태 (조사 결과)

| 항목 | 상태 |
|---|---|
| `stepd-worker` VM | ❌ 삭제됨 (`gcloud compute instances describe` NOT_FOUND) |
| `stepd-worker` SA | ❌ 없음 (`stepd-deployer` 만 존재) |
| `deploy/worker-vm.sh` | ✅ 존재 · REGION default us-central1 (asia-northeast3 override 필요) |
| `deploy/worker-env.sh` | ✅ 존재 · Secret Manager 로 secrets 로드 |
| `deploy/deploy-server.ps1` | 로컬 pm2 만 · VM SSH 재시작 로직 없음 (문서상 "TERMINATED" 이후 삭제됨) |
| Cloud SQL | `step-d:asia-northeast3:stepd-db` (worker-vm.sh default us-central1 과 불일치) |

## 사용자 페르소나·니즈

- **주 사용자**: 방송사·MCN 편집자 (실 트래픽)
- **니즈**:
  - 로컬 컴 · 개발자 부재 시 잡 처리 정지 위험 방지
  - 장기 · 여러 방송사 확장 시 로컬 자원 한계
  - 클라우드 워커가 primary · 로컬은 backup

## 목표 · 트레이드오프

- **A. Cloud 전용** (로컬 pm2 폐지) — 단일 소스 · 명확 · 로컬 backup 없음
- **B. Cloud + 로컬 병렬** — 부하 분산 · dual 관리 복잡 · queue 는 이미 `FOR UPDATE SKIP LOCKED` 로 안전
- **C. Cloud 만 · 로컬 pm2 dev 용** — 개발자 로컬은 개발 검증 전용 · production 은 Cloud

**권고 C** — production 은 Cloud 워커 primary · 로컬은 dev/디버그.

## 배포 로드맵

### Step 1: SA 신설 (`stepd-worker`)

```bash
gcloud iam service-accounts create stepd-worker \
  --display-name="STEP-D 워커 (content/youtube 잡 처리)" \
  --project=step-d

SA="stepd-worker@step-d.iam.gserviceaccount.com"
for role in \
  roles/cloudsql.client \
  roles/secretmanager.secretAccessor \
  roles/storage.objectAdmin \
  roles/artifactregistry.reader \
  roles/aiplatform.user; do
  gcloud projects add-iam-policy-binding step-d \
    --member="serviceAccount:$SA" --role="$role"
done
```

- `cloudsql.client`: CloudSQL Auth Proxy 로 Postgres 접근
- `secretmanager.secretAccessor`: `worker-env.sh` 가 secrets 로드
- `storage.objectAdmin`: GCS 미디어·산출물 read/write
- `artifactregistry.reader`: Docker 이미지 pull (썸네일 등 · GEBD 는 별개 SA)
- `aiplatform.user`: Vertex Gemini 호출

### Step 2: worker-vm.sh · worker-env.sh 지역 조정

- `deploy/worker-vm.sh` line 14-15:
  - `REGION="${REGION:-asia-northeast3}"`
  - `SQL_INSTANCE="${SQL_INSTANCE:-step-d:asia-northeast3:stepd-db}"`
- `deploy/worker-env.sh` — 이미 override 있으면 default 만 조정

### Step 3: VM 생성 · Spot · asia-northeast3

```bash
gcloud compute instances create stepd-worker \
  --project=step-d \
  --zone=asia-northeast3-c \
  --machine-type=n1-standard-4 \
  --provisioning-model=SPOT \
  --instance-termination-action=STOP \
  --boot-disk-size=30GB --boot-disk-type=pd-standard \
  --image-family=debian-12 --image-project=debian-cloud \
  --service-account=stepd-worker@step-d.iam.gserviceaccount.com \
  --scopes=cloud-platform \
  --metadata-from-file=startup-script=deploy/worker-vm.sh \
  --tags=stepd-worker
```

**주의**: Spot 선점 시 STOP · 재부팅 후 startup-script 재실행. queue.ts 는 crash-safe.

**월 비용 예상**:
- n1-standard-4 Spot asia-northeast3: ~$1.2/월 (30h 기준) · 상시 실행 시 ~$25/월
- 로컬 pm2 를 대체하려면 상시 · $25/월 · 예산 확인 필요
- 대안: on-demand VM · content 잡 큐 있을 때만 부팅 (GEBD 계획 [[production-gpu-10usd-plan]] 참조)

### Step 4: 검증

```bash
# 부팅 로그
gcloud compute instances get-serial-port-output stepd-worker --zone=asia-northeast3-c

# SSH 접근
gcloud compute ssh stepd-worker --zone=asia-northeast3-c

# 워커 서비스 확인
sudo systemctl status 'stepd-worker-*'
sudo journalctl -u stepd-worker-content -f
```

- content lane · youtube lane 각 running 확인
- CloudSQL Proxy 연결 확인 (`sudo journalctl -u cloud-sql-proxy -f`)
- 큐에 test 잡 삽입 · 픽업 확인

### Step 5: deploy-server.ps1 확장

- `-Only vm` 옵션 · VM SSH 로 `git pull && systemctl restart` 만
- 로컬 pm2 재시작과 동시 · 코드 배포 시 양쪽 모두 최신 반영

```powershell
# deploy-server.ps1 안 신설:
if ($Only -eq "vm" -or $Only -eq "all") {
    gcloud compute ssh stepd-worker --zone=asia-northeast3-c \
      --command="cd /opt/stepd && git pull origin main && sudo systemctl restart 'stepd-worker-*'"
}
```

### Step 6: 로컬 pm2 → dev-only 전환 (선택)

- 로컬 pm2 는 `WORKER_JOBS=dev` (신규 lane · empty · 실제 잡 안 담)
- 개발자가 수동 트리거 시에만 사용
- production 은 Cloud VM primary

## Verification

1. **VM 부팅 · 상태**: `gcloud compute instances describe stepd-worker --format='value(status)'` = RUNNING
2. **잡 픽업**: 큐에 dummy jobs 넣고 · journalctl 로 lane 이 claim 확인
3. **소스 최신**: `ssh -c "git -C /opt/stepd log --oneline -1"` = 로컬 main 과 동일
4. **비용**: 1주 후 GCP Billing · Compute Engine SKU · 예산 이내

## Out of Scope (다음 세션들)

- GEBD 전용 T4 GPU VM · [[production-gpu-10usd-plan]] Step 5 참조 (별도 인스턴스)
- Cloud Run Job 방식 (배치 잡 · 세션·리소스 별개)
- 다중 방송사 확장 시 워커 lane 병렬 (WORKER_JOBS=content-1 · content-2 등)
- GKE 마이그레이션 (overkill · 현 규모엔 불필요)

## 관련 문서·메모리

- [[stt-diarize-chyron-stack]] · [[production-gpu-10usd-plan]] · [[deploy-noninteractive-gcloud]]
- `deploy/worker-vm.sh` · `deploy/worker-env.sh` · `deploy/deploy-server.ps1`
- `apps/server/src/worker.ts` · `apps/server/src/queue.ts`
