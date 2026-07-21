"use client";

import { GitBranch, Sparkles, CheckCircle2, Send, Film } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { StatTile } from "@/components/ui/stat-tile";
import { StatusBadge } from "@/components/ui/status-badge";
import { ExportExcelButton } from "@/components/export-excel-button";
import { LineageTrail } from "@/components/lineage-trail";
import { useAppData } from "@/lib/data/store";
import { DISTRIBUTION_CHANNELS, type DistributionChannel } from "@/lib/constants";

// Illustrative per-channel view estimates. Real figures wire in at M6 (STEPD distributions
// currently has no performance columns — see plan §7.6).
const MOCK_VIEWS: Record<DistributionChannel, number> = { smr: 82000, youtube: 124000, meta: 45000 };

export default function AnalyticsPage() {
  const { recommendations, clips } = useAppData();

  const total = recommendations.length;
  const adopted = recommendations.filter((r) => r.status === "adopted");
  const rejected = recommendations.filter((r) => r.status === "rejected");
  const decisions = adopted.length + rejected.length;
  const adoptionRate = decisions > 0 ? Math.round((adopted.length / decisions) * 100) : 0;

  const publishedDists = clips.flatMap((c) => c.distributions.filter((d) => d.status === "published"));
  const scheduledDists = clips.flatMap((c) => c.distributions.filter((d) => d.status === "scheduled"));

  // reject-reason distribution
  const rejectDist = rejected.reduce<Record<string, number>>((acc, r) => {
    const k = r.rejectReason ?? "기타";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  const maxReject = Math.max(1, ...Object.values(rejectDist));

  // per-channel published counts (real) + estimated views (mock)
  const channels = (Object.keys(DISTRIBUTION_CHANNELS) as DistributionChannel[]).map((ch) => {
    const published = clips.reduce(
      (n, c) => n + c.distributions.filter((d) => d.channel === ch && d.status === "published").length,
      0,
    );
    return { ch, published, estViews: published * MOCK_VIEWS[ch] };
  });

  const funnel = [
    { label: "추천 생성", value: total, tone: "idle" as const },
    { label: "채택", value: adopted.length, tone: "progress" as const },
    { label: "클립", value: clips.filter((c) => c.sourceRecommendationId).length, tone: "progress" as const },
    { label: "배포", value: publishedDists.length + scheduledDists.length, tone: "done" as const },
  ];
  const funnelMax = Math.max(1, ...funnel.map((f) => f.value));

  return (
    <>
      <PageHeader
        eyebrow="게시 클립 성과"
        title="성과 & 추적"
        description="추천 채택률, 추천→클립→배포 계보, 채널별 성과. 성과 수치는 M6 백엔드 연결 시 실측으로 대체됩니다."
        actions={<ExportExcelButton />}
      />

      {/* KPI row */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          icon={Sparkles}
          label="추천 총계"
          value={String(total)}
          sub={`검토 대기 ${recommendations.filter((r) => r.status === "pending").length}`}
        />
        <StatTile
          icon={CheckCircle2}
          tone="progress"
          label="채택률 (결정 대비)"
          value={`${adoptionRate}%`}
          sub={`채택 ${adopted.length} · 반려 ${rejected.length}`}
        />
        <StatTile
          icon={Send}
          tone="done"
          label="게시된 배포"
          value={String(publishedDists.length)}
          sub={`예약 ${scheduledDists.length}`}
        />
        <StatTile
          icon={Film}
          label="생성 클립"
          value={String(clips.length)}
          sub={`추천에서 ${clips.filter((c) => c.sourceRecommendationId).length}`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* funnel */}
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold">전환 퍼널</h3>
          <div className="space-y-2">
            {funnel.map((f) => (
              <div key={f.label} className="flex items-center gap-2 text-sm">
                <span className="w-20 shrink-0 text-xs text-muted-foreground">{f.label}</span>
                <div className="h-6 flex-1 overflow-hidden rounded bg-muted">
                  <div
                    className="flex h-full items-center rounded bg-status-progress/50 px-2 text-xs font-medium"
                    style={{ width: `${(f.value / funnelMax) * 100}%`, minWidth: "2rem" }}
                  >
                    {f.value}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* reject reasons */}
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold">반려 사유 분포 ({rejected.length})</h3>
          {rejected.length === 0 ? (
            <p className="text-sm text-muted-foreground">반려된 추천이 없습니다.</p>
          ) : (
            <div className="space-y-2">
              {Object.entries(rejectDist)
                .sort((a, b) => b[1] - a[1])
                .map(([reason, count]) => (
                  <div key={reason} className="flex items-center gap-2 text-xs">
                    <span className="w-20 shrink-0 text-muted-foreground">{reason}</span>
                    <div className="h-4 flex-1 overflow-hidden rounded bg-muted">
                      <div className="h-full rounded bg-status-error/60" style={{ width: `${(count / maxReject) * 100}%` }} />
                    </div>
                    <span className="w-6 text-right tabular-nums">{count}</span>
                  </div>
                ))}
            </div>
          )}
        </Card>

        {/* channel performance */}
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold">채널별 성과</h3>
          <table className="w-full text-sm">
            <thead className="text-left text-xs font-medium text-muted-foreground">
              <tr>
                <th className="pb-2 font-medium">채널</th>
                <th className="pb-2 text-right font-medium">게시</th>
                <th className="pb-2 text-right font-medium">예상 조회수</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((c) => (
                <tr key={c.ch} className="border-t border-border">
                  <td className="py-2.5">{DISTRIBUTION_CHANNELS[c.ch]}</td>
                  <td className="py-2.5 text-right tabular-nums">{c.published}</td>
                  <td className="py-2.5 text-right tabular-nums text-muted-foreground">
                    {c.estViews > 0 ? `~${(c.estViews / 10000).toFixed(1)}만` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-muted-foreground">예상 조회수는 데모 추정치 · M6에서 실측 연동</p>
        </Card>

        {/* lineage */}
        <Card className="p-4">
          <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
            <GitBranch className="size-4 text-status-done" /> 채택 계보 ({adopted.length})
          </h3>
          {adopted.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              아직 채택된 추천이 없습니다.{" "}
              <StatusBadge tone="idle">추천에서 채택</StatusBadge>
            </p>
          ) : (
            <div className="space-y-2">
              {adopted.map((r) => (
                <LineageTrail key={r.id} rec={r} />
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
