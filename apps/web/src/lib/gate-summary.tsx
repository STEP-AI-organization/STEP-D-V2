"use client";

/**
 * 게이트 요약 — 사이드바 배지·대시보드가 같은 값을 쓰게 하는 곳.
 *
 * 화면마다 따로 조회하면 같은 배치 요청이 여러 번 나가고, 무엇보다 **화면끼리 숫자가
 * 달라진다.** 사이드바는 3건이라는데 미디어 화면은 5건이면 어느 쪽을 믿어야 할지 모른다.
 *
 * 판정은 서버가 한다. 여기서는 서버가 준 상태를 세기만 한다 — 화면이 자기 나름대로
 * "이 정도면 통과"를 계산하기 시작하면 서버 판정과 어긋난다.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { fetchGateBatch, type GateResult, type GateState, type RightsIssue } from "@/lib/data/api";
import { useAppData } from "@/lib/data/store";

export interface GateSummary {
  /** clipId → 게이트. 비어 있으면 아직 못 읽었거나 클립이 없다. */
  gates: Record<string, GateResult>;
  /** clipId → 이슈 목록. 목록 화면의 "이슈 요약"이 이걸 쓴다. */
  issues: Record<string, RightsIssue[]>;
  /** 상태별 건수. 못 읽었으면 전부 0 이고 `error` 가 채워진다. */
  counts: Record<GateState, number>;
  /** 사람이 손봐야 하는 총 건수 — 사이드바 배지. */
  needsAttention: number;
  error: string | null;
  refresh: () => Promise<void>;
}

const EMPTY_COUNTS: Record<GateState, number> = {
  pass: 0, rights_hold: 0, conditional: 0, review_pending: 0, blocked: 0,
};

const GateSummaryContext = createContext<GateSummary>({
  gates: {},
  issues: {},
  counts: EMPTY_COUNTS,
  needsAttention: 0,
  error: null,
  refresh: async () => {},
});

/** 배지가 오래된 값을 들고 있으면 안 되지만, 자주 조회할 이유도 없다. */
const POLL_MS = 60_000;

export function GateSummaryProvider({ children }: { children: ReactNode }) {
  const { clips } = useAppData();
  const [gates, setGates] = useState<Record<string, GateResult>>({});
  const [issues, setIssues] = useState<Record<string, RightsIssue[]>>({});
  const [error, setError] = useState<string | null>(null);

  const clipIds = useMemo(() => clips.map((c) => c.id), [clips]);
  const idsKey = clipIds.join(",");

  const refresh = useCallback(async () => {
    if (clipIds.length === 0) { setGates({}); setIssues({}); setError(null); return; }
    try {
      const r = await fetchGateBatch("clip", clipIds);
      setGates(r.gates);
      setIssues(r.issues);
      setError(null);
    } catch (err) {
      // 못 읽으면 0 으로 보여주지 않는다 — "처리할 게 없다"로 읽히면 안 된다.
      setGates({});
      setIssues({});
      setError(err instanceof Error ? err.message : String(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const value = useMemo<GateSummary>(() => {
    const counts = { ...EMPTY_COUNTS };
    for (const id of clipIds) {
      // 게이트를 못 읽은 클립은 검수 대기로 센다 — 모르면 통과가 아니다.
      const state = (gates[id]?.state ?? "review_pending") as GateState;
      counts[state] = (counts[state] ?? 0) + 1;
    }
    const needsAttention =
      counts.rights_hold + counts.conditional + counts.review_pending + counts.blocked;
    return { gates, issues, counts, needsAttention, error, refresh };
  }, [gates, issues, clipIds, error, refresh]);

  return <GateSummaryContext.Provider value={value}>{children}</GateSummaryContext.Provider>;
}

export function useGateSummary(): GateSummary {
  return useContext(GateSummaryContext);
}
