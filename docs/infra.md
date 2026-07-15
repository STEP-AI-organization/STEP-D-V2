# STEP-D 인프라 (실서비스)

> 전체 인프라의 단일 진실 소스. **바뀌면 여기 갱신한다.** 최종: 2026-07-15.
> 레거시 `deploy/INFRA.md`(shorts-vm/shorts-pg)는 폐기된 구 시스템 — 혼동 주의.

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
   │  Cloud SQL: stepd-db (PostgreSQL 16)      │
   └───────────────┬─────────────────────────┘
                   │ claim (FOR UPDATE SKIP LOCKED)
                   ▼
   ┌─────────────────────────────────────────┐
   │  워커 VM: stepd-worker (e2-small, GPU 없음)│
   │  Node 워커 + Python 콘텐츠 파이프라인       │
   │   → YouTube API / Vertex Gemini            │
   └─────────────────────────────────────────┘
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
- **비공개(IAM)** — 공개 invoker 없음. 프론트는 Vercel rewrite로 ID 토큰 프록시 경유.
- 리소스: cpu 2 / mem 4Gi / timeout 600s / concurrency 10 / min 0 / max 5 (cloudbuild.yaml).
- 서비스계정: `stepd-deployer@step-d.iam.gserviceaccount.com`.
- env/시크릿(cloudbuild.yaml `--set-secrets`): `DATABASE_URL`=stepd-db-url, `GOOGLE_CLIENT_ID/SECRET`,
  `JWT_SECRET`, `PUBLIC_URL`=stepd-public-url. 평문 env: `NODE_ENV`, `GCS_BUCKET`=stepd-media.
- Cloud SQL 연결: `--add-cloudsql-instances step-d:us-central1:stepd-db` (유닉스 소켓).
- **자동배포 안 됨** — `gcloud builds submit` 또는 `deploy-server.ps1`로 수동.

### 2. 워커 VM — `stepd-worker`
- `e2-small` (2 vCPU / 2GB), zone `us-central1-a`, Ubuntu 24.04, 부트디스크 20GB.
- **GPU 없음** — 파이프라인이 전부 관리형(Gemini)이라 불필요.
- 서비스계정 `stepd-deployer`: `roles/aiplatform.user`(Vertex) · `roles/cloudsql.client` · `roles/secretmanager.secretAccessor`.
- 코드: `/opt/stepd` (git clone, origin/main pull). systemd 서비스 `stepd-worker`(Node) + `cloud-sql-proxy`.
- DB 접속: cloud-sql-proxy(`127.0.0.1:5432`) 경유. 시크릿 `stepd-worker-db-url`(Cloud Run과 값 다름 — 소켓 vs TCP).
- Python 파이프라인: `/opt/stepd/core/.venv` (deploy/worker-pipeline-setup.sh), `CORE_PYTHON`으로 워커에 주입.
- 프로비저닝: `deploy/worker-vm.sh`(Node) → `deploy/worker-pipeline-setup.sh`(Python).

### 3. Cloud SQL — `stepd-db`
- PostgreSQL 16. 인스턴스 연결명 `step-d:us-central1:stepd-db`.
- 접속: Cloud Run=유닉스 소켓, 워커=cloud-sql-proxy TCP, 로컬=도커 PG 별도(`stepd-pg`).
- 주요 테이블: `entities`(program/episode/…), `media`, `youtube_channels`, `channel_videos`,
  `video_stats`, `channel_analytics`, `job_queue`, `content_analysis`(콘텐츠 파이프라인 결과).
- ⚠️ 함정: Postgres가 따옴표 없는 식별자를 소문자로 접음 → `SELECT *`는 소문자 키. camelCase는
  명시적 별칭(`AS "camelCase"`) 필수. (전례: refreshToken/media 필드 유실 버그, 수정됨.)

### 4. GCS 버킷
- `stepd-media` — 업로드 영상·썸네일·클립 (`GCS_BUCKET`).
- `step-d-landing` — 랜딩 영상. `step-d_cloudbuild` — Cloud Build 산출.

### 5. AI — Vertex AI (Gemini)
- 모델 기본 `gemini-2.5-flash` (`GEMINI_MODEL`로 override).
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
- 실서비스 흐름·배선: [content-pipeline-prod.md](content-pipeline-prod.md).
- 파이프라인 계획: [pipeline-plan.md](pipeline-plan.md), 인물엔진: [context-engine-plan.md](context-engine-plan.md).

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

| 대상 | 방법 |
|---|---|
| 프론트(Vercel) | `.\deploy\deploy-web.ps1` (또는 main 푸시) |
| 백엔드(Cloud Run + 워커) | `.\deploy\deploy-server.ps1` |
| 워커 파이썬 환경(1회) | `deploy/worker-pipeline-setup.sh` + `CORE_PYTHON` env |

- Cloud Build 업로드는 `.gcloudignore`로 venv/미디어 제외(안 하면 5.2GB).
- 상세: [deploy.md](deploy.md).

## 로컬 개발

`.\dev.ps1` — 도커 PG(`stepd-pg`) + 서버(4100) + 웹(3000). 상세: [local-dev.md](local-dev.md).

---

## 변경 이력

- **2026-07-15 (배포 완료)**: 콘텐츠 파이프라인(core/) 실서비스 배선 + **프로덕션 배포**.
  content.analyze 잡, content_analysis 테이블, 워커 파이썬 환경. STT를 관리형 Gemini
  오디오로 전환(GPU-free, 서울). Vertex 서울 리전. `.gcloudignore` 추가(빌드 5.2GB→소스만).
  Cloud Run 배포 SUCCESS. 워커 VM에 파이썬 venv 설치·CORE_PYTHON 주입·Vertex 스모크 OK.
  워커 VM(e2-small) 유지(GPU 불요). ⚠️ 미검증: 실제 업로드→content.analyze E2E, 프레임 GCS 호스팅(v1 생략).
- 그 이전: YouTube 채널·영상 애널리틱스 트랙, Vercel 배포, Cloud Run/워커/큐 기반 구축.
