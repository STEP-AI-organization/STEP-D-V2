"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Sparkles,
  Clapperboard,
  Search,
  Send,
  Layers,
  FileText,
  Loader2,
  BookOpen,
  Users,
  ShoppingBag,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { NarrativeView } from "./narrative-view";
import { CastView } from "./cast-view";
import { PublishDialog } from "@/components/publish-dialog";
import { ShortsCard } from "./shorts-card";
import { PplView } from "./ppl-view";
import { useVideoSeek } from "./episode/seek-context";
import type { MediaAsset } from "@/lib/types";
import { useAppData } from "@/lib/data/store";
import {
  type AnalysisScene,
  type AnalysisShort,
  type AnalysisTranscriptSegment,
  type EpisodeCastResponse,
  type MediaFaces,
  type PplData,
  fetchEpisodeCast,
  getMediaFaces,
  getMediaPpl,
  patchMediaFacesMapping,
  reanalyzeMedia,
} from "@/lib/data/api";
import { useMediaAnalysisPoll } from "@/lib/data/use-media-analysis";
import { useToast } from "@/components/ui/toast";
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
  const app = useAppData();
  const { clipsForEpisode, mediaForEpisode } = app;
  const [tab, setTabState] = useState<PanelTab>(isPanelTab(initialTab) ? initialTab : "recommend");
  const [publishClipId, setPublishClipId] = useState<string | null>(null);

  function setTab(next: PanelTab) {
    setTabState(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url.toString());
  }

  // 추천 탭 = 분석 파이프라인이 뽑은 shorts 목록. 서버가 recFromShort로 1:1 rec을 만들어 두므로
  // ShortsCard가 recsForEpisode에서 매칭해 채택 버튼을 붙임.
  const master = mediaForEpisode(episodeId, "master");
  const { analysis, loading } = useMediaAnalysisPoll(master?.id);
  const shorts = [...(analysis?.data?.shorts ?? [])].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const clips = clipsForEpisode(episodeId);

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar — Review OS underline tabs */}
      <div className="mb-4 flex gap-1 border-b border-border">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          const count =
            t.key === "recommend"
              ? shorts.length
              : t.key === "clips"
                ? clips.length
                : undefined;

          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13px] font-semibold transition-colors",
                active
                  ? "border-brand text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-3.5" />
              {t.label}
              {typeof count === "number" && count > 0 && (
                <span className="ml-0.5 rounded-md bg-brand/15 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-brand">
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Panel content */}
      <div className="flex-1 overflow-y-auto pr-1">
        {tab === "recommend" && (
          <RecommendTab
            shorts={shorts}
            master={master}
            episodeId={episodeId}
            apiBase={app.apiBase}
            loading={loading && !analysis}
          />
        )}
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

/**
 * 추천 탭 — 분석 산출 shorts를 ShortsCard 그리드로 렌더.
 * 이전에는 분석 서브탭에도 동일한 카드가 있어 두 번 나타났음. 이제 여기만.
 */
function RecommendTab({
  shorts,
  master,
  episodeId,
  apiBase,
  loading,
}: {
  shorts: AnalysisShort[];
  master: MediaAsset | undefined;
  episodeId: string;
  apiBase: string;
  loading: boolean;
}) {
  if (!master) {
    return <EmptyState icon={Sparkles} compact title="분석할 영상이 없어요" />;
  }
  if (loading) {
    return <Card className="p-6 text-center text-sm text-muted-foreground">추천 정보를 불러오는 중…</Card>;
  }
  if (shorts.length === 0) {
    return (
      <EmptyState
        icon={Sparkles}
        compact
        title="아직 추천이 없습니다"
        description="분석 완료 후 자동 생성됩니다."
      />
    );
  }
  // 2026-07-23: 3-type (숏폼/클립/하이라이트) 그룹핑 표시. type 필드 없으면 legacy shortform.
  const groups: { key: string; label: string; badge: string; items: AnalysisShort[] }[] = [
    { key: "shortform", label: "숏폼", badge: "40~60초 · SNS 배포", items: [] },
    { key: "clip", label: "클립", badge: "1~10분 · SMR·재편집·코너/세션", items: [] },
    { key: "highlight", label: "하이라이트", badge: "여러 영상 종합 (준비 중)", items: [] },
  ];
  for (const s of shorts) {
    const t = (s as any).type || "shortform";
    const g = groups.find((x) => x.key === t) ?? groups[0];
    g.items.push(s);
  }
  return (
    <div className="space-y-6">
      {groups.filter((g) => g.items.length > 0).map((g) => (
        <div key={g.key} className="space-y-2">
          <div className="flex items-baseline gap-2 border-b border-border/60 pb-1">
            <h3 className="text-base font-semibold">{g.label}</h3>
            <span className="text-xs text-muted-foreground">{g.badge}</span>
            <span className="ml-auto text-xs text-muted-foreground">{g.items.length}건</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {g.items.map((s, i) => (
              <ShortsCard
                key={`${g.key}-${s.start}-${s.end}-${i}`}
                short={s}
                index={i}
                mediaId={master.id}
                episodeId={episodeId}
                apiBase={apiBase}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ClipsTab({
  clips,
}: {
  clips: ReturnType<typeof useAppData>["clipsForEpisode"] extends (...a: any[]) => infer R ? R : never;
}) {
  const app = useAppData();
  const seek = useVideoSeek();

  if (clips.length === 0) {
    return (
      <EmptyState
        icon={Clapperboard}
        compact
        title="아직 클립이 없습니다"
        description="쇼츠 추천을 채택하면 클립이 만들어져요."
      />
    );
  }

  return (
    <div className="space-y-2">
      {clips.map((clip) => {
        const rendered = clip.status === "ready" || clip.status === "published";
        const start = typeof clip.startTime === "number" ? clip.startTime : 0;
        // 렌더된 클립: 자체 mp4 스트림(clip.videoUrl) 재생 · 미렌더: 원본 startTime 프레임
        const previewSrc = rendered && clip.videoUrl
          ? `${app.apiBase}${clip.videoUrl}`
          : undefined;
        const thumbSrc = clip.thumbnailUrl
          ? `${app.apiBase}${clip.thumbnailUrl}`
          : clip.sourceMediaId
            ? `${app.apiBase}/media/${clip.sourceMediaId}/frame?t=${start.toFixed(2)}`
            : undefined;
        return (
          <Card key={clip.id} className="overflow-hidden p-0">
            <div className="flex gap-3 p-2.5">
              {/* Preview column — rendered면 인라인 재생, 아니면 원본 프레임 썸네일(클릭 시 원본 seek) */}
              <div className="relative w-40 shrink-0 overflow-hidden rounded-md bg-black">
                {previewSrc ? (
                  <video
                    src={previewSrc}
                    controls
                    preload="metadata"
                    className="aspect-video w-full object-contain"
                  />
                ) : thumbSrc ? (
                  <button
                    type="button"
                    onClick={() => seek?.seekTo(start)}
                    className="group relative block aspect-video w-full"
                    title={`▶ 원본 ${formatTimecode(start)}부터 재생`}
                  >
                    <img
                      src={thumbSrc}
                      alt=""
                      loading="lazy"
                      className="absolute inset-0 size-full object-cover"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = "0"; }}
                    />
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 transition group-hover:bg-black/25">
                      <span className="rounded-full bg-white/90 px-2 py-1 text-[10px] font-bold text-black opacity-0 transition group-hover:opacity-100">
                        ▶ 원본
                      </span>
                    </div>
                  </button>
                ) : (
                  <div className="flex aspect-video w-full items-center justify-center text-muted-foreground">
                    <Clapperboard className="size-6" />
                  </div>
                )}
              </div>

              {/* Content column */}
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="line-clamp-2 text-[13px] font-semibold leading-snug">{clip.title}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10.5px] text-muted-foreground">
                      <Badge>{CLIP_TYPES[clip.clipType]}</Badge>
                      <span>{ASPECT_RATIOS[clip.aspectRatio]}</span>
                      <span>· {formatDuration(clip.durationSec)}</span>
                      {typeof clip.startTime === "number" && typeof clip.endTime === "number" && (
                        <span className="tabular-nums">
                          · 원본 {formatTimecode(clip.startTime)}–{formatTimecode(clip.endTime)}
                        </span>
                      )}
                    </div>
                  </div>
                  <StatusBadge
                    tone={clip.status === "encoding" ? "progress" : rendered ? "done" : "warn"}
                    pulse={clip.status === "encoding"}
                  >
                    {clip.status === "encoding"
                      ? "인코딩"
                      : clip.status === "ready"
                        ? "렌더 완료"
                        : clip.status === "published"
                          ? "배포됨"
                          : "편집 대기"}
                  </StatusBadge>
                </div>

                <div className="mt-auto flex items-center gap-2 pt-1">
                  <Link
                    href={`/editor/${clip.id}`}
                    className="text-[11.5px] font-semibold text-brand underline-offset-2 hover:underline"
                  >
                    {rendered ? "편집기 · 재렌더" : "편집기 열기 →"}
                  </Link>
                  {previewSrc && (
                    <a
                      href={previewSrc}
                      download={`${clip.title}.mp4`}
                      className="text-[11.5px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    >
                      다운로드
                    </a>
                  )}
                </div>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

/** Vision score → color class */
function scoreColorClass(v: number): string {
  return v >= 70 ? "text-status-done" : v >= 45 ? "text-status-warn" : "text-muted-foreground";
}

type AnalyzeView = "scenes" | "script" | "narrative" | "cast" | "ppl";

function AnalyzeTab({ episodeId }: { episodeId: string }) {
  const app = useAppData();
  const { mediaForEpisode, episodes, programs } = app;
  const { toast } = useToast();
  const master = mediaForEpisode(episodeId, "master");
  const { analysis, loading } = useMediaAnalysisPoll(master?.id);
  // 쇼츠 추천은 상단 "추천" 탭에서 노출. 여기 서브탭은 원본 분석 산출물 전용.
  const [view, setView] = useState<AnalyzeView>("scenes");
  const [retrying, setRetrying] = useState<false | "fast" | "full">(false);
  const [castData, setCastData] = useState<EpisodeCastResponse | null>(null);
  const [faces, setFaces] = useState<MediaFaces | null>(null);
  const [ppl, setPpl] = useState<PplData | null>(null);
  const [pendingMap, setPendingMap] = useState<Record<string, string>>({});
  const [savingMap, setSavingMap] = useState(false);

  const masterId = master?.id;
  useEffect(() => {
    if (!masterId) return;
    let cancelled = false;
    fetchEpisodeCast(masterId).then((d) => { if (!cancelled) setCastData(d); }).catch(() => {});
    return () => { cancelled = true; };
  }, [masterId]);

  // faces.json 20초 폴링 — 분석 진행 중에도 완성되는 대로 나타남
  useEffect(() => {
    if (!masterId) return;
    let alive = true;
    const load = () => { getMediaFaces(masterId).then((f) => { if (alive) setFaces(f); }).catch(() => {}); };
    load();
    const t = window.setInterval(load, 20000);
    return () => { alive = false; clearInterval(t); };
  }, [masterId]);

  // ppl.json 20초 폴링 — faces와 동일 패턴, 분석 완료 전에도 부분 결과 표시.
  useEffect(() => {
    if (!masterId) return;
    let alive = true;
    const load = () => { getMediaPpl(masterId).then((p) => { if (alive) setPpl(p); }).catch(() => {}); };
    load();
    const t = window.setInterval(load, 20000);
    return () => { alive = false; clearInterval(t); };
  }, [masterId]);

  // 프로그램 cast — 매핑 dropdown 옵션 소스
  const episode = episodes.find((e) => e.id === episodeId);
  const program = episode ? programs.find((p) => p.id === episode.programId) : null;
  const programCast = program?.cast ?? [];

  async function retryAnalysis(fast: boolean) {
    if (!master || retrying) return;
    setRetrying(fast ? "fast" : "full");
    try {
      await reanalyzeMedia(master.id, fast);
      toast({ title: `${fast ? "빠른" : "정밀"} 재분석 시작`, description: "AI 분석을 다시 큐에 넣었습니다. 진행률은 위 파이프라인에서 확인하세요.", tone: "progress" });
    } catch (e) {
      toast({ title: "재분석 요청 실패", description: e instanceof Error ? e.message : "다시 시도해 주세요.", tone: "error" });
    } finally {
      setRetrying(false);
    }
  }

  if (!master) {
    return <EmptyState icon={Search} compact title="분석할 영상이 없어요" />;
  }
  if (loading && !analysis) {
    return <Card className="p-6 text-center text-sm text-muted-foreground">분석 정보를 불러오는 중…</Card>;
  }
  if (analysis?.status === "failed") {
    return (
      <EmptyState
        icon={Search}
        compact
        title="분석 실패"
        description={analysis.error ?? "재시도 필요"}
        action={
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" onClick={() => retryAnalysis(true)} disabled={!!retrying}>
              {retrying === "fast" ? "요청 중…" : "빠른 재분석"}
            </Button>
            <Button size="sm" onClick={() => retryAnalysis(false)} disabled={!!retrying}>
              {retrying === "full" ? "요청 중…" : "정밀 재분석"}
            </Button>
          </div>
        }
      />
    );
  }

  const data = analysis?.data;
  const scenes = data?.scenes ?? [];
  const shorts = [...(data?.shorts ?? [])].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const transcript = (data?.transcript ?? []).filter((s) => (s.text ?? "").trim());
  const narrative = data?.narrative;

  if (!scenes.length && !shorts.length && !transcript.length && !narrative) {
    return (
      <EmptyState
        icon={Loader2}
        compact
        title="분석 진행 중…"
        description="STT → 장면 분할 → Vision 채점"
      />
    );
  }

  const faceClusters = faces?.clusters ?? {};
  const faceCount = Object.keys(faceClusters).length;
  // ppl은 analysis.data.ppl 우선 → 폴링본 폴백 (분석 완료 이후에도 폴링본이 더 신선할 수 있음)
  const pplData = ppl ?? (data?.ppl ?? null);
  const pplCount = pplData?.detections?.length ?? 0;
  const subTabs: { key: AnalyzeView; label: string; icon: typeof Layers; count: number }[] = [
    { key: "scenes", label: "장면", icon: Layers, count: scenes.length },
    { key: "script", label: "자막", icon: FileText, count: transcript.length },
    { key: "narrative", label: "서사", icon: BookOpen, count: narrative?.segments?.length ?? 0 },
    { key: "cast", label: "인물", icon: Users, count: faceCount || (castData?.people?.length ?? 0) },
    { key: "ppl", label: "PPL·브랜드", icon: ShoppingBag, count: pplCount },
  ];

  return (
    <div className="space-y-2">
      {/* 재분석 바 — cast 바꾼 뒤 트리거하면 지문 바뀐 스테이지만 재실행 */}
      <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/30 px-2.5 py-1.5">
        <span className="flex-1 text-[11px] text-muted-foreground">파이프라인 재실행 · cast·프로파일 바꾼 뒤 트리거</span>
        <Button size="xs" variant="outline" onClick={() => retryAnalysis(true)} disabled={!!retrying}>
          {retrying === "fast" ? "요청 중…" : "빠른 재분석"}
        </Button>
        <Button size="xs" onClick={() => retryAnalysis(false)} disabled={!!retrying}>
          {retrying === "full" ? "요청 중…" : "정밀 재분석"}
        </Button>
      </div>
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

      {view === "scenes" && <ScenesView scenes={scenes} />}

      {view === "narrative" && <NarrativeView narrative={narrative} />}

      {view === "cast" && (
        faceCount === 0 ? (
          <CastView mediaId={master?.id} />
        ) : (
          <FaceClustersView
            mediaId={master.id}
            apiBase={app.apiBase}
            faces={faces!}
            programCast={programCast}
            pendingMap={pendingMap}
            setPendingMap={setPendingMap}
            savingMap={savingMap}
            onSave={async () => {
              if (!master || savingMap || Object.keys(pendingMap).length === 0) return;
              setSavingMap(true);
              try {
                await patchMediaFacesMapping(master.id, pendingMap);
                setPendingMap({});
                const fresh = await getMediaFaces(master.id);
                setFaces(fresh);
                toast({ title: "매핑 저장됨", description: "refined.speaker 필드도 rename 됐어요.", tone: "done" });
              } catch (e) {
                toast({ title: "매핑 저장 실패", description: e instanceof Error ? e.message : "다시 시도해 주세요.", tone: "error" });
              } finally {
                setSavingMap(false);
              }
            }}
          />
        )
      )}

      {view === "script" && (
        <ScriptView
          transcript={transcript}
          savedMap={faces?.mapping ?? {}}
          pendingMap={pendingMap}
          setPendingMap={setPendingMap}
          onSave={async () => {
            if (!master || savingMap || Object.keys(pendingMap).length === 0) return;
            setSavingMap(true);
            try {
              await patchMediaFacesMapping(master.id, pendingMap);
              setPendingMap({});
              const fresh = await getMediaFaces(master.id);
              setFaces(fresh);
              toast({ title: "화자 이름 저장됨", description: "자막의 speaker가 rename 됐어요.", tone: "done" });
            } catch (e) {
              toast({ title: "저장 실패", description: e instanceof Error ? e.message : "다시 시도해 주세요.", tone: "error" });
            } finally {
              setSavingMap(false);
            }
          }}
          savingMap={savingMap}
          programCast={programCast}
        />
      )}

      {view === "ppl" && (
        <PplView ppl={pplData} mediaId={master.id} apiBase={app.apiBase} />
      )}
    </div>
  );
}

const FALLBACK_SPEAKER_RE = /^(M\d+|F\d+|MC\d*|NARR|\?)$/;

/** 자막 리스트 — 행 클릭 시 상단 원본 플레이어를 그 순간으로 seek + 재생.
 *  상단 "화자 이름 지정" 바에서 M1/F1/MC/NARR/? 같은 폴백 라벨에 이름을 붙이면
 *  faces 매핑 API로 저장 → refined.speaker 전체 rename. 저장 전 pending은 뱃지에 즉시 반영. */
function ScriptView({
  transcript,
  savedMap,
  pendingMap,
  setPendingMap,
  onSave,
  savingMap,
  programCast,
}: {
  transcript: AnalysisTranscriptSegment[];
  savedMap: Record<string, string>;
  pendingMap: Record<string, string>;
  setPendingMap: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onSave: () => Promise<void>;
  savingMap: boolean;
  programCast: string[];
}) {
  const seek = useVideoSeek();
  const effectiveMap: Record<string, string> = { ...savedMap, ...pendingMap };
  const pendingCount = Object.keys(pendingMap).length;

  // 자막에 실제로 등장한 폴백 라벨만 매핑 대상으로. 등장 순 유지.
  const seen = new Set<string>();
  const fallbackSpeakers: string[] = [];
  for (const s of transcript) {
    const sp = (s.speaker ?? "").trim();
    if (sp && FALLBACK_SPEAKER_RE.test(sp) && !seen.has(sp)) {
      seen.add(sp);
      fallbackSpeakers.push(sp);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {fallbackSpeakers.length > 0 && (
        <div className="rounded-md border border-brand/25 bg-brand/5 p-2.5">
          <div className="mb-1.5 flex items-center gap-2 text-[11px] text-brand">
            <span className="flex-1 font-semibold">
              화자 이름 지정 · {fallbackSpeakers.length}명
              <span className="ml-1 font-normal text-brand/70">
                (M1·F1 같은 임시 라벨에 실명 붙이기)
              </span>
            </span>
            <Button size="xs" onClick={onSave} disabled={pendingCount === 0 || savingMap}>
              {savingMap
                ? "저장 중…"
                : pendingCount > 0
                  ? `${pendingCount}개 저장`
                  : "저장할 이름 없음"}
            </Button>
          </div>
          <div
            className="grid gap-1.5"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}
          >
            {fallbackSpeakers.map((sp) => {
              const currentValue = effectiveMap[sp] ?? "";
              const isPending = pendingMap[sp] != null;
              return (
                <div
                  key={sp}
                  className="flex items-center gap-1.5 rounded border border-border bg-background px-1.5 py-1"
                  style={isPending ? { borderColor: "var(--color-brand)" } : undefined}
                >
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground">
                    {sp}
                  </span>
                  <input
                    list={`speaker-cast-${sp}`}
                    value={currentValue}
                    placeholder="이름"
                    onChange={(e) => setPendingMap((prev) => ({ ...prev, [sp]: e.target.value }))}
                    className="w-full min-w-0 rounded border border-input bg-background px-1.5 py-0.5 text-[11px]"
                  />
                  <datalist id={`speaker-cast-${sp}`}>
                    {programCast.map((n) => (
                      <option key={n} value={n} />
                    ))}
                  </datalist>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <Card className="max-h-[60vh] overflow-y-auto">
        <ul className="divide-y divide-border">
          {transcript.map((s, i) => {
            const rawSp = s.speaker ?? "";
            // pending 우선, 없으면 saved, 그것도 없으면 원본 라벨.
            const displaySp = rawSp ? (effectiveMap[rawSp] || rawSp) : "";
            const isFallback = displaySp !== "" && FALLBACK_SPEAKER_RE.test(displaySp);
            return (
              <li
                key={i}
                className="flex cursor-pointer items-start gap-2 px-3 py-1.5 text-[12px] hover:bg-muted/40"
                onClick={() => seek?.seekTo(s.start)}
                title={`▶ ${formatTimecode(s.start)}부터 재생`}
              >
                <span className="shrink-0 pt-0.5 tabular-nums text-[11px] text-muted-foreground">
                  {formatTimecode(s.start)}
                </span>
                {displaySp && (
                  <span
                    className={cn(
                      "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold",
                      isFallback
                        ? "bg-muted text-muted-foreground"
                        : "bg-brand/15 text-brand",
                    )}
                    title={isFallback ? "폴백 라벨 · 위에서 이름 지정 가능" : "실명 라벨"}
                  >
                    {displaySp}
                  </span>
                )}
                <span className="leading-relaxed">{s.text}</span>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

/** Scene list — color-coded vision score, dialogue/silent, tags, on-screen names, dialogue.
 *  씬 행 클릭 시 상단 원본 플레이어를 그 씬 시작 시각으로 seek. */
function ScenesView({ scenes }: { scenes: AnalysisScene[] }) {
  const [sort, setSort] = useState<"time" | "score">("time");
  const [silentOnly, setSilentOnly] = useState(false);
  const seek = useVideoSeek();

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
          <li
            key={s.index ?? i}
            className="cursor-pointer px-3 py-2 hover:bg-muted/40"
            onClick={() => seek?.seekTo(s.start)}
            title={`▶ ${formatTimecode(s.start)}부터 재생`}
          >
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

function FaceClustersView({
  mediaId,
  apiBase,
  faces,
  programCast,
  pendingMap,
  setPendingMap,
  savingMap,
  onSave,
}: {
  mediaId: string;
  apiBase: string;
  faces: MediaFaces;
  programCast: string[];
  pendingMap: Record<string, string>;
  setPendingMap: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  savingMap: boolean;
  onSave: () => Promise<void>;
}) {
  const clusters = faces.clusters ?? {};
  const savedMap = faces.mapping ?? {};
  const effectiveMap: Record<string, string> = { ...savedMap, ...pendingMap };
  const pendingCount = Object.keys(pendingMap).length;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-brand/25 bg-brand/5 px-2.5 py-2 text-[11px] text-brand">
        <span className="flex-1">
          {Object.keys(clusters).length}개 인물 그룹 · {faces.labeled_segments ?? 0} 세그먼트 라벨링. 매핑 저장 시 refined.speaker 전체 rename.
          {programCast.length === 0 && <span className="mt-1 block text-status-warn">⚠ 프로그램에 등록된 cast가 없어요 — 프로그램 편집에서 출연자부터 넣어주세요.</span>}
        </span>
        <Button size="xs" onClick={onSave} disabled={pendingCount === 0 || savingMap}>
          {savingMap ? "저장 중…" : pendingCount > 0 ? `${pendingCount}개 매핑 저장` : "저장할 매핑 없음"}
        </Button>
      </div>
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
        {Object.entries(clusters)
          .sort((a, b) => b[1].count - a[1].count)
          .map(([label, meta]) => {
            const currentValue = effectiveMap[label] ?? "";
            const isPending = pendingMap[label] != null;
            return (
              <Card key={label} className="p-2.5" style={isPending ? { borderColor: "var(--color-brand)" } : undefined}>
                <div className="mb-1.5 flex items-center gap-1.5">
                  <span className="rounded-md px-1.5 py-0.5 text-[11px] font-bold" style={{ background: meta.gender_hint === "M" ? "rgba(94,155,255,.15)" : "rgba(245,165,36,.15)", color: meta.gender_hint === "M" ? "#5e9bff" : "#f5a524" }}>{label}</span>
                  <span className="text-[10.5px] text-muted-foreground">{meta.count}회</span>
                  <span className="ml-auto text-[10px] text-muted-foreground/70">{meta.gender_hint === "M" ? "남" : "여"}</span>
                </div>
                <div className="mb-1.5 grid grid-cols-3 gap-1">
                  {meta.representative_frames.map((fp) => {
                    const name = fp.split("/").pop() ?? fp;
                    const url = `${apiBase}/media/${mediaId}/analysis/faces/${name}`;
                    return (
                      <div key={fp} className="relative aspect-square overflow-hidden rounded border border-border bg-muted">
                        <img src={url} alt={label} loading="lazy" className="absolute inset-0 size-full object-cover" />
                      </div>
                    );
                  })}
                </div>
                {/* 이름 입력 — 프로그램 cast는 자동완성 후보로, 그 외 임의 이름도 자유 입력 */}
                <input
                  list={`cast-suggest-${label}`}
                  value={currentValue}
                  placeholder="이름 입력 또는 선택"
                  onChange={(e) => setPendingMap((prev) => ({ ...prev, [label]: e.target.value }))}
                  className="w-full rounded border border-input bg-background px-2 py-1 text-[11.5px]"
                />
                <datalist id={`cast-suggest-${label}`}>
                  {programCast.map((n) => (
                    <option key={n} value={n} />
                  ))}
                </datalist>
                {savedMap[label] && !isPending && (
                  <div className="mt-1 text-[10.5px] text-status-done">✓ 저장됨 · {savedMap[label]}</div>
                )}
                {isPending && (
                  <div className="mt-1 text-[10.5px] text-brand">● 저장 대기 · {pendingMap[label] || "(삭제)"}</div>
                )}
              </Card>
            );
          })}
      </div>
    </div>
  );
}