# STEP-D 프리미어 패널 (UXP)

프리미어 안에서 **렌더한 완성본을 STEP-D 로 바로 올린다.** 편집자가 하루 두 번 하는 왕복
(프리미어 나가기 → 브라우저 → 파일 찾기 → 드래그)을 없애는 게 이 패널의 첫 값이다.

추천 마커·시퀀스 조작·자동 내보내기는 다음 단계다 —
[docs/plans/active/premiere-plugin-plan.md](../../docs/plans/active/premiere-plugin-plan.md)

## 요구 사항

- Premiere Pro **25.6 이상** (UXP 정식 지원 시작 버전). 개인용 구독으로 충분하다 — 팀/엔터프라이즈 전용 기능을 쓰지 않는다.
- **Adobe UXP Developer Tool (UDT)** — 개발 중 로드용. 무료이고 Creative Cloud 데스크톱 앱에서 설치한다.

> 윈도우1 실측(2026-08-28): Premiere Pro 2026 **26.3.2** 설치됨(조건 충족) · Media Encoder 2026 설치됨
> (나중에 시퀀스 자동 렌더에 쓴다) · **UDT 는 아직 설치 안 됨**.

## 개발 중 로드 (지금 단계)

플러그인은 폴더에 파일을 둔다고 프리미어가 알아보지 않는다 — **UDT 가 프리미어에 등록해 준다.**

1. **UXP Developer Tool 설치** — Creative Cloud 데스크톱 앱 → 검색창에 `UXP Developer Tool`
   → 설치. (Adobe 계정만 있으면 되고 별도 비용 없다)
2. Premiere 를 실행해 둔다. UDT 는 **떠 있는 앱**에만 붙는다.
3. UDT 실행 → 연결 대상이 `Premiere Pro`(26.3.2)로 잡혔는지 확인 → **Add Plugin** →
   이 폴더의 `manifest.json` 선택.
4. 목록의 `STEP-D` 행에서 **Actions ▸ Load**.
5. Premiere 메뉴 **창(Window) ▸ 확장(Extensions) ▸ STEP-D 업로드**.

코드를 고친 뒤에는 UDT 에서 **Reload** 만 누르면 된다 (프리미어 재시작 불필요).

**안 뜰 때 보는 곳** — ① UDT 의 대상 앱이 Premiere 인지(Photoshop 으로 잡혀 있으면 목록에
안 보인다) ② Load 가 실제로 성공했는지(실패하면 UDT 행에 오류가 뜬다 · `manifest.json`
문법 오류가 대표적) ③ 창 ▸ 확장 메뉴에 항목이 없으면 프리미어를 껐다 켜고 다시 Load.

## 쓰는 법

1. 패널에서 STEP-D 계정으로 로그인한다 (stepd.stepai.kr 과 같은 계정).
2. 프로그램을 고르고, 프리미어에서 렌더해 둔 MP4 를 선택한다.
3. **STEP-D 로 업로드** → 끝나면 배포 가능한 클립으로 등록된다. 게시는 웹에서 한다
   (게시는 크레딧·게이트·감사 기록이 걸린 문이라 한 곳에서만 연다).

## 인증 — 왜 이렇게 했나

UXP 는 브라우저가 아니라 **쿠키 저장소가 없다.** fetch 가 `Set-Cookie` 를 보관하지도,
다음 요청에 다시 싣지도 않는다. 그래서 서버가 같은 세션 토큰을 헤더로도 받게 열어 뒀다
(`x-stepd-session` · `apps/server/src/index.ts` 의 `sessionToken()`). 검증 경로는 웹과
똑같은 `resolveSession` 하나이고, 새 자격증명 체계를 만들지 않았다.

**세션이 만료되면 패널이 알아서 다시 로그인한다.** 자격증명은 OS 키체인
(UXP `secureStorage` → Windows DPAPI / macOS Keychain)에 넣고, 어떤 요청이든 401 이 오면
한 번 재로그인해 토큰을 갈아끼우고 그 요청을 재시도한다. 30분짜리 업로드를 마친 뒤
`clip-finalize` 한 줄에서 401 로 전부 날리는 게 가장 뼈아픈 실패라, 그 방어가 목적이다.
재시도는 **한 번뿐**이다 — 비밀번호가 바뀌었으면 로그인도 401 이라 무한 루프가 된다.

API 키는 쓰지 않는다. 키는 테넌트 단위 자격증명이라 "누가 올렸나"가 남지 않고,
`clip-finalize` 는 애초에 키 화이트리스트에 없다.

## 업로드 경로 (서버 API 를 새로 만들지 않았다)

```
POST /api/media/upload-init   → GCS resumable 세션 (mediaId · objectPath · sessionUrl)
PUT  sessionUrl               → 8MB 청크 · 308 이어받기 · 끊기면 커밋 위치 되물어 재개
POST /api/media/clip-finalize → 배포 가능한 클립
```

- 파일은 Cloud Run 을 거치지 않고 **브라우저(패널) → GCS 직행**이다. 32MB 요청 상한·
  600초 타임아웃이 적용되지 않아 몇 GB 완성본도 올라간다.
- 청크 PUT 은 `fetch` 가 아니라 **XHR** 로 보낸다. fetch 는 308(Resume Incomplete)을
  리다이렉트로 삼켜 이어받기 위치를 못 읽는다 (웹 `api.ts putChunk` 도 같은 이유).
- 큰 파일을 통째로 메모리에 올리지 않으려고 UXP `fs` 모듈로 **부분 읽기**를 먼저 시도하고,
  없는 버전에서만 전체 읽기로 물러난다.

## 배포 (파일럿 → 마켓플레이스)

Adobe 플러그인은 세 갈래로 나갈 수 있고, 순서대로 밟는 게 맞다.

| 단계 | 방법 | 필요한 것 | 심사 |
|---|---|---|---|
| **1. 파일럿(지금)** | UDT 로 직접 로드 | 없음 | 없음 |
| **2. 내부 배포** | `.ccx` 패키지를 편집자에게 전달 · Adobe Admin Console 로 조직 배포 | UXP Developer Tool 의 Package 기능 | 없음(사설 배포) |
| **3. 마켓플레이스** | Adobe Exchange 등록 | 아래 절차 | Adobe 심사 |

**마켓플레이스 등록 절차** (3단계에 필요한 것 — 시작 전 준비물):

1. [Adobe Developer Distribution](https://developer.adobe.com/distribute/) 계정 — Adobe ID 로
   가입 후 **개발자/판매자 프로필** 작성. 유료 판매를 하려면 세금·정산 정보까지 필요하다.
2. **플러그인 ID 예약** — `manifest.json` 의 `id`(`kr.stepai.stepd.premiere`)는 등록 후
   바꿀 수 없다. 지금 값을 그대로 가져간다.
3. **패키징** — UDT 에서 `.ccx` 생성. Adobe 가 서명한다(별도 코드서명 인증서 불필요).
4. **리스팅 자료** — 아이콘(다중 해상도) · 스크린샷 · 설명(영문 필수) · 지원 URL ·
   개인정보 처리방침 URL. STEP-D 는 로그인·파일 업로드를 하므로 **처리방침 링크가 사실상 필수**다
   (기존 `stepd.stepai.kr/privacy` 를 쓰되 플러그인이 보내는 데이터를 한 줄 추가해야 한다).
5. **심사 항목** — 네트워크 도메인이 manifest 에 명시돼 있을 것, 자격증명을 평문 저장하지
   말 것, 권한이 기능에 비해 넓지 않을 것. 지금 구현은 이 셋을 이미 만족한다
   (도메인 2개 · secureStorage · `localFileSystem: "request"`).
6. 심사는 보통 **수 영업일**. 반려 사유는 대개 리스팅 자료 미비이지 코드가 아니다.

⚠️ 마켓플레이스는 **공개 배포**다. ENA 같은 특정 고객사만 쓸 거면 2단계(.ccx/Admin Console)로
충분하고 심사도 없다. 3단계는 "아무 방송사나 설치해서 STEP-D 를 쓴다"가 목표일 때 간다.
