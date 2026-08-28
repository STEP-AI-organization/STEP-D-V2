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
2. **프리미어에서 개발자 모드를 켠다 — 이걸 안 하면 아무것도 안 된다.**
   `편집(Edit) ▸ 환경 설정/설정 ▸ 플러그인(Plugins)` → **UXP 플러그인** 그룹의
   **개발자 모드 사용(Enable developer mode)** 체크 → **프리미어 재시작**
   (설정 화면에도 "다음에 Premiere 를 시작할 때 적용됩니다" 라고 쓰여 있다).
   근거: `Adobe Premiere Pro 2026\Settings\EveScripts\UXPPluginsPrefsPanel.adam.eve`
   (`devToolsCheckBox` · `kResDLGEnableDeveloperMode`).
3. UDT 실행 → 연결 대상이 `Premiere Pro`(26.3.2)로 잡혔는지 확인 → **Add Plugin** →
   이 폴더의 `manifest.json` 선택.
4. 목록의 `STEP AI 스튜디오` 행에서 **Actions ▸ Load**.
5. Premiere 메뉴 **창(Window) ▸ 확장(Extensions) ▸ STEP AI 스튜디오**.

코드를 고친 뒤에는 UDT 에서 **Reload** 만 누르면 된다 (프리미어 재시작 불필요).

**안 뜰 때 보는 곳**

| 증상 | 원인 | 조치 |
|---|---|---|
| `Plugin Load Failed. No applications are connected to the service.` | **프리미어 개발자 모드가 꺼져 있다** (2026-08-28 실측 원인) | 위 2번 → 프리미어 재시작 |
| 위를 켰는데도 같은 오류 | 재시작을 안 했다 | 프리미어 완전 종료 후 재실행 |
| UDT 목록에 대상 앱이 Photoshop 등으로 잡힘 | 연결된 앱이 여럿 | UDT 에서 대상을 Premiere Pro 로 |
| Load 는 성공했는데 창 ▸ 확장에 없음 | 패널 등록이 늦게 반영 | 프리미어 재실행 후 다시 Load |
| Load 자체가 오류 | `manifest.json` 문법·필드 오류 | UDT 행의 오류 메시지 확인 |

**밖에서 연결 상태를 확인하는 법** — UDT 는 개발자 서비스를 `127.0.0.1:14001` 에 띄운다.
프리미어가 붙었는지는 그 포트의 연결을 보면 된다:

```powershell
Get-NetTCPConnection -LocalPort 14001    # Established 가 UDT 자신(cli) 하나뿐이면 앱 미연결
```

UDT 로그(`%APPDATA%\Adobe\Adobe UXP Developer Tool\Logs\appLogs-*.log`)에
`New Server client Connected : Type : cli` 만 있고 앱 연결이 없으면 같은 상태다.
⚠️ 프리미어와 UDT 의 **실행 순서는 원인이 아니다** — 개발자 모드가 켜져 있으면
프리미어가 켜질 때 서비스에 붙는다. (처음엔 순서를 의심했으나 로그가 아니라고 말했다)

## 쓰는 법

1. 패널에서 STEP-D 계정으로 로그인한다 (stepd.stepai.kr 과 같은 계정).
2. 프로그램을 고르고, 프리미어에서 렌더해 둔 MP4 를 선택한다.
3. **STEP-D 로 업로드** → 끝나면 배포 가능한 클립으로 등록된다. 게시는 웹에서 한다
   (게시는 크레딧·게이트·감사 기록이 걸린 문이라 한 곳에서만 연다).

## `manifest.json` 하나로 패널이 뜨는 원리

프리미어 안에는 **UXP 런타임**(브라우저 비슷한 실행기)이 들어 있다. 우리 패널은 그 위에서
도는 샌드박스 웹앱이고, `manifest.json` 은 그 앱의 **신분증이자 계약서**다. 프리미어는
코드를 실행하기 **전에** 이 JSON 만 읽어서 네 가지를 판단한다:

| 선언 | 필드 | 프리미어가 하는 일 |
|---|---|---|
| 누구인가 | `id` · `name` · `version` | `id` 로 플러그인을 식별·중복 방지(마켓 등록 후 변경 불가). `name` 이 UDT·설치 목록에 보인다 |
| 어디에 붙는가 | `host: [{ app: "premierepro", minVersion }]` | 이 앱·버전이 아니면 **아예 목록에 안 띄운다**. 버전이 낮으면 로드 거부 |
| 무엇을 띄우는가 | `entrypoints: [{ type: "panel", id, label }]` | `label` 이 **창 ▸ 확장 메뉴에 뜨는 이름**. 패널을 열면 `main`(=`index.html`)을 로드하고, 그 안의 `main.js` 가 돈다 |
| 무엇을 할 수 있는가 | `requiredPermissions` | **선언한 것만 허용.** `network.domains` 에 없는 주소는 fetch 가 막힌다(그래서 GCS 도메인을 적어 뒀다). `localFileSystem: "request"` 는 "사용자가 고른 파일만" 이라는 뜻 |

즉 **JSON 이 플러그인을 띄우는 게 아니라, JSON 이 "무엇을 어디에 어떤 권한으로 띄울지"를
선언하고 프리미어가 그대로 실행해 주는 것**이다. 코드를 돌려 보지 않고도 호환성과 권한을
검사할 수 있어야 하니 선언을 코드 밖 JSON 으로 분리해 둔 것이고, 마켓 심사도 이 파일을 본다.

로드 방식 둘은 **결국 같은 절차**다 — 둘 다 이 매니페스트를 읽는다:

- **UDT Load** = "이 폴더에 매니페스트가 있다" 고 프리미어에 알려 주는 임시 등록(개발용)
- **`.ccx` 설치** = 같은 폴더를 압축·서명한 것 → 영구 설치(배포용)

그래서 개발 중에는 파일만 고치고 **Reload** 하면 되고, 매니페스트를 고쳤을 때만
언로드→다시 Load 가 필요하다.

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

## UXP 와 "마켓에 뜨는 플러그인" 은 다른 것인가

**다른 게 아니라 층이 다르다.** UXP 는 *무엇으로 만들었나*(기술), 마켓플레이스는
*어떻게 나눠주나*(유통 경로)다. 우리가 만든 UXP 패널이 곧 마켓에 올라갈 그 물건이고,
포장(`.ccx`)만 바꾸면 된다.

헷갈리는 진짜 이유는 **프리미어 마켓 진열대에 성격이 다른 네 가지가 같이 있어서**다:

| 마켓에 보이는 것 | 실제 정체 | 우리와의 관계 |
|---|---|---|
| CEP 패널 | 구세대 HTML 패널 기술 | 프리미어는 UXP 를 **25.6(2025)에서야** 받았다 — 지금 마켓의 프리미어 패널 상당수가 아직 이것 |
| **UXP 패널** | 신세대 · Adobe 의 진행 방향 | **우리 것** |
| 네이티브 이펙트 | C++ SDK (Magic Bullet 류 색보정·뷰티 필터) | 패널이 아니라 *효과* 목록에 뜬다. UXP 로는 못 만들고, 만들 이유도 없다 |
| MOGRT · 프리셋 팩 | 코드가 아니라 템플릿 파일 | 무관 |

그래서 "마켓 플러그인" 이라는 한 종류가 따로 있는 게 아니다. 우리는 그중 UXP 패널을
만들었고, 그대로 마켓에 낼 수 있다.

⚠️ 다만 **지금의 UDT 로드는 '설치' 가 아니다.** 개발용 임시 등록이라 그 PC에서만 유효하고,
프리미어를 껐다 켜면 다시 Load 해야 한다. 편집자에게 넘길 때는 `.ccx` 로 포장해야
영구 설치가 된다(아래).

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
