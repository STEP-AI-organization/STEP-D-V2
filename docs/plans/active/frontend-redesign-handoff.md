# 프론트 재개편 — 디자이너 산출물 이식 규격

> 상태: **진행 중** (2026-09-03 작성) · 대상: `apps/web`
> 디자이너가 AI 스튜디오로 바이브코딩한 UI 를 받아 현행 프론트를 재개편한다.
> 이 문서는 **전달한 브리프의 정본**이자 **받은 뒤 이식하는 절차**다.

## 0. 한 줄 요약

**바꾸는 건 표현 계층뿐이다.** API 클라이언트·프록시·업로드·편집기는 그대로 산다.
디자이너 산출물은 "화면이 어떻게 보이는가" 만 정하고, "데이터가 어디서 오는가" 는 우리가 이미 갖고 있다.

---

## 1. 디자이너에게 전달한 브리프 (원문 · 2026-08-25 전달)

```
STEP D 프론트 기술스택

프레임워크
- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind CSS v4 (v3 아님)

라이브러리 (이것만 사용)
- UI 컴포넌트: @base-ui/react (headless) — MUI·shadcn·Chakra·Ant ❌
- 아이콘: lucide-react — SVG 직접 그리기 ❌
- 차트: recharts
- 패널 분할: react-resizable-panels

작업 시 지켜주실 것
1. 스타일은 Tailwind 클래스로만 — 인라인 style, styled-components, emotion, 별도 CSS 파일 ❌
2. 색상은 hex 직접 박지 말고 CSS 변수 토큰으로 (예: var(--color-accent))
3. 다크 테마 기준으로 디자인
4. 데이터는 전부 목(mock)으로 — API 연동은 저희가 합니다
5. AI 스튜디오 기본 산출물(단일 App.tsx) 형태 그대로 주셔도 됩니다.
   위 1~2번만 지켜지면 저희가 이식합니다
```

### 리포 실측 대조 — **전부 일치한다** (2026-09-03 `apps/web/package.json` 확인)

| 브리프 | 실제 | |
|---|---|---|
| Next.js 16 | `next` **16.2.3** | ✅ |
| React 19 | `react` **19.2.3** | ✅ |
| TypeScript | `typescript` **5.7.2** | ✅ |
| Tailwind v4 | `tailwindcss` **^4.3.2** (+ `@tailwindcss/postcss`) | ✅ |
| @base-ui/react | **^1.3.0** | ✅ |
| lucide-react | **^0.577.0** | ✅ |
| recharts | **^3.9.2** | ✅ |
| react-resizable-panels | **^4.7.6** | ✅ |

브리프와 리포가 어긋난 항목은 **없다.** (산출물이 도착한 뒤에 스택 불일치를 발견하는 게
최악이라 먼저 대조했다.)

### 브리프에 안 적었지만 우리가 쓰는 것

디자이너가 몰라도 되지만 **이식하는 사람은 알아야 한다.**

| 패키지 | 용도 |
|---|---|
| `clsx` + `tailwind-merge` | `cn()` 헬퍼 (`src/lib/utils.ts`) — 클래스 병합. 산출물의 `className={...}` 조건부 조합은 전부 이걸로 바꾼다 |
| `class-variance-authority` | 버튼·뱃지 같은 변형(variant) 정의 |
| `tw-animate-css` | 애니메이션 유틸 (globals.css 에서 import) |
| `@portone/browser-sdk` | 결제창 |
| `exceljs` · `jspdf` | 내보내기 |
| `@stepd/native` | Electron 브리지 타입 (`workspace:*`) |

---

## 2. 디자인 토큰 — **바뀔 일 없음. 산출물이 여기 맞춘다**

정의 위치: **`apps/web/src/app/globals.css`** (538줄, 단일 파일)

구조:
```
@import "tailwindcss";  @import "tw-animate-css";
@custom-variant dark (&:is(.dark *));
@font-face × 11            ← 한글 웹폰트
:root { … }   .dark { … }  ← ① 시맨틱 토큰 (shadcn 계열)
@theme inline { … }        ← Tailwind v4 매핑 (--color-* 로 노출)
@layer base / components
:root { --sd-* … }  .dark { --sd-* … }  ← ② STEP D 토큰
```

### ① 시맨틱 토큰 — Tailwind 클래스로 바로 쓴다

`@theme inline` 이 `--color-*` 로 매핑하므로 **`bg-background` `text-muted-foreground`
`border-border` 처럼 클래스로 쓰면 된다.** `var()` 를 직접 쓸 일이 거의 없다.

```
background  foreground  card  card-foreground  popover  popover-foreground
primary     primary-foreground    secondary  secondary-foreground
muted       muted-foreground      accent     accent-foreground
destructive destructive-foreground
border  input  ring  brand  elevated  panel
status-idle  status-progress  status-done  status-warn  status-error
radius(-sm/-md/-lg/-xl)   font-sans  font-display  font-mono
```

### ② `--sd-*` 토큰 — Review OS 전용. `var(--sd-…)` 로 쓴다

```
색   sd-accent(-hover/-ring/-bg/-border)  sd-fg  sd-mut  sd-label
면   sd-bg  sd-card  sd-card-sub  sd-app-bg  sd-border  sd-divider
셸   sd-sidebar-bg  sd-sidebar-border  sd-nav-fg
폼   sd-control(-hover/-border/-border-hover)  sd-placeholder-a/-b
상태 sd-ok  sd-warn(-fg/-bg/-border)  sd-danger(-bg/-border/-strong)  sd-idle
기타 sd-on-accent  sd-on-danger  sd-chart  sd-serif  sd-mono
```

### ⚠️ 토큰을 써야 하는 **진짜 이유** — 라이트 테마

앱은 **기본 다크**지만 **테마 토글이 실제로 있다**(`components/theme-toggle.tsx` ·
커맨드 팔레트 · `localStorage['stepd-theme']`). `layout.tsx` 가 첫 페인트 전에 클래스를 건다.

> 토큰만 쓰면 **라이트는 공짜로 따라온다** (`:root` / `.dark` 양쪽에 값이 이미 있다).
> **hex 를 박으면 라이트에서 깨진다** — 그리고 다크로 개발하는 동안 아무도 눈치채지 못한다.

브리프 2번이 지켜졌는지가 이식 난이도를 통째로 가른다. 산출물을 받으면 **제일 먼저
hex 리터럴을 grep** 할 것.

---

## 3. 경계 — 디자이너 몫 vs 우리 몫

`apps/web` 은 133파일 **39,008줄**이다. 이 중 디자인이 손댈 곳은 일부다.

| 영역 | 줄 | 누구 |
|---|---|---|
| 화면·컴포넌트 (표현) | 나머지 | **디자이너 → 이식** |
| `lib/data` (API 클라이언트·스토어) | 4,665 · **API 함수 155개** | **우리 (그대로 유지)** |
| 편집기 `components/editor` + `lib/editor` | 7,704 | **우리 (그대로 유지)** |
| `app/api/*` (proxy · render-proxy · app-version) | 225 | **우리 (건드리지 말 것)** |

### 🚫 절대 갈아엎으면 안 되는 글루

목업에는 **흔적조차 없는데** 없으면 제품이 죽는다. 전부 사고를 겪고 얻은 코드다.

| 파일 | 없으면 나는 일 |
|---|---|
| `app/api/proxy` + `lib/proxy-headers.ts` | 홉바이홉 헤더가 통과해 **삭제·저장이 `fetch failed`** (2026-08-28) |
| `lib/gcp-auth.ts` | 프로덕션 웹→서버 ID 토큰. 없으면 전부 401 |
| `lib/data/api.ts` 의 헤더 규칙 | 외부 고객사는 `Authorization` 이 덮여서 **`x-api-key` 로** 붙어야 한다 |
| `lib/upload-tracker.ts` · `lib/native-transfers.tsx` | GCS resumable 업로드 · Electron 영속 업로드 큐 |
| `lib/editor/aspect-presets.ts` | 서버 미러와 **바이트 동일** 유지 대상 |
| 응답 크기 규율 | 웹은 `/api/proxy` 경유라 **서버가 보내는 바이트가 곧 Vercel 과금** (하루 276GB→6.6GB 줄인 건) |

**규칙: 새 UI 는 기존 `lib/data` 함수를 호출한다. 새로 fetch 를 짜지 않는다.**

---

## 4. 이식 절차 (단일 `App.tsx` → `apps/web`)

산출물은 AI 스튜디오 기본형(단일 파일 + 목 데이터)으로 온다고 합의했다.

1. **검수** — `style={{`, `styled`, hex 리터럴(`#[0-9a-f]{3,8}`), 브리프 외 패키지 import 를 grep.
   나오면 이식 전에 치환한다(나중에 찾으면 30배 비싸다).
2. **분해** — 단일 `App.tsx` 를 화면 단위로 자른다 → `src/app/(app)/<route>/page.tsx`.
3. **프리미티브 치환** — 산출물의 자체 버튼·모달·드롭다운을 `@base-ui/react` 기반
   기존 프리미티브로 바꾼다. 접근성·키보드·포커스 트랩이 거기 들어 있다.
4. **토큰 매핑** — 남은 색을 §2 토큰으로. 클래스로 되는 건 클래스로.
5. **목 → 실데이터** — 목 배열을 `lib/data` 의 해당 함수로 교체.
   **이 단계에서 화면이 조용히 안 채워지는 게 이 리포 최빈 실패**다(§5).
6. **검증** — `pnpm check` (타입 + 서버/네이티브 테스트) → 화면에 실제 값이 뜨는지 눈으로.
   `pnpm lint` 는 아직 기존 오류가 있어 `check` 에서 빠져 있다.

### 새 화면을 추가할 때

`src/app/(app)/<route>/page.tsx` + **`src/lib/nav.ts` 의 `NAV` 배열에 항목 추가**.
빼먹으면 화면은 있는데 아무도 못 간다.

---

## 5. 개편 내내 살아 있어야 하는 안전벨트

`apps/server/src/tests/` 에 **web 을 가로질러 검사하는 테스트 9개**가 있다.
전면 개편은 이들이 잡는 사고가 대량으로 나는 작업이라, **개편 중에 더 중요하다.**

| 테스트 | 지키는 것 |
|---|---|
| `web-routes-exist` | 웹이 부르는 경로가 서버에 실제로 있는지 |
| `analytics-reach` | *"모은 것이 화면까지 닿는가 — **이 리포에서 제일 자주 나는 실패 방식**"* |
| `chatbot-catalog` | 챗봇 화면 카탈로그 == 실제 화면 목록 |
| `api-keys` | 회사별 격리 (*"뚫리면 남의 회사 데이터가 통째로 나간다"*) |
| `proxy-headers` | 홉바이홉 제거 (`fetch failed` 재발 방지) |
| `automation-layout-parity` | 화면 필드 ↔ 저장 화이트리스트 |
| `caption-font` · `ops-role` · `premiere-session` | 서체·역할·인증 표면 |

> 화면을 지우거나 이름을 바꾸면 `chatbot-catalog`·`web-routes-exist` 가 깨진다.
> **숫자를 지우지 말고 원인을 고칠 것** — 그게 이 테스트들의 존재 이유다.

---

## 6. 화면 인벤토리 — **35개** (2026-09-03 실측)

⚠️ CLAUDE.md 에는 오래 "(app) 그룹 9개" 로 적혀 있었다. **실제는 (app) 27개**다.
개편 범위를 9개로 잡으면 3분의 1만 보고 계획하는 셈이라 여기 실물을 박아둔다.

**(app) 27** — `/` · analytics · analyze · assets · automation · business ·
channel-analytics · clips · commerce · credits · dashboard · distribution · edits ·
`episodes/[id]` · media · ops · performance · program-analytics · programs ·
`programs/[id]` · `programs/[id]/highlights` · `programs/[id]/settings` ·
publish-channels · reframe-lab · search · thumbnails · trends

**(editor) 1** — `editor/[id]` (풀스크린 · 7,704줄 · **재개편 대상 아님**)

**공개 7** — landing · login · register · invite · terms · privacy · data-deletion

---

## 7. 리포 분리는 **하지 않는다** (2026-09-03 검토 결론)

"프론트/백을 리포로 쪼개자" 를 검토했고 **안 하기로 했다.** 근거:

- **결합이 실측으로 높다.** 최근 300커밋 중 `apps/web` 을 건드린 94개 가운데
  **60개(64%)가 `apps/server` 를 같이 수정**했다. 쪼개면 그 60개가 크로스리포 PR 쌍이 된다.
- **얻을 게 이미 없다.** 독립 배포는 이미 된다 — 웹 Vercel · 서버 Cloud Run ·
  어드민 별도 Vercel. 리포를 쪼개도 배포는 하나도 안 바뀐다.
- **잃는 게 크다.** §5 의 테스트 9개를 못 돌린다. 하필 전면 개편 중에.
- **미러가 늘어난다.** 지금 웹이 서버 코드를 실제로 import 하는 건 `automation.ts`
  (import 0개 순수 모듈) **하나뿐**인데, 쪼개면 이게 강제로 미러가 된다.
  자동배포 화면 주석에 이미 답이 있다 — *"미러가 한 번 어긋나면 화면이 조용히
  거짓 약속을 하게 된다."*
- 개발자가 혼자라 팀 경계 이득도 없다.

**나중에 정말 쪼갤 일이 생기면** 먼저 `packages/shared` 로 계약(`automation.ts` ·
`aspect-presets.ts` · 라우트 매니페스트)을 뽑는다. 그건 분리를 안 해도 지금 이득이고
(`aspect-presets` 의 "바이트 동일" 위험이 사라진다), 분리 비용도 크게 준다.

---

## 관련

- [apps/web/CLAUDE.md](../../../apps/web/CLAUDE.md) — 프론트 상세 규칙
- `apps/web/src/app/globals.css` — 토큰 정본
- `apps/web/src/lib/nav.ts` — 화면 등록
- `apps/web/src/lib/data/api.ts` — API 계약 (155 함수)
