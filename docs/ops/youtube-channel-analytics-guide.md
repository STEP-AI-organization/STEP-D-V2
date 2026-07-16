# 채널분석 파이프라인 — YouTube OAuth 구축 가이드

목표: **대형 유튜버에게 링크를 주고 → 로그인시켜 → refresh token을 확보 → 주기적으로 채널 분석 데이터를 당겨온다.**

2026-07-16 기준 코드 실사 + 라이브 인프라 점검 결과.
2026-07-14 초판에서 "구현해야 할 부분"으로 적었던 코드 작업은 그 후 대부분 구현 완료됐다 —
이 문서는 이제 **무엇이 됐고(✅) 무엇이 남았는지(⬜)** 를 기준으로 읽는다.

수집 파이프라인의 운영 상세(큐·워커·점검 커맨드)는 [pipeline-current.md](pipeline-current.md)·[worker-queue.md](worker-queue.md),
인프라 전반은 [infra.md](infra.md), Vercel 설정은 [vercel-ops.md](vercel-ops.md) 참고.

---

## 0. 요약 — 코드는 다 됐다. 남은 건 운영·보안 항목이다.

### ✅ 구현됨 (코드 확인 완료)

| | 상태 |
|---|---|
| OAuth 라우트 (`/api/youtube/auth`, `/api/youtube/oauth/callback`, `/refresh`) | ✅ 정경로는 `oauth/callback`. 구 `/api/youtube/callback`도 별칭으로 동작 (`index.ts:695·845-846`) |
| `access_type=offline` + `prompt=consent` | ✅ refresh token 매번 발급 (`index.ts:711-712`) |
| refresh token DB 저장 (`youtube_channels.refreshToken`) | ✅ (`schema.sql:46` — 단 평문, §6) |
| 외부 유튜버용 `/register` 페이지 + 익명 접근 | ✅ Vercel Deployment Protection **꺼져 있음** (실측, §3) |
| **analytics/publish 스코프 분리** | ✅ `YT_ANALYTICS_SCOPES` / `YT_PUBLISH_SCOPES` + `?mode=` 분기 (`index.ts:677-703`, §2) |
| **수익(monetary) 스코프** | ✅ analytics 세트에 기본 포함 (`index.ts:682`) |
| **Analytics API 연동 코드** | ✅ `fetchChannelAnalytics` / `fetchVideoAnalytics` (`youtube.ts:35·460`, §5) |
| **Analytics·트렌드 라우트** | ✅ `/api/youtube/analytics/:channelId`(+`/daily`), `/trends/*`, `/videos/:videoId/analytics` 등 (§5) |
| **주기 수집 (워커)** | ✅ 15분 sweep + `video.*` fan-out (§5) |
| **`invalid_grant` → `revoked` 처리** | ✅ (`youtube.ts:130-132`, §6) |

### ⬜ 남음 (전부 코드 밖 운영/보안 항목)

| | 왜 |
|---|---|
| **GCP OAuth 동의화면 게시(Production) + 심사** | 안 하면 refresh token이 7일 뒤 죽는다 (§1) — **크리티컬 패스** |
| **refresh token 평문 저장 → 암호화** | DB 유출 시 파트너 채널 데이터가 노출된다 (§6) |
| **스코프 분리 이전 연결 채널의 재동의** | 구 토큰엔 `yt-analytics` 스코프가 없어 분석 불가. 서버가 감지는 한다 (§2) |
| cloudbuild의 `--allow-unauthenticated` 잔존 플래그 제거 | 지금은 실효 없지만 언제든 공개로 뒤집힐 리스크 (§3) |

---

## 1. ⬜ 가장 큰 함정 — Testing 모드면 refresh token이 7일 만에 죽는다

Google OAuth 앱의 게시 상태(Publishing status)가 **"Testing"** 이면
**발급된 refresh token은 7일 후 무효화된다.**

"토큰만 받아두고 나중에 리프레시해서 계속 긁는다"는 이 프로젝트의 전제가 통째로 무너진다.
대형 유튜버한테 일주일마다 다시 로그인해달라고 할 수는 없다.

→ **반드시 "In production"으로 게시해야 한다.** 그래야 refresh token이 무기한 유지된다
(사용자가 직접 권한 해제하거나, 6개월간 미사용이거나, 비밀번호 변경 등의 경우만 무효화).

### 그런데 게시하려면 Google 심사(verification)를 통과해야 한다

YouTube 스코프는 Google이 분류한 **민감 스코프(sensitive scope)** 다.
External 사용자 + Production 조합이면 **앱 인증 심사**가 필요하다.

심사 전(미인증) 상태에서는:
- 동의 화면에 **"확인되지 않은 앱입니다"** 경고가 뜬다 (대형 유튜버가 겁먹고 이탈)
- **테스트 사용자 100명 제한**

심사는 **수 주** 걸린다. 유튜버 섭외보다 **먼저 시작해야 한다.**

> **지금 당장 할 일:** OAuth 동의 화면 구성 → 심사 제출. 이게 크리티컬 패스다.
> 심사 필수 항목인 개인정보처리방침·서비스약관 페이지는 이미 있다 (`/privacy`, `/terms` — apps/web/src/app/).

---

## 2. ✅ 스코프 — 분리 완료

초판이 지적한 "스코프가 틀렸다(쓰기 권한 과다 + `yt-analytics.readonly` 부재)"는 해결됐다.
현재 코드 (`apps/server/src/index.ts:677-703`):

```ts
export type ConsentMode = "analytics" | "publish";

const YT_ANALYTICS_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",              // 채널·영상 메타 (Data API)
  "https://www.googleapis.com/auth/yt-analytics.readonly",         // 시청시간·트래픽·인구통계
  "https://www.googleapis.com/auth/yt-analytics-monetary.readonly", // 수익 (수익화 채널만)
].join(" ");

const YT_PUBLISH_SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/youtube.channel-memberships.creator",
].join(" ");

function scopesFor(mode: ConsentMode): string {
  return mode === "publish" ? YT_PUBLISH_SCOPES : YT_ANALYTICS_SCOPES;
}
```

- **외부 유튜버(`/register`)** → `mode` 미지정 = `analytics` = **읽기 전용**. 유출돼도 쓰기 불가.
- **우리 채널(`/publish-channels`)** → `GET /api/youtube/auth?mode=publish` 로 업로드 권한 포함 (`index.ts:781`).
- **수익 스코프**: 초판은 "처음엔 빼고 가라"고 권했으나 실제로는 **기본 포함**으로 갔다.
  미수익화 채널이나 스코프 없는 동의는 403이 나는데, 수익 리포트만 조용히 생략한다
  (`youtube.ts:446-453 softReportMonetary`). UI는 `hasMonetaryScope`로
  "수익 권한 없음"과 "권한은 있는데 $0"을 구분한다 (`index.ts:864`).

### ⬜ 마이그레이션 — 스코프 분리 **이전**에 연결된 채널

`index.ts:691` 주석 그대로: *"channels connected before the split won't have it."*
구 스코프(쓰기 3종)로 연결된 채널의 토큰에는 `yt-analytics.readonly`가 없어 Analytics 호출이 403 난다.

- **감지는 돼 있다**: analytics 라우트는 스코프를 검사해 `409 channel_needs_reconsent`를 준다
  (`index.ts:930-936`). 워커도 해당 영상 분석을 건너뛰고 경고만 남긴다
  (`worker.ts:182-183`, `channel-pipeline.ts:109`).
- **남은 일**: 해당 채널 소유자에게 `/register`로 **재연결(재동의)** 을 받아내는 것. 자동 안내는 없다 — 수동 운영.

---

## 3. ✅ 외부 접근 — 뚫려 있다 (2026-07-16 실측)

초판의 "Vercel SSO에 막힌다"는 해소됐다.

- `https://stepd.stepai.kr` **익명 200** — Deployment Protection 꺼져 있음. 유튜버가 `/register`를 바로 연다.
- `/api/*` 는 Next rewrite → 프록시 라우트가 **Google ID 토큰을 붙여 Cloud Run으로 전달**한다
  (`apps/web/next.config.ts:8` → `apps/web/src/app/api/proxy/[[...path]]/route.ts:33-36`).
  `https://stepd.stepai.kr/api/state` 익명 200 확인.
- **Cloud Run 자체는 비공개가 맞다**: 직접 URL(`https://stepd-server-…run.app/health`) 익명 접근 = 403.
  IAM invoker = `domain:stepai.kr` + `serviceAccount:stepd-deployer@step-d.iam.gserviceaccount.com`. `allUsers` 없음.
- `redirect_uri` = `${PUBLIC_URL}/api/youtube/oauth/callback` (`index.ts:695-699`).
  `PUBLIC_URL`은 Secret Manager `stepd-public-url`로 주입된다 (`cloudbuild.yaml:49`).
  GCP OAuth 클라이언트에 등록된 URI와 **byte 단위로 일치**해야 한다.

### ⚠️ 리스크 — cloudbuild에 `--allow-unauthenticated`가 남아 있다

`cloudbuild.yaml:37`과 `apps/server/cloudbuild.yaml:26` 둘 다 이 플래그로 배포한다.
현재는 IAM에 반영되지 않고 있다(실측 — 배포 SA에 IAM 변경 권한이 부족해 경고 후 무시되는 것으로 추정).
**하지만 그 권한이 생기는 순간 다음 배포에서 서비스가 공개로 뒤집힌다.**
→ `--no-allow-unauthenticated`로 바꾸거나 플래그를 제거할 것.

---

## 4. GCP 설정 — 남은 건 게시/심사뿐

### 4-1. API 활성화 — ✅
**YouTube Data API v3** · **YouTube Analytics API** 둘 다 프로덕션에서 실제 수집이 돌고 있으므로 활성화돼 있다.

### 4-2. OAuth 동의 화면 — ⬜ 게시 + 심사
- **User Type: External** (외부 유튜버가 쓰니 필수)
- 앱 이름 / 지원 이메일 / 로고 — **유튜버가 이 화면을 본다. 신뢰감 있게.**
- **승인된 도메인**: `stepai.kr` (커스텀 도메인 `stepd.stepai.kr` 사용 중)
- 개인정보처리방침 URL · 서비스약관 URL — 심사 필수. `/privacy`·`/terms` 페이지 존재.
- **스코프 등록**: 코드가 요구하는 3종 — `youtube.readonly`, `yt-analytics.readonly`,
  `yt-analytics-monetary.readonly` (+내부 publish용 쓰기 스코프). monetary는 더 민감한 스코프라 심사가 까다로워진다.
- 저장 후 → **"게시(Publish app)" → 심사 제출** ← **이게 남은 크리티컬 패스다.**

### 4-3. OAuth 클라이언트 — 콜백 경로 주의
- Application type: **Web application**
- **Authorized redirect URIs** — 쓸 도메인 전부 등록 (하나라도 빠지면 `redirect_uri_mismatch`).
  **정경로는 `/api/youtube/oauth/callback`** 이다 (`index.ts:695`). 구 `/api/youtube/callback`도
  별칭 핸들러가 있어 동작하지만(`index.ts:846`), 신규 등록은 정경로로:
  ```
  http://localhost:4100/api/youtube/oauth/callback     ← 로컬 개발 (local-dev.md 참고)
  https://stepd.stepai.kr/api/youtube/oauth/callback   ← 프로덕션
  ```
- **Client ID / Client Secret / PUBLIC_URL** 은 로컬은 `apps/server/.env`,
  Cloud Run은 Secret Manager(`stepd-google-client-id`/`-secret`/`stepd-public-url`)로 주입 (`cloudbuild.yaml:46-49`).

### 4-4. 할당량(Quota)
- Data API 기본 **10,000 units/day**. 채널 하나 전체 영상 동기화가 수백 units 먹는다.
  대형 채널 수십 개 붙이면 금방 터진다 → **할당량 증설 신청** 미리 해둘 것.
- Analytics API는 별도 할당량. `video.analyze`가 영상당 Analytics 호출 4~5건을 쓰므로,
  코드에 쿼터 보호 장치가 있다 — 신선/노후 영상별 재수집 간격, Shorts 프로브 캡 등 (`apps/server/src/config.ts`).

---

## 5. ✅ 채널분석 데이터 수집 — 구현돼 있다

초판의 "구현해야 할 부분"은 전부 코드가 됐다.

### 연동 코드 (`apps/server/src/youtube.ts`)
- `fetchChannelAnalytics()` (`youtube.ts:35`) — `youtubeanalytics.googleapis.com/v2/reports`,
  `ids=channel==MINE`, metrics/dimensions/filters 파라미터화. 기본 metrics는
  `views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost`.
- `fetchVideoAnalytics()` (`youtube.ts:460`) — `filters=video==<id>`로 영상 하나에 대해
  요약·리텐션 커브·트래픽 소스·인구통계 4종 + 수익(403이면 생략) 리포트를 병렬 수집.

### 라우트 (`apps/server/src/index.ts`)
| 라우트 | 무엇 |
|---|---|
| `GET /api/youtube/analytics/:channelId` | 라이브 Analytics 호출. 기본 최근 90일, `start/end/dimensions/metrics/sort` 쿼리 지원 (`index.ts:921`) |
| `GET /api/youtube/analytics/:channelId/daily` | **우리 DB**(`channel_analytics`)의 일별 시계열 (`index.ts:1011`) |
| `GET /api/youtube/videos/:videoId/analytics` | **우리 DB** — 요약+트래픽+인구통계+리텐션+댓글 한 방 (`index.ts:1161`) |
| `GET /api/youtube/trends/:channelId` · `/trends/video/:videoId` | 조회수 트렌드 (`video_stats` 스냅샷 기반) |
| `POST /api/youtube/sync/:channelId` | 업로드 목록·공개 통계 동기화 + Shorts 분류 |
| `POST /api/youtube/pipeline/run` · `/run/:channelId` | 수집 수동 트리거 (워커 큐에 enqueue) |
| `GET /api/queue/stats` | 큐 깊이 — 워커 VM 생존 확인용 |

### 수집 주기 (워커 VM `stepd-worker` — 상세는 [worker-queue.md](worker-queue.md))
- **15분 sweep** (`worker.ts:55`) → due 채널마다 `channel.analyze` enqueue. 채널 연결 직후엔 즉시 1회 실행.
- **`channel.analyze`**: 영상 동기화 6시간 간격, 채널 일별 애널리틱스 24시간 간격 (`channel-pipeline.ts:39-41`).
  첫 연결 시 **365일 백필**, 이후엔 YouTube가 수정하는 최근 10일만 재수집 (`channel-pipeline.ts:43-45`).
  일별 수익(`estimatedRevenue`) 백필 포함 (`channel-pipeline.ts:243-262`).
- **`video.analyze` fan-out** (`worker.ts:139-168`): 동기화된 **전체 업로드** 대상.
  게시 7일 미만(fresh)은 매일, 그 이후는 주 1회 재수집 (`config.ts:23-28`).
- **`video.comments`**: fresh 영상만 매일, 상위 100개 댓글 스레드 (`config.ts:31-33`).
- **`video.hotwatch`**: 신규 업로드는 48시간 동안 1시간 간격 스냅샷 — 잡이 자기 자신을 재큐 (`config.ts:36-38`).

### 저장 테이블
| 테이블 | 내용 | 소재 |
|---|---|---|
| `channel_analytics` | 채널 일별 지표(+`estimatedRevenue`) | ⚠️ **schema.sql에 없음** — `db-pg.ts:135` 런타임 생성 |
| `video_analytics` | 영상별 요약·트래픽·인구통계(JSONB, 최신본만) | `schema.sql:84` |
| `video_retention` | 영상별 리텐션 커브 | `schema.sql:94` |
| `video_comments` | 영상별 상위 댓글 | `schema.sql:102` |
| `video_stats` / `channel_videos` | 공개 조회수 스냅샷 / 업로드 목록 | `schema.sql:72·55` |

자주 쓰는 조합 (`GET /api/youtube/analytics/:channelId`에 그대로 쿼리로 전달 가능):
| 알고 싶은 것 | dimensions | metrics |
|---|---|---|
| 일별 성장 추이 | `day` | `views,estimatedMinutesWatched,subscribersGained` |
| 영상별 성과 | `video` | `views,averageViewPercentage,estimatedMinutesWatched` |
| 트래픽 유입 경로 | `insightTrafficSourceType` | `views,estimatedMinutesWatched` |
| 시청자 인구통계 | `ageGroup,gender` | `viewerPercentage` |

> `ids=channel==UC...` 로 **남의 채널**을 지정하는 건 안 된다 (MCN/콘텐츠 소유자 권한 필요).
> 반드시 **그 채널 주인의 토큰으로 `channel==MINE`** 을 부르는 구조여야 한다 —
> 현 구현(채널별 refresh token 저장 + `withAccessToken` 갱신)이 정확히 그 구조다.

---

## 6. 보안 — refresh token이 아직 평문이다

- ✅ **스코프 축소**: 외부 유튜버 토큰은 읽기 전용 (§2) — 유출돼도 채널 장악은 불가.
  단 monetary 스코프가 포함돼 수익 데이터 열람은 가능하다.
- ✅ **토큰 폐기 대응**: refresh 시 `400 invalid_grant`는 재시도 불가한 terminal로 처리
  (`youtube.ts:130-132 TokenRevokedError`) → 채널 `status`를 `revoked`로 파킹하고
  (`index.ts:909-911`, `channel-pipeline.ts:123-125`) API는 409로 "재연결 필요"를 알린다 (`index.ts:956-959`).
- ⬜ **저장 시 암호화**: `youtube_channels.refreshToken`이 DB에 **여전히 평문**이다
  (`schema.sql:46` — 서버 코드에 암호화 흔적 없음). KMS 또는 앱 레벨 AES-GCM, 키는 Secret Manager.
  **이게 유일하게 남은 코드 작업이다.**

---

## 7. 남은 진행 순서

1. **[지금] OAuth 동의 화면 게시 + 심사 제출** ← 수 주 걸린다. 유일한 크리티컬 패스.
   (`/privacy`·`/terms`·커스텀 도메인은 이미 준비돼 있다)
2. refresh token 암호화 (KMS/AES-GCM)
3. cloudbuild 두 파일에서 `--allow-unauthenticated` 제거 (§3 리스크)
4. 심사 통과 후 → 스코프 분리 이전 연결 채널 재동의 받기 + 유튜버 섭외 시작

> 초판의 "3~6번 코드 작업"은 끝났다. **이제 병목은 심사뿐이다.**
