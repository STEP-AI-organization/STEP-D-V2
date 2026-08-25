# YouTube API 쿼터 증량 — 심사팀 회신 패키지 (2026-08-25)

> YouTube API Services 팀이 쿼터 증량 요청에 대해 3가지를 요구함:
> ① 변경된 단가(업로드 1,600→**1 unit**)를 반영한 쿼터 사용 내역,
> ② 인증 사용자가 업로드하는 과정의 스크린캐스트(영문),
> ③ 프로젝트 번호 **275364761012** 와 **872105344568** 를 함께 쓰는 이유 설명.

## 0. 사실관계 (2026-08-25 실측)

| 항목 | 값 | 근거 |
|---|---|---|
| 872105344568 | **step-d** (STEP-D 프로덕션) | `gcloud projects describe step-d` |
| 275364761012 | **AENA 플랫폼** (사내 기존 서비스) | `aena/.env.server` `SPFN_AUTH_GOOGLE_CLIENT_ID=275364761012-…` |
| STEP-D OAuth 클라이언트 소속 | 872105344568 (step-d 자체) | 시크릿 `stepd-google-client-id` 앞자리 |

→ **같은 클라이언트를 두 프로젝트에서 쓰는 게 아니라, 한 회사(STEP AI)의 서로 다른 두 제품이
각자 프로젝트·각자 OAuth 클라이언트를 가진 것.** 심사팀이 의심하는 "쿼터 분산(quota
circumvention)"에 해당하지 않는다 — 회신에서 이걸 명확히 한다.

⚠️ **보내기 전 사용자 확인 2가지**
1. 275364761012 가 AENA 프로젝트가 맞는지 (콘솔에서 프로젝트명 확인 — 여기선 로컬 env 로만 확인함).
2. 요청 쿼터량 확정 — 아래 계산표는 **50,000 units/day** 기준. 신청서에 적어낸 숫자와 맞출 것.

---

## 1. 회신 이메일 초안 (영문)

제목: `Re: YouTube API Services – Audit and Quota Extension Request (Project 872105344568)`

```
Hello YouTube API Services Team,

Thank you for your review and for informing us of the updated quota cost for
video uploads (1,600 units → 1 unit). Please find below (1) our updated quota
usage breakdown reflecting the new pricing, (2) the requested screencast, and
(3) an explanation regarding the two project numbers.

──────────────────────────────────────────────
1. What our API client does
──────────────────────────────────────────────
STEP-D (project 872105344568) is a B2B SaaS for broadcasters and MCNs in
Korea. Broadcasters upload their full-length episodes to our platform; our
system suggests short-form clip segments; a human operator reviews and
approves them; approved clips are then uploaded to the broadcaster's own
YouTube channels through OAuth-authorized accounts (scope:
youtube.upload / youtube.force-ssl). Every upload is initiated on behalf of
an authenticated channel owner who connected their channel through Google
OAuth consent. We do not upload to channels we do not manage authorization
for, and end users (broadcaster staff) individually authorize each channel.

──────────────────────────────────────────────
2. Updated quota usage breakdown (new pricing)
──────────────────────────────────────────────
Per published video:
  videos.insert (upload) .......................... 1 unit
  thumbnails.set (custom thumbnail) ............... 50 units
  videos.update part=status (delayed private→public
    publish safety window) ........................ 50 units
  videos.list part=status (scheduled-publish
    reconciliation, batched 50 IDs/call) .......... ~1 unit
  Subtotal per published video .................... ~102 units

Per connected channel per day (monitoring / sync):
  channels.list ................................... 1 unit
  playlistItems.list (recent uploads, paged) ...... ~5 units
  videos.list (stats batches of 50) ............... ~5 units
  commentThreads.list (recent videos) ............. ~10 units
  Subtotal per channel per day .................... ~21 units
  (Channel performance reporting uses the YouTube Analytics API,
   which has its own separate quota.)

Projected steady-state (12-month target):
  50 connected channels × 5 published videos/day
    = 250 uploads/day × ~102 units ................ ~25,500 units
  50 channels × ~21 units (sync/monitoring) ....... ~1,050 units
  Metadata corrections (videos.update part=snippet,
    ~50/day × 50 units) ........................... ~2,500 units
  Daily total ..................................... ~29,000 units
  Requested quota (with headroom for spikes on
    broadcast days) ............................... 50,000 units/day

──────────────────────────────────────────────
3. Regarding projects 275364761012 and 872105344568
──────────────────────────────────────────────
These are two independent products operated by the same company (STEP AI),
each with its own codebase, its own OAuth client, and its own user base:

  • 275364761012 — "AENA", an internal media-archive platform we operate
    for the broadcaster KT ENA. Its OAuth client
    (275364761012-…apps.googleusercontent.com) is used only by that product.
  • 872105344568 — "STEP-D" (this request), our multi-tenant SaaS product.

The same API client is NOT shared across the two projects; each project's
client credentials are created in and used from its own project only. The
two products serve different users and workloads, so their quotas are not
being split to circumvent limits. If it is preferable, we are happy to have
each project reviewed independently.

──────────────────────────────────────────────
4. Screencast
──────────────────────────────────────────────
Attached is a screen recording (with English captions) showing an
authenticated user in our production client (https://stepd.stepai.kr):
  1) connecting a YouTube channel via Google OAuth,
  2) selecting an approved clip and publishing it,
  3) the video appearing on the channel (uploaded as private, then switched
     to public after our safety window via videos.update),
  4) the scheduled-publish flow.

This mailbox (hkj@stepai.kr) is the correct API contact. Please keep it as
the primary contact; no CC is required.

Thank you, and please let us know if any further information is needed.

Best regards,
Hakyung Jin
STEP AI — STEP-D
hkj@stepai.kr
```

---

## 2. 쿼터 계산 근거 (코드 실측 — 회신 표의 출처)

| 호출 | 코드 위치 | 단가(units) | 언제 |
|---|---|---|---|
| `videos.insert` (resumable) | `youtube.ts:420` | **1** (구 1,600) | 배포/자동배포 업로드 |
| `thumbnails.set` | `youtube.ts:473` | 50 | 업로드 직후 커스텀 썸네일 |
| `videos.update` part=status | `youtube.ts:872` | 50 | private→public 유예 전환 |
| `videos.update` part=snippet | `youtube.ts:929` | 50 | 발행 후 제목·설명 수정 |
| `videos.list` (status·batch 50) | `worker.ts:1093` | 1 | youtube.reconcile (예약 게시 확인) |
| `channels.list` | `youtube.ts:221` · `index.ts:8523` | 1 | 채널 연결·동기화 |
| `playlistItems.list` | `youtube.ts:247` | 1/페이지 | 업로드 목록 동기화 |
| `videos.list` (stats·batch 50) | `youtube.ts:284,779` | 1 | 통계 배치 |
| `commentThreads.list` | `youtube.ts:686` | 1/페이지 | video.comments 잡 |
| `videoCategories.list` | `youtube.ts:840` | 1 | 카테고리 캐시 |
| Analytics API | `index.ts:9703,10526` | 별도 쿼터 | 채널 성과 |

영상 1편 발행 = **~102 units** (insert 1 + thumbnail 50 + 공개전환 50 + reconcile ~1).
단가 변경 전에는 1,702 units 였으므로, 같은 요청량이면 필요 쿼터가 **94% 감소**했다 —
회신에서 요청량을 재산정한 이유로 쓸 것.

## 3. 스크린캐스트 촬영 대본 (장면별 · 영문 자막 포함)

녹화: 전체 화면 + 브라우저 URL 표시(stepd.stepai.kr 이 보여야 "API 클라이언트 위치" 요건 충족).
길이 2~4분. 각 장면에 아래 영문 자막(또는 내레이션)을 얹는다. 한국어 UI 라서 자막이 필수.

| # | 조작 | 영문 자막 |
|---|---|---|
| 1 | stepd.stepai.kr 로그인 화면 → 로그인 | "STEP-D, our production web client at stepd.stepai.kr. An operator signs in." |
| 2 | 배포 채널 화면 → "채널 연결" → Google OAuth 동의화면(계정 선택·권한 화면이 그대로 보이게) | "The channel owner connects their YouTube channel via Google OAuth, granting youtube.upload / youtube.force-ssl." |
| 3 | 연결된 채널 목록 표시 | "The authorized channel now appears in the client." |
| 4 | 클립 화면 → 완성 클립 선택 → 배포 → 채널 선택 → 게시 | "The operator selects an approved clip and publishes it to the authorized channel. This triggers videos.insert (resumable upload) and thumbnails.set." |
| 5 | 배포 화면에서 상태가 게시됨으로 바뀌는 것 | "Upload completes. The video is created as PRIVATE first — our safety window." |
| 6 | (유예 후) 해당 영상 YouTube Studio/watch 페이지에서 공개 상태 확인 | "After the review window, videos.update (part=status) switches it to PUBLIC. Here is the video live on the channel." |
| 7 | (선택) 자동배포 화면 — 예약 게시 설정 보여주기 | "Scheduled publishing: the API sets publishAt; our worker later reconciles status with videos.list." |

팁: 실채널에 올리기 부담스러우면 **테스트 채널 + 업로드 게이트 ON 상태**로 실제 업로드
1건을 쓰는 게 정석이다(₩0 · 쿼터 ~102 units). 화면 녹화는 Xbox Game Bar(Win+Alt+R)면 충분.

## 4. 보내기 전 체크리스트

- [ ] 275364761012 = AENA 프로젝트명 콘솔 확인 (console.cloud.google.com 상단 프로젝트 선택기)
- [ ] 요청 쿼터량(회신의 50,000/day)이 실제 신청서 숫자와 일치하는지 — 다르면 표의 채널 수·업로드 수를 조정
- [ ] 스크린캐스트 촬영·영문 자막 → mp4 또는 유튜브 unlisted 링크로 첨부
- [ ] 회신 발신 주소 = 신청 계정과 동일한 hkj@stepai.kr
