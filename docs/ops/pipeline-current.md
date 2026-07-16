# 채널분석 파이프라인 — 현재 동작 (2026-07-16)

> **지금 프로덕션에서 실제로 도는** 데이터 수집 파이프라인. 검증 완료.
>
> 같은 워커 VM에서 **AI 콘텐츠 분석(`content.analyze`)도 이미 가동 중**이다 — 업로드된
> 영상을 파이썬 `core/` 파이프라인(STT→refine→scenes→vision→names→shorts)으로 분석해
> AI 쇼츠 추천까지 만든다. 그 상세는 [content-pipeline-prod.md](content-pipeline-prod.md),
> 전체 청사진(구성 A~J)은 [../plans/pipeline-plan.md](../plans/pipeline-plan.md).
> 이 문서는 그 재료가 되는 **채널·영상·성과 데이터 수집 계층**과 큐·워커의 동작을 설명한다.

---

## 전체 흐름

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
       (상세: content-pipeline-prod.md)
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

관련: 큐·워커 인프라 상세 [worker-queue.md](worker-queue.md) · 콘텐츠 AI 파이프라인
[content-pipeline-prod.md](content-pipeline-prod.md) · 배포 [deploy.md](deploy.md) ·
YouTube OAuth·심사 [youtube-channel-analytics-guide.md](youtube-channel-analytics-guide.md)

---

## 아직 안 된 것 (다음 단계)

AI 분석 자체는 이미 이 워커에서 돈다 — `content.analyze`가 STT→장면→비전→쇼츠 추천까지
만들어 회차 추천 보드에 올린다. [../plans/pipeline-plan.md](../plans/pipeline-plan.md) 기준으로 남은 것:

- **렌더 고도화**: 추천 채택 시 지금은 ffmpeg 단순 트림·인코딩뿐 — 리프레이밍(9:16 크롭)·자막·템플릿 렌더 미구현
- **장면 프레임 호스팅**: 분석 중 뽑은 scene_frames는 임시 디렉터리와 함께 버려진다 (DB엔 트랜스크립트·장면 메타·점수·쇼츠만)
- **채널×프로그램 적합도 추천**: 추천은 회차 단위 AI 쇼츠뿐 — 구간 × 채널 매트릭스는 아직
- **성과 환류(J)**: 여기서 모은 `channel_analytics`·`video_analytics`가 아직 추천 가중치 보정에 연결되지 않았다

즉 **수집 계층과 1차 AI 분석은 가동 중**, 다음은 렌더·채널 적합·성과 환류로 폐루프를 닫는 단계.
