# STEP-D — 배포 필수 필드 분리 UX 계획서

> 작성 2026-07-12. 대상: `C:\Users\STEPAI05\step-d`. 분석 소스: `C:\Users\STEPAI05\STEPD`(원본, **읽기 전용·미수정**).
> 문제: **채널마다 배포 필수 필드가 다른데 SMR 때문에 전부 한 번에 입력하고 가야 하는 구조**. 원인을 원본에서 정확히 규명하고 v2 개선안을 세운다. (구현 아님 — 분석+계획)
> file:line 인용은 조사 시점(2026-07-12) 기준. 원본 코드 변경 시 재확인 필요.

---

## 0. 한눈에 보기 (Executive Summary)

- **오해된 원인 vs 실제 원인.** "하나의 통합 폼이 모든 채널을 한 게이트에서 검증한다"가 **아니다**. 실제 구조는 **채널 아키텍처의 비대칭**이다.
  - **SMR** = 네이버가 긁어가는 **pull XML 피드**. XML은 `clips` 테이블 컬럼에서 **직접** 렌더된다(별도 배포 레코드에 콘텐츠가 없음). 그래서 피드에 나갈 모든 필드가 **발행 전에 clip에 이미 존재**해야 한다. + SMR에는 **발행 시점 입력 폼이 없다**(발행 = `{channel:'smr', reserveDate}` 토글뿐). → 그 필드를 넣을 유일한 창구가 **공유 클립 메타데이터 폼**이라, "앞에서 다 채운다".
  - **YouTube / Meta** = 항목별 **push API 업로드**. 각자 **자체 발행 폼**을 갖고, 발행 시점에 채널 고유 필드를 `distributions.metadata`(jsonb)에 담는다.
  - **결정타(조용한 게이트):** 피드 **생성(읽기) 시점**에 `validateClip`이 필수 필드 빠진 clip을 **말없이 드롭**한다(`smr.ts:250`). 운영자에겐 "게시됨(isUse=Y)"으로 보이지만 네이버에는 안 나온다 → "혹시 몰라 전부 미리, 정확히 채운다"는 방어적 습관을 강제.
- **핵심 완화 자산:** clip 메타 대부분은 **AI(Gemini)가 자동 생성**한다(register-clip 잡). title·synopsis·tags·hashtag·searchKeyword·clipType·clipCategory·youtubeCategory·people·썸네일 후보 + `contentImg`. 즉 **운영자 실입력 부담은 보이는 것보다 작다** — 문제는 "폼이 SMR 전량을 한꺼번에 요구하는 것처럼 보이고, 게이트가 조용하다"는 점.
- **v2 방향(추천):** **채널별 발행 준비도(readiness) 모델**. ① 발행은 **해당 채널의 필드만** 필요(YouTube를 SMR 미완성 상태로도 발행 가능). ② 채널별 **필수 필드 체크리스트를 명시적으로 노출**(조용한 드롭 제거). ③ SMR의 무거운 **프로그램 단위 요건(programCode·장르·편성요일·포스터/썸네일)은 "프로그램 준비"로 분리** — 클립마다 반복 부담시키지 않음. ④ 공통 필드는 AI 선채움 후 **검토/확정**, 채널 고유 필드는 선택한 채널에서만 점진 노출.

---

## 1. 조사 방법·범위

원본에서 배포 경로 3개(SMR·YouTube·Meta)의 **검증 코드(=필수 필드의 정본)**, 엔티티, 라우트, 실제 발행 폼, 관련 문서를 정독했다. 핵심 파일:

- **SMR:** `src/server/smr/{validator.ts, xml-serializer.ts, constants.ts, reserve-date.ts}`, `src/server/routes/{smr.ts, smr-admin.ts, smr-feeds.ts}`, `src/server/services/distribution.service.ts`, `src/server/entities/{clip,content,program,distribution,smr-feed,smr-feed-member}.entity.ts`, `docs/{SMR_FEED_OVERVIEW.md, dev/SMR.md, naver-tv-guide.md}`.
- **YouTube:** `src/server/routes/youtube.ts`, `src/server/jobs/youtube-upload.job.ts`, `src/server/services/youtube-sftp-csv.service.ts`, `src/server/entities/youtube-channel.entity.ts`, `docs/YOUTUBE_SFTP_DELIVERY.md`.
- **Meta:** `src/server/routes/meta.ts`, `src/server/services/meta-validation.service.ts`, `src/server/jobs/meta-{ig,fb}-reels-upload.job.ts`, `src/server/entities/meta-account.entity.ts`, `docs/META_REELS_INTEGRATION_2026-04-20.md`.
- **공통/폼/흐름:** `src/app/(app)/studio/clips/_components/clip-form.tsx`, `src/app/(app)/studio/clips/[id]/{edit/,}page.tsx`, `src/app/(app)/studio/{smr,youtube-publish,meta-publish,schedule}/page.tsx`, `src/server/services/clip-metadata.service.ts`, `docs/PIPELINE_OVERVIEW.md`.

> "필수"의 정본은 **검증 코드**(validator/route guard)다. UI 라벨의 `*`나 문서 표기는 코드와 어긋나는 곳이 있어(아래 각주) 코드를 우선했다.

---

## 2. 채널별 필수 / 선택 필드 매트릭스

### 2.1 SMR (네이버TV / 네이트) — **3계층 검증**

SMR은 `program → content(회차) → clip` 계층을 XML로 내보낸다. clip 하나가 네이버에 뜨려면 **연결된 content와 program도 각자의 검증을 통과**해야 한다. 고정 상수: `SMR_CPID='CW'`, `SMR_CHANNEL_ID='EN1'`, `SMR_CORPORATOR='KT ENA'` (`constants.ts:5-7`).

**(a) Clip 레벨** — `validateClip` (`validator.ts:156-186`), 피드 생성 시 `smr.ts:250`에서 필터.

| 필드(라벨) | 코드/XML | 필수? | cause | 근거 |
|---|---|---|---|---|
| 클립 유형 | `clipType` / `<cliptype>` | **필수** (9종 enum) | input | `validator.ts:160`; enum `:40` `T2 T3 T6 T9 TZ TH TI TS TT` |
| 재생 시간 | `playTime` / `<playtime>` | **필수** (>0) | **system**(인코딩) | `validator.ts:170` |
| 썸네일 | `contentImg` / `<contentimg>` | **필수** | **system**(썸네일 잡) | `validator.ts:175`; 코드가 SMR 스펙보다 엄격(스펙은 선택, `dev/SMR.md:574`) |
| 프로그램 연결 | `programId` / `<programid>` | **필수** | input | `validator.ts:180` |
| 클립 카테고리 | `clipCategory` / `<clipcategory>` | 선택(있으면 enum) | input | `validator.ts:165` (`01`–`11`) — 비어도 통과 |

DB NOT-NULL로 항상 존재(검증 재확인 안 함): `clipId, originId, title, mediaDomain, filePath, itemTypeId, targetAge` (`clip.entity.ts:15-26`). 생성 시 기본값 주입(`title`←파일명, `clipType`←`TZ`, `targetAge`←0, `playTime`←파일 길이; `smr-admin.ts:593-599`).

**(b) Content(회차) 레벨** — `validateContent` (`validator.ts:137-152`), `smr.ts:197`.

| 필드 | 코드/XML | 필수? | 근거 |
|---|---|---|---|
| 방송일자 | `broadDate` / `<broaddate>` | **필수** (YYYYMMDD 8자리) | `validator.ts:141` (`/^\d{8}$/`) |
| 시청연령 | `targetAge` / `<targetage>` | **필수** (0/7/12/15/19) | `validator.ts:146` |

**(c) Program / 채널(피드) 레벨** — `validateAggregateFeedProgramInfo` (`validator.ts:92-133`), 피드 생성/수정 시 `smr-feeds.ts:120,150`에서 throw. **프로그램당 1회 설정** 성격.

| 필드 | 코드/XML | 필수? | 근거 |
|---|---|---|---|
| 프로그램 코드 | `programCode` / `<programcode>` | **필수** + 형식(`^[a-z0-9]+$`) | `validator.ts:97`, 형식 `:46-54` (소문자·숫자만; 실측 확인) |
| 카테고리 | `category` / `<category>` | **필수** (01/02/03) | `validator.ts:102` |
| 장르(section) | `section` / `<section>` | **필수** (01–11) | `validator.ts:107` |
| 시청연령 | `targetAge` | **필수** (0/7/12/15/19) | `validator.ts:112` |
| 편성 요일 | `weekCode` / `<weekcode>` | **필수** (7자리 이진, ≥1) | `validator.ts:117` |
| 포스터 이미지 | `programPosterImg` | **필수** | `validator.ts:122` |
| 프로그램 썸네일 | `programThumImg` | **필수** | `validator.ts:128` |

**(d) 배포/운영 게이트** (validator 밖, 그러나 실질 필수):
- SMR distribution 레코드 존재해야 피드에 포함 (`smr.ts:248`).
- **`reserveDate`(공개일시)** — 검증은 안 하지만 **비면 네이버가 게시 안 함**. 즉시 발행 시 `now`로 **강제 채움**(`smr-admin.ts:805`, `nowReserveDate()` `reserve-date.ts:32`). → **SMR #1 특이점.**
- `platformisuse` 19자리 마스크 position-1(네이버)=`Y` 여야 노출. 기본 전부 `N`=비노출(`xml-serializer.ts:162,683`).

### 2.2 YouTube

**두 경로:** ① **API(`videos.insert`) = 실사용**, ② **SFTP+CSV = 스캐폴드(미배선, 컬럼 미확정)** `youtube-sftp-csv.service.ts:12-14`. 아래는 실사용 API 경로.

| 필드 | 코드 | 필수? | 근거 |
|---|---|---|---|
| 클립/파일 | `clipId`, `clip.fileId` | **필수** | `youtube.ts:286` (파일 없으면 throw) |
| 채널 선택(OAuth 연결) | `youtubeChannelPublicId` | **필수** (active 채널) | `youtube.ts:289`; UI `!selectedChannel` `clips/page.tsx:1228` |
| 제목 | `title` / `snippet.title` | **필수** | `youtube.ts:272`; job `:65` |
| 카테고리 | `categoryId` | 자동 기본값(24) | `youtube-upload.job.ts:118` — 항상 전송, 차단 안 함 |
| 공개 상태 | `privacyStatus` | 자동 파생(예약=private, 아니면 public) | `youtube-upload.job.ts:112,129` |
| 아동용 | `selfDeclaredMadeForKids` | 자동(false 하드코딩) | `youtube-upload.job.ts:123` |
| 설명 | `description` | 선택 | `youtube.ts:272` |
| 태그 | `tags` | 선택 | `youtube.ts:273` |
| 예약 게시 | `scheduleDate` / `publishAt` | 선택 | `youtube.ts:275` |
| 썸네일 | `thumbnailFileId` | 선택(실패해도 영상 성공) | `youtube-upload.job.ts:183-220` |

**전제(계정 단위, 1회):** 채널별 Google OAuth(access/refresh 토큰 `notNull`, `youtube-channel.entity.ts:19-20`). ⚠️ 문서/UI 문구는 "비공개 업로드"라 하지만 실제 job은 예약 아니면 **public** 업로드(`youtube-upload.job.ts:112`) — 원본 내 불일치(플래그).

### 2.3 Meta Reels (Instagram / Facebook)

`POST /admin/meta/publish` → IG/FB 잡 팬아웃. 검증 정본 `meta-validation.service.ts`.

| 필드 | 코드 | 필수? | 근거 |
|---|---|---|---|
| 클립/파일 | `clipId`, `clip.fileId` | **필수** | `meta.ts:275,289` |
| 계정(페이지) | `metaAccountPublicId` | **필수** (active) | `meta.ts:277` |
| 배포 플랫폼 | `platforms` (IG/FB ≥1) | **필수** (minItems 1) | `meta.ts:253-256` |
| 페이지 액세스 토큰 | `pageAccessToken` | **필수** (계정 단위) | `meta-account.entity.ts:18` |
| IG 비즈니스 연결 | `igUserId` | **IG 선택 시 필수** | `meta.ts:283-286` |
| 캡션 | `caption` (IG) | 선택(기본 title+synopsis) | `meta.ts:257` |
| 제목/설명 | `title`/`description` (FB) | 선택 | `meta.ts:258-259` |
| 피드 공유 | `shareToFeed` (IG) | 선택(기본 true) | `meta.ts:260` |
| 예약 게시 | `scheduleDate` | 선택 | `meta.ts:261` |
| **커버/썸네일** | — | **없음**(미수집·미전송) | 폼·잡·스키마 어디에도 없음 |

**영상 스펙(차단성 검증, 파일 probe 기반 자동값):** 코덱 H.264(`meta-validation.service.ts:33`), 길이 3s–900s(IG)/5400s(FB) `:40-51`, 크기 ≤1GB(IG)/≤10GB(FB) `:55-61`, **세로 비율**(IG=에러 필수 `:67`, FB=경고). probe 값이 비면 해당 검사 skip(`:23-24`).
**전제(계정 단위, 1회):** Facebook OAuth 페이지 토큰 + (IG 시) IG 비즈니스 연결.

### 2.4 요약 매트릭스 (채널 × 필드)

| 필드 | SMR | YouTube | Meta | 입력 성격 |
|---|:---:|:---:|:---:|---|
| 인코딩 영상 파일 | ✅ | ✅ | ✅ | system(인코딩) |
| 제목 | ✅ | ✅ | △(caption/title) | **AI 선채움** |
| 설명/시놉시스 | ○ | ○ | ○ | **AI 선채움** |
| 썸네일 | ✅(contentImg) | ○(clip) | ✖ 미사용 | system/AI |
| 예약·공개일시 | ✅**(강제)** | ○ | ○ | **발행 시점 결정** |
| 태그/해시태그·검색어 | ○ | ○(tags) | — | **AI 선채움** |
| 카테고리 | ✅(clipCategory enum) | 자동(24) | — | AI/자동 |
| 프로그램 연결 | ✅ | ✖ | ✖ | 클립 등록 시 |
| 회차 연결 | ✅ | ✖ | ✖ | 클립 등록 시 |
| 방송일자 | ✅(회차) | ✖ | ✖ | 회차 메타 |
| 시청연령 enum | ✅ | ✖ | ✖ | 프로그램/회차 |
| **프로그램 코드·장르·편성요일·포스터** | ✅**(프로그램 1회)** | ✖ | ✖ | **프로그램 설정** |
| 채널/계정 연결(OAuth) | ✖(내부 피드) | ✅ | ✅ | **계정 1회** |
| 배포 플랫폼 선택 | ✖ | ✖ | ✅(IG/FB) | 발행 시점 |
| 영상 스펙(코덱/길이/비율) | ✖ | ✖ | ✅(차단) | 자동 probe |

✅필수 · ○선택 · △조건부 · ✖해당없음. **굵은 필수**가 "SMR 때문에 미리" 부담의 실체.

---

## 3. 근본 원인 — 왜 SMR이 "다 한 번에"를 강제하나

**구조적(진짜 원인):**
1. **SMR = clip 컬럼에서 직접 생성되는 pull 피드.** `serializeFeedClipMediaInfos`(`xml-serializer.ts:667-728`)가 `<clipmediainfo>`의 모든 태그를 `clips` 행 필드에서 바로 만든다. SMR distribution 행은 **콘텐츠를 안 담고** `isUse/reserveDate/platformIsUse`만 가진다(`distribution.service.ts:90-119`). → 피드가 내보내는 모든 필드는 **발행 전 clip에 이미 있어야** 한다. `clip.entity.ts`는 사실상 SMR `clipmediainfo` 스키마의 거울.
2. **SMR엔 발행 시점 폼이 없다.** 발행 경로가 받는 건 `{channel, reserveDate}`뿐(`smr-admin.ts:789`, `smr/page.tsx:328`). → SMR 필드를 넣을 **유일한 창구가 공유 클립 메타 폼**(`clip-form.tsx`). 그래서 "앞에서 전부".
3. **조용한 읽기-시점 게이트.** `validateClip`이 피드 폴링 때 미완성 clip을 **말없이 드롭**(`smr.ts:250`). 운영자에겐 게시됨으로 보이나 네이버엔 안 뜸 → "전부 미리·정확히"를 방어적으로 강제. (`dev/SMR.md:609`: T6가 안 뜬 실제 원인이 빈 `reservedate`였던 사례.)

**원인이 아닌 것(흔한 오해):**
- ~~하나의 폼이 모든 채널 필드를 모은다~~ — **아님.** YouTube/Meta 필드는 각자 발행 페이지에서 발행 시점에 `distributions.metadata`로 수집(`youtube.ts:265-328`, `meta.ts:247-345`). 클립 폼은 **SMR/clip 전용**.
- ~~SMR 메타 없으면 clip 생성/인코딩 불가~~ — **아님.** `createClip`은 `fileId`만 요구(`smr-admin.ts:556`); 메타는 register-clip 잡이 AI로 자동 채움. 발행 전제는 `status='ready'`(인코딩 완료)뿐.
- ~~한 게이트가 전 채널 검증~~ — **아님.** SMR=피드 읽기 시점, YouTube/Meta=발행 쓰기 시점, 서로 다름.
- 부가: **클립 폼의 실제 하드 필수는 `title`+`programId` 둘뿐**(`clip-form.tsx:252` `canSave`). 나머지 SMR 필드는 "폼에 다 보여서" 부담처럼 느껴지는 것 + 조용한 게이트 때문. (라벨 불일치: `clipCategory` 힌트가 "필수 입력"이라 쓰였지만 실제 강제 안 됨 — `clip-form.tsx:316` vs `validator.ts:165`.)

**한 줄 결론:** SMR은 *clip 컬럼에서 렌더되는 조용한 완결성 게이트를 가진 메타데이터 pull 피드이며 발행 시점 폼이 없다.* 그래서 SMR 필드는 공유 클립 폼에 앞당겨 몰린다 — 항목별로 push하며 발행 시점에 채널 필드를 담는 YouTube/Meta와 정반대.

---

## 4. 공통 vs 채널별 필드 (분리 설계의 축)

- **3채널 공통:** 인코딩 파일, 제목, 설명/시놉시스, 예약·공개일시. (SMR은 clip에, YT/Meta는 `distributions.metadata`에 저장 — 저장 위치만 다름.)
- **SMR+YouTube 공통:** 썸네일(Meta는 커버 미사용).
- **SMR 전용(대부분 AI/자동 or 프로그램 1회):** clipType·clipCategory·targetAge(enum), broadDate, searchKeyword, hashtag, masterClip, startTime/endTime, platformIsUse, 그리고 **프로그램 레벨**(programCode·category·section·weekCode·poster/thumb).
- **YouTube 전용:** 채널 OAuth 연결, categoryId(자동), tags.
- **Meta 전용:** 계정/페이지 OAuth + IG 연결, platforms, caption, shareToFeed, 영상 스펙 검증.

**설계 함의:** "공통(AI 선채움) → 채널 고유(선택 채널만) → 계정/프로그램 1회 설정"의 **3층 분리**가 자연스럽다.

---

## 5. v2 개선 계획

### 5.1 원칙
1. **발행은 대상 채널의 필드만 요구.** YouTube 발행이 SMR 요건에 막히지 않는다.
2. **채널별 필수 필드를 명시적으로 노출**(조용한 드롭 → 보이는 체크리스트). "왜 네이버에 안 뜨나"를 사전에 설명.
3. **무거운 SMR 프로그램 요건은 "프로그램 준비"로 분리** — 클립마다 반복 부담 금지.
4. **공통 필드는 AI 선채움 → 검토/확정**, 채널 고유 필드는 선택한 채널에서만 점진 노출.
5. **정직한 예약**(SMR reserveDate 강제)은 유지·시각화(현 v2가 이미 반영).

### 5.2 추천안 — **채널별 발행 준비도(Readiness) 모델**

하나의 "이 클립 배포" 진입점에서, 채널을 **독립 카드/행**으로 다룬다.

- **채널별 상태 = {미준비 / 준비됨 / 예약됨 / 게시됨 / 실패}.** 데이터는 이미 채널별 행 구조(`distributions` unique `target×channel`, `metadata` jsonb)라 v2 목 모델도 채널별로 둔다.
- **각 채널 카드에 "요건 체크리스트"**: 그 채널이 필요로 하는 필드만, 충족/미충족을 아이콘으로. 미충족이면 인라인으로 채우거나 해당 위치(프로그램 설정/회차/썸네일)로 딥링크.
  - YouTube 카드: 채널 연결·제목(✓ AI) — 보통 즉시 준비됨.
  - Meta 카드: 계정/IG 연결·플랫폼 선택·영상 스펙(세로) — 스펙 미달 시 명확 사유.
  - SMR 카드: 공개일시(필수 입력) + "프로그램 피드 요건"(programCode·장르·편성요일·포스터/썸네일)을 **프로그램 준비 배지**로 요약, 미충족 시 "프로그램 설정에서 완료" 링크. 회차 방송일자·연령, clipType·contentImg는 대부분 자동 충족으로 표시.
- **"준비된 채널만" 개별/일괄 발행.** SMR이 아직 미준비여도 YouTube·Meta는 지금 발행. SMR은 요건 충족 후 별도 발행(또는 예약).
- **공통 필드 1회 편집(AI 선채움 검토) 패널** 상단 + 채널 고유 필드는 아코디언으로 그 채널 선택 시만.

### 5.3 대안
- **대안 A — 채널 탭 단일 폼:** 한 다이얼로그에 공통 + 채널 탭. 변경 작음, 그러나 "준비도/독립 발행" 약함. 조용한 게이트 문제는 탭별 검증 노출로 일부 해소.
- **대안 B — 완전 분리 발행 페이지(원본형 유지):** 채널별 페이지. 결합 최소지만 "이 클립을 배포" 한 동작이 흩어지고, v2가 지향한 통합·계보 가시성과 역행.
- **추천 = 통합 진입점 + 채널별 준비도·독립 발행 + 점진 노출**(A의 단순함 + B의 채널 독립성 결합).

### 5.4 리스크·완화
- **SMR 프로그램 설정을 숨기면 다시 조용한 실패.** → 프로그램 준비 배지 + 발행 시 명시 차단 메시지("이 프로그램은 피드 요건 3개 미충족 → 게시해도 네이버 미노출")로 **가시화**가 핵심.
- **AI 선채움 오류(enum/카테고리).** → enum(clipType/clipCategory/section/targetAge)은 목 데이터에서도 검증 규칙을 그대로 반영, 잘못된 값은 채널 카드에서 경고.
- **데이터 seam 충실도.** v2 목 모델을 실제와 정렬: 채널별 `metadata`(YT/Meta) vs clip 컬럼(SMR), reserveDate 강제, platformIsUse. M6 백엔드 연결 시 매핑 표(§7) 유지.
- **썸네일 채널차(Meta 미사용, T6 숏폼은 커스텀 커버 없음).** 카드에서 채널별로만 노출.
- **범위 크리프.** 이번 계획은 "필드 분리 UX"에 한정 — 실제 발행 API 연동/토큰 플로우는 M6.

---

## 6. 현재 v2 통합 배포 다이얼로그 대비 변경점

현 v2(`src/components/publish-dialog.tsx`, `distribution/page.tsx`):
- 채널 **다중 체크박스** + 즉시/예약 + SMR reserveDate 정직성 노트. 모든 채널을 **균일**하게 취급, 채널 고유 필드/준비도 개념 없음.

변경:
1. 채널을 **체크박스 → 준비도 카드**로. 각 카드에 채널별 요건 체크리스트.
2. **"지금 배포"는 선택 채널 요건만** 요구(전 채널 일괄 강제 아님). 준비된 채널만 활성.
3. **SMR 카드에 프로그램 피드 요건 배지 + 딥링크**, reserveDate는 카드 안 필수 입력으로.
4. 공통 필드(AI 선채움)는 **상단 1회 검토**, 채널 고유는 아코디언.
5. 채널별 상태(`DistributionState.status`)를 카드가 그대로 반영(이미 채널별 모델).

---

## 7. 데이터 seam — 실제 백엔드 매핑(M6 대비)

| v2 개념 | 원본 실체 |
|---|---|
| 채널별 발행 상태 | `distributions` (unique `targetType+targetId+channel`), 상태는 `metadata.uploadStatus ?? (isUse==='Y'?published:pending)` (`schedule/page.tsx:214`) |
| 채널 고유 필드(YT/Meta) | `distributions.metadata` jsonb (`distribution.entity.ts:22`) |
| SMR 필드 | **clip 컬럼**(피드가 여기서 렌더) — metadata 아님 |
| SMR 공개일시 | `distributions.reserveDate` (비면 미게시; 즉시=now 강제) |
| SMR 노출 마스크 | `platformIsUse` 19자리, position-1=네이버 |
| 채널 검증 | SMR=`validateClip/Content/Program`(피드 읽기), YT/Meta=발행 시 route guard |
| 프로그램 피드 요건 | `validateAggregateFeedProgramInfo` (`validator.ts:92`) |

---

## 8. 열린 질문 / 후속
- SMR 프로그램 준비 UI를 **프로그램 화면**에 둘지, 배포 카드 딥링크로만 둘지 (권장: 프로그램 화면에 "SMR 피드 준비" 섹션 + 배포에서 배지·링크).
- YouTube 공개상태 불일치(코드 public vs 문서 private) — v2 카피는 **코드 실동작 기준**으로.
- SFTP-CSV 경로는 원본에서 미배선·컬럼 미확정 → v2 범위 제외(플래그만).
- 목 검증 규칙을 어느 깊이까지 재현할지(enum·형식까지 vs 존재유무만) — 권장: enum·형식까지(조용한 실패 재현 방지 학습 효과).
