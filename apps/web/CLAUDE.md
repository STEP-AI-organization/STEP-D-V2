# apps/web — 프론트엔드 Claude 컨텍스트

Next.js 16 (App Router) · React 19 · TypeScript · **Tailwind v4** · base-ui · lucide-react · recharts

> 2026-07-14 전면 교체. 예전의 `app/components/console/*` + `ConsoleProvider` 구조는 더 이상 없다.
> 인라인 style 객체와 `lib/console/theme.ts`도 없다 — 지금은 Tailwind 클래스를 쓴다.

---

## 라우트 (src/app)

**화면 목록을 여기 적지 않는다.** 정본은
[docs/plans/active/frontend-redesign-handoff.md](../../docs/plans/active/frontend-redesign-handoff.md) §6 하나다.

> ⚠️ 2026-09-14 까지 여기 **13행짜리 표**가 있었는데 실물과 어긋나 있었다 — 개수도 틀렸고
> (`(app)` 만 스물 몇 개다), 표에 있던 `/recommendations`·`/channels` 는 없어진 경로였고,
> `/clips`·`/analytics` 는 화면이 아니라 **이전 안내 페이지**로 바뀐 뒤였다. 루트 `CLAUDE.md`
> 도 같은 자리에서 한 번 틀렸던 적이 있다(거기 주석 참조). 목록을 **두 곳에 두면 반드시**
> 한쪽이 낡는다. 그래서 복제하지 않고 가리킨다.

경로 구조만 적는다 — 이건 파일 배치라 드리프트하지 않는다:

```
(app)/       셸이 붙는 업무 화면 전부. 사이드바 + 헤더 안에서 열린다
(editor)/    풀스크린 편집기(`/editor/:id`) — 셸 없이 화면을 다 쓴다
그 외 최상위  공개 화면: landing · login · register · invite · terms · privacy · data-deletion
```

**함정 셋** (경로가 있다고 화면이 있는 게 아니다):
- `(app)/page.tsx` 는 화면이 아니라 `/dashboard` 로 보내는 **리다이렉트**다.
- `(app)/clips` · `(app)/analytics` 는 **이전 안내**(`MovedNotice`)다 — 기능은 각각 `/media`,
  `/performance` 로 갔다. 바로 리다이렉트하지 않는 건 의도다(북마크를 말없이 옮기지 않으려고).
- 데이터 스토어는 루트 `layout.tsx` 에 있어 `(app)` 과 `(editor)` 가 **같은 것을 공유한다.**

### `(app)/layout.tsx` — 스트랭글러 프레임

디자이너 산출물 이식이 진행 중이라 셸이 두 갈래다. 셸만 먼저 바꾸고 화면을 하나씩 갈아끼운다:

```
이식된 화면  → 페이지가 <Header>·<main>·<Footer> 를 직접 그린다 (디자이너 원문 구조)
미이식 화면  → LegacyFrame 이 옛 상단바·배너·스크롤 컨테이너를 대신 씌운다
```

- 셸은 `components/layout/` 이 **현행**이다. `components/shell/` 에는 아직 쓰는 것
  (`auth-guard`·`topbar`·`connection-banner`·`transfer-center`·`moved-notice`)과
  이식이 끝나 **아무도 안 부르는 것**이 섞여 있다 — 이름이 같은 게 양쪽에 있으니
  (`shell/sidebar` vs `layout/sidebar`) 고치기 전에 어느 쪽이 살아 있는지 확인할 것.
- `CommandPalette` 는 내렸다 — 디자이너 헤더가 Ctrl+K 모달을 들고 와서 둘 다 두면 모달이 두 개 뜬다.

---

## 핵심 파일

| 파일 | 역할 |
|------|------|
| `src/lib/data/store.tsx` | 전역 상태 + 모든 뮤테이션 핸들러. `useAppData()` 를 부르는 파일이 30여 개라 **어느 필드가 바뀌어도 그만큼이 리렌더 후보**다 |
| `src/lib/data/api.ts` | 서버(@stepd/server) HTTP 클라이언트 + 타입. **새 API 함수는 여기에 타입과 함께** |
| `src/lib/data/repository.ts` | **로컬 dev 더미 시드뿐**(`seedInitialData`). 구 SPFN 스텁(`mockRepository`·`activeRepository`)은 제거됐다 |
| `src/lib/data/mock.ts` | 위 시드의 데이터. 프로덕션 번들엔 안 실린다(`layout.tsx` 의 `LOCAL_DUMMY` 분기) |
| `src/lib/types.ts` | 도메인 타입 (Program·Episode·Recommendation·Clip·JobEvent) |
| `src/lib/nav.ts` | 사이드바 정본 — `NAV_GROUPS`(그룹별 항목) · `SCREEN_META`(화면 제목/부제) · `ALL_NAV_ITEMS` |
| `src/lib/auth.tsx` | 세션 Context. **역할이 두 축**(`workspaceRole` 관리 / `role` 운영) — 화면 권한은 후자를 본다 |
| `src/lib/utils.ts` | `cn()` — 모든 ui 프리미티브가 의존 |
| `src/middleware.ts` | 로그인 관문(엣지). 쿠키 **유무**만 보고 `/login` 으로 보낸다 — 검증은 서버 몫 |
| `src/components/ui/` | 프리미티브 — badge · button · card · custom-select · empty-state · section-heading · skeleton · stat-tile · status-badge · table · toast · **tokens.ts** |
| `src/components/layout/` | **현행 셸** — sidebar · header · legacy-frame |
| `src/components/shell/` | 구 셸의 잔존분. 아직 쓰는 것과 죽은 것이 섞여 있다(위 "스트랭글러 프레임" 참조) |
| `src/components/editor/` | 에디터 셸 |
| `src/lib/native-transfers.tsx` | Electron 브리지 감지 + 네이티브 업로드 큐 상태·알림 |

---

## 데이터 흐름 (중요)

`store.tsx`는 **빈 상태(EMPTY_STATE)로 시작**해 기동 시 `fetchState()`가 성공하면 서버 상태로
교체한다 (목 시드 폴백은 제거됨 — 새로고침마다 목 데이터가 번쩍이는 문제 방지).

```
서버 응답 O → 실서버 데이터 + 뮤테이션이 서버로 전송 (serverConnected=true)
서버 응답 X → 빈 상태 유지 + loading 해제 (화면은 빈 목록/스켈레톤)
```

**빈 화면이 "데이터 없음"인지 "서버 미연결"인지 구분할 것** — `NEXT_PUBLIC_API_URL`과
`/api/state` 응답으로 확인. 목 데이터가 보인다면 낡은 빌드다.

새 API 함수는 `lib/data/api.ts`에 타입과 함께 추가하고, 화면은 `store.tsx`의 핸들러를 통해 부른다.

### `fetchState()` 는 `null` 을 돌려줄 수 있다 — 그건 실패가 아니다

스토어는 탭이 열려 있는 내내 서버 상태를 폴링한다(유휴 45초 · 분석 중 8초 · 숨은 탭은 건너뜀).
그런데 `/api/state` 는 **워크스페이스 전체**라, 예전엔 대부분의 틱에서 "아무것도 안 바뀐 전체"가
흘렀다. 프로덕션 웹은 `/api/proxy` 를 거치므로 **그 바이트가 전부 Vercel Fast Origin Transfer 로
과금된다**(2026-08-31 에 표시등 하나가 3시간에 34.5 GB 를 썼다).

2026-09-14 에 두 가지를 같이 넣었다 — **조건부 요청**과 **폴링 경로 분리**. 둘은 짝이다:

```
유휴      → GET /api/state           (전체 · 대부분 304 라 사실상 공짜)
분석 중   → GET /api/state/progress  (회차 pipeline + 잡만 · 작다)
             단계가 바뀐 틱에만 전체를 덧받아 새 추천·클립·미디어를 채운다
             단계가 안 바뀌어도 최소 45초마다 한 번은 전체 — 동료가 바꾼 건 진행률에 안 잡힌다
```

**왜 ETag 만으로는 부족했나:** 8초 틱이 도는 구간은 정확히 **진행률이 매 틱 바뀌는** 구간이라
ETag 가 매번 어긋난다. 조건부 요청이 가장 필요한 곳에서 가장 안 듣는다 — 그래서 그 구간만
작은 응답으로 옮겼다.

### 조건부 요청 규약

```
fetchState() · fetchStateProgress()  →  If-None-Match: <지난 ETag>
                                        200 + 본문  → 새 값 (ETag 갱신)
                                        304         → null  ← "받을 게 없다"
```

- **`null` 을 실패로 취급하지 말 것.** `serverConnected` 를 내리거나 빈 상태로 되돌리면
  45초마다 화면이 깜빡인다. `null` 은 "못 받았다" 가 아니라 "받을 게 없다" 다.
- ETag 는 `api.ts` 모듈 변수에 손으로 들고 다니고, **두 엔드포인트가 각자 따로** 갖는다
  (`stateEtag` · `progressEtag` — 다른 문서라 섞으면 안 된다). 응답이 `no-store` 라 브라우저
  HTTP 캐시가 대신 해 주지 않는다(테넌트 데이터가 중간에 남으면 안 되므로 그대로 둔다).
- 진행률 병합(`applyProgress`)은 **단계 전환 여부를 `setState` 업데이터 밖에서** 판정한다.
  업데이터는 순수해야 하고 StrictMode 가 두 번 부르기 때문 — 직전 상태는 `stateRef` 로 읽는다.
- 서버 쪽 짝은 `apps/server/src/index.ts` 의 `stateResponse()` 와 `db-pg.ts` 의
  `getStateProgress()` 다. 동작 보증은 `src/tests/e2e/api.e2e.ts` 의 "조건부 요청(ETag)" 블록 —
  **진짜 DB 가 있어야 증명되는 것**이라 단위 테스트가 아니라 e2e 에 있다. 거기엔 "진행률 응답이
  전체보다 실제로 작다" 도 들어 있다(작지 않으면 라우트만 하나 늘린 셈이라).

Electron에서 열리면 영상 업로드 다이얼로그는 브라우저 XHR 대신 `window.stepdNative`에 파일과
메타데이터를 넘긴다. 실제 파일 경로·GCS 재개 세션은 웹에 노출하지 않고 `native/`가 보관하며,
일반 브라우저에서는 기존 업로드 경로를 그대로 사용한다.

---

## 규칙

- **스타일:** Tailwind 클래스. 인라인 style 객체 금지. 색은 CSS 변수(`var(--color-*)`, `globals.css`).
- **조합은 `components/ui/tokens.ts` 에서 가져다 쓴다** — 모달 폭·알약 버튼·모달 껍데기·글자 역할(`T.section`·`T.muted` 등). 원본 빈도를 실측해 모은 것이라 직접 적는 것보다 정확하다. 레이아웃 유틸(`flex items-center gap-2`)은 일부러 안 모았다 — 이름으로 감싸면 클래스만 보고 알던 걸 정의를 찾아가야 한다.
- **파란색을 글자에 쓸 땐 hex 금지**, `text-[var(--text-accent)]`(배지 안이면 `--badge-text`). 이 값은 **테마마다 다르다**(라이트 `#1C60FF` · 다크 `#3B82F6`) — 박아두면 다크(기본 테마)에서 대비가 3.31:1 로 떨어진다. 배경·테두리는 두 테마가 같은 값이라 hex 여도 된다. `web-design-tokens.test.ts` 가 막는다.
- **프리미티브 우선:** 새 카드/배지/빈 상태를 직접 만들지 말고 `components/ui/*`를 쓴다.
- **아이콘:** `lucide-react`. `EmptyState`의 `icon` prop은 **컴포넌트**(`icon={Youtube}`)를 받는다 — JSX 엘리먼트 아님.
- **경로 별칭:** `@/*` → `./src/*`.
- **환경변수:** `NEXT_PUBLIC_API_URL` 하나만 쓴다. (`NEXT_PUBLIC_API_BASE_URL`은 구 STEPD 잔재 — 읽지 않음)
- **검증:** `npx next build` — 타입체크·프리렌더까지 여기서 걸린다. `tsc --noEmit`만으로는 부족.
- **테스트:** `pnpm --filter @stepd/web test` (`src/**/*.test.ts` · node:test + tsx).
  루트 `pnpm check` 와 CI 가 같이 돌린다.
  > 2026-09-14 신설. 그전엔 **`test` 스크립트 자체가 없어서** `lib/editor/reframe.test.ts` 가
  > 한 번도 실행된 적이 없었다. 파일이 있다고 도는 게 아니다 — 새 테스트를 넣었으면
  > 관문에서 실제로 도는지 한 번은 눈으로 볼 것.
- `useSearchParams()`를 쓰는 페이지는 반드시 `<Suspense>`로 감쌀 것 (안 그러면 프리렌더 실패).
