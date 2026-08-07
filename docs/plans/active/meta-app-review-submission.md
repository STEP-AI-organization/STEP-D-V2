# 메타 앱 검수(App Review) 제출 준비 체크리스트
### 인스타그램 · 페이스북 영상 자동배포 AI SaaS

> 목적: 여러 고객 계정에 대신 영상(릴스 포함)을 자동 게시하는 SaaS 기준.
> 이 경우 **Advanced Access + 정식 App Review**가 필수입니다.
> 아래 영문 문구는 메타 제출 폼에 **그대로 복붙**할 수 있게 작성했고, 국문은 설명입니다.
> (메타 리뷰어는 영어로 심사하므로 제출은 영문으로 하세요.)

---

## 0. 진행 순서 요약 (병목 순)

```
① 비즈니스 인증(Business Verification)  ← 제일 오래 걸림, 무조건 먼저
② 앱 라이브 모드 전환
③ 개인정보처리방침 URL + 데이터 삭제 URL 준비
④ 핵심 기능(영상 자동배포) 실제 구현 (시연 가능해야 함)
⑤ 권한별 사용 사유 작성 + 스크린캐스트 녹화
⑥ 권한별로 App Review 제출 (권한당 2~4주 심사)
```

핵심 원칙: **"안 쓰는 권한은 절대 미리 신청하지 않는다."** 과다 신청이 최대 반려 사유입니다. 대신 비즈니스 인증을 미리 통과시켜 두는 게 진짜 "넉넉한 준비"입니다.

---

## 1. 제출 전 사전 준비 체크리스트

- [ ] **비즈니스 인증 완료** — 사업자등록증/법인 서류, 회사 도메인 이메일, 사업장 주소·전화 검증. 통과까지 며칠~2주 걸릴 수 있으니 **가장 먼저** 시작.
- [ ] **앱을 Live 모드로 전환** — 개발 모드로는 Advanced Access 제출 불가.
- [ ] **개인정보처리방침 URL** — 회사 도메인에 HTTPS로 호스팅 (2번 항목 참고).
- [ ] **데이터 삭제 요청 URL(Data Deletion Callback/Instructions URL)** — Facebook Login 앱은 **없으면 자동 반려**.
- [ ] **앱 도메인 / 유효 OAuth 리디렉션 URI** 등록.
- [ ] **앱 아이콘·이름·카테고리** 설정 (실서비스처럼 보여야 함).
- [ ] **테스트용 실제 인스타 비즈니스 계정** 준비 (스크린캐스트용, 더미/테스트유저 금지).
- [ ] 연결 대상 계정 조건 확인: 페북 계정 + 페북 페이지 + 인스타 **프로페셔널(비즈니스/크리에이터)** + 페이지에 연결.

---

## 2. 신청할 권한 세트 (영상 배포 SaaS 풀세트)

| 권한 | 용도 | Access 등급 |
|---|---|---|
| `instagram_business_basic` | 계정 기본정보 (다른 권한 전제조건) | Advanced |
| `instagram_business_content_publish` | 인스타 피드/릴스 게시 | Advanced |
| `pages_show_list` | 연결된 페북 페이지 목록 조회 | Advanced |
| `pages_manage_posts` | 페북 페이지에 영상 게시 | Advanced |
| `pages_read_engagement` | 페이지 상태/메타데이터 읽기 (게시 흐름에 필요) | Advanced |
| `business_management` | (선택) 여러 자산·계정 관리 시 | Advanced |

> ⚠️ 이 세트에서 더 늘리지 마세요. 승인률이 떨어집니다.
> Instagram Login 방식과 Facebook Login 방식은 권한 이름이 다릅니다. 위 표는 **Instagram Login(권장, 2024.7 이후)** 기준이며, Facebook Login 방식이면 `instagram_content_publish` + `instagram_basic`을 쓰세요.

---

## 3. 권한별 사용 사유 문구 (제출 폼에 복붙)

> 아래 `[App Name]`, `[Company]`, 기능 명칭만 실제 값으로 바꿔 넣으세요.

### 3-1. `instagram_business_basic`
**EN (paste this):**
> Our app, [App Name], is a scheduling and auto-publishing tool for businesses and creators. We use `instagram_business_basic` to retrieve the connected Instagram Business account's ID, username, and profile details after the user authenticates. This lets the user confirm which account they are connecting and lets us display the correct account inside our dashboard before they schedule or publish content. Without this permission we cannot identify the target account for publishing.

**국문 설명:** 인증한 사용자의 인스타 비즈니스 계정 ID·유저네임·프로필을 불러와 "어느 계정에 올릴지" 대시보드에 표시하는 용도. 다른 권한의 전제조건.

### 3-2. `instagram_business_content_publish`
**EN (paste this):**
> [App Name] lets users schedule and automatically publish videos, Reels, and image posts to their own Instagram Business accounts. We use `instagram_business_content_publish` to create media containers and publish them to the account the user has connected and authorized. Publishing is always initiated by the account owner through our scheduling interface. This permission is the core function of our product; without it users cannot publish the content they create in our app.

**국문 설명:** 앱의 핵심 기능. 미디어 컨테이너 생성 → 발행. "사용자가 직접 예약/승인한 게시"라는 점을 반드시 강조 (자동 스팸 아님을 어필).

### 3-3. `pages_show_list`
**EN (paste this):**
> We use `pages_show_list` to display the list of Facebook Pages the user manages so they can select which Page (and its linked Instagram account) to publish to. This selection step happens right after login, before any content is scheduled.

**국문 설명:** 사용자가 관리하는 페북 페이지 목록을 보여주고 "어느 페이지에 올릴지" 선택하게 하는 용도.

### 3-4. `pages_manage_posts`
**EN (paste this):**
> [App Name] uses `pages_manage_posts` to publish and schedule video and image posts to the Facebook Pages that the user manages and has explicitly selected. All posts are created from content the user uploads and approves within our app. This permission enables the Facebook side of our cross-posting feature (Instagram + Facebook).

**국문 설명:** 페북 페이지에 실제로 영상/이미지를 게시하는 권한. 인스타+페북 동시 배포 기능의 페북 쪽.

### 3-5. `pages_read_engagement`
**EN (paste this):**
> We use `pages_read_engagement` to read the metadata and connection status of the Pages the user selected (for example, to verify the Page is correctly linked to an Instagram professional account and is eligible for publishing). This ensures our publishing flow does not fail silently and gives users clear connection status in the dashboard.

**국문 설명:** 선택한 페이지의 연결 상태/메타데이터를 읽어 "게시 가능한 상태인지" 검증하는 용도. 게시 실패 방지.

### 3-6. `business_management` (선택 — 실제로 쓸 때만)
**EN (paste this):**
> [App Name] manages publishing across multiple Pages and Instagram accounts that belong to a single business customer. We use `business_management` to let the customer's admin select and manage the business assets connected to our app in one place. We only access assets the customer has explicitly granted.

**국문 설명:** 한 고객이 여러 자산(페이지·계정)을 한 곳에서 관리하는 기능이 **실제로 있을 때만** 신청. 없으면 빼세요.

---

## 4. 스크린캐스트(시연 영상) 시나리오

권한마다 **별도 영상**이 필요합니다. 리뷰어가 반드시 봐야 하는 3요소를 매 영상에 포함하세요:
**① 실제 비즈니스 계정 로그인 → ② OAuth 동의 화면이 화면에 뜨는 장면 → ③ 그 권한 데이터/기능이 앱 화면에서 실제 동작.**

### 공통 녹화 규칙
- [ ] 화면 해상도 선명하게, 영어 자막 또는 영어 나레이션 권장.
- [ ] **테스트 유저 말고 진짜 인스타 비즈니스 계정** 사용.
- [ ] 동의 화면에서 **해당 권한 항목이 보이는 것**을 클로즈업.
- [ ] 더미/목업 화면 금지 — 실제 앱 UI여야 함.

### 게시 권한(content_publish / pages_manage_posts) 시연 스텝 (예시)
1. 앱 랜딩 → "Connect Instagram / Facebook" 클릭
2. 페이스북 로그인 → **권한 동의 화면 노출 (권한 항목 보이게)**
3. 관리하는 페이지/인스타 계정 목록에서 대상 선택
4. 영상 업로드 → 캡션 입력 → "예약" 또는 "지금 게시" 클릭
5. **실제로 인스타/페북에 게시물이 올라간 것**을 앱 안 또는 실제 계정에서 확인
6. (예약 기능이면) 예약 목록에 뜨는 것 + 발행 완료 상태까지

---

## 5. 개인정보처리방침에 반드시 들어갈 항목

- [ ] 수집하는 데이터 종류 (인스타/페북 계정 정보, 게시 콘텐츠, 토큰 등)
- [ ] **사용 목적** (게시/예약 기능 제공)
- [ ] **보관 기간** 및 **삭제 절차**
- [ ] 제3자 공유 여부 (Meta 플랫폼과의 관계 명시)
- [ ] **데이터 삭제 요청 방법** (데이터 삭제 URL과 일치해야 함)
- [ ] 연락처 (회사 이메일/주소)
- [ ] HTTPS로 빠르게 로딩될 것, 신청 권한과 내용이 **일치**할 것

---

## 6. 흔한 반려 사유 & 회피 팁

| 반려 사유 | 회피법 |
|---|---|
| 권한 과다 신청 | 위 2번 세트만. 안 쓰는 권한 절대 금지 |
| 비즈니스 인증 미완료 상태로 제출 | 인증 통과 후 제출 |
| 스크린캐스트에 동의 화면·실사용 장면 없음 | 3요소 모두 포함 |
| 데이터 삭제 URL 없음 (FB Login) | 반드시 등록 |
| 개인정보처리방침이 신청 권한과 불일치 | 권한 목록과 정책 내용 맞추기 |
| 나레이션/설명 없는 영상 | 영어 자막·설명 추가 |
| 테스트 유저로 시연 | 실제 비즈니스 계정 사용 |

---

## 7. 최종 제출 체크리스트

- [ ] 비즈니스 인증 통과됨
- [ ] 앱 Live 모드
- [ ] 개인정보처리방침 URL 등록 & 접속됨
- [ ] 데이터 삭제 URL 등록
- [ ] 핵심 기능 구현 완료 (시연 가능)
- [ ] 권한별 사용 사유 작성 (3번 문구)
- [ ] 권한별 스크린캐스트 녹화 완료
- [ ] 각 권한 App Review 제출
- [ ] 심사 대기 (권한당 2~4주), 반려 시 수정 후 재제출

---

## 참고: 용량(Rate Limit) — 미리 신청하는 게 아님
- 앱 전체 한도 = **200 × 활성 사용자 수** (60분 롤링). 고객 늘면 자동 증가.
- 계정당 게시 = **24시간 50건** 하드 캡 (증설 불가).
- 확장은 웹훅 · 큐 · 백오프 · 캐싱 같은 아키텍처로 해결.

---
*작성 기준: 2026년 8월. 메타 정책은 수시로 바뀌니 제출 직전 developers.facebook.com 문서로 권한 이름을 재확인하세요.*
