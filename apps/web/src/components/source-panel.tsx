"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { FileVideo, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { getStreamUrl } from "@/lib/data/api";
import { useAppData } from "@/lib/data/store";
import { useMediaAnalysisPoll } from "@/lib/data/use-media-analysis";
import { formatTimecode } from "@/lib/utils";
import { markersFromAnalysis, type TimelineMarker } from "./timeline-markers";
import { ReviewTimeline, type TimelineLane, type TimelineBlock } from "./review-timeline";
import { useVideoSeek } from "./episode/seek-context";

/**
 * Left panel — source video player with AI timeline markers.
 * Opus Clip style: the source video is always visible while reviewing derivatives.
 */
export function SourcePanel({ episodeId }: { episodeId: string }) {
  const { mediaForEpisode, recommendations } = useAppData();
  const master = mediaForEpisode(episodeId, "master");
  const [videoSrc, setVideoSrc] = useState<string>();
  const [videoError, setVideoError] = useState<string | null>(null);
  const { analysis, loading } = useMediaAnalysisPoll(master?.id);
  const [currentTime, setCurrentTime] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);

  // 상위 SeekProvider에 이 <video>를 등록 → 다른 카드가 seekTo() 하면 여기서 재생.
  // SourcePanel이 언마운트되면 등록 해제.
  const seekCtx = useVideoSeek();
  useEffect(() => {
    seekCtx?.registerVideo(videoRef.current);
    return () => seekCtx?.registerVideo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoSrc]);

  // Load stream URL
  useEffect(() => {
    if (!master) return;
    let cancelled = false;
    setVideoSrc(undefined);
    setVideoError(null);
    getStreamUrl(master.id)
      .then((u) => { if (!cancelled) setVideoSrc(u); })
      // 못 불러오면 검은 사각형만 남기지 않는다 — 왜 안 나오는지 적는다(analyze 화면과 같은 처리).
      .catch((err) => {
        if (!cancelled)
          setVideoError(`원본을 불러오지 못했습니다 (${err instanceof Error ? err.message : String(err)})`);
      });
    return () => { cancelled = true; };
  }, [master?.id]);

  // 내부 seek — 타임라인 lane 클릭용. 컨텍스트 있으면 그쪽으로 넘김.
  const seekTo = useCallback(
    (time: number) => {
      if (seekCtx) return seekCtx.seekTo(time);
      const video = videoRef.current;
      if (video) {
        video.currentTime = time;
        video.play().catch(() => {});
      }
    },
    [seekCtx],
  );

  const onTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (video) setCurrentTime(video.currentTime);
  }, []);

  const durationSec = master?.durationSec ?? 0;

  // Recommendations are minted 1:1 from the analysis shorts (server recFromShort), so drawing
  // both would double every segment. Prefer the recs — they carry the real score fields —
  // and fall back to the raw shorts only before the board has been wired up.
  // Memoised on the store's own array: recsForEpisode() allocates a new one per call, and this
  // recomputes on every timeupdate tick otherwise.
  const allMarkers: TimelineMarker[] = useMemo(() => {
    const recMarkers = recommendations
      .filter((r) => r.episodeId === episodeId && r.startTime != null && r.endTime != null)
      .map((r) => ({
        start: r.startTime!,
        end: r.endTime!,
        appeal: r.appeal,
        score100: r.score100,
        label: r.title,
      }));
    if (recMarkers.length > 0) return recMarkers.sort((a, b) => a.start - b.start);
    return markersFromAnalysis(analysis?.data?.shorts ?? []);
  }, [recommendations, episodeId, analysis?.data?.shorts]);

  // Multi-lane highlight timeline (visual layer). **실제 분석 산출물이 있는 레인만** 그린다.
  // 예전엔 데이터가 없으면 '샘플' 블록으로 트랙을 채웠는데, 그 블록도 클릭·seek 가 되는 탓에
  // 존재하지 않는 PPL·쇼츠 구간이 조작 가능한 UI 로 남았다(PPL 은 RUN_PPL=0 이라 상시 빈 레인).
  const timelineLanes: TimelineLane[] = useMemo(() => {
    const scenes = analysis?.data?.scenes ?? [];
    const pplDetections = analysis?.data?.ppl?.detections ?? [];
    const shortsBlocks: TimelineBlock[] = allMarkers.map((m, i) => ({
      id: `sh${i}`,
      start: m.start,
      end: m.end,
      title: m.label || `쇼츠 후보 ${i + 1}`,
      // score100(0-100)이 있으면 그걸, 없으면 legacy appeal(1-5)에서 근사. 옛 회차 호환.
      sub:
        typeof m.score100 === "number"
          ? `${Math.round(m.score100)}점`
          : typeof m.appeal === "number"
            ? `${Math.round((m.appeal - 1) * 25)}점`
            : undefined,
    }));
    const sceneBlocks: TimelineBlock[] = scenes
      .filter((s) => s.start != null && s.end != null)
      .slice(0, 60)
      .map((s, i) => ({
        id: `sc${i}`,
        start: Number(s.start),
        end: Number(s.end),
        title: `장면 ${(s.index ?? i) + 1}`,
        sub: s.vision_score != null ? `Vision ${s.vision_score}` : undefined,
      }));
    const pplBlocks: TimelineBlock[] = pplDetections.map((d, i) => ({
      id: `pp${i}`,
      start: Number(d.start),
      end: Number(d.end),
      title: d.brand,
      sub: d.category || undefined,
    }));

    const lanes: TimelineLane[] = [];
    if (shortsBlocks.length)
      lanes.push({ key: "shorts", label: "쇼츠 후보", color: "#8b7cf6", blocks: shortsBlocks });
    if (pplBlocks.length)
      lanes.push({ key: "ppl", label: "PPL·브랜드", color: "#f5a524", blocks: pplBlocks });
    if (sceneBlocks.length)
      lanes.push({ key: "analysis", label: "분석 구간", color: "#5e9bff", blocks: sceneBlocks });
    return lanes;
  }, [allMarkers, analysis?.data?.scenes, analysis?.data?.ppl?.detections]);

  if (!master) {
    return (
      <Card className="flex h-64 flex-col items-center justify-center gap-3">
        <FileVideo className="size-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">업로드된 영상이 없습니다</p>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {/* Video player */}
      <Card className="overflow-hidden p-0">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm font-semibold">
          <FileVideo className="size-4" /> {master.filename}
        </div>
        <div className="bg-black">
          {videoSrc ? (
            <video
              ref={videoRef}
              key={videoSrc}
              src={videoSrc}
              controls
              playsInline
              onTimeUpdate={onTimeUpdate}
              className="mx-auto max-h-[50vh] w-full object-contain"
            />
          ) : (
            <div className="grid min-h-40 place-items-center px-6 py-10 text-center text-xs text-muted-foreground">
              {videoError ?? "원본을 불러오는 중…"}
            </div>
          )}
        </div>
        {/* Video metadata */}
        <div className="flex flex-wrap gap-x-6 gap-y-1 px-4 py-2 text-xs text-muted-foreground">
          <span>해상도 <span className="tabular-nums text-foreground">{master.width}×{master.height}</span></span>
          <span>길이 <span className="tabular-nums text-foreground">{formatTimecode(durationSec)}</span></span>
          <span>코덱 <span className="text-foreground">{master.codec || "—"}</span></span>
          <span>오디오 <span className="text-foreground">{master.hasAudio ? "있음" : "없음"}</span></span>
          <span>용량 <span className="tabular-nums text-foreground">{(master.size / 1024 / 1024).toFixed(1)}MB</span></span>
        </div>
      </Card>

      {/* Analysis still loading — the player above stays usable meanwhile. */}
      {loading && !analysis && (
        <Card className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> 분석 로딩 중…
        </Card>
      )}

      {/* Multi-lane highlight timeline (쇼츠 / PPL / 분석) — visual layer; needs a
          duration to scale the tracks to. 검출이 하나도 없으면 아예 그리지 않는다. */}
      {durationSec > 0 && timelineLanes.length > 0 && (
        <ReviewTimeline
          durationSec={durationSec}
          currentTime={currentTime}
          onSeek={seekTo}
          lanes={timelineLanes}
        />
      )}

      {/* Quick stats — Vision 점수 칩은 뺐다: 현재 파이프라인(run_scenes)은 vision_score 를
          산출하지 않아 항상 "—" 였다. 근거 없는 지표 자리를 남기지 않는다. */}
      {analysis?.data && (
        <div className="grid grid-cols-3 gap-2 text-xs">
          <StatChip label="쇼츠 추천" value={(analysis.data.shorts ?? []).length} tone="warn" />
          <StatChip label="장면" value={(analysis.data.scenes ?? []).length} tone="muted" />
          <StatChip label="자막" value={(analysis.data.transcript ?? []).length} tone="muted" />
        </div>
      )}
    </div>
  );
}

function StatChip({ label, value, tone }: { label: string; value: number | string; tone: "done" | "warn" | "muted" }) {
  const colorMap = {
    done: "text-status-done",
    warn: "text-status-warn",
    muted: "text-muted-foreground",
  };
  return (
    <Card className="p-2 text-center">
      <div className={`text-base font-bold ${colorMap[tone]}`}>{value}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </Card>
  );
}