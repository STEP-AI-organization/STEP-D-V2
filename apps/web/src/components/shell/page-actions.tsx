/**
 * 화면 상단 액션 행.
 *
 * **제목·부제는 상단바가 그린다** (lib/nav.ts `SCREEN_META` → shell/topbar.tsx).
 * 옛 `PageHeader` 는 화면 안에서 제목을 한 번 더 그렸는데, 새 셸이 상단바에 제목을
 * 붙이면서부터 같은 제목이 두 번 보였다. 그래서 제목·eyebrow·설명은 상단바로 넘기고
 * 여기엔 액션만 남긴다 — 화면마다 제목 표기가 갈리는 문제도 같이 사라진다
 * ("사업운영"/"사업 운영", "운영 · 진단"/"운영 진단" 처럼 두 곳이 어긋나 있었다).
 *
 * 액션이 없는 화면은 이걸 쓰지 말고 그냥 본문부터 시작하면 된다.
 */
export function PageActions({ children }: { children: React.ReactNode }) {
  return <div className="mb-3 flex flex-wrap items-center justify-end gap-2">{children}</div>;
}
