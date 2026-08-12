# 비동기 작업 큐 + 워커 VM

채널이 연결되면 자동으로 분석이 돌게 하는 구조. 2026-07-16 (워커 2-레인 분리 반영).

```
브라우저 ──▶ Vercel(stepd.stepai.kr) ──▶ Cloud Run (API)
                                            │  enqueue()  ← INSERT 한 번, 요청 안에서 끝
                                            ▼
                                    job_queue (Cloud SQL)   ← 한 테이블, 두 레인이 나눠 먹음
                                            │  FOR UPDATE SKIP LOCKED + 타입 필터(WORKER_JOBS)
                              워커 VM (stepd-worker, e2-small) — systemd 서비스 2개
          ┌─────────────────────────────────┴──────────────────────────────────┐
  stepd-worker-youtube  (WORKER_JOBS=youtube)      stepd-worker-content  (WORKER_JOBS=content)
          │  YouTube Data / Analytics API                  │  python -m core.analyze (파이썬 core/)
          │  channel.analyze ─팬아웃─▶ video.analyze         │  content.analyze — STT→정제→장면→비전→쇼츠
          │  video.hotwatch(자기 재큐) · video.comments      │  (Vertex Gemini, GPU-free, 영상당 수 분)
          ▼                                                 ▼
  channel_videos · video_stats · channel_analytics   content_analysis
  video_analytics · video_retention · video_comments + 회차 추천 보드(recommendation)
```

**핵심: content와 youtube 잡은 별도 워커 프로세스로 돈다** (같은 VM, 같은 큐 테이블, 하지만
서로 다른 잡 타입만 claim). 무거운 `content.analyze`(영상당 수 분)와 가벼운 `video.*` 홍수(채널당
수백 개)가 한 워커에서 순차 처리되면 서로 굶기 때문 — 아래 [워커 레인 분리](#워커-레인-분리-content--youtube) 참고.

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
| **claim** | `FOR UPDATE SKIP LOCKED` — 워커를 여러 대 띄워도 같은 잡을 절대 두 번 안 가져간다. `claimJob(types?)`에 **타입 필터**가 있어 레인별 워커가 자기 타입만 집는다(`WORKER_JOBS`, 아래 참고). 순서는 `runAfter ASC, createdAt ASC` (우선순위 컬럼은 없다 — due가 빠른 것부터). |
| **중복 방지** | `dedupeKey` 부분 유니크 인덱스 (`status IN ('pending','running')`). 같은 채널/영상 잡이 쌓이지 않는다. 완료 후엔 다시 넣을 수 있다. |
| **실패** | 지수 백오프 재시도 (30초 → 최대 30분). `maxAttempts`(5) 소진 시 `failed`로 남긴다 — 삭제하지 않는다. 그게 무엇이 깨졌는지에 대한 기록이다. |
| **크래시 복구** | 워커가 죽어 `running`으로 잠긴 잡은 30분 뒤 `requeueStale()`이 회수한다 (기동 시 + 15분 tick마다). |
| **후속 잡** | 핸들러가 `FollowUp`을 반환하면 현재 잡이 `done`이 된 **뒤에** enqueue한다. 자기 재큐 잡(hotwatch)이 아직 `running`인 자기 자신과 dedupe 충돌하지 않게 하기 위한 장치다. |

## 잡 타입 17종

`queue.ts`의 `JobType` 정의와 `worker.ts`의 `handle()` switch가 처리한다.
새 잡 타입(렌더링 등)이 들어올 자리도 이 switch다.

| 타입 | 하는 일 | 들어오는 곳 |
|---|---|---|
| `channel.analyze` | `runChannelPipeline()` — 업로드 동기화 + 채널 애널리틱스(일별 수익 포함) 백필. 끝나면 due한 영상마다 아래 두 잡을 **팬아웃**(`enqueueDueVideoJobs`) | 15분 sweep(전 채널), OAuth 연결 콜백, `POST /api/youtube/pipeline/run/:id`(`force`) |
| `video.analyze` | 영상별 애널리틱스 + 리텐션 저장 (Analytics 4콜/영상) | channel.analyze 팬아웃 |
| `video.hotwatch` | 신규 업로드를 게시 후 48시간 동안 1시간 간격으로 조회수 스냅샷. 창이 안 닫혔으면 **자기 자신을 재큐**(FollowUp) | 동기화가 새 업로드를 발견할 때 (`channel-pipeline.ts`) |
| `video.comments` | fresh 영상의 상위 댓글 100개(1페이지) 수집 | channel.analyze 팬아웃 |
| `content.analyze` | 업로드된 회차 영상을 GCS에서 내려받아 파이썬 `core/` 파이프라인(`python -m core.analyze`, STT→정제→장면→비전→이름자막→쇼츠, **Vertex Gemini**)으로 분석 → `content_analysis` 저장 + AI 쇼츠를 회차 추천 보드에 기록. 상세는 [pipeline-current.md](pipeline-current-state.md) | `POST /api/media/upload` (업로드 시), `POST /api/admin/queue/purge`의 재큐 |

## 워커 레인 분리 (content ↔ youtube)

한 워커는 잡을 **하나씩 순차 처리**한다. 그래서 한 워커에 두 종류를 섞으면 서로 굶는다:

- `content.analyze` 하나가 수 분~수십 분 돌면 → 그동안 모든 `video.*` 잡이 막힌다.
- 채널 하나 동기화가 `video.analyze`를 **수백 개**(전 영상) 쏟아내면 → `content.analyze`가 그 뒤에서 굶는다.

그래서 잡 타입을 **두 레인**으로 나누고, VM에 워커 프로세스를 **2개** 띄운다:

| systemd 서비스 | `WORKER_JOBS` | claim하는 타입 | 채널 sweep |
|---|---|---|---|
| `stepd-worker-youtube` | `youtube` | channel.analyze · video.analyze · video.hotwatch · video.comments | O (15분) |
| `stepd-worker-content` | `content` | content.analyze | X (youtube 일이라 안 함) |

- 구현: `queue.ts`의 `claimJob(types?)` 타입 필터 + `worker.ts`의 `WORKER_JOBS` env 분기.
  `SKIP LOCKED`라 두 워커가 같은 테이블을 안전하게 나눠 먹는다 — 사실상 별도 큐, 경합 0.
- **`WORKER_JOBS` 미설정(`all`)이면 한 워커가 전부 처리**(구버전 호환) — 프로비저닝 안 된 VM은 그대로 돈다.
- 둘 다 GPU-free(STT까지 Gemini 오디오)라 지금은 한 e2-small에 두 프로세스로 충분. content가 커지면
  content 레인만 별도/GPU VM으로 떼면 된다(그 VM만 `WORKER_JOBS=content`로 띄우면 끝).

**content 레인 필수 env** (`/etc/stepd/worker.env`, `worker-vm.sh`가 넣는다):
`GCS_BUCKET`(GCS 영상 읽기 — 없으면 로컬모드로 못 찾아 ENOENT) · `CORE_PYTHON`(=`/opt/stepd/core/.venv/bin/python`,
없으면 Windows 기본경로로 폴백해 실패) · `GOOGLE_CLOUD_PROJECT` · `VERTEX_LOCATION` · `STT_PROVIDER=gemini`.
파이썬 venv는 `worker-pipeline-setup.sh`로 별도 설치 ([pipeline-current.md](pipeline-current-state.md)).

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
# 워커 로그 (레인별)
sudo journalctl -u stepd-worker-youtube -f
sudo journalctl -u stepd-worker-content -f
systemctl status 'stepd-worker-*'      # 두 레인 상태 한눈에

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
bash deploy/cloud.sh server    # Cloud Run 서비스
bash deploy/cloud.sh worker    # 워커 Jobs (한쪽만 올리면 코드가 어긋난다 — 보통 둘 다)
```

두 스크립트 모두 VM에 SSH해서 `git fetch` + `git reset --hard origin/main` 후
**두 레인 서비스를 재시작**한다(`stepd-worker-youtube` · `stepd-worker-content`; 분리 전 VM이면 옛
`stepd-worker` 단일로 폴백). 워커는 origin/main을 당겨가므로 **커밋·푸시가 선행**돼야 한다
(`cloud.sh` 가 미커밋 변경을 감지해 물어본다). 워커는 `/opt/stepd`의 TS 소스를 tsx로 직접
실행하므로 빌드 단계가 없다. 전체 배포 절차는 [deploy.md](deploy.md).

**레인 서비스를 처음 만들 때(또는 worker.env 항목 추가)는 `worker-vm.sh`를 다시 돌린다.**
단, 이 스크립트는 실행 중 `git reset`으로 **자기 자신을 덮어쓰므로 첫 실행은 옛 버전이 돈다** — 두 번
돌리거나, 아래처럼 pull·env·재시작만 타겟으로 한다(권장):

```powershell
gcloud compute ssh stepd-worker --zone us-central1-a --project step-d --command "sudo git -C /opt/stepd fetch --depth 1 origin main && sudo git -C /opt/stepd reset --hard origin/main && sudo systemctl restart stepd-worker-content stepd-worker-youtube"
```

`pending`이 계속 쌓이기만 하면 워커가 죽은 것이다. `failed`가 늘면 `job_queue.error`를 볼 것.

## 주의

- **`stepd-worker-db-url`은 Cloud Run의 `stepd-db-url`과 다른 값이다.** Cloud Run은
  `/cloudsql/...` 유닉스 소켓, VM은 로컬 프록시(`127.0.0.1:5432`)로 붙는다. 같은 값을 쓰면 워커가 DB에 못 붙는다.
- 워커는 `SIGTERM`을 받으면 **현재 잡을 마치고** 종료한다. `systemctl restart`가 작업을 중간에 끊지 않는다.
- refresh token이 무효(`invalid_grant`)면 워커가 채널을 `revoked`로 파킹하고 재시도를 멈춘다 —
  해당 채널 잡이 안 돈다면 채널 상태부터 볼 것.
- **`content.analyze`가 계속 실패하면** `worker.env`의 `GCS_BUCKET`·`CORE_PYTHON`부터 본다: 없으면
  워커가 로컬모드로 GCS 영상을 못 찾아 `ENOENT`거나 Windows 기본 파이썬 경로로 폴백해 실패한다. 그다음은
  VM 서비스계정의 `roles/storage.objectViewer`(버킷 읽기)와 파이썬 venv(`worker-pipeline-setup.sh`) 여부.
  content 레인은 자기 워커(`stepd-worker-content`)에서 도니 그 저널을 볼 것.
