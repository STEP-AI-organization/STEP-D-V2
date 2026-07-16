# 비동기 작업 큐 + 워커 VM

채널이 연결되면 자동으로 분석이 돌게 하는 구조. 2026-07-16.

```
브라우저 ──▶ Vercel(stepd.stepai.kr) ──▶ Cloud Run (API)
                                            │  enqueue()  ← INSERT 한 번, 요청 안에서 끝
                                            ▼
                                    job_queue (Cloud SQL)
                                            │  FOR UPDATE SKIP LOCKED
                                            ▼
                              워커 VM (stepd-worker, e2-small)
                    ┌───────────────────────┴────────────────────────┐
                    ▼                                                ▼
     YouTube Data / Analytics API                      python -m core.analyze (파이썬 core/)
     channel.analyze ──팬아웃──▶ video.analyze          content.analyze — STT→정제→장면→비전→쇼츠
     video.hotwatch(자기 재큐) · video.comments          (Vertex Gemini, GPU-free)
                    │                                                │
                    ▼                                                ▼
  channel_videos · video_stats · channel_analytics        content_analysis
  video_analytics · video_retention · video_comments      + 회차 추천 보드(recommendation)
```

## 왜 Cloud Run이 아니라 VM인가

Cloud Run은 **응답이 끝나는 순간 CPU를 throttle**하고 요청을 **600초로 제한**한다.

- OAuth 콜백에서 `void runPipeline()` 으로 던지면 → 리다이렉트 직후 CPU가 끊겨 **죽을 수 있다.**
- 대형 채널 첫 백필(365일 + 영상 수백 개)은 600초를 넘길 수 있다 → **잘린다.**
- STT·비전 평가(`content.analyze`)는 영상 하나에 수십 분이 걸릴 수 있다 — 이미 이 워커에서 돈다.

그래서 **Cloud Run은 큐에 넣기만 하고**(요청 안에서 끝나는 INSERT 하나라 절대 유실되지 않음),
**실제 실행은 상시 켜진 워커 VM**이 한다. 타임아웃도 throttle도 없다.

## 큐 설계

`job_queue` 테이블 (Cloud SQL). 별도 브로커(Pub/Sub·Redis) 없이 Postgres로 처리한다 —
이미 있는 DB고, 트랜잭션이 곧 신뢰성이다.

**이 테이블은 `schema.sql`에 없다.** 기동 시 `queue.ts`의 `initQueue()`가
`CREATE TABLE IF NOT EXISTS`로 런타임 생성한다 (`content_analysis`·`channel_analytics`도
마찬가지로 `db-pg.ts` 코드에서 생성 — schema.sql만 보고 테이블 목록을 판단하지 말 것).

| 동작 | 방식 |
|---|---|
| **claim** | `FOR UPDATE SKIP LOCKED` — 워커를 여러 대 띄워도 같은 잡을 절대 두 번 안 가져간다. 스케일아웃 = 프로세스 하나 더 띄우기. 순서는 `runAfter ASC, createdAt ASC` (우선순위 컬럼은 없다 — due가 빠른 것부터). |
| **중복 방지** | `dedupeKey` 부분 유니크 인덱스 (`status IN ('pending','running')`). 같은 채널/영상 잡이 쌓이지 않는다. 완료 후엔 다시 넣을 수 있다. |
| **실패** | 지수 백오프 재시도 (30초 → 최대 30분). `maxAttempts`(5) 소진 시 `failed`로 남긴다 — 삭제하지 않는다. 그게 무엇이 깨졌는지에 대한 기록이다. |
| **크래시 복구** | 워커가 죽어 `running`으로 잠긴 잡은 30분 뒤 `requeueStale()`이 회수한다 (기동 시 + 15분 tick마다). |
| **후속 잡** | 핸들러가 `FollowUp`을 반환하면 현재 잡이 `done`이 된 **뒤에** enqueue한다. 자기 재큐 잡(hotwatch)이 아직 `running`인 자기 자신과 dedupe 충돌하지 않게 하기 위한 장치다. |

## 잡 타입 5종

`queue.ts`의 `JobType` 정의와 `worker.ts`의 `handle()` switch가 처리한다.
새 잡 타입(렌더링 등)이 들어올 자리도 이 switch다.

| 타입 | 하는 일 | 들어오는 곳 |
|---|---|---|
| `channel.analyze` | `runChannelPipeline()` — 업로드 동기화 + 채널 애널리틱스(일별 수익 포함) 백필. 끝나면 due한 영상마다 아래 두 잡을 **팬아웃**(`enqueueDueVideoJobs`) | 15분 sweep(전 채널), OAuth 연결 콜백, `POST /api/youtube/pipeline/run/:id`(`force`) |
| `video.analyze` | 영상별 애널리틱스 + 리텐션 저장 (Analytics 4콜/영상) | channel.analyze 팬아웃 |
| `video.hotwatch` | 신규 업로드를 게시 후 48시간 동안 1시간 간격으로 조회수 스냅샷. 창이 안 닫혔으면 **자기 자신을 재큐**(FollowUp) | 동기화가 새 업로드를 발견할 때 (`channel-pipeline.ts`) |
| `video.comments` | fresh 영상의 상위 댓글 100개(1페이지) 수집 | channel.analyze 팬아웃 |
| `content.analyze` | 업로드된 회차 영상을 GCS에서 내려받아 파이썬 `core/` 파이프라인(`python -m core.analyze`, STT→정제→장면→비전→이름자막→쇼츠, **Vertex Gemini**)으로 분석 → `content_analysis` 저장 + AI 쇼츠를 회차 추천 보드에 기록. 상세는 [content-pipeline-prod.md](content-pipeline-prod.md) | `POST /api/media/upload` (업로드 시), `POST /api/admin/queue/purge`의 재큐 |

YouTube 분석 잡과 콘텐츠 파이프라인이 **같은 워커 프로세스, 같은 큐**에서 돈다.
전 단계가 GPU-free(STT까지 Gemini 오디오)라 e2-small로 충분하다.

## 파이프라인 주기 (쿼터 고려)

| | 주기 | 이유 |
|---|---|---|
| 영상 동기화 | 6시간 | Data API 쿼터 (기본 10,000 units/day) |
| 채널 Analytics | 24시간 | 일 단위 데이터라 더 자주 받아도 의미 없음 |
| 첫 실행 | 즉시 · 365일 백필 | 연결 직후 화면이 비어 있으면 안 되니까 |
| 이후 | 최근 10일 재수집 | YouTube가 최근 며칠 수치를 계속 정정한다 → `(channelId, day)` PK로 덮어쓰기 |
| 영상별 Analytics | fresh(<7일) 24시간 · 이후 7일 | `video.analyze`가 영상당 4콜이라 staleness 게이트가 쿼터를 지킨다 (`config.ts`) |
| 댓글 | fresh 영상만 · 24시간 | 오래된 영상 댓글은 신호가 없다 |
| hotwatch | 게시 후 48시간 · 1시간 간격 | 초기 확산 곡선은 시간 단위 밀도가 있어야 보인다 |

워커는 15분마다 전 채널의 `channel.analyze`를 큐에 넣는다 (dedupe가 중복을 막고,
실제 due 판정은 파이프라인의 staleness 창이 한다 — sweep은 `force` 없이 넣으므로
안 due한 채널은 쿼터를 안 쓴다). Cloud Scheduler는 필요 없다 — 워커가 스스로 tick한다.

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
```

**재배포는 VM에 들어가 `git pull` 하지 말고 스크립트로.**

```powershell
.\deploy\deploy-server.ps1      # Cloud Run + 워커 VM 함께 (권장 — 한쪽만 올리면 코드가 어긋난다)
.\deploy-worker.ps1             # 워커만 (리포 루트)
```

두 스크립트 모두 VM에 SSH해서 `git fetch` + `git reset --hard origin/main` 후
`systemctl restart stepd-worker` 한다 — 워커는 origin/main을 당겨가므로 **커밋·푸시가 선행**돼야
한다(`deploy-server.ps1`은 이를 자동으로 확인·푸시한다). 워커는 `/opt/stepd`의 TS 소스를
tsx로 직접 실행하므로 빌드 단계가 없다. 전체 배포 절차는 [deploy.md](deploy.md).

`pending`이 계속 쌓이기만 하면 워커가 죽은 것이다. `failed`가 늘면 `job_queue.error`를 볼 것.

## 주의

- **`stepd-worker-db-url`은 Cloud Run의 `stepd-db-url`과 다른 값이다.** Cloud Run은
  `/cloudsql/...` 유닉스 소켓, VM은 로컬 프록시(`127.0.0.1:5432`)로 붙는다. 같은 값을 쓰면 워커가 DB에 못 붙는다.
- 워커는 `SIGTERM`을 받으면 **현재 잡을 마치고** 종료한다. `systemctl restart`가 작업을 중간에 끊지 않는다.
- refresh token이 무효(`invalid_grant`)면 워커가 채널을 `revoked`로 파킹하고 재시도를 멈춘다 —
  해당 채널 잡이 안 돈다면 채널 상태부터 볼 것.
