"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Save, Send, Info, Check, Sparkles, Film } from "lucide-react";
import { useAppData } from "@/lib/data/store";
import { getStreamUrl } from "@/lib/data/api";
import {
  applyTemplate,
  makeInitialEditorState,
  type EditorState,
} from "@/lib/editor/presets";
import { formatDuration } from "@/lib/utils";
import { EditorPreview } from "@/components/editor/editor-preview";
import { EditorPanel } from "@/components/editor/editor-panel";
import { EditorTimeline } from "@/components/editor/editor-timeline";
import { EditorAiPanel } from "@/components/editor/editor-ai-panel";
import type { Recommendation } from "@/lib/types";

export function EditorShell({ clipId }: { clipId: string }) {
  const { clips, recsForEpisode, mediaForEpisode, saveClipEditor, exportClip } = useAppData();
  const clip = clips.find((c) => c.id === clipId);

  const title = clip?.title ?? "새 클립";
  const duration = clip?.durationSec ?? 40;
  const recs = clip ? recsForEpisode(clip.episodeId) : [];

  // Real footage: the encoded clip video, else the episode's uploaded master — fetched as a
  // signed GCS URL the player streams directly from Cloud Storage (no proxy in the byte path).
  const master = clip ? mediaForEpisode(clip.episodeId, "master") : undefined;
  const mediaId = clip?.mediaId ?? master?.id;
  const [videoUrl, setVideoUrl] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    if (mediaId) getStreamUrl(mediaId).then((u) => !cancelled && setVideoUrl(u)).catch(() => {});
    else setVideoUrl(undefined);
    return () => {
      cancelled = true;
    };
  }, [mediaId]);

  const [state, setState] = useState<EditorState>(
    () => clip?.editorState ?? makeInitialEditorState(title, duration),
  );
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const rendered = clip?.status === "ready" || clip?.status === "published";

  // Hydrate from a previously saved revision once the clip lands (async store load /
  // hard refresh). Keyed on clip id so it runs on first arrival, never clobbering edits.
  useEffect(() => {
    if (clip?.editorState) {
      setState(clip.editorState);
      setSaved(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.id]);

  async function save() {
    if (!clip) {
      setSaved(true);
      return;
    }
    setSaving(true);
    try {
      await saveClipEditor(clip.id, state);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  // The single expensive render (plan §2.4): everything above was metadata. Persist the
  // latest decisions first so the render (and its revision-hash cache) reflects them.
  async function confirmExport() {
    if (!clip) return;
    setExporting(true);
    try {
      if (!saved) {
        await saveClipEditor(clip.id, state);
        setSaved(true);
      }
      await exportClip(clip.id);
    } finally {
      setExporting(false);
    }
  }

  const update = (patch: Partial<EditorState>) => {
    setState((s) => ({ ...s, ...patch }));
    setSaved(false);
  };
  const applyTpl = (id: EditorState["templateId"]) => setState((s) => applyTemplate(s, id));

  function applyRec(rec: Recommendation) {
    setState((s) => ({
      ...s,
      titleLines: [{ ...s.titleLines[0], text: rec.title }, ...s.titleLines.slice(1)],
      trimIn: 0,
      trimOut: Math.max(1, rec.endTime - rec.startTime),
    }));
    setSaved(false);
  }

  // The real <video> element is the transport's source of truth; both the preview
  // (which mounts it) and the timeline (which drives it) share this handle.
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const timelineDuration = videoDuration ?? duration;

  const togglePlay = useCallback(() => {
    const v = videoEl;
    if (!v) return;
    if (v.paused) {
      // Snap into the trim window before playing so preview stays render-free (§2.4).
      if (v.currentTime < state.trimIn || v.currentTime >= state.trimOut - 0.05) {
        v.currentTime = state.trimIn;
      }
      void v.play();
    } else {
      v.pause();
    }
  }, [videoEl, state.trimIn, state.trimOut]);

  const handleDuration = useCallback(
    (d: number) => {
      setVideoDuration(d);
      if (state.trimOut > d) update({ trimOut: d });
    },
    [state.trimOut],
  );

  const backHref = clip ? `/episodes/${clip.episodeId}?tab=clips` : "/clips";

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      {/* header */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-zinc-800 px-3 sm:gap-3 sm:px-4">
        <Link
          href={backHref}
          className="inline-flex shrink-0 items-center gap-1.5 text-sm text-zinc-400 transition-colors hover:text-zinc-100"
        >
          <ArrowLeft className="size-4" /> <span className="hidden sm:inline">나가기</span>
        </Link>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>

        <div className="flex shrink-0 items-center gap-2">
          <MetadataButton state={state} duration={duration} />
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-60"
          >
            {saved ? <Check className="size-4 text-emerald-400" /> : <Save className="size-4" />}
            {saving ? "저장 중…" : saved ? "저장됨" : "저장"}
          </button>
          <button
            onClick={confirmExport}
            disabled={exporting}
            title="편집 결정을 최종 렌더로 굽습니다 (렌더는 여기서 단 한 번 — plan §2.4)"
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-60"
          >
            {rendered ? <Check className="size-4 text-emerald-400" /> : <Film className="size-4" />}
            {exporting ? "렌더 중…" : rendered ? "확정됨" : "확정(렌더)"}
          </button>
          <Link
            href="/distribution"
            className="inline-flex items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-sm font-medium text-black hover:bg-zinc-200"
          >
            <Send className="size-4" /> 배포
          </Link>
        </div>
      </header>

      {/* body — 3 columns; side panels fold away on narrow viewports so the
          preview never gets crushed (AI panel below lg, properties below md). */}
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-52 shrink-0 border-r border-zinc-800 lg:block xl:w-60">
          <EditorAiPanel recs={recs} onApply={applyRec} />
        </aside>

        <div className="flex min-w-0 flex-1 items-center justify-center overflow-auto bg-zinc-900 p-4 sm:p-6">
          <EditorPreview
            state={state}
            update={update}
            videoUrl={videoUrl}
            videoRef={setVideoEl}
            onDuration={handleDuration}
            onTogglePlay={togglePlay}
          />
        </div>

        <aside className="hidden w-72 shrink-0 border-l border-zinc-800 md:block xl:w-80">
          <EditorPanel state={state} update={update} applyTpl={applyTpl} />
        </aside>
      </div>

      {/* timeline */}
      <footer className="shrink-0 border-t border-zinc-800 p-3">
        <EditorTimeline
          state={state}
          update={update}
          duration={timelineDuration}
          video={videoEl}
          videoUrl={videoUrl}
          onTogglePlay={togglePlay}
        />
      </footer>
    </div>
  );
}

/** Editor-embedded upload metadata preview (StepD pattern). */
function MetadataButton({ state, duration }: { state: EditorState; duration: number }) {
  const [open, setOpen] = useState(false);
  const title = state.titleLines.map((l) => l.text).join(" ").trim() || "제목 미설정";
  const tags = ["쇼츠", "예능", "하이라이트"];

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
      >
        <Info className="size-4" /> 메타데이터
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 top-[calc(100%+8px)] z-50 w-80 rounded-lg border border-zinc-700 bg-zinc-900 p-4 shadow-2xl">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-zinc-300">
              <Sparkles className="size-3.5 text-amber-400" /> 쇼츠 배포 메타데이터 · AI 최적화
            </div>
            <div className="text-sm font-medium">{title}</div>
            <div className="mt-1 text-xs text-zinc-500">
              {state.channelName} · {state.aspect} · {formatDuration(duration)}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <Stat label="예상 조회수" value="12.4만" />
              <Stat label="예상 CTR" value="8.7%" />
              <Stat label="SEO 점수" value="94" />
              <Stat label="완주율" value="71%" />
            </div>
            <div className="mt-3 flex flex-wrap gap-1">
              {tags.map((t) => (
                <span key={t} className="rounded-full border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400">
                  #{t}
                </span>
              ))}
            </div>
            <div className="mt-3 border-t border-zinc-800 pt-2 text-[11px] text-zinc-500">
              AI 추천 발행: 수 19:00 (KST) · 실제 예측·발행은 M6에서 연동
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-zinc-800 p-2">
      <div className="text-[10px] text-zinc-500">{label}</div>
      <div className="text-base font-bold text-amber-400">{value}</div>
    </div>
  );
}
