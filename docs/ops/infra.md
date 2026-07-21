# STEP-D 인프라 (실서비스)

> 전체 인프라의 단일 진실 소스. **바뀌면 여기 갱신한다.** 최종: 2026-07-16.
> 레거시 주의: 구 시스템(shorts-vm/shorts-pg) 문서는 폐기·삭제됐고, 리포에 남은 `apps/api`
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
- **비공개(IAM)** — invoker 바인딩은 `domain:stepai.kr` + `serviceAccount:stepd-deployer@step-d.iam.gserviceaccount.com` 둘뿐, `allUsers` 없음. 직접 URL 익명 접근은 403 (2026-07-16 실측).
  프론트는 Vercel rewrite로 **ID 토큰 프록시** 경유(`apps/web/next.config.ts` → `apps/web/src/app/api/proxy/[[...path]]/route.ts`) — 그래서 `stepd.stepai.kr/api/*`는 익명 200이다(공개면은 Vercel 웹뿐).
- ⚠️ 함정: 루트 `cloudbuild.yaml:37`과 `apps/server/cloudbuild.yaml:26` 둘 다 `--allow-unauthenticated` 플래그가 남아 있다. 현재는 배포 SA에 IAM 변경 권한이 없어 경고 후 무시되는 것으로 추정 — IAM에 반영되지 않아 실효 없음(실측). 단 권한이 생기는 순간 **매 배포가 서비스를 공개로 뒤집는다** → 플래그 제거 권장.
- 리소스: cpu 2 / mem 4Gi / timeout 600s / concurrency 10 / min 0 / max 5 (cloudbuild.yaml).
- 서비스계정: `stepd-deployer@step-d.iam.gserviceaccount.com`.
- env/시크릿(cloudbuild.yaml `--set-secrets`): `DATABASE_URL`=stepd-db-url, `GOOGLE_CLIENT_ID/SECRET`,
  `JWT_SECRET`, `PUBLIC_URL`=stepd-public-url. 평문 env: `NODE_ENV`, `GCS_BUCKET`=stepd-media.
- Cloud SQL 연결: `--add-cloudsql-instances step-d:us-central1:stepd-db` (유닉스 소켓).
- 빌드 설정 정본은 **루트 `cloudbuild.yaml`**(docker 빌드, `apps/server/Dockerfile`) — `deploy-server.ps1:101`이 이걸 submit 한다. `apps/server/cloudbuild.yaml`(buildpacks 빌드)도 공존하지만 배포 경로에서 안 쓴다.
- **자동배포 안 됨** — 두 cloudbuild.yaml 헤더의 "Triggered by GitHub push" 주석은 낡은 서술이고 GitHub 트리거는 없다. 실제 운영은 `deploy-server.ps1`의 수동 `gcloud builds submit`이 정본.

### 2. 워커 VM — `stepd-worker`
- `e2-small` (2 vCPU / 2GB), zone `us-central1-a`, Ubuntu 24.04, 부트디스크 20GB.
- **GPU 없음** — 파이프라인이 전부 관리형(Gemini)이라 불필요.
- 서비스계정 `stepd-deployer`: `roles/aiplatform.user`(Vertex) · `roles/cloudsql.client` · `roles/secretmanager.secretAccessor`.
- 코드: `/opt/stepd` (git clone, origin/main pull). systemd 서비스 `stepd-worker`(Node) + `cloud-sql-proxy`.
- DB 접속: cloud-sql-proxy(`127.0.0.1:5432`) 경유. 시크릿 `stepd-worker-db-url`(Cloud Run과 값 다름 — 소켓 vs TCP).
- Python 파이프라인: `/opt/stepd/core/.venv` (deploy/worker-pipeline-setup.sh), `CORE_PYTHON`으로 워커에 주입.
- 프로비저닝: `deploy/worker-vm.sh`(Node) → `deploy/worker-pipeline-setup.sh`(Python).
- **`/etc/stepd/worker.env` = `deploy/worker-env.sh`가 단일 진실 소스.** 워커 변수를 추가하려면
  거기에 `add_var`/`add_secret` 한 줄만 넣으면 된다 (worker-vm.sh는 이 스크립트를 호출할 뿐,
  값을 따로 갖고 있지 않다). 비파괴·멱등 — 빠진 변수만 추가하고 기존 값은 건드리지 않는다.
  `deploy-server.ps1`이 매 배포마다 실행하므로 정합이 자동으로 유지된다. 수동 실행:
  `bash /opt/stepd/deploy/worker-env.sh` → 변경 시 `sudo systemctl restart stepd-worker-youtube stepd-worker-content`.
  🔒 이 스크립트는 `YOUTUBE_UPLOAD_ENABLED`를 **절대 쓰지 않는다** ([youtube-upload-gate.md](youtube-upload-gate.md)).
- 이력: `worker-vm.sh`의 `REPO_URL` 기본값이 구 리포(`STEP-AI-official`)를 가리켜 신규 프로비저닝이
  깨지던 문제는 2026-07-17에 `STEP-AI-organization`으로 정정됐다(변경 이력 2026-07-16 리포 이전 참고).

### 3. Cloud SQL — `stepd-db`
- PostgreSQL 16. 인스턴스 연결명 `step-d:us-central1:stepd-db`.
- 접속: Cloud Run=유닉스 소켓, 워커=cloud-sql-proxy TCP, 로컬=도커 PG 별도(`stepd-pg`).
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
- 실서비스 흐름·배선: [pipeline-current.md](pipeline-current.md).
- 파이프라인 계획: [../plans/pipeline-plan.md](../plans/pipeline-plan.md), 인물엔진: [../plans/context-engine-plan.md](../plans/context-engine-plan.md).
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

| 대상 | 방법 |
|---|---|
| 프론트(Vercel) | `.\deploy\deploy-web.ps1` (또는 main 푸시) |
| 백엔드(Cloud Run + 워커) | `.\deploy\deploy-server.ps1` |
| 워커만 (코드 갱신·재시작) | 루트 `.\deploy-worker.ps1` — SSH → `git reset --hard origin/main` → 재시작 (`deploy-server.ps1 -Only worker`와 같은 일) |
| 워커 파이썬 환경(1회) | `deploy/worker-pipeline-setup.sh` + `CORE_PYTHON` env |

- Cloud Build 업로드는 `.gcloudignore`로 venv/미디어 제외(안 하면 5.2GB).
- 상세: [deploy.md](deploy.md).

## 로컬 개발

`.\dev.ps1` — 도커 PG(`stepd-pg`) + 서버(4100) + 웹(3000). 상세: [local-dev.md](local-dev.md).

---

## 변경 이력

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
