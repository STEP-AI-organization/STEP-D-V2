"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Sparkles,
  Clapperboard,
  Search,
  Send,
  Layers,
  FileText,
  Flame,
  Loader2,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { RecommendationCard } from "@/components/recommendation-card";
import { PublishDialog } from "@/components/publish-dialog";
import { useAppData } from "@/lib/data/store";
import { type AnalysisScene } from "@/lib/data/api";
import { useMediaAnalysisPoll } from "@/lib/data/use-media-analysis";
import {
  ASPECT_RATIOS,
  CLIP_TYPES,
  DISTRIBUTION_CHANNELS,
} from "@/lib/constants";
import { cn, formatDuration, formatTimecode } from "@/lib/utils";

type PanelTab = "recommend" | "clips" | "analyze" | "distribute";

const TABS: { key: PanelTab; label: string; icon: typeof Sparkles }[] = [
  { key: "recommend", label: "추천", icon: Sparkles },
  { key: "clips", label: "클립", icon: Clapperboard },
  { key: "analyze", label: "분석", icon: Search },
  { key: "distribute", label: "배포", icon: Send },
];

function isPanelTab(v: string | undefined): v is PanelTab {
  return !!v && TABS.some((t) => t.key === v);
}

/**
 * Right panel — derivatives overview in a tabbed layout.
 * Shows AI recommendations, finalized clips, detailed analysis, and distribution status.
 */
export function DerivativesPanel({
  episodeId,
  initialTab,
}: {
  episodeId: string;
  initialTab?: string;
}) {
  const { recsForEpisode, clipsForEpisode } = useAppData();
  const [tab, setTabState] = useState<PanelTab>(isPanelTab(initialTab) ? initialTab : "recommend");
  const [publishClipId, setPublishClipId] = useState<string | null>(null);

  function setTab(next: PanelTab) {
    setTabState(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url.toString());
  }

  const recs = recsForEpisode(episodeId);
  const pendingRecs = recs.filter((r) => r.status === "pending").sort((a, b) => b.appeal - a.appeal);
  const clips = clipsForEpisode(episodeId);

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar */}
      <div className="-mx-1 mb-3 flex gap-0.5 border-b border-border pb-px">
        {TABS.map((t) => {
          const Icon = t.icon;
          const count =
            t.key === "recommend"
              ? pendingRecs.length
              : t.key === "clips"
                ? clips.length
                : undefined;

          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "flex items-center gap-1 rounded-t-md px-3 py-2 text-xs font-medium transition-colors",
                tab === t.key
                  ? "bg-card text-foreground shadow-[0_1px_0_var(--color-card)]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-3.5" />
              {t.label}
              {typeof count === "number" && count > 0 && (
                <span className="ml-1 rounded-full bg-muted px-1.5 py-px text-[10px] font-bold">
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Panel content */}
      <div className="flex-1 overflow-y-auto pr-1">
        {tab === "recommend" && <RecommendTab recs={recs} pendingRecs={pendingRecs} />}
        {tab === "clips" && <ClipsTab clips={clips} />}
        {tab === "analyze" && <AnalyzeTab episodeId={episodeId} />}
        {tab === "distribute" && (
          <DistributeTab clips={clips} onPublish={setPublishClipId} />
        )}
      </div>

      {publishClipId && (
        <PublishDialog clipIds={[publishClipId]} onClose={() => setPublishClipId(null)} />
      )}
    </div>
  );
}

/* ── Sub-tabs ── */

function RecommendTab({
  recs,
  pendingRecs,
}: {
  recs: ReturnType<typeof useAppData>["recsForEpisode"] extends (...a: any[]) => infer R ? R : never;
  pendingRecs: ReturnType<typeof useAppData>["recsForEpisode"] extends (...a: any[]) => infer R ? R : never;
}) {
  if (pendingRecs.length === 0 && recs.length === 0) {
    return (
      <EmptyState
        icon={Sparkles}
        compact
        title="아직 추천이 없습니다"
        description="분석 완료 후 자동 생성됩니다."
      />
    );
  }

  return (
    <div className="space-y-4">
      {pendingRecs.length > 0 && (
        <div>
          <div className="mb-2 text-[11px] font-semibold text-muted-foreground">
            🔥 신규 추천 ({pendingRecs.length})
          </div>
          <div className="space-y-2">
            {pendingRecs.map((rec) => (
              <RecommendationCard key={rec.id} rec={rec} />
            ))}
          </div>
        </div>
      )}
      {recs.some((r) => r.status !== "pending") && (
        <div>
          <div className="mb-2 text-[11px] font-semibold text-muted-foreground">
            처리 완료
          </div>
          <div className="space-y-2">
            {recs
              .filter((r) => r.status !== "pending")
              .map((rec) => (
                <RecommendationCard key={rec.id} rec={rec} />
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ClipsTab({
  clips,
}: {
  clips: ReturnType<typeof useAppData>["clipsForEpisode"] extends (...a: any[]) => infer R ? R : never;
}) {
  if (clips.length === 0) {
    return (
      <EmptyState
        icon={Clapperboard}
        compact
        title="아직 클립이 없습니다"
        description="추천을 채택하면 생성됩니다."
      />
    );
  }

  return (
    <div className="space-y-2">
      {clips.map((clip) => (
        <Card key={clip.id} className="p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold leading-snug">{clip.title}</div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                <Badge>{CLIP_TYPES[clip.clipType]}</Badge>
                <span>{ASPECT_RATIOS[clip.aspectRatio]}</span>
                <span>· {formatDuration(clip.durationSec)}</span>
              </div>
            </div>
            <StatusBadge
              tone={clip.status === "encoding" ? "progress" : "done"}
              pulse={clip.status === "encoding"}
            >
              {clip.status === "encoding" ? "인코딩" : clip.status === "ready" ? "준비" : "배포"}
            </StatusBadge>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Link
              href={`/editor/${clip.id}`}
              className="text-xs font-medium text-primary underline-offset-2 hover:underline"
            >
              편집기 열기
            </Link>
          </div>
        </Card>
      ))}
    </div>
  );
}

/** Vision score → color class */
function scoreColorClass(v: number): string {
  return v >= 70 ? "text-status-done" : v >= 45 ? "text-status-warn" : "text-muted-foreground";
}

type AnalyzeView = "shorts" | "scenes" | "script";

function AnalyzeTab({ episodeId }: { episodeId: string }) {
  const { mediaForEpisode } = useAppData();
  const master = mediaForEpisode(episodeId, "master");
  const { analysis, loading } = useMediaAnalysisPoll(master?.id);
  const [view, setView] = useState<AnalyzeView>("shorts");

  if (!master) {
    return <EmptyState icon={Search} compact title="분석할 영상이 없어요" />;
  }
  if (loading && !analysis) {
    return <Card className="p-6 text-center text-sm text-muted-foreground">분석 정보를 불러오는 중…</Card>;
  }
  if (analysis?.status === "failed") {
    return <EmptyState icon={Search} compact title="분석 실패" description={analysis.error ?? "재시도 필요"} />;
  }

  const data = analysis?.data;
  const scenes = data?.scenes ?? [];
  const shorts = [...(data?.shorts ?? [])].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const transcript = (data?.transcript ?? []).filter((s) => (s.text ?? "").trim());

  if (!scenes.length && !shorts.length && !transcript.length) {
    return (
      <EmptyState
        icon={Loader2}
        compact
        title="분석 진행 중…"
        description="STT → 장면 분할 → Vision 채점"
      />
    );
  }

  const subTabs: { key: AnalyzeView; label: string; icon: typeof Flame; count: number }[] = [
    { key: "shorts", label: "쇼츠 추천", icon: Flame, count: shorts.length },
    { key: "scenes", label: "장면", icon: Layers, count: scenes.length },
    { key: "script", label: "자막", icon: FileText, count: transcript.length },
  ];

  return (
    <div className="space-y-2">
      <div className="flex rounded-lg border border-border p-0.5">
        {subTabs.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              onClick={() => setView(t.key)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-medium",
                view === t.key ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-3" /> {t.label} · {t.count}
            </button>
          );
        })}
      </div>

      {view === "shorts" && (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-border">
            {shorts.map((s, i) => (
              <li key={i} className="flex gap-3 px-3 py-2.5">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md bg-status-warn/10 text-[11px] font-bold text-status-warn">
                  #{s.rank ?? i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold">{s.title || "제목 없음"}</div>
                  <div className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
                    {formatTimecode(s.start)}~{formatTimecode(s.end)} · {Math.round(s.end - s.start)}초
                  </div>
                  {s.reason && <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{s.reason}</p>}
                  {s.tags && s.tags.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {s.tags.map((t) => (
                        <Badge key={t} className="text-muted-foreground">{t}</Badge>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {view === "scenes" && <ScenesView scenes={scenes} />}

      {view === "script" && (
        <Card className="max-h-[50vh] overflow-y-auto">
          <ul className="divide-y divide-border">
            {transcript.map((s, i) => (
              <li key={i} className="flex gap-2 px-3 py-1.5 text-[12px]">
                <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">{formatTimecode(s.start)}</span>
                <span>{s.text}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** Scene list — color-coded vision score, dialogue/silent, tags, on-screen names, dialogue. */
function ScenesView({ scenes }: { scenes: AnalysisScene[] }) {
  const [sort, setSort] = useState<"time" | "score">("time");
  const [silentOnly, setSilentOnly] = useState(false);

  let list = silentOnly ? scenes.filter((s) => !s.has_dialogue) : scenes;
  if (sort === "score") list = [...list].sort((a, b) => (b.vision_score ?? -1) - (a.vision_score ?? -1));
  const scored = scenes.filter((s) => s.vision_score != null).length;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div className="flex rounded-md border border-border p-0.5">
          <button
            onClick={() => setSort("time")}
            className={cn("rounded px-2 py-1 text-[11px] transition", sort === "time" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}
          >시간순</button>
          <button
            onClick={() => setSort("score")}
            className={cn("rounded px-2 py-1 text-[11px] transition", sort === "score" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}
          >시각점수순</button>
        </div>
        <button
          onClick={() => setSilentOnly((v) => !v)}
          className={cn("rounded-md border border-border px-2 py-1 text-[11px] transition", silentOnly ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}
        >무음만</button>
        <span className="text-[11px] text-muted-foreground">시각채점 {scored}/{scenes.length}</span>
      </div>
      <ul className="divide-y divide-border">
        {list.map((s, i) => (
          <li key={s.index ?? i} className="px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="tabular-nums text-[11px] text-muted-foreground">
                {formatTimecode(s.start)}{s.end != null ? `–${formatTimecode(s.end)}` : ""}
              </span>
              {typeof s.vision_score === "number" && (
                <span className={cn("tabular-nums text-[11px] font-bold", scoreColorClass(s.vision_score))}>{s.vision_score}</span>
              )}
              <span className={cn("rounded-full px-1.5 py-0.5 text-[9px]", s.has_dialogue ? "bg-status-done/10 text-status-done" : "bg-status-warn/10 text-status-warn")}>
                {s.has_dialogue ? "대사" : "무음"}
              </span>
              {s.on_screen_names && s.on_screen_names.length > 0 && (
                <span className="ml-auto flex flex-wrap gap-1">
                  {s.on_screen_names.slice(0, 3).map((t) => (
                    <Badge key={t} className="text-muted-foreground">🏷 {t}</Badge>
                  ))}
                </span>
              )}
            </div>
            {(s.vision_reason || s.text) && (
              <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{s.vision_reason || s.text}</p>
            )}
            {s.vision_tags && s.vision_tags.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {s.vision_tags.map((t) => (
                  <Badge key={t} className="text-muted-foreground">{t}</Badge>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function DistributeTab({
  clips,
  onPublish,
}: {
  clips: ReturnType<typeof useAppData>["clipsForEpisode"] extends (...a: any[]) => infer R ? R : never;
  onPublish: (id: string) => void;
}) {
  if (clips.length === 0) {
    return <EmptyState icon={Send} compact title="배포할 클립이 없습니다" />;
  }

  return (
    <div className="space-y-2">
      {clips.map((clip) => (
        <Card key={clip.id} className="p-3">
          <div className="text-[13px] font-medium">{clip.title}</div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {clip.distributions.length === 0 && (
              <span className="text-[11px] text-muted-foreground">미배포</span>
            )}
            {clip.distributions.map((d) => (
              <StatusBadge
                key={d.channel}
                tone={d.status === "failed" ? "error" : d.status === "published" ? "done" : "warn"}
              >
                {DISTRIBUTION_CHANNELS[d.channel]} · {d.status === "failed" ? "실패" : d.status === "published" ? "게시" : "예약"}
              </StatusBadge>
            ))}
            <Button size="xs" variant="outline" className="ml-auto" onClick={() => onPublish(clip.id)}>
              채널별 배포
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}