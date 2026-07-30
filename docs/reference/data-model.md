# 데이터 모델 레퍼런스 — 테이블·엔티티·스키마 변경

> 실측: 2026-07-28. Cloud SQL PostgreSQL 기준 (접속: `DATABASE_URL`, `apps/server/src/db-pg.ts`).
> **스키마의 진실은 schema.sql 단독이 아니라 런타임 안전망 + `apps/server/migrations/`다** —
> `initDb()`/`initQueue()`는 baseline 안전망이고, 0002 이후 변경은 `node-pg-migrate`로 관리한다.
> 라우트는 [api-reference.md](api-reference.md), 마이그레이션 런북은 [../ops/migrations.md](../ops/migrations.md), 용어는 [glossary.md](glossary.md) 참고.

## 1. 스키마 소재 지도 — 테이블이 어디서 정의되는가

현재 주요 테이블은 16개다. `apps/server/schema.sql`은 baseline 일부만 담고 있으므로, 실제 스키마는
baseline/런타임 안전망과 `apps/server/migrations/`를 함께 봐야 한다.

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

### baseline/런타임 안전망의 3테이블 — **schema.sql에 없음**

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

### node-pg-migrate 추가분 (0002~0008)

| 마이그레이션 | 대상 | 요점 | 용도 |
|---|---|---|---|
| `0002_transcript-table` | `transcript` | mediaId PK, provider, language, segments/words JSONB, raw JSONB, createdAt/updatedAt | `content_analysis.data.transcript`와 별도로 보관하는 표준 STT 저장소 |
| `0003_cast-registry` | `program_cast`, `episode_cast` | 프로그램 단위 출연자 레지스트리 + 회차별 등장/역할/신뢰도 | 인물 OCR·비전 결과를 프로그램 맥락으로 재사용 |
| `0004_cast-image-url` | `program_cast.imageUrl` | 인물 기준 이미지 URL | 출연자 식별/검수 UI 보조 |
| `0005~0007_short-source-map` | `short_source_map` | 숏폼 videoId PK, 원본 longVideoId, segStart/segEnd, source/confidence/confirmedAt, seg* 설명 컬럼 | 숏폼→원본 롱폼 구간 역매칭과 LEARN 데이터셋 입력 |
| `0008_channel-point-profile` | `youtube_channels.pointProfile`, `pointProfileAt` | 채널별 학습 규칙 JSONB + 저장 시각 | 역매칭 데이터에서 학습한 고성과 구간 규칙을 추천 프롬프트에 주입 |

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

## 3. Lab 매칭/학습 모델 — short_source_map + pointProfile

`short_source_map`은 채널의 기존 발행 숏폼 1건을 원본 롱폼 1구간에 연결한다. YouTube 백카탈로그에는
출처 구간 정보가 없기 때문에, 이 테이블이 "발행 숏폼 → 원본 구간 → 성과" 학습 데이터의 기준점이다.

| 필드 | 의미 |
|---|---|
| `shortVideoId` | PK. `channel_videos.videoId`인 숏폼 ID. 재매칭은 upsert |
| `channelId` | 채널 단위 조회·내보내기 키 |
| `longVideoId` | 출처 롱폼의 `channel_videos.videoId` |
| `segStart`, `segEnd` | 롱폼 기준 원본 구간 초. `segEnd > segStart` 체크 |
| `source` | `manual`(운영자 지정) 또는 `auto`(`core/align.py` 오디오 정렬 추정) |
| `confidence` | 자동 정렬 신뢰도. `core/align.py`의 peak ratio 계열 점수 |
| `confirmedAt` | 사람이 확인한 시각. 자동 추정은 처음엔 null |
| `segTranscript`, `segSummary`, `segEmotion`, `segHook`, `segAt` | `match.segment`가 채우는 LEARN 입력 설명 |

수명주기는 Lab API와 워커 잡으로 이어진다.

- `POST /api/lab/match`: 사람이 저장한 매칭. `source="manual"`, `confirmedAt=now`.
- `POST /api/lab/match/auto` 또는 `/auto-bulk*`: `match.align` 잡을 큐잉하고, 워커가 `core/align.py`로 오디오 상호상관 기반 구간을 추정해 `source="auto"`로 저장.
- `POST /api/lab/match/segment`: `match.segment` 잡이 원본 구간의 자막·장면요약·감정·훅을 채워 LEARN 입력을 완성.
- `POST /api/lab/match/learn`: `match.learn` 잡이 성과 tier(같은 시기 채널 중앙값 대비)를 붙인 데이터셋을 만들고 `core/learn_profile.py`로 규칙을 학습.
- 학습 결과는 `youtube_channels.pointProfile`/`pointProfileAt`에 저장된다. 이후 해당 채널 영상 분석 시 추천 스티어링 자료로 쓴다.

## 4. 신규 DB 부트스트랩 — schema.sql 단독 실행은 불완전 (함정)

schema.sql 헤더의 "Run once to bootstrap" 주석은 **낡았다**. schema.sql만 psql로 돌리면
`job_queue`·`channel_analytics`·`content_analysis`, 런타임 ALTER 컬럼, `transcript`·출연자·`short_source_map`·
`pointProfile` 등 0002 이후 마이그레이션 추가분이 빠진다.

baseline 안전망은 프로세스 기동이 한다:

```
index.ts L90:  initDb().then(() => initQueue())   # Cloud Run — 백그라운드, dbReady 플래그
worker.ts L354: await initDb(); await initQueue()  # 워커 VM — 동기, 실패 시 종료
```

- `initDb()` = 연결 테스트 → `migrate()`(CREATE/ALTER … IF NOT EXISTS 전부) → `seedIfEmpty()`
- `seedIfEmpty()`는 entities가 0건일 때만 실행되며, `seed.ts`는 **의도적으로 전부 빈 배열**
  (프로덕션에 데모 콘텐츠 없음 — 실제 업로드로만 생성)
- 빈 DB 재현은 `apps/server`에서 `pnpm migrate up`을 먼저 실행한 뒤 서버/워커를 띄우는 경로가 정본이다.
- schema.sql은 참고 문서에 가깝다. 신규 스키마 검토는 이 문서 §1, `apps/server/migrations/`, `db-pg.ts`를 같이 볼 것.

## 5. 스키마 변경 절차 (마이그레이션 런북)

현행 마이그레이션 도구는 `node-pg-migrate`다. 상세 절차와 프로덕션 주의사항은
[../ops/migrations.md](../ops/migrations.md)가 정본이다. 짧은 규칙:

1. 새 테이블/컬럼은 `apps/server/migrations/NNNN_*.cjs`에 additive하게 추가한다.
2. `db-pg.ts migrate()`와 `queue.ts initQueue()`는 baseline 안전망이다. 0002 이후 새 변경을 여기에 먼저 넣지 않는다.
3. `schema.sql`, 이 문서, 관련 API 문서를 같이 갱신한다. 안 하면 이 문서 §1 같은 드리프트가 다시 쌓인다.

**반영 시점 주의:** 마이그레이션은 **배포 후 첫 프로세스 기동 시** 실행된다. 실행 주체가 둘이다 —
Cloud Run(stepd-server, cloudbuild)과 워커 VM(stepd-worker, `deploy-worker.ps1` 수동 배포), 그리고 수동
`pnpm migrate up` 경로가 함께 있다. 먼저 적용된 스키마 위에서 구버전 코드가 잠시 돌 수 있으므로,
변경은 반드시 **후방호환**이어야 한다.

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
