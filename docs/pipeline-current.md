# 채널분석 파이프라인 — 현재 동작 (2026-07-15)

> **지금 프로덕션에서 실제로 도는** 데이터 수집 파이프라인. 검증 완료.
>
> ⚠️ [pipeline-plan.md](pipeline-plan.md)의 **AI 파이프라인**(STT·훅 사전·비전 융합·렌더링,
> 구성 A~J)과는 다른 것이다. 그건 아직 미구현. 이 문서는 그 AI 파이프라인의 재료가 될
> **채널·영상·성과 데이터를 모으는 수집 계층**을 설명한다.

---

## 전체 흐름

```
① 유튜버가 채널 연결  (stepd.stepai.kr/register → Google 로그인, 읽기 전용 동의)
        │
        ▼
② Cloud Run — OAuth 콜백 (/api/youtube/oauth/callback)
     · refreshToken·accessToken·scope를 youtube_channels에 저장
     · job_queue에 "channel.analyze" 잡 INSERT  ← 요청 안에서 끝나는 INSERT 하나. 유실 불가.
        │
        ▼
③ job_queue (Cloud SQL)  ◀──────┐
        │                        │ 워커가 15분마다 전 채널을 훑어
        │                        │ 아직 분석 안 된 채널(lastSyncedAt=NULL)도 여기 넣음
        ▼                        │ = 콜백 enqueue가 실패해도 잡아내는 보증 장치
④ 워커 VM (stepd-worker, e2-small)
     · 큐에서 잡을 꺼냄 (FOR UPDATE SKIP LOCKED — 워커 N대여도 중복 실행 없음)
     · runChannelPipeline 실행
        │
        ├─▶ 영상 동기화 (YouTube Data API v3)
        │      uploads 재생목록 → 영상별 조회수·좋아요·댓글·길이
        │      → channel_videos (최신 상태) · video_stats (1시간 단위 스냅샷 = 시계열)
        │
        └─▶ 채널 분석 (YouTube Analytics API)
               일별 시청시간·평균 시청률·구독자 증감 등
               → channel_analytics ((channelId, day) PK)
        │
        ▼
⑤ 프론트가 조회
     GET /api/youtube/analytics/:channelId/daily?days=90   ← DB에 저장된 값 (빠름)
     GET /api/youtube/analytics/:channelId                 ← YouTube에서 실시간 (느림)
```

---

## 왜 2단 구조인가 (Cloud Run + 워커 VM)

Cloud Run은 **응답 직후 CPU를 throttle**하고 요청을 **600초로 제한**한다. 그래서:

- OAuth 콜백에서 분석을 직접 돌리면 → 리다이렉트 직후 CPU가 끊겨 죽을 수 있다.
- 대형 채널 첫 백필(365일 + 영상 수백 개)은 600초를 넘긴다.
- 앞으로 들어올 STT·비전·렌더링은 훨씬 무겁다.

→ **Cloud Run은 큐에 넣기만**(유실 불가한 INSERT 하나), **실제 실행은 상시 켜진 워커 VM**.
워커엔 타임아웃도 throttle도 없다.

---

## 잡이 언제 도는가

| 계기 | 동작 |
|---|---|
| **채널 연결 즉시** | Cloud Run이 `force` 잡을 큐잉 → 워커가 바로 집어감 |
| **15분마다 스윕** | 워커가 전 채널 확인 → due한 것(`lastSyncedAt`이 오래됐거나 NULL)만 큐잉 |
| **수동 트리거** | `POST /api/youtube/pipeline/run/:channelId` (강제 실행) |

Cloud Scheduler는 안 쓴다 — **워커가 스스로 15분마다 tick**한다.

---

## 수집 주기 (YouTube API 쿼터 고려)

| | 주기 | 이유 |
|---|---|---|
| 영상 동기화 | 6시간 | Data API 쿼터 (기본 10,000 units/day) |
| Analytics | 24시간 | 일 단위 데이터라 더 자주 받아도 의미 없음 |
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
- **중복 방지**: `dedupeKey` (채널당 in-flight 잡 1개) → 스윕이 겹쳐도 안 쌓임
- **실패**: 지수 백오프 재시도 (30초 → 최대 30분), `maxAttempts`(5) 소진 시 `failed`로 보존
- **크래시 복구**: 워커가 죽어 잠긴 잡은 30분 후 회수

---

## 데이터가 쌓이는 곳

| 테이블 | 내용 |
|---|---|
| `youtube_channels` | 채널 + 토큰 + 상태 + `lastSyncedAt`/`lastAnalyzedAt`/`lastError` |
| `channel_videos` | 영상별 최신 메타·지표 |
| `video_stats` | 영상 지표의 1시간 단위 스냅샷 (조회수 추이 차트용) |
| `channel_analytics` | 일별 채널 분석 (시청시간·시청률·구독자 증감…) |
| `job_queue` | 작업 큐 |

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

## 아직 안 된 것 (다음 단계)

이 수집 계층 위에 [pipeline-plan.md](pipeline-plan.md)의 AI 파이프라인이 올라간다:

- STT(단어 타임스탬프) → 훅 사전 후보 추출 → 경계 스냅 → 비전 융합 평가 → 리프레이밍·자막 렌더
- 채널·프로그램 적합도 기반 추천 (구간 × 채널 매트릭스)
- 성과 환류(J): 여기서 모은 `channel_analytics`·`video_stats`가 추천 가중치 보정의 입력이 됨

즉 **지금 파이프라인은 "성과 데이터를 모으는 단계"**, 다음은 그 데이터로 추천·렌더링하는 단계.
