"use client";

import { useMemo, useState } from "react";
import { CalendarClock } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { PublishDialog } from "@/components/publish-dialog";
import { ExportExcelButton } from "@/components/export-excel-button";
import { useAppData } from "@/lib/data/store";
import { useToast } from "@/components/ui/toast";
import { DISTRIBUTION_CHANNELS, type DistributionChannel, type StatusTone } from "@/lib/constants";
import { humanReserve, nextWeekdayReserve, WEEKDAYS } from "@/lib/reserve-date";
import { structuralBlockers, type EvalContext } from "@/lib/publish/requirements";
import type { Clip, DistributionState } from "@/lib/types";

const CHANNELS = Object.keys(DISTRIBUTION_CHANNELS) as DistributionChannel[];
const DIST_TONE: Record<DistributionState["status"], StatusTone> = {
  none: "idle",
  pending: "progress",
  scheduled: "warn",
  published: "done",
  failed: "error",
};
const DIST_LABEL: Record<DistributionState["status"], string> = {
  none: "—",
  pending: "업로드 중",
  scheduled: "예약됨",
  published: "게시됨",
  failed: "실패",
};

export default function DistributionPage() {
  const { clips, retryDistribution, bulkPublish, getEpisode, getProgram, connections, loading } = useAppData();
  const { toast } = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialogClips, setDialogClips] = useState<string[] | null>(null);

  function retry(clipId: string, channel: DistributionChannel) {
    retryDistribution(clipId, channel);
    toast({ title: "재시도 요청됨", description: `${DISTRIBUTION_CHANNELS[channel]} 재배포를 시작했습니다.`, tone: "progress" });
  }

  /** Structural blockers for a channel (excludes publish-time inputs) — matrix hint. */
  function blockersFor(clip: Clip, channel: DistributionChannel) {
    const episode = getEpisode(clip.episodeId);
    const program = episode ? getProgram(episode.programId) : undefined;
    const ctx: EvalContext = { clip, episode, program, connections, inputs: {} };
    return structuralBlockers(channel, ctx);
  }

  // weekly template
  const [weekday, setWeekday] = useState(3); // 수
  const [time, setTime] = useState("19:00");
  const [tplChannels, setTplChannels] = useState<Set<DistributionChannel>>(new Set(["smr", "youtube"]));

  const scheduled = useMemo(
    () =>
      clips.flatMap((c) =>
        c.distributions
          .filter((d) => d.status === "scheduled")
          .map((d) => ({ clip: c, dist: d })),
      ),
    [clips],
  );

  function toggleSel(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function applyWeekly() {
    const readyIds = clips.filter((c) => c.status !== "published").map((c) => c.id);
    const targetIds = readyIds.length ? readyIds : clips.map((c) => c.id);
    const [hh, mm] = time.split(":").map(Number);
    const reserveDate = nextWeekdayReserve(weekday, hh, mm);
    bulkPublish(targetIds, [...tplChannels], { reserveDate, scheduled: true });
    toast({
      title: "일괄 예약 완료",
      description: `${targetIds.length}개 클립 · 매주 ${WEEKDAYS[weekday]} ${time} · ${tplChannels.size}개 채널`,
      tone: "warn",
    });
  }

  return (
    <>
      <PageHeader
        eyebrow="멀티채널 배포"
        title="배포현황"
        description="클립 × 채널 현황. 채널마다 필수 요건을 확인하고 준비된 채널부터 개별 발행합니다. 실패는 그 자리에서 재시도합니다."
        actions={
          <>
            <ExportExcelButton />
            <Button
              size="sm"
              disabled={selected.size === 0}
              onClick={() => setDialogClips([...selected])}
            >
              채널별 배포 {selected.size > 0 && `(${selected.size})`}
            </Button>
          </>
        }
      />

      {/* matrix */}
      <Card className="overflow-hidden p-0">
        <Table>
          <THead>
            <tr>
              <TH className="w-10" />
              <TH>클립</TH>
              {CHANNELS.map((ch) => (
                <TH key={ch}>{DISTRIBUTION_CHANNELS[ch]}</TH>
              ))}
              <TH />
            </tr>
          </THead>
          <TBody>
            {clips.map((clip) => {
              const isSel = selected.has(clip.id);
              return (
                <TR key={clip.id} interactive className={isSel ? "bg-primary/[0.04]" : undefined}>
                  <TD>
                    <input
                      type="checkbox"
                      className="size-4 cursor-pointer"
                      checked={isSel}
                      onChange={() => toggleSel(clip.id)}
                      aria-label={`${clip.title} 선택`}
                    />
                  </TD>
                  <TD>
                    <div className="font-medium">{clip.title}</div>
                    <div className="text-xs text-muted-foreground">{clip.programTitle}</div>
                  </TD>
                  {CHANNELS.map((ch) => {
                    const d = clip.distributions.find((x) => x.channel === ch);
                    const status = d?.status ?? "none";
                    return (
                      <TD key={ch}>
                        {status === "none" ? (
                          (() => {
                            const blockers = blockersFor(clip, ch);
                            return blockers.length === 0 ? (
                              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                                <span className="size-1.5 rounded-full bg-status-done/70" aria-hidden />
                                준비됨
                              </span>
                            ) : (
                              <span
                                className="inline-flex items-center gap-1 text-[11px] text-status-warn"
                                title={blockers.map((b) => b.label).join(", ")}
                              >
                                <span className="size-1.5 rounded-full bg-status-warn" aria-hidden />
                                {blockers.length}개 필요
                              </span>
                            );
                          })()
                        ) : (
                          <div className="flex flex-col items-start gap-1">
                            <StatusBadge tone={DIST_TONE[status]}>{DIST_LABEL[status]}</StatusBadge>
                            {d?.reserveDate && (
                              <span className="text-[11px] tabular-nums text-muted-foreground">
                                {humanReserve(d.reserveDate)}
                              </span>
                            )}
                            {d?.error && <span className="text-[11px] text-status-error">{d.error}</span>}
                            {status === "failed" && (
                              <Button size="xs" variant="outline" onClick={() => retry(clip.id, ch)}>
                                재시도
                              </Button>
                            )}
                          </div>
                        )}
                      </TD>
                    );
                  })}
                  <TD numeric>
                    <Button size="xs" variant="outline" onClick={() => setDialogClips([clip.id])}>
                      배포
                    </Button>
                  </TD>
                </TR>
              );
            })}
            {clips.length === 0 && (
              <tr>
                <td
                  colSpan={CHANNELS.length + 3}
                  className="px-4 py-12 text-center text-sm text-muted-foreground"
                >
                  {loading ? "클립을 불러오는 중…" : "배포할 클립이 없습니다. 회차에서 추천을 채택해 클립을 만드세요."}
                </td>
              </tr>
            )}
          </TBody>
        </Table>
      </Card>

      {/* scheduler */}
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
            <CalendarClock className="size-4" /> 주간 일괄 예약 템플릿
          </h3>
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="w-12 text-xs text-muted-foreground">요일</span>
              <div className="flex gap-1">
                {WEEKDAYS.map((w, i) => (
                  <button
                    key={w}
                    onClick={() => setWeekday(i)}
                    className={`size-7 rounded-md border text-xs ${weekday === i ? "border-primary bg-primary/10" : "border-border text-muted-foreground"}`}
                  >
                    {w}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-12 text-xs text-muted-foreground">시각</span>
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="rounded-md border border-border bg-background px-2 py-1 text-sm"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="w-12 text-xs text-muted-foreground">채널</span>
              <div className="flex gap-1.5">
                {CHANNELS.map((ch) => (
                  <button
                    key={ch}
                    onClick={() =>
                      setTplChannels((prev) => {
                        const next = new Set(prev);
                        if (next.has(ch)) next.delete(ch);
                        else next.add(ch);
                        return next;
                      })
                    }
                    className={`rounded-md border px-2 py-1 text-xs ${tplChannels.has(ch) ? "border-primary bg-primary/10" : "border-border text-muted-foreground"}`}
                  >
                    {DISTRIBUTION_CHANNELS[ch]}
                  </button>
                ))}
              </div>
            </div>
            <Button size="sm" onClick={applyWeekly} disabled={tplChannels.size === 0}>
              준비된 클립 일괄 예약 (매주 {WEEKDAYS[weekday]} {time})
            </Button>
          </div>
        </Card>

        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold">예약 현황 ({scheduled.length})</h3>
          {scheduled.length === 0 ? (
            <p className="text-sm text-muted-foreground">예약된 배포가 없습니다.</p>
          ) : (
            <ul className="space-y-1.5">
              {scheduled.map(({ clip, dist }) => (
                <li key={`${clip.id}-${dist.channel}`} className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate">{clip.title}</span>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                    <StatusBadge tone="warn">{DISTRIBUTION_CHANNELS[dist.channel]}</StatusBadge>
                    <span className="tabular-nums">{humanReserve(dist.reserveDate)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {dialogClips && <PublishDialog clipIds={dialogClips} onClose={() => setDialogClips(null)} />}
    </>
  );
}
