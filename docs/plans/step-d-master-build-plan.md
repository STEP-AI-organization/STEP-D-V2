# STEP-D 종합 빌드 플랜 (마스터)

> 작성·최종 갱신 2026-07-16. 리포 전체 문서(.md 30편 + 방향기획서 docx) 정독 + 실제 코드/인프라 실태 조사를
> 종합한 **"어떻게 만들 것인가"** 단일 기준 문서. 기존 계획 문서들(pipeline-plan·context-engine-plan·
> step-d-ux-plan(삭제됨 — §1.5로 흡수)·방향기획서)의 상위 통합본이며, **계획과 실제 구현의 갭·다음 착수점**을 명시한다.
>
> 이 문서는 다른 개별 문서와 충돌 시 **실측(코드·gcloud) 우선** 원칙으로 쓰였다.
> 현황 스냅샷은 작성 당일 커밋(329844f 직접 업로드 · 5197193 AI 추천 배선 · 4c93313 분석 탭 · a148f38 파이프라인 상태)까지 반영해 갱신했다.

---

## 0. 이 문서를 읽는 법 — 정본 / 폐기 문서 구분

리포에 **3세대 스택 문서가 혼재**한다. 빌드 시 아래 정본만 따를 것.
`docs/`는 2026-07-16에 `ops/`(현황·운영) · `plans/`(계획, 본 문서 위치) · `reference/`(용어·데이터모델) · `research/` · `prototypes/` · `archive/`로 재편됐고,
낡은 문서 5편(`backend-notes.md`·`integration-map.md`·`step-d-ux-plan.md`·`deploy/INFRA.md`·`deploy/runbook.md`)은 **삭제**됐다.
(step-d-ux-plan의 살아있는 요지 = 페인포인트·UX 원칙은 §1.5로 흡수.)

| 구분 | 정본(LIVE) | 폐기(따라가면 안 됨) |
|------|-----------|----------------------|
| 제품/비전 | `../archive/STEPD-방향기획서.docx·pdf`(마스터), `apps/docs/product-vision.md`(8레이어·5Phase 유효) | — |
| 아키텍처 | `CLAUDE.md`, [`../ops/infra.md`](../ops/infra.md)("단일 진실 소스"), 본 문서 | `apps/docs/architecture.md`(구 FastAPI), `apps/docs/dev-guide.md`, `apps/docs/feature-status.md`(구 시스템) |
| 파이프라인 | [`pipeline-plan.md`](pipeline-plan.md)(A~J 청사진), [`../ops/content-pipeline-prod.md`](../ops/content-pipeline-prod.md), [`../ops/pipeline-current.md`](../ops/pipeline-current.md) | (구 `core/README.md`·`WHISPERX_GUIDE.md`·`bridge.ts`는 9d76484에서 **삭제 완료**) |
| 인프라/배포 | [`../ops/infra.md`](../ops/infra.md), [`../ops/worker-queue.md`](../ops/worker-queue.md), [`../ops/deploy.md`](../ops/deploy.md), [`../ops/vercel-ops.md`](../ops/vercel-ops.md), `deploy/deploy-server.ps1`·`deploy-web.ps1`(워커만 재배포 = 루트 `deploy-worker.ps1`) | `docker-compose*.yml`·`Caddyfile`·`scripts/dev.ps1`·`deploy/setup-vm.sh`·`deploy/deploy.sh`(전부 구 shorts-api VM/asia-northeast3). ※루트 `deploy.ps1`은 d48c8f9에서 Cloud Run 서버 배포용으로 교체돼 더는 폐기 아님 |
| 데이터 모델 | `apps/server/schema.sql` + [`../reference/data-model.md`](../reference/data-model.md)(런타임 생성 테이블 포함 전모, §9) | — |
| 편집기 | [`opencut-integration-plan.md`](opencut-integration-plan.md), 본 문서 §7 | — |
| 코드(레거시) | `apps/web`, `apps/server`, `core/` | `apps/api`(구 Python FastAPI, 로직 참고만 — **폐기 여부 미결정**, §12 R13) |

**정리 권고(문서 위생):** 1차 실행 완료 — 2026-07-16 재편·삭제로 `deploy/INFRA.md`의 죽은 Vercel env 오염원 등이 제거됐다. 남은 폐기 대상(`apps/docs/architecture.md` 등 구 시스템 문서)은 헤더에 `> ⚠️ DEPRECATED` 배너를 달거나 `docs/archive/`로 이동.

---

## 1. 제품 요지 (한 화면 요약)

**STEP-D = 방송사·MCN용 "숏폼 자동 생성 + 멀티플랫폼 배포 + 성과 환류" B2B SaaS.**

> 60~90분 장편 회차를 올리면, **그 프로그램과 그 채널을 아는 AI**가 STT 1회로 전사 → 한국어 훅 사전·종결어미로 문장 안 잘리게 후보 추출 → 상위 후보만 Gemini 비전으로 융합 평가(비용 상한 고정) → **(후보×채널) 매트릭스**로 채널별 최적 구간 추천 → 운영자 **원클릭 채택** 시 9:16 자막 번인 쇼츠 렌더 → YouTube/Meta/SMR 배포 → 성과·댓글·리텐션 회수 → **채널 프로파일·인물 KB·훅 사전 갱신(폐루프)**.

**범용 도구(Opus Clip류)와의 결정적 차이 = B2B 컨텍스트 자산.** 고객은 이미 활성 채널·프로그램·출연자·과거 배포 데이터를 보유 → 회차가 쌓일수록 추천이 정확해지는 "컨텍스트 자산 플랫폼". 인력의 역할이 **제작 → 검수·승인**으로 바뀌는 것이 핵심 가치.

### 5대 차별화 (= 특허 발명신고서 청구 축)
1. **한국어 종결어미 스냅** — 클립 경계를 발화 경계·종결어미(-다/-요/-죠)에 스냅. 문장 중간 컷 구조적 방지. 해외 도구가 못 하는 것.
2. **비용-정밀도 계단** — 훅 사전 로컬 점수 → 상위 후보만 비전 LLM 평가(상한 고정) → 가중 융합. **회차당 AI 비용이 상수** = B2B 원가/과금 설계 근거.
3. **STT 단일 원천** — 단어 단위 STT 1회 결과를 후보·자막·제목·PPL이 공유(`transcript` 테이블). 싱크 불일치 원천 제거.
4. **채널×프로그램 적합 추천** — 추천이 단일 랭킹이 아닌 **(후보×채널) 매트릭스**. 같은 회차라도 Shorts/Reels/SMR별로 다른 구간이 상위.
5. **인물·서사 컨텍스트 엔진(CX)** — 출연자를 등록하면 "20대 남성"이 아닌 "23기 영숙"으로 확정 식별. 회차가 갈수록 인물 서사·반응·성과가 쌓여 추천 근거가 됨.

### 1.5 UX 페인포인트·원칙 (구 `step-d-ux-plan.md` §2·§4 흡수 — 원문 삭제됨)

v2 UX의 출발점이었던 구 STEPD 페인포인트 5종. 현 (app) 화면(인박스·회차 파이프라인 허브·추천 보드·통합 배포·풀스크린 에디터)은 이 목록을 정면 해소하도록 설계됐다.
- **A 워크플로우 파편화** — 추천→클립 원클릭 채택 부재(쇼츠 채택률 ≈0의 1순위 원인) + 엔티티별 화면 산개로 "이 회차가 파이프라인 어디에 있나"를 한 화면에서 못 봄.
- **B 의사결정 지원 부재** — 소스당 후보 15~20개가 우선순위 없이 쏟아짐, 거절 사유 기록 없음, 추천→클립→배포→성과 계보 단절, 성과 지표 자체가 없음.
- **C 가시성·신뢰 문제** — 파이프라인 상태 불투명(장애 시 무알림), UI 문구 ≠ 실제 동작, 데드엔드 UI, 필터/상태 소실.
- **D 편집기 UX 취약** — 말자막(STT) 부재, 템플릿·복제·폰트 확장 없음, 싱크 미세조정 UI 없음.
- **E 배포·스케줄 파편화** — 채널마다 별도 화면·별도 모달, "이 클립을 이 채널들에 한 번에" 통합 배포 액션 부재.

**UX 원칙(요지):** 최상위 목표 = *"운영자가 지금 무엇을 해야 하는지 한눈에 알고, 최소 클릭으로 회차를 소스에서 배포까지 민다."*
작업 중심(>엔티티 중심) · 원클릭 채택 · 의사결정 지원(랭킹·사유·계보) · **상태 정직성(프리뷰=출력, 문구=실동작 — §2.4·§7의 근거 원칙)** · 데드엔드 제로 · 키보드 우선(⌘K) · 낙관적 반영 · 점진적 노출.

---

## 2. 전체 아키텍처 — 하나의 큐/워커 위 두 트랙

핵심 구조: **Cloud SQL의 `job_queue` 테이블 하나 + 상시 워커 VM** 위에서 **콘텐츠 트랙**과 **채널 트랙**이 병렬로 돈다.

```
┌── 웹 (Next.js 16 / React 19 / Vercel : stepd.stepai.kr) ──┐
│   브라우저 → Next rewrite → /api/proxy (ID토큰 발급) ────────┘
│                              │ (IAM 보호된 Cloud Run 호출)
▼
API (Hono / Cloud Run : stepd-server, us-central1)
│  · 업로드·추천·채택·배포·YouTube OAuth·Lab
│  · 무거운 일은 직접 안 함 → enqueue(INSERT 1회)만
▼
job_queue (Cloud SQL : stepd-db, PostgreSQL 16)   ← FOR UPDATE SKIP LOCKED · dedupeKey · 지수백오프
▼
워커 VM (GCE stepd-worker, e2-small, GPU 없음, us-central1-a) ── tsx src/worker.ts
│
├─[콘텐츠 트랙  content.*]  content-pipeline.ts → spawn `python -m core.analyze`
│     GCS 다운로드 → STT→정제→장면분할→비전채점→이름OCR→쇼츠추천 (전부 관리형 Gemini/Vertex)
│     → content_analysis 테이블(analysis.json) → AI 쇼츠를 회차 추천 보드(recommendation 엔티티)에 기록
│
└─[채널 트랙  channel.* / video.*]  channel-pipeline.ts → YouTube Data/Analytics API
      → channel_videos · video_stats · channel_analytics · video_analytics · video_retention · video_comments

스토리지: GCS(stepd-media) = 원본·썸네일·클립  |  Cloud SQL = 엔티티·지표·큐
AI: Vertex Gemini(gemini-2.5-flash) — 서울(asia-northeast3) 리전 고정 (개인정보 데이터 레지던시)
```

**왜 Cloud Run이 아니라 워커 VM인가:** Cloud Run은 응답 종료 시 CPU throttle + 요청 600초 제한 → 백그라운드 분석/대형 채널 백필이 잘림. 그래서 Run은 enqueue만, 실행은 타임아웃·throttle 없는 상시 VM. 스케일아웃 = 워커 프로세스/VM 추가(SKIP LOCKED가 중복 픽업 방지).

### 두 트랙의 현재 성숙도
| 트랙 | 목적 | 상태 |
|------|------|------|
| **채널 트랙** (`channel.*`/`video.*`) | 연결된 YouTube 채널·영상·성과 수집(성과 환류 J의 입력) | **프로덕션 수준 완성**. OAuth→콜백→enqueue→워커→일별/시간별 지표 수집(365일 백필 + 48h hotwatch). 실동작. |
| **콘텐츠 트랙** (`content.*`) | 업로드 영상 → AI 분석 → 쇼츠 추천 | **추천 보드까지 실배선 완료**(커밋 5197193). `core/analyze.py` 6단계가 실제 Gemini로 돌아 `content_analysis`에 저장되고, AI 쇼츠가 곧 운영자 채택 대상(`recommendation`)으로 보드에 뜬다(§3.2). 남은 것 = ⓐ채택 즉시 렌더의 이연(§2.4) ⓑ9:16 렌더·프레임 호스팅 미배선(§4·§11). |

### 2.4 아키텍처 불변식 — 렌더는 최종 1회만 (Deferred Render)

> **원칙(사용자 지정): "렌더는 무조건 마지막에만."** 비싼 렌더 = **ffmpeg 9:16 인코딩 + ASS 자막 번인**은 운영자가 모든 결정(자막·리프레임·오버레이·길이·템플릿·제목)을 **확정한 뒤 단 한 번**만 실행한다. 분석·선정·편집·프리뷰 단계는 **전부 무렌더**(메타데이터/결정/근사 프리뷰).

**불변식:**
- **분석·선정·편집·프리뷰 = 무렌더.** 후보 클립·추천·장면·PPL·제목·편집 결정은 전부 **메타데이터**(구간 in/out, 좌표, 텍스트, 스타일, 리비전 JSON)로만 산출. 실제 비디오 인코딩 없음.
- **프리뷰 = 원본/프록시 스트림 Range + CSS 오버레이 근사.** 픽셀 정확한 최종본이 아니라 근사. UI에 "프리뷰는 근사치, 최종 화질은 서버 렌더" 명시(상태 정직성).
- **최종 확정 = 단일 렌더.** 운영자가 "익스포트/확정"을 누른 순간에만 서버 ffmpeg가 1회 렌더 → 그 산출물만 배포.
- **render revision(설정 해시) 캐시.** 편집 결정 전체를 해시 → 동일 결정이면 재렌더 금지(캐시 히트), 바뀐 부분만 무효화.
- 용어: 여기서 "렌더" = **비싼 비디오 인코드**(9:16 + 자막 번인). 프레임 1장 추출·썸네일 후보 이미지(G) 같은 **경량 이미지 연산은 규칙 대상 아님**.

**왜:** 회차당 후보 8~20개 × 채널 3종 × 편집 반복을 매번 렌더하면 CPU·시간·비용이 폭발한다. 렌더를 최종 1회로 미루면 ① 회차당 원가가 상수에 수렴(차별화 2 "비용-계단"과 정합) ② 편집 반복이 즉각적(무렌더 프리뷰) ③ 워커 렌더 부하가 예측 가능(스케일 정책 분리 용이).

**현재 코드와의 정합 점검:**
| 지점 | 현 동작 | 불변식 | 조치 |
|------|---------|--------|------|
| 콘텐츠 분석(`core/analyze.py`) | STT·장면·비전·이름·추천 전부 메타(JSON), 인코딩 없음 | ✅ 부합 | 유지 |
| 프리뷰(`/api/media/:id/stream`) | 원본 HTTP Range 스트리밍 | ✅ 부합 | 편집기 CSS 오버레이 근사만 얹음 |
| **채택(`POST /adopt`)** | **즉시 ffmpeg 트림·인코딩(렌더)** | ⚠️ **위반** | **채택 = 구간·결정 확정(메타)만**으로 강등, 실렌더는 최종 확정 시로 이연 |
| 최종 확정/익스포트 | (미구현) | — | 서버 ffmpeg **1회 렌더** + revision 해시 캐시로 신규 구현 |
| 배포(`publish`) | 상태만 변경(스텁) | — | **렌더된 산출물만** 배포 |

불변식 한 줄: **"분석·선정·편집·프리뷰 = 무렌더, 최종 확정 = 단일 렌더."**

---

## 3. 현재 구현 실태 (코드·인프라 실측)

### 3.1 서버 (`apps/server`, Hono, ~14파일, index.ts ≈1290줄)
- **실동작 라우트:**
  - 상태/생성: `/api/state`, `POST /api/programs`(콘텐츠 루트 생성, SMR 피드 메타 포함).
  - **업로드 2경로:** ① `POST /api/media/upload-init` → GCS **resumable 세션** 발급(`storage-gcs.ts::createResumableSession`) → 브라우저가 GCS로 **직접 업로드** → `POST /api/media/finalize`(서명 URL로 ffprobe·썸네일만 range-read — Cloud Run 메모리 평탄, GB급 마스터 대응. 커밋 329844f). ② 로컬(무GCS) 폴백 = 기존 멀티파트 `POST /api/media/upload`. 두 경로 모두 회차+마스터 생성 **+ `content.analyze` enqueue**(dedupeKey). **휴리스틱 placeholder 추천은 더 이상 만들지 않는다** — 추천 보드는 AI 결과로만 채워짐(§3.2).
  - 미디어: `/api/media/:id/stream`(Range), `/thumb`, `/analysis`(AI 분석결과 = `content_analysis`).
  - 추천/클립: `/api/recommendations/:id/adopt`(실제 ffmpeg 트림·인코딩 — §2.4 이연 대상), `/reject`(사유 기록), `PATCH /api/clips/:id/editor`(편집 결정 JSON 저장, **무렌더**), `PATCH /api/clips/:id/link-video`(배포된 YouTube 영상 연결).
  - YouTube: OAuth(analytics/publish 스코프 분리)·채널동기화·애널리틱스(일별 포함)·트렌드·댓글·파이프라인 트리거 — 전부 실제 구글 API.
  - 운영: `/api/queue/stats`, `POST /api/admin/reset`(엔티티·미디어·분석 전체 초기화), `POST /api/admin/queue/purge`(video.* 백로그 정리 + `content.analyze` 재기동), `/api/lab/*`(로컬-데브 shim).
- **유일한 실질 스텁:** `POST /api/distributions/publish`(+`/retry`) — clip.distributions에 채널·상태·예약일만 기록하고 **실제 업로드 없음**.
- **죽은 코드:** `src/db.ts`·`src/storage.ts`(구 node:sqlite 프로토타입 — live 코드는 `db-pg.ts`+`storage-gcs.ts`만 사용), `src/pipeline.ts::buildRecommendations()`(휴리스틱 제거 후 어디서도 import 안 됨 — `pipeline.ts`에서 살아있는 건 `newId`뿐), 웹 `apps/web/src/lib/data/repository.ts`의 **`apiRepository` 스텁**(SPFN RPC 통합 계획 폐기 — 실 서버 연동은 `api.ts` REST로 이미 가동).

### 3.2 추천 = AI 쇼츠 단일 경로 (✅ 2026-07-16 조인 완료 — 구 "두 갈래 병존" 해소)
- **휴리스틱 추천 폐지.** 업로드는 추천 0건으로 시작한다(커밋 b566fbc "더미 추천 제거" — `buildEpisodeAndMedia`가 `recommendations: []` 반환). 구 균등분할 `buildRecommendations()`는 死코드로만 잔존.
- **AI 쇼츠 → 추천 보드 직결.** `content.analyze` 완료 시 `content-pipeline.ts::writeRecommendationsFromShorts()`(content-pipeline.ts:98)가 `analysis.shorts`를 `recommendation` 엔티티로 변환해 회차 보드에 **멱등 기록**(기존 추천 DELETE 후 rank 역순 prepend — 재실행 시 교체, 커밋 5197193). rank 1 → appeal 5로 매핑돼 보드 최상단. 회차 `pipeline` 상태도 워커가 실반영(`recommend/done`, 실패 시 `error` — 커밋 a148f38).
- **즉 `adopt`가 자르는 대상 = 진짜 AI 추천.** 남은 갭은 채택 즉시 렌더(§2.4 위반)의 이연뿐 → **착수점 #1(§11)**.

### 3.3 core AI 파이프라인 (`core/`, Python, GPU-free)
- **정본 경로 = `core/analyze.py` 6단계**(구 `pipeline.py` 3단계·WhisperX 경로와 그 문서 `README`·`WHISPERX_GUIDE`·`bridge.ts`는 커밋 9d76484에서 **삭제 완료**):
  1. `asr.py` STT — 기본 **Gemini 2.5 Flash 오디오**(Vertex, 서울). faster-whisper는 옵션(`STT_PROVIDER=whisper`). **word-level 타임스탬프는 whisper에서만**(Gemini는 utterance 단위, `words:[]`).
  2. `refine.py` 자막 정제 — Gemini, 40개 배치, 타임스탬프 1:1 보존, `glossary.json` 결정론 재적용.
  3. `scenes.py` 장면 분할 — **PySceneDetect**(`ContentDetector threshold=27`) + ffmpeg 중점 프레임 추출. 무음 장면(`has_dialogue=False`) = 리액션 후보.
  4. `vision.py` 장면 시각 채점 — Gemini Vision, 프레임당 `{score,reason,tags}`.
  5. `names.py` 이름자막 OCR — Gemini, 로워서드 `on_screen_names` 추출(인물 앵커 검증 실험).
  6. `recommend.py` 쇼츠 추천 — 장면 타임라인 텍스트를 **단일 Gemini 호출**로 `shorts.json` 선정.
- **인증:** API 키 없음. **ADC**(로컬 `gcloud auth application-default login`, 워커 VM SA `roles/aiplatform.user`).
- **미배선/미완:** 렌더링(F)·PPL(H)·제목메타(I) 없음(core엔 STT~추천만), 프레임 호스팅 없음(scene_frames는 temp와 함께 폐기 — content-pipeline.ts:131). 구 스텁(`subtitles.py`·`downloader.py`·`bridge.ts`·`pipeline.py`)은 9d76484에서 제거됨.

### 3.4 프론트 (`apps/web`, Next 16)
- 화면: `/`(Inbox)·`/programs`·`/episodes/[id]`(파이프라인 허브)·`/recommendations`·`/clips`·`/distribution`·`/analytics`·`/channels`·`/publish-channels` + `/editor/[id]`(풀스크린)·`/landing`·`/register`·`/terms`·`/privacy`.
- 데이터층: `store.tsx`가 기동 시 `fetchState()` → **실패하면 조용히 목 폴백**. 실 서버 연결은 `repository.ts`(throw 스텁, 우회됨 — §3.1 죽은 코드)가 아니라 **`api.ts`가 직접** 담당. **AI 분석결과도 프론트가 소비한다:** `api.ts:57 getMediaAnalysis()`가 `GET /api/media/:id/analysis`를 호출하고, 회차 상세(`episode-detail.tsx`) **분석 탭이 실제 `content_analysis`를 렌더**(커밋 4c93313 — 목 데이터에서 교체됨).
- `apps/web/src/components/editor/` 편집기: 골격(editor-shell·timeline·preview·panel)에 더해 **웨이브폼(editor-waveform)·타임코드 입력(editable-timecode)·자막/오버레이 직접조작(editor-overlay)이 네이티브 구현돼 있고**(커밋 201dd54), 편집 결정은 `PATCH /api/clips/:id/editor`(무렌더, `api.ts::saveClipEditor`)로 저장된다. `../prototypes/editor-prototype.html`("AENA 에디터 통합 프로토타입" — AENA=구 브랜드)은 좌(추천/클립 카드·원클릭 채택)·중(9:16 프리뷰+드래그 리사이즈 자막/오버레이)·우(클립·인코드 큐)·하(웨이브폼 타임라인·트림 핸들·IN/OUT·스냅 가이드·줌·멀티트랙) 3분할 **정적 목업(백엔드 미연결)**. 6개 검수 조작 UI 시각화.

### 3.5 admin (`admin/`)
- "STEP D Lab" = **독립 서버 아님, 정적 프론트**. 하나뿐인 서버(apps/server)의 `/api/lab/*`에서 core 산출물(STT·정제자막·장면·프레임)을 fetch해 눈으로 검수. 파라미터 튜닝 루프용.

---

## 4. 필요 기술 스택 — 무엇을·왜·어떤 기술·라이선스

**대원칙 (방향기획서·pipeline-plan):** ① 특허 청구 로직(B·C·D·E융합·H교차)은 **100% 자체 구현** ② 오픈소스는 "재료"(형태소·인코딩·얼굴검출)로만 ③ 모델 추론은 **관리형 API(GPU 무운영)** ④ 모든 타임스탬프 PTS 초 단위 통일 ⑤ **Ultralytics YOLO(AGPL) 배제** — 자체 검출기 필요 시 Apache 계열(RF-DETR 등).

### 4.1 발명신고서 구성 A~J × 기술
> **렌더 불변식(§2.4):** A~E·G~I는 전부 **메타데이터/경량 이미지 연산 = 무렌더**. 실제 비디오 렌더는 **F 단 하나**이며, 그마저도 파이프라인 자동이 아니라 **운영자 최종 확정 시 1회**만 실행한다.

| 구성 | 역할 | 기술 선택 | 라이선스/근거 | 현재 |
|------|------|-----------|--------------|------|
| **A 수집·변환** | MXF/파일/URL 수용, 리먹스 분기, 분석용 프록시 | ffmpeg(리먹스 = ffprobe 코덱검사 H.264+AAC→`-c copy`), yt-dlp(URL), 프록시 480/720p + 16kHz mono wav | ffmpeg LGPL/GPL, yt-dlp Unlicense | 업로드+ffprobe만. 프록시·리먹스·URL임포트 신규 |
| **B STT 1회-공유** | 단어 타임스탬프 STT → `transcript` 테이블 전 단계 공유 | **미결(§12):** 현 core=Gemini 오디오 / 계획=Clova Speech 1차 / whisper=word-level. **어댑터로 감쌈** | 관리형 API | core에 Gemini STT 실동작. transcript 테이블·단어 타임스탬프 정합 미완 |
| **C 훅 사전 후보** | 한국어 훅 사전 대조 + 로컬 점수(후보상한30·중첩0.35·프리롤2.5s) | **100% 자체 IP** + **Kiwi**(형태소, `kiwi-nlp` WASM) | Kiwi LGPL-3(SaaS 사용이라 무관) | 전부 신규(휴리스틱만) |
| **D 종결어미 스냅** | EF 종결어미+발화경계 스냅(룩백8s/룩어헤드10s) | **100% 자체 IP** + ffmpeg `silencedetect`(+옵션 Silero VAD) | Silero VAD MIT | 전부 신규 |
| **E 융합 평가** | 상위 20개×7프레임 비전 루브릭 → 0.70/0.30 융합 | **Gemini** 멀티모달(structured JSON 4축) + 융합 자체 | 관리형 | core `vision.py`가 장면 단위 채점은 함(후보×프레임 방식과 다름) |
| **F 렌더링** ⟵ **유일 렌더 지점(최종 확정 시 1회)** | 9:16 리프레이밍(블러배경)·자막번인·템플릿·render revision 캐시 | **ffmpeg + libass(ASS)** = 디자인 템플릿. 화자추적은 **MediaPipe**(2단계). Remotion **비채택**(유료) | MediaPipe Apache-2 | `trimEncode` 단순 트림만. 9:16·자막·템플릿 신규. **§2.4: 채택 즉시 렌더 → 확정 시 렌더로 이연** |
| **G 썸네일** | 후보 프레임 스코어링(선명도+얼굴)+규격 최적화 | ffmpeg + 라플라시안 분산 + MediaPipe + **sharp** 리사이즈 | sharp Apache-2 | 1장 고정. 스코어링 신규 |
| **H PPL** | 비전 상품식별 × 음성 브랜드 언급 이중 신호 → 구간화·CSV | Gemini vision + STT 브랜드매칭(사전 자체). 보강: **Video Intelligence Logo Recognition**(구간 타임스탬프) | 관리형 | 전부 신규(레거시 apps/api에 참고 코드) |
| **I 제목·메타** | 바이럴 5종 제목·태그·무음 리포트 | Gemini + 프롬프트 자산 자체. 무음=D의 silencedetect 재사용 | 관리형 | 전부 신규 |
| **J 배포·환류** | 회차 스케줄링·멀티플랫폼 업로드·성과 수집·환류 | **YouTube Data API v3** resumable / **Meta Graph API**(앱심사 리드타임) / **SMR 어댑터**(공개 API 없음, FTP/CMS) / 댓글요약 LLM | — | 채널 수집·OAuth 실동작, **publish 스텁**. 실업로드·Meta·SMR·환류 신규 |

### 4.2 큐·워커·인프라 재료
| 항목 | 선택 | 근거/라이선스 |
|------|------|--------------|
| 작업 큐 | **자체 `job_queue` 테이블**(FOR UPDATE SKIP LOCKED) — 이미 프로덕션. 계획서의 pg-boss는 **미결(§12)** | Redis 불필요, Cloud SQL 재활용 |
| 렌더 워커 | 현 e2-small VM. 렌더 부하 증가 시 **Cloud Run Jobs** 또는 워커 증설 | CPU·시간 소모 큼 → API와 스케일 분리 |
| 형태소 | Kiwi(`kiwi-nlp`) | LGPL-3, WASM npm |
| 이미지 리사이즈 | sharp | Apache-2 |

### 4.3 객체탐지/OCR/비전 (object-detection-research 결론)
- **PPL(H):** 1차 Gemini 멀티모달(E 인프라 공유, 추가비용 0) → 보강 **Video Intelligence Logo Recognition**(10만+ 브랜드, 구간 타임스탬프) → 장기 Grounding DINO(Apache) 자체호스팅.
- **리프레이밍(F)·썸네일(G)·얼굴:** **MediaPipe**(Apache, CPU) + 라플라시안 선명도. 추적 **ByteTrack**(MIT).
- **OCR(이름자막):** **PaddleOCR**(Apache) 또는 Gemini — 방송 이름자막이 인물 식별 최강 앵커.
- **의상 re-ID:** **OpenCLIP**(MIT).
- ⚠️ **배제/함정:** Ultralytics YOLO = AGPL(B2B 부적합). InsightFace 등 얼굴 임베딩 **모델 가중치가 비상업 라이선스**인 함정 — 도입 시점 재조사 필수.

---

## 5. 인물·서사 컨텍스트 엔진 (CX) — 차별화 5의 구현

**전제:** B2B라 출연자·회차·배포 데이터가 처음부터 존재 → 영상 이해를 "익명 장면"에서 "확정 인물·누적 서사"로 격상.

- **CX-1 캐스트 레지스트리:** 프로그램·기수별 출연자 등록(이름/역할/대표 얼굴). 1화 분석 후 미등록 얼굴 클러스터에 이름 붙이는 반자동 온보딩. 얼굴 식별 = **다중 신호 융합 투표**(아래).
- **CX-2 장면 이해:** 샷당 대표 프레임 1~2장에 **3중 컨텍스트 주입**(①확정 인물 ID ②구간 전사 ③인물 KB 요약) → 장면 레코드 `{시각,공간,등장인물,행동,요약문}` → 롤업 → **서사 타임라인**(회차 시놉시스는 부산물).
- **CX-3 인물 KB:** `person`/`person_episode_log`/`person_reaction` 정규 테이블 + 클립 **등장인물 태그**(성과 귀속 키). 페르소나 태그·시청자 반응(인물별 댓글 감성·기대)·인물별 성과 누적.
- **CX-4 선정 통합:** `최종점수 = [비전 0.70 + 로컬 0.30] × 채널 적합 계수 × 인물·서사 계수`. 인물·서사 계수 = 인물 화제성 + **기대 매칭**(댓글 "영숙 답장 언제 나옴?" × 미방영 장면) + 서사 완결성.
- **CX-5 환류:** 배포 성과·댓글 → KB 갱신 → 다음 회차 CX-2 프롬프트·CX-4 계수 자동 반영. 채널 분석 차원에 **인물** 축 추가.

**다중 신호 인물 확정 스택 (핵심):**
| 신호 | 기술 |
|------|------|
| 얼굴 검출 | MediaPipe(CPU, 얼굴 있는 프레임만 후단 호출 = 비용 필터) |
| 얼굴 매칭 | 1차 Gemini 폐쇄후보군("이 15명 중 누구") / 2차 임베딩+**pgvector**(Cloud SQL 확장) |
| 이름자막 OCR | PaddleOCR/Gemini — **방송 특화 최강 앵커** |
| 의상 re-ID | OpenCLIP(회차 내 의상 고정 → 뒷모습·원경 커버) |
| 발화 귀속 | STT 화자분리 × 얼굴 입 움직임 |
| 샷 내 전파 | ByteTrack(한 프레임 확정 → 트랙 전체 ID 전파, 호출 절감) |

**게이트(필수):** CX1 착수 전 실제 1회분 PoC로 **주요 인물 샷 태깅 정확도 90%+** 및 회차당 비용 실측 통과. 미달 시 CX-2 연쇄 붕괴 → CX 트랙 재설계.

**법무:** 얼굴 인식 = 민감정보(PIPA). 방송사 계약에 출연자 초상 데이터 처리 근거 명시(출연 계약상 권리 활용).

---

## 6. 채널 분석 & 트렌드 모듈

### 6.1 채널 분석 6단계 루프 (J 확장) — 알고리즘 적합 최적화
2026 YouTube Shorts는 스와이프율이 아니라 **임프레션당 시청시간·완주율**이 지배 신호(30초 미만 완주 ~65%, 30~60초 ~50%가 노출 문턱).
1. **수집** — YouTube Analytics API(views·engagedViews·avgViewDuration/Percentage·**리텐션 커브**·트래픽 소스·시청층·구독 전환). 게시 후 0~48h 시간단위, 이후 일단위. → `metrics_snapshot`(리텐션 커브 JSON). *(현: `video_stats`·`channel_analytics`·`video_retention`으로 이미 수집 중)*
2. **정규화** — 절대 조회수 금지. 채널 최근 N개 중앙값 대비 배수 + 경과시간 정렬.
3. **피처 조인** — 클립 메타(훅 카테고리·길이·프리롤·제목패턴·게시시각·등장인물) × 성과.
4. **진단** — 초반 3초 이탈→D(시작 스냅), 완주율vs길이→E(목표 길이), 중반 이탈↔전사→C(훅 가중치), 트래픽 소스→I(제목).
5. **프로파일 갱신** — 승자 분포로 채널 소프트 성향 자동 보정(가중 이동평균→데이터 쌓이면 회귀).
6. **A/B 실험** — '복사 후 수정' 변형판으로 시작점·제목·썸네일 실험. 게시 시각 추천.

### 6.2 트렌드 모듈 (T) — 남의 잘 나가는 쇼츠 역분석
- 트렌딩 쇼츠(`videos.list chart=mostPopular regionCode=KR` + 벤치마크 채널 + yt-dlp 제보 큐)에 우리 파이프라인(STT+비전)을 돌려 **형식**을 태깅(오프닝 구조·자막 스타일·컷 템포·길이).
- **트렌드 패턴 라이브러리** `{패턴명,정의,예시,빈도추이,최초관측일}` — 반감기 감쇠로 지난 유행 배제.
- 제작 반영 = **suggest까지만 자동, apply는 운영자 승인**(브랜드 톤 보호). 예: 무맥락 콜드오픈 옵션·자막 훅 프리셋·훅 사전 신규 항목 제안.

---

## 7. 영상 편집기 통합 (CapCut 오픈소스 활용) — 비파괴 이식

> 요구: "지금꺼 안 깨지게" 기존 프로덕션(apps/server·web)에 편집기를 **비파괴적**으로 얹는다.
> STEP-D 파이프라인이 이미 만든 산출물(후보 클립·9:16·자막·오버레이)을 **사람이 불러와 다듬고 다시 서버 렌더**하는 흐름.

### 7.1 오픈소스 편집기 후보 비교
> 라이선스·별 수치는 **실제 GitHub LICENSE / npm 레지스트리로 검증**(2026-07 조사, 추정 아님).

| 후보 | 스택 (React/Next 호환) | 라이선스 (검증) | 성숙도 | 핵심 기능 | 익스포트 | 통합 난이도 | B2B 상업 사용 |
|------|------|----------|--------|-----------|----------|-------------|--------------|
| **OpenCut** | classic: **Next.js App Router + React 19 + Tailwind** / 신규 main: Vite+TanStack+**Rust·WASM** | **MIT** (`OpenCut-app/OpenCut`, `opencut-app/opencut-classic` 둘 다 MIT) | **70,919★**. 단 별은 재작성 중 main에 붙음. **안정 Next.js 코드 = 별도 저장소 `opencut-classic`(2026-05-17 아카이브)** | 멀티트랙 타임라인·컷/트림·텍스트·오버레이·일부 트랜지션·웨이브폼 | **브라우저 렌더**(opencut-wasm, 로컬 우선/IndexedDB) | **부품 발췌 = 중** / 통포크 = 높음 | ✅ **MIT** |
| **OpenVideo** (구 designcombo/react-video-editor) | Next 15 + React + **Tailwind v4** + Zustand + PixiJS v8 + Radix/shadcn (궁합 최상) | **듀얼, MIT 아님** (`openvideodev/react-video-editor`=NOASSERTION; ≤3인/비영리 무료, 4인+ 영리는 유료 Company License; 파생 판매 금지; `@designcombo/*` SDK는 **license 필드 없음**=권리유보) | 1,735★, 활발 | CapCut 클론 풀세트(타임라인·자막·오버레이·트랜지션) | 브라우저 WebCodecs+Pixi → MP4 | 중하(스타터킷) | ⚠️ **회사(4인+) 유료** |
| **React Video Editor "Pro"** (reactvideoeditor.com) | Next + Remotion | **유료·소스공개형(OSS 아님)**; 재배포·경쟁제품 금지, 위반 시 **£50,000/건** + 별도 Remotion 라이선스 | 상용 | 완성형 CapCut형 | Remotion 렌더 | 낮음(구매 시) | ❌ 이중 비용·재배포 불가 |
| **Remotion** | React 프로그래매틱 렌더러 (**타임라인 UI 아님**) | 소스공개형; 개인·소기업 무료, **회사 유료**(~$25/dev·월, 월 $100 최소) | 53.3k★ | 렌더 엔진(코드), 편집 UI 없음 | 서버(Node/Lambda) | — (UI 없음) | ⚠️ **회사 유료** |
| **Revideo** (re.video) | TS 코드기반 + React `<Player/>` 프리뷰 | **MIT** (`redotvideo/revideo`) | 3.9k★, 활발 | 코드로 씬 기술 → 렌더. **드래그 타임라인 UI 아님** | 서버/CLI(헤드리스) | 높음(UI 직접) | ✅ 단 운영자용 UI 아님 |
| **Etro** (etrojs) | 프레임워크 무관 TS 라이브러리 | **GPL-3.0** (`etro-js/etro`) — 강한 카피레프트 | 1.1k★ | 프로그래매틱 레이어/필터, UI 없음 | 브라우저 MediaRecorder | — | ❌ **폐쇄 SaaS에 바이럴** |
| **Diffusion Studio** (@diffusionstudio/core) | 브라우저 WebCodecs 엔진(TS) | **MPL-2.0** + 워터마크 제거 유료키 | 1.2k★, 2024-10 정체 | 프로그래매틱 렌더 엔진, UI 없음 | 브라우저 WebCodecs | 높음(UI 직접) | △ 워터마크/UI 없음 |
| **Cap** (cap.so) | Tauri v2 **데스크톱 앱**(SolidStart+Rust) | **AGPLv3** (일부 crate MIT) | 20.2k★ | 화면녹화·로컬 편집. **임베드형 웹 타임라인 아님** | 데스크톱 로컬 | — | ❌ **AGPL 네트워크 카피레프트** |

### 7.2 추천: **OpenCut(`opencut-classic`)에서 UI 부품 발췌 (통포크 금지)**
> 리포 기존 결론(`opencut-integration-plan.md`)과 동일 방향이나, **발췌 기준을 "main의 v0.3.0 태그"가 아니라 아카이브된 별도 저장소 `opencut-app/opencut-classic`(2026-05-17 아카이브, MIT)로 고정**한다. main은 Vite+Rust로 전혀 다른 프로젝트가 돼 "재평가"가 무의미. → **`opencut-integration-plan.md` 갱신 권장.**

**근거:** 상업용 B2B SaaS에 안전(MIT) + **실제 React/Next 타임라인 UI** + 비파괴(최종 렌더는 우리 서버 ffmpeg 유지) 세 조건을 **동시에** 만족하는 후보는 OpenCut이 유일하다.
1. **진짜 MIT인 유일한 완성형 타임라인 UI** — Revideo(MIT)는 UI 없는 코드 렌더러, OpenVideo/RVE/Remotion은 유료, Etro(GPL)·Cap(AGPL)은 폐쇄 SaaS 사용 불가, Diffusion Studio(MPL)는 UI 없음+워터마크.
2. **스택 궁합** — classic은 React 19 + Tailwind로 apps/web과 마찰 낮음(프리미티브만 base-ui vs radix/shadcn 소폭 어댑팅).
3. **비파괴 이식에 유리** — 필요한 건 **UI 패턴**(웨이브폼·타임코드 입력·드래그 스냅·자막 오버레이 편집)이지 로컬 우선 저장/브라우저 렌더 엔진이 아니다. 부품만 격리하면 서버 렌더 아키텍처 무변경.

**차선(runner-up) = OpenVideo(구 designcombo):** 기능·스택 궁합은 최상이라 "덜 만들어도 됨"이 장점이나, ① **더 이상 MIT 아님**(회사 4인+ 유료 Company License, 파생 판매 금지, SDK 무라이선스) ② 로컬 우선 브라우저 익스포트가 우리 서버 렌더·GCS 마스터 구조와 정면 충돌. 결국 라이선스 비용 내며 익스포트 모델과 싸움. → 채택 안 함.

**절대 회피(라이선스):** Etro(GPL-3.0)·Cap(AGPLv3) = 폐쇄 SaaS 소스공개 강제(바이럴). OpenVideo/designcombo = 회사 유료 + SDK 라이선스 미표기. RVE Pro = 유료·재배포 금지·£50k 위약금. Remotion = 회사 유료.

**왜 통포크는 안 되는가:** ① `opencut-classic`은 아카이브(유지보수 종료), main은 Rust/WASM 재작성이라 업스트림 추적 무의미 ② **로컬 우선(브라우저 다운로드+IndexedDB)** 모델이 STEP-D의 **서버 미디어(GCS)+서버 ffmpeg 렌더** B2B 모델과 정반대(방송 마스터를 브라우저에 못 내림) ③ `opencut-wasm` GPU 컴포지터 불필요(우리는 프리뷰=`<video>`+CSS 오버레이, 최종 화질은 서버 렌더) ④ 우리 레포에 이미 `apps/web/src/components/editor/` 골격 존재.

### 7.3 비파괴 통합 설계
```
발췌 코드 → apps/web/src/vendor/opencut/  (격리, MIT 고지 + NOTICE, opencut-classic 아카이브 커밋 고정)
우리 수정 → vendor 밖 wrapping (아카이브라 업스트림 픽스 없음 = 우리가 소유·관리)
```
발췌 대상(계획서 지정): `audio-waveform.tsx`, `editable-timecode.tsx`, `drag-line.tsx`/`drop-target.ts`, 프리뷰 `text-edit-overlay.tsx`/`transform-handles.tsx`/`snap-guides.tsx`.
- **미디어 소스:** 그들의 IndexedDB 대신 우리 **`/api/media/:id/stream`(HTTP Range 이미 구현, 프록시 해상도)**.
- **편집 상태:** `store.tsx`에 editor 상태 추가(선언적 `EditorState` 통짜 직렬화). 그들의 zustand 스토어는 어댑터로.
- **렌더(핵심, §2.4 불변식):** 편집 중에는 **무렌더** — 브라우저 익스포트(opencut-wasm)도 서버 렌더도 안 함. 에디터는 **편집 결정(EDL/리비전 JSON)** 만 산출(in/out·자막 텍스트·위치·스타일·오버레이 트랜스폼·템플릿/콜드오픈/썸네일/제목). 운영자가 **"익스포트/확정"**을 누른 순간에만 그 리비전을 서버로 POST → **서버 ffmpeg가 9:16 + ASS 자막 번인을 1회 렌더**(render revision 해시 캐시로 동일 결정 재렌더 방지). **서버 ffmpeg 렌더가 최종 화질의 단일 진실원.** 리트림 시 D 스냅 재적용.
- **자막 프리뷰:** 퍼센트 좌표 + 고정 종횡비 캔버스 CSS 오버레이로 **근사**. UI에 "프리뷰는 근사치, 최종 화질은 서버 렌더" 명시(상태 정직성 원칙).
- **CJK 자막 함정 2가지(반드시 점검):** ① **libass 폰트** — 렌더 컨테이너(Cloud Run 이미지)에 CJK 폰트 파일이 fontconfig에 설치돼 있어야 함. 없으면 자막이 두부(□)로 렌더. ② **좌표계 변환** — 브라우저 프리뷰의 px 위치·크기를 ASS `\pos`/마진/`PlayResX·PlayResY`로 정확 매핑해야 프리뷰=최종 일치(최대 함정). 프리뷰 CSS 폰트를 서버 ASS와 **동일 폰트**(Pretendard/Noto Sans CJK/G마켓 산스)로 맞춰 WYSIWYG.
- **접점(가장 중요, §2.4):** 채택 = **구간·결정 확정(메타, 무렌더)**. 편집기는 트림된 파일이 아니라 **원본/프록시 스트림의 해당 구간**을 `/api/media/:id/stream`으로 로드(무렌더) → 사람이 리트림/자막/템플릿/콜드오픈/썸네일/제목 6개 조작(전부 메타 결정) → **최종 확정 시 export-clip 잡이 서버 ffmpeg로 1회 렌더** → 그 산출물을 배포. 즉 §11의 "AI 추천→채택" 흐름 **뒤에** 붙고, **렌더는 이 확정 지점 하나뿐**.

### 7.4 편집기 마일스톤
- **E-0 (지금·비파괴 최소):** 기존 `components/editor/` 골격 유지. `/api/media/:id/stream`으로 채택 클립 재생 + retrim(이미 서버에 `POST /adopt` 재트림 존재) 연결만. **기존 화면 무변경.**
- **E-1 (AP3 병행, 최소 편집기):** `opencut-classic`에서 **웨이브폼 + 타임코드 입력 + 드래그 스냅** 발췌 → 리트림 정밀화(종결어미 스냅 D와 궁합). **자막 오버레이 인라인 편집**(text-edit-overlay·transform-handles·snap-guides). `docs/editor-prototype.html` 목업이 목표 UI.
- **E-2 (조건부, Phase 2):** 편집 로그 계측 → "6개 조작 밖" 요구가 실측되면 `opencut-classic` `panels/timeline/` 멀티트랙 이식. 그 이상(모션그래픽)은 프리미어 인계(XML/패널) 영역.

**편집기 리스크:** ① v0.3.0 태그 고정 안 하면 main 재작성에 휩쓸림 ② 브라우저 프리뷰 ≠ 서버 렌더 화질 괴리(상태 정직성 UI로 관리) ③ CJK 자막 렌더 일치(프리뷰 CSS ↔ ASS libass) ④ MIT 고지·NOTICE 누락 금지.

---

## 8. GCP 인프라 현황 & 필요분

### 8.1 현황 (프로젝트 `step-d`, 번호 872105344568)
- **리전:** 컴퓨트·SQL·GCS = **us-central1** / **Vertex Gemini만 asia-northeast3(서울)** — 개인정보 데이터 레지던시.
- **Cloud Run** `stepd-server`(cpu2/mem4Gi/timeout600s/concurrency10/max5, SA `stepd-deployer@`). **유일 백엔드.**
- **워커 VM** `stepd-worker`(e2-small, us-central1-a, GPU 없음, 공개 IP 없음→Cloud NAT egress).
- **Cloud SQL** `stepd-db`(PostgreSQL 16, 연결명 `step-d:us-central1:stepd-db`).
- **GCS** `stepd-media`(업로드·썸네일·클립) / `step-d-landing` / `step-d_cloudbuild`.
- **Artifact Registry** `us-central1-docker.pkg.dev/step-d/stepd-server/stepd-server`.
- **Secret Manager:** `stepd-db-url`(Run 소켓) · `stepd-worker-db-url`(VM TCP, **값 다름 주의**) · `stepd-google-client-id/secret` · `stepd-jwt-secret` · `stepd-public-url`.
- **인증 경로:** 브라우저 → Vercel(`stepd.stepai.kr`) → Next rewrite → `/api/proxy`가 `GCP_SERVICE_ACCOUNT_KEY`로 **ID 토큰 발급** → IAM 보호 Cloud Run. `NEXT_PUBLIC_API_URL`은 **반드시 비워둘 것**(값 있으면 브라우저가 IAM Run 직접 쳐서 403).

### 8.2 배포 흐름
- **서버:** `.\deploy\deploy-server.ps1` (typecheck → `git push`(워커가 pull) → `gcloud builds submit --config cloudbuild.yaml` → Cloud Run 배포 → **워커 SSH `git reset --hard` + `systemctl restart stepd-worker`**). **⚠️ Cloud Run은 푸시 자동배포 안 됨** — 스크립트 필수.
- **웹:** `.\deploy\deploy-web.ps1` (`next build` → `git push` → Vercel 자동). Vercel 프로젝트 `step-d-v2-web`, scope `step-ai`, Root `apps/web`, **`next build --webpack` 강제**(Turbopack이면 자산 404).

### 8.3 필요분 (로드맵과 연동)
| 필요 | 시점 | 내용 |
|------|------|------|
| **GCS 서명 URL 업로드** | AP1 | GB급 마스터 → 클라이언트 직접 업로드, 서버는 완료 통지만(현 메모리 버퍼는 OOM 위험) |
| **렌더 워커 분리** | AP3 | **최종 확정 렌더(§2.4) 전용** ffmpeg 부하 → Cloud Run Jobs 또는 워커 증설(API와 스케일 분리). 렌더가 최종 1회로 제한돼 부하 예측 가능. `/tmp` tmpfs 정리 필수(OOM) |
| **Vertex 쿼터 상향/레이트리미터** | AP3~4 | 90분 회차 = 1000+ Gemini 호출. 동시 회차 몰리면 서울 리전 쿼터 천장 → 전역 레이트리미터·배치 API |
| **pgvector 확장** | CX1~2 | 얼굴·의상 임베딩 검색(2차 인물 매칭) |
| **`yt-analytics.readonly` 스코프 추가** | AP4 | 현재 스코프에 없어 진짜 리텐션/트래픽 분석 제한. OAuth 앱 프로덕션 게시 + 구글 심사 필요 |
| **Meta 앱 심사** | AP4 이전 | 리드타임 김 → 조기 신청 |
| **워커 HA** | 운영 강화 | 현 워커 단일. 죽으면 `job_queue.pending` 무한 적재(`/api/queue/stats` 감지) |

---

## 9. 데이터 모델 (현재 + 신규)

**현재 (Cloud SQL):**
- `entities(kind,id,data JSONB,ord)` — `program|episode|recommendation|clip|job` 도메인 그래프(JSON 블롭).
- 정규: `media` · `youtube_channels` · `channel_videos` · `video_stats` · `channel_analytics` · `video_analytics` · `video_retention` · `video_comments` · **`content_analysis`**(mediaId PK, AI 분석결과) · `job_queue` · `kv`.

**신규 필요 (방향기획서 8.2 + 각 트랙):**
- `transcript`(단어/문장별 start·end PTS) — B의 단일 원천. **C/D/F/I/H가 전부 이 테이블만 읽음(재호출 금지).**
- `candidate`(훅 후보 + 로컬/비전/융합 점수 + 채널별 계수) — 중간 산출물 저장(파라미터 튜닝 재실행 최소화).
- `scene_record` / 서사 타임라인 — CX-2.
- `person` / `person_episode_log` / `person_reaction` + 클립 **등장인물 태그** — CX-3.
- `metrics_snapshot`(클립,채널,시각,지표 + 리텐션 JSON) — 성과 환류.
- `trend_pattern` — 트렌드 모듈.
- **스키마 소량 확장:** `recommendation`에 reject 사유, `distribution`에 성과 컬럼, `clip`에 subtype(하이라이트/예고).

**DB 함정(실제 버그 이력):** ① Postgres가 따옴표 없는 식별자를 소문자로 접음 → camelCase는 `AS "camelCase"` 필수 ② node-postgres가 BIGINT를 **문자열** 반환 → `new Date(Number(x))` 필수 ③ 마이그레이션 도구 부재(수동 `schema.sql`) → **Drizzle/Prisma 등 도입 검토**.

---

## 10. 우선순위 로드맵

> 운영 원칙(방향기획서): 소수 팀은 병렬로 벌리지 말고 **PoC → AP1+AP2 → 첫 고객 회차 골드셋 평가 → 다음 단계**로. 고객이 과거 수동 제작한 클립을 **골드셋**으로 확보해 AP2부터 자동 회귀 평가.

### PoC 게이트 (1~2주, 버리는 코드) — **가장 먼저**
- **PoC A 추천 품질:** 실제 회차 1개 → STT → 훅 사전 초안 + 경계 스냅 → 후보 20개 육안 평가. 종결어미 스냅이 정말 문장을 안 자르는지 + STT 단어 타임스탬프 정밀도 실측(→ B 스택 확정).
- **PoC B 인물 식별:** 샷 분할 → Gemini 폐쇄군 매칭 ±OCR → 샷 100개 수동 채점. **90%+ 미달 시 CX 트랙 재설계.**

### AP 트랙 (AI Pipeline) × CX 트랙 × 편집기
| 단계 | 콘텐츠(AP) | CX | 편집기 |
|------|-----------|----|--------|
| **AP1 골격** | 서명 URL 업로드, 프록시 생성, 리먹스 분기, 잡 체인(`media.ingest→analyze.stt→analyze.candidates→analyze.vision→clip.render→publish`) — **`clip.render`는 최종 확정 시 1회만 트리거(자동 아님, §2.4)**, GCS↔/tmp 수명관리 | — | E-0(채택 구간 재생·retrim 연결) |
| **AP2 진짜 추천** ★첫 체감가치·영업데모 | STT+`transcript`, 훅 사전 C, 경계 스냅 D, **`buildRecommendations()` 교체** = (A)/(B) 조인. **프로그램·채널 프로파일 스키마 + 하드 제약 필터 + 클립 인물 태그 자리 선반영**. **[이 단계 렌더 없음 — 전부 메타]** | CX1 착수 준비 | — |
| **AP3 평가+렌더 파이프라인** | 비전 융합 E + **(후보×채널) 매트릭스** + 채널 탭 **(무렌더, 메타 점수)**, 9:16 블러+ASS 자막+템플릿 F **[F = 유일 렌더, 최종 확정 시 1회]**, 썸네일 G(경량 이미지) | CX1(캐스트 등록·인물 확정 태그)·CX2(장면 레코드·서사 타임라인·시놉시스) | **E-1(웨이브폼·타임코드·드래그스냅·자막 오버레이 편집 — 무렌더 프리뷰)** |
| **AP4 배포 실동작** | YouTube **실업로드**, 스케줄러, 제목/메타 I, **Meta 앱 심사 착수**, 채널 분석 수집(1~3단계) | CX3(인물 KB·댓글 인물별 구조화) | — |
| **AP5 차별화 완성** | PPL H, 화자추적 리프레이밍, 댓글 요약, 채널 분석 진단·A/B(4~6), 트렌드 모듈 T, SMR 어댑터 | CX4(인물·서사 계수 통합·기대 매칭 부스트) | E-2(조건부 멀티트랙) |

---

## 11. 현재 대비 갭 & 다음 착수점 (구체적)

**🎯 다음 착수점 #1 — 콘텐츠 트랙 (A)/(B) 조인 (AP2 핵심):**
지금 업로드하면 (A)휴리스틱 추천이 운영자에게 뜨고, (B)진짜 AI 쇼츠는 `content_analysis`에 저장되지만 **서로 안 이어짐**. 착수 순서:
1. `content.analyze` 완료 시 `content_analysis.data.shorts`를 **`recommendation` 엔티티로 변환·머지**(scene_from/to → start/end, title/reason/tags 매핑).
2. `buildRecommendations()` 휴리스틱을 "AI 분석 대기 중 placeholder"로 강등하거나, 분석 완료 후 교체.
3. 프론트 `api.ts`에 `/api/media/:id/analysis` 소비 함수 추가 → `/episodes/[id]` 분석 탭·추천 보드가 실제 AI 결과 표시.
4. **`adopt`를 무렌더 구간-결정으로 재정의(§2.4).** 채택은 (B) 구간·결정을 확정하는 **메타 연산**으로 바꾸고(현재는 채택 즉시 ffmpeg 렌더 = 불변식 위반), 실제 트림·인코딩은 **최종 확정/익스포트 시 1회**로 이연. 프리뷰는 원본 스트림 Range로.

**🎯 다음 착수점 #2 — 배포 실동작 (J, AP4):** `POST /api/distributions/publish` 스텁 → YouTube Data API v3 resumable 실업로드로 교체(OAuth·publish 스코프는 이미 정의됨, 업로드 코드만 없음). Meta 앱 심사 조기 신청.

**🎯 다음 착수점 #3 — transcript 단일 원천 확립 (B, AP2):** STT 스택 확정(§12) → `transcript` 테이블(단어/문장 PTS) 신설 → C/D/H/I가 전부 이 테이블만 읽게. Gemini STT는 word-level이 없으므로 word 필요 로직은 whisper 경로 or Clova 확정 필요.

**부차 갭:** 프레임 GCS 호스팅(현 temp 폐기) / admin Lab을 로컬 파일→DB(`/api/media/:id/analysis`) 전환 / 죽은 코드(`db.ts`·`storage.ts`) 제거 / core `README`·`bridge.ts`·`WHISPERX_GUIDE` stale 갱신.

---

## 12. 미결정 & 리스크

| # | 항목 | 내용 | 대응 |
|---|------|------|------|
| R1 | **STT 스택 3갈래** | 현 core=Gemini 오디오(word 없음) / 계획=Clova(word+화자분리) / whisper=word-level. **미확정** | PoC A 실측 → 어댑터로 감싸 교체. word-level·화자분리 필요(D스냅·CX발화귀속)면 Clova/whisper 필수 |
| R2 | **큐 라이브러리** | 계획=pg-boss(MIT), 실제=자체 `job_queue`(SKIP LOCKED)가 이미 프로덕션 | **자체 큐 유지 권장**(이미 동작·신뢰성 확보). pg-boss 재도입 실익 재검토 |
| R3 | **Vertex 쿼터 천장** | 90분 회차 1000+ Gemini 호출, 동시 회차 시 서울 리전 쿼터 초과 | 전역 레이트리미터·배치 API·쿼터 상향(§8.3) |
| R4 | **CX 인물 태깅 정확도** | 90%+ 미달 시 CX-2 장면 요약 연쇄 붕괴 | PoC B 게이트(CX1 착수 전 필수) |
| R5 | **리전 강제 부재** | 서울 리전이 env 기본값일 뿐 하드 강제 아님. `VERTEX_LOCATION` 바꾸면 국외 이전 가능 | **화이트리스트 검증 코드 추가**(PIPA 근거 보장) |
| R6 | **Meta 앱 심사 리드타임** | 수 주 | AP4 이전 조기 신청 |
| R7 | **SMR 전달 방식 불명** | 표준 공개 API 없음(네이버 pull XML 피드 + 조용한 검증 게이트) | 계약사 채널로 조기 확인, 어댑터 인터페이스만 선설계 |
| R8 | **ffmpeg 필터그래프 복잡도** | 블러 배경+자막+오버레이 화질·속도 | AP3 초기 프로토타입 검증 |
| R9 | **Cloud Run IAM 모순** | cloudbuild `--allow-unauthenticated` vs 문서 "IAM 비공개" | 실제 IAM 정책 확인(조직 정책이 무효화 중일 가능성) |
| R10 | **얼굴 임베딩 라이선스** | InsightFace 등 가중치 비상업 함정 | 도입 시점 재조사, 상업 가능 가중치 or 관리형(Rekognition) |
| R11 | **배포 자동화 부재** | Cloud Run 푸시 자동배포 안 됨 → 옛 코드 계속 실행 위험 | 배포 스크립트 필수화·카나리아(`media.durationSec`) |
| R12 | **편집기 업스트림 표류** | OpenCut main = Vite/Rust 재작성, classic은 아카이브(픽스 없음) | `opencut-classic` 아카이브 커밋 고정·부품 격리(vendor)·우리가 소유 관리 |

---

## 13. 컴플라이언스 & 특허

- **데이터 레지던시:** 오디오·프레임(얼굴)·전사 = 개인정보/민감정보 → Vertex 서울 리전 처리. **R5(화이트리스트 검증) 보완 필요.** 프레임은 로컬 temp에만, DB엔 메타/점수/텍스트만 저장.
- **초상권:** 얼굴 인식 = 방송사 계약에 출연자 초상 데이터 처리 근거 명시.
- **타사 영상:** 트렌드 역분석은 **내부 분석 목적만**(재업로드·재가공 금지). 사운드 자동 삽입 안 함(저작권).
- **보안:** `.env*`·`gcp-keys/` 커밋 금지(2026-07-14 개인키 유출 사고 이력) → `.gitattributes`·pre-commit 훅 절차화, `.example` 템플릿만.
- **특허 확장 청구 후보(변리사 검토):** ①폐쇄 후보군 인물 확정 식별 + 화자분리 교차 발화 귀속(얼굴+이름자막OCR+의상+화자 다중신호 투표) ②인물 KB 회차 간 누적·선정 계수 환류 폐루프 ③댓글 기대 포인트 × 미방영 장면 매칭 부스트 ④채널 적합 계수 (후보×채널) 매트릭스(LLM 호출 증가 없는 채널별 랭킹).

---

## 부록 A — 정독한 문서 목록 (30편)

- **루트/제품:** `CLAUDE.md`, `README.md`, `admin/README.md`, `docs/STEPD-방향기획서.docx/pdf`(마스터), `apps/docs/{product-vision,architecture,feature-status,competitor-analysis,dev-guide}.md`
- **파이프라인/AI:** `docs/{pipeline-plan,pipeline-current,content-pipeline-prod,context-engine-plan,worker-queue,object-detection-research,opencut-integration-plan}.md`, `core/{README,WHISPERX_GUIDE}.md`
- **UX/배포필드:** `docs/{step-d-ux-plan,publish-fields-ux-plan,integration-map,backend-notes,glossary}.md`
- **인프라:** `docs/{infra,deploy,local-dev,vercel-ops,youtube-channel-analytics-guide}.md`, `deploy/{INFRA,runbook}.md`(폐기)
- **설정:** `cloudbuild.yaml`, `pnpm-workspace.yaml`, `docker-compose*.yml`(폐기), `Caddyfile`(폐기), `deploy.ps1`/`dev.ps1`

## 부록 B — 핵심 파일 지도

| 역할 | 경로 |
|------|------|
| 서버 진입점(라우트) | `apps/server/src/index.ts` |
| 휴리스틱 추천(교체 대상) | `apps/server/src/pipeline.ts` |
| core 호출부 | `apps/server/src/content-pipeline.ts` |
| 큐·워커·채널 | `apps/server/src/{queue,worker,channel-pipeline}.ts` |
| DB(정본) | `apps/server/src/db-pg.ts` · `apps/server/schema.sql` |
| AI 오케스트레이터(정본) | `core/analyze.py` (+asr/refine/scenes/vision/names/recommend) |
| 죽은 코드(제거 대상) | `apps/server/src/{db,storage}.ts`, `core/{bridge.ts,pipeline.py,README.md}`(stale) |
| 프론트 데이터층 | `apps/web/src/lib/data/{store.tsx,api.ts,repository.ts,mock.ts}` |
| 편집기 골격 | `apps/web/src/components/editor/`, `docs/editor-prototype.html` |
| 배포 스크립트(정본) | `deploy/{deploy-server,deploy-web}.ps1`, `deploy/{worker-vm,worker-pipeline-setup}.sh` |
| 인프라 정본 | `docs/infra.md` |
