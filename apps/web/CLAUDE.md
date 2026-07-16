# apps/web — 프론트엔드 Claude 컨텍스트

Next.js 16 (App Router) · React 19 · TypeScript · **Tailwind v4** · base-ui · lucide-react · recharts

> 2026-07-14 전면 교체. 예전의 `app/components/console/*` + `ConsoleProvider` 구조는 더 이상 없다.
> 인라인 style 객체와 `lib/console/theme.ts`도 없다 — 지금은 Tailwind 클래스를 쓴다.

---

## 라우트 (src/app)

| 경로 | 파일 | 화면 |
|------|------|------|
| `/` | `(app)/page.tsx` | 오늘 할 일 (Inbox) |
| `/programs` | `(app)/programs/` | 콘텐츠 — 프로그램·회차 |
| `/episodes/:id` | `(app)/episodes/[id]/` | 회차 상세 (파이프라인 허브) |
| `/recommendations` | `(app)/recommendations/` | 추천 & 채택 보드 |
| `/clips` | `(app)/clips/` | 클립 |
| `/distribution` | `(app)/distribution/` | 배포 |
| `/analytics` | `(app)/analytics/` | 성과 |
| `/channels` | `(app)/channels/` | 채널 트렌드 |
| `/publish-channels` | `(app)/publish-channels/` | 배포채널 (YouTube 채널 연동) |
| `/editor/:id` | `(editor)/editor/[id]/` | 풀스크린 에디터 |
| `/landing` | `landing/` | 마케팅 랜딩 (구 STEPD에서 보존) |
| `/register` | `register/` | 외부 협력자 YouTube 채널 등록 |

`(app)` 그룹은 `(app)/layout.tsx`가 `AppShell`(사이드바+상단바) + `CommandPalette`로 감싼다.
`(editor)` 그룹은 셸 없이 풀스크린. 데이터 스토어는 루트 `layout.tsx`에 있어 두 그룹이 공유한다.

---

## 핵심 파일

| 파일 | 역할 |
|------|------|
| `src/lib/data/store.tsx` | 전역 상태 + 모든 뮤테이션 핸들러 (`useAppData()`) |
| `src/lib/data/api.ts` | 서버(@stepd/server) HTTP 클라이언트 + 타입 |
| `src/lib/data/repository.ts` | 목 폴백 seam. `apiRepository`는 폐기된 SPFN 통합 스텁(미호출) — 실 연동은 `api.ts`. |
| `src/lib/data/mock.ts` | 목 시드 데이터 |
| `src/lib/types.ts` | 도메인 타입 (Program·Episode·Recommendation·Clip·JobEvent) |
| `src/lib/nav.ts` | 사이드바 8개 메뉴 정의 (`NAV`, 역할별 필터) |
| `src/lib/utils.ts` | `cn()` — 모든 ui 프리미티브가 의존 |
| `src/components/ui/` | 디자인 시스템 프리미티브 (Card·Button·Table·EmptyState·StatTile·StatusBadge·PageHeader·Toast) |
| `src/components/shell/` | AppShell·Sidebar·Topbar·JobCenter·CommandPalette |
| `src/components/editor/` | 에디터 셸 |

---

## 데이터 흐름 (중요)

`store.tsx`는 기동 시 `fetchState()`로 서버를 찔러보고 **실패하면 조용히 목 데이터로 폴백**한다.

```
서버 응답 O → 실서버 데이터 + 뮤테이션이 서버로 전송
서버 응답 X → 목 시드 데이터 + 뮤테이션은 메모리에만 (화면은 정상으로 보임!)
```

**화면이 잘 보인다고 서버에 붙은 게 아니다.** 연결 여부는 `NEXT_PUBLIC_API_URL`과
`/api/state` 응답으로 확인할 것.

새 API 함수는 `lib/data/api.ts`에 타입과 함께 추가하고, 화면은 `store.tsx`의 핸들러를 통해 부른다.

---

## 규칙

- **스타일:** Tailwind 클래스. 인라인 style 객체 금지. 색은 CSS 변수(`var(--color-*)`, `globals.css`).
- **프리미티브 우선:** 새 카드/배지/빈 상태를 직접 만들지 말고 `components/ui/*`를 쓴다.
- **아이콘:** `lucide-react`. `EmptyState`의 `icon` prop은 **컴포넌트**(`icon={Youtube}`)를 받는다 — JSX 엘리먼트 아님.
- **경로 별칭:** `@/*` → `./src/*`.
- **환경변수:** `NEXT_PUBLIC_API_URL` 하나만 쓴다. (`NEXT_PUBLIC_API_BASE_URL`은 구 STEPD 잔재 — 읽지 않음)
- **검증:** `npx next build` — 타입체크·프리렌더까지 여기서 걸린다. `tsc --noEmit`만으로는 부족.
- `useSearchParams()`를 쓰는 페이지는 반드시 `<Suspense>`로 감쌀 것 (안 그러면 프리렌더 실패).
