"use client";

/**
 * 헤더 — 디자이너 산출물 이식 (원본 `STEPD_SaaS_UI_V1/src/components/layout/header.tsx`).
 *
 * **마크업·클래스·문구는 한 글자도 안 바꿨다.** 바꾼 건 목 데이터를 실제 배선으로 되돌린 것뿐이다.
 *
 * | 원본(목업)                              | 이식본 |
 * |---|---|
 * | `SEARCH_NAV_ITEMS` 정적 9개             | `NAV_GROUPS` 전체(19개) — 메뉴가 늘면 검색도 같이 는다 |
 * | 리포트 요약 `프로그램 3 · 회차 14 …`    | 스토어 실제 건수 |
 * | (없음)                                  | 우측 유틸에 `TransferCenter` **재삽입** |
 *
 * ## Ctrl+K 는 이제 여기 하나뿐이다
 * 우리 `CommandPalette` 도 같은 키를 잡고 있었다. 둘 다 마운트하면 한 번 눌러 **모달이 두 개**
 * 뜬다. 디자이너 헤더가 검색 모달을 들고 오므로 `(app)/layout.tsx` 에서 CommandPalette 를
 * 내렸다(테스트 참조 0건 확인). 되살리려면 여기 리스너를 먼저 빼야 한다.
 *
 * ## 주간 리포트는 **아직 만들지 않는다**
 * 원본의 안내 문구가 그 사실을 이미 정확히 적고 있다("리포트 파일 생성·전송은 아직 서버에
 * 없어서…"). 서버에 그 기능이 없는 게 사실이므로 문구를 그대로 두고 동작도 그대로 둔다 —
 * 여기서 억지로 뭔가 만들면 화면이 거짓말을 하게 된다.
 */
import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, CornerDownLeft, FileText, Search, X } from "lucide-react";

import { TransferCenter } from "@/components/shell/transfer-center";
import { useAppData } from "@/lib/data/store";
import { NAV_GROUPS } from "@/lib/nav";

interface HeaderProps {
  title?: string;
  subtitle?: string;
}

/** 원본은 9개가 박혀 있었다. 메뉴 정본(nav.ts)에서 뽑아 **19개 전부** 이동 가능하게 한다. */
const SEARCH_NAV_ITEMS = NAV_GROUPS.flatMap((g) =>
  g.items.map((i) => ({ id: i.href, label: i.label, href: i.href })),
);

export function Header({ title = "대시보드", subtitle = "" }: HeaderProps) {
  const router = useRouter();
  const [searchOpen, setSearchOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [scope, setScope] = useState<"전사" | "내 담당">("전사");
  const backdropMouseDownRef = React.useRef(false);
  const [metrics, setMetrics] = useState({
    performance: true,
    production: true,
    channel: true,
  });

  // Shortcut key listener for Ctrl+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      } else if (e.key === "Escape") {
        setSearchOpen(false);
        setReportOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const filteredItems = SEARCH_NAV_ITEMS.filter((item) =>
    item.label.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  return (
    <>
      <header className="h-14 border-b border-[var(--color-border-subtle)] px-5 flex items-center justify-between bg-[var(--color-bg-dark)] shrink-0 select-none">
        {/* Page Title & Optional Subtitle */}
        <div className="flex items-baseline gap-3">
          <h1 className="text-base font-bold text-[var(--color-text-primary)]">
            {title}
          </h1>
          {subtitle && (
            <span className="text-xs text-[var(--color-text-muted)] font-normal">
              {subtitle}
            </span>
          )}
        </div>

        {/* Header Utilities */}
        <div className="flex items-center gap-2.5">
          {/* 네이티브(Electron) 업로드 큐 — 원본엔 없다. 데스크톱 셸에서만 뭔가를 그리고,
              브라우저에서는 null 이라 **기하가 안 변한다**. 빼면 진행 중인 업로드를 볼 데가 없다. */}
          <TransferCenter />

          {/* Search Trigger Input Button */}
          <button
            onClick={() => setSearchOpen(true)}
            className="relative flex items-center w-72 h-9 bg-[var(--color-bg-input)] dark:bg-slate-800/90 hover:bg-[var(--color-bg-card-hover)] dark:hover:bg-slate-700 text-xs text-[var(--color-text-primary)] pl-9 pr-14 rounded-full shadow-md shadow-slate-900/5 dark:shadow-none transition-all cursor-pointer text-left"
          >
            <Search className="w-3.5 h-3.5 absolute left-3 text-[var(--color-text-muted)] dark:text-slate-300 pointer-events-none" />
            <span className="text-[var(--color-text-muted)] dark:text-slate-300 truncate">검색</span>
            <span className="absolute right-2 text-[10.5px] font-semibold text-slate-500 dark:text-slate-300 bg-slate-200/70 dark:bg-slate-700/60 px-2 py-0.5 rounded-full !shadow-none border-none pointer-events-none">
              Ctrl K
            </span>
          </button>

          {/* Weekly Report Trigger Button */}
          <button
            onClick={() => setReportOpen(true)}
            className="flex items-center gap-1.5 px-4 h-9 text-xs font-semibold text-[var(--color-text-primary)] dark:text-slate-100 bg-[var(--color-bg-card)] dark:bg-slate-800/90 hover:bg-[var(--color-bg-card-hover)] dark:hover:bg-slate-700 rounded-full shadow-md shadow-slate-900/5 dark:shadow-none transition-all cursor-pointer shrink-0"
          >
            <FileText className="w-3.5 h-3.5 text-[var(--color-text-secondary)] dark:text-slate-300" />
            <span>주간 리포트</span>
          </button>
        </div>
      </header>

      {/* Command Palette / Search Modal Dialog */}
      {searchOpen && (
        <div
          onMouseDown={(e) => {
            backdropMouseDownRef.current = e.target === e.currentTarget;
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && backdropMouseDownRef.current) {
              setSearchOpen(false);
            }
            backdropMouseDownRef.current = false;
          }}
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-start justify-center pt-24"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[480px] bg-[var(--color-bg-card)] border border-[var(--color-border-subtle)] rounded-2xl shadow-2xl overflow-hidden flex flex-col animate-in fade-in slide-in-from-bottom-3 zoom-in-95 duration-200 ease-out select-none"
          >
            {/* Input Header */}
            <div className="p-3 border-b border-[var(--color-border-subtle)] flex items-center gap-2">
              <Search className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
              <input
                type="text"
                autoFocus
                placeholder="이동하거나 검색... (회차·클립·화면)"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  // 원본은 Enter 처리가 없었다(목업). 첫 항목에 ⏎ 아이콘을 그려 놓고 눌러도
                  // 아무 일이 없으면 화면이 거짓말을 한다 — 그려진 대로 동작하게만 한다.
                  if (e.key === "Enter" && filteredItems[0]) {
                    setSearchOpen(false);
                    router.push(filteredItems[0].href);
                  }
                }}
                className="w-full bg-transparent text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none"
              />
              <span className="px-1.5 py-0.5 rounded bg-[var(--color-bg-input)] text-[10.5px] text-[var(--color-text-muted)] border border-[var(--color-border-subtle)]">
                ESC
              </span>
            </div>

            {/* Nav Items List */}
            <div className="max-h-[300px] overflow-y-auto p-1 divide-y divide-[var(--color-border-subtle)]/40">
              {filteredItems.map((item, idx) => (
                <div
                  key={item.id}
                  onClick={() => {
                    setSearchOpen(false);
                    router.push(item.href);
                  }}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-xs cursor-pointer transition-colors ${
                    idx === 0
                      ? "bg-[var(--color-bg-input)] text-[var(--color-text-primary)] font-bold"
                      : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-card-hover)] hover:text-[var(--color-text-primary)]"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className="text-[11px] text-[var(--color-text-muted)] font-medium">이동</span>
                    <span>{item.label}</span>
                  </div>
                  {idx === 0 && <CornerDownLeft className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Weekly Report Modal Dialog */}
      {reportOpen && (
        <div
          onMouseDown={(e) => {
            backdropMouseDownRef.current = e.target === e.currentTarget;
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && backdropMouseDownRef.current) {
              setReportOpen(false);
            }
            backdropMouseDownRef.current = false;
          }}
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[490px] bg-[var(--color-bg-card)] border border-[var(--color-border-subtle)] rounded-2xl shadow-2xl overflow-hidden p-6 flex flex-col space-y-6 select-none animate-in fade-in slide-in-from-bottom-5 zoom-in-95 duration-200 ease-out text-xs"
          >
            {/* Modal Header Title & Close Button */}
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-[var(--color-text-primary)] text-base tracking-tight">주간 리포트</h2>
              <button
                onClick={() => setReportOpen(false)}
                className="p-1 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-input)] transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 1. Scope Selection Pills (Full Width Equal Grid) */}
            <div className="space-y-2">
              <label className="block text-xs font-bold text-[var(--color-text-primary)]">범위</label>
              <div className="grid grid-cols-2 gap-2.5 w-full">
                {["전사", "내 담당"].map((item) => {
                  const isSelected = scope === item;
                  return (
                    <button
                      key={item}
                      type="button"
                      onClick={() => setScope(item as "전사" | "내 담당")}
                      className={`w-full py-2.5 px-4 rounded-full text-xs font-semibold cursor-pointer transition-all duration-200 flex items-center justify-start gap-2.5 border select-none ${
                        isSelected
                          ? "border-[#1C60FF] dark:border-blue-500 text-[#1C60FF] dark:text-blue-400 bg-[#1C60FF]/8 dark:bg-blue-500/15 font-bold shadow-none"
                          : "border-slate-200 dark:border-white text-slate-600 dark:text-white bg-slate-50/50 dark:bg-transparent hover:border-slate-300 dark:hover:border-white font-medium shadow-none"
                      }`}
                    >
                      {isSelected ? (
                        <span className="w-4 h-4 rounded-full bg-[#1C60FF] dark:bg-blue-500 text-white flex items-center justify-center shrink-0 shadow-xs">
                          <Check className="w-2.5 h-2.5 stroke-[3]" />
                        </span>
                      ) : (
                        <span className="w-4 h-4 rounded-full border border-slate-300 dark:border-white shrink-0" />
                      )}
                      <span className="truncate">{item}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 2. Section (Metrics) Selection Pills (Full Width Equal Grid) */}
            <div className="space-y-2">
              <label className="block text-xs font-bold text-[var(--color-text-primary)]">섹션</label>
              <div className="grid grid-cols-3 gap-2.5 w-full">
                {[
                  { key: "performance", label: "성과" },
                  { key: "production", label: "생산" },
                  { key: "channel", label: "채널" },
                ].map((sec) => {
                  const isSelected = metrics[sec.key as keyof typeof metrics];
                  return (
                    <button
                      key={sec.key}
                      type="button"
                      onClick={() =>
                        setMetrics((prev) => ({ ...prev, [sec.key]: !prev[sec.key as keyof typeof metrics] }))
                      }
                      className={`w-full py-2.5 px-4 rounded-full text-xs font-semibold cursor-pointer transition-all duration-200 flex items-center justify-start gap-2.5 border select-none ${
                        isSelected
                          ? "border-[#1C60FF] dark:border-blue-500 text-[#1C60FF] dark:text-blue-400 bg-[#1C60FF]/8 dark:bg-blue-500/15 font-bold shadow-none"
                          : "border-slate-200 dark:border-white text-slate-600 dark:text-white bg-slate-50/50 dark:bg-transparent hover:border-slate-300 dark:hover:border-white font-medium shadow-none"
                      }`}
                    >
                      {isSelected ? (
                        <span className="w-4 h-4 rounded-full bg-[#1C60FF] dark:bg-blue-500 text-white flex items-center justify-center shrink-0 shadow-xs">
                          <Check className="w-2.5 h-2.5 stroke-[3]" />
                        </span>
                      ) : (
                        <span className="w-4 h-4 rounded-full border border-slate-300 dark:border-white shrink-0" />
                      )}
                      <span className="truncate">{sec.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Info Summary Box */}
            <ReportSummary />

            {/* Notice Footer Text */}
            <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
              자동 발송은 없으며, &apos;리포트 작성&apos;시에만 만들어집니다.<br />
              리포트 파일 생성·전송은 아직 서버에 없어서, 고른 섹션을 토스트 요약으로만 보여줍니다.
            </p>

            {/* Action Buttons */}
            <div className="flex items-center justify-end gap-2 pt-3 border-t border-[var(--color-border-subtle)]">
              <button
                onClick={() => setReportOpen(false)}
                className="px-4 py-2 rounded-full bg-[var(--color-bg-input)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-card-hover)] transition-colors text-xs font-semibold cursor-pointer"
              >
                닫기
              </button>
              <button
                onClick={() => setReportOpen(false)}
                className="px-5 py-2 rounded-full bg-[var(--color-bg-active)] text-white hover:bg-[#0D1EB8] transition-colors text-xs font-semibold cursor-pointer shadow-md shadow-[#1C60FF]/20"
              >
                리포트 작성
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * 리포트 범위 안의 실제 건수 — 원본은 `프로그램 3 (방영 중 3) · 회차 14 · 미디어 33 · 게시 23` 이
 * 박혀 있었다. 문장 **모양은 그대로** 두고 숫자만 스토어에서 읽는다.
 */
function ReportSummary() {
  const { programs, episodes, media, clips } = useAppData();
  const airing = programs.filter((p) => p.status === "airing" || p.status === "active").length;
  const published = clips.filter((c) => c.status === "published").length;

  return (
    <div className="p-3.5 rounded-xl bg-[var(--color-bg-input)] border border-[var(--color-border-subtle)] space-y-1 text-xs text-[var(--color-text-muted)]">
      <div className="font-bold text-[var(--color-text-primary)]">리포트 범위 내 숫자</div>
      <div className="text-[11px] leading-relaxed">
        프로그램 {programs.length} (방영 중 {airing}) · 회차 {episodes.length} · 미디어 {media.length} · 게시 {published}
      </div>
    </div>
  );
}
