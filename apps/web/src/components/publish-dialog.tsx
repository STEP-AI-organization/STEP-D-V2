"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  X,
  Send,
  CalendarClock,
  Info,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { useAppData } from "@/lib/data/store";
import { useToast } from "@/components/ui/toast";
import {
  DISTRIBUTION_CHANNELS,
  type DistributionChannel,
} from "@/lib/constants";
import {
  evaluateChannel,
  platformLabel,
  type EvalContext,
  type PublishInputs,
  type RequirementCheck,
} from "@/lib/publish/requirements";
import { fromDatetimeLocal, humanReserve, nowReserve } from "@/lib/reserve-date";
import type { Clip, MetaPlatform } from "@/lib/types";

const CHANNELS: DistributionChannel[] = ["smr", "youtube", "meta"];
const META_PLATFORMS: MetaPlatform[] = ["instagram", "facebook"];

/**
 * Readiness publish surface (docs/plans/publish-fields-ux-plan.md §5.2).
 * Each channel is an independent card: its own required-field checklist, its own
 * inputs, and its own publish action — so YouTube/Meta can go out while SMR is
 * still incomplete. No silent drops: exactly what's missing is shown.
 */
export function PublishDialog({
  clipIds,
  onClose,
}: {
  clipIds: string[];
  onClose: () => void;
}) {
  const { clips } = useAppData();
  const targets = clips.filter((c) => clipIds.includes(c.id));

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 py-[6vh]">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <div className="relative w-full max-w-2xl rounded-xl border border-border bg-card shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 rounded-t-xl border-b border-border bg-card px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">채널별 배포</h2>
            <p className="truncate text-xs text-muted-foreground">
              {targets.length === 1 ? targets[0].title : `${targets.length}개 클립`} · 준비된 채널부터 개별 발행
            </p>
          </div>
          <button
            onClick={onClose}
            className="-mr-1 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
            aria-label="닫기"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-4 p-4">
          <CommonSummary targets={targets} />
          <div className="space-y-3">
            {CHANNELS.map((channel) => (
              <ChannelCard key={channel} channel={channel} targets={targets} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** AI-drafted common metadata, shown once for review (plan §5.1④). */
function CommonSummary({ targets }: { targets: Clip[] }) {
  if (targets.length !== 1) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        {targets.length}개 클립을 함께 배포합니다. 채널별 준비 상태는 아래에서 각각 확인하세요.
      </div>
    );
  }
  const clip = targets[0];
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
        <Sparkles className="size-3.5 text-primary" /> 공통 메타데이터 · AI 초안
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
        <Field label="제목" value={clip.title} className="col-span-2 sm:col-span-4" />
        <Field label="썸네일" value={clip.thumbnailLabel ?? "자동 생성"} />
        <Field label="유형" value={clip.clipType} />
        <Field label="비율" value={clip.aspectRatio} />
        <Field label="길이" value={`${clip.durationSec}s`} />
      </div>
    </div>
  );
}

function Field({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="truncate font-medium">{value}</div>
    </div>
  );
}

type Mode = "immediate" | "scheduled";

function ChannelCard({ channel, targets }: { channel: DistributionChannel; targets: Clip[] }) {
  const { getEpisode, getProgram, connections, publishToChannel } = useAppData();
  const { toast } = useToast();
  const [mode, setMode] = useState<Mode>("immediate");
  const [when, setWhen] = useState("");
  const [platforms, setPlatforms] = useState<Set<MetaPlatform>>(
    () => new Set<MetaPlatform>(["instagram", "facebook"]),
  );

  const resolvedReserve = mode === "immediate" ? nowReserve() : when ? fromDatetimeLocal(when) : undefined;

  const inputs: PublishInputs = useMemo(
    () => ({
      // SMR always carries a public datetime (honest scheduling); others only when scheduled.
      reserveDate: channel === "smr" ? resolvedReserve : mode === "scheduled" ? resolvedReserve : undefined,
      scheduled: mode === "scheduled",
      platforms: channel === "meta" ? [...platforms] : undefined,
    }),
    [channel, resolvedReserve, mode, platforms],
  );

  // Per-clip readiness + current channel status.
  const rows = (targets.length ? targets : []).map((clip) => {
    const episode = getEpisode(clip.episodeId);
    const program = episode ? getProgram(episode.programId) : undefined;
    const ctx: EvalContext = { clip, episode, program, connections, inputs };
    const readiness = evaluateChannel(channel, ctx);
    const dist = clip.distributions.find((d) => d.channel === channel);
    return { clip, readiness, status: dist?.status ?? "none", reserveDate: dist?.reserveDate };
  });

  if (rows.length === 0) return null;

  const total = rows.length;
  const readyRows = rows.filter((r) => r.readiness.ready);
  const publishable = readyRows.filter((r) => r.status !== "published");
  const liveRows = rows.filter((r) => r.status === "published" || r.status === "scheduled");

  // Aggregate checklist: a check is met only if met for every clip.
  const checks: (RequirementCheck & { failCount: number })[] = rows[0].readiness.checks.map(
    (chk, i) => {
      const failing = rows.filter((r) => !r.readiness.checks[i].met);
      return {
        ...chk,
        met: failing.length === 0,
        failCount: failing.length,
        detail: total > 1 ? (failing.length ? `${failing.length}개 클립 미충족` : "충족") : chk.detail,
      };
    },
  );

  const allReady = readyRows.length === total;
  const someReady = readyRows.length > 0;

  function publish() {
    if (publishable.length === 0) return;
    publishToChannel(
      publishable.map((r) => r.clip.id),
      channel,
      {
        reserveDate: inputs.reserveDate,
        scheduled: mode === "scheduled",
        platforms: channel === "meta" ? [...platforms] : undefined,
      },
    );
    const label = DISTRIBUTION_CHANNELS[channel];
    const skipped = total - readyRows.length;
    toast({
      title: mode === "scheduled" ? `${label} 예약 완료` : `${label} 배포 요청됨`,
      description:
        `${publishable.length}개 발행` + (skipped > 0 ? ` · ${skipped}개 미준비 제외` : ""),
      tone: mode === "scheduled" ? "warn" : "done",
    });
  }

  return (
    <div
      className={cn(
        "rounded-lg border bg-background",
        allReady ? "border-status-done/30" : "border-border",
      )}
    >
      {/* header */}
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{DISTRIBUTION_CHANNELS[channel]}</span>
          {allReady ? (
            <StatusBadge tone="done">준비 완료</StatusBadge>
          ) : someReady ? (
            <StatusBadge tone="warn">{readyRows.length}/{total} 준비</StatusBadge>
          ) : (
            <StatusBadge tone="warn">미준비</StatusBadge>
          )}
        </div>
        {liveRows.length > 0 && (
          <span className="text-[11px] text-muted-foreground">
            {liveRows.some((r) => r.status === "scheduled") ? "예약됨" : "게시됨"}
            {total === 1 && liveRows[0].reserveDate ? ` · ${humanReserve(liveRows[0].reserveDate)}` : ""}
          </span>
        )}
      </div>

      <div className="space-y-3 p-3">
        {/* checklist */}
        <Checklist channel={channel} checks={checks} />

        {/* channel-specific inputs */}
        {channel === "meta" && (
          <div>
            <div className="mb-1.5 text-[11px] font-semibold text-muted-foreground">배포 플랫폼</div>
            <div className="flex gap-2">
              {META_PLATFORMS.map((p) => {
                const on = platforms.has(p);
                return (
                  <button
                    key={p}
                    onClick={() =>
                      setPlatforms((prev) => {
                        const next = new Set(prev);
                        if (next.has(p)) next.delete(p);
                        else next.add(p);
                        return next;
                      })
                    }
                    className={cn(
                      "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                      on
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:bg-accent",
                    )}
                    aria-pressed={on}
                  >
                    {platformLabel(p)}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <ScheduleControl
          channel={channel}
          mode={mode}
          setMode={setMode}
          when={when}
          setWhen={setWhen}
          resolvedReserve={resolvedReserve}
        />

        {/* publish action */}
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-[11px] text-muted-foreground">
            {publishable.length > 0
              ? `${publishable.length}개 발행 대상`
              : someReady
                ? "이 채널 게시 완료"
                : "필수 항목을 채우면 발행할 수 있어요"}
          </span>
          <Button size="sm" onClick={publish} disabled={publishable.length === 0}>
            {mode === "scheduled" ? <CalendarClock /> : <Send />}
            {mode === "scheduled" ? "예약 배포" : "지금 배포"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Checklist({
  channel,
  checks,
}: {
  channel: DistributionChannel;
  checks: (RequirementCheck & { failCount: number })[];
}) {
  const programChecks = checks.filter((c) => c.scope === "program");
  const rest = checks.filter((c) => c.scope !== "program");

  return (
    <div className="space-y-1.5">
      {rest.map((c) => (
        <CheckRow key={c.key} check={c} />
      ))}
      {channel === "smr" && programChecks.length > 0 && (
        <div className="mt-1 rounded-md border border-border bg-muted/30 p-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] font-semibold text-muted-foreground">프로그램 피드 요건</span>
            {programChecks[0].fix?.href && (
              <Link
                href={programChecks[0].fix.href}
                className="inline-flex items-center gap-0.5 text-[11px] font-medium text-primary hover:underline"
              >
                {programChecks[0].fix.label}
                <ArrowRight className="size-3" />
              </Link>
            )}
          </div>
          <div className="space-y-1">
            {programChecks.map((c) => (
              <CheckRow key={c.key} check={c} dense />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CheckRow({
  check,
  dense,
}: {
  check: RequirementCheck & { failCount?: number };
  dense?: boolean;
}) {
  return (
    <div className="flex items-start gap-2 text-xs">
      {check.met ? (
        <CheckCircle2 className="mt-px size-3.5 shrink-0 text-status-done" />
      ) : (
        <AlertCircle className="mt-px size-3.5 shrink-0 text-status-warn" />
      )}
      <span className={cn("shrink-0", check.met ? "text-foreground" : "font-medium text-foreground")}>
        {check.label}
        {check.optional && <span className="ml-1 text-muted-foreground">(선택)</span>}
      </span>
      {check.detail && (
        <span
          className={cn(
            "ml-auto truncate text-right",
            check.met ? "text-muted-foreground" : "text-status-warn",
          )}
        >
          {check.detail}
        </span>
      )}
    </div>
  );
}

function ScheduleControl({
  channel,
  mode,
  setMode,
  when,
  setWhen,
  resolvedReserve,
}: {
  channel: DistributionChannel;
  mode: Mode;
  setMode: (m: Mode) => void;
  when: string;
  setWhen: (v: string) => void;
  resolvedReserve?: string;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-semibold text-muted-foreground">발행 시점</div>
      <div className="flex gap-2">
        {(["immediate", "scheduled"] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={cn(
              "flex-1 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
              mode === m
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:bg-accent",
            )}
          >
            {m === "immediate" ? "즉시 발행" : "예약"}
          </button>
        ))}
      </div>
      {mode === "scheduled" && (
        <input
          type="datetime-local"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
          className="mt-2 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      )}
      {channel === "smr" && (
        <div className="mt-2 flex items-start gap-2 rounded-md bg-status-progress/10 p-2 text-[11px] text-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0 text-status-progress" />
          <span>
            네이버 SMR은 <b>공개일시가 필수</b>입니다.{" "}
            {mode === "immediate" ? "즉시 발행 시 현재 시각으로 설정" : "예약 시각으로 설정"}:{" "}
            <b className="tabular-nums">{humanReserve(resolvedReserve)}</b>
          </span>
        </div>
      )}
    </div>
  );
}
