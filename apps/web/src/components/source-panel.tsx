"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { FileVideo, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { getStreamUrl } from "@/lib/data/api";
import { useAppData } from "@/lib/data/store";
import { useMediaAnalysisPoll } from "@/lib/data/use-media-analysis";
import { formatTimecode } from "@/lib/utils";
import { TimelineMarkers, markersFromAnalysis, type TimelineMarker } from "./timeline-markers";

/**
 * Left panel — source video player with AI timeline markers.
 * Opus Clip style: the source video is always visible while reviewing derivatives.
 */
export function SourcePanel({ episodeId }: { episodeId: string }) {
  const { mediaForEpisode, recommendations } = useAppData();
  const master = mediaForEpisode(episodeId, "master");
  const [videoSrc, setVideoSrc] = useState<string>();
  const { analysis, loading } = useMediaAnalysisPoll(master?.id);
  const [currentTime, setCurrentTime] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Load stream URL
  useEffect(() => {
    if (!master) return;
    let cancelled = false;
    getStreamUrl(master.id)
      .then((u) => { if (!cancelled) setVideoSrc(u); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [master?.id]);

  const seekTo = useCallback(
    (time: number) => {
      const video = videoRef.current;
      if (video) {
        video.currentTime = time;
        video.play().catch(() => {});
      }
    },
    [videoRef],
  );

  const onTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (video) setCurrentTime(video.currentTime);
  }, []);

  const durationSec = master?.durationSec ?? 0;

  // Recommendations are minted 1:1 from the analysis shorts (server recFromShort), so drawing
  // both would double every segment. Prefer the recs — they carry the real 1–5 appeal score —
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
        label: r.title,
      }));
    if (recMarkers.length > 0) return recMarkers.sort((a, b) => a.start - b.start);
    return markersFromAnalysis(analysis?.data?.shorts ?? []);
  }, [recommendations, episodeId, analysis?.data?.shorts]);

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
          <video
            ref={videoRef}
            key={videoSrc}
            src={videoSrc}
            controls
            playsInline
            onTimeUpdate={onTimeUpdate}
            className="mx-auto max-h-[50vh] w-full object-contain"
          />
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

      {/* Timeline markers — TimelineMarkers renders nothing without a duration to scale to,
          which would otherwise leave an empty captioned card behind. */}
      {durationSec > 0 && allMarkers.length > 0 && (
        <Card className="px-3 pb-8 pt-3">
          <div className="mb-2 text-xs font-semibold text-muted-foreground">
            AI 분석 구간 ({allMarkers.length}개 마커)
          </div>
          <TimelineMarkers
            markers={allMarkers}
            durationSec={durationSec}
            currentTime={currentTime}
            onSeek={seekTo}
          />
        </Card>
      )}

      {/* Quick stats */}
      {analysis?.data && (
        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <StatChip label="쇼츠 추천" value={(analysis.data.shorts ?? []).length} tone="warn" />
          <StatChip label="장면" value={(analysis.data.scenes ?? []).length} tone="muted" />
          <StatChip label="자막" value={(analysis.data.transcript ?? []).length} tone="muted" />
          <StatChip
            label="Vision 점수"
            value={
              (() => {
                const scenes = analysis.data.scenes ?? [];
                const scored = scenes.filter((s) => s.vision_score != null);
                if (!scored.length) return "—";
                const avg = Math.round(scored.reduce((a, s) => a + (s.vision_score ?? 0), 0) / scored.length);
                return avg.toString();
              })()
            }
            tone="done"
          />
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