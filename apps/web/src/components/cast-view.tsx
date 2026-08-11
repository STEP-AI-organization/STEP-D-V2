"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import {
  fetchEpisodeCast,
  registerEpisodeCast,
  setEpisodeCastStatus,
  type EpisodeCastPerson,
  type EpisodeCastResponse,
  type EpisodeCastStatus,
} from "@/lib/data/api";
import { formatTimecode } from "@/lib/utils";
import type { StatusTone } from "@/lib/constants";

const STATUS_META: Record<string, { tone: StatusTone; label: string }> = {
  confirmed: { tone: "done", label: "확정" },
  matched: { tone: "progress", label: "매칭" },
  candidate: { tone: "idle", label: "후보" },
  rejected: { tone: "error", label: "제외" },
};

export function CastView({ mediaId }: { mediaId: string | undefined }) {
  const [data, setData] = useState<EpisodeCastResponse | null>(null);
  const [loading, setLoading] = useState(false);
  // 로딩 실패를 "분석 전이라 인물이 없다"로 둔갑시키지 않으려면 오류를 따로 들고 있어야 한다.
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!mediaId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchEpisodeCast(mediaId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setData(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mediaId, nonce]);

  // 액션 결과를 서버 응답 그대로 반영 — 낙관적으로 찍고 넘어가지 않는다.
  const applyPerson = useCallback((name: string, next: EpisodeCastPerson) => {
    setData((prev) => {
      if (!prev) return prev;
      const people = prev.people.map((p) => (p.name === name ? { ...p, ...next } : p));
      return {
        ...prev,
        people,
        // 서버 GET /api/media/:id/cast 와 같은 식이어야 새로고침 후 숫자가 안 바뀐다.
        // (castId 없는 인물은 확정해도 '매칭'에 안 들어간다 — 명단 등록이 필요하다.)
        matchedCount: people.filter((p) => p.castId && p.status !== "rejected").length,
        candidateCount: people.filter((p) => !p.castId && p.status === "candidate").length,
      };
    });
  }, []);

  if (!mediaId) return null;

  if (loading && !data) {
    return (
      <Card className="p-6 text-center text-sm text-muted-foreground">
        인물 정보를 불러오는 중…
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="space-y-2 p-4 text-center">
        <AlertTriangle className="mx-auto size-4 text-status-error" />
        <div className="text-sm font-semibold">인물 정보를 불러오지 못했습니다</div>
        <div className="text-[11px] text-muted-foreground">{error}</div>
        <Button size="xs" variant="outline" onClick={() => setNonce((n) => n + 1)}>
          다시 시도
        </Button>
      </Card>
    );
  }

  if (!data || data.people.length === 0) {
    return (
      <EmptyState
        icon={Users}
        compact
        title="등장 인물이 없습니다"
        description="영상 분석 후 자동 감지됩니다."
      />
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-[11px] font-semibold text-muted-foreground">
        감지된 인물 {data.people.length}명 (매칭 {data.matchedCount}명)
      </div>
      {data.people.map((p) => (
        <PersonCard
          key={`${p.name}:${p.castId ?? ""}`}
          mediaId={mediaId}
          person={p}
          onUpdated={applyPerson}
        />
      ))}
    </div>
  );
}

function PersonCard({
  mediaId,
  person,
  onUpdated,
}: {
  mediaId: string;
  person: EpisodeCastPerson;
  onUpdated: (name: string, next: EpisodeCastPerson) => void;
}) {
  const meta = person.status ? STATUS_META[person.status] : undefined;
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const run = async (label: string, fn: () => Promise<EpisodeCastPerson>) => {
    setBusy(true);
    try {
      onUpdated(person.name, await fn());
      toast({ title: `${person.name} · ${label} 완료`, tone: "done" });
    } catch (e: unknown) {
      toast({
        title: `${label} 실패`,
        description: e instanceof Error ? e.message : String(e),
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const setStatus = (status: EpisodeCastStatus, label: string) =>
    run(label, () => setEpisodeCastStatus(mediaId, person.name, status, person.castId ?? undefined));

  const isConfirmed = person.status === "confirmed";
  const isRejected = person.status === "rejected";

  return (
    <Card className="p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-bold">{person.name}</span>
        {person.role && (
          <span className="text-[11px] text-muted-foreground">{person.role}</span>
        )}
        {meta && (
          <StatusBadge tone={meta.tone} className="ml-auto">
            {meta.label}
          </StatusBadge>
        )}
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span>
          {person.sceneCount ?? 0}개 장면 · 총 {Math.round(person.totalSec ?? 0)}초
        </span>
        {typeof person.confidence === "number" && person.confidence > 0 && (
          <span>신뢰도 {Math.round(person.confidence * 100)}%</span>
        )}
      </div>

      {person.appearances && person.appearances.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {person.appearances.map((a, i) => (
            <span
              key={i}
              className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground"
            >
              {formatTimecode(a.start)}~{formatTimecode(a.end)}
            </span>
          ))}
        </div>
      )}

      {/* 확정은 사람만 할 수 있는 판단이다 — 파이프라인은 후보 제안까지만 한다. */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {isConfirmed || isRejected ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => setStatus(person.castId ? "matched" : "candidate", "판단 해제")}
          >
            판단 해제
          </Button>
        ) : (
          <>
            <Button size="xs" disabled={busy} onClick={() => setStatus("confirmed", "확정")}>
              확정
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => setStatus("rejected", "제외")}
            >
              제외
            </Button>
            {!person.castId && (
              <Button
                size="xs"
                variant="secondary"
                disabled={busy}
                title="프로그램 출연자 명단에 등록하고 이 회차를 확정합니다 (다음 회차부터 자동 매칭)"
                onClick={() =>
                  run("명단 등록", () => registerEpisodeCast(mediaId, person.name))
                }
              >
                명단 등록
              </Button>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
