# 비동기 작업 큐 + 워커 VM

채널이 연결되면 자동으로 분석이 돌게 하는 구조. 2026-07-14.

```
브라우저 ──▶ Vercel(stepd.stepai.kr) ──▶ Cloud Run (API)
                                            │  enqueue()  ← INSERT 한 번, 요청 안에서 끝
                                            ▼
                                    job_queue (Cloud SQL)
                                            │  FOR UPDATE SKIP LOCKED
                                            ▼
                                    워커 VM (e2-small)  ──▶ YouTube Data / Analytics API
                                            │
                                            ▼
                             channel_videos · video_stats · channel_analytics
```

## 왜 Cloud Run이 아니라 VM인가

Cloud Run은 **응답이 끝나는 순간 CPU를 throttle**하고 요청을 **600초로 제한**한다.

- OAuth 콜백에서 `void runPipeline()` 으로 던지면 → 리다이렉트 직후 CPU가 끊겨 **죽을 수 있다.**
- 대형 채널 첫 백필(365일 + 영상 수백 개)은 600초를 넘길 수 있다 → **잘린다.**
- 앞으로 들어올 STT·비전 평가·렌더링은 훨씬 오래 걸린다.

그래서 **Cloud Run은 큐에 넣기만 하고**(요청 안에서 끝나는 INSERT 하나라 절대 유실되지 않음),
**실제 실행은 상시 켜진 워커 VM**이 한다. 타임아웃도 throttle도 없다.

## 큐 설계

`job_queue` 테이블 (Cloud SQL). 별도 브로커(Pub/Sub·Redis) 없이 Postgres로 처리한다 —
이미 있는 DB고, 트랜잭션이 곧 신뢰성이다.

| 동작 | 방식 |
|---|---|
| **claim** | `FOR UPDATE SKIP LOCKED` — 워커를 여러 대 띄워도 같은 잡을 절대 두 번 안 가져간다. 스케일아웃 = 프로세스 하나 더 띄우기. |
| **중복 방지** | `dedupeKey` 부분 유니크 인덱스 (`status IN ('pending','running')`). 같은 채널 잡이 쌓이지 않는다. 완료 후엔 다시 넣을 수 있다. |
| **실패** | 지수 백오프 재시도 (30초 → 최대 30분). `maxAttempts`(5) 소진 시 `failed`로 남긴다 — 삭제하지 않는다. 그게 무엇이 깨졌는지에 대한 기록이다. |
| **크래시 복구** | 워커가 죽어 `running`으로 잠긴 잡은 30분 뒤 `requeueStale()`이 회수한다. |

## 파이프라인 주기 (쿼터 고려)

| | 주기 | 이유 |
|---|---|---|
| 영상 동기화 | 6시간 | Data API 쿼터 (기본 10,000 units/day) |
| Analytics | 24시간 | 일 단위 데이터라 더 자주 받아도 의미 없음 |
| 첫 실행 | 즉시 · 365일 백필 | 연결 직후 화면이 비어 있으면 안 되니까 |
| 이후 | 최근 10일 재수집 | YouTube가 최근 며칠 수치를 계속 정정한다 → `(channelId, day)` PK로 덮어쓰기 |

워커는 15분마다 전 채널을 훑어 **due한 것만** 큐에 넣는다 (dedupe가 중복을 막는다).
Cloud Scheduler는 필요 없다 — 워커가 스스로 tick한다.

## VM 만들기

```bash
# 1) VM (e2-small: 2 vCPU / 2GB — 워커엔 충분)
gcloud compute instances create stepd-worker \
  --project step-d --zone us-central1-a \
  --machine-type e2-small \
  --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud \
  --boot-disk-size 20GB \
  --service-account stepd-deployer@step-d.iam.gserviceaccount.com \
  --scopes cloud-platform \
  --no-address     # 공개 IP 불필요. 아웃바운드는 Cloud NAT로.

# 공개 IP를 빼면 Cloud NAT가 있어야 외부(YouTube API)로 나갈 수 있다.
# NAT가 없다면 --no-address 를 빼고 만들 것.

# 2) 워커용 DB URL 시크릿 (Cloud Run은 유닉스 소켓, VM은 로컬 프록시라 값이 다르다)
printf 'postgresql://USER:PASS@127.0.0.1:5432/DBNAME' | \
  gcloud secrets create stepd-worker-db-url --data-file=- --project step-d

# 3) 프로비저닝
gcloud compute ssh stepd-worker --zone us-central1-a
sudo bash /opt/stepd/deploy/worker-vm.sh   # (스크립트를 먼저 scp 하거나 repo clone 후 실행)
```

VM 서비스계정에 필요한 권한:

```bash
gcloud projects add-iam-policy-binding step-d \
  --member serviceAccount:stepd-deployer@step-d.iam.gserviceaccount.com \
  --role roles/cloudsql.client
gcloud projects add-iam-policy-binding step-d \
  --member serviceAccount:stepd-deployer@step-d.iam.gserviceaccount.com \
  --role roles/secretmanager.secretAccessor
```

## 운영

```bash
# 워커 로그
sudo journalctl -u stepd-worker -f

# 큐 깊이 — 워커가 살아있는지 가장 빨리 확인하는 법
curl -s https://stepd.stepai.kr/api/queue/stats
# {"pending":0,"running":1,"done":42,"failed":0}

# 특정 채널 강제 재분석 (큐에 넣기만 하고 즉시 리턴)
curl -X POST https://stepd.stepai.kr/api/youtube/pipeline/run/UCxxxx

# 저장된 일별 지표
curl -s "https://stepd.stepai.kr/api/youtube/analytics/UCxxxx/daily?days=90"

# 코드 갱신 후 재배포
cd /opt/stepd && git pull && sudo systemctl restart stepd-worker
```

`pending`이 계속 쌓이기만 하면 워커가 죽은 것이다. `failed`가 늘면 `job_queue.error`를 볼 것.

## 주의

- **`stepd-worker-db-url`은 Cloud Run의 `stepd-db-url`과 다른 값이다.** Cloud Run은
  `/cloudsql/...` 유닉스 소켓, VM은 로컬 프록시(`127.0.0.1:5432`)로 붙는다. 같은 값을 쓰면 워커가 DB에 못 붙는다.
- 워커는 `SIGTERM`을 받으면 **현재 잡을 마치고** 종료한다. `systemctl restart`가 작업을 중간에 끊지 않는다.
- 잡 타입은 지금 `channel.analyze` 하나뿐이다. STT·비전·렌더링이 들어올 자리는
  `worker.ts`의 `handle()` switch다.
