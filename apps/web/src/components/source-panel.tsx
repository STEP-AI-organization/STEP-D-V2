"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { FileVideo, Loader2 } from "lucide-react";
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

  /** 현재 시각에 걸리는 자막 한 줄 — 분석 JSON 은 이미 위에서 받아 둔 것을 쓴다(추가 요청 0). */
  const caption = useMemo(() => {
    const segs = analysis?.data?.transcript;
    if (!segs?.length) return null;
    const hit = segs.find((x) => currentTime >= x.start && currentTime < (x.end ?? x.start + 4));
    return hit?.text?.trim() || null;
  }, [analysis, currentTime]);

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
      // 색은 원본 트랙과 같게 — 쇼츠 후보 indigo-500, 분석 구간 blue-500(원본 D:598·623).
      lanes.push({ key: "shorts", label: "쇼츠 후보", color: "#6366f1", blocks: shortsBlocks });
    if (pplBlocks.length)
      lanes.push({ key: "ppl", label: "PPL·브랜드", color: "#f5a524", blocks: pplBlocks });
    if (sceneBlocks.length)
      lanes.push({ key: "analysis", label: "분석 구간", color: "#3b82f6", blocks: sceneBlocks });
    return lanes;
  }, [allMarkers, analysis?.data?.scenes, analysis?.data?.ppl?.detections]);

  if (!master) {
    return (
      <div className="bg-[var(--color-bg-card)] border-none shadow-md shadow-slate-900/5 dark:shadow-none rounded-2xl h-64 flex flex-col items-center justify-center gap-3">
        <FileVideo className="w-10 h-10 text-[var(--color-text-muted)]" />
        <p className="text-xs text-[var(--color-text-muted)]">업로드된 영상이 없습니다</p>
      </div>
    );
  }

  return (
    <>
      {/* Full-width Compact Video Player Container matching AI Timeline width
          (원본 episodes/e_1293d2f1/page.tsx D:485–533) */}
      <div className="w-full space-y-2.5">
        <div className="w-full bg-black rounded-2xl overflow-hidden relative border border-slate-200/80 dark:border-slate-800 shadow-md">
          {/* Player Area with Letterboxing support */}
          <div className="relative w-full h-[400px] bg-black flex items-center justify-center">
            {videoSrc ? (
              <video
                ref={videoRef}
                key={videoSrc}
                src={videoSrc}
                controls
                playsInline
                onTimeUpdate={onTimeUpdate}
                className="max-w-full max-h-full object-contain"
              >
                <track kind="captions" />
              </video>
            ) : (
              /* 못 불러오면 검은 사각형만 남기지 않는다 — 왜 안 나오는지 적는다. */
              <div className="px-6 py-10 text-center text-xs text-slate-400">
                {videoError ?? "원본을 불러오는 중…"}
              </div>
            )}

            {/* Subtitle Overlay (Bottom Center of Video) — 원본은 문자열 리터럴이다.
                진짜 자막은 이미 받아 둔 분석 JSON 에 있으니 현재 시각에 걸리는 것만 그린다. */}
            {caption && (
              <div className="absolute bottom-12 left-1/2 -translate-x-1/2 bg-black/85 px-4 py-1.5 rounded-xl text-white text-xs font-medium border border-white/10 pointer-events-none z-10 shadow-lg">
                {caption}
              </div>
            )}
          </div>
        </div>

        {/* Video Metadata & File Name Bar (Positioned below the video) */}
        <div className="flex items-center gap-6 px-2 text-[12px] text-[var(--color-text-muted)] font-medium flex-wrap">
          <div className="flex items-center gap-1.5 font-bold text-[var(--color-text-primary)] min-w-0">
            <FileVideo className="w-4 h-4 text-[var(--color-bg-active)] shrink-0" />
            <span className="truncate">{master.filename}</span>
          </div>
          <span className="opacity-30">|</span>
          <div>해상도 <strong className="text-[var(--color-text-primary)]">{master.width}×{master.height}</strong></div>
          <div>길이 <strong className="text-[var(--color-text-primary)]">{formatTimecode(durationSec)}</strong></div>
          <div>코덱 <strong className="text-[var(--color-text-primary)]">{master.codec || "—"}</strong></div>
          <div>오디오 <strong className="text-[var(--color-text-primary)]">{master.hasAudio ? "있음" : "없음"}</strong></div>
          <div>용량 <strong className="text-[var(--color-text-primary)]">{(master.size / 1024 / 1024).toFixed(1)}MB</strong></div>
        </div>
      </div>

      {/* Analysis still loading — the player above stays usable meanwhile. */}
      {loading && !analysis && (
        <div className="flex items-center justify-center gap-2 py-3 text-xs text-[var(--color-text-muted)]">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> 분석 로딩 중…
        </div>
      )}

      {/* AI 타임라인 · 하이라이트 (No outer BG, No shadow, Full Width) — 시각 레이어라
          길이가 있어야 트랙을 그린다. 검출이 하나도 없으면 아예 그리지 않는다. */}
      {durationSec > 0 && timelineLanes.length > 0 && (
        <div className="w-full space-y-3">
          <ReviewTimeline
            durationSec={durationSec}
            currentTime={currentTime}
            onSeek={seekTo}
            lanes={timelineLanes}
          />
        </div>
      )}

      {/* Horizontal Dividing Line Below AI Timeline */}
      <div className="border-b border-slate-200 dark:border-slate-800/80 my-5" />

      {/* Single Background Container with Vertical Divider Lines for 쇼츠 추천 / 장면 / 자막.
          Vision 점수 칩은 뺐다: 현재 파이프라인(run_scenes)은 vision_score 를 산출하지 않아
          항상 "—" 였다. 근거 없는 지표 자리를 남기지 않는다. */}
      {analysis?.data && (
        <div className="bg-[var(--color-bg-card)] border border-slate-200/70 dark:border-slate-800 shadow-md shadow-slate-900/5 dark:shadow-none rounded-2xl p-4 grid grid-cols-3 divide-x divide-slate-200 dark:divide-slate-800">
          <CountCell label="쇼츠 추천" value={(analysis.data.shorts ?? []).length} accent />
          <CountCell label="장면" value={(analysis.data.scenes ?? []).length} />
          <CountCell label="자막" value={(analysis.data.transcript ?? []).length} />
        </div>
      )}
    </>
  );
}

/** 원본 3분할 개수 셀 (D:658–675). 쇼츠 추천만 파란 숫자다. */
function CountCell({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between px-6 py-1">
      <span className="font-bold text-sm text-slate-700 dark:text-slate-300">{label}</span>
      <span className={`text-xl font-bold ${accent ? "text-[var(--color-bg-active)]" : "text-[var(--color-text-primary)]"}`}>
        {value}
      </span>
    </div>
  );
}
