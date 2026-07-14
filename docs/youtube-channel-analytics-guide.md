# 채널분석 파이프라인 — YouTube OAuth 구축 가이드

목표: **대형 유튜버에게 링크를 주고 → 로그인시켜 → refresh token을 확보 → 주기적으로 채널 분석 데이터를 당겨온다.**

2026-07-14 기준 코드 실사 결과와 GCP 설정 순서를 정리한다.

---

## 0. 요약 — 뼈대는 이미 있다. 3개가 빠졌다.

| | 상태 |
|---|---|
| OAuth 라우트 (`/api/youtube/auth`, `/callback`, `/refresh`) | ✅ 구현됨 |
| `access_type=offline` + `prompt=consent` | ✅ 있음 → refresh token 매번 발급됨 |
| refresh token DB 저장 (`youtube_channels.refreshToken`) | ✅ 있음 |
| 외부 유튜버용 `/register` 페이지 | ✅ 있음 |
| 영상 목록·조회수 동기화 (`youtube.ts`) | ✅ 있음 (Data API v3) |
| **YouTube Analytics API 스코프** | ❌ **없음 — 채널분석 불가** |
| **OAuth 앱 게시(Production) + 심사** | ❌ **안 하면 토큰이 7일 뒤 죽음** |
| **외부인이 `/register` 접근 가능** | ❌ **Vercel SSO 보호에 막힘** |

이 3개를 해결하지 않으면 전략 자체가 성립하지 않는다. 아래 순서대로.

---

## 1. ⛔ 가장 큰 함정 — Testing 모드면 refresh token이 7일 만에 죽는다

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

---

## 2. ⛔ 스코프가 틀렸다 — 지금 스코프로는 채널분석이 안 된다

`apps/server/src/index.ts:396` 현재:

```ts
const YT_SCOPES =
  "https://www.googleapis.com/auth/youtube " +                              // 읽기+쓰기 전체
  "https://www.googleapis.com/auth/youtube.channel-memberships.creator " +  // 멤버십
  "https://www.googleapis.com/auth/youtube.force-ssl";                      // 읽기+쓰기
```

문제가 두 가지다.

**(a) `yt-analytics.readonly` 가 없다.**
지금 코드(`youtube.ts`)가 쓰는 건 Data API v3 (`channels`, `playlistItems`, `videos`) 뿐이다.
이건 **공개 지표(조회수·좋아요·댓글수)** 만 준다. 누구나 볼 수 있는 숫자다.

진짜 "채널분석" — **시청 지속시간, 평균 시청률, 트래픽 소스, 구독자 증감, 시청자 인구통계,
노출 대비 클릭률** — 은 전부 **YouTube Analytics API**에서 나오고, 그건
`https://www.googleapis.com/auth/yt-analytics.readonly` 스코프가 있어야 부를 수 있다.

**이 스코프 없이는 유튜버 토큰을 받아봐야 공개 조회수밖에 못 본다.** 굳이 로그인시킬 이유가 없어진다.

**(b) 쓰기 권한을 요구하고 있다 — 과도하다.**
`youtube` 와 `youtube.force-ssl` 은 **영상 업로드·수정·삭제 권한**을 포함한다.
대형 유튜버에게 "당신 채널 전체 수정 권한을 주세요"라고 요구하는 셈이다.
- 동의율이 떨어진다
- Google 심사가 훨씬 까다로워진다
- 유출 시 채널이 장악당한다

### 고칠 스코프 (외부 유튜버 = 분석 전용, 읽기만)

```ts
const YT_ANALYTICS_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",      // 채널·영상 메타 (Data API)
  "https://www.googleapis.com/auth/yt-analytics.readonly", // 채널분석 (Analytics API) ★
].join(" ");
```

수익 데이터(RPM·예상수익)까지 필요하면 `yt-analytics-monetary.readonly` 를 추가한다.
다만 더 민감한 스코프라 심사가 더 빡세진다 — **처음엔 빼고 가는 걸 권한다.**

### ⚠️ 내부 채널용 흐름과 분리해야 한다

지금은 `/register`(외부 유튜버)와 `/system`(우리 채널 배포용)이 **같은 `/api/youtube/auth`,
같은 스코프**를 쓴다. 우리 채널엔 업로드 권한이 필요하지만 **외부 유튜버에겐 절대 필요 없다.**

→ `/api/youtube/auth` 에 `mode` 파라미터를 받아 스코프를 분기할 것:

```ts
// mode=analytics (외부 유튜버) → 읽기 전용
// mode=publish   (우리 채널)   → 업로드 권한 포함
const scopes = mode === "publish" ? YT_PUBLISH_SCOPES : YT_ANALYTICS_SCOPES;
```

---

## 3. ⛔ 외부인이 `/register` 링크를 열 수 없다

현재 Vercel 프로젝트(`step-d-v2-web`)에 **Deployment Protection(SSO)** 이 켜져 있다.
익명 요청은 전부 Vercel 로그인으로 302된다. **대형 유튜버가 링크를 열면 우리 Vercel 로그인 화면을 본다.**

또한 OAuth 콜백(`redirect_uri`)은 **Google이 브라우저를 리다이렉트시키는 공개 URL**이어야 한다.
백엔드 Cloud Run은 IAM 보호라 직접 노출할 수 없다.

### 해결

1. **Vercel → step-d-v2-web → Settings → Deployment Protection → 끄기**
   (또는 최소한 `/register`·`/api/youtube/*` 경로만 공개 허용)
2. `redirect_uri` 는 **Vercel 공개 도메인**으로 잡는다. Vercel 프록시가 ID 토큰을 붙여
   Cloud Run으로 전달하므로 백엔드는 계속 IAM 보호 상태로 둘 수 있다.
   ```
   PUBLIC_URL = https://step-d-v2-web-step-ai.vercel.app
   → redirect_uri = https://step-d-v2-web-step-ai.vercel.app/api/youtube/callback
   ```
3. 가급적 **커스텀 도메인**을 붙여라. 대형 유튜버에게 `step-d-v2-web-step-ai.vercel.app`
   링크를 보내면 피싱으로 의심받는다. `connect.stepd.co.kr` 같은 도메인이 훨씬 낫다.
   (Google 심사에서도 검증된 도메인을 요구한다.)

---

## 4. GCP 설정 순서

### 4-1. API 활성화
GCP Console → **APIs & Services → Library** 에서 둘 다 켠다:
- **YouTube Data API v3**
- **YouTube Analytics API** ← 지금 안 켜져 있을 것

### 4-2. OAuth 동의 화면 (OAuth consent screen)
- **User Type: External** (외부 유튜버가 쓰니 필수)
- 앱 이름 / 지원 이메일 / 로고 — **유튜버가 이 화면을 본다. 신뢰감 있게.**
- **승인된 도메인**: 위 커스텀 도메인 등록
- 개인정보처리방침 URL · 서비스약관 URL — **심사 필수 항목이다. 미리 만들어 둘 것.**
- **스코프 추가**: `youtube.readonly`, `yt-analytics.readonly`
- 저장 후 → **"게시(Publish app)" → 심사 제출**

### 4-3. OAuth 클라이언트 생성
**APIs & Services → Credentials → Create Credentials → OAuth client ID**
- Application type: **Web application**
- **Authorized redirect URIs** — 쓸 도메인 전부 등록 (하나라도 빠지면 `redirect_uri_mismatch`):
  ```
  http://localhost:4000/api/youtube/callback          ← 로컬 개발
  https://<vercel-도메인>/api/youtube/callback         ← 스테이징
  https://connect.stepd.co.kr/api/youtube/callback     ← 프로덕션(커스텀 도메인)
  ```
- 발급된 **Client ID / Client Secret** 을 서버 env에 넣는다:
  ```
  GOOGLE_CLIENT_ID=...
  GOOGLE_CLIENT_SECRET=...
  PUBLIC_URL=https://connect.stepd.co.kr
  ```
  (`apps/server/.env` — 로컬. Cloud Run은 배포 시 환경변수/시크릿으로 주입)

### 4-4. 할당량(Quota)
- Data API 기본 **10,000 units/day**. 채널 하나 전체 영상 동기화가 수백 units 먹는다.
  대형 채널 수십 개 붙이면 금방 터진다 → **할당량 증설 신청** 미리 해둘 것.
- Analytics API는 별도 할당량.

---

## 5. 채널분석 데이터 당기는 법 (구현해야 할 부분)

토큰만 있으면 이렇게 부른다. `ids=channel==MINE` — 그 refresh token 주인의 채널을 뜻한다.

```ts
// 액세스 토큰은 refreshAccessToken(ch.refreshToken) 으로 갱신해서 사용
const params = new URLSearchParams({
  ids: "channel==MINE",
  startDate: "2026-01-01",
  endDate: "2026-07-14",
  metrics: "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost",
  dimensions: "day",
});
const res = await fetch(
  `https://youtubeanalytics.googleapis.com/v2/reports?${params}`,
  { headers: { Authorization: `Bearer ${accessToken}` } },
);
```

자주 쓰는 조합:
| 알고 싶은 것 | dimensions | metrics |
|---|---|---|
| 일별 성장 추이 | `day` | `views,estimatedMinutesWatched,subscribersGained` |
| 영상별 성과 | `video` | `views,averageViewPercentage,estimatedMinutesWatched` |
| 트래픽 유입 경로 | `insightTrafficSourceType` | `views,estimatedMinutesWatched` |
| 시청자 인구통계 | `ageGroup,gender` | `viewerPercentage` |

> `ids=channel==UC...` 로 **남의 채널**을 지정하는 건 안 된다 (MCN/콘텐츠 소유자 권한 필요).
> 반드시 **그 채널 주인의 토큰으로 `channel==MINE`** 을 부르는 구조여야 한다 —
> 지금 설계(채널별 refresh token 저장)가 정확히 그 구조라 맞게 가고 있다.

---

## 6. 보안 — 지금 refresh token이 평문으로 저장된다

`youtube_channels.refreshToken` 이 DB에 **평문**이다.
현재 스코프엔 **쓰기 권한까지** 포함돼 있어서, DB가 털리면 **대형 유튜버 채널이 장악당한다.**

최소한:
1. **스코프를 읽기 전용으로 축소** (2번) — 유출돼도 피해가 "분석 데이터 열람"에 그친다
2. **저장 시 암호화** (KMS 또는 앱 레벨 AES-GCM). 키는 Secret Manager에
3. 토큰 폐기 대응: refresh 시 `400 invalid_grant` 가 오면 사용자가 권한을 해제한 것 →
   `status`를 `revoked`로 바꾸고 재동의 요청

---

## 7. 권장 진행 순서

1. **[오늘] OAuth 동의 화면 구성 + 심사 제출** ← 수 주 걸린다. 제일 먼저.
   - 그 전에: 개인정보처리방침·서비스약관 페이지, 커스텀 도메인 확보
2. **[오늘] YouTube Analytics API 활성화**
3. 스코프 수정 — `youtube.readonly` + `yt-analytics.readonly`, 외부/내부 흐름 분리
4. Vercel Deployment Protection 해제 (외부 유튜버 접근 가능하게)
5. Analytics API 연동 코드 작성 (`youtube.ts`에 `fetchChannelAnalytics()` 추가)
6. refresh token 암호화
7. 심사 통과 후 → 유튜버 섭외 시작

> 3~6번은 코드 작업이라 하루면 된다. **1번이 병목이다.** 심사 먼저 걸어두고 코드 짜라.
