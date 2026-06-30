"use client";

/* ============================================================================
 * ConsoleProvider — central state + handlers for the entire console.
 * The original app/page.tsx was one giant stateful component; this keeps that
 * logic intact (verbatim handlers) but exposes it via context so the new
 * screen components stay presentational. UI lives in the screens, logic here.
 * ========================================================================== */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ShortcutEditorDraft } from "../ShortcutEditor";
import {
  analyzePpl,
  API_BASE_URL,
  applyCreative,
  authLoginUrl,
  autoDistribute,
  cancelPublish,
  cancelYouTubeChannelDraft,
  confirmManyYouTubeChannelDraft,
  deleteJob,
  disconnectChannel,
  getChannelAnalytics,
  getChannelInsights,
  getClipYouTubeStats,
  getJob,
  getMe,
  getPublishStatus,
  getResults,
  getSilenceReport,
  getStudioSummary,
  getVideoComments,
  getVideoCommentsWithSummary,
  getYouTubeChannelDraft,
  getYouTubeStatus,
  importFromYouTube,
  inspectVideo,
  logout as apiLogout,
  publishToYouTube,
  regenerateThumbnailTexts,
  regenerateTitles,
  reschedulePublish,
  renderHighlight,
  retrimClip,
  savePplLinks,
  setDefaultChannel,
  updateChannelStyleNote,
  uploadVideo,
  youtubeConnectUrl,
  type AuthUser,
  type Clip as BackendClip,
  type ChannelInsights,
  type ClipYouTubeStats,
  type CommentSummary,
  type HighlightRenderResponse,
  type PplAnalysis,
  type SilenceReport,
  type SubtitleMode,
  type VideoInspection,
  type YouTubeChannelDraft,
  type YouTubePublish,
} from "@/lib/api";
import {
  defaultDateLocal,
  defaultScheduleLocal,
  errorMessage,
  fmtCount,
  relDays,
  resolveMedia,
  stageFromProgress,
  toScheduleStamp,
  youtubeId,
} from "@/lib/console/format";
import {
  mapBackendClip,
  mapChannel,
  mapScheduleItem,
  mapStudioProject,
  type ChannelCard,
  type ChannelVideo,
  type Clip,
  type CommentItem,
  type PickerClip,
  type Privacy,
  type ProjectCard,
  type SchedItem,
} from "@/lib/console/map";
import { SAMPLE_CLIPS } from "@/lib/console/dummy";

export type NavKey =
  | "dashboard"
  | "channels"
  | "studio"
  | "schedule"
  | "commerce"
  | "report"
  | "settings";

export type PublishDraft = {
  clipId: string;
  mode: "now" | "schedule";
  channelDbId: string;
  title: string;
  description: string;
  tags: string;
  privacy: Privacy;
  scheduleLocal: string;
};

export type HighlightDraft = {
  title: string;
  clipIds: string[];
  aspect: "landscape" | "vertical" | "square";
  maxDurationSeconds: number;
  result?: HighlightRenderResponse | null;
};

/** A real PPL-detected product surfaced on the Commerce screen. */
export type CommerceItem = {
  key: string;
  jobId: string;
  clipId: string;
  clipTitle: string;
  projectTitle: string;
  productId: string;
  brand: string;
  product: string;
  category: string;
  exposure: number;
  voiceMentions: number;
  confidence: number;
  affiliateUrl: string;
  videoUrl?: string;
  thumbnail?: string;
  // Single-brand overlay (frames filtered to THIS product only) for the box player.
  overlay?: PplAnalysis;
};

function useConsoleState() {
  /* ---- nav / global ---- */
  const [nav, setNav] = useState<NavKey>("dashboard");
  const [me, setMe] = useState<AuthUser | null>(null);

  /* ---- studio: project list + schedule + upload pipeline ---- */
  const [projects, setProjects] = useState<ProjectCard[]>([]);
  const [sched, setSched] = useState<SchedItem[]>([]);
  const [pickerClips, setPickerClips] = useState<PickerClip[]>([]);
  const [studioLoaded, setStudioLoaded] = useState(false);
  const [openProject, setOpenProject] = useState<string | null>(null);

  const [view, setView] = useState<"empty" | "checking" | "processing" | "results">("empty");
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [ytUrl, setYtUrl] = useState("");
  const [ytPreviewId, setYtPreviewId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [stageIndex, setStageIndex] = useState(0);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<VideoInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [backendJobId, setBackendJobId] = useState<string | null>(null);
  const [backendClips, setBackendClips] = useState<Clip[] | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);

  /* ---- channels ---- */
  const [channels, setChannels] = useState<ChannelCard[]>([]);
  const [ytAuthed, setYtAuthed] = useState(false);
  const [defaultPrivacy, setDefaultPrivacy] = useState<Privacy>("private");
  const [openChannel, setOpenChannel] = useState<string | null>(null);
  const [openVideo, setOpenVideo] = useState<string | null>(null);
  const [videoComments, setVideoComments] = useState<Record<string, CommentItem[]>>({});
  const [commentSummary, setCommentSummary] = useState<Record<string, CommentSummary & { busy?: boolean }>>({});
  const [insights, setInsights] = useState<Record<string, ChannelInsights>>({});
  const [insightsBusy, setInsightsBusy] = useState<string | null>(null);
  const [channelBusy, setChannelBusy] = useState<string | null>(null);
  const [styleNoteDraft, setStyleNoteDraft] = useState<string | null>(null);
  const [styleNoteSaving, setStyleNoteSaving] = useState(false);

  /* ---- channel connect draft ---- */
  const [channelDraftId, setChannelDraftId] = useState<string | null>(null);
  const [channelDraft, setChannelDraft] = useState<YouTubeChannelDraft | null>(null);
  const [selectedDraftChannelIds, setSelectedDraftChannelIds] = useState<string[]>([]);
  const [channelDraftLoading, setChannelDraftLoading] = useState(false);
  const [channelDraftSaving, setChannelDraftSaving] = useState(false);

  /* ---- clip selection / editing ---- */
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [editorClipId, setEditorClipId] = useState<string | null>(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [retrimBusy, setRetrimBusy] = useState(false);
  const [titleBusy, setTitleBusy] = useState(false);
  const [revisions, setRevisions] = useState<Record<string, number>>({});

  /* ---- ppl (commerce) ---- */
  const [autoPplMode, setAutoPplMode] = useState(false);
  const [pplData, setPplData] = useState<Record<string, PplAnalysis | null>>({});
  const [pplBusy, setPplBusy] = useState<string | null>(null);
  const [commerceItems, setCommerceItems] = useState<CommerceItem[]>([]);
  const [commerceLoaded, setCommerceLoaded] = useState(false);
  const [commerceLoading, setCommerceLoading] = useState(false);
  const [commerceAnalyzing, setCommerceAnalyzing] = useState<string | null>(null);

  /* ---- clip detail drawer (silence / live stats / title-thumb regen) ---- */
  const [silenceReport, setSilenceReport] = useState<Record<string, SilenceReport>>({});
  const [silenceBusy, setSilenceBusy] = useState<string | null>(null);
  const [clipYtStats, setClipYtStats] = useState<Record<string, ClipYouTubeStats>>({});
  const [clipStatsBusy, setClipStatsBusy] = useState<string | null>(null);
  const [thumbBusy, setThumbBusy] = useState(false);

  /* ---- publish ---- */
  const [publishDraft, setPublishDraft] = useState<PublishDraft | null>(null);
  const [publishState, setPublishState] = useState<Record<string, YouTubePublish>>({});
  const [publishing, setPublishing] = useState(false);
  const publishPollers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  /* ---- schedule ---- */
  const [schedAction, setSchedAction] = useState<{ item: SchedItem; local: string } | null>(null);
  const [schedBusy, setSchedBusy] = useState(false);
  const [autoDist, setAutoDist] = useState<{ channelDbId: string; startDate: string; times: string; privacy: Privacy; selected: string[] } | null>(null);
  const [autoDistBusy, setAutoDistBusy] = useState(false);

  /* ---- highlight ---- */
  const [highlightDraft, setHighlightDraft] = useState<HighlightDraft | null>(null);
  const [highlightBusy, setHighlightBusy] = useState(false);

  /* ---- toast ---- */
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  };

  const sourcePreviewUrl = useMemo(() => (selectedFile ? URL.createObjectURL(selectedFile) : null), [selectedFile]);
  useEffect(() => {
    if (!sourcePreviewUrl) return undefined;
    return () => URL.revokeObjectURL(sourcePreviewUrl);
  }, [sourcePreviewUrl]);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      if (pollTimer.current) clearTimeout(pollTimer.current);
      Object.values(publishPollers.current).forEach((t) => clearTimeout(t));
    },
    []
  );

  /* ---- nav ---- */
  const switchNav = (k: NavKey) => {
    setNav(k);
    setOpenProject(null);
    setOpenChannel(null);
    setOpenVideo(null);
    setSelectedClipId(null);
    setEditorClipId(null);
  };

  /* ---- studio loaders ---- */
  const loadStudio = async () => {
    try {
      const summary = await getStudioSummary();
      setProjects(summary.projects.map(mapStudioProject));
      setSched(summary.schedule.map(mapScheduleItem).filter((x): x is SchedItem => x !== null));
      setPickerClips(
        summary.projects.flatMap((p) =>
          (p.clips || []).map((c) => ({
            clipId: c.clip_id,
            jobId: p.job_id,
            title: c.title,
            thumb: c.thumbnail_url,
            videoUrl: c.video_url || null,
            score: c.score,
            status: c.status,
            project: p.original_filename || p.title,
          }))
        )
      );
    } catch {
      // backend may be unreachable; screens render their empty/dummy states
    } finally {
      setStudioLoaded(true);
    }
  };

  const loadChannels = async () => {
    try {
      const status = await getYouTubeStatus();
      setChannels(status.channels.map(mapChannel));
      setYtAuthed(status.authenticated);
      const dp = status.default_privacy_status;
      if (dp === "public" || dp === "unlisted" || dp === "private") setDefaultPrivacy(dp);
    } catch {
      setChannels([]);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void getMe().then(setMe).catch(() => setMe(null));
      void loadStudio();
      void loadChannels();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  /* ---- OAuth return-url handling (preserved from page.tsx) ---- */
  const loadChannelDraft = async (draftId: string) => {
    setChannelDraftId(draftId);
    setChannelDraft(null);
    setSelectedDraftChannelIds([]);
    setChannelDraftLoading(true);
    try {
      const draft = await getYouTubeChannelDraft(draftId);
      setChannelDraft(draft);
      const unconnected = draft.channels.filter((ch) => !ch.already_connected).map((ch) => ch.channel_id);
      setSelectedDraftChannelIds(unconnected.length ? unconnected : draft.channels.slice(0, 1).map((ch) => ch.channel_id));
    } catch (error) {
      setChannelDraftId(null);
      showToast(errorMessage(error));
    } finally {
      setChannelDraftLoading(false);
    }
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const params = url.searchParams;
    const youtube = params.get("youtube");
    const draftId = params.get("draft");
    const login = params.get("login");
    const message = params.get("message") || "";
    const connectAfterLogin = params.get("connect_youtube") === "1";
    const shouldClean = Boolean(youtube || draftId || login || message || connectAfterLogin);

    if (shouldClean && API_BASE_URL) {
      try {
        const api = new URL(API_BASE_URL);
        const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
        if (localHosts.has(url.hostname) && localHosts.has(api.hostname) && url.hostname !== api.hostname) {
          url.hostname = api.hostname;
          window.location.replace(url.toString());
          return;
        }
      } catch {
        /* continue */
      }
    }
    if (shouldClean) {
      ["youtube", "draft", "login", "message", "connect_youtube"].forEach((key) => params.delete(key));
      window.history.replaceState(null, "", url.toString());
    }

    let action: (() => void) | null = null;
    if (youtube === "review" && draftId) {
      action = () => {
        setNav("channels");
        void loadChannelDraft(draftId);
      };
    } else if (youtube === "error") {
      action = () => showToast(`YouTube 채널 연결에 실패했어요${message ? `: ${message}` : ""}`);
    } else if (login === "error") {
      action = () => showToast(`Google 로그인에 실패했어요${message ? `: ${message}` : ""}`);
    } else if (youtube === "connected") {
      action = () => {
        showToast("YouTube 채널 연결이 완료됐어요");
        void loadChannels();
      };
    }
    if (action) {
      window.setTimeout(action, 0);
      return;
    }
    if (connectAfterLogin) {
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- OAuth starts on the FastAPI host, outside Next routing.
      window.location.assign(youtubeConnectUrl(url.toString()));
      return;
    }
    if (login === "ok") action = () => showToast("Google 로그인 완료");
    if (!action) return;
    window.setTimeout(action, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- auth ---- */
  const cleanOAuthReturnUrl = () => {
    if (typeof window === "undefined") return "";
    const url = new URL(window.location.href);
    ["youtube", "draft", "login", "message", "connect_youtube"].forEach((key) => url.searchParams.delete(key));
    return url.toString();
  };
  const connectYouTube = () => {
    if (typeof window === "undefined") return;
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- OAuth starts on the FastAPI host, outside Next routing.
    window.location.assign(youtubeConnectUrl(cleanOAuthReturnUrl() || window.location.href));
  };
  const login = () => {
    if (typeof window === "undefined") return;
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Google login starts on the FastAPI host, outside Next routing.
    window.location.assign(authLoginUrl(cleanOAuthReturnUrl() || window.location.href));
  };
  const logout = async () => {
    try {
      await apiLogout();
      setMe(null);
      showToast("로그아웃했어요");
    } catch {
      showToast("로그아웃에 실패했어요");
    }
  };

  /* ---- upload pipeline ---- */
  const pickFile = (fileOrName?: File | string | null) => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    setProgress(0);
    setStageIndex(0);
    setBackendError(null);
    setBackendJobId(null);
    setBackendClips(null);
    setSelectedClipId(null);
    setYtPreviewId(null);
    if (fileOrName instanceof File) {
      setSelectedFile(fileOrName);
      setFileName(fileOrName.name || "업로드 영상.mp4");
      setInspection(null);
      setInspecting(true);
      inspectVideo(fileOrName)
        .then((info) => {
          setInspection(info);
          if (info.has_subtitle_stream) showToast("내장 자막이 감지됐어요. 추가 자막 없이 진행할 수 있어요");
        })
        .catch((error) => {
          setBackendError("영상 검사 실패: " + errorMessage(error));
          showToast("영상 검사에 실패했어요");
        })
        .finally(() => setInspecting(false));
      return;
    }
    setSelectedFile(null);
    setInspection(null);
    setInspecting(false);
    setFileName(typeof fileOrName === "string" ? fileOrName : null);
  };
  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) pickFile(f);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    setDragging(false);
    if (f) pickFile(f);
  };
  const importYt = () => {
    const u = ytUrl.trim();
    if (!u) {
      showToast("유튜브 링크를 붙여넣어 주세요");
      return;
    }
    const id = youtubeId(u);
    if (!id) {
      showToast("유효한 유튜브 링크가 아니에요. 영상 주소를 확인해 주세요");
      return;
    }
    pickFile("유튜브 영상 · " + u.replace(/^https?:\/\/(www\.)?/, "").slice(0, 42));
    setYtPreviewId(id);
    showToast("유튜브 링크를 준비했어요");
  };
  const pollJob = async (jobId: string) => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    try {
      const job = await getJob(jobId);
      const nextProgress = Math.max(1, Math.min(100, Math.round(job.progress || 0)));
      setProgress(nextProgress);
      setStageIndex(stageFromProgress(nextProgress));
      if (job.status === "completed") {
        const results = await getResults(jobId);
        const clips = results.clips.map(mapBackendClip);
        setBackendClips(clips);
        setProgress(100);
        setStageIndex(3);
        setView("results");
        void loadStudio();
        showToast(`쇼츠 후보 ${clips.length}개를 만들었어요`);
        if (autoPplMode) {
          setAutoPplMode(false);
          showToast("PPL 분석을 시작해요…");
          for (const clip of clips) {
            try {
              const analysis = await analyzePpl(clip.id);
              if (analysis) setPplData((s) => ({ ...s, [clip.id]: analysis }));
            } catch { /* 개별 실패 무시 */ }
          }
          showToast("PPL 분석 완료!");
        }
        return;
      }
      if (job.status === "failed") throw new Error(job.error || "작업이 실패했어요");
      pollTimer.current = setTimeout(() => {
        void pollJob(jobId);
      }, 1600);
    } catch (error) {
      setBackendError(errorMessage(error));
      setView("checking");
      showToast("백엔드 작업을 확인하지 못했어요");
    }
  };
  const startBackendJob = async (subtitleMode: SubtitleMode) => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    if (!selectedFile && !ytUrl.trim()) {
      showToast("영상 파일이나 유튜브 링크를 먼저 준비하세요");
      return;
    }
    setBackendError(null);
    setUploadOpen(false);
    setView("processing");
    setProgress(1);
    setStageIndex(0);
    try {
      const response = selectedFile
        ? await uploadVideo(selectedFile, subtitleMode, "korean_pop")
        : await importFromYouTube(ytUrl.trim(), subtitleMode, "korean_pop");
      setBackendJobId(response.job_id);
      void pollJob(response.job_id);
    } catch (error) {
      setBackendError(errorMessage(error));
      setView("checking");
      showToast("작업 시작에 실패했어요");
    }
  };
  const beginUpload = () => {
    if (!selectedFile && !ytUrl.trim()) {
      showToast("영상 파일이나 유튜브 링크를 먼저 준비하세요");
      return;
    }
    setView("checking");
  };
  const beginPplFlow = () => {
    if (!selectedFile && !ytUrl.trim()) {
      showToast("영상 파일이나 유튜브 링크를 먼저 준비하세요");
      return;
    }
    setAutoPplMode(true);
    setView("checking");
  };
  const answerSubs = (hasExistingSubtitles: boolean) => {
    void startBackendJob(hasExistingSubtitles ? "off" : "on");
  };
  const resetUpload = () => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    setView("empty");
    setFileName(null);
    setProgress(0);
    setStageIndex(0);
    setSelectedFile(null);
    setYtPreviewId(null);
    setYtUrl("");
    setInspection(null);
    setInspecting(false);
    setBackendError(null);
    setBackendJobId(null);
    setBackendClips(null);
  };
  const openUpload = () => {
    setNav("studio");
    setOpenProject(null);
    resetUpload();
    setUploadOpen(true);
  };

  /* ---- studio project detail ---- */
  const openProjectDetail = async (jobId: string) => {
    setOpenProject(jobId);
    setBackendClips(null);
    setView("empty");
    try {
      const results = await getResults(jobId);
      setBackendClips(results.clips.map(mapBackendClip));
    } catch {
      setBackendClips([]);
    }
  };
  const closeProject = () => {
    setOpenProject(null);
    setBackendClips(null);
  };
  const handleDeleteProject = async (jobId: string) => {
    if (typeof window !== "undefined" && !window.confirm("프로젝트를 삭제하면 영상과 쇼츠 클립이 모두 사라집니다. 계속할까요?")) return;
    try {
      await deleteJob(jobId);
      setProjects((prev) => prev.filter((p) => p.id !== jobId));
      if (openProject === jobId) {
        setOpenProject(null);
        setBackendClips(null);
      }
      showToast("프로젝트를 삭제했어요");
    } catch {
      showToast("삭제에 실패했어요. 다시 시도해 주세요");
    }
  };

  /* ---- channels ---- */
  const openChannelDetail = async (channelDbId: string) => {
    setOpenChannel(channelDbId);
    setOpenVideo(null);
    const existing = channels.find((c) => c.id === channelDbId);
    if (existing?.loaded) {
      setOpenVideo(existing.videos[0]?.id || null);
      return;
    }
    try {
      const a = await getChannelAnalytics(channelDbId, { limit: 30, sort: "views" });
      const videos: ChannelVideo[] = a.videos.map((v, i) => ({
        id: v.video_id,
        title: v.title,
        date: relDays(v.published_at),
        views: fmtCount(v.view_count),
        likes: fmtCount(v.like_count),
        comments: fmtCount(v.comment_count),
        posterIdx: i,
        url: v.url,
        thumbnailUrl: v.thumbnail || (v.video_id ? `https://i.ytimg.com/vi/${v.video_id}/mqdefault.jpg` : null),
      }));
      setChannels((prev) =>
        prev.map((c) =>
          c.id === channelDbId
            ? {
                ...c,
                subs: a.totals.hidden_subscriber_count ? "비공개" : fmtCount(a.totals.subscriber_count),
                views: fmtCount(a.totals.channel_view_count),
                videos,
                loaded: true,
              }
            : c
        )
      );
      setOpenVideo(videos[0]?.id || null);
    } catch {
      showToast("채널 분석을 불러오지 못했어요");
    }
  };
  const closeChannel = () => {
    setOpenChannel(null);
    setOpenVideo(null);
  };
  useEffect(() => {
    if (!openChannel || !openVideo || videoComments[openVideo]) return;
    let cancelled = false;
    const vid = openVideo;
    getVideoComments(openChannel, vid, 20)
      .then((list) => {
        if (cancelled) return;
        setVideoComments((prev) => ({
          ...prev,
          [vid]: list.map((c) => ({ author: c.author, text: c.text, likes: c.likes, time: relDays(c.published_at) })),
        }));
      })
      .catch(() => {
        if (!cancelled) setVideoComments((prev) => ({ ...prev, [vid]: [] }));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openChannel, openVideo]);

  const loadInsights = async (channelDbId: string) => {
    setInsightsBusy(channelDbId);
    try {
      const data = await getChannelInsights(channelDbId);
      setInsights((prev) => ({ ...prev, [channelDbId]: data }));
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setInsightsBusy(null);
    }
  };
  const loadCommentSummary = async (channelDbId: string, videoId: string) => {
    const key = `${channelDbId}|${videoId}`;
    setCommentSummary((s) => ({ ...s, [key]: { ...(s[key] ?? { summary: "", sentiment: "neutral", themes: [], highlights: [] }), busy: true } }));
    try {
      const result = await getVideoCommentsWithSummary(channelDbId, videoId);
      setCommentSummary((s) => ({ ...s, [key]: { ...result.summary, busy: false } }));
    } catch (error) {
      showToast("댓글 요약 실패: " + errorMessage(error));
      setCommentSummary((s) => ({ ...s, [key]: { ...(s[key] ?? { summary: "", sentiment: "neutral", themes: [], highlights: [] }), busy: false } }));
    }
  };
  const saveStyleNote = async (channelDbId: string) => {
    if (styleNoteDraft === null) return;
    setStyleNoteSaving(true);
    try {
      const updated = await updateChannelStyleNote(channelDbId, styleNoteDraft);
      const note = (updated.style_note || "").trim();
      setChannels((prev) => prev.map((c) => (c.id === channelDbId ? { ...c, styleNote: note } : c)));
      setStyleNoteDraft(null);
      showToast("채널 스타일 메모를 저장했어요");
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setStyleNoteSaving(false);
    }
  };
  const makeDefaultChannel = async (channelDbId: string) => {
    setChannelBusy(channelDbId);
    try {
      await setDefaultChannel(channelDbId);
      await loadChannels();
      showToast("기본 채널로 설정했어요");
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setChannelBusy(null);
    }
  };
  const removeChannel = async (channelDbId: string, name: string) => {
    if (typeof window !== "undefined" && !window.confirm(`'${name}' 채널 연결을 해제할까요?`)) return;
    setChannelBusy(channelDbId);
    try {
      await disconnectChannel(channelDbId);
      if (openChannel === channelDbId) {
        setOpenChannel(null);
        setOpenVideo(null);
      }
      await loadChannels();
      showToast("채널 연결을 해제했어요");
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setChannelBusy(null);
    }
  };

  /* ---- channel draft ---- */
  const closeChannelDraft = async () => {
    const id = channelDraftId;
    setChannelDraftId(null);
    setChannelDraft(null);
    setSelectedDraftChannelIds([]);
    if (id) {
      try {
        await cancelYouTubeChannelDraft(id);
      } catch {
        /* ignore */
      }
    }
  };
  const confirmChannelDraft = async () => {
    if (!channelDraft || selectedDraftChannelIds.length === 0) return;
    const selected = channelDraft.channels.filter((ch) => selectedDraftChannelIds.includes(ch.channel_id));
    setChannelDraftSaving(true);
    try {
      await confirmManyYouTubeChannelDraft(channelDraft.id, selectedDraftChannelIds);
      setChannelDraftId(null);
      setChannelDraft(null);
      setSelectedDraftChannelIds([]);
      await loadChannels();
      const allRefresh = selected.length > 0 && selected.every((ch) => ch.already_connected);
      showToast(allRefresh ? `YouTube 채널 ${selected.length}개 연결을 갱신했어요` : `YouTube 채널 ${selected.length}개를 추가했어요`);
      setNav("channels");
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setChannelDraftSaving(false);
    }
  };
  const toggleDraftChannel = (channelId: string) => {
    setSelectedDraftChannelIds((ids) => (ids.includes(channelId) ? ids.filter((id) => id !== channelId) : [...ids, channelId]));
  };

  /* ---- derived: clips ---- */
  const activeClips = useMemo(() => backendClips ?? (view === "results" ? SAMPLE_CLIPS : []), [backendClips, view]);
  const currentJobId = backendJobId || openProject || null;

  const replaceClip = (updated: BackendClip) => {
    const mapped = mapBackendClip(updated);
    setBackendClips((prev) => (prev ? prev.map((c) => (c.id === mapped.id ? mapped : c)) : prev));
  };

  /* ---- clip editing ---- */
  const openClipEditor = (clipId: string) => setEditorClipId(clipId);
  const editorClip = activeClips.find((c) => c.id === editorClipId) || null;

  const saveShortcutEditor = async (draft: ShortcutEditorDraft) => {
    const target = activeClips.find((c) => c.id === editorClipId);
    if (!target) return;
    setApplyBusy(true);
    try {
      const updated = await applyCreative(target.id, {
        title: draft.title.slice(0, 180),
        thumbnail_text: draft.thumbnailText.slice(0, 120),
        template_id: draft.templateId,
        overlay_position: draft.overlayPosition,
        overlay_scale: draft.overlayScale,
        editor_state: draft.editorState as unknown as Record<string, unknown>,
        burn_overlays: draft.burnOverlays as unknown as Record<string, unknown>[],
        metadata_overrides: { editor_state: draft.editorState, burn_overlays: draft.burnOverlays },
      });
      replaceClip(updated);
      setRevisions((r) => ({ ...r, [target.id]: (r[target.id] || 1) + 1 }));
      showToast("편집기 설정으로 다시 렌더했어요");
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setApplyBusy(false);
    }
  };

  const doRetrim = async (clipId: string, start: number, end: number) => {
    if (end - start < 1) {
      showToast("클립은 최소 1초 이상이어야 해요");
      return;
    }
    setRetrimBusy(true);
    try {
      const updated = await retrimClip(clipId, { start_seconds: start, end_seconds: end });
      replaceClip(updated);
      setRevisions((r) => ({ ...r, [clipId]: (r[clipId] || 1) + 1 }));
      showToast("새 구간으로 다시 잘랐어요");
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setRetrimBusy(false);
    }
  };

  const regenTitles = async (clipId: string) => {
    setTitleBusy(true);
    try {
      const res = await regenerateTitles(clipId);
      const opts = res.options.map((o, i) => ({
        id: o.id || `${clipId}-t${i}`,
        text: o.title,
        overlay: o.overlay_text || "",
        note: o.reason || o.style || "",
      }));
      if (opts.length) {
        setBackendClips((prev) => (prev ? prev.map((c) => (c.id === clipId ? { ...c, titleOptions: opts } : c)) : prev));
      }
      showToast("AI 제목을 새로 생성했어요");
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setTitleBusy(false);
    }
  };

  const regenThumbs = async (clipId: string) => {
    setThumbBusy(true);
    try {
      const res = await regenerateThumbnailTexts(clipId);
      const opts = res.options.map((o, i) => ({ id: o.id || `${clipId}-th${i}`, text: o.text, note: o.reason || o.style || "" }));
      setBackendClips((prev) => (prev ? prev.map((c) => (c.id === clipId ? { ...c, thumbTextOptions: opts } : c)) : prev));
      showToast("썸네일 문구를 새로 생성했어요");
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setThumbBusy(false);
    }
  };

  const loadSilenceReport = async (jobId: string) => {
    setSilenceBusy(jobId);
    try {
      const r = await getSilenceReport(jobId);
      setSilenceReport((s) => ({ ...s, [jobId]: r }));
    } catch (error) {
      showToast("무음 탐지 실패: " + errorMessage(error));
    } finally {
      setSilenceBusy(null);
    }
  };

  const loadClipYtStats = async (clipId: string) => {
    setClipStatsBusy(clipId);
    try {
      const r = await getClipYouTubeStats(clipId);
      setClipYtStats((s) => ({ ...s, [clipId]: r }));
    } catch (error) {
      showToast("성과 조회 실패: " + errorMessage(error));
    } finally {
      setClipStatsBusy(null);
    }
  };

  /* ---- highlight ---- */
  const doRenderHighlight = async (clipIds: string[], title: string, aspect: HighlightDraft["aspect"], maxDur: number) => {
    if (!currentJobId) {
      showToast("하이라이트는 실제 분석된 프로젝트에서 사용할 수 있어요");
      return;
    }
    if (!clipIds.length) {
      showToast("하이라이트에 넣을 클립을 선택하세요");
      return;
    }
    setHighlightBusy(true);
    try {
      const res = await renderHighlight(currentJobId, { clip_ids: clipIds, title: title.trim() || "하이라이트", aspect, max_duration_seconds: maxDur });
      setHighlightDraft((d) => (d ? { ...d, result: res } : d));
      showToast("하이라이트 MP4를 만들었어요");
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setHighlightBusy(false);
    }
  };

  /* ---- ppl (commerce) ---- */
  const runPpl = async (clipId: string) => {
    setPplBusy(clipId);
    try {
      const analysis = await analyzePpl(clipId);
      setPplData((s) => ({ ...s, [clipId]: analysis }));
      showToast(analysis && analysis.products.length ? `브랜드 ${analysis.products.length}개를 인식했어요` : "감지된 브랜드가 없어요");
      return analysis;
    } catch (error) {
      showToast("브랜드 분석 실패: " + errorMessage(error));
      return null;
    } finally {
      setPplBusy(null);
    }
  };
  const savePpl = async (clipId: string, links: Record<string, string>) => {
    try {
      const updated = await savePplLinks(clipId, links);
      setPplData((s) => ({ ...s, [clipId]: updated }));
      showToast("제휴 링크를 저장했어요");
    } catch (error) {
      showToast("저장 실패: " + errorMessage(error));
    }
  };

  // Build commerce items from a clip's PPL analysis — one per product, each with
  // a single-brand overlay (frames filtered to THAT product only) for the box player.
  const buildCommerceItems = (
    meta: { jobId: string; clipId: string; clipTitle: string; projectTitle: string; videoUrl?: string; thumbnail?: string },
    a: PplAnalysis | null
  ): CommerceItem[] =>
    (a?.products || []).map((pr) => {
      const frames = (a!.frames || [])
        .map((f) => ({ timestamp: f.timestamp, detections: (f.detections || []).filter((d) => d.product_id === pr.id) }))
        .filter((f) => f.detections.length);
      return {
        key: `${meta.clipId}|${pr.id}`,
        jobId: meta.jobId,
        clipId: meta.clipId,
        clipTitle: meta.clipTitle,
        projectTitle: meta.projectTitle,
        productId: pr.id,
        brand: pr.brand,
        product: pr.product,
        category: pr.category,
        exposure: pr.exposure_seconds,
        voiceMentions: (pr.voice_mentions || []).length,
        confidence: pr.confidence,
        affiliateUrl: pr.affiliate_url || "",
        videoUrl: meta.videoUrl,
        thumbnail: meta.thumbnail,
        overlay: { status: a!.status, duration_seconds: a!.duration_seconds, frame_count: frames.length, products: [pr], frames },
      };
    });

  // Collect already-analyzed PPL products across every project into commerce items.
  const loadCommerce = async () => {
    if (commerceLoading) return;
    setCommerceLoading(true);
    try {
      const items: CommerceItem[] = [];
      for (const p of projects) {
        try {
          const res = await getResults(p.id);
          res.clips.forEach((cl) => {
            if (cl.ppl_analysis?.products?.length) {
              items.push(
                ...buildCommerceItems(
                  { jobId: p.id, clipId: cl.clip_id, clipTitle: cl.title, projectTitle: p.title, videoUrl: resolveMedia(cl.video_url), thumbnail: resolveMedia(cl.thumbnail_url) },
                  cl.ppl_analysis
                )
              );
            }
          });
        } catch {
          /* skip project that fails to load */
        }
      }
      setCommerceItems(items);
    } finally {
      setCommerceLoading(false);
      setCommerceLoaded(true);
    }
  };

  // Run on-demand brand recognition (Gemini vision) for one clip, then merge.
  const analyzeClipForCommerce = async (clip: PickerClip) => {
    setCommerceAnalyzing(clip.clipId);
    try {
      const a = await analyzePpl(clip.clipId);
      const fresh = buildCommerceItems(
        { jobId: clip.jobId, clipId: clip.clipId, clipTitle: clip.title, projectTitle: clip.project, thumbnail: resolveMedia(clip.thumb) },
        a
      );
      setCommerceItems((prev) => [...prev.filter((x) => x.clipId !== clip.clipId), ...fresh]);
      setCommerceLoaded(true);
      showToast(fresh.length ? `브랜드 ${fresh.length}개를 인식했어요` : "감지된 브랜드가 없어요");
    } catch (error) {
      showToast("브랜드 분석 실패: " + errorMessage(error));
    } finally {
      setCommerceAnalyzing(null);
    }
  };

  // Persist a chosen affiliate URL for one product (real, via savePplLinks).
  const saveCommerceLink = async (clipId: string, productId: string, url: string) => {
    const links: Record<string, string> = {};
    commerceItems.filter((x) => x.clipId === clipId).forEach((x) => {
      links[x.productId] = x.affiliateUrl;
    });
    links[productId] = url;
    try {
      await savePplLinks(clipId, links);
      setCommerceItems((prev) => prev.map((x) => (x.clipId === clipId && x.productId === productId ? { ...x, affiliateUrl: url } : x)));
      showToast("제휴 링크를 저장했어요");
    } catch (error) {
      showToast("저장 실패: " + errorMessage(error));
    }
  };

  /* ---- publish ---- */
  const schedulePublishPoll = (publishId: string, clipId: string) => {
    const tick = async () => {
      try {
        const p = await getPublishStatus(publishId);
        setPublishState((s) => ({ ...s, [clipId]: p }));
        if (p.status === "pending" || p.status === "uploading") {
          publishPollers.current[clipId] = setTimeout(() => void tick(), 2200);
        } else {
          delete publishPollers.current[clipId];
          if (p.status === "published") showToast("유튜브에 발행됐어요");
          else if (p.status === "scheduled") showToast("유튜브 예약 발행이 등록됐어요");
          else if (p.status === "failed") showToast("발행에 실패했어요" + (p.error ? `: ${p.error}` : ""));
          void loadStudio();
        }
      } catch {
        publishPollers.current[clipId] = setTimeout(() => void tick(), 3500);
      }
    };
    void tick();
  };
  const openPublishDraft = (clip: Clip, mode: "now" | "schedule") => {
    if (!ytAuthed) {
      showToast("먼저 Google로 로그인하고 채널을 연결하세요");
      connectYouTube();
      return;
    }
    if (channels.length === 0) {
      showToast("발행할 YouTube 채널을 먼저 연결하세요");
      setNav("channels");
      return;
    }
    const def = channels.find((c) => c.isDefault) || channels[0];
    setPublishDraft({
      clipId: clip.id,
      mode,
      channelDbId: def.id,
      title: (clip.yt.title || clip.title).slice(0, 100),
      description: clip.description,
      tags: clip.publishTags.join(", "),
      privacy: defaultPrivacy,
      scheduleLocal: mode === "schedule" ? defaultScheduleLocal() : "",
    });
  };
  const doPublish = async () => {
    if (!publishDraft) return;
    const d = publishDraft;
    if (!d.title.trim()) {
      showToast("제목을 입력하세요");
      return;
    }
    let scheduleDate: string | null = null;
    if (d.mode === "schedule") {
      const stamp = toScheduleStamp(d.scheduleLocal);
      if (!stamp) {
        showToast("예약 시간을 선택하세요");
        return;
      }
      scheduleDate = stamp;
    }
    setPublishing(true);
    try {
      const res = await publishToYouTube(d.clipId, {
        channel_db_id: d.channelDbId,
        privacy_status: d.privacy,
        schedule_date: scheduleDate,
        title: d.title.trim(),
        description: d.description,
        tags: d.tags.split(/[,\n]/).map((t) => t.trim().replace(/^#/, "")).filter(Boolean).slice(0, 30),
      });
      setPublishState((s) => ({ ...s, [d.clipId]: res }));
      setPublishDraft(null);
      showToast(d.mode === "schedule" ? "유튜브 예약 발행을 등록했어요" : "유튜브 발행을 시작했어요");
      schedulePublishPoll(res.id, d.clipId);
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setPublishing(false);
    }
  };

  /* ---- schedule reschedule/cancel/auto-distribute ---- */
  const openReschedule = (item: SchedItem) => {
    const m = item.scheduleStamp && /^\d{14}$/.test(item.scheduleStamp) ? item.scheduleStamp : null;
    let local = defaultScheduleLocal();
    if (m) local = `${m.slice(0, 4)}-${m.slice(4, 6)}-${m.slice(6, 8)}T${m.slice(8, 10)}:${m.slice(10, 12)}`;
    setSchedAction({ item, local });
  };
  const doReschedule = async () => {
    if (!schedAction) return;
    const stamp = toScheduleStamp(schedAction.local);
    if (!stamp) {
      showToast("예약 시간을 선택하세요");
      return;
    }
    setSchedBusy(true);
    try {
      await reschedulePublish(schedAction.item.publishId, stamp);
      setSchedAction(null);
      await loadStudio();
      showToast("예약 시간을 변경했어요");
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setSchedBusy(false);
    }
  };
  const doCancelSched = async () => {
    if (!schedAction) return;
    if (typeof window !== "undefined" && !window.confirm("이 예약을 취소할까요? 업로드된 영상은 비공개로 전환돼요.")) return;
    setSchedBusy(true);
    try {
      await cancelPublish(schedAction.item.publishId);
      setSchedAction(null);
      await loadStudio();
      showToast("예약을 취소했어요");
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setSchedBusy(false);
    }
  };
  const openAutoDist = () => {
    if (!ytAuthed || channels.length === 0) {
      showToast("먼저 Google 로그인 후 채널을 연결하세요");
      setNav("channels");
      return;
    }
    if (pickerClips.length === 0) {
      showToast("먼저 쇼츠를 만들어 주세요");
      return;
    }
    const def = channels.find((c) => c.isDefault) || channels[0];
    setAutoDist({ channelDbId: def.id, startDate: defaultDateLocal(), times: "18:00", privacy: defaultPrivacy, selected: [] });
  };
  const toggleAutoClip = (clipId: string) =>
    setAutoDist((d) => {
      if (!d) return d;
      const has = d.selected.includes(clipId);
      return { ...d, selected: has ? d.selected.filter((x) => x !== clipId) : [...d.selected, clipId] };
    });
  const doAutoDistribute = async () => {
    if (!autoDist) return;
    if (autoDist.selected.length === 0) {
      showToast("배포할 쇼츠를 선택하세요");
      return;
    }
    const startDate = autoDist.startDate.replace(/-/g, "");
    if (!/^\d{8}$/.test(startDate)) {
      showToast("시작 날짜를 선택하세요");
      return;
    }
    const times = autoDist.times.split(",").map((t) => t.trim()).filter((t) => /^\d{1,2}:\d{2}$/.test(t));
    setAutoDistBusy(true);
    try {
      const res = await autoDistribute({
        clip_ids: autoDist.selected,
        channel_db_id: autoDist.channelDbId,
        start_date: startDate,
        times: times.length ? times : ["18:00"],
        privacy_status: autoDist.privacy,
      });
      setAutoDist(null);
      await loadStudio();
      showToast(`쇼츠 ${res.items.length}개를 자동 배치했어요`);
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setAutoDistBusy(false);
    }
  };

  const defChannel = channels.find((c) => c.isDefault) || channels[0] || null;

  return {
    // nav / global
    nav, setNav: switchNav, me, login, logout, connectYouTube, showToast, toast,
    // studio
    projects, sched, pickerClips, studioLoaded, loadStudio,
    openProject, openProjectDetail, closeProject, handleDeleteProject,
    view, setView, dragging, setDragging, fileName, ytUrl, setYtUrl, ytPreviewId,
    progress, stageIndex, selectedFile, sourcePreviewUrl, inspection, inspecting, backendError,
    backendClips, uploadOpen, setUploadOpen, openUpload,
    pickFile, onFileInput, onDrop, importYt, beginUpload, beginPplFlow, answerSubs, startBackendJob, resetUpload,
    activeClips, currentJobId, replaceClip,
    // clip editing
    selectedClipId, setSelectedClipId, editorClipId, editorClip, openClipEditor, setEditorClipId,
    saveShortcutEditor, applyBusy, doRetrim, retrimBusy, regenTitles, regenThumbs, titleBusy, thumbBusy, revisions,
    // clip detail drawer
    silenceReport, silenceBusy, loadSilenceReport, clipYtStats, clipStatsBusy, loadClipYtStats,
    // highlight
    highlightDraft, setHighlightDraft, highlightBusy, doRenderHighlight,
    // ppl / commerce
    pplData, pplBusy, runPpl, savePpl,
    commerceItems, commerceLoaded, commerceLoading, commerceAnalyzing,
    loadCommerce, analyzeClipForCommerce, saveCommerceLink,
    // channels
    channels, ytAuthed, defaultPrivacy, openChannel, openChannelDetail, closeChannel,
    openVideo, setOpenVideo, videoComments, commentSummary, loadCommentSummary,
    insights, insightsBusy, loadInsights, channelBusy, makeDefaultChannel, removeChannel,
    styleNoteDraft, setStyleNoteDraft, styleNoteSaving, saveStyleNote, defChannel,
    // channel draft
    channelDraftId, channelDraft, selectedDraftChannelIds, channelDraftLoading, channelDraftSaving,
    closeChannelDraft, confirmChannelDraft, toggleDraftChannel,
    // publish
    publishDraft, setPublishDraft, publishState, publishing, openPublishDraft, doPublish,
    // schedule
    schedAction, setSchedAction, schedBusy, openReschedule, doReschedule, doCancelSched,
    autoDist, setAutoDist, autoDistBusy, openAutoDist, toggleAutoClip, doAutoDistribute,
  };
}

export type ConsoleCtx = ReturnType<typeof useConsoleState>;
const Ctx = createContext<ConsoleCtx | null>(null);

export function ConsoleProvider({ children }: { children: ReactNode }) {
  const value = useConsoleState();
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useConsole(): ConsoleCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useConsole must be used within ConsoleProvider");
  return v;
}
