# YouTube API 컴플라이언스 심사 — 2차 회신 패키지 (2026-09-02)

> 1차(쿼터 증량·2026-08-25)는 [youtube-quota-reply-draft.md](youtube-quota-reply-draft.md).
> 이번 건은 **데모 계정으로 실제 화면을 확인하는 단계**다. 심사팀이 요구한 것 셋:
>
> 1. **접근 가능한 API client location 링크** — 사용량을 확인할 수 있어야 한다
> 2. **스크린캐스트** — 인증된 사용자의 애널리틱스 결과가 화면에 어떻게 뜨는지
> 3. 심사 중 **모든 탭에서 page error** 를 만났다 (첨부 스크린샷 있음)
>
> 기한: **영업일 7일**.

---

## 0. 지금까지 확인한 사실 (2026-09-02 실측)

| 확인한 것 | 결과 |
|---|---|
| `https://stepd.stepai.kr` | **200** (0.04s) |
| `https://stepd.stepai.kr/analytics` | **200** — 다만 **"옮겨졌습니다" 안내 화면**이다(§2) |
| `https://stepd.stepai.kr/landing` | **200** (1.20s) |
| `https://stepd.stepai.kr/api/proxy/api/health` | **401** — 로그인 안 한 상태에선 정상 |
| 서버 최근 7일 5xx | **0건** (4xx 는 전부 사용자 본인 세션의 정상 403/404) |

→ **서버는 죽어 있지 않다.** 심사팀이 본 오류는 서버 500 이 아니라 (a) 브라우저 쪽,
(b) 로그인 실패, (c) 데모 계정의 데이터 상태 중 하나일 가능성이 높다.

⚠️ 여기서 더 좁히려면 **사람만 아는 정보 두 가지**가 필요하다(§1).

---

## 1. 먼저 확인해야 할 것 — 이게 있어야 원인을 좁힌다

1. **심사팀이 보낸 첨부(오류 스크린샷)** — 오류 문구가 원인을 거의 그대로 알려 준다.
   - `Application error: a client-side exception` → 프론트 예외
   - `fetch failed` / `Failed to fetch` → `/api/proxy` 경로 ([proxy 함정](#3-의심-1위--apiproxy))
   - `401` / 로그인 화면으로 튕김 → 세션·계정 문제
2. **심사팀에 준 링크와 데모 계정** — 정확히 어느 URL 과 어느 이메일인가.
   - `stepd.stepai.kr` 이 아니라 **Vercel 프리뷰 URL**을 줬다면 그 자체가 원인이다
     (프리뷰는 `NEXT_PUBLIC_API_URL` 이 다르거나 배포가 만료된다).

---

## 2. 심사팀 요구 ①에 대한 답 — "API client location"

심사팀이 말하는 *API client location* 은 **API 를 쓰는 우리 제품의 화면 주소**다.

```
https://stepd.stepai.kr
```

로그인이 필요한 B2B SaaS 이므로 **데모 계정이 반드시 같이 가야 한다.** 회신에 링크만 넣고
계정을 빼면 이번과 같은 "접근이 안 된다" 가 반복된다.

### ⚠️ 화면 주소가 바뀌었다 — 옛 주소를 주면 그것만으로 "오류" 로 보인다

| 옛 주소 | 지금 | 옛 주소로 가면 |
|---|---|---|
| `/analytics` | **`/performance`** | "성과 화면이 옮겨졌습니다" 안내만 뜬다 |
| `/channels` | **`/trends`** (유튜브 트렌드) | 없는 주소 |
| `/clips` | **`/edits`** (편집본) | "옮겨졌습니다" 안내만 뜬다 |

**심사팀에 옛 주소를 보냈다면 그게 "page error" 의 정체일 수 있다.** 보낸 메일을 확인할 것.

또 하나: 좌측 메뉴의 **채널 분석(`/channel-analytics`)은 아직 껍데기**다("셸·라우팅만 세운
상태"). 심사팀이 메뉴를 눌러 보다 여기 들어가면 빈 화면을 본다 — **심사 기간에는 이 메뉴를
감추는 편이 낫다.**

### 심사팀에 안내할 화면 (지금 주소)

```
/publish-channels   YouTube 채널 연결 (Google OAuth 동의)
/performance        연결한 채널의 조회수·시청시간·수익  ← 애널리틱스 본체
/program-analytics  프로그램 단위 분석
/trends             유튜브 트렌드
```

---

## 2-B. 데모 워크스페이스 — 계정만으로는 부족하다

**계정이 아니라 워크스페이스를 따로 만드는 게 맞다.** 이유 둘:

1. **다른 고객사 데이터가 심사팀 화면에 보이면 안 된다.** 기존 워크스페이스에 계정만
   추가하면 그 회사 프로그램·회차·채널이 그대로 보인다. 이건 심사 위험이자 고객사와의
   신뢰 문제다.
2. 심사팀은 **깨끗한 상태에서 처음부터** 보는 게 판단하기 쉽다.

### 만드는 순서

1. **어드민에서 워크스페이스 생성** — `admin.stepd.stepai.kr` (superadmin 세션 필요)
   · 내부적으로 `POST /api/superadmin/tenants` — 소유자 계정이 같이 만들어진다
2. 그 워크스페이스로 `stepd.stepai.kr` 로그인
3. **`/publish-channels` 에서 YouTube 채널 연결**
   · ⚠️ 반드시 **STEP AI 소유 채널**로. 고객사 채널을 쓰면 그 회사 지표가 심사팀에 넘어간다
   · ⚠️ **연결 모드가 `analytics` 여야 한다.** 업로드 전용(`publish`)으로 연결하면
     `/performance` 가 *"구조적으로 데이터가 존재하지 않습니다"* 를 띄운다 — 심사팀 눈에는
     고장 난 화면이다
   · ⚠️ 실제 **조회 이력이 있는 채널**이어야 한다. 새로 판 빈 채널은 지표가 전부 "—" 로 뜬다
4. `/performance` 에서 숫자가 실제로 뜨는지 **눈으로 확인**

> 좋은 소식: `/performance` 는 우리 클립·배포 데이터가 없어도 된다. **연결된 채널의
> YouTube Analytics 를 직접 읽는다.** 즉 채널 하나만 제대로 연결하면 화면이 찬다 —
> 데모용 콘텐츠를 따로 만들어 넣을 필요가 없다.

## 3. 의심 1위 — `/api/proxy`

프로덕션 웹은 서버를 **직접** 부르지 않고 Vercel 함수 `/api/proxy` 를 거친다(ID 토큰).
과거 여기서 **됐다 안 됐다 하는 `fetch failed`** 가 실제로 있었다(2026-08 기록):

- `ECONNRESET` — 죽은 소켓 재사용 → `connection: close` 로 해결
- `UND_ERR_INVALID_ARG` — 홉바이홉 헤더 통과 → 헤더 제거로 해결

둘 다 고쳤지만, **심사팀이 본 "모든 탭에서 오류" 는 이 증상과 모양이 같다.** 첨부 스크린샷에
`fetch failed` 가 있으면 여기부터 판다.

확인 방법: 시크릿 창 → F12 → Network → 탭을 옮겨 다니며 `/api/proxy/...` 응답 코드를 본다.

---

## 4. 심사팀 요구 ②에 대한 답 — 스크린캐스트 촬영 대본

**분량 2~3분 · 영어 자막 또는 영어 내레이션 · 마우스 커서 보이게 · 무편집 연속 촬영 권장**
(끊어 찍으면 "다른 계정으로 바꿔치기했다" 는 의심을 산다.)

| # | 화면 | 보여 줄 것 | 말할 것(영문) |
|---|---|---|---|
| 1 | 로그인 | 데모 계정으로 로그인 | "This is STEP-D, our API client at stepd.stepai.kr. I am signing in as an authenticated user." |
| 2 | `/publish-channels` | **Connect YouTube** 클릭 → **Google 동의 화면** → 요청 스코프가 보이게 | "The user authorizes their own YouTube channel through Google OAuth consent. We request youtube.readonly and yt-analytics.readonly for analytics." |
| 3 | 동의 후 복귀 | 채널 카드에 채널명·구독자 수가 뜨는 것 | "After consent, the connected channel appears here." |
| 4 | `/performance` | 조회수·시청 시간·수익 등 **인증 사용자 본인 채널의 수치** | "These analytics come from the YouTube Analytics API for the channel the user authorized. Only the authorized user's own data is shown." |
| 5 | `/performance` 상세 | 일자별 추이 그래프 (`analytics/:id/daily`) | "Daily breakdown, retrieved per authorized channel." |
| 6 | `/program-analytics` | 프로그램 단위 분석 | "Program-level breakdown for the same authorized channel." |
| 7 | 로그아웃 또는 다른 계정 | (선택) 다른 계정에는 그 데이터가 안 보인다 | "Data is scoped to the authorizing user; another workspace cannot see it." |

⚠️ **②번(동의 화면)이 이 영상의 핵심이다.** 심사의 요지가 "인증된 사용자의 데이터를
그 사용자에게만 보여 주는가" 이므로, 동의 화면 → 그 채널의 수치가 **한 흐름으로**
이어지는 장면이 있어야 한다.

⚠️ 화면에 **다른 고객사 데이터가 스치지 않게** 할 것 — 데모 워크스페이스로만 찍는다.

---

## 5. 회신 이메일 초안 (영문)

> ⚠️ **아래 대괄호를 채우기 전에는 보내지 말 것.** 특히 오류 원인은 실제로 확인한 것만 쓴다 —
> 짐작으로 "고쳤다" 고 쓰면 다음 심사에서 같은 화면이 또 나온다.

```
Subject: Re: YouTube API Services Compliance Review — Project 872105344568

Hello YouTube API Services Team,

Thank you for the follow-up and for letting us know about the page errors you
encountered. We apologize for the inconvenience during your review.

1) API client location
────────────────────────────────────────
Our API client is a web application available at:

    https://stepd.stepai.kr

STEP-D is a B2B SaaS used by broadcasters and MCNs in Korea, so the
application requires sign-in. Please use the demo account below, which has a
YouTube channel already connected so that the analytics screens are populated:

    Email:    [데모 계정 이메일]
    Password: [비밀번호]

After signing in, the YouTube-related screens are:
    /publish-channels   — connect a YouTube channel via Google OAuth consent
    /performance        — analytics for the authorized channel
    /program-analytics  — program-level breakdown

2) About the page errors you observed
────────────────────────────────────────
[확인한 원인을 여기에 쓴다. 예시 — 실제로 확인한 것만:]
[ - We identified the cause as ... and deployed a fix on [날짜]. ]
[ - We verified the demo account end-to-end on [날짜]; all tabs load correctly. ]

We have verified the flow again from a clean browser session on [날짜].

3) Screencast
────────────────────────────────────────
The recording below shows an authenticated user connecting their own YouTube
channel through the Google OAuth consent screen, and the resulting analytics
being displayed in our application:

    [영상 링크 — 공개 접근 가능해야 한다]

Please let us know if any part is unclear or if you need additional access.

Best regards,
[이름] / STEP AI
```

---

## 6. 보내기 전 최종 점검

- [ ] 영상 링크가 **로그인 없이 열린다** (Google Drive 라면 "링크가 있는 모든 사용자")
- [ ] 데모 계정 비밀번호가 실제로 그 값이다 (직접 로그인해 확인)
- [ ] 데모 워크스페이스에 **다른 고객사 데이터가 없다**
- [ ] 오류 원인 문단이 **확인한 사실**만 담고 있다
- [ ] 기한(영업일 7일) 안이다
