# 데이터 모델 레퍼런스 — 테이블·엔티티·스키마 변경

> 실측: 2026-07-16. Cloud SQL PostgreSQL 기준 (접속: `DATABASE_URL`, `apps/server/src/db-pg.ts`).
> **스키마의 진실은 schema.sql이 아니라 코드다** — `initDb()`(db-pg.ts) + `initQueue()`(queue.ts)가
> 기동 시 `CREATE TABLE IF NOT EXISTS`로 전체 스키마를 만든다. 라우트는 [api-reference.md](api-reference.md), 용어는 [glossary.md](glossary.md) 참고.

## 1. 스키마 소재 지도 — 테이블이 어디서 정의되는가

전체 12테이블. `apps/server/schema.sql`에는 9개만 있고, 3개는 코드에서만 생성된다.

### schema.sql의 9테이블 (db-pg.ts `migrate()`에도 동일 블록 존재)

| 테이블 | PK | 주요 컬럼 | 용도 |
|--------|----|-----------|------|
| `entities` | (kind, id) | `data JSONB`, `ord INTEGER` | 도메인 엔티티 전부 (JSON 블롭 — §2) |
| `media` | id | episodeId, role(`master`/`clip`), path(GCS URI/로컬), mime, size, durationSec, width/height/codec/hasAudio, thumbPath, createdAt | 업로드 원본·인코딩 클립 파일 메타 |
| `kv` | key | value TEXT | 잡동사니. 현재 `connections` 키 하나 |
| `youtube_channels` | id | channelId(UNIQUE), channelName, refreshToken, accessToken, expiresAt, scope, email, status, connectedAt | OAuth 연동된 배포채널 |
| `channel_videos` | id | videoId(UNIQUE), channelId, title, publishedAt, durationSec, viewCount/likeCount/commentCount, lastSynced, isShort, shortCheckedAt | 채널 업로드 영상 목록 |
| `video_stats` | id | videoId, channelId, snapshotAt, viewCount/likeCount/commentCount | 누적 조회수 스냅샷(시계열, INSERT만) |
| `video_analytics` | videoId | channelId, fetchedAt, summary/trafficSources/demographics(JSONB) | 영상별 Analytics 최신 1행(갱신 시 덮어씀) |
| `video_retention` | videoId | channelId, fetchedAt, curve(JSONB) | 시청 지속 곡선, 최신 1행 |
| `video_comments` | id(=댓글 id) | videoId, channelId, author, text, likeCount, publishedAt, fetchedAt | 상위 댓글(재수집 시 좋아요 수 갱신) |

### 코드에서만 생성되는 3테이블 — **schema.sql에 없음**

| 테이블 | 생성 위치 | 컬럼 |
|--------|-----------|------|
| `job_queue` | `queue.ts` `initQueue()` (L47) | id PK, type, payload JSONB, status(pending/running/done/failed), attempts, maxAttempts(기본 5), runAfter BIGINT, lockedAt, dedupeKey, error, createdAt, updatedAt. 인덱스: `(status, runAfter)` + `dedupeKey` 부분 UNIQUE(상태 pending/running일 때만 — 인플라이트 중복 방지) |
| `channel_analytics` | `db-pg.ts` `migrate()` (L135) | PK(channelId, day). views, estimatedMinutesWatched, averageViewDuration, averageViewPercentage, subscribersGained, subscribersLost, fetchedAt. (channel, day) 키라 재수집 시 덮어씀 — YouTube가 최근 며칠을 계속 수정하기 때문 |
| `content_analysis` | `db-pg.ts` `migrate()` (L215) | mediaId PK, status(pending/done/failed), data JSONB(analyze.py 결과 통짜), error, createdAt, updatedAt |

### 코드 내 ALTER (배포된 DB에 사후 추가된 컬럼 — db-pg.ts L191~209)

| 대상 | 컬럼 | 비고 |
|------|------|------|
| `youtube_channels` | `lastSyncedAt`, `lastAnalyzedAt`, `lastError` | 스케줄러 구동용. NULL = 한 번도 안 돌았음. schema.sql에 **없음** |
| `channel_videos` | `isShort BOOLEAN DEFAULT FALSE`, `shortCheckedAt BIGINT` | `/shorts/` 프로브로 검증(youtube.ts). schema.sql에는 인라인 반영됨 |
| `channel_analytics` | `estimatedRevenue REAL DEFAULT 0` | 수익화 채널 + monetary scope 동의 시에만 0 초과 |

## 2. entities JSONB 모델 — kind별 data 구조

`entities`는 `(kind, id)` PK + `data JSONB` + `ord`. kind는 5종
(`db-pg.ts:12`): `program | episode | recommendation | clip | job`.
`data`의 형태는 서버에 스키마가 없고, **웹 타입이 계약이다** — `apps/web/src/lib/types.ts`.

- `ord`: `listEntities()`가 `ORDER BY ord ASC`. `prependEntity()`가 `MIN(ord)-1`로 넣으므로 최신 항목이 목록 맨 앞.
- 쓰기는 통짜 upsert(`putEntity` — data 전체 교체). 부분 업데이트 없음.

| kind | 웹 타입 | 생성/갱신 주체 | 비고 |
|------|---------|---------------|------|
| `program` | `Program` (+`smr?: ProgramSmrConfig`) | `POST /api/programs` | smr = SMR 피드용 programCode/category/weekdays (프로그램당 1회 입력) |
| `episode` | `Episode` (`pipeline: EpisodePipeline`) | 업로드 시 자동 생성(index.ts `buildEpisodeAndMedia`) | `pipeline.stage/stageStatus/progress/note`를 워커가 실시간 갱신(content-pipeline.ts `setEpisodePipeline`) |
| `recommendation` | `Recommendation` | 워커 `content.analyze` → `recFromShort()`(content-pipeline.ts L66) | AI 쇼츠(core/recommend.py) → `kind:"short"`, `appeal = 6 - rank`(1위→5). 재실행 시 해당 에피소드 추천 전부 삭제 후 재삽입(멱등). ⚠️ 서버가 쓰는 `thumbnailCandidates[].time`이 웹 타입의 `atTime`과 필드명이 어긋나 있음 |
| `clip` | `Clip` | 추천 채택(`POST /api/recommendations/:id/adopt`) | ffmpeg 트림 성공 시 `mediaId`/`videoUrl`/`sourceMediaId` 채워짐. 추가 서버 전용 필드: `publishedVideoId`(link-video 라우트 — channel_videos와의 수동 조인 키, 웹 타입에 없음), `editorState`(에디터 저장 blob) |
| `job` | `JobEvent` | **런타임 기록 없음** | 시드 전용 자리(현재 시드도 빈 배열). 실제 잡 상태는 `job_queue` 테이블이 담당 |

**distribution은 별도 엔티티가 아니다.** `Clip.distributions: DistributionState[]`로 클립 안에
내장된다 — `{channel, status(none/scheduled/published/failed), reserveDate?, error?, platforms?, externalId?}`.
`POST /api/distributions/publish`가 이 배열을 갱신하고 클립 status를 `published`로 바꾼다(스텁 — 실제 업로드 없음).

**connections도 entities가 아니다.** `kv` 테이블의 `connections` 키에 JSON 문자열로 저장
(`{youtube, meta, metaInstagram}` — `getConnections()`).

`GET /api/state`는 5개 kind 전체 + connections + media 목록을 묶어 웹의 InitialData로 내려준다(db-pg.ts `getState()`).

## 3. 신규 DB 부트스트랩 — schema.sql 단독 실행은 불완전 (함정)

schema.sql 헤더의 "Run once to bootstrap" 주석은 **낡았다**. schema.sql만 psql로 돌리면
`job_queue`·`channel_analytics`·`content_analysis`와 `youtube_channels`의 lastSyncedAt 3종 컬럼이 빠진다.

실제 부트스트랩은 프로세스 기동이 한다:

```
index.ts L90:  initDb().then(() => initQueue())   # Cloud Run — 백그라운드, dbReady 플래그
worker.ts L354: await initDb(); await initQueue()  # 워커 VM — 동기, 실패 시 종료
```

- `initDb()` = 연결 테스트 → `migrate()`(CREATE/ALTER … IF NOT EXISTS 전부) → `seedIfEmpty()`
- `seedIfEmpty()`는 entities가 0건일 때만 실행되며, `seed.ts`는 **의도적으로 전부 빈 배열**
  (프로덕션에 데모 콘텐츠 없음 — 실제 업로드로만 생성)
- 따라서 새 DB는 **`DATABASE_URL`만 주고 서버나 워커를 한 번 띄우면 끝**. schema.sql은 참고 문서에 가깝다
  (단, 위 3테이블·3컬럼이 빠져 있어 그마저 불완전 — 코드를 기준으로 볼 것)

## 4. 스키마 변경 절차 (마이그레이션 런북)

별도 마이그레이션 도구(파일 넘버링, 버전 테이블)는 **없다**. 현행 방식:

1. **새 컬럼** → `db-pg.ts` `migrate()`에 `ALTER TABLE … ADD COLUMN IF NOT EXISTS` 추가
   (선례: `estimatedRevenue`, `isShort`, `lastSyncedAt` — L191~209)
2. **새 테이블** → `migrate()`(또는 큐 관련이면 `queue.ts initQueue()`)에 `CREATE TABLE IF NOT EXISTS` 블록 추가
3. `schema.sql`도 같이 갱신 — 안 하면 이 문서 §1 같은 드리프트가 또 쌓인다

**반영 시점 주의:** 마이그레이션은 **배포 후 첫 프로세스 기동 시** 실행된다. 실행 주체가 둘이다 —
Cloud Run(stepd-server, cloudbuild)과 워커 VM(stepd-worker, `deploy-worker.ps1` 수동 배포).
먼저 재시작한 쪽이 스키마를 바꾸므로, 한쪽만 배포해도 다른 쪽 구버전 코드가 새 스키마 위에서 돈다.
`IF NOT EXISTS` 덕에 중복 실행은 안전하지만, 이 때문에 변경은 반드시 **후방호환**이어야 한다.

권장 절차:

- 추가만 한다. `NOT NULL` 컬럼이면 `DEFAULT` 필수(기존 행 채움). 컬럼 제거·개명·타입 변경은
  코드에서 참조를 먼저 없앤 뒤 별도 수동 psql로 — `migrate()`에 DROP을 넣지 말 것.
- 검증: `apps/server`에서 `npx tsc --noEmit` + 로컬 Postgres로 기동해 `migrate()` 통과 확인.

**Postgres 함정 두 가지** (db-pg.ts 전반의 패턴이 이것 때문):

- 컬럼명이 따옴표 없이 생성돼 전부 소문자로 접힌다 → SELECT에서 `lastsynced AS "lastSynced"`처럼
  **camelCase 별칭을 매번 명시**해야 웹 타입과 맞는다. 새 쿼리 작성 시 빠뜨리기 쉬움.
- `BIGINT`는 pg 드라이버가 문자열로 돌려줄 수 있다 → 숫자로 쓰려면 `Number()` 캐스팅
  (선례: `getLatestCommentFetchedAt`, `getChannelViewTrend`).

큐 운영(잡 타입·백오프·퍼지)은 [../ops/worker-queue.md](../ops/worker-queue.md) 참고.
