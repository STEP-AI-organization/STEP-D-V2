"use client";

import { Menu, Search } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { JobCenter } from "@/components/shell/job-center";
import { UploadVideoButton } from "@/components/upload-video-dialog";

/** Top app bar: mobile nav toggle · breadcrumb slot · job center · theme. */
export function Topbar({ breadcrumb }: { breadcrumb?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-border bg-background/80 px-4 backdrop-blur sm:gap-3 sm:px-5">
      <button
        type="button"
        onClick={() => window.dispatchEvent(new Event("toggle-sidebar"))}
        className="-ml-1 flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:hidden"
        aria-label="메뉴 열기"
        title="메뉴"
      >
        <Menu className="size-5" />
      </button>

      <div className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{breadcrumb}</div>

      {/* Click entry point for the command palette — previously ⌘K/Ctrl+K only, unreachable
          by mouse/touch users and on mobile. */}
      <button
        type="button"
        onClick={() => window.dispatchEvent(new Event("open-command-palette"))}
        className="flex h-9 items-center gap-2 rounded-[9px] border border-border bg-card px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label="검색 · 빠른 이동"
        title="검색 · 빠른 이동"
      >
        <Search className="size-4" />
        <kbd className="mono hidden rounded border border-border bg-elevated px-1.5 text-[10px] sm:inline">
          ⌘K
        </kbd>
      </button>

      {/* Global 원본 업로드 — the prototype surfaces this CTA in the header on every
          screen (opens the same upload dialog as the 콘텐츠 page). */}
      <div className="hidden sm:block">
        <UploadVideoButton variant="default" />
      </div>

      <JobCenter />
      <ThemeToggle />
    </header>
  );
}
