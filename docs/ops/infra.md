# STEP-D 인프라 (실서비스)

> 전체 인프라의 단일 진실 소스. **바뀌면 여기 갱신한다.** 최종: **2026-08-21**.
>
> ⚠️ **2026-08-07 전면 개편.** 워커가 GCE VM → **Cloud Run Jobs** 로 옮겨졌고,
> GEBD(화면전환 모델)용 **GPU VM** 이 새로 생겼다. 이전 판이 기술하던 `stepd-worker` VM 은
> **존재하지 않는다**(조회 결과 GCE 인스턴스 0개였다).
> 레거시 주의: 구 시스템(shorts-vm/shorts-pg) 문서는 폐기·삭제됐고, 2026-08-12 삭제된 `apps/api`
> (구 Python FastAPI)는 레거시 잔존물 — 현 서버(`apps/server`)는 이를 전혀 사용하지 않는다.

## 한눈에

```
                 사용자 브라우저
                       │
        ┌──────────────┴───────────────┐
        ▼                              ▼
   Vercel (프론트)                 (외부 유튜버)
   stepd.stepai.kr                 /register
   step-d-v2-web                        │
        │  /api/* rewrite                │ OAuth
        ▼                                ▼
   ┌─────────────────────────────────────────┐
   │  Cloud Run: stepd-server (하나뿐인 백엔드) │  Node/Hono
   │  API 서빙 + 잡 enqueue                     │
   └───────────────┬─────────────────────────┘
                   │ job_queue (INSERT)
                   ▼
   ┌─────────────────────────────────────────┐
   │  Cloud SQL: stepd-db (PostgreSQL 15)      │
   └───────────────┬─────────────────────────┘
                   │ claim (FOR UPDATE SKIP LOCKED)
                   ▼
   ┌──────────────────────────────────────────────────────┐
   │  Cloud Run Jobs  (상시 프로세스 없음 · drain 모드)      │
   │   stepd-worker-youtube  1vCPU/2Gi  경량 잡 99.98%      │
   │   stepd-worker-content  4vCPU/8Gi  core/ 파이프라인     │
   │  ← Cloud Scheduler 가 15분마다 깨움. 큐 비면 즉시 종료   │
   └───────────────┬──────────────────────────────────────┘
                   │ gebd.detect (GPU 필요분만)
                   ▼
   ┌──────────────────────────────────────────────────────┐
   │  GCE: stepd-gebd-vm (us-central1-b · g2-standard-8+L4) │
   │  GEBD 화면전환 모델 · 잡 없으면 스스로 shutdown          │
   └──────────────────────────────────────────────────────┘
        │                         │
        ▼                         ▼
   GCS: stepd-media          Vertex AI (Gemini)
```

## GCP 프로젝트

- **프로젝트**: `step-d` (번호 `872105344568`)
- **기본 리전**: `us-central1` (컴퓨트·SQL·GCS). **AI만 서울**(아래).
- 인증: 로컬은 ADC(`gcloud auth application-default login`), 서버·워커는 서비스계정.

## 컴포넌트별 스펙

### 1. Cloud Run — `stepd-server` (하나뿐인 백엔드)
- 리전 `us-central1`, Node/Hono, `apps/server`.
- **비공개(IAM)** — invoker 바인딩은 `domain:stepai.kr` + `serviceAccount:stepd-deployer@step-d.iam.gserviceaccount.com` 둘뿐, `allUsers` 없음. 직접 URL 익명 접근은 403 (2026-07-16 실측).
  프론트는 Vercel rewrite로 **ID 토큰 프록시** 경유(`apps/web/next.config.ts` → `apps/web/src/app/api/proxy/[[...path]]/route.ts`) — 그래서 `stepd.stepai.kr/api/*`는 익명 200이다(공개면은 Vercel 웹뿐).
- ⚠️ 함정: 루트 `cloudbuild.yaml:37`과 `apps/server/cloudbuild.yaml:26` 둘 다 `--allow-unauthenticated` 플래그가 남아 있다. 현재는 배포 SA에 IAM 변경 권한이 없어 경고 후 무시되는 것으로 추정 — IAM에 반영되지 않아 실효 없음(실측). 단 권한이 생기는 순간 **매 배포가 서비스를 공개로 뒤집는다** → 플래그 제거 권장.
- 리소스: cpu 2 / mem 4Gi / timeout 600s / concurrency 10 / **min 0** / max 5 · cpu-boost (cloudbuild.yaml).
  2026-08-21: min-instances 1 → **0** 으로 내려 유휴 과금을 없앴다(월 ~₩36~55k 절약). 콜드스타트는
  첫 요청만 몇 초 느려질 뿐 — 프록시 재시도(2026-08-21)가 연결 오류는 흡수한다. 라이트 워크로드 판단.
- 서비스계정: `stepd-deployer@step-d.iam.gserviceaccount.com`.
- env/시크릿(cloudbuild.yaml `--set-secrets`): `DATABASE_URL`=stepd-db-url, `GOOGLE_CLIENT_ID/SECRET`,
  `JWT_SECRET`, `PUBLIC_URL`=stepd-public-url. 평문 env: `NODE_ENV`, `GCS_BUCKET`=stepd-media.
- Cloud SQL 연결: `--add-cloudsql-instances step-d:us-central1:stepd-db` (유닉스 소켓).
- 빌드 설정 정본은 **루트 `cloudbuild.yaml`**(docker 빌드, `apps/server/Dockerfile`) — `deploy/cloud.sh server` 가 이걸 submit 한다. `apps/server/cloudbuild.yaml`(buildpacks 빌드)도 공존하지만 배포 경로에서 안 쓴다.
- **자동배포 안 됨** — 두 cloudbuild.yaml 헤더의 "Triggered by GitHub push" 주석은 낡은 서술이고 GitHub 트리거는 없다. 실제 운영은 `deploy/cloud.sh server` 의 수동 `gcloud builds submit` 이 정본.

### 2. 워커 — **Cloud Run Jobs** (2026-08-07 이전 완료)

예전 `stepd-worker` GCE VM 은 **없다.** 상시 프로세스를 둘 이유가 폴링 하나뿐이었고
(잡의 99.98%가 YouTube API 대기), idle 과금만 났다. `worker.ts` 에 **drain 모드**를 넣어
큐가 비면 종료하도록 바꾸고 Cloud Run Jobs 로 옮겼다.

| Job | 스펙 | lane | 비고 |
|---|---|---|---|
| `stepd-worker-youtube` | 1 vCPU · 2Gi | `channel.analyze`·`video.*`·`distribution.publish` | 서버 이미지 그대로 (core/ 불필요) |
| `stepd-worker-content` | 4 vCPU · 8Gi | `content.analyze`·`youtube.download`·`match.*` | **`Dockerfile.worker`** — core/ + 파이썬 venv 포함 |

- **트리거**: Cloud Scheduler `*/15 * * * *` (Asia/Seoul) → Run Admin API `:run`.
  `stepd-worker-youtube-tick` · `stepd-worker-content-tick`.
- **drain 모드**: `WORKER_MODE=drain`. 큐가 비면 exit 0 → **idle 과금 0.**
  `DRAIN_MAX_MS`(기본 50분) 초과 시 새 잡을 안 집는다(진행 중인 건 끝까지) — Job 타임아웃에
  걸려 잡 도중에 죽는 걸 막는다.
- **STT**: content Job 은 GPU 가 없으므로 **`STT_PROVIDER=soniox`** 여야 한다
  ($0.10/시간 · 회차당 약 ₩135). `hybrid`/`whisper` 는 CUDA 가 필요하다.
- ⚠️ **`/tmp` 가 tmpfs(RAM)** 다. 원본 영상 1GB 가 통째로 메모리를 먹어 8Gi 로 잡았다.
  90~120분 회차(2~3GB)는 16Gi 검토 필요.
- 시크릿: `stepd-db-url`(소켓) · `stepd-google-client-id/secret` · `stepd-jwt-secret` ·
  `stepd-public-url` · **`stepd-soniox-api-key`**(2026-08-07 신설).

### 2-1. GEBD GPU VM — `stepd-gebd-vm`

화면전환 모델(TSN + SJNET)은 CUDA 가 필수라 이것만 GPU 로 남는다.
CPU 전용 실행은 9.45초 만에 실패한다(mmaction2 가 CUDA 요구).

- `g2-standard-8` + **NVIDIA L4** · zone **`us-central1-b`** · 부팅디스크 100GB pd-balanced.
  T4 를 먼저 시도했으나 us-central1 4개 존 전부 STOCKOUT 이었다.
- 이미지: `us-central1-docker.pkg.dev/step-d/stepd/gebd-mmaction2:latest` (**13.8GB** ·
  원본 53.9GB 를 `devel`→`runtime` 베이스로 슬리밍). 가중치 1.58GB 는 이미지에 안 굽고
  `gs://stepd-media/models/gebd/` 에서 받는다.
- **부팅 = 처리 = 자체 종료.** `deploy/gebd/vm-startup.sh` 가 잡을 소진하고 유휴 10분이면
  `shutdown -h now`. 실측 18분 가동 후 `guestTerminate` 확인.
- 🔒 **`--max-run-duration=3600s --instance-termination-action=STOP`** — 스크립트가 죽어도
  GCE 가 1시간이면 강제 정지시킨다. **상시 가동은 월 $533 이라 유휴 종료 실패의 손해가 245배다.**
- 병목은 GPU 가 아니라 **CPU 측 비디오 디코딩**이다(실측 GPU 9~23% · CPU 285%) —
  비싼 GPU 를 살 이유가 없다.
- 아직 `AUTO_GEBD=1` 은 안 켰다. 켜도 **VM 을 깨우는 배선이 없어** 잡만 쌓인다.

### 3. Cloud SQL — `stepd-db`
- PostgreSQL 15. 인스턴스 연결명 `step-d:us-central1:stepd-db`. Zonal · 디스크 10GB PD_SSD.
- **tier `db-custom-1-4096` (전용코어 1vCPU · 4GB · SLA 있음)** — 2026-08-21 에 `db-g1-small`
  에서 **올렸다**(여러 회사·리소스 유입 대비). 월 **$25.55 → $50.59** (+$25.04 ≈ **+₩34,500**).
  - **자동 백업 ON**(매일 18:00 · 7개 보관) + **PITR ON**(WAL 7일 · 특정 시점 복구). 2026-08-21
    이전엔 **백업이 꺼져 있었다** — 유료 고객 데이터 공백이라 승급과 함께 켰다. 백업/WAL 추가비는
    DB 가 작아(데이터 ~0.7GB) **월 ₩1,000 미만 추정**(청구서 확인).
  - 배경(2026-08-07~08-21 실험): `db-g1-small`(공유코어 1.7GB)로 내려 CPU 9%·메모리 여유 59%
    로 굴렀지만, 공유코어는 **SLA 가 없고**(Google dev/test 등급) 지속부하에서 버스트 크레딧이
    소진돼 스로틀된다. 멀티테넌트 진입에 부적합해 되돌렸다.
  - 다음 상향 트리거: 모니터링에서 **CPU 지속 50% 초과**면 `db-custom-2-8192` 로 —
    `gcloud sql instances patch stepd-db --project=step-d --tier=db-custom-2-8192`

- 접속: Cloud Run·Cloud Run Jobs = 유닉스 소켓(`--set-cloudsql-instances`),
  외부(개발 PC) = **Cloud SQL Auth Proxy**, 로컬 개발 = 도커 PG 별도(`stepd-pg`).
  ⚠️ 로컬 `.env` 의 `DATABASE_URL` 은 `localhost:5432`(도커 PG)라 **프로덕션이 아니다.**
- 주요 테이블: `entities`(program/episode/…), `media`, `youtube_channels`, `channel_videos`,
  `video_stats`, `channel_analytics`, `job_queue`, `content_analysis`(콘텐츠 파이프라인 결과).
- ⚠️ 함정1(키): Postgres가 따옴표 없는 식별자를 소문자로 접음 → `SELECT *`는 소문자 키. camelCase는
  명시적 별칭(`AS "camelCase"`) 필수. (전례: refreshToken/media 필드 유실 버그, 수정됨.)
- ⚠️ 함정2(날짜): node-postgres가 `BIGINT`(int8)를 **문자열**로 반환. 프론트에서 `new Date("1752…")`는
  epoch ms 문자열을 날짜로 파싱 못 해 **Invalid Date**. 반드시 `new Date(Number(x))`. 대상 필드:
  `connectedAt`·`createdAt`·`expiresAt`·`lastSyncedAt` 등 모든 BIGINT 타임스탬프.
  (전례: 배포채널 "Invalid Date 연결" 버그, 2026-07-15 수정.)
- ⚠️ 함정3(스키마 소재): `job_queue`·`content_analysis`·`channel_analytics`는 `apps/server/schema.sql`에
  **없다** — 서버/워커 기동 시 코드가 런타임 생성한다(`queue.ts:44` initQueue, `db-pg.ts:135`·`db-pg.ts:215`).
  schema.sql만 돌려서 새 DB를 부트스트랩하면 이 셋이 빠진다. 상세: [../reference/data-model.md](../reference/data-model.md).

### 4. GCS 버킷
- `stepd-media` — 업로드 영상·썸네일·클립 (`GCS_BUCKET`).
- `step-d-landing` — 랜딩 영상. `step-d_cloudbuild` — Cloud Build 산출.

### 5. AI — Vertex AI (Gemini)
- 모델 기본 `gemini-3.1-flash` (`GEMINI_MODEL`로 override).
- **리전 `asia-northeast3`(서울)** — 얼굴 프레임·오디오·자막이 개인정보라 국내 처리(데이터레지던시).
  ⚠️ 서울엔 Google **Speech-to-Text v2 Chirp가 없음** → STT는 Gemini 오디오 사용(아래).
- 인증: ADC(로컬) / VM SA(워커). API 키 없음.
- **Speech-to-Text API**는 활성화돼 있으나 **사용 안 함** — Chirp_2가 "정우성"→"정구속" 오인식 +
  서울 리전 없음 때문. 대신 Gemini 오디오 전사(품질·레지던시 우위).

### 6. Vercel (프론트)
- 프로젝트 `step-d-v2-web` (팀 `step-ai`). 도메인 `stepd.stepai.kr`.
- `apps/web` 배포. main 푸시 시 자동 빌드. `/api/*`는 rewrite로 Cloud Run 프록시.
- ⚠️ `apps/web`에서 `npm install` 금지(pnpm 워크스페이스). `NEXT_PUBLIC_API_URL` 비워둬야 프록시 탐.
- 상세: [vercel-ops.md](vercel-ops.md).

## 콘텐츠 파이프라인 (core/)

업로드 영상 → 쇼츠 추천. **전 단계 GPU-free**(관리형 Gemini).

```
STT(Gemini 오디오, 서울) → 자막정제 → 장면분할(scenedetect+ffmpeg) →
시각채점(Gemini Vision) → 이름자막 OCR → 쇼츠추천(Gemini)
```

- 진입점: `python -m core.analyze <video> --out <dir>` → analysis.json(transcript+scenes+shorts).
- 실측: 8분 영상 ≈ 512초(vision+names가 프레임당 Gemini 호출이라 지배적).
- 실서비스 흐름·배선: [pipeline-current.md](pipeline-current-state.md).
- 파이프라인 계획: [../plans/pipeline-plan.md](../archive/plans-2026-07/pipeline-plan.md), 인물엔진: [../plans/context-engine-plan.md](../plans/onhold/context-engine-plan.md).
- **빠른 모드** `--fast`(잡 `fast:true` 또는 워커 `CORE_ANALYZE_FAST=1`): 시각 분석 스킵, 자막만으로 추천 → 61분 영상 96초. 대량 배치용.

### 영상 수집 경로 — 실서비스 vs 연구 (봇차단 관점)

**핵심: 실서비스는 YouTube를 스크래핑하지 않는다 → 봇차단 위험 없음.**

| 경로 | 방식 | 봇차단 |
|---|---|---|
| **실서비스** | 운영자가 자기 롱폼 **업로드**(GCS resumable) → content.analyze | ❌ 없음 (스크래핑 아님) |
| **연동 채널 자동수집**(미래 옵션) | YouTube **Data API**(OAuth 인증) | ❌ 없음 (공식·인증) |
| **연구 데이터셋 수집**(현재) | `youtube.download`/`match.*`가 **yt-dlp**로 공개 채널 당김 | ⚠️ **있음** (일회성) |

- yt-dlp 스크래핑은 **연구용 데이터셋 구축**에만 쓴다 — 데이터센터 IP + 누적 요청이 YouTube 봇차단("Sign in to confirm you're not a bot")을 유발한다. 제품 루프가 여기 의존하지 않으므로 **프로덕션 리스크 아님**.
- 완화(연구용, 일회성이라 이 정도로 충분): ① 다운로드 **스로틀**(간격) — 제일 효과·무료, ② 제대로 된 로그인 **쿠키**(`stepd-ytdlp-cookies`; 계정 밴 위험 유의), ③ 필요 시 **레지던셜 프록시**(데이터센터 IP가 근본 원인).
- fast 다운로드는 **오디오만** 받아(youtube.download `fast:true`) 용량·시간을 크게 줄이지만, **봇차단 자체는 못 피한다**(별개 문제).

## 잡 큐 (job_queue)

Postgres 기반. `FOR UPDATE SKIP LOCKED` claim, dedupeKey, 지수백오프.

| 잡 타입 | 트랙 | 용도 |
|---|---|---|
| `channel.analyze` | YouTube | 채널 영상·성과 동기화 |
| `video.analyze` / `video.hotwatch` / `video.comments` | YouTube | 영상 애널리틱스·급상승·댓글 |
| `content.analyze` | 콘텐츠 | 업로드 영상 → STT→…→쇼츠 (워커가 python 실행) |

상세: [worker-queue.md](worker-queue.md).

## 시크릿 (Secret Manager)

`stepd-db-url`(Cloud Run 소켓) · `stepd-worker-db-url`(워커 TCP) · `stepd-google-client-id` ·
`stepd-google-client-secret` · `stepd-jwt-secret` · `stepd-public-url`.
로컬 시크릿(`.env`, `gcp-keys/`)은 gitignore.

## 배포

**`deploy/cloud.sh` 하나로 한다.** 손으로 gcloud 를 치지 말 것 — 아래 실수가 반복됐다.

```bash
bash deploy/cloud.sh status     # 현황만 (서비스·Jobs·Scheduler·GEBD VM·큐)
bash deploy/cloud.sh server     # Cloud Run 서비스
bash deploy/cloud.sh worker     # 워커 이미지 2종 + Jobs 갱신
bash deploy/cloud.sh gebd       # GEBD 이미지 → AR
bash deploy/cloud.sh migrate    # DB 마이그레이션
bash deploy/cloud.sh all        # server + worker + migrate
```

| 함정 | 스크립트의 처리 |
|---|---|
| 루트 `cloudbuild.yaml` 이 마지막에 **서버를 재배포**한다 | 워커는 `cloudbuild-worker.yaml`(빌드·푸시만) |
| 이미지를 밀어도 **Cloud Run Job 은 안 바뀐다** | `jobs update --image` 동반 |
| `:latest` 를 밀면 다음 서버 배포에 섞인다 | 워커는 시각 태그만 |
| `gcloud builds submit` 은 **작업 트리를 그대로** 올린다 | 미커밋 변경 경고 |
| **마이그레이션은 자동이 아니다** | Cloud Run Job 으로 Cloud SQL 접속 |
| `.gcloudignore` 가 있으면 `.gitignore` 는 **무시**된다 | `tmp/` 등을 명시 (안 하면 컨텍스트 1.9GB) |

웹(Vercel)은 별도: `deploy/deploy-web.ps1` — **커밋 author 가 `contact@stepai.kr`** 여야 한다.

Claude Code 스킬: `.claude/skills/deploy/SKILL.md`

## 로컬 개발

`.\dev.ps1` — 도커 PG(`stepd-pg`) + 서버(4100) + 웹(3000). 상세: [local-dev.md](local-dev.md).

---

## 월 비용 (2026-08-07 실측 단가 기준)

단가는 **GCP Billing API 직접 조회**(us-central1). 추정이 아니다 — 다만 실제 청구서 대조는 아직이다.

```
T4 GPU        $0.350000/시간      N1 vCPU   $0.031611/시간
L4 GPU        $0.560040/시간      N1 RAM    $0.004237/GiB·시간
G2 코어       $0.026238/시간      SQL vCPU  $0.041300/시간
Balanced PD   $0.100000/GiB·월    SQL RAM   $0.007000/GiB·시간
```

### 고정비 — 아무것도 안 돌려도 나감

| 항목 | 월 |
|---|---|
| Cloud SQL `db-custom-1-4096` (전용코어 1vCPU·4GB) | **₩69,800** ($50.59) |
| Cloud SQL 자동백업 + PITR (WAL·백업 스토리지) | ~₩1,000 (DB 작음 · 청구서 확인) |
| GEBD VM 부팅디스크 100GB pd-balanced (정지 중에도 과금) | ₩13,800 |
| AR 이미지 13.8GB | ₩1,900 |
| GCS (미디어 + 가중치 1.58GB) | ₩50 |
| Cloud Run `stepd-server` (min-instances=**0** · 콜드스타트 허용) | ₩0 (유휴 과금 없음) |
| Cloud Scheduler 2개 (3개까지 무료) | ₩0 |
| **소계** | **≈ ₩86,500** |

> 2026-08-21: min-instances **1 → 0** 으로 내려 유휴 과금(추정 월 ₩36~55k)을 없앴다. 첫 요청
> 콜드스타트(몇 초)만 감수 — 프록시 재시도(2026-08-21)가 연결 오류는 흡수한다. 다시 상시 웜이
> 필요하면 `cloudbuild.yaml` 의 `--min-instances` 를 1 로.

### 사용량비

| 항목 | 회차당 |
|---|---|
| GEBD VM ($0.868/시간 × ~18분) | ₩360 |
| content Job (4vCPU·8Gi × ~30분) | ₩125 |
| Soniox STT ($0.10/시간 · 화자분리 포함) | ₩135 |
| Gemini API (usage.json 실측) | ₩154 |
| **합계** | **≈ ₩774** |

폴링(회차 수 무관): Job 2개 × 15분 주기 ≈ **월 ₩3,400**.

### 월 총액

| 회차/월 | 합계 |
|---|---|
| **12건** | **≈ ₩99,200** |
| 30건 | ≈ ₩113,100 |
| 100건 | ≈ ₩167,200 |

> 2026-08-21 Cloud SQL 승급(db-custom-1-4096 + 백업/PITR)으로 고정비가 **≈₩51,000 → ≈₩86,500**
> (+₩35,500) 올랐고, 같은 날 Cloud Run min-instances 1→0 으로 내려 유휴 과금은 없앴다.
> 회차당 사용량비(~₩774)는 그대로 — DB 는 사용량비에 크게 안 잡힌다.

> **GPU 는 거의 안 켜서 싸다.** 상시 가동이면 GEBD VM 만 월 $533(₩735,000)이다 —
> 유휴 자동 종료가 245배를 가른다. 그래서 `--max-run-duration` 하드 안전장치를 같이 건다.

### 더 줄일 여지

| 방법 | 절감/월 | 대가 |
|---|---|---|
| content Job 폴링 제거 (서버가 enqueue 시 직접 트리거) | ₩2,500 | 서버 재배포 · 최대 15분 지연도 사라짐 |
| Spot VM (`PREEMPTIBLE_CPUS` 쿼터 추가 신청) | GPU분 60~91% | 선점 가능 (재시도 안전) |
| VM 을 매번 삭제/재생성 | ₩13,800 | 회차마다 13.8GB 재pull |

## 변경 이력

### 2026-08-21 — 멀티테넌트 대비 Cloud SQL 승급
- **Cloud SQL `db-g1-small` → `db-custom-1-4096`** (여러 회사·리소스 유입 대비). 공유코어(SLA 없음)
  → 전용코어(SLA 있음). 월 **$25.55 → $50.59** (+₩34,500).
- **자동 백업 ON**(꺼져 있던 걸 켬 · 7개 보관) + **PITR ON**(WAL 7일). 백업/WAL 추가비 월 ₩1,000 미만 추정.
- 고정비 ≈ **₩51,000 → ₩86,500**(확정분). 상향 트리거: CPU 지속 50% 초과 시 db-custom-2-8192.
- 서버 **min-instances 1 → 0** — 유휴 과금(추정 월 ₩36~55k) 제거. 콜드스타트는 프록시 재시도로 흡수.
- 문서 정정: PostgreSQL **15**(16 아님).
- 규모 전제: 2~3개사·가벼운 부하. 그 이상이면 워커 즉시트리거·병렬 + 테넌트 가드레일 검토(미착수).

### 2026-08-07 — 워커 클라우드 이전 + GEBD GPU
- 워커: GCE VM(`stepd-worker`) → **Cloud Run Jobs 2종** + Scheduler 15분. 상시 프로세스 제거
- GEBD: GPU 쿼터 승인(`GPUS_ALL_REGIONS=1`) → **`stepd-gebd-vm`**(L4) 신설.
  이미지 53.9GB → **13.8GB** 슬리밍, AR `stepd` 저장소 신설
- DB: 마이그레이션 `0009`·`0010` 적용(`search_segments`·`search_events` 가 없었다).
  job_queue 81,199행 + 파생 데이터 146,050행 정리 — **채널 연결만 보존**
- 배포: `deploy/cloud.sh` + `/deploy` 스킬로 통합
- 시크릿 `stepd-soniox-api-key` 신설 (클라우드 STT 는 Soniox)
- **Cloud SQL `db-custom-1-4096` → `db-g1-small`** (실측 CPU 9% · 메모리 여유 확인 후).
  월 ₩69,800 → ₩35,300. 인프라 총액 ₩99,800 → **₩63,700 (37% 절감)**


- **2026-07-16 (리포 이전 + 채널 트렌드 재설계)**: GitHub 리포를 `STEP-AI-official/STEP-D-V2`
  → **`STEP-AI-organization/STEP-D-V2`**로 이전(origin 변경 + Vercel 프로젝트 Git 재연결).
  ⚠️ **함정(중요): Vercel git 배포는 커밋 author 이메일이 Vercel 팀 멤버여야 함** — `ha983885@snu.ac.kr`
  (hakyungjin) author 커밋은 "Git author must have access to the project" 로 **전 배포가 UNKNOWN 차단**됐다.
  → 배포 커밋은 반드시 **`contact@stepai.kr`** author로(`git config user.email contact@stepai.kr`).
  채널 트렌드: 성장률/트렌드를 `channel_analytics`(실 일별)로 교체, 채널 수익 수집, 영상 검색·정렬·페이지네이션.
  core/ 폐기 파일 8개 제거(pipeline·segment·downloader·subtitles·bridge·test_pipeline + stale 문서 2).

- **2026-07-16 (편집기 + 채널 애널리틱스)**: 검수 편집기 직접조작 완성(실영상 트랜스포트·웨이브폼·
  타임코드 입력·오버레이 드래그/인라인편집/리사이즈/스냅·저장=EditorState 영속화, 전부 무렌더 §2.4).
  채널 트렌드: 영상 클릭 **500 수정**(snapshotAt BIGINT→Date, §3 함정2), 분석 강화(평균시청시간·시청률·
  유입경로·시청층·리텐션·댓글), **수익 지표**(`yt-analytics-monetary.readonly` 스코프 추가 + estimatedRevenue·
  cpm·adImpressions 수집, 비수익 채널은 403 무시). register 온보딩: 영상 0개 채널 90초 스핀 수정
  (`lastSyncedAt`/`lastAnalyzedAt` 노출). ⚠️ 수익 실제 표시엔 **수익화 채널 + monetary 스코프 재연결** 필요,
  앱 검증(데모영상) 완료 전엔 외부 사용자 동의 제한. ⚠️ 이 배포들은 gcloud 유저 인증 만료로
  **배포 SA 키(`stepd-service-account-key.json`)로 활성화**해 진행(`gcloud auth activate-service-account`).
- **2026-07-15 (브랜드 통일·더미 정리)**: 프론트 브랜드 표기를 전부 **"STEP D"**로 통일
  (사이드바 로고 STEPD/v2·메타 title·등록/약관/개인정보/법적고지·엑셀 헤더). `seed.ts` 비움 —
  프로덕션은 데모 콘텐츠 없이 빈 상태로 시작. 서버(Cloud Run) 재배포로 재시드 차단
  (리비전 stepd-server-00014). **프로덕션 DB 더미 정리**: `entities`(7)·`media`(1)·`kv`(connections)
  삭제. cloud-sql-proxy 경유 트랜잭션, `youtube_channels`·`channel_videos`·`video_*`·`channel_analytics`
  는 **보존**(채널 2·애널리틱스 132일 무결). 빈 상태 UI·유튜브 채널 유지 재캡처로 검증.
- **2026-07-15 (프론트 점검·핫픽스)**: 실서비스 프론트 UX 점검(헤드리스 전 페이지). 크래시 0.
  사용자 노출 포맷 버그 3종 수정·배포·검증: ①배포채널 "Invalid Date 연결"(BIGINT→문자열, §3 함정2)
  ②회차 상세 "null화"(episodeNumber null 미가드) ③추천 카드 "NaN:NaN"(formatTimecode NaN).
  Vercel 배포 Ready 확인 후 재캡처로 세 버그 소멸 검증.
- **2026-07-15 (배포 완료)**: 콘텐츠 파이프라인(core/) 실서비스 배선 + **프로덕션 배포**.
  content.analyze 잡, content_analysis 테이블, 워커 파이썬 환경. STT를 관리형 Gemini
  오디오로 전환(GPU-free, 서울). Vertex 서울 리전. `.gcloudignore` 추가(빌드 5.2GB→소스만).
  Cloud Run 배포 SUCCESS. 워커 VM에 파이썬 venv 설치·CORE_PYTHON 주입·Vertex 스모크 OK.
  워커 VM(e2-small) 유지(GPU 불요). ⚠️ 미검증: 실제 업로드→content.analyze E2E, 프레임 GCS 호스팅(v1 생략).
- 그 이전: YouTube 채널·영상 애널리틱스 트랙, Vercel 배포, Cloud Run/워커/큐 기반 구축.
