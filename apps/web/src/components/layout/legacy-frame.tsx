"use client";

/**
 * 아직 안 옮긴 화면을 감싸는 임시 틀 (2026-09-03 · 이식 계획 P7).
 *
 * 셸(사이드바)은 이미 디자이너 것으로 바뀌었는데 화면 24개는 아직 옛 마크업이다.
 * 그 화면들은 **자기 스크롤 컨테이너가 없다** — 예전엔 `AppShell` 의 `<main className="p-5">`
 * 안에서 문서 스크롤로 굴렀다. 새 셸은 `h-screen overflow-hidden` 이라, 이 틀이 없으면
 * **레거시 화면이 스크롤 불가가 되어 아래쪽 내용에 영영 못 닿는다.**
 *
 * 그래서 여기서 세 가지를 대신한다:
 *   1. 상단바(옛 Topbar) — 화면 제목·액션이 거기 붙어 있다
 *   2. 연결 배너 — 빈 화면이 "데이터 없음" 인지 "서버 미연결" 인지 구분해 준다
 *   3. `<main className="flex-1 overflow-y-auto p-5">` — 잃어버린 스크롤을 되돌린다
 *
 * ## 이 파일은 **지워지려고 만든 것**이다
 * 화면을 옮길 때마다 그 경로를 `MIGRATED` 에 추가하면 이 틀을 건너뛰고 디자이너 구조
 * (페이지가 `<Header>`·`<main>`·`<Footer>` 를 직접 그림)로 렌더된다.
 * 24개가 전부 옮겨지면 `MIGRATED` 만 남고, 그때 이 파일과 `components/shell/` 옛 셸을
 * 통째로 지운다.
 */
import { usePathname } from "next/navigation";

import { ConnectionBanner } from "@/components/shell/connection-banner";
import { Topbar } from "@/components/shell/topbar";

/**
 * 디자이너 구조로 이식이 끝난 경로.
 *
 * 여기 있는 화면은 **자기가 `<Header>`·`<main>`·`<Footer>` 를 그린다** — 감싸지 않는다.
 * 하위 경로도 포함한다(`/programs` 를 넣으면 `/programs/123` 도 이식본으로 취급).
 *
 * ⚠️ 화면을 옮기기 **전에** 여기 추가하면 상단바도 스크롤도 없는 화면이 된다.
 * 순서는 항상 "페이지 이식 → 여기 추가" 다.
 */
const MIGRATED: string[] = [
  // 아직 없음 — 셸만 먼저 옮겼다.
];

export function LegacyFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const migrated = MIGRATED.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (migrated) return <>{children}</>;

  return (
    <>
      <Topbar />
      <ConnectionBanner />
      {/* 새 셸이 overflow-hidden 이라 스크롤을 여기서 돌려준다. p-5 는 옛 AppShell 과 같다. */}
      <main className="flex-1 overflow-y-auto p-5">{children}</main>
    </>
  );
}
