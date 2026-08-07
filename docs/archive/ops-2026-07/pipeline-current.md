# 파이프라인 — 현재 동작 (2026-07-16)

> **지금 프로덕션에서 실제로 도는** 파이프라인 전체. 검증 완료.
>
> 두 계층을 한 문서에서 다룬다: ① **채널·영상·성과 데이터 수집** (channel.* / video.* 잡, TS 구현) ·
> ② **AI 콘텐츠 분석** (`content.analyze`, 파이썬 `core/` 파이프라인 — STT→refine→scenes→vision→names→shorts).
> 둘은 같은 워커 VM·큐·DB를 공유하되 잡 타입·핸들러·테이블이 분리돼 충돌하지 않는다.
> 전체 청사진(구성 A~J)은 [../plans/pipeline-plan.md](../plans/pipeline-plan.md),
> 큐 자체(클레임·백오프·dedupe)의 상세는 [worker-queue.md](worker-queue.md).

---

## 전체 흐름 — 데이터 수집 계층

```
① 유튜버가 채널 연결  (stepd.stepai.kr/register → Google 로그인, 읽기 전용 동의)
        │
        ▼
② Cloud Run — OAuth 콜백 (/api/youtube/oauth/callback)
     · refreshToken·accessToken·scope를 youtube_channels에 저장
     · 가벼운 채널 단위 분석(runChannelPipeline, force)은 응답 전에 요청 안에서 직접 실행
       → 연결 직후 화면이 바로 찬다. 실패해도 워커 스윕이 다시 잡는다.
     · job_queue에 "channel.analyze" 잡 INSERT — 무거운 영상별 팬아웃은 워커 몫
        │
        ▼
③ job_queue (Cloud SQL)  ◀──────┐
        │                        │ 워커가 15분마다 전 활성 채널을 큐잉 (dedupe로 중복 방지,
        │                        │ due 아니면 파이프라인이 스스로 스킵)
        ▼                        │ = 콜백 처리가 실패해도 잡아내는 보증 장치
④ 워커 VM (stepd-worker, e2-small)
     · 큐에서 잡을 꺼냄 (FOR UPDATE SKIP LOCKED — 워커 N대여도 중복 실행 없음)
     · channel.analyze → runChannelPipeline 실행
        │
        ├─▶ 영상 동기화 (YouTube Data API v3)
        │      uploads 재생목록 → 영상별 조회수·좋아요·댓글·길이 + Shorts 판별(/shorts/ 프로브)
        │      → channel_videos (최신 상태) · video_stats (1시간 단위 스냅샷 = 시계열)
        │      처음 보는 신규 업로드 → video.hotwatch 큐잉 (48시간 시간별 폴링, 아래 표)
        │
        ├─▶ 채널 분석 (YouTube Analytics API)
        │      일별 시청시간·평균 시청률·구독자 증감 + 일별 예상 수익(estimatedRevenue)
        │      → channel_analytics ((channelId, day) PK)
        │
        └─▶ 영상별 잡 팬아웃 — due한 업로드마다
               video.analyze  → 요약·트래픽소스·인구통계 + 리텐션 커브
                                → video_analytics · video_retention
               video.comments → 상위 댓글 스레드 (신선한 영상만) → video_comments
     · content.analyze (업로드 회차) → 파이썬 core/ AI 분석 → content_analysis + 추천 보드
       (상세: 아래 [AI 콘텐츠 분석 계층](#ai-콘텐츠-분석-계층-contentanalyze))
        │
        ▼
⑤ 프론트가 조회
     GET /api/youtube/analytics/:channelId/daily?days=90   ← DB에 저장된 값 (빠름)
     GET /api/youtube/analytics/:channelId                 ← YouTube에서 실시간 (느림)
```

---

## 왜 2단 구조인가 (Cloud Run + 워커 VM)

Cloud Run은 **응답 직후 CPU를 throttle**하고 요청을 **600초로 제한**한다. 그래서:

- 응답 뒤에 남겨둔 작업은 언제 CPU가 끊길지 모른다 → 가벼운 채널 단위 분석만
  OAuth 콜백 **응답 전에 await로** 돌리고(위 ②), 나머지는 전부 큐에 넣는다.
- 대형 채널 첫 백필(365일 + 영상 수백 개 팬아웃)은 600초를 넘긴다.
- STT·비전이 들어가는 `content.analyze`는 훨씬 무겁다 — 실제로 이미 워커에서 돈다.

→ **Cloud Run은 큐에 넣기만**(유실 불가한 INSERT 하나), **실제 실행은 상시 켜진 워커 VM**.
워커엔 타임아웃도 throttle도 없다.

---

## 잡이 언제 도는가

| 계기 | 동작 |
|---|---|
| **채널 연결 즉시** | Cloud Run이 콜백 안에서 채널 분석을 직접 실행(force) 후, 영상별 팬아웃용 `channel.analyze` 잡을 큐잉 |
| **15분마다 스윕** | 워커가 전 활성 채널을 큐잉(dedupe) → due 판정(동기화 6h·Analytics 24h)은 파이프라인이 스스로 |
| **channel.analyze 완료 직후** | due한 업로드마다 `video.analyze`·`video.comments` 팬아웃 |
| **신규 업로드 발견 시** | `video.hotwatch` 큐잉 → 게시 후 48시간 동안 1시간 간격 스냅샷, 잡이 완료 후 스스로 재큐 |
| **영상 업로드(회차) 시** | Cloud Run이 `content.analyze` 잡을 큐잉 (dedupe: 미디어당 1개) |
| **수동 트리거** | `POST /api/youtube/pipeline/run/:channelId` (강제 실행) |

Cloud Scheduler는 안 쓴다 — **워커가 스스로 15분마다 tick**한다.

---

## 수집 주기 (YouTube API 쿼터 고려)

| | 주기 | 이유 |
|---|---|---|
| 영상 동기화 | 6시간 | Data API 쿼터 (기본 10,000 units/day) |
| 채널 Analytics | 24시간 | 일 단위 데이터라 더 자주 받아도 의미 없음 |
| 영상별 Analytics (`video.analyze`) | 신선(<7일) 24시간 · 이후 7일 | 영상당 Analytics **4콜** — 이 신선도 게이트가 쿼터를 지킨다 (영상 수 캡 없음) |
| 댓글 (`video.comments`) | 24시간 · 신선(<7일)한 영상만 | 상위 100 스레드 1페이지면 충분 |
| 핫워치 (`video.hotwatch`) | 게시 후 48시간 동안 1시간 간격 | 초기 확산 곡선을 고밀도로 |
| **첫 실행** | 즉시 · Analytics **365일 백필** | 연결 직후 화면이 비면 안 되니까 |
| 이후 | 최근 **10일**만 재수집 | YouTube가 최근 며칠 수치를 계속 정정 → `(channelId, day)` PK로 덮어쓰기 |

---

## 토큰 관리 (핵심)

우리는 refreshToken만 보관한다. accessToken(약 1시간)은 만료되므로 모든 YouTube 호출이
`withAccessToken()`을 거친다:

- 저장된 토큰이 유효하면 **재사용**, 만료 5분 전부터 갱신
- 갱신 시 accessToken **+ expiresAt 함께** 저장 (안 그러면 매번 갱신하게 됨)
- Google이 **401**이면 refresh 후 1회 재시도 / **403**(스코프·쿼터)이면 재시도 안 함
- 같은 채널 동시 요청은 refresh 1회로 병합
- 유튜버가 권한 해제(`invalid_grant`) → 채널 `status=revoked` → 스윕에서 제외, 재동의 필요

---

## 큐 신뢰성 (job_queue)

Postgres 하나로 처리 (별도 브로커 없음):

- **claim**: `FOR UPDATE SKIP LOCKED` → 워커 여러 대여도 같은 잡 중복 실행 불가
- **중복 방지**: `dedupeKey` — 대상당 in-flight 잡 1개 (`channel.analyze:<채널>`,
  `video.analyze:<영상>`, `content.analyze:<미디어>` …) → 스윕이 겹쳐도 안 쌓임
- **실패**: 지수 백오프 재시도 (30초 → 최대 30분), `maxAttempts`(5) 소진 시 `failed`로 보존
- **크래시 복구**: 워커가 죽어 잠긴 잡은 30분 후 회수
- **자기 재큐**: `video.hotwatch`는 완료 직후 후속 잡을 스스로 큐잉 (같은 dedupeKey 재사용)

---

## 데이터가 쌓이는 곳

| 테이블 | 내용 |
|---|---|
| `youtube_channels` | 채널 + 토큰 + 상태 + `lastSyncedAt`/`lastAnalyzedAt`/`lastError` |
| `channel_videos` | 영상별 최신 메타·지표 + Shorts 여부(`isShort`) |
| `video_stats` | 영상 지표 스냅샷 시계열 (동기화 시 1시간 간격 + 핫워치의 시간별 고밀도) |
| `channel_analytics` | 일별 채널 분석 (시청시간·시청률·구독자 증감 + `estimatedRevenue` 일별 예상 수익) |
| `video_analytics` | 영상별 Analytics 최신 스냅샷 (요약·트래픽소스·인구통계) — 영상당 1행 덮어쓰기 |
| `video_retention` | 영상별 리텐션 커브 (최신만) |
| `video_comments` | 영상별 상위 댓글 스레드 |
| `content_analysis` | 업로드 영상의 AI 분석 결과 JSON (`status`/`data`/`error`) |
| `job_queue` | 작업 큐 |

- ⚠️ **`job_queue`·`content_analysis`는 `schema.sql`에 없다** — 코드가 런타임에 생성한다
  (`queue.ts`의 `initQueue`, `db-pg.ts`의 `initDb`). `estimatedRevenue` 컬럼도
  `ALTER TABLE … ADD COLUMN IF NOT EXISTS`로 코드가 백필한다. 테이블 정의의 정본은
  [../reference/data-model.md](../reference/data-model.md).
- `estimatedRevenue`는 별도 Analytics 호출로 일별 수익을 받아 `channel_analytics`에 병합한다.
  수익 창출 채널 + 수익(monetary) 스코프 동의가 있어야 값이 오고, 아니면 **0으로 남되 이유를
  로그로 남긴다** (MCN/CMS가 수익을 관리하는 채널은 403).

---

## 상태 확인

```bash
# 큐·워커 건강 (pending이 안 쌓이면 정상)
curl https://stepd.stepai.kr/api/queue/stats

# 특정 채널 분석 데이터
curl "https://stepd.stepai.kr/api/youtube/analytics/CHANNEL_ID/daily?days=90"

# 워커 로그
gcloud compute ssh stepd-worker --zone us-central1-a --command "sudo journalctl -u stepd-worker -n 30 --no-pager"
```

관련: 큐·워커 인프라 상세 [worker-queue.md](worker-queue.md) · 배포 [deploy.md](deploy.md) ·
YouTube OAuth·심사 [youtube-channel-analytics-guide.md](youtube-channel-analytics-guide.md)

---

## AI 콘텐츠 분석 계층 (content.analyze)

업로드한 영상을 AI가 분석해 쇼츠를 추천하는 파이프라인(core/)의 실서비스 배선. 2026-07-16.

### 전체 흐름

```
웹 업로드 → apps/server(Cloud Run) /api/media/upload
      │        (대용량은 upload-init → 브라우저→GCS 직행 → finalize, 같은 꼬리로 합류)
      │  episode.pipeline={stage:analyze, progress:30} + content_analysis=pending
      │  + enqueue("content.analyze", {mediaId}, dedupeKey="content.analyze:<mediaId>")
      ▼
   job_queue (Cloud SQL — 코드 생성 테이블, 위 함정 참고)
      ▼
워커 VM(stepd-worker, e2-small, GPU 없음)  ── content-pipeline.ts
      │  GCS에서 영상 다운로드 → python -m core.analyze
      │  (STT→정제→장면→프레임분석[시각채점+이름자막 통합 1호출]→쇼츠추천[장르 자동감지·후보→합성 2단계])
      │  · 단계별 체크포인트(stt/refined/scenes/shorts.json) — 재시도 시 완료 단계부터 재개
      │  · @@PROGRESS 라인 → episode.pipeline에 단계별 진행률 실시간 반영
      ▼
   content_analysis(mediaId, data=결과JSON) ← saveContentAnalysis
      ├─ 프레임+단계 산출물 → GCS analysis/{mediaId}/ 영구 저장 (data.framesBase)
      ├─ AI 쇼츠 → 회차 추천 보드에 기록 (writeRecommendationsFromShorts, 멱등·appeal은 AI 산출)
      └─ episode.pipeline={stage:recommend, stageStatus:done, progress:100}
      ▼
웹: 회차 상세 분석 탭이 GET /api/media/:id/analysis 조회 + 추천 & 채택 보드에 쇼츠 노출
```

**핵심: 전 단계가 GPU-free다** (STT까지 Gemini 오디오). e2-small 워커에서 그대로 돈다.
GPU VM 불필요.

**추천 보드 배선** — 분석이 끝나면 워커가 shorts를 회차의 추천 엔티티(kind=recommendation)로
변환해 기록한다(`content-pipeline.ts` `writeRecommendationsFromShorts`). 재실행 시 해당 회차의
기존 추천을 전부 지우고 다시 쓰는 멱등 동작이라 중복이 쌓이지 않고, rank 1이 보드 맨 앞에 온다.
업로드 시 휴리스틱 더미 추천은 더 이상 만들지 않는다 — 보드는 비어 있다가 AI 결과로 채워진다.

### 구성 요소

| 파일 | 역할 |
|------|------|
| `core/analyze.py` | 전 스테이지 오케스트레이터(단일 진입점). `python -m core.analyze <video> --out <dir>` → analysis.json |
| `core/asr.py` | STT provider 스위치. `STT_PROVIDER=gemini`(기본, 관리형) / `whisper`(로컬 GPU) |
| `apps/server/src/content-pipeline.ts` | 워커측 실행기: 영상 다운로드 → analyze.py 스폰(진행률 파싱) → 결과 DB 저장 + 프레임/산출물 GCS 영구 저장 + 추천 보드 기록 + episode.pipeline 갱신. 미디어별 고정 작업 디렉토리(`$TMP/stepd-content/<mediaId>`)로 재시도 시 체크포인트 재개, 48h TTL 청소 |
| `apps/server/src/queue.ts` | `content.analyze` 잡 타입 + `job_queue` 런타임 생성 |
| `apps/server/src/worker.ts` | `content.analyze` 케이스 → `runContentAnalyze` 호출 |
| `apps/server/src/db-pg.ts` | `content_analysis` 테이블(런타임 생성) + `markContentAnalysisPending`/`saveContentAnalysis`/`getContentAnalysis` |
| `apps/server/src/index.ts` | 업로드 시 enqueue + `GET /api/media/:id/analysis` + `POST /api/admin/queue/purge` |
| `deploy/worker-pipeline-setup.sh` | 워커 VM에 파이썬 파이프라인 설치 (최초 1회) |
| `deploy-worker.ps1` (루트) | 워커 코드 갱신(재배포) 스크립트 |

### 진행 상태와 실패 처리

- **진행 상태** — `content_analysis.status`(pending/done/failed)와 별개로, 워커가
  **episode.pipeline**에 실제 상태를 기록한다. 업로드 시 서버가
  `{stage:'analyze', stageStatus:'progress', progress:30}`으로 시작하고(index.ts), 이후
  analyze.py가 stdout으로 내보내는 `@@PROGRESS {stage,pct,note}` 라인을 워커가 파싱해
  단계별 진행률("음성 인식 12/40 윈도우", "프레임 분석 60/182" 등)을 실시간 반영한다
  (2% 또는 3초 간격 스로틀). 완료 시
  `{stage:'recommend', stageStatus:'done', progress:100, note:'AI 쇼츠 추천 N건'}`.
- **실패 경로** — 오류 시 워커가 `content_analysis`에 `status='failed'` + `error`(메시지
  1000자 절단)를 저장하되, **완료된 단계의 결과는 유실하지 않는다**: 작업 디렉토리의
  체크포인트에서 transcript/scenes를 회수해 `data={partial:true, stagesDone, …}`로 같이
  저장하고, 디렉토리 자체도 남겨 둔다. 큐가 지수 백오프로 재시도하면(기본 maxAttempts 5)
  같은 디렉토리의 체크포인트에서 **완료 단계를 건너뛰고 재개**한다 — STT 완료 후 vision에서
  죽어도 STT 비용을 다시 내지 않는다. 소진되면 `job_queue`에 `failed`로 남고, 작업
  디렉토리는 48h TTL 청소가 회수한다.

### 워커 VM 배포

**최초 1회 — 파이썬 환경 설치:**

```bash
# 워커에 파이썬 파이프라인 환경 설치 (ffmpeg + venv + core deps, GPU 불필요)
gcloud compute ssh stepd-worker --zone us-central1-a \
  --command "cd /opt/stepd && sudo git pull && sudo bash deploy/worker-pipeline-setup.sh"

# 워커 서비스 env에 파이썬 경로 추가 (systemd EnvironmentFile 또는 서비스에)
#   CORE_PYTHON=/opt/stepd/core/.venv/bin/python
# 그리고 워커 재시작
```

워커 SA(stepd-deployer)는 이미 `roles/aiplatform.user` 보유 → Vertex(Gemini) ADC 인증 자동, 키 불필요.

**이후 코드 갱신(재배포) — 루트 `deploy-worker.ps1`:**

```powershell
.\deploy-worker.ps1            # 재시작 생략은 -SkipRestart
```

VM에 SSH해 `git fetch` + `git reset --hard origin/main` + `systemctl restart stepd-worker`를
한 번에 실행한다. 워커는 tsx로 소스를 직접 실행하므로 빌드가 없고, `reset --hard`라 VM의 로컬
변경은 폐기된다(멱등). 파이썬 의존성이 바뀌었으면 worker-pipeline-setup.sh를 다시 돌려야 한다.

### 운영 복구 (큐가 막혔을 때)

- 업로드 enqueue는 dedupeKey `content.analyze:<mediaId>`를 쓴다. **pending/running인 동일
  키만** 충돌하는 부분 유니크 인덱스라, 끝난 잡은 다시 넣을 수 있고 재기동 시 중복이 안 생긴다
  (충돌 시 enqueue는 null 반환·스킵).
- `POST /api/admin/queue/purge` (body `{"confirm":"PURGE"}`) — video.* 잡 홍수에
  content.analyze가 굶을 때의 원샷 복구 라우트:
  1. `video.*` 백로그(pending/failed) 삭제 — 다음 채널 틱에 재생성되므로 안전
  2. 미디어가 이미 지워진 좀비 content.analyze 잡 삭제 ("media not found"로 영원히 실패하는 것들)
  3. 살아남은 content.analyze를 pending·attempts=0으로 리셋해 즉시 실행
  4. 모든 master 미디어에 analyze 잡 존재 보장 (잡이 유실/미생성된 경우 커버, dedupe가 중복 스킵)

### 남은 것 (v1 이후)

1. ~~장면 프레임 호스팅~~ — **완료(2026-07-16).** 워커가 성공 시 프레임+단계 산출물을
   `analysis/{mediaId}/`로 GCS 업로드하고(`persistArtifacts`), 서버가
   `GET /api/media/:id/analysis/frames/:name`으로 스트리밍한다. admin reset이 prefix째 지운다.
   웹/Lab UI에서 이 프레임을 실제로 그리는 화면은 아직 없음(다음 단계).
2. **처리량** — 시각채점+이름자막을 프레임당 1호출로 통합해 이미지 호출이 절반이 됐다
   (8분 영상 182→91). 90분 회차도 ~500 호출 수준. 동시 회차가 몰리면 Vertex 리전 쿼터가
   천장(리뷰 R5) — 전역 레이트리미터·배치 API 오프로드 검토는 유효.
3. ~~진행 상태 세분화~~ — **완료(2026-07-16).** analyze.py `@@PROGRESS` → 워커 파싱 →
   episode.pipeline 반영 (위 섹션).
4. ~~admin 연결~~ — **완료(2026-07-16).** 회차 상세 분석 탭이
   `getMediaAnalysis`(apps/web/src/lib/data/api.ts)로 `/api/media/:id/analysis`(DB)를 읽어
   실제 content_analysis를 렌더한다(apps/web/src/components/episode-detail.tsx).
5. **장르 수동 지정** — 추천 장르는 현재 자동 감지(`--genre auto`)뿐. 프로그램/회차에
   장르 필드를 붙여 `content.analyze`에 넘기면 감지 호출 1회를 아끼고 오분류를 막는다.

### 로컬 테스트

```bash
# 오케스트레이터 단독 (전 스테이지)
core/.venv310/Scripts/python -m core.analyze core/영상.mp4 --out /tmp/out
# → /tmp/out/analysis.json (transcript + scenes + shorts)
```

---

## 아직 안 된 것 (다음 단계)

AI 분석 자체는 이미 이 워커에서 돈다 — `content.analyze`가 STT→장면→비전→쇼츠 추천까지
만들어 회차 추천 보드에 올린다. [../plans/pipeline-plan.md](../plans/pipeline-plan.md) 기준으로 남은 것:

- **렌더 고도화**: 추천 채택 시 지금은 ffmpeg 단순 트림·인코딩뿐 — 리프레이밍(9:16 크롭)·자막·템플릿 렌더 미구현
- **장면 프레임 UI**: 프레임·산출물은 GCS `analysis/{mediaId}/`에 영구 저장되지만, 웹/Lab에서 이를 그리는 화면은 아직 없다
- **채널×프로그램 적합도 추천**: 추천은 회차 단위 AI 쇼츠뿐 — 구간 × 채널 매트릭스는 아직
- **성과 환류(J)**: 여기서 모은 `channel_analytics`·`video_analytics`가 아직 추천 가중치 보정에 연결되지 않았다

즉 **수집 계층과 1차 AI 분석은 가동 중**, 다음은 렌더·채널 적합·성과 환류로 폐루프를 닫는 단계.

---

## 부록 — 2026-07-16 영상 파이프라인 실서비스화: 문제 해결 기록

> 대용량 영상 **업로드 → 재생 → AI 쇼츠 추천**을 실서비스에 연결하며 잡은 문제들의 인시던트 로그.
> 핵심 원칙 하나로 수렴: **영상 바이트는 우리 서버(Cloud Run·Vercel 프록시)를 거치지 않는다 — 업로드도 재생도 GCS와 브라우저가 직접.**

### 한 줄 요약

| 영역 | 상태 |
|------|------|
| 대용량 업로드 | ✅ 브라우저→GCS 직접 resumable |
| 영상 재생 | ✅ GCS 서명 URL 직접 재생 + 조각mp4 자동 리먹스 |
| AI 쇼츠 추천 | ✅ 파이프라인 실증(16분 → 200장면·5쇼츠·5추천), 추천 보드 배선 |
| 프로그램 생성 | ✅ 라우트 + SMR 폼 |
| 운영 도구 | ✅ reset · queue/purge · remux admin 엔드포인트, 배포 스크립트 |

### 1. 대용량 영상 업로드 실패

**증상** — 실서버에서 큰 영상(수 GB, 몇 시간짜리)이 업로드 도중 실패.

**원인 — 바이트가 Cloud Run 서버를 통과해서 생기는 세 개의 벽**
1. 요청 32MB 상한 (Cloud Run이 인프라 단에서 거부)
2. 메모리 초과 — 파일 전체를 RAM + `/tmp`(tmpfs)에 이중 적재, 4Gi 인스턴스에서 OOM
3. 600초 요청 타임아웃

**해결** — 브라우저 → GCS **직접 resumable 업로드**(16MB 청크, 끊겨도 재개). 서버는 세션(1회용 티켓)만 발급.
- 서버: `POST /api/media/upload-init`(resumable 세션) + `POST /api/media/finalize`(회차·미디어 생성) — `apps/server/src/index.ts`
- `apps/server/src/storage-gcs.ts` — `createResumableSession`, `signedReadUrl`
- 웹: `apps/web/src/lib/data/api.ts` — `uploadVideo`(init → 청크 PUT → finalize)
- 이탈 방지 UI: `apps/web/src/components/upload-video-dialog.tsx`

### 2. 영상 재생 안 됨 (4단 중첩 버그)

원본 마스터가 브라우저에서 재생이 안 됐고, 원인이 **네 겹**이었다. 하나씩 벗겨냄.

#### 2-1. 이중 `/api` (404)
서버 `mediaPublic.streamUrl`이 `/api/media/…`를 내보내는데, 웹이 `${apiBase}(=/api)${streamUrl}`로 합쳐 **`/api/api/media/…` → 404**.
→ 서버가 `/media/…`(프리픽스 없이) 내보내도록 수정. `apps/server/src/db-pg.ts` `mediaPublic`.

#### 2-2. 스트림 500 (`Controller is already closed`)
GCS 스트림을 `ReadableStream`으로 수동 래핑하다가, 브라우저가 Range를 중간에 끊으면 **닫힌 컨트롤러에 enqueue → 500**.
→ `createReadStream`을 `Readable.toWeb`로 교체(백프레셔·취소·에러 자동 처리). `apps/server/src/storage-gcs.ts`.

#### 2-3. Vercel 프록시가 대용량 응답에서 막힘
브라우저 → Vercel 프록시 → Cloud Run → GCS 경로에서 **74MB 응답이 프록시에서 병목**. Range 청크로 쪼개도 요청 수십 개 + 버벅임.
→ **바이트를 우리 서버로 안 나른다.** `GET /api/media/:id/stream-url`이 **GCS 서명 URL(JSON)**을 주고, 웹이 `<video src={서명URL}>`로 **GCS에 직접 range 요청**.
- 서버: `apps/server/src/index.ts` (`/api/media/:id/stream-url`, GCS면 `direct:true`)
- 웹: `getStreamUrl` — `apps/web/src/lib/data/api.ts`; `SourceTab`(episode-detail) · `editor-shell`이 이걸 사용
- (스트림 엔드포인트는 로컬 개발용 청크 서빙으로 잔존)

#### 2-4. 조각 mp4(fMP4) → 일반 `<video>` 재생 불가 ★재생 최종 원인
업로드된 파일이 **fragmented MP4**였음: `ftyp → moov(1KB, 초기화만) → moof/mdat 조각 수백 개`. 정상 progressive mp4는 `moov(전체 샘플테이블) + mdat` 하나씩. fMP4는 MSE/DASH용이라 일반 `<video>`가 못 틀어 스피너.
→ `finalize`에서 **progressive로 리먹스**: `ffmpeg -c copy -movflags +faststart`(재인코딩 없이 컨테이너만 재조립, ~초 단위) 후 GCS 객체 교체. 1.5GB 이하만(Cloud Run RAM /tmp OOM 방지).
- `apps/server/src/ffmpeg.ts` — `remuxFaststart`
- `finalize`에 리먹스 블록, 기존 파일용 `POST /api/admin/remux/:id`
- 검증: 변환 후 `ftyp → moov(1MB, 전체 인덱스, 앞) → mdat` = 표준 progressive ✓

### 3. AI 쇼츠 추천이 안 뜸

#### 3-1. 휴리스틱 더미 추천 제거
업로드 시 영상 길이를 등분해 "오프닝·훅" 라벨을 붙이던 `buildRecommendations` 휴리스틱을 **제거**(가짜로 보임). 진짜 구간은 AI 파이프라인이 채운다.

#### 3-2. 쇼츠 → 추천 보드 배선 (없던 연결)
core 파이프라인은 `analysis.shorts`를 `content_analysis` 테이블에만 저장하고, **추천 보드는 `recommendation` 엔티티를 읽어** 서로 안 이어져 있었음.
→ 워커가 `content.analyze` 완료 후 `analysis.shorts` → recommendation 엔티티로 변환·저장. rank→appeal(1→5) 매핑, `kind="short"`, 썸네일 후보 3개, 회차 파이프라인 `recommend/done` 갱신.
- `apps/server/src/content-pipeline.ts` — `writeRecommendationsFromShorts`, `setEpisodePipeline`

#### 3-3. ★근본 원인: 워커에 `GCS_BUCKET` 미설정
`content.analyze`가 한 번도 안 돌던 진짜 이유. 워커 env에 `GCS_BUCKET`이 없어 영상을 **로컬 디스크**(`storage/uploads/…`)에서 찾음 → **ENOENT → 워커 크래시**.
→ 워커 `/etc/stepd/worker.env`에 `GCS_BUCKET=stepd-media` 추가 + 재시작. 즉시 STT 시작·정상 동작.

#### 3-4. `video.comments` 403 홍수가 content.analyze를 굶김
채널 파이프라인이 영상마다 댓글 잡을 넣는데, 토큰에 댓글 스코프가 없어 **403 → 5회 재시도 → 매 스케줄마다 재적재 → 큐 수백 개**. 단일스레드 워커가 여기 매여 content.analyze가 안 돎.
→ `fetchVideoComments`: 403은 재시도 무의미하니 `[]`로 스킵. `apps/server/src/youtube.ts`.
→ `POST /api/admin/queue/purge`: `video.*` 잡 + 좀비 content.analyze 삭제 + 재점화.

#### 3-5. 좀비 잡 크래시루프
여러 번 리셋하며 **삭제된 미디어의 content.analyze 잡**이 남아 "media not found / ENOENT"로 워커를 크래시루프에 빠뜨림.
→ reset이 미디어 행 전부 삭제 + purge가 좀비 content.analyze(미디어 없는 것) 삭제.
→ `content-pipeline.ts` 다운로드 스트림에 `src.on("error", reject)` (스트림 에러가 워커를 안 죽이도록).
→ `worker.ts`에 `unhandledRejection`/`uncaughtException` 핸들러(긴 실행 중 생존).

**검증**: 16분 영상 1건이 `200 scenes, 5 shorts, 5 recs`로 완주 (워커 로그). **파이프라인 자체는 정상**, 좀비만 문제였음.

### 4. 분석 탭 목데이터 → 실데이터

회차 상세 "분석" 탭이 하드코딩 목(유재석/이영자/홍현희)이었음.
→ `getMediaAnalysis`로 실제 `content_analysis` 표시 + 20초 폴링(분석 중이면 "AI가 분석 중"). `apps/web/src/components/episode-detail.tsx`.

### 5. 파이프라인 상태 거짓 표시

업로드 직후 회차 파이프라인이 `recommend/done`("추천 생성됨")으로 **거짓** 초록.
→ 업로드 = `analyze/progress`("AI 장면 분석 중"), 워커가 완료 시 `recommend/done`으로 실반영.

### 6. 프로그램 생성 기능 부재

`＋ 새 프로그램` 버튼에 onClick이 없고 서버 생성 라우트도 없어 **프로그램이 0개 → 업로드가 program not found로 실패**.
→ `POST /api/programs` + 새 프로그램 다이얼로그(제목·장르·시청등급·출연자 + SMR: 프로그램코드·카테고리·편성요일). `docs/plans/publish-fields-ux-plan.md` 기준.

### 7. 추천 채택 전역 탭 통합

전역 "추천 & 채택" 보드는 어느 회차 건지 안 보여 혼란 → **nav에서 제거**, 회차 상세 "추천" 탭(콘텐츠→회차→추천)으로 통합. 대시보드 인박스는 이미 `/episodes/:id?tab=recommend`로 링크.

### 인프라 변경 (실서버)

| 항목 | 내용 |
|------|------|
| 버킷 CORS | `gs://stepd-media` — 브라우저 직접 업로드/재생 허용 (`stepd.stepai.kr` · PUT/GET · Content-Range) |
| 서비스계정 signBlob | `stepd-deployer`에 Token Creator(자기 자신) — 서명 URL 생성 |
| 워커 env | `/etc/stepd/worker.env`에 `GCS_BUCKET=stepd-media` |
| 워커 git remote | org 변경(`STEP-AI-official` → `STEP-AI-organization`) 반영 + read 토큰 |

### 새 admin 엔드포인트 (`apps/server/src/index.ts`)

- `POST /api/media/upload-init` · `POST /api/media/finalize` — 대용량 직접 업로드
- `GET /api/media/:id/stream-url` — 재생용 서명 URL
- `POST /api/admin/reset` — 콘텐츠 전체 초기화 (`{confirm:"RESET"}`)
- `POST /api/admin/queue/purge` — 큐 홍수·좀비 정리 + content.analyze 재점화 (`{confirm:"PURGE"}`)
- `POST /api/admin/remux/:id` — 기존 영상 progressive 리먹스
- `POST /api/programs` — 프로그램 생성

### 배포 스크립트

- `deploy.ps1` — 서버 전용 Cloud Run 배포(`gcloud builds submit` + /health)
- `deploy-worker.ps1` — 워커 VM `git reset --hard origin/main` + 재시작

### 남은 것 / 주의

- **긴 영상 처리량**: 16분 영상은 Gemini 수백 호출로 수십 분 소요(비동기라 문제는 아님). 초대용량은 Vertex 리전 쿼터 천장 주의.
- **초대용량(>1.5GB) 리먹스**: Cloud Run RAM /tmp OOM 방지로 스킵됨. 필요 시 디스크 기반 워커 리먹스로 이관.
- **댓글 스코프**: `video.comments`는 재동의 전까지 빈 값. 홍수는 위 fix로 멈춤.
- **워커 배포**: youtube 403 fix·크래시 핸들러 반영하려면 `deploy-worker.ps1` 1회 실행.
- **`apps/api` 레거시**: 이번 작업과 무관(구 STEPD).

### 교훈

1. **영상 바이트는 앱 서버로 나르지 말 것** — 업로드(GCS resumable)도 재생(GCS 서명 URL)도 직접. 프록시/서버 경유가 병목·OOM·타임아웃의 근원이었다.
2. **업로드 파일은 progressive mp4로 정규화** — 유저 파일은 fMP4일 수 있고 브라우저가 못 튼다. 인제스트에서 `-c copy -movflags +faststart` 리먹스.
3. **워커 환경변수·좀비 잡이 조용한 킬러** — GCS_BUCKET 하나 빠져서 파이프라인 전체가 안 돌았고, 리셋 남발이 크래시루프를 만들었다. 상태 초기화는 미디어 행 + 큐 잡을 함께.
