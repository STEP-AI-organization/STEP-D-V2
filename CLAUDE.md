# STEP-D — Claude 컨텍스트

> 2026-07-16 실측 기준 갱신. 이 리포는 구 STEPD(Python FastAPI + VM)가 아니다.
> 구 코드는 `apps/api/`에 레거시로만 남아 있고, 새 작업은 `apps/web` + `apps/server` + `core/`에서 한다.

## 제품 개요

운영자(방송사·MCN) 중심의 클립/쇼츠 스튜디오. 긴 영상을 올리면 **AI 파이프라인이 추천 구간을
생성**하고, 운영자가 채택하면 트림·인코딩된 클립이 되어 편집 → 멀티채널 배포 → 성과 추적으로 이어진다.

```
업로드(GCS resumable) → content.analyze 잡 큐잉 → [워커 VM] python -m core.analyze
  (STT→자막정제→장면분할→비전채점→이름OCR→쇼츠추천, Vertex Gemini)
    → content_analysis 저장 + 회차 추천 보드에 AI 추천 기록
      → [사람] 채택/거절 → ffmpeg 트림·인코딩 → 클립 → 편집 → 배포(YouTube/Meta/SMR) → 성과
```

문서 진입점: [docs/README.md](docs/README.md) · 종합 계획: [docs/plans/step-d-master-build-plan.md](docs/plans/step-d-master-build-plan.md)

---

## 모노레포 구조 (pnpm workspace, Node ≥22)

```
apps/web/      Next.js 16 (App Router) + React 19 + Tailwind v4 + base-ui  → Vercel (stepd.stepai.kr)
apps/server/   Hono + PostgreSQL(Cloud SQL) + GCS + ffmpeg                 → Cloud Run (stepd-server)
               + src/worker.ts = 별도 워커 프로세스                          → GCE VM (stepd-worker)
core/          Python AI 파이프라인 (analyze·asr·refine·scenes·vision·names·recommend)
admin/         STEP D Lab — core/ 분석 결과 검수 도구 (서버 /lab 라우트가 서빙)
apps/api/      ⚠️ 레거시 (구 STEPD, Python FastAPI). 미사용 — 새 코드 금지. 제거 여부 미결정.
deploy/        배포 스크립트 (deploy-server.ps1 · deploy-web.ps1) + worker-vm.sh 프로비저닝
docs/          ops(현황·운영) / plans(계획) / reference / research / prototypes / archive
```

---

## 백엔드 — apps/server

Hono 단일 진입점(index.ts, **~1270줄, 라우트 ~40개**) + 별도 워커 프로세스 구조.

| 파일 | 역할 |
|------|------|
| `src/index.ts` | 모든 HTTP 라우트. 여기 한 파일에 유지. **Cloud Run은 잡을 큐잉만 한다.** |
| `src/worker.ts` | **워커 프로세스 진입점** (GCE VM에서 tsx로 상시 실행). 15분 sweep + 잡 폴링 |
| `src/queue.ts` | Postgres job_queue (FOR UPDATE SKIP LOCKED · dedupeKey · 지수 백오프) |
| `src/channel-pipeline.ts` | channel.analyze — 업로드 동기화 + 채널 애널리틱스/일별 수익 백필 |
| `src/content-pipeline.ts` | content.analyze — `python -m core.analyze` 스폰, 결과 저장 + 추천 배선 |
| `src/db-pg.ts` | PostgreSQL 전부. 엔티티=JSONB(`entities`) + 미디어/YouTube 정규 테이블 |
| `src/youtube.ts` | YouTube Data/Analytics API, 토큰 리프레시(invalid_grant→revoked), 쇼츠 분류 |
| `src/storage-gcs.ts` | GCS 어댑터 + resumable 업로드 세션 (GCS_BUCKET 없으면 로컬 폴백) |
| `src/ffmpeg.ts` | `hasFfmpeg` / `probe` / `captureThumbnail` / `trimEncode` |
| `src/seed.ts` | **의도적으로 전부 빈 배열** — 프로덕션은 데모 콘텐츠 없이 시작 |
| `schema.sql` | 테이블 정의 — 단 **job_queue·content_analysis·channel_analytics는 여기 없고 코드가 런타임 생성** (queue.ts·db-pg.ts). 상세: [docs/reference/data-model.md](docs/reference/data-model.md) |

죽은 코드 주의: `src/db.ts`(구 sqlite)·`src/storage.ts`·`src/pipeline.ts`의 `buildRecommendations()`(구 휴리스틱)는
어디서도 import되지 않는 잔존물이다. 실제 추천은 core/ AI 파이프라인이 만든다.

**워커 잡 5종** (worker.ts handle 스위치): `channel.analyze`(채널 동기화+분석, 완료 후 영상별 fan-out) ·
`video.analyze`(영상 애널리틱스+리텐션) · `video.hotwatch`(신규 업로드 48h 시간별 스냅샷, 자기 재큐) ·
`video.comments`(상위 댓글) · `content.analyze`(AI 콘텐츠 분석).

**⚠️ 배포(publish)는 아직 스텁이다.** `POST /api/distributions/publish`는 클립의 distributions 상태만
기록한다(실제 송출 없음). 반면 YouTube OAuth·채널/영상 애널리틱스·수익 수집은 실제로 동작한다.

**주요 라우트** (전체 목록: [docs/reference/api-reference.md](docs/reference/api-reference.md))
```
GET  /health · /api/state
POST /api/media/upload-init → finalize   # 브라우저→GCS 직접 resumable 업로드 (대용량 표준 경로)
POST /api/media/upload                   # 소용량 직접 업로드
GET  /api/media/:id/stream · /thumb · /analysis
POST /api/recommendations/:id/adopt · /reject
POST /api/distributions/publish · /retry # (스텁) 상태 기록만
PATCH /api/clips/:id/editor · /link-video
GET/POST /api/youtube/*                  # auth(mode=analytics|publish) · oauth/callback · channels ·
                                         # analytics/:id(/daily) · sync · videos · trends · pipeline/run
GET  /api/queue/stats · POST /api/admin/reset · /api/admin/queue/purge
GET  /lab · /api/lab/*                   # admin Lab 검수 도구
```

**환경변수** (실제 코드가 읽는 것)
```
DATABASE_URL          Cloud SQL 접속 (없으면 DB 초기화 실패)
GCS_BUCKET            있으면 GCS 모드 / STEPD_STORAGE_DIR  로컬 모드 저장 경로
GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / PUBLIC_URL       YouTube OAuth
PORT                  Cloud Run 주입(8080). cloudbuild에서 직접 설정 금지 — 예약 변수
CORE_DIR / CORE_PYTHON                    core/ 파이프라인 위치·파이썬 (워커)
STT_PROVIDER          기본 gemini (whisper=로컬 GPU 경로, 프로덕션 아님)
GOOGLE_CLOUD_PROJECT(기본 step-d) / VERTEX_LOCATION(기본 asia-northeast3)   Vertex Gemini
```

**ffmpeg은 로컬 파일만 읽는다.** GCS 모드에선 `/tmp`로 먼저 내려받아야 하고, Cloud Run의 `/tmp`는
**RAM(tmpfs)** 이므로 작업 후 반드시 지울 것 — 안 지우면 업로드마다 메모리가 쌓여 OOM 난다.

---

## 프론트 — apps/web

상세: [apps/web/CLAUDE.md](apps/web/CLAUDE.md). 요점만:

- 화면: `(app)` 그룹 9개(/, programs, episodes/:id, recommendations, clips, distribution, analytics,
  channels, publish-channels) + `(editor)` 풀스크린 에디터 + landing/register/terms/privacy.
- **데이터 레이어 함정:** `store.tsx`가 기동 시 `fetchState()`로 서버를 찔러보고 **실패하면 조용히
  목 데이터로 폴백**한다. 화면이 멀쩡해 보여도 서버 미연결일 수 있다 — `NEXT_PUBLIC_API_URL`과
  `/api/state` 응답으로 직접 확인할 것.
- 실 서버 연동은 `lib/data/api.ts`(REST)가 담당한다. `repository.ts`의 `apiRepository`는
  폐기된 SPFN 통합 스텁(미호출)이다.
- 환경변수는 `NEXT_PUBLIC_API_URL` 하나. 경로 별칭 `@/*` → `./src/*`.

---

## 배포

상세 런북: [docs/ops/deploy.md](docs/ops/deploy.md) · 인프라 SSOT: [docs/ops/infra.md](docs/ops/infra.md)

- **서버+워커**: `.\deploy\deploy-server.ps1` — 타입체크 → push → `gcloud builds submit`(루트
  cloudbuild.yaml, ffmpeg 포함 이미지) → Cloud Run 배포 → 워커 VM SSH 재시작 → 검증.
- **워커만**: 루트 `.\deploy-worker.ps1` (VM에서 `git reset --hard origin/main` + systemd 재시작).
- **웹**: `.\deploy\deploy-web.ps1` — Vercel. **커밋 author가 contact@stepai.kr이어야 배포됨**
  (Vercel git-author 차단, 스크립트가 강제). 프로덕션 = https://stepd.stepai.kr

---

## 작업 규칙

- **배포는 명시적 요청 시에만.** "ㄱㄱ", "배포해줘" 없이 git push·Cloud Build 실행 금지.
- **`.env*`, `gcp-keys/` 절대 커밋 금지.** (2026-07-14 개인키 공개 리포 유출 사고 — 커밋 전 `git status` 확인)
- 서버 라우트는 `apps/server/src/index.ts` 한 파일에 유지 — 분리하지 말 것.
- 프론트 API 함수 추가: `apps/web/src/lib/data/api.ts`에 타입 + 함수 함께.
- 새 화면 추가: `src/app/(app)/<route>/page.tsx` + `src/lib/nav.ts`의 `NAV` 배열에 항목 추가.
- 핵심 AI 파이프라인 코드는 `core/`에 (파이썬). 서버에서는 content-pipeline.ts로만 접점 유지.
- 검증: `apps/server`는 `npx tsc --noEmit`, `apps/web`은 `npx next build` (타입체크 포함).

---

## 상세 문서

- [docs/README.md](docs/README.md) — **문서 전체 지도 (여기부터)**: 현황(ops) vs 계획(plans) 구분
- [docs/ops/infra.md](docs/ops/infra.md) — 인프라 단일 진실 소스 (GCP·Vercel·큐·시크릿)
- [docs/plans/step-d-master-build-plan.md](docs/plans/step-d-master-build-plan.md) — 종합 빌드 플랜 (정본)
- [docs/reference/api-reference.md](docs/reference/api-reference.md) · [docs/reference/data-model.md](docs/reference/data-model.md)
