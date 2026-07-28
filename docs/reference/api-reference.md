# @stepd/server HTTP API 레퍼런스

> 실측: 2026-07-28 · `apps/server/src/index.ts` 기준 — 라우트 추가 시 이 문서도 갱신.
> 프론트 대응 함수는 `apps/web/src/lib/data/api.ts` 기준. 데이터 구조는 [data-model.md](data-model.md),
> 큐·워커 동작은 [../ops/worker-queue.md](../ops/worker-queue.md) 참고.

## 공통 사항

- 등록 라우트는 영역별로 관리한다: 헬스·상태 · 콘텐츠 · 추천/클립/배포 · YouTube OAuth/채널/분석 ·
  큐/파이프라인 · admin · Lab 검수 · Lab `match.*`.
- 모든 라우트는 `apps/server/src/index.ts` 한 파일에 등록된다 (작업 규칙: 분리 금지).
- `/api/*`에 CORS 허용 (origin 반사, credentials 없음). 대부분 라우트 자체 인증은 없고,
  프로덕션 접근 제어는 인프라 레벨(Cloud Run) 몫이다. 예외로 Lab 매칭 쓰기(`POST/DELETE /api/lab/match*`)는
  `LAB_WRITE_TOKEN`과 `x-lab-token` 헤더를 요구한다.
- 프론트의 `API_BASE`는 `NEXT_PUBLIC_API_URL`(없으면 `/api`). 스트림·썸네일 URL은
  `mediaUrl()` 헬퍼가 `API_BASE`를 붙여 조립한다.
- DB 초기화는 서버 기동과 비동기 — 기동 직후에는 `/health`의 `ok`가 `false`일 수 있다.

## 헬스 · 상태

| 메서드·경로 | 역할 | 요청/응답 요점 | 프론트 함수 |
|---|---|---|---|
| `GET /health` | 서버 생존 + DB/ffmpeg 준비 여부 | → `{ ok: dbReady, ffmpeg }` | (웹 미사용) |
| `GET /api/state` | 웹 InitialData 전체 (엔티티 + 미디어) | → `{ programs, episodes, recommendations, clips, jobs, connections, media }` | `fetchState` |

## 콘텐츠 — 프로그램 · 업로드 · 미디어

| 메서드·경로 | 역할 | 요청/응답 요점 | 프론트 함수 |
|---|---|---|---|
| `POST /api/programs` | 프로그램 생성 (업로드 전 필수 콘텐츠 루트) | `{ title(필수), section, targetAge, cast, programCode, category, weekdays }` → `{ program }`. SMR 필드는 `smr` 블롭으로 저장 | `createProgram` |
| `POST /api/media/upload-init` | 대용량 업로드 1단계: GCS resumable 세션 발급 | `{ programId, filename, contentType }` → `{ mode:"resumable", mediaId, objectPath, sessionUrl }`. **GCS 미설정(로컬)이면 `mode:"multipart"`** — 클라이언트가 `/upload`로 폴백 | `uploadVideo` |
| `POST /api/media/finalize` | 대용량 업로드 2단계: GCS에 올라간 파일로 회차·마스터 미디어 생성 + `content.analyze` 인큐 | `{ mediaId, objectPath(필수), programId, title, filename, contentType, size }` → `{ media, episode, recommendations:[] }`. GCS 모드 전용. probe/썸네일은 서명 URL로 range-read | `uploadVideo` |
| `POST /api/media/upload` | (레거시) multipart 단일 요청 업로드 — 로컬 dev용 | FormData `file(필수), programId, title` → finalize와 동일 응답. Cloud Run ~32 MB 요청 캡 대상 | `uploadVideo` (로컬 폴백) |
| `GET /api/media/:id/stream` | 영상 스트리밍 | HTTP Range. Range 없어도 **항상 206 + 최대 4 MB 청크**(프록시 500 방지) | `mediaUrl`로 URL 조립 |
| `GET /api/media/:id/thumb` | 썸네일 JPEG | 200 / 404 | `mediaUrl`로 URL 조립 |
| `GET /api/media/:id/analysis` | AI 콘텐츠 분석 결과 (STT·씬·쇼츠) | → `{ status: pending\|done\|failed, data, error }`, 없으면 404 `{status:"none"}`. `data`에 `genre`(감지 장르)·`framesBase`(프레임 저장 경로) 추가, 실패 시엔 완료된 단계까지의 부분 결과(`data.partial=true` + transcript/scenes)가 담길 수 있다 | `getMediaAnalysis` |
| `GET /api/media/:id/analysis/frames/:name` | 워커가 영구 저장한 씬 대표 프레임 JPEG | `:name`은 `scene_NNNN.jpg` 형식만 허용. 저장 위치 `analysis/{mediaId}/scene_frames/`. 프레임 저장 이전 분석이면 404 | (직접 URL 조립) |

## 캐스트 — 출연자 레지스트리 · 회차 등장 타임라인

프로그램별 출연자를 등록해 두면, 파이프라인이 **화면에 박힌 이름표(lower-third) OCR**을 이 레지스트리에
매칭해 회차별 "출연자 × 등장 구간" 타임라인을 만든다(`core/cast.py`). **얼굴 인식이 아니다** — 근거는
이름 자막 + 등장 구간이며, 확정(`confirmed`)은 오직 운영자만 할 수 있다(파이프라인은 `matched`/`candidate`까지).
레지스트리가 비어 있으면 무동작 — 잡힌 이름은 전부 `candidate`로 남는다.

| 메서드·경로 | 역할 | 요청/응답 요점 |
|---|---|---|
| `GET /api/programs/:id/cast` | 프로그램 출연자 레지스트리 조회 | → `{ cast: [{ castId, name, aliases, role, season, note }] }` |
| `POST /api/programs/:id/cast` | 출연자 등록 | `{ name(필수), aliases, role, season, note }` → 201 `{ member }`. 같은 (프로그램+이름+기수) 중복은 409 |
| `PATCH /api/programs/:id/cast/:castId` | 출연자 수정 (부분 병합 — 생략 필드는 보존) | → `{ member }` |
| `DELETE /api/programs/:id/cast/:castId` | 출연자 삭제 | → `{ ok, castId }`. **과거 회차의 등장 기록(근거)은 남고 링크만 끊긴다** |
| `GET /api/media/:id/cast` | 회차 출연자 타임라인 | → `{ mediaId, people: [{ name, castId, status, matchType, confidence, sceneCount, totalSec, evidence, appearances:[{start,end,scenes,source}] }], matchedCount, candidateCount }` |
| `POST /api/media/:id/cast/:name/status` | 운영자 판정 (확정/거절/재링크) | `{ status: confirmed\|rejected\|candidate\|matched, castId? }` → `{ person }`. **`confirmed`로 가는 유일한 경로** |
| `POST /api/media/:id/cast/:name/register` | 미등록 후보 → 레지스트리 등록 + 링크 + 확정 (원스텝 온보딩) | `{ role?, season?, aliases? }` → 201 `{ member, person }`. 잡힌 이름은 alias로 보존돼 다음 회차부터 자동 매칭 |

> 재분석은 기계 산출 컬럼만 덮어쓴다 — 운영자의 `confirmed`/`rejected`와 그 링크(`castId`)는 보존된다
> (`db-pg.ts saveEpisodeCast`). 추천 보드가 DELETE+INSERT로 과거 라벨을 잃는 것과 대비되는 지점.

### 업로드 시퀀스 (프로덕션 = GCS 직접 전송)

```
브라우저                      Cloud Run(@stepd/server)              GCS            워커 VM
   │ POST /api/media/upload-init ──▶ resumable 세션 생성 ──────────▶ │
   │ ◀── { mediaId, objectPath, sessionUrl }                        │
   │ PUT 16 MiB 청크 × N (Content-Range, 308 반복) ────────────────▶ │
   │ POST /api/media/finalize ──▶ 회차+미디어 생성, 서명 URL로 probe/썸네일,
   │                              content.analyze 인큐 (dedupe: content.analyze:<mediaId>)
   │ ◀── { media, episode, recommendations: [] }                          … content.analyze 실행
   │        (추천 보드는 비어 있음 — 워커가 채우면 회차 pipeline 상태 갱신) ◀──┘
```

파일이 Cloud Run을 거치지 않으므로 32 MB 요청 캡·타임아웃이 적용되지 않는다. 실제 추천
구간은 워커의 `content.analyze` 잡이 채운다 ([../ops/pipeline-current.md](../ops/pipeline-current.md)).
청크 전송·재개 로직은 `api.ts`의 `uploadResumable()` 참고.

## 추천 · 클립 · 배포

| 메서드·경로 | 역할 | 요청/응답 요점 | 프론트 함수 |
|---|---|---|---|
| `POST /api/recommendations/:id/adopt` | 추천 채택 → ffmpeg 트림·인코딩으로 실제 클립 생성 | → `{ clipId, clip }`. 마스터 미디어+ffmpeg 있으면 실 인코딩(GCS는 서명 URL로 구간만 fetch), 없으면 메타데이터만 | `adoptRec` |
| `POST /api/recommendations/:id/reject` | 추천 거절 | `{ reason }` (기본 "기타") → `{ ok }` | `rejectRec` |
| `POST /api/distributions/publish` | ⚠️ **스텁 — 상태 기록만, 실송출 없음.** 클립 엔티티의 `distributions` 배열과 `status:"published"`만 갱신 | `{ clipIds, channel, reserveDate?, scheduled?, platforms? }` → `{ ok }`. `scheduled:true`면 상태 `scheduled`. `channel:"meta"`일 때만 `platforms` 저장 | `publishClips` |
| `POST /api/distributions/retry` | 실패 배포 재시도 (역시 상태만 `published`로) | `{ clipId, channel }` → `{ ok }` | `retryDist` |
| `PATCH /api/clips/:id/link-video` | 클립 ↔ 게시된 YouTube videoId 수동 연결 (성과 조인) | `{ videoId }` (null/""면 해제) → `{ ok, clipId, publishedVideoId, videoKnown }` | (웹 미사용) |
| `PATCH /api/clips/:id/editor` | 에디터 결정 블롭(EditorState) 저장 — 메타데이터만, 렌더 없음 | `{ editorState(필수, 객체) }` → `{ ok, clipId }` | `saveClipEditor` |

## YouTube — OAuth · 채널 관리

| 메서드·경로 | 역할 | 요청/응답 요점 | 프론트 함수 |
|---|---|---|---|
| `GET /api/youtube/auth` | Google OAuth 동의 화면으로 리다이렉트 | 쿼리 `mode=analytics\|publish`(기본 analytics), `channel`(채널 URL 메모), `return`(완료 후 이동할 same-site 경로, 기본 `/register`) | `getYouTubeAuthUrl` (URL 조립) |
| `GET /api/youtube/oauth/callback` | OAuth 콜백: 토큰 교환 → 채널 upsert → 인라인 채널 분석 + `channel.analyze` 인큐 → `return`으로 리다이렉트 | GCP에 등록된 경로. `GET /api/youtube/callback`은 동일 핸들러(레거시 링크 호환) | (브라우저 리다이렉트) |
| `GET /api/youtube/channels` | 연동 채널 목록 | → `{ channels: [{ channelId, channelName, subscribers, status, lastSyncedAt, lastAnalyzedAt, hasMonetaryScope, lastError, … }] }` | `fetchYouTubeChannels` |
| `DELETE /api/youtube/channels/:channelId` | 채널 연동 해제 | → `{ ok }` | `deleteYouTubeChannel` |
| `POST /api/youtube/refresh` | 액세스 토큰 강제 갱신 | `{ channelId }` → `{ ok, expiresAt }`. 리프레시 토큰 무효 시 **409 `revoked`** + 채널 상태 `revoked` | (웹 미사용) |

**mode별 스코프 세트** — `analytics`는 외부 크리에이터 채널의 지표 열람용 **읽기 전용**
(`youtube.readonly` + `yt-analytics.readonly` + `yt-analytics-monetary.readonly`),
`publish`는 자사 채널 업로드용 쓰기 권한(`youtube` + `youtube.force-ssl` +
`youtube.channel-memberships.creator`). 파트너에게 publish 링크를 보내지 말 것 —
유출 시 쓰기 토큰이 DB에 남는다. 상세: [../ops/youtube-channel-analytics-guide.md](../ops/youtube-channel-analytics-guide.md).

## YouTube — 분석 · 영상 · 트렌드

| 메서드·경로 | 역할 | 요청/응답 요점 | 프론트 함수 |
|---|---|---|---|
| `GET /api/youtube/analytics/:channelId` | YouTube Analytics API 라이브 조회 (기본: 최근 90일 일별) | 쿼리 `start, end, dimensions, metrics, sort, maxResults` → `{ channelId, channelName, columns, rows }`. analytics 스코프 없는 구식 연동이면 **409 `channel_needs_reconsent`** | `fetchChannelAnalytics` |
| `GET /api/youtube/analytics/:channelId/daily` | 워커가 적재한 일별 지표 (자체 DB, YouTube 호출 없음) | 쿼리 `days`(기본 90) → `{ channelId, days, rows }` | `fetchChannelDaily` |
| `POST /api/youtube/sync/:channelId` | 업로드 영상 동기화 + 스냅샷 + 쇼츠 판별(프로브) | → `{ ok, videoCount, inserted, updated, shortsClassified, shortsPending }` | `syncChannelVideos` |
| `GET /api/youtube/videos/:channelId` | 동기화된 채널 영상 목록 | → `{ channelId, channelName, videoCount, videos }` | `fetchChannelVideos` |
| `GET /api/youtube/trends/:channelId` | 채널 조회수 트렌드 + 요약 | 쿼리 `days`(1~90, 기본 30) → `{ trend, summary }` | `fetchChannelTrends` |
| `GET /api/youtube/trends/video/:videoId` | 영상 1개의 일별 조회/좋아요/댓글 추이 (스냅샷 기반) | → `{ video, trend }` | `fetchVideoTrend` |
| `GET /api/youtube/videos/:videoId/analytics` | 영상 1개 종합 지표 (video.analyze/comments 잡 결과, 자체 DB) | → `{ video, summary, trafficSources, demographics, retention, comments, fetchedAt }`. 빈 섹션 = 잡 미실행 또는 데이터 없음 | `fetchVideoAnalytics` |
| `DELETE /api/youtube/videos/:videoId` | 추적 영상 삭제 | → `{ ok }` | `deleteTrackedVideo` |

동작 세부:

- `sync`의 조회수 스냅샷(`video_stats`)은 영상당 **1시간에 1회**만 적재된다 (마지막
  스냅샷이 1시간 이내면 건너뜀).
- 쇼츠 판별은 `youtube.com/shorts/<id>` 프로브 방식 — 동기화 1회당 프로브 상한과 동시성은
  `config.ts`의 `SHORTS_PROBE_MAX_PER_SYNC` / `SHORTS_PROBE_CONCURRENCY`로 제한되고,
  판별 결과는 영상별로 캐시된다 (`shortsPending`이 남은 미판별 수).
- OAuth 콜백은 가벼운 채널 분석(`runChannelPipeline`)을 응답 전에 **인라인 실행**하고,
  무거운 영상별 분석은 `channel.analyze` 잡으로 워커에 넘긴다.

## 큐 · 파이프라인 트리거

| 메서드·경로 | 역할 | 요청/응답 요점 | 프론트 함수 |
|---|---|---|---|
| `POST /api/youtube/pipeline/run` | due 채널 전체 분석 — Cloud Scheduler가 호출 (OIDC로 인증, 별도 시크릿 없음) | → `{ ok, channels, ran, tookMs, results }` | (웹 미사용) |
| `POST /api/youtube/pipeline/run/:channelId` | 채널 1개 분석을 워커 큐에 즉시 인큐 (`channel.analyze`, force) | → `{ ok, jobId, queued, note }`. `queued:false` = 동일 잡이 이미 대기 중(dedupe) | `triggerChannelAnalysis` |
| `GET /api/queue/stats` | 큐 상태별 잡 수 — 워커 VM 생존 확인용 | → `{ pending, running, done, failed }` | (웹 미사용) |

## admin — 파괴적 유지보수

두 라우트 모두 오조작 방지를 위해 **body에 `confirm` 문자열을 요구**한다. 불일치 시 400.

| 메서드·경로 | 역할 | 요청/응답 요점 | 프론트 함수 |
|---|---|---|---|
| `POST /api/admin/reset` | 콘텐츠 전체 삭제 (프로그램·회차·추천·클립 + media 행 + GCS/로컬 파일). **복구 불가** | `{ confirm: "RESET" }` (필수) → `{ ok, deletedMedia }` | (웹 미사용 — curl 운영) |
| `POST /api/admin/queue/purge` | 큐 정리: `video.*` 백로그 삭제 + 좀비 `content.analyze` 제거 + 생존 잡 리셋 + 마스터별 분석 잡 보장 인큐 | `{ confirm: "PURGE" }` (필수) → `{ ok, deletedVideoJobs, deletedZombieContentJobs, resetContentJobs, reQueuedContentJobs }` | (웹 미사용 — curl 운영) |

## Lab — admin 검수 도구 전용

레포 루트 `core/`(파이썬 파이프라인)의 **로컬 산출물**을 admin Lab 프론트(`admin/index.html`)에
서빙하는 라우트다. 웹 앱(apps/web)은 사용하지 않는다. 읽기 경로는 `CORE_DIR` env(기본: 레포
루트 `core/`). 산출물 스키마는 [core-pipeline-reference.md](core-pipeline-reference.md) 참고.

| 메서드·경로 | 역할 | 요청/응답 요점 |
|---|---|---|
| `GET /api/lab/data` | 검수 페이로드 일괄 | `pipeline_output.json`·`refined_segments.json`·`scenes.json`·`shorts.json` 합본 → `{ video, video_name, stats, raw, refined, scenes, shorts }` |
| `GET /api/lab/frames/:name` | 씬 대표 프레임 JPEG | `core/scene_frames/<name>` (경로탈출 가드) |
| `GET /api/lab/video` | 원본 영상 스트리밍 (Range 지원) | `pipeline_output.json`의 `video` 파일 |
| `GET /lab` | admin Lab 프론트 HTML 로컬 서빙 | 프로덕션에서는 admin이 Vercel에 별도 배포 |

### Lab — 숏폼 ↔ 롱폼 매칭 / LEARN

채널의 기존 숏폼 백카탈로그를 원본 롱폼 구간에 역매칭하고, 고성과 구간 규칙을 학습하기 위한 운영 API다.
쓰기 라우트는 모두 `LAB_WRITE_TOKEN`이 서버에 있어야 하고, 요청 헤더 `x-lab-token` 값이 일치해야 한다.

| 메서드·경로 | 역할 | 요청/응답 요점 |
|---|---|---|
| `GET /api/lab/match/channels` | 매칭 가능한 YouTube 채널 목록 | 토큰 제외, `{ channelId, channelName, subscribers }[]` |
| `GET /api/lab/match/videos/:channelId` | 채널별 숏폼·롱폼·기존 매핑 일괄 조회 | `durationSec <= 180` 또는 `isShort`를 숏폼으로 분류 |
| `POST /api/lab/match` | 수동 매칭 저장/upsert | `{ shortVideoId, channelId, longVideoId, segStart, segEnd, note? }` → `short_source_map`, source=`manual` |
| `POST /api/lab/match/auto` | 선택 숏폼들의 자동 오디오 정렬 큐잉 | `{ channelId, longVideoId, shortVideoIds[], delayMs? }` → `match.align` |
| `DELETE /api/lab/match/:shortVideoId` | 숏폼 매핑 삭제 | → `{ ok, removed }` |
| `GET /api/lab/match/auto-bulk/preview/:channelId` | 채널 일괄 자동 매칭 계획 미리보기 | 제목 토큰/게시일 기반 롱폼 후보 그룹, 쓰기 토큰 불필요 |
| `POST /api/lab/match/auto-bulk` | 한 채널의 자동 매칭 잡 일괄 큐잉 | `{ channelId, limit?, staggerMs? }` → `match.align` 여러 건 |
| `POST /api/lab/match/auto-bulk/all` | 여러 채널 또는 전체 채널 자동 매칭 큐잉 | `{ channelIds?, limitPerChannel?, staggerMs? }` |
| `GET /api/lab/match/overview` | 전 채널 매칭 현황 | shorts/matched/auto/remaining + `match.align` job 상태 |
| `GET /api/lab/match/status/:channelId` | 한 채널의 매칭 진행 상태 | pending/running/done/failed, matched/auto/confirmed/described |
| `POST /api/lab/match/segment` | 매칭 구간 설명 생성 큐잉 | `{ channelId, limitLongforms? }` → `match.segment`, segTranscript/segSummary/segEmotion/segHook 채움 |
| `GET /api/lab/match/export/:channelId` | LEARN 데이터셋 내보내기 | 같은 시기 채널 중앙값 대비 성과 tier(`high/mid/low`) 포함 |
| `POST /api/lab/match/learn` | 채널 포인트 프로파일 학습 큐잉 | `{ channelId }` → `match.learn`, `youtube_channels.pointProfile` 저장 |
| `GET /api/lab/match/profile/:channelId` | 학습된 채널 프로파일 조회 | `{ profile, at }` 또는 `{ profile: null, at: null }` |

## 프론트 연동 방식 (참고)

- 실제 서버 통신은 전부 `apps/web/src/lib/data/api.ts`의 REST 함수들이다. 새 라우트를
  추가하면 여기에 타입 + 함수를 같이 추가한다 (작업 규칙).
- `store.tsx`는 빈 상태(`EMPTY_STATE`)로 시작해 마운트 시 `fetchState()`로 서버 상태를
  로드한다. 실패하면 **빈 상태로 남는다** — 목 데이터 폴백은 제거됐다 (store.tsx 주석:
  "server unreachable — leave the store empty (no mock fallback)"). 연결 여부는
  `serverConnected` 플래그로 UI에 노출된다.

## 오류 응답 규약

- 오류는 JSON `{ error: string }` (때로 `message` 동반) + 상태 코드. 성공은 대부분 `{ ok: true, … }`.
- **400** — 필수 필드 누락 (`title required`, `mediaId and objectPath required`,
  `videoId is required`, `editorState is required`, admin `confirm` 불일치 등).
- **404** — 엔티티/미디어/채널/영상 없음. `GET /api/media/:id/analysis`는 404 body가
  `{ status: "none" }`.
- **409** 두 종류 (YouTube 계열):
  - `{ error: "revoked" }` — 리프레시 토큰 무효. 채널 상태를 `revoked`로 바꾸고 재연동 요구.
    발생 지점: `refresh` · `analytics/:channelId` · `sync/:channelId`.
  - `{ error: "channel_needs_reconsent" }` — 스코프 분리 이전에 연동돼 `yt-analytics.readonly`가
    없는 채널. `/register`에서 재연동 필요. 발생 지점: `analytics/:channelId`.
- **416** — `stream`의 Range 시작점이 파일 크기를 벗어난 경우 (`Content-Range: bytes */<size>`).
- **500** — OAuth env 미설정(`OAuth not configured`), 외부 API·인코딩 실패 등.

## 웹 미사용 라우트 요약

`api.ts`에 대응 함수가 없는 라우트: `/health`, `/api/admin/*`, `PATCH /api/clips/:id/link-video`,
`POST /api/youtube/refresh`, `POST /api/youtube/pipeline/run`, `GET /api/queue/stats`,
OAuth 콜백 2종, `/lab`·`/api/lab/*`. 운영 curl·Cloud Scheduler·admin Lab이 소비자다.
