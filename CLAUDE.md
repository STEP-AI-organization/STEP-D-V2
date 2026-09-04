# STEP-D — Claude 컨텍스트

> 2026-08-08 실측 기준 갱신. 이 리포는 구 STEPD(Python FastAPI + VM)가 아니다.
> 구 코드(`apps/api/` · `apps/docs/`)는 **2026-08-12 삭제됐다.** 작업은 `apps/web` + `apps/server` + `core/` 에서 한다.

## 제품 개요

운영자(방송사·MCN) 중심의 클립/쇼츠 스튜디오. 긴 영상을 올리면 **AI 파이프라인이 추천 구간을
생성**하고, 운영자가 채택하면 트림·인코딩된 클립이 되어 편집 → 멀티채널 배포 → 성과 추적으로 이어진다.

```
업로드(GCS resumable) → content.analyze 잡 큐잉 → [Cloud Run Job] python -m core.analyze
  STT(Soniox+화자분리) → shot boundary → scene_type → [GEBD GPU VM] 장면경계 → beat 생성(최소 6초)
    → beat annotate(Vision·맥락누적) → 쇼츠 추천(beat-only) → 검색 세그먼트 인덱싱(pgvector)
  · 단계별 체크포인트 — 실패/재시도 시 완료된 단계부터 재개 · @@PROGRESS로 UI에 단계별 진행률
    → content_analysis + search_segments 저장 (산출물 GCS analysis/{mediaId}/ 영구 보존)
      → [사람] 채택/거절 → ffmpeg 트림·인코딩 → 클립 → 편집 → 배포(YouTube/Meta/SMR) → 성과
```
**실측(2026-08-08 · 58.6분 회차):** 964초 · 자막 925 / 장면 12 / beat 245 / 쇼츠 20 /
검색 세그먼트 204. 장르·캐스트는 **사람이 미리 지정**해야 정확하다(미지정 시 자동판정 폴백).
**원가(2026-08-19 갱신)**: 프로덕션 현재 구성 60분 회차 ≈ **₩800(분당 ₩13.3)** → 판매가
**₩60/분(2026-08-25 인하 · 28→150→60)** 대비 **마진 ~78%**. 2026-08-19 beat_annot(장면이해 본체)를 **gemini-2.5-flash-lite** 로 전환해
(−72% 실측 · env `GEMINI_BEAT_ANNOT_MODEL=gemini-2.5-flash-lite`·`VERTEX_LOCATION=global`) 원가가
₩1,124→₩800 으로 내렸다(전엔 마진 31%). 화면 자막 읽기(`RUN_CHYRON_PER_SEG`)는 여전히 **OFF**
(env `=0`) — 화자 실명·인물 검색축이 없다. 켜도 flash-lite 면 흑자(₩60/분 기준 마진 ~66% · 원가 +₩440).
⚠️ 리포 곳곳에 돌던 ₩285·₩994·₩1,510 은 **전부 틀린 값**이다. 네 번 다 같은 뿌리 —
**안 돈 스테이지를 0 으로 셌거나, 프로덕션이 그걸 켰다고 짐작했다.** 원가를 인용하기 전에
① 그 로그가 전체 실행인지(체크포인트 재개 아닌지) ② 꺼진 스테이지가 없는지 ③ **프로덕션 잡
env 를 실제로 조회했는지**(`gcloud run jobs describe stepd-worker-content --region us-central1`).
정본은 [docs/ops/how-it-works.md](docs/ops/how-it-works.md) §4 하나뿐 — 인용은 거기서만 할 것.

**2026-09-03 부터 추측할 필요가 없다.** core 가 회차마다 `usage.json`(토큰·받아쓰기 시간 실측 ·
**재시도분 누적**)을 남기고 서버가 그걸 `usage_events.cost_krw` 에 넣는다(`cost_source='measured'`).
지금 단가는 `GET /api/superadmin/usage` → `totals.costPer60minKrw` 로 조회한다. 상수
(`COST_KRW_PER_MINUTE`)는 파일을 못 읽었을 때의 폴백일 뿐이다 — 그 상수가 한 세대 낡아
(19 = flash-lite 전환 전 값) 원장이 원가를 **43% 부풀리고 있던 걸** 2026-09-03 에 잡았다.
**인프라 뺀 벤더 원가는 60분 ≈₩668(분당 ₩11.1)** · 인프라 포함 ₩800. 배선: §4 "이 숫자를 계속 재는 법".

문서 진입점: [docs/README.md](docs/README.md) · 종합 계획: [docs/plans/active/step-d-master-build-plan.md](docs/plans/active/step-d-master-build-plan.md)

---

## 모노레포 구조 (pnpm workspace, Node ≥22)

```
apps/web/      Next.js 16 (App Router) + React 19 + Tailwind v4 + base-ui  → Vercel (stepd.stepai.kr)
apps/server/   Hono + PostgreSQL(Cloud SQL) + GCS + ffmpeg                 → Cloud Run (stepd-server)
               + src/worker.ts = 별도 워커 프로세스 → Cloud Run Jobs (stepd-worker-content
                 / stepd-worker-youtube, drain 모드) + GEBD 전용 GPU L4 spot VM
native/        Electron Windows 데스크탑 셸. 프로덕션 웹을 표시하고 영상 파일을 GCS로
               직접 전송하는 영속 업로드 큐·트레이·stepd:// 프로토콜을 제공
core/          Python AI 파이프라인. **워커가 아니다** — 워커(worker.ts)가 자식 프로세스로
               띄운다. 2026-08-12 단계별 하위 패키지로 재편: stt·scenes·beats·recommend·
               search·vision·thumbnail·evaluate·common. 상세 [core/README.md](core/README.md)
admin/         STEP D Admin — 플랫폼 관리 콘솔 (Vite+React SPA). 회사·사용자·잡·감사
               → Vercel 독립 배포 · admin.stepd.stepai.kr · superadmin 세션 필수
               (구 STEP D Lab 은 2026-08-10 제거 — /api/lab/* 라우트도 함께 삭제)
deploy/        cloud.sh(표준 배포: status|server|worker|gebd|migrate|all) · deploy-web.ps1(Vercel)
               · gebd/(Dockerfile.slim · vm-startup.sh · run_long_v3.sh) · worker-vm.sh
docs/          ops(현황·운영) / plans(계획) / reference / research / prototypes / archive
```

---

## 백엔드 — apps/server

Hono 단일 진입점(index.ts, **~12,300줄, 라우트 275개**) + 별도 워커 프로세스 구조.
(2026-08-25 실측 갱신)

| 파일 | 역할 |
|------|------|
| `src/index.ts` | 모든 HTTP 라우트. 여기 한 파일에 유지. **Cloud Run은 잡을 큐잉만 한다.** |
| `src/worker.ts` | **워커 프로세스 진입점.** 잡 28종 · 레인 7개 · drain 모드 (아래 참조) |
| `src/pipeline/queue.ts` | Postgres job_queue (FOR UPDATE SKIP LOCKED · dedupeKey · 지수 백오프 · 5분 하트비트) |
| `src/pipeline/channel-pipeline.ts` | channel.analyze — 업로드 동기화 + 채널 애널리틱스/일별 수익 백필 |
| `src/pipeline/content-pipeline.ts` | content.analyze — `python -m core.analyze` 스폰, 진행률 파싱(@@PROGRESS→episode.pipeline), 결과+프레임 영구 저장, 추천 배선. 미디어별 고정 작업 디렉토리로 재시도 시 체크포인트 재개 |
| `src/db-pg.ts` | PostgreSQL 전부. 엔티티=JSONB(`entities`) + 미디어/YouTube 정규 테이블 |
| `src/youtube.ts` | YouTube Data/Analytics API, 토큰 리프레시(invalid_grant→revoked), 쇼츠 분류 |
| `src/media/storage-gcs.ts` | GCS 어댑터 + resumable 업로드 세션 (GCS_BUCKET 없으면 로컬 폴백) |
| `src/media/ffmpeg.ts` | `hasFfmpeg` / `probe` / `captureThumbnail` / `trimEncode` |
| `src/ai/search-embed.ts` | 검색 **쿼리** 임베딩 (Vertex `text-multilingual-embedding-002` · 768d). 실패 시 null → 키워드축 폴백 |
| `src/ai/search-parse.ts` | 자연어 질의 → 구조화 필터 (인물·장면·기간) |
| `src/publish/upload-gate.ts` | **YouTube 실업로드 게이트** — 기본 OFF. 오타·빈값·미설정은 전부 OFF |
| `src/ai/gemini.ts` · `ai/cast.ts` · `ai/profile.ts` · `media/thumbnail-assets.ts` | Gemini 호출 · 캐스트 · 프로그램 프로필 · 썸네일 레퍼런스 |
| `src/seed.ts` | **의도적으로 전부 빈 배열** — 프로덕션은 데모 콘텐츠 없이 시작 |
| `src/chatbot/` | **업무 도우미 챗봇** (2026-09-03) — 제품 사용법 안내 + 워크스페이스 **읽기**. 지식은 `docs/help/*.md` 뿐이고, 링크는 `catalog.ts` 화이트리스트를 통과한 것만 나간다. 실행 기능 없음 |
| `src/pipeline/harvest.ts` · `harvest-cycle.ts` | **완전자동화** (2026-09-04) — 수집 유튜브 채널과 배포 채널을 지정하면 롱폼을 받아 회차로 만든다(프로그램·자동배포 계획도 등록할 때 같이 만들어진다). 그 뒤는 기존 분석·자동배포 계획이 그대로 완주한다. **새벽 2시 하루 한 번**(`channel.harvest`) + 화면의 "지금 가져오기"(`POST /api/harvest/run`) · **수집원당 하루 1편이 실질 상한**(순회가 하루 한 번) · **배포 계획이 없거나 멈췄으면 내려받기조차 안 한다** · 배포 재고가 2일치면 안 가져온다 · 연결 안 된 채널은 운영자 승인 필요 |
| `src/report/` | **보고 리포트 생성** (2026-09-03) — 자연어 → 스펙(모델) → 집계(SQL) → 서술(모델) → md/HTML. **숫자는 집계만 낳는다**(narrate.ts 가 지어낸 수를 잡아 서술을 버린다) |
| `src/<도메인>/` | **2026-09-01 정리** — 74개가 평평하던 것을 묶었다: `ai` `auth` `billing` `chatbot` `commerce` `media` `naver` `pipeline` `publish` `report` `social` `tests`. 최상위엔 진입점(index·worker)과 공용(db-pg·config·ids·kst·mailer·seed·youtube)만 남는다 |
| `schema.sql` | 테이블 정의 — 단 **job_queue·content_analysis·channel_analytics·search_segments·meta_accounts·tiktok_accounts는 여기 없고 코드가 런타임 생성** (queue.ts·db-pg.ts). 상세: [docs/reference/data-model.md](docs/reference/data-model.md) |

`src/ids.ts`(구 pipeline.ts)는 `newId` 헬퍼만 export한다(구 sqlite `db.ts`·`storage.ts`, 휴리스틱 `buildRecommendations()`는 정리 완료). 실제 추천은 core/ AI 파이프라인이 만든다.

### 워커 — 잡 28종 · 레인 7개 · drain 모드

프로세스 하나가 다 처리하지 않는다. `WORKER_JOBS` 로 **레인을 갈라** 서로 굶기지 않게 한다.

```
content : media.prepare · media.transcode · content.analyze · match.align · match.segment · match.learn
          · thumbnail.style · thumbnail.generate · clip.metadata · clip.reframe · reframe.compare
          → 파이썬·ffmpeg·이미지생성 무거운 잡. Cloud Run Job `stepd-worker-content`
youtube : channel.analyze · video.analyze · video.hotwatch · video.comments · distribution.publish
          · youtube.reconcile(예약 게시 확인 — 예약분이 실제로 공개됐는지 되읽어 상태 갱신)
          → 짧고 API 쿼터 위주. Cloud Run Job `stepd-worker-youtube`
gebd    : gebd.detect
          → GPU L4 spot VM 전용. GPU 없는 데서 claim 하면 Docker mmaction2 를 못 돌린다
naver   : naver.publish · naver.login
          → 사무실 상시 PC 전용. 네이버는 공개 업로드 API 가 없어 Playwright 자동화인데,
            해외 데이터센터 IP 로 로그인하면 캡차·2차인증에 막힌다 → 한국 IP 필요
download: youtube.download
          → 윈도우2(naver 와 같은 PC) 전용 — 2026-08-14 이동. 유튜브가 데이터센터 IP 를
            봇으로 판정해(쿠키 물려도) 다운로드 상시 실패 → 한국 IP 가 받아 GCS 로 올리고
            분석은 클라우드 content 레인이 잇는다. 런처 worker:naver 가 naver,download 고정
commerce: commerce.link
          → **윈도우2**(naver·download 와 같은 PC · 런처가 naver,download,commerce 고정).
            파트너스 공개 API 는 최종승인(누적 판매 15만원) 후에야 나와서, 그 전까지는
            콘솔 내부 API 를 브라우저 컨텍스트에서 부른다. 이 PC 여야 하는 이유 둘 —
            ① 한국 IP(콘솔이 Akamai) ② **화면 있는 크롬**: headless 는 세션이 유효해도
            차단된다(실측 2026-08-27). 그래서 Cloud Run 에 못 올린다.
            **회사마다 계정이 다르다**(커미션 정산이 계정 단위) → 잡마다 그 테넌트의 세션을
            주입해 쓴다(commerce_account · 상시 크롬 N개 불필요).
            승인 후 공식 딥링크 API 로 바뀌면 이 레인은 없어지고 클라우드로 간다.
render  : clip.render
          → CPU 를 통째로 쓰는 잡. 노는 사무실 PC(윈도우2)가 당겨간다 — 건당 50~90초.
⚠️ **사무실 PC 가 공짜인 건 CPU 뿐이다.** GCS 에서 원본을 받아 오는 잡을 거기로 보내면
   인터넷 egress(≈₩165/GB)가 새로 생긴다 — 같은 리전 Cloud Run 은 그게 0원이다.
   실측 계산(2026-09-01 · 270MB 원본): WIN2 ₩45 vs Cloud Run ₩14. 그래서 media.transcode 는
   content 레인(클라우드)에 둔다. **바이트를 옮기는 잡은 클라우드, CPU 만 쓰는 잡은 사무실 PC.**
⚠️ 2026-08-12 이전에는 thumbnail.* 가 **어느 레인에도 없어** 프로덕션(content·youtube 워커만
   뜬다)에서 아무도 집지 않았다. 잡을 추가하면 반드시 레인에 넣을 것 —
   `worker-lanes.test.ts` 가 강제한다.
```

⚠️ **`all` 워커는 머신 전용 레인(gebd·naver·download)을 집지 않는다**(`ALL_LANE_TYPES`). 예전엔
집어가서 `unknown job type`·GPU 없음으로 실패시키고 재시도만 쌓았다 — 증상이 "잡은 조용히
실패하는데 정작 전용 워커는 큐가 비어 보임" 이라 원인을 찾기 어렵다. 잡이 안 잡히면
**다른 워커 프로세스가 떠 있는지부터 확인할 것.**

**drain 모드(`WORKER_MODE=drain`)가 비용 구조의 핵심.** 상시 5초 폴링 대신 Cloud Scheduler 가
Job 을 깨우고 → **큐가 비면 종료** → idle 과금 0. `DRAIN_MAX_MS`(기본 50분)를 넘기면 새 잡을
claim 하지 않고 진행 중인 것만 마친다(Job 타임아웃 중간 사망 회피).

> ⚠️ **drain 모드에는 이벤트 루프 앵커가 필수다.** content-pipeline 은 python 자식과
> stdout/stderr 파이프를 전부 `unref()` 한다(Windows 크래시 전파 차단). drain 은 폴링
> setInterval 도 없어서, 앵커가 없으면 DB 무활동 구간(STT 등)에 루프가 비어 **Node 가
> `exit(0)` 으로 조용히 죽는다** — Cloud Run 은 '성공' 으로 기록하고 잡은 running 인 채 남는다.
> (실측 2026-08-08: 58분 회차가 매번 컨테이너 시작 44초 만에 종료.) `worker.ts` `loop()` 의
> `keepAlive` 를 절대 unref 하지 말 것.

**⚠️ YouTube 실업로드는 구현 완료 · 기본 OFF.** `upload-gate.ts` 3중 방어 —
`YOUTUBE_UPLOAD_ENABLED` 가 명시적 truthy 일 때만 ON, 라우트 409 · 워커 차단 · 업로드 직전
`assertUploadEnabled()`. 잘못된 env 의 실패 모드가 "업로드 안 됨"이지 "실수로 업로드됨"이
아니게 방향을 잡아뒀다. **TikTok 은 같은 패턴의 `TIKTOK_UPLOAD_ENABLED` 게이트로 받은함
드래프트 실업로드(기본 OFF=기록만). Meta·SMR 송출은 여전히 상태 기록만(스텁).**

### 검색 — 제품의 목적물

회차당 200여 개 세그먼트를 `search_segments` 에 적재한다. **컬럼이 곧 질의축이다:**
`start/end/duration · characters · speakers · scene_type · hook · highlight_score · is_short ·
rights · dialogue · chyron · summary · emb_dialogue vector(768) · emb_summary vector(768)`

**비대칭 하이브리드** — 인덱싱은 `core/index_segments.py`(RETRIEVAL_DOCUMENT), 쿼리는
`search-embed.ts`(RETRIEVAL_QUERY). Vertex 실패 시 **키워드축(pg_trgm) 단독 폴백** — 한국어는
키워드 매칭이 강해서 벡터 없이도 검색이 성립한다.

**주요 라우트** — 총 275개 (전체: [docs/reference/api-reference.md](docs/reference/api-reference.md))
```
GET  /health · /api/state · /api/search        # 검색 = 하이브리드(벡터+키워드)
POST /api/media/upload-init → finalize   # 브라우저→GCS 직접 resumable 업로드 (대용량 표준 경로)
POST /api/media/upload · /api/media/from-youtube
GET  /api/media/:id/stream · /thumb · /frame · /analysis · /transcript
POST /api/media/:id/analyze              # → content.analyze 큐잉
GET/POST /api/programs/:id/cast          # 캐스트 사전등록 (인물 라벨링의 primary)
POST /api/programs/:id/autofill · /profile/generate · /thumbnail-style
GET  /api/programs/:id/thumbnail-style(/thumbs/:name)   # 스타일 프로파일 + 수집 썸네일
                                         # (구 /api/thumbnail-refs/* 레퍼런스 풀은 2026-08-13 삭제)
POST /api/recommendations/:id/adopt · /reject
GET/PATCH /api/clips/:id/commerce        # 커머스 상품·링크 검토 — **승인한 것만** 발행 설명란에
POST /api/clips/:id/commerce/issue       #   붙는다(pending 기본). issue 는 재발급·상품 교체
GET  /api/commerce/review                #   워크스페이스 검토 대기 목록 (웹 /commerce 화면)
GET/POST /api/clips/:id/reframe          # AI Beat별 Fit/Fill 분석 상태 조회·큐잉
POST /api/clips/:id/export · /generate-metadata(채널별 메타) · /regenerate-titles
POST /api/distributions/publish · /retry # YouTube 실업로드(게이트 OFF) · Meta/SMR 은 상태 기록만
GET/POST /api/youtube/*                  # auth(mode=analytics|publish) · callback · channels ·
                                         # analytics/:id(/daily) · sync · videos · trends · comments
GET  /api/meta/auth · /api/tiktok/auth   # Meta·TikTok OAuth + 계정 연결
GET  /api/queue/stats · /api/admin/jobs · /api/admin/media-analysis
POST /api/admin/reset · /queue/purge · /gebd-vm/wake · /worker-vm/wake
GET  /api/instagram/auth                 # Instagram 비즈니스 로그인 (FB Page 경유 아님 · 2026-08-13 분리)
POST /api/chatbot/message                # 업무 도우미 — 대화(스레드 유지) · 세션 필수
GET/DELETE /api/chatbot/threads(/:id)    #   내 대화만 보인다(같은 회사 동료 것도 안 보임)
POST /api/reports                        # 보고 리포트 초안 — 자연어 요청 → md
GET  /api/reports(/:id)(/export)         #   export 는 **검산 통과분만** 나간다(409로 막는다)
POST /api/reports/:id/email              #   SMTP 설정 있을 때만
```

**환경변수** (실제 코드가 읽는 것)
```
DATABASE_URL          Cloud SQL 접속 (없으면 DB 초기화 실패)
GCS_BUCKET            운영 미디어 버킷 / STEPD_STORAGE_DIR  로컬 모드 저장 경로
GCS_UPLOAD_BUCKET     stepd-upload-seoul (asia-northeast3). 비우면 GCS_BUCKET 폴백
GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / PUBLIC_URL       YouTube OAuth
PORT                  Cloud Run 주입(8080). cloudbuild에서 직접 설정 금지 — 예약 변수
CORE_DIR / CORE_PYTHON                    core/ 파이프라인 위치·파이썬 (워커)
REFRAME_FACE_MODEL / REFRAME_PIPELINE_VERSION   AI 리프레임 모델 경로·플랜 캐시 버전 (워커)
STT_PROVIDER          프로덕션 soniox (SONIOX_API_KEY 필요) · gemini · whisper(로컬 GPU)
GOOGLE_CLOUD_PROJECT(기본 step-d) / VERTEX_LOCATION(기본 asia-northeast3)   Vertex Gemini
EMBED_MODEL / EMBED_DIM                   검색 임베딩 (기본 text-multilingual-embedding-002 · 768)
GEMINI_SUPPORT_MODEL / GEMINI_SUPPORT_LOCATION
                      챗봇·리포트 모델 (기본 gemini-2.5-flash-lite · global). **둘은 세트다** —
                      asia-northeast3 에서 flash-lite 는 404 라 리전을 안 바꾸면 죽는다(ai/models.ts)
WORKER_JOBS           content | youtube | gebd | naver,download | commerce | all(기본)  ← 레인 선택
WORKER_MODE           drain 이면 큐 비는 즉시 종료 / DRAIN_MAX_MS(기본 50분)
YOUTUBE_UPLOAD_ENABLED   실업로드 게이트. 미설정·오타·빈값 = OFF
TIKTOK_UPLOAD_ENABLED    TikTok 받은함 드래프트 업로드 게이트. 기본 OFF · 오타=OFF
COMMERCE_LINKS_ENABLED   쿠팡 제휴 링크 게이트 (파이프라인 정본: docs/ops/commerce-links.md).
                      기본 OFF · 오타=OFF. 켜면 ① generate-metadata 가
                      상품 쿼리를 같이 뽑고(추가 원가 ₩0 · 같은 호출) ② commerce.link 잡이
                      링크를 발급하고 ③ **사람이 /commerce 에서 승인한 것만** YouTube
                      설명란에 링크+대가성 문구로 붙는다(발급≠게시 · 미승인은 안 나간다).
                      ⚠️ 켤 때 commerce 레인 워커도 같이 띄울 것 — 안 그러면 잡이 조용히 쌓인다
COMMERCE_SESSION_KEY  커머스 세션 봉인 키 (base64 32바이트 · 없으면 세션 저장 자체를 거부).
                      **고객사 법인 계정의 전체 권한**이 담기므로 평문 폴백은 없다.
                      회사별 계정 등록: `pnpm --filter @stepd/server commerce:login`
COUPANG_CDP_URL       (개발용) 미리 로그인해 둔 파트너스 크롬의 CDP 주소 · 기본 127.0.0.1:9223
COMMERCE_DEV_CDP      (개발용) 1 이면 계정 행이 없어도 위 CDP 크롬 계정으로 발급한다.
                      ⚠️ 프로덕션 금지 — 수익이 그 계정으로 귀속된다
GEBD_IMAGE / GEBD_MODEL / GEBD_ASSETS / GEBD_CHUNK_SEC(300) / GEBD_CORES(1)   GPU VM
GEBD_VM_NAME / GEBD_VM_ZONE · WORKER_VM_NAME / WORKER_VM_ZONE   /admin/*-vm/wake 대상
META_APP_ID / META_APP_SECRET / META_REDIRECT_URI                Meta OAuth (Facebook Page 전용)
INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET / INSTAGRAM_REDIRECT_URI Instagram 비즈니스 로그인
                      (콘솔 "Instagram API" 제품의 Instagram 앱 ID/시크릿 — Meta 앱 ID와 다름)
TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET / TIKTOK_REDIRECT_URI   TikTok OAuth
AUTO_GEBD / AUTO_THUMBNAIL                분석 완료 후 후속 잡 자동 큐잉 스위치
SMTP_HOST / SMTP_PORT(587) / SMTP_USER / SMTP_PASS / INVOICE_MAIL_FROM
                      결제 완료 인보이스 메일 + 자동배포 완료 알림 (미설정 = 조용히 건너뜀 · mailer.ts)
SMTP_OAUTH_CLIENT_ID / _SECRET / _REFRESH_TOKEN
                      SMTP_PASS 대신 Gmail XOAUTH2 (스코프 mail.google.com 필수 · 호스트 생략 시
                      smtp.gmail.com:465). 자동배포 알림은 워커(stepd-worker-youtube)가 보낸다
INVOICE_ISSUER_NAME / _BIZNO / _CEO / _ADDRESS / _CONTACT   인보이스·거래명세서 발행자 표기
                      (비면 항목 생략 — 지어내지 않음. 어드민 월별 명세와 같은 namespace)
GEMINI_BATCH              1 이면 chyron 을 Vertex 배치 예측으로 — 단가 50%. **기본 OFF 로 둘 것**:
                          실측 한 회차 5시간 45분(동기 4분) · 지금 구현은 폴링이라 상한에서
                          취소→동기 폴백 = 느리면서 제값. 오타·빈값·버킷없음도 전부 OFF.
GEMINI_BATCH_BUCKET       배치 입출력 GCS 버킷 (없으면 GCS_BUCKET 사용)
GEMINI_BATCH_TIMEOUT_SEC  기본 1500. 넘기면 동기 폴백 — 워커 DRAIN_MAX_MS(50분) 안에 끝나야 한다
```
core/ 쪽 스위치(파이썬): `RUN_FACES`·`RUN_PPL`·`RUN_REFINE`·`RUN_CHYRON_PER_SEG`·`MIN_BEAT_SEC`·
`BEAT_ANNOT_WORKERS`·`BEAT_ANNOT_CTX_RECENT`·`GEMINI_*_MODEL`(단계별 모델 오버라이드).
**faces·PPL 은 기본 off** — 되살릴 때만 켠다(코드 삭제 금지).

**ffmpeg은 로컬 파일만 읽는다.** GCS 모드에선 `/tmp`로 먼저 내려받아야 하고, Cloud Run의 `/tmp`는
**RAM(tmpfs)** 이므로 작업 후 반드시 지울 것 — 안 지우면 업로드마다 메모리가 쌓여 OOM 난다.

---

## 프론트 — apps/web

상세: [apps/web/CLAUDE.md](apps/web/CLAUDE.md). 요점만:

- 화면: **총 35개** — `(app)` **27개** + `(editor)` 풀스크린 에디터 + 공개 7개(landing·login·
  register·invite·terms·privacy·data-deletion). 목록 정본은
  [docs/plans/active/frontend-redesign-handoff.md](docs/plans/active/frontend-redesign-handoff.md) §6.
  ⚠️ 여기 오래 "9개(…recommendations, channels…)" 로 적혀 있었는데 **셋 다 틀렸다** —
  개수도, 없어진 화면 이름도. 개편 범위를 3분의 1로 잡게 만드는 종류의 오류라 실물로 바꿨다.
- **프론트 재개편 진행 중**(디자이너 산출물 이식) — 규격·이식 절차·건드리면 안 되는 글루는
  위 문서 하나로 본다. 리포 분리는 **검토 후 안 하기로 했다**(같은 문서 §7).
- **데이터 레이어:** `store.tsx`는 빈 상태(EMPTY_STATE)로 시작해 기동 시 `fetchState()`가 성공하면
  서버 상태로 교체한다. 실패하면 **빈 상태를 유지한다 (목 폴백은 제거됨)** — 빈 화면이면
  "서버 미연결"인지 "데이터 없음"인지 `/api/state` 응답으로 구분할 것.
- 실 서버 연동은 `lib/data/api.ts`(REST)가 담당한다. `repository.ts`의 `apiRepository`는
  폐기된 SPFN 통합 스텁(미호출)이다.
- 환경변수는 `NEXT_PUBLIC_API_URL` 하나. 경로 별칭 `@/*` → `./src/*`.

---

## 배포

상세 런북: [docs/ops/deploy.md](docs/ops/deploy.md) · 인프라 SSOT: [docs/ops/infra.md](docs/ops/infra.md)

- **표준 경로 — `bash deploy/cloud.sh <target>`** (`status`|`server`|`worker`|`gebd`|`migrate`|`all`).
  비대화형 Bash + deployer SA 로 돌아서 PowerShell stderr 오탐·재인증 함정을 피한다.
  `/deploy` 스킬(`.claude/skills/deploy/`)이 같은 스크립트를 감싼다.
- **웹**: `.\deploy\deploy-web.ps1` — Vercel. **커밋 author가 contact@stepai.kr이어야 배포됨**
  (Vercel git-author 차단, 스크립트가 강제). 프로덕션 = https://stepd.stepai.kr
- **어드민**: `cd admin && npx vercel deploy --prod --scope step-ai` — **git 자동배포가 아니다.**
  푸시해도 안 나가므로 손으로 올려야 한다(2026-09-03: 그래서 21일치가 밀려 있었다).
  ⚠️ Vercel 에 **이름이 비슷한 프로젝트가 둘** 있다:
  `stepd-admin`(구 `stepd-lab` · 2026-09-03 개명)이 **진짜**로 admin.stepd.stepai.kr 을 서비스하고,
  `step-d-admin`(admin.stepd.co.kr · 114일째 방치)은 **버려진 것**이다. 링크는
  `admin/.vercel`(gitignore)이 projectId 로 들고 있으니 그냥 위 명령을 쓸 것.
- 구 경로(`deploy-server.ps1`·`deploy-worker.ps1`·`ecosystem.config.cjs`·docker-compose·Caddyfile)는
  **2026-08-12 삭제됐다.** 워커 VM 상시 운영(pm2/systemd) 전제라 현재 배치(Cloud Run Jobs +
  윈도우2 작업 스케줄러)와 맞지 않았고, 남겨두면 처음 보는 사람이 그걸 따라간다.

---

## 용어 — 사용자에게 보이는 글에서 "테넌트"라고 쓰지 않는다

같은 실체(`tenants` 행 하나)를 **보는 자리에 따라 다르게 부른다.** 개발자 말이 화면에
그대로 나가면 운영자도 고객사도 그게 뭔지 모른다.

| 자리 | 쓰는 말 | 왜 |
|------|---------|-----|
| 어드민 콘솔 (`admin/`) | **회사** | STEPAI 운영자가 여러 고객사를 관리하는 자리 |
| 제품 화면 (`apps/web`) · 오류 메시지 | **워크스페이스** | 사용자는 자기 것 **안에** 있다 |
| 코드 식별자 · DB · 기술 주석 | `tenantId` · `tenants` · "테넌트 RLS" | 그대로 둔다 — 리네임은 위험만 크고 얻는 게 없다 |

같은 원칙 하나 더 (2026-08-25): 자동배포의 `rule`(automation_rule)은 화면·문구에서
**"자동배포 계획"(짧게 "계획")** 이라 부른다 — "규칙"은 채널 규칙(channel_rule ·
길이/화면비 제약)과 헷갈린다. 코드 식별자·DB·API 필드는 rule 그대로.

어드민은 **STEPAI 운영자 전용**이다(superadmin 세션 필수). 고객사는 여기 안 들어온다 —
고객사 사람은 `stepd.stepai.kr`, 고객사 **시스템**은 API 키로 붙는다.

## 작업 규칙

- **배포는 명시적 요청 시에만.** "ㄱㄱ", "배포해줘" 없이 git push·Cloud Build 실행 금지.
- **`.env*`, `gcp-keys/` 절대 커밋 금지.** (2026-07-14 개인키 공개 리포 유출 사고 — 커밋 전 `git status` 확인)
- 서버 라우트는 `apps/server/src/index.ts` 한 파일에 유지 — 분리하지 말 것.
- 프론트 API 함수 추가: `apps/web/src/lib/data/api.ts`에 타입 + 함수 함께.
- 새 화면 추가: `src/app/(app)/<route>/page.tsx` + `src/lib/nav.ts`의 `NAV` 배열에 항목 추가.
- 핵심 AI 파이프라인 코드는 `core/`에 (파이썬). 서버에서는 content-pipeline.ts로만 접점 유지.
- **검증: `pnpm check`** — 전 패키지 타입체크 + 네이티브/서버 테스트. **커밋 전에 이거 하나면 된다.**
  (CI 는 없다. 아무도 자동으로 안 돌리므로 사람이 돌려야 한다.)
  - 개별: `apps/server` `npx tsc --noEmit` · `node --import tsx --test "src/**/*.test.ts"` ·
    `apps/web` `npx next build` · `native` `pnpm test` · `pnpm dist`
  - `pnpm lint`(웹 eslint)는 **아직 기존 오류가 있어 `check` 에서 뺐다** — 프론트 개편이
    끝나면 합칠 것. 초록이 아닌 관문은 사람이 무시하게 된다.
  - **테스트는 `apps/server/src/tests/` 에 모여 있다**(2026-09-01 이동 · 63개). 소스와 섞여
    한 폴더에 138개가 쌓여 있었다. 테스트 안의 `SRC`(또는 HERE·SRC_DIR…)는 여전히
    **`src/` 를 가리킨다** — 정의에 `".."` 를 붙여 두었으니 소스 스캔 경로는 그대로 쓴다.
  - 테스트 중 상당수는 **소스 스캔 아키텍처 테스트**다(`publish-guard`·`worker-lanes`·
    `docs-drift`·`rls-access`). 순수 함수로 증명 안 되는 불변식 — "큐에 넣는 곳은 한 군데",
    "모든 잡 타입은 도는 레인에 있다", "문서 숫자가 코드와 같다" — 을 고정한다.
    **깨지면 숫자를 지우지 말고 원인을 고칠 것.**

---

## 상세 문서

- [docs/README.md](docs/README.md) — **문서 전체 지도 (여기부터)**: 현황(ops) vs 계획(plans) 구분
- [docs/ops/infra.md](docs/ops/infra.md) — 인프라 단일 진실 소스 (GCP·Vercel·큐·시크릿)
- [docs/plans/active/step-d-master-build-plan.md](docs/plans/active/step-d-master-build-plan.md) — 종합 빌드 플랜 (정본)
- [docs/reference/api-reference.md](docs/reference/api-reference.md) · [docs/reference/data-model.md](docs/reference/data-model.md)
