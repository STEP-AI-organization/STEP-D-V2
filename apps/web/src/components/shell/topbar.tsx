"use client";

/**
 * 상단바 (README §0) — height 54px · 흰 배경 · 하단 1px #e4e2dc.
 * 좌측 화면 제목(세리프 17px) + 부제(11.5px, 말줄임), 우측 "주간 리포트".
 */
import { usePathname } from "next/navigation";

import { screenMetaFor } from "@/lib/nav";

export function Topbar({ breadcrumb }: { breadcrumb?: React.ReactNode }) {
  const pathname = usePathname();
  const meta = screenMetaFor(pathname);

  return (
    <header
      className="sticky top-0 z-20 flex h-[54px] items-center justify-between gap-4 bg-white px-5"
      style={{ borderBottom: "1px solid var(--sd-border)" }}
    >
      <div className="min-w-0">
        <h1 className="sd-serif truncate text-[17px] leading-[1.3] font-semibold" style={{ color: "var(--sd-fg)" }}>
          {breadcrumb ?? meta.title}
        </h1>
        {meta.subtitle && (
          <p className="truncate text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
            {meta.subtitle}
          </p>
        )}
      </div>

      {/* 주간 리포트는 자동 발송이 없다 — 사람이 눌러서 만든다 (README §15). */}
      <button type="button" className="sd-btn shrink-0">주간 리포트</button>
    </header>
  );
}
