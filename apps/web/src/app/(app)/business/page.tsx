"use client";

import Link from "next/link";
import {
  Briefcase,
  Building2,
  FileText,
  Megaphone,
  ShieldAlert,
  Sparkles,
  Target,
} from "lucide-react";
import { ExportExcelButton } from "@/components/export-excel-button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageActions } from "@/components/shell/page-actions";
import { Card } from "@/components/ui/card";
import { SectionHeading } from "@/components/ui/section-heading";
import { StatTile } from "@/components/ui/stat-tile";
import { StatusBadge } from "@/components/ui/status-badge";
import { useAppData } from "@/lib/data/store";
import { channelLabel, type StatusTone } from "@/lib/constants";
import { formatDuration } from "@/lib/utils";
import type { Clip, Program, Recommendation } from "@/lib/types";

function formatCount(n: number): string {
  return n.toLocaleString("ko-KR");
}

function recScore(rec: Recommendation): number {
  return rec.score100 ?? rec.appeal * 20;
}

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

interface ProgramBusinessRow {
  program: Program;
  episodeCount: number;
  recommendations: Recommendation[];
  pendingRecommendations: number;
  adoptedRecommendations: number;
  rejectedRecommendations: number;
  clips: Clip[];
  readyClips: number;
  renderedClips: number;
  publishedDestinations: number;
  failedDestinations: number;
  avgScore: number;
  riskCount: number;
  shareable: boolean;
}

interface RiskItem {
  id: string;
  tone: StatusTone;
  title: string;
  detail: string;
  href: string;
}

export default function BusinessPage() {
  const { programs, episodes, recommendations, clips, loading } = useAppData();

  const episodeById = new Map(episodes.map((episode) => [episode.id, episode]));

  const rows: ProgramBusinessRow[] = programs
    .map((program) => {
      const programEpisodes = episodes.filter((episode) => episode.programId === program.id);
      const episodeIds = new Set(programEpisodes.map((episode) => episode.id));
      const programRecommendations = recommendations.filter((rec) => episodeIds.has(rec.episodeId));
      const programClips = clips.filter((clip) => episodeIds.has(clip.episodeId));
      const publishedDestinations = programClips.reduce(
        (sum, clip) => sum + clip.distributions.filter((dist) => dist.status === "published").length,
        0,
      );
      const failedDestinations = programClips.reduce(
        (sum, clip) => sum + clip.distributions.filter((dist) => dist.status === "failed").length,
        0,
      );
      const pendingRecommendations = programRecommendations.filter((rec) => rec.status === "pending").length;
      const adoptedRecommendations = programRecommendations.filter((rec) => rec.status === "adopted").length;
      const rejectedRecommendations = programRecommendations.filter((rec) => rec.status === "rejected").length;
      const readyClips = programClips.filter((clip) => clip.status === "ready" || clip.status === "published").length;
      const renderedClips = programClips.filter((clip) => clip.rendered).length;
      const avgScore =
        programRecommendations.length > 0
          ? Math.round(programRecommendations.reduce((sum, rec) => sum + recScore(rec), 0) / programRecommendations.length)
          : 0;
      const brandReviewCount = programRecommendations.filter((rec) => (rec.brands?.length ?? 0) > 0).length;
      const ageReviewCount = programClips.filter((clip) => clip.targetAge === 19).length;
      const riskCount = failedDestinations + brandReviewCount + ageReviewCount;

      return {
        program,
        episodeCount: programEpisodes.length,
        recommendations: programRecommendations,
        pendingRecommendations,
        adoptedRecommendations,
        rejectedRecommendations,
        clips: programClips,
        readyClips,
        renderedClips,
        publishedDestinations,
        failedDestinations,
        avgScore,
        riskCount,
        shareable: readyClips > 0 || publishedDestinations > 0,
      };
    })
    .sort(
      (a, b) =>
        Number(b.shareable) - Number(a.shareable) ||
        b.publishedDestinations - a.publishedDestinations ||
        b.readyClips - a.readyClips ||
        b.adoptedRecommendations - a.adoptedRecommendations ||
        b.pendingRecommendations - a.pendingRecommendations ||
        b.avgScore - a.avgScore,
    );

  const shareablePrograms = rows.filter((row) => row.shareable).length;
  const salesReadyClips = clips.filter((clip) => clip.status === "ready" || clip.status === "published").length;
  const publishedDestinations = clips.reduce(
    (sum, clip) => sum + clip.distributions.filter((dist) => dist.status === "published").length,
    0,
  );
  const pendingRecommendations = recommendations.filter((rec) => rec.status === "pending").length;
  const adoptedRecommendations = recommendations.filter((rec) => rec.status === "adopted").length;
  const decidedRecommendations = recommendations.filter((rec) => rec.status === "adopted" || rec.status === "rejected").length;
  const adoptionRate = pct(adoptedRecommendations, decidedRecommendations);

  const salesCandidates = clips
    .filter((clip) => clip.status === "ready" || clip.status === "published")
    .sort((a, b) => Number(b.status === "published") - Number(a.status === "published") || b.durationSec - a.durationSec)
    .slice(0, 6);

  const pendingRecCandidates = recommendations
    .filter((rec) => rec.status === "pending")
    .sort((a, b) => recScore(b) - recScore(a))
    .slice(0, Math.max(0, 6 - salesCandidates.length));

  const riskItems: RiskItem[] = [
    ...clips.flatMap((clip) =>
      clip.distributions
        .filter((dist) => dist.status === "failed")
        .map((dist) => ({
          id: `${clip.id}-${dist.channel}-failed`,
          tone: "error" as const,
          title: clip.title,
          detail: `${channelLabel(dist.channel)} 배포 실패${dist.error ? ` · ${dist.error}` : ""}`,
          href: `/episodes/${clip.episodeId}?tab=distribute`,
        })),
    ),
    ...clips
      .filter((clip) => clip.targetAge === 19)
      .map((clip) => ({
        id: `${clip.id}-age`,
        tone: "warn" as const,
        title: clip.title,
        detail: "19세 등급 클립 · 광고/플랫폼 적합성 확인",
        href: `/episodes/${clip.episodeId}?tab=clips`,
      })),
    ...recommendations
      .filter((rec) => rec.status === "pending" && (rec.brands?.length ?? 0) > 0)
      .map((rec) => ({
        id: `${rec.id}-brand`,
        tone: "warn" as const,
        title: rec.title,
        detail: `브랜드 노출 확인 · ${rec.brands?.join(", ")}`,
        href: `/episodes/${rec.episodeId}?tab=recommend`,
      })),
  ].slice(0, 8);

  const shareableRows = rows
    .filter((row) => row.shareable || row.pendingRecommendations > 0 || row.adoptedRecommendations > 0)
    .slice(0, 3);
  const topSignals = rows
    .filter((row) => row.recommendations.length > 0)
    .sort((a, b) => b.avgScore - a.avgScore || b.adoptedRecommendations - a.adoptedRecommendations)
    .slice(0, 5);

  return (
    <div className="mx-auto max-w-[1240px]">
      <PageActions>
        <ExportExcelButton />
      </PageActions>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          icon={Building2}
          tone="done"
          label="공유 가능 IP"
          value={formatCount(shareablePrograms)}
          sub={`전체 프로그램 ${formatCount(rows.length)}`}
        />
        <StatTile
          icon={Briefcase}
          tone="progress"
          label="영업 준비 클립"
          value={formatCount(salesReadyClips)}
          sub={`게시 채널 ${formatCount(publishedDestinations)}`}
        />
        <StatTile
          icon={Sparkles}
          label="검토 대기 추천"
          value={formatCount(pendingRecommendations)}
          sub={`채택률 ${adoptionRate}%`}
        />
        <StatTile
          icon={ShieldAlert}
          tone={riskItems.length > 0 ? "warn" : "done"}
          label="권리/승인 확인"
          value={formatCount(riskItems.length)}
          sub={riskItems.length > 0 ? "배포 전 확인 필요" : "현재 표시된 리스크 없음"}
        />
      </div>

      <div className="mb-8 grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <section>
          <SectionHeading icon={Building2} count={rows.length}>
            프로그램/IP 운영 보드
          </SectionHeading>
          <Card className="overflow-hidden">
            {loading ? (
              <div className="p-8 text-center text-sm text-muted-foreground">불러오는 중…</div>
            ) : rows.length === 0 ? (
              <EmptyState
                compact
                icon={Building2}
                title="프로그램 데이터가 없습니다"
                description="프로그램과 회차가 생성되면 IP별 운영 지표가 표시됩니다."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead className="border-b border-border bg-muted/35 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3 font-medium">프로그램/IP</th>
                      <th className="px-3 py-3 text-right font-medium">회차</th>
                      <th className="px-3 py-3 text-right font-medium">추천</th>
                      <th className="px-3 py-3 text-right font-medium">채택</th>
                      <th className="px-3 py-3 text-right font-medium">준비 클립</th>
                      <th className="px-3 py-3 text-right font-medium">게시</th>
                      <th className="px-3 py-3 text-right font-medium">확인</th>
                      <th className="px-4 py-3 text-right font-medium">상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.program.id} className="border-b border-border/70 last:border-0">
                        <td className="px-4 py-3">
                          <Link href={`/programs/${row.program.id}`} className="font-medium hover:underline">
                            {row.program.title}
                          </Link>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {row.program.section} · 점수 {row.avgScore || "—"}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">{row.episodeCount}</td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {row.recommendations.length}
                          {row.pendingRecommendations > 0 && (
                            <div className="text-[11px] text-muted-foreground">대기 {row.pendingRecommendations}</div>
                          )}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {row.adoptedRecommendations}
                          {row.rejectedRecommendations > 0 && (
                            <div className="text-[11px] text-muted-foreground">반려 {row.rejectedRecommendations}</div>
                          )}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {row.readyClips}
                          {row.renderedClips > 0 && (
                            <div className="text-[11px] text-muted-foreground">렌더 {row.renderedClips}</div>
                          )}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">{row.publishedDestinations}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{row.riskCount}</td>
                        <td className="px-4 py-3 text-right">
                          {row.failedDestinations > 0 ? (
                            <StatusBadge tone="error">실패 {row.failedDestinations}</StatusBadge>
                          ) : row.riskCount > 0 ? (
                            <StatusBadge tone="warn">확인 {row.riskCount}</StatusBadge>
                          ) : row.shareable ? (
                            <StatusBadge tone="done">공유 가능</StatusBadge>
                          ) : row.pendingRecommendations > 0 || row.adoptedRecommendations > 0 ? (
                            <StatusBadge tone="progress">작업 중</StatusBadge>
                          ) : (
                            <StatusBadge tone="idle">준비 전</StatusBadge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </section>

        <section>
          <SectionHeading icon={FileText}>부서 공유 후보</SectionHeading>
          <div className="space-y-3">
            {loading ? (
              <Card className="p-6 text-center text-sm text-muted-foreground">불러오는 중…</Card>
            ) : shareableRows.length === 0 ? (
              <EmptyState compact icon={FileText} title="공유 가능한 IP가 없습니다" />
            ) : (
              shareableRows.map((row) => (
                <Card key={row.program.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-muted-foreground">프로그램/IP</div>
                      <Link href={`/programs/${row.program.id}`} className="mt-1 block truncate text-sm font-semibold hover:underline">
                        {row.program.title}
                      </Link>
                    </div>
                    <StatusBadge tone={row.shareable ? "done" : "progress"}>
                      {row.shareable ? "공유 가능" : "검토 필요"}
                    </StatusBadge>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                    <Metric label="준비 클립" value={row.readyClips} />
                    <Metric label="대기 추천" value={row.pendingRecommendations} />
                    <Metric label="게시 채널" value={row.publishedDestinations} />
                  </div>
                </Card>
              ))
            )}
          </div>
        </section>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <section>
          <SectionHeading icon={Briefcase} count={salesCandidates.length + pendingRecCandidates.length}>
            영업 소재 큐
          </SectionHeading>
          <Card className="divide-y divide-border/70">
            {loading ? (
              <div className="p-6 text-center text-sm text-muted-foreground">불러오는 중…</div>
            ) : salesCandidates.length + pendingRecCandidates.length === 0 ? (
              <EmptyState compact icon={Briefcase} title="영업 소재가 없습니다" />
            ) : (
              <>
                {salesCandidates.map((clip) => (
                  <QueueRow
                    key={clip.id}
                    href={`/episodes/${clip.episodeId}?tab=clips`}
                    title={clip.title}
                    meta={`${clip.programTitle} · ${formatDuration(clip.durationSec)}`}
                    badge={clip.status === "published" ? "게시됨" : "준비됨"}
                    tone={clip.status === "published" ? "done" : "progress"}
                  />
                ))}
                {pendingRecCandidates.map((rec) => {
                  const episode = episodeById.get(rec.episodeId);
                  return (
                    <QueueRow
                      key={rec.id}
                      href={`/episodes/${rec.episodeId}?tab=recommend`}
                      title={rec.title}
                      meta={`${episode?.programTitle ?? "프로그램 미확인"} · 점수 ${recScore(rec)}`}
                      badge="추천"
                      tone="idle"
                    />
                  );
                })}
              </>
            )}
          </Card>
        </section>

        <section>
          <SectionHeading icon={Target} count={topSignals.length}>
            편성 신호
          </SectionHeading>
          <Card className="divide-y divide-border/70">
            {loading ? (
              <div className="p-6 text-center text-sm text-muted-foreground">불러오는 중…</div>
            ) : topSignals.length === 0 ? (
              <EmptyState compact icon={Target} title="편성 신호가 없습니다" />
            ) : (
              topSignals.map((row) => (
                <QueueRow
                  key={row.program.id}
                  href={`/programs/${row.program.id}`}
                  title={row.program.title}
                  meta={`평균 점수 ${row.avgScore} · 채택 ${row.adoptedRecommendations}/${row.recommendations.length}`}
                  badge={`${pct(row.adoptedRecommendations, row.adoptedRecommendations + row.rejectedRecommendations)}%`}
                  tone={row.adoptedRecommendations > 0 ? "done" : "idle"}
                />
              ))
            )}
          </Card>
        </section>

        <section>
          <SectionHeading icon={ShieldAlert} count={riskItems.length}>
            권리/승인 큐
          </SectionHeading>
          <Card className="divide-y divide-border/70">
            {loading ? (
              <div className="p-6 text-center text-sm text-muted-foreground">불러오는 중…</div>
            ) : riskItems.length === 0 ? (
              <EmptyState compact icon={ShieldAlert} title="현재 확인할 항목이 없습니다" />
            ) : (
              riskItems.map((item) => (
                <QueueRow
                  key={item.id}
                  href={item.href}
                  title={item.title}
                  meta={item.detail}
                  badge={item.tone === "error" ? "차단" : "확인"}
                  tone={item.tone}
                />
              ))
            )}
          </Card>
        </section>
      </div>

      <div className="mt-6 grid gap-3 md:grid-cols-3">
        <DepartmentTile
          icon={Megaphone}
          title="홍보팀"
          body={`즉시 쓸 수 있는 소재 ${salesReadyClips}개`}
          href="/distribution"
        />
        <DepartmentTile
          icon={Briefcase}
          title="광고영업"
          body={`공유 가능 IP ${shareablePrograms}개`}
          href="/performance"
        />
        <DepartmentTile
          icon={ShieldAlert}
          title="법무/심의"
          body={`확인 항목 ${riskItems.length}개`}
          href="/distribution"
        />
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-muted/45 px-3 py-2">
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-semibold tabular-nums">{formatCount(value)}</div>
    </div>
  );
}

function QueueRow({
  href,
  title,
  meta,
  badge,
  tone,
}: {
  href: string;
  title: string;
  meta: string;
  badge: string;
  tone: StatusTone;
}) {
  return (
    <Link href={href} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted/35">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{title}</div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">{meta}</div>
      </div>
      <StatusBadge tone={tone} className="shrink-0">
        {badge}
      </StatusBadge>
    </Link>
  );
}

function DepartmentTile({
  icon: Icon,
  title,
  body,
  href,
}: {
  icon: typeof Megaphone;
  title: string;
  body: string;
  href: string;
}) {
  return (
    <Link href={href}>
      <Card interactive className="flex items-center gap-3 p-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold">{title}</div>
          <div className="truncate text-xs text-muted-foreground">{body}</div>
        </div>
      </Card>
    </Link>
  );
}
