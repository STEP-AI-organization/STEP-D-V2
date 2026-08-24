"use client";

/**
 * 상단바 (README §0) — height 54px · 카드색 배경 · 하단 1px #e4e2dc.
 * 좌측 화면 제목(세리프 17px) + 부제(11.5px, 말줄임), 우측 검색·"주간 리포트".
 *
 * 검색 버튼이 여기 있는 이유: 커맨드 팔레트가 Ctrl/⌘+K 로만 열려서 단축키를 모르면
 * 없는 기능이었다. 테마 전환은 커맨드 팔레트에서 제공하고, `--sd-*`와 semantic 토큰이
 * 라이트·다크에서 함께 전환되어 한 화면에 서로 다른 색 체계가 섞이지 않는다.
 */
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Search } from "lucide-react";

import { WeeklyReportDialog } from "@/components/report/weekly-report-dialog";
import { screenMetaFor } from "@/lib/nav";

export function Topbar({ breadcrumb }: { breadcrumb?: React.ReactNode }) {
  const pathname = usePathname();
  const meta = screenMetaFor(pathname);
  const [reportOpen, setReportOpen] = useState(false);

  return (
    <header
      className="sticky top-0 z-20 flex h-[54px] items-center justify-between gap-4 px-5"
      style={{ background: "var(--sd-card)", borderBottom: "1px solid var(--sd-border)" }}
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

      <div className="flex shrink-0 items-center gap-1.5">
        {/* 커맨드 팔레트가 이 이벤트를 듣고 열린다 — 단축키 말고도 손으로 열 수 있게. */}
        <button
          type="button"
          className="sd-btn flex items-center gap-1.5"
          onClick={() => window.dispatchEvent(new Event("open-command-palette"))}
          title="화면·회차·클립 검색 (Ctrl/⌘ + K)"
        >
          <Search className="size-[13px]" aria-hidden />
          <span>검색</span>
          <kbd
            className="sd-mono rounded-[3px] px-1 text-[9.5px]"
            style={{ background: "var(--sd-card-sub)", color: "var(--sd-mut)" }}
          >
            Ctrl K
          </kbd>
        </button>

        {/* 주간 리포트는 자동 발송이 없다 — 사람이 눌러서 만든다 (README §15). */}
        <button type="button" className="sd-btn" onClick={() => setReportOpen(true)}>
          주간 리포트
        </button>
      </div>
      {reportOpen && <WeeklyReportDialog onClose={() => setReportOpen(false)} />}
    </header>
  );
}
