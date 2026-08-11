"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Save, Send, Info, Check, Sparkles, Film, Plus, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useAppData } from "@/lib/data/store";
import { useToast } from "@/components/ui/toast";
import { getStreamUrl, getMediaAnalysis, generateUploadMetadata, API_BASE, type AnalysisTranscriptSegment, type AnalysisScene , fetchShortsTemplates, type FrameTemplate } from "@/lib/data/api";
import {
  applyTemplate,
  ensureTracks,
  makeInitialEditorState,
  synthesizeCaptionWords,
  pickKeywordIdx,
  type EditorState,
  type EditorTrack,
  type KfSelection,
} from "@/lib/editor/presets";
import { useEditorHistory } from "@/lib/editor/useEditorHistory";
import { EditorPreview } from "@/components/editor/editor-preview";
import { EditorPanel } from "@/components/editor/editor-panel";
import { EditorTimeline } from "@/components/editor/editor-timeline";
import { EditorAiPanel } from "@/components/editor/editor-ai-panel";
import { RENDER_CHANNELS, type RenderChannel } from "@/lib/types";

export function EditorShell({ clipId }: { clipId: string }) {
  const { clips, recsForEpisode, mediaForEpisode, saveClipEditor, exportClip } = useAppData();
  const { toast } = useToast();
  const clip = clips.find((c) => c.id === clipId);

  const title = clip?.title ?? "새 클립";
  const recs = clip ? recsForEpisode(clip.episodeId) : [];

  // Real footage: the encoded clip video, else the episode's uploaded master — fetched as a
  // signed GCS URL the player streams directly from Cloud Storage (no proxy in the byte path).
  const master = clip ? mediaForEpisode(clip.episodeId, "master") : undefined;
  const mediaId = clip?.mediaId ?? master?.id;
  // Draft clips preview the MASTER (no render yet); confirmed clips preview their own baked
  // file. Only master preview overlays live captions.
  const previewingMaster = !clip?.mediaId;
  // ── 타임라인 좌표계 ──────────────────────────────────────────────────────────
  // 예전엔 세그먼트(추천 창)만 타임라인이 되고 trimIn/trimOut은 그 안쪽 상대 초였다.
  // 이제 '원본 전체'가 타임라인이 되고 trimIn/trimOut은 마스터 절대 초. AI 추천 창은
  // [recStart, recEnd]로 별도 하이라이트만 표시하고, 사용자는 그 밖까지 트림을 확장/축소할 수 있다.
  const masterDuration = previewingMaster
    ? Math.max(1, Number(master?.durationSec ?? clip?.endTime ?? clip?.durationSec ?? 40))
    : Math.max(1, Number(clip?.durationSec ?? 40));
  const duration = masterDuration;
  // AI 추천 원본 창은 소스 추천 엔티티에서 가져온다 — clip.startTime/endTime이 저장 시
  // 트림에 맞춰 이동하더라도 원 AI 후보 위치는 고정. 소스 rec이 없으면 clip 최초값으로 폴백.
  const sourceRecEarly = clip?.sourceRecommendationId
    ? recs.find((r) => r.id === clip.sourceRecommendationId)
    : undefined;
  const recStart = previewingMaster ? Number(sourceRecEarly?.startTime ?? clip?.startTime ?? 0) : 0;
  const recEnd = previewingMaster
    ? Number(sourceRecEarly?.endTime ?? clip?.endTime ?? clip?.startTime ?? 0) || masterDuration
    : masterDuration;
  // Master id that owns the STT transcript (the segment was cut from it).
  const transcriptMediaId = clip?.sourceMediaId ?? master?.id;
  const [videoUrl, setVideoUrl] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    if (mediaId) getStreamUrl(mediaId).then((u) => !cancelled && setVideoUrl(u)).catch(() => {});
    else setVideoUrl(undefined);
    return () => {
      cancelled = true;
    };
  }, [mediaId]);

  // Real STT transcript for the master (spoken-subtitle preview). Only when previewing the
  // master — a confirmed clip already has captions burned in, so we don't overlay them.
  const [transcript, setTranscript] = useState<AnalysisTranscriptSegment[] | undefined>();
  // Real analysis scenes for the AI panel "분석" tab — always fetched when we have a
  // transcript media id (independent of previewingMaster; scenes are metadata, not overlay).
  const [scenes, setScenes] = useState<AnalysisScene[] | undefined>();
  useEffect(() => {
    let alive = true;
    if (transcriptMediaId) {
      getMediaAnalysis(transcriptMediaId)
        .then((a) => {
          if (!alive) return;
          setScenes(Array.isArray(a.data?.scenes) ? a.data!.scenes : undefined);
          // 마스터 미리보기일 때만 자막 오버레이 (확정 클립은 이미 번인)
          setTranscript(previewingMaster && Array.isArray(a.data?.transcript) ? a.data!.transcript : undefined);
        })
        .catch(() => {
          if (!alive) return;
          setScenes(undefined);
          setTranscript(undefined);
        });
    } else {
      setScenes(undefined);
      setTranscript(undefined);
    }
    return () => {
      alive = false;
    };
  }, [transcriptMediaId, previewingMaster]);

  const {
    state,
    setState,
    undo,
    redo,
    reset,
    canUndo,
    canRedo,
  } = useEditorHistory(() =>
    clip?.editorState
      ? ensureTracks(clip.editorState, duration, previewingMaster ? recStart : 0)
      : makeInitialEditorState(title, duration, recStart, recEnd, clip?.titleLine1, clip?.titleLine2),
  );
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportElapsed, setExportElapsed] = useState(0);
  // 키프레임 선택 상태 (타임라인 다이아몬드 ↔ 속성 패널 공유, C1).
  const [kfSel, setKfSel] = useState<KfSelection>(null);
  // CapCut 스타일 좌우 패널 접기/펼치기 상태 (기본 펼침 — 처음엔 다 보이게)
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  useEffect(() => {
    if (!exporting) { setExportElapsed(0); return; }
    const t0 = Date.now();
    const id = window.setInterval(() => setExportElapsed(Math.floor((Date.now() - t0) / 1000)), 500);
    return () => window.clearInterval(id);
  }, [exporting]);
  // 서버는 동기 렌더라 실제 진척 미측정. 경과 시간 기반으로 예상 단계 안내(사용자 안심용).
  // 실측(하하 15~40초 클립): 자막 번인 ~3s · 리프레이밍 ~4s · 인코딩 ~8-15s.
  const exportStage =
    exportElapsed < 3 ? "자막 번인 준비"
    : exportElapsed < 8 ? "리프레이밍(9:16 등)"
    : "인코딩(H.264)";
  const rendered = clip?.status === "ready" || clip?.status === "published";

  // ── F3: which destination this export renders for ───────────────────────────
  //
  // "" = 원본 유지 (no preset): the clip renders at its own aspect over the full segment —
  // exactly the behaviour that existed before presets. That is deliberately the fallback
  // default: seeding Shorts for everything would reframe a 16:9 하이라이트 to vertical and
  // cap it at 60s, silently changing what today's clips produce. A preset only applies when
  // something actually chose one — the AI matrix at adopt (targetChannel), or the operator here.
  const [channel, setChannel] = useState<RenderChannel | "">("");
  const [capped, setCapped] = useState<{ maxSec: number; requestedSec: number } | null>(null);

  // Seed from the clip's AI-suggested destination once it lands. Once the operator picks a
  // preset themselves (channelPickedRef), the seed must never clobber it — their choice
  // outranks the suggestion. The ref resets per clip so a new clip seeds fresh.
  const channelPickedRef = useRef(false);
  useEffect(() => {
    channelPickedRef.current = false;
  }, [clip?.id]);
  useEffect(() => {
    if (channelPickedRef.current) return;
    setChannel(clip?.targetChannel ?? "");
    setCapped(null);
  }, [clip?.id, clip?.targetChannel]);

  const preset = channel ? RENDER_CHANNELS[channel] : null;

  // Operator's manual 종횡비 pick beats the preset (aspectOverrideRef). Without this, the
  // force-sync effect below reverts every layout-tab aspect click instantly, so on the common
  // path (AI-adopted clips carry a targetChannel → preset) the 레이아웃 탭 종횡비 buttons look
  // dead. Reset per clip and whenever the operator switches destination — the new preset owns
  // the frame again until they override it once more.
  const aspectOverrideRef = useRef(false);
  useEffect(() => {
    aspectOverrideRef.current = false;
  }, [clip?.id, channel]);

  // A chosen destination seeds the frame. This is not cosmetic: the server resolves the render
  // aspect as editorState.aspect > preset > clip.aspectRatio, and buildEditorAss maps overlay
  // \pos from the preview stage's aspect — so preview must match what the render will use.
  // es.aspect is always set, so seeding it to the preset keeps preview == render by default;
  // an explicit operator override is honored by that same precedence, so it stays consistent.
  // No-op while channel is "" — which is why existing clips (no targetChannel) are untouched.
  useEffect(() => {
    if (preset && !aspectOverrideRef.current && state.aspect !== preset.aspect) {
      update({ aspect: preset.aspect });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset?.aspect, state.aspect]);

  // Layout tab writes through this: an aspect patch is an explicit operator override, so it
  // must stick against the preset force-sync. All other patches pass straight through.
  const panelUpdate = (patch: Partial<EditorState>) => {
    if ("aspect" in patch) aspectOverrideRef.current = true;
    update(patch);
  };

  // Hydrate once the clip first lands (async store load / hard refresh). A saved revision
  // restores as before; a never-saved draft re-inits from the clip's REAL title/duration —
  // on hard refresh the store starts empty, so the history was seeded with the placeholder
  // ("새 클립", 40s) and 확정(렌더) would bake a wrong cut. Only auto-reset while the
  // operator hasn't edited yet (canUndo), so in-flight edits are never clobbered.
  const hydratedClipId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!clip || hydratedClipId.current === clip.id) return;
    hydratedClipId.current = clip.id;
    if (clip.editorState) {
      reset(ensureTracks(clip.editorState, duration, previewingMaster ? recStart : 0));
      setSaved(true);
    } else if (!canUndo) {
      reset(makeInitialEditorState(clip.title, duration, recStart, recEnd, clip.titleLine1, clip.titleLine2));
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
    } catch (e) {
      // A silent failure here means the operator keeps editing on top of unsaved work and
      // loses it on refresh — surface it instead of just resetting the button.
      toast({
        title: "저장 실패",
        description: e instanceof Error ? e.message : "편집 내용을 저장하지 못했습니다.",
        tone: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  // Always-fresh handle to save() for the keydown listener below. The listener isn't
  // re-bound on every edit (its deps deliberately exclude state), so calling save()
  // directly would capture a stale `state` and persist an outdated snapshot on Ctrl+S —
  // silently dropping any non-trim edit (caption/keyword color, title, elements, filters).
  const saveRef = useRef(save);
  saveRef.current = save;

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
      const res = await exportClip(clip.id, channel || undefined);
      setCapped(res.capped);
      // The render can take minutes — confirm it actually finished, not just that the
      // button reset. capped is surfaced separately by the banner below.
      toast({
        title: "렌더 완료",
        description: res.hookPreroll
          ? "클립이 확정·인코딩되었습니다. 첫 3초 훅 프리롤이 적용됐습니다."
          : "클립이 확정·인코딩되었습니다.",
        tone: "done",
      });
    } catch (e) {
      toast({
        title: "렌더 실패",
        description: e instanceof Error ? e.message : "클립 확정(렌더)에 실패했습니다. 다시 시도해 주세요.",
        tone: "error",
      });
    } finally {
      setExporting(false);
    }
  }

  const update = (patch: Partial<EditorState>) => {
    setState((s) => ({ ...s, ...patch }));
    setSaved(false);
  };

  // Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z) — skipped while typing so text fields keep native undo.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        if (canUndo) {
          e.preventDefault();
          undo();
          setSaved(false);
        }
      } else if (key === "y" || (key === "z" && e.shiftKey)) {
        if (canRedo) {
          e.preventDefault();
          redo();
          setSaved(false);
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [undo, redo, canUndo, canRedo]);
  // 프레임 템플릿 — 서버 assets/shorts-template 이 진실의 출처다. 실패해도 편집은 되어야
  // 하므로 빈 배열로 두고 프레임 없이 굴린다.
  const [frames, setFrames] = useState<FrameTemplate[]>([]);
  useEffect(() => { fetchShortsTemplates().then(setFrames).catch(() => setFrames([])); }, []);
  const frame = useMemo(
    () => frames.find((f) => f.name === state.templateId) ?? null,
    [frames, state.templateId],
  );

  const applyTpl = (id: EditorState["templateId"]) => setState((s) => applyTemplate(s, id));

  // 제목만 갈아끼우는 경로 — '제목 후보' 탭에서 클릭할 때 사용. trim은 건드리지 않는다.
  function applyTitle(title: string) {
    setState((s) => ({
      ...s,
      titleLines: [{ ...s.titleLines[0], text: title }, ...s.titleLines.slice(1)],
    }));
    setSaved(false);
  }

  // 소스 추천 — '제목 후보' 탭이 이 rec의 titleCandidates를 보여준다 (위 sourceRecEarly와 동일 값).
  const sourceRec = sourceRecEarly;

  // Phase 1: a new layer duplicates the main track's trim (same video for all tracks).
  function addTrack() {
    setState((s) => {
      const tracks = s.tracks ?? [];
      const main = tracks[0];
      const track: EditorTrack = {
        id: `track-${Date.now()}`,
        label: `트랙 ${tracks.length + 1}`,
        trimIn: main?.trimIn ?? s.trimIn,
        trimOut: main?.trimOut ?? s.trimOut,
        startTime: main?.startTime ?? 0,
        duration: main?.duration ?? Math.max(1, duration),
        speedPoints: [],
        volume: 1,
        muted: false,
        transition: { type: "cut", duration: 0 },
      };
      return { ...s, tracks: [...tracks, track] };
    });
    setSaved(false);
  }

  // The real <video> element is the transport's source of truth; both the preview
  // (which mounts it) and the timeline (which drives it) share this handle. Timeline
  // seconds match video seconds directly — trim is stored in the same coord as the
  // loaded video (master for draft, clip for rendered), so no offset needed.
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const timelineDuration = duration;

  // Track the element's position (video-timeline seconds).
  const [videoTime, setVideoTime] = useState(0);
  useEffect(() => {
    const v = videoEl;
    if (!v) return;
    const onTime = () => setVideoTime(v.currentTime);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("seeked", onTime);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("seeked", onTime);
    };
  }, [videoEl]);

  // The spoken caption under the playhead — same source & timeline as the render burn-in.
  //
  // 2026-07-24: STT segment의 절대 시각(초) 그대로 활용 (사용자 확정: "이미 초 찍혀있잖아").
  //   offsetMs는 사용자 수동 fine-tune만 (기본 0). drift·chunk 보정 로직 다 제거.
  //   전제: master 재생 시 videoTime = 원본 절대 시각 · transcript.start = 실제 발화 시각.
  //   sync 어긋나면 원인은 STT/refine 시각 정확도(코어) 이슈 → 파이프라인 쪽에서 fix.
  const captionData = useMemo(() => {
    if (!transcript) return undefined;
    const t = videoTime + (state.offsetMs || 0) / 1000; // master-absolute seconds
    const seg = transcript.find(
      (s) => Number(s.start ?? 0) <= t && t < Number(s.end ?? Number(s.start ?? 0) + 3),
    );
    const text = (seg?.text ?? "").trim();
    if (!seg || !text) return undefined;
    // 한국 방송은 word-by-word 하이라이트 안 씀. words 계산·keyword pick 제거 (2026-07-24).
    return { text, words: [] as { word: string; start: number; end: number }[], activeIdx: -1, keyIdx: new Set<number>() };
  }, [transcript, videoTime, state.offsetMs]);
  const captionText = captionData?.text;

  const togglePlay = useCallback(() => {
    const v = videoEl;
    if (!v) return;
    if (v.paused) {
      // Snap into the trim window before playing so the preview matches what the render
      // will cut. trim is in the video's own timeline (master or clip file) — no offset.
      const lo = state.trimIn;
      const hi = state.trimOut;
      if (v.currentTime < lo || v.currentTime >= hi - 0.05) v.currentTime = lo;
      void v.play();
    } else {
      v.pause();
    }
  }, [videoEl, state.trimIn, state.trimOut]);

  // On load, park the playhead at the trim IN so the first frame matches the render
  // window. Uses the video element from the event target — videoEl state가 stale일 수
  // 있어 (mount race) 이벤트가 준 요소를 쓰면 항상 살아있는 요소를 seek한다.
  const handleDuration = useCallback(
    (d: number, el?: HTMLVideoElement) => {
      const v = el ?? videoEl;
      if (!v) return;
      const target = Math.min(Math.max(0, state.trimIn), Math.max(0, d - 0.05));
      try {
        v.currentTime = target;
      } catch {
        /* seeking before ready — the timeline will seek on first interaction */
      }
    },
    [videoEl, state.trimIn],
  );

  // Editor keyboard shortcuts (beyond undo/redo): space = play/pause, I/O = trim in/out at
  // the playhead, Ctrl/⌘+S = save. Skipped while typing so text fields behave normally.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === "s") {
        e.preventDefault();
        void saveRef.current();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const rel = Math.max(0, Math.min(videoTime, duration)); // 타임라인 좌표 playhead
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (key === "i") {
        e.preventDefault();
        const trimIn = Math.max(0, Math.min(rel, state.trimOut - 0.1));
        setState((s) => {
          const [main, ...rest] = s.tracks ?? [];
          return main
            ? { ...s, trimIn, tracks: [{ ...main, trimIn }, ...rest] }
            : { ...s, trimIn };
        });
        setSaved(false);
      } else if (key === "o") {
        e.preventDefault();
        const trimOut = Math.max(state.trimIn + 0.1, Math.min(rel, duration));
        setState((s) => {
          const [main, ...rest] = s.tracks ?? [];
          return main
            ? { ...s, trimOut, tracks: [{ ...main, trimOut }, ...rest] }
            : { ...s, trimOut };
        });
        setSaved(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [togglePlay, videoTime, duration, state.trimIn, state.trimOut]);

  // 클립 목록은 미디어 화면으로 합쳐졌다 — 회차를 모를 때 여기로 보낸다.
  const backHref = clip ? `/episodes/${clip.episodeId}?tab=clips` : "/media";

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
          <MetadataButton clipId={clipId} state={state} update={update} />
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
            title={
              preset
                ? `${preset.label} 프리셋으로 렌더합니다 — ${preset.aspect}, 최대 ${preset.maxSec}초 (렌더는 여기서 단 한 번 — plan §2.4)`
                : "클립 원본 비율로 구간 전체를 렌더합니다 (렌더는 여기서 단 한 번 — plan §2.4)"
            }
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-60"
          >
            {rendered ? <Check className="size-4 text-emerald-400" /> : <Film className="size-4" />}
            {exporting
              ? <span className="tabular-nums">{exportStage} · {exportElapsed}s</span>
              : rendered ? "확정됨" : "확정(렌더)"}
          </button>
          <Link
            href="/distribution"
            className="inline-flex items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-sm font-medium text-black hover:bg-zinc-200"
          >
            <Send className="size-4" /> 배포
          </Link>
        </div>
      </header>

      {/* The preset's length cap shortened the deliverable. The operator picked a longer
          segment and got a shorter file — say so rather than let it pass unnoticed. */}
      {capped && (
        <div
          role="status"
          className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200"
        >
          <Info className="mt-0.5 size-4 shrink-0" />
          <span>
            {preset?.label ?? "선택한 배포처"}의 길이 상한 {capped.maxSec}초에 맞춰 잘렸습니다 — 고른 구간은{" "}
            {capped.requestedSec.toFixed(1)}초입니다. 전체를 살리려면 배포처를 바꾸거나 “원본 유지”로 렌더하세요.
          </span>
        </div>
      )}

      {/* body — CapCut 스타일 3열. 좌우 aside는 접었다 폈다 (버튼·아이콘 바). 접히면 프리뷰 확장. */}
      <div className="flex min-h-0 flex-1">
        {/* 좌: AI 패널 (접힘 시 얇은 아이콘 바) */}
        {leftOpen ? (
          <aside className="hidden w-52 shrink-0 border-r border-zinc-800 bg-zinc-950 lg:block xl:w-60">
            <div className="flex h-8 items-center justify-between border-b border-zinc-800 px-2 text-[11px] font-medium text-zinc-400">
              <span>AI 패널</span>
              <button
                onClick={() => setLeftOpen(false)}
                className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                title="접기"
              >
                <PanelLeftClose className="size-3.5" />
              </button>
            </div>
            <EditorAiPanel
              clipId={clipId}
              scenes={scenes}
              sourceRec={sourceRec}
              currentTitle={state.titleLines[0]?.text ?? ""}
              onApplyTitle={applyTitle}
            />
          </aside>
        ) : (
          <div className="hidden w-10 shrink-0 flex-col items-center border-r border-zinc-800 bg-zinc-950 py-2 lg:flex">
            <button
              onClick={() => setLeftOpen(true)}
              className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              title="AI 패널 펼치기"
            >
              <PanelLeftOpen className="size-4" />
            </button>
            <Sparkles className="mt-2 size-3.5 text-zinc-600" />
          </div>
        )}

        {/* 중앙: 프리뷰 (확장 가능) */}
        <div className="flex min-w-0 flex-1 items-center justify-center overflow-auto bg-zinc-900 p-4 sm:p-6">
          <EditorPreview
            frame={frame}
            state={state}
            update={update}
            videoUrl={videoUrl}
            videoRef={setVideoEl}
            onDuration={handleDuration}
            onTogglePlay={togglePlay}
            caption={captionText}
            captionWords={captionData?.words}
            captionActiveIdx={captionData?.activeIdx ?? -1}
            captionKeyIdx={captionData?.keyIdx}
            hasTranscript={!!transcript}
            currentTime={videoTime}
            posterMediaId={mediaId}
            posterApiBase={API_BASE}
            /* poster는 AI 추천 시작 프레임(마스터 절대 초) 하나로 고정 — trimIn이 바뀔 때마다
               다시 fetch되면 캐시 무효화 폭탄이라 videoUrl 로드 전까지의 정지 미리보기만 담당. */
            posterTime={recStart}
          />
        </div>

        {/* 우: 속성 패널 (접힘 시 얇은 아이콘 바) */}
        {rightOpen ? (
          <aside className="hidden w-72 shrink-0 border-l border-zinc-800 bg-zinc-950 md:block xl:w-80">
            <div className="flex h-8 items-center justify-between border-b border-zinc-800 px-2 text-[11px] font-medium text-zinc-400">
              <button
                onClick={() => setRightOpen(false)}
                className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                title="접기"
              >
                <PanelRightClose className="size-3.5" />
              </button>
              <span>속성</span>
            </div>
            <EditorPanel state={state} update={panelUpdate} applyTpl={applyTpl} kfSel={kfSel} setKfSel={setKfSel} />
          </aside>
        ) : (
          <div className="hidden w-10 shrink-0 flex-col items-center border-l border-zinc-800 bg-zinc-950 py-2 md:flex">
            <button
              onClick={() => setRightOpen(true)}
              className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              title="속성 패널 펼치기"
            >
              <PanelRightOpen className="size-4" />
            </button>
          </div>
        )}
      </div>

      {/* timeline */}
      <footer className="shrink-0 border-t border-zinc-800 p-3">
        <EditorTimeline
          state={state}
          update={update}
          duration={timelineDuration}
          video={videoEl}
          // 마스터 프리뷰(미렌더 드래프트)에선 파형 생략 — useAudioPeaks가 파일 전체를
          // 받아 디코드하므로 수 GB 마스터면 탭이 OOM 난다. 렌더된 클립만 파형 표시.
          videoUrl={previewingMaster ? undefined : videoUrl}
          tracks={state.tracks}
          onTogglePlay={togglePlay}
          // AI 추천 구간 — 타임라인 위에 하이라이트 밴드로 표시(트림과 별개).
          recWindow={previewingMaster ? { start: recStart, end: recEnd } : undefined}
          // "첫 3초 훅" 토글의 실제 렌더 가능 여부 — clip 에 hook 시각이 있어야 프리롤이 붙는다.
          hookAvailable={typeof clip?.hookTimeSec === "number"}
        />
        <button
          onClick={addTrack}
          className="mt-2 inline-flex items-center gap-1 rounded-md border border-dashed border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        >
          <Plus className="size-3.5" /> 트랙 추가
        </button>
      </footer>
    </div>
  );
}

/** YouTube 업로드 메타데이터 편집 팝오버 — 제목·설명·태그 3필드 + AI 생성 버튼.
 *  '생성'은 서버 /api/clips/:id/generate-metadata 호출 → 자막 근거로 title·description·tags
 *  자동 채움. 로딩·에러 상태 반영. 사용자가 수동 편집 가능. */
function MetadataButton({
  clipId,
  state,
  update,
}: {
  clipId: string;
  state: EditorState;
  update: (patch: Partial<EditorState>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = state.uploadMeta;

  async function generate() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const gen = await generateUploadMetadata(clipId);
      update({ uploadMeta: gen });
    } catch (e) {
      setError(e instanceof Error ? e.message : "생성 실패");
    } finally {
      setLoading(false);
    }
  }

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
          <div className="absolute right-0 top-[calc(100%+8px)] z-50 w-96 rounded-lg border border-zinc-700 bg-zinc-900 p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-300">
                <Sparkles className="size-3.5 text-amber-400" /> YouTube 업로드 메타데이터
              </div>
              <button
                onClick={generate}
                disabled={loading}
                className="inline-flex items-center gap-1 rounded-md bg-amber-500 px-2 py-1 text-[11px] font-semibold text-black hover:bg-amber-400 disabled:opacity-60"
              >
                <Sparkles className="size-3" /> {loading ? "생성 중…" : "AI 생성"}
              </button>
            </div>
            {error && (
              <div className="mb-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
                {error}
              </div>
            )}

            <label className="block">
              <span className="text-[11px] text-zinc-500">제목</span>
              <input
                type="text"
                value={meta?.title ?? ""}
                onChange={(e) => update({ uploadMeta: { ...(meta ?? { description: "", tags: [] }), title: e.target.value } })}
                placeholder={meta ? "" : "‘생성’을 눌러 초안을 만들거나 직접 입력"}
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 outline-none focus:border-zinc-500"
              />
            </label>

            <label className="mt-2 block">
              <span className="text-[11px] text-zinc-500">설명</span>
              <textarea
                value={meta?.description ?? ""}
                onChange={(e) => update({ uploadMeta: { ...(meta ?? { title: "", tags: [] }), description: e.target.value } })}
                placeholder={meta ? "" : "‘생성’을 눌러 초안을 만들거나 직접 입력"}
                rows={5}
                className="mt-1 w-full resize-none rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 outline-none focus:border-zinc-500"
              />
            </label>

            <label className="mt-2 block">
              <span className="text-[11px] text-zinc-500">태그 (쉼표로 구분)</span>
              <input
                type="text"
                value={(meta?.tags ?? []).join(", ")}
                onChange={(e) => {
                  const tags = e.target.value
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean);
                  update({ uploadMeta: { ...(meta ?? { title: "", description: "" }), tags } });
                }}
                placeholder="쇼츠, 하이라이트, …"
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 outline-none focus:border-zinc-500"
              />
            </label>

            {meta?.tags && meta.tags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {meta.tags.map((t) => (
                  <span key={t} className="rounded-full border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400">
                    #{t}
                  </span>
                ))}
              </div>
            )}

            <div className="mt-3 border-t border-zinc-800 pt-2 text-[11px] text-zinc-500">
              배포 시 여기 값이 YouTube 업로드 필드로 전송됩니다.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
