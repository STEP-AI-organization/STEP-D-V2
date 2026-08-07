# GCE Spot VM 워커 부활 — On-demand (큐 트리거로 부팅·shutdown)

2026-07-31 · 사용자 지시 "이제 잡을 클라우드에서도 처리하게끔" · "상시로 하지말고 큐 들어올때 키고 끄고".

로컬 pm2 워커만으로 부족·장기 운영 관점에서 클라우드 워커 필요. 상시 실행 대신
**Cloud Scheduler cron 이 큐 상태 감시 · pending 잡 있을 때만 VM start · idle X분 후
auto-shutdown**. GEBD 계획 ([[production-gpu-10usd-plan]]) 과 동일 패턴 · content lane
도 이 방식 적용.

## 현 상태 (조사 결과)

| 항목 | 상태 |
|---|---|
| `stepd-worker` VM | ❌ 삭제됨 |
| `stepd-worker` SA | ❌ 없음 |
| `deploy/worker-vm.sh` | ✅ 존재 · REGION default us-central1 (asia-northeast3 override 필요) |
| `deploy/worker-env.sh` | ✅ 존재 · Secret Manager 로 secrets 로드 |
| `deploy/deploy-server.ps1` | 로컬 pm2 만 · VM 관련 로직 없음 |
| Cloud SQL | `step-d:asia-northeast3:stepd-db` |

## 비용 예상 (On-demand)

30분 회차 · 하루 3-5개 실행 가정:

| 항목 | 계산 | 월 |
|---|---|---|
| n1-standard-4 Spot | 하루 60분 실행 · 시간당 $0.048 | ~$1.5 |
| pd-standard 30GB | 상시 (VM STOPPED 여도 디스크 요금) | ~$1.2 |
| 네트워크·CloudSQL Proxy | 소량 | ~$0.3 |
| **합계** | | **~$3/월** |

상시 실행 시 ~$25/월 대비 88% 절감. GEBD VM (~$6-10) 과 합쳐도 총 $10-13/월 예산 이내.

## 아키텍처

```
    Cloud Run (API)
         ↓ enqueue content.analyze
    Cloud SQL job_queue
         ↓
    Cloud Scheduler (매 3분)
         ↓
    POST /api/admin/worker-vm/wake
         ↓ pending>0 확인
    gcloud compute instances start stepd-worker
         ↓ startup-script → worker-vm.sh 자동 재실행
    stepd-worker-content lane 픽업 · 처리
         ↓ idle 10분 지속
    /usr/local/bin/worker-idle-shutdown.sh → shutdown -h now
```

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

Cloud Run SA (`stepd-server`) 에도 · `compute.instanceAdmin.v1` 추가 (wake 라우트가 VM start 호출).

### Step 2: `deploy/worker-vm.sh` on-demand 확장

기존 worker-vm.sh (content + youtube 2 lane) 유지 · auto-shutdown daemon 만 추가:

```bash
# 기존 systemctl enable stepd-worker-* 후 추가
sudo tee /usr/local/bin/worker-idle-shutdown.sh >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
IDLE=${IDLE_SHUTDOWN_SEC:-600}
COUNT_FILE=/var/tmp/worker-idle-count
touch "$COUNT_FILE"
while true; do
  # pending content.* / youtube.* 잡 조회 (gebd 는 별 VM 이라 제외)
  PENDING=$(psql -h 127.0.0.1 -U stepd -d stepd -tAc \
    "SELECT COUNT(*) FROM job_queue
     WHERE type IN ('content.analyze','youtube.download','video.analyze','channel.analyze',
                    'video.comments','video.hotwatch','distribution.publish',
                    'match.align','match.segment','match.learn')
     AND status IN ('pending','running')" 2>/dev/null || echo -1)
  if [ "$PENDING" = "0" ]; then
    NOW=$(date +%s)
    IDLE_SINCE=$(cat "$COUNT_FILE" 2>/dev/null || echo "$NOW")
    if [ -z "$IDLE_SINCE" ] || [ "$IDLE_SINCE" = "0" ]; then
      echo "$NOW" > "$COUNT_FILE"
    else
      DIFF=$((NOW - IDLE_SINCE))
      if [ "$DIFF" -ge "$IDLE" ]; then
        logger -t worker-idle "shutdown after ${DIFF}s idle (threshold ${IDLE}s)"
        /sbin/shutdown -h now
        exit 0
      fi
    fi
  else
    echo "0" > "$COUNT_FILE"
  fi
  sleep 60
done
EOF
sudo chmod +x /usr/local/bin/worker-idle-shutdown.sh

sudo tee /etc/systemd/system/worker-idle-shutdown.service >/dev/null <<EOF
[Unit]
Description=stepd-worker VM auto-shutdown daemon (idle >${IDLE_SHUTDOWN_SEC}s)
After=cloud-sql-proxy.service

[Service]
Environment=IDLE_SHUTDOWN_SEC=${IDLE_SHUTDOWN_SEC:-600}
ExecStart=/usr/local/bin/worker-idle-shutdown.sh
Restart=always
RestartSec=30
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now worker-idle-shutdown.service
```

또한 REGION/SQL_INSTANCE default 를 asia-northeast3 으로 (line 14-15):

```bash
REGION="${REGION:-asia-northeast3}"
SQL_INSTANCE="${SQL_INSTANCE:-step-d:asia-northeast3:stepd-db}"
```

### Step 3: VM 생성 (Spot · asia-northeast3)

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
  --metadata-from-file=startup-script=deploy/worker-startup.sh \
  --tags=stepd-worker
```

`deploy/worker-startup.sh` (신규 · GEBD startup-script 와 유사):
- `git reset --hard origin/main`
- `bash deploy/worker-vm.sh` (idempotent · systemd 유닛 재적용)

### Step 4: 서버 wake 라우트 (`apps/server/src/index.ts`)

```typescript
// POST /api/admin/worker-vm/wake — Cloud Scheduler 가 매 3분 호출
app.post("/api/admin/worker-vm/wake", async (c) => {
  // 관리자 토큰 검증 (Cloud Scheduler OIDC or 헤더)
  const stats = await queueStats();
  const pending = (stats.content_pending ?? 0) + (stats.youtube_pending ?? 0);
  if (pending === 0) return c.json({ waked: false, reason: "no pending" });

  // gcloud compute instances start stepd-worker
  // (Cloud Run SA 에 compute.instanceAdmin.v1 필요)
  const { execSync } = await import("node:child_process");
  try {
    execSync(`gcloud compute instances start stepd-worker --zone=asia-northeast3-c`, { stdio: "inherit" });
    return c.json({ waked: true, pending });
  } catch (e) {
    // 이미 RUNNING 이면 무해 (return code 0)
    return c.json({ waked: false, reason: String(e).slice(0, 200) });
  }
});
```

Cloud Scheduler cron:
```bash
gcloud scheduler jobs create http worker-vm-wake \
  --location=asia-northeast3 \
  --schedule="*/3 * * * *" \
  --uri="https://stepd-server-<hash>.a.run.app/api/admin/worker-vm/wake" \
  --http-method=POST \
  --oidc-service-account-email=stepd-scheduler@step-d.iam.gserviceaccount.com
```

### Step 5: 검증

1. **VM 부팅 로그**: `gcloud compute instances get-serial-port-output stepd-worker --zone=asia-northeast3-c`
2. **워커 서비스**: `sudo systemctl status 'stepd-worker-*'` · content · youtube 모두 running
3. **idle daemon**: `sudo journalctl -u worker-idle-shutdown -f` · pending 조회 로그
4. **자동 shutdown**: pending == 0 이 10분 지속 후 · VM status TERMINATED 로
5. **wake 라우트**: pending > 0 만들고 · Cloud Scheduler 강제 실행 → VM RUNNING 전이
6. **큐 픽업**: test 잡 삽입 · journalctl 로 lane 이 claim 확인

### Step 6: 로컬 pm2 → dev-only 전환 (선택)

Cloud VM 이 primary 확정 후:
- 로컬 pm2 는 개발자 디버그용 (`WORKER_JOBS=dev` 신규 lane · 실제 잡 안 담)
- production 트래픽은 Cloud VM 만 처리
- deploy-server.ps1 · `-Only vm` 옵션 확장 (`gcloud compute ssh + git pull + systemctl restart`)

## Verification (배포 후 1주)

1. GCP Billing "Compute Engine" SKU · 예상: 주당 $0.5-1
2. VM RUNNING 시간 · Cloud Monitoring · 하루 40-60분 이내
3. content.analyze 잡 · 회당 처리 시간 · 큐 인·완료 timestamp 로 계산
4. Cloud Scheduler wake 호출 · pending>0 일 때만 VM start (idempotent · 이미 RUNNING 이면 no-op)

## Out of Scope (다음 세션들)

- GEBD 전용 T4 GPU VM · [[production-gpu-10usd-plan]] Step 5 참조 (별도 인스턴스 · 같은 on-demand 패턴)
- 다중 방송사 확장 시 · Cloud Run 실 워커 병렬 (Cloud Run Job 방식)
- 다중 방송사 3~5곳 이상 시 · 상시 실행이 오히려 저렴할 수 있음 (트래픽 임계값 재검토)
- Cloud Scheduler 실패 대비 backup (Cloud Functions on-timer 등)

## 관련 문서·메모리

- [[stt-diarize-chyron-stack]] · [[production-gpu-10usd-plan]]
- [[deploy-noninteractive-gcloud]] · [[deploy-ps1-bom-required]]
- `deploy/worker-vm.sh` · `deploy/worker-env.sh` · `deploy/deploy-server.ps1`
- `apps/server/src/worker.ts` · `apps/server/src/queue.ts`
