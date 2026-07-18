"use client";

import { useState } from "react";
import { WifiOff, RefreshCw } from "lucide-react";
import { useAppData } from "@/lib/data/store";

/**
 * Server-connection indicator. When /api/state can't be reached the whole app looks
 * identical to "no data yet" — the exact ambiguity CLAUDE.md warns about. This makes the
 * difference explicit: an empty screen with this banner = 서버 미연결, without it = 데이터 없음.
 * Shown only after the initial load has settled (never flashes during the mount fetch).
 */
export function ConnectionBanner() {
  const { serverConnected, loading, refresh } = useAppData();
  const [retrying, setRetrying] = useState(false);

  if (loading || serverConnected) return null;

  async function retry() {
    setRetrying(true);
    try {
      await refresh();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div
      role="alert"
      className="flex items-center gap-3 border-b border-status-error/30 bg-status-error/10 px-4 py-2.5 text-sm text-foreground sm:px-6"
    >
      <WifiOff className="size-4 shrink-0 text-status-error" />
      <span className="min-w-0 flex-1">
        서버에 연결할 수 없습니다. 표시된 데이터가 없거나 오래됐을 수 있습니다.
      </span>
      <button
        type="button"
        onClick={retry}
        disabled={retrying}
        className="flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-60"
      >
        <RefreshCw className={retrying ? "size-3.5 animate-spin" : "size-3.5"} />
        재시도
      </button>
    </div>
  );
}
