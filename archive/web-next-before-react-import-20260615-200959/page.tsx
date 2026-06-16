"use client";

import { ChangeEvent, DragEvent, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  BarChart3,
  Bell,
  CalendarDays,
  CheckCircle2,
  Clipboard,
  Download,
  ExternalLink,
  Eye,
  FileJson,
  LayoutGrid,
  Loader2,
  LogIn,
  LogOut,
  MessageCircle,
  Package,
  PlayCircle,
  Plus,
  RefreshCw,
  Scissors,
  Search,
  Tags,
  ThumbsUp,
  TrendingUp,
  Users,
  UploadCloud,
  WandSparkles,
  X,
  Youtube,
  Zap
} from "lucide-react";
import {
  applyCreative,
  AssetUploadResponse,
  Clip,
  CreativeApplyRequest,
  getJob,
  getJobDebug,
  authLoginUrl,
  AuthUser,
  getChannelAnalytics,
  getMe,
  getRenderTemplates,
  getResults,
  getYouTubeStatus,
  getPublishStatus,
  importFromYouTube,
  inspectVideo,
  logout,
  AnalyticsSort,
  ChannelAnalytics,
  Job,
  JobDebug,
  getStudioSummary,
  mediaUrl,
  publishToYouTube,
  regenerateTitles,
  RenderTemplate,
  ShortsStylePreset,
  StudioSummary,
  SubtitleMode,
  TitleOption,
  uploadOverlayAsset,
  uploadVideo,
  VideoInspection,
  YouTubePublish,
  YouTubeStatus,
  youtubeConnectUrl
} from "@/lib/api";

const workflowSteps = [
  ["01", "영상 업로드", "긴 MP4를 끌어다 놓기만 하면 분석이 시작됩니다."],
  ["02", "자막 분석", "STT로 전체 발화를 읽고 문장 경계를 맞춥니다."],
  ["03", "AI 컷 선별", "터질 구간만 골라 점수화하고 대표 프레임을 봅니다."],
  ["04", "쇼츠 완성", "세로 영상, 제목, 태그, 업로드 패키지까지 만듭니다."]
];

const subtitleModeOptions: Array<{ id: SubtitleMode; label: string; title: string }> = [
  { id: "auto", label: "Auto", title: "Skip extra captions when the source has a subtitle stream." },
  { id: "on", label: "Add", title: "Add Korean Shorts captions unless the source already has a subtitle stream." },
  { id: "off", label: "None", title: "Do not add extra captions." }
];

const stylePresetOptions: Array<{ id: ShortsStylePreset; label: string; title: string }> = [
  { id: "korean_pop", label: "K-Shorts", title: "Bold Korean Shorts captions with hook-term color emphasis." },
  { id: "clean", label: "Clean", title: "Minimal captions with softer outline and no color emphasis." },
  { id: "news", label: "News", title: "Compact high-contrast captions for information-heavy clips." }
];

const getCleanReturnUrl = () => {
  if (typeof window === "undefined") return undefined;
  return `${window.location.origin}${window.location.pathname}`;
};

const navigateForOAuth = (url: string) => {
  if (typeof window === "undefined") return;
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- OAuth redirects start on the API origin.
  window.location.assign(url);
};

const scoreBandLabels: Record<string, string> = {
  publish_candidate: "Publish",
  review_candidate: "Review",
  needs_edit: "Needs edit",
  weak: "Weak"
};

const scoreBandLabel = (band?: string) => scoreBandLabels[band ?? ""] ?? "Review";
const scoreBandClass = (band?: string) => `band-${(band ?? "review_candidate").replaceAll("_", "-")}`;

type StudioView = "home" | "projects" | "schedule" | "analytics";

const studioNavItems: Array<{ id: StudioView; label: string; short: string; icon: typeof LayoutGrid }> = [
  { id: "home", label: "Clip board", short: "Home", icon: LayoutGrid },
  { id: "projects", label: "Projects", short: "Projects", icon: Clipboard },
  { id: "schedule", label: "Schedule", short: "Schedule", icon: CalendarDays },
  { id: "analytics", label: "Analytics", short: "Analytics", icon: BarChart3 }
];

const publishStatusLabels: Record<string, string> = {
  draft: "Draft",
  pending: "Queued",
  uploading: "Uploading",
  scheduled: "Scheduled",
  published: "Published",
  failed: "Failed"
};

const stylePresetLabels: Record<string, string> = {
  korean_pop: "K-Shorts",
  clean: "Clean",
  news: "News",
  custom: "Custom"
};

const analyticsSortOptions: Array<{ id: AnalyticsSort; label: string }> = [
  { id: "views", label: "조회수" },
  { id: "likes", label: "좋아요" },
  { id: "comments", label: "댓글" },
  { id: "recent", label: "최신순" }
];

const formatCount = (value: number) => {
  if (value >= 100000000) return `${(value / 100000000).toFixed(value % 100000000 === 0 ? 0 : 1)}억`;
  if (value >= 10000) return `${(value / 10000).toFixed(value % 10000 === 0 ? 0 : 1)}만`;
  return value.toLocaleString("ko-KR");
};

const formatDate = (value?: string | null) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
};

const formatDuration = (value?: number | null) => {
  if (!value || value <= 0) return "";
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

const weekDays = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const dateKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const formatMonthLabel = (year: number, month: number) => `${year}.${String(month + 1).padStart(2, "0")}`;

const formatTime = (value?: string | null) => {
  if (!value) return "09:00";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "09:00";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

const timeValue = (value?: string | null) => {
  if (!value) return 0;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
};

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [dragging, setDragging] = useState(false);
  const [previewDuration, setPreviewDuration] = useState<number | null>(null);
  const [videoInspection, setVideoInspection] = useState<VideoInspection | null>(null);
  const [inspectionLoading, setInspectionLoading] = useState(false);
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedClip, setSelectedClip] = useState<Clip | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugData, setDebugData] = useState<JobDebug | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [modalTab, setModalTab] = useState<"titles" | "overlay" | "youtube">("titles");
  const [templates, setTemplates] = useState<RenderTemplate[]>([]);
  const [titleOptions, setTitleOptions] = useState<TitleOption[]>([]);
  const [selectedTitleOption, setSelectedTitleOption] = useState<TitleOption | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState("clean");
  const [overlayPosition, setOverlayPosition] = useState("top_right");
  const [overlayScale, setOverlayScale] = useState(0.12);
  const [overlayAsset, setOverlayAsset] = useState<AssetUploadResponse | null>(null);
  const [subtitleMode, setSubtitleMode] = useState<SubtitleMode>("auto");
  const [stylePreset, setStylePreset] = useState<ShortsStylePreset>("korean_pop");
  const [creativeBusy, setCreativeBusy] = useState(false);
  const [titleLoading, setTitleLoading] = useState(false);
  const [assetLoading, setAssetLoading] = useState(false);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [youtubeStatus, setYoutubeStatus] = useState<YouTubeStatus | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [publishPrivacy, setPublishPrivacy] = useState("public");
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishResult, setPublishResult] = useState<YouTubePublish | null>(null);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [analyticsChannelId, setAnalyticsChannelId] = useState<string | null>(null);
  const [analyticsData, setAnalyticsData] = useState<ChannelAnalytics | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsSort, setAnalyticsSort] = useState<AnalyticsSort>("views");
  const [studioView, setStudioView] = useState<StudioView>("home");
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  const [studioSummary, setStudioSummary] = useState<StudioSummary | null>(null);
  const [studioLoading, setStudioLoading] = useState(false);

  const isWorking = busy || job?.status === "pending" || job?.status === "processing";
  const boardCount = clips.length;
  const showHomeResultsShell = studioView === "home" && (clips.length > 0 || Boolean(job));
  const showHomeControls = studioView === "home" && (clips.length > 0 || Boolean(job) || Boolean(error));

  const statusLabel = useMemo(() => {
    if (!job) return clips.length ? "Latest completed" : "Ready";
    if (job.status === "completed") return "Completed";
    if (job.status === "failed") return "Failed";
    if (job.status === "processing") return "Processing";
    return "Queued";
  }, [clips.length, job]);

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === selectedTemplateId) ?? templates[0],
    [selectedTemplateId, templates]
  );
  const videoPreviewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);

  const previewTitle = selectedTitleOption?.title ?? selectedClip?.title ?? "";
  const previewOverlayText =
    selectedTitleOption?.overlay_text ??
    selectedClip?.thumbnail_text ??
    selectedTemplate?.badge_text ??
    "";

  const selectClip = (clip: Clip) => {
    const creative = clip.creative_settings ?? {};
    const assetId = typeof creative.asset_id === "string" ? creative.asset_id : "";
    const assetUrl = typeof creative.asset_url === "string" ? creative.asset_url : "";

    setModalTab("titles");
    setTitleOptions(clip.title_options ?? []);
    setSelectedTitleOption((clip.title_options ?? [])[0] ?? null);
    setSelectedTemplateId(String(creative.template_id ?? "clean"));
    setOverlayPosition(String(creative.overlay_position ?? "top_right"));
    setOverlayScale(Number(creative.overlay_scale ?? 0.12));
    setOverlayAsset(assetId && assetUrl ? { asset_id: assetId, asset_url: assetUrl, filename: assetId } : null);
    setPublishResult(null);
    setSelectedClip(clip);
  };

  const loadYouTubeStatus = async () => {
    try {
      const status = await getYouTubeStatus();
      setYoutubeStatus(status);
      setSelectedChannelId((current) => {
        if (current && status.channels.some((channel) => channel.id === current)) return current;
        const fallback = status.channels.find((channel) => channel.is_default) ?? status.channels[0];
        return fallback ? fallback.id : null;
      });
    } catch {
      // YouTube may not be configured yet; the panel handles the empty state.
    }
  };

  const loadAuth = async () => {
    try {
      setAuthUser(await getMe());
    } catch {
      setAuthUser(null);
    }
  };

  const loginGoogle = () => {
    navigateForOAuth(authLoginUrl(getCleanReturnUrl()));
  };

  const signOut = async () => {
    try {
      await logout();
    } finally {
      setNotice(null);
      setAuthUser(null);
      setYoutubeStatus(null);
      await loadYouTubeStatus();
    }
  };

  const connectYouTube = () => {
    const returnUrl = getCleanReturnUrl();
    const authenticated = Boolean(authUser || youtubeStatus?.authenticated);
    setError(null);
    setNotice(null);

    if (!authenticated && typeof window !== "undefined") {
      const loginReturnUrl = new URL(returnUrl ?? window.location.href);
      loginReturnUrl.searchParams.set("connect_youtube", "1");
      navigateForOAuth(authLoginUrl(loginReturnUrl.toString()));
      return;
    }

    navigateForOAuth(youtubeConnectUrl(returnUrl));
  };

  const loadAnalytics = async (channelDbId: string, sort: AnalyticsSort) => {
    setAnalyticsLoading(true);
    setError(null);
    try {
      const data = await getChannelAnalytics(channelDbId, { limit: 50, sort });
      setAnalyticsData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "채널 분석 데이터를 불러오지 못했습니다.");
    } finally {
      setAnalyticsLoading(false);
    }
  };

  const openAnalytics = (channelDbId: string | null) => {
    const target = channelDbId ?? youtubeStatus?.channels[0]?.id ?? null;
    if (!target) {
      setError("먼저 유튜브 채널을 연결해 주세요.");
      return;
    }
    setAnalyticsChannelId(target);
    setAnalyticsOpen(true);
    setAnalyticsData(null);
    loadAnalytics(target, analyticsSort);
  };

  const changeAnalyticsChannel = (channelDbId: string) => {
    setAnalyticsChannelId(channelDbId);
    loadAnalytics(channelDbId, analyticsSort);
  };

  const changeAnalyticsSort = (sort: AnalyticsSort) => {
    setAnalyticsSort(sort);
    if (analyticsChannelId) loadAnalytics(analyticsChannelId, sort);
  };

  const loadStudioSummary = async () => {
    setStudioLoading(true);
    try {
      setStudioSummary(await getStudioSummary());
    } catch {
      setStudioSummary(null);
    } finally {
      setStudioLoading(false);
    }
  };

  const publishSelectedClip = async () => {
    if (!selectedClip) return;
    setPublishBusy(true);
    setError(null);
    try {
      const created = await publishToYouTube(selectedClip.clip_id, {
        channel_db_id: selectedChannelId,
        privacy_status: publishPrivacy
      });
      setPublishResult(created);
      let current = created;
      for (let attempt = 0; attempt < 600; attempt += 1) {
        if (current.status !== "pending" && current.status !== "uploading") break;
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
        current = await getPublishStatus(created.id);
        setPublishResult(current);
      }
      await loadStudioSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : "유튜브 업로드에 실패했습니다.");
    } finally {
      setPublishBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;

    void Promise.resolve().then(() => {
      if (!cancelled) loadStudioSummary();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!videoPreviewUrl) return;
    return () => {
      URL.revokeObjectURL(videoPreviewUrl);
    };
  }, [videoPreviewUrl]);

  useEffect(() => {
    if (!file) return;

    let cancelled = false;
    void inspectVideo(file)
      .then((result) => {
        if (!cancelled) setVideoInspection(result);
      })
      .catch((err) => {
        if (!cancelled) setInspectionError(err instanceof Error ? err.message : "자막 여부를 확인하지 못했습니다.");
      })
      .finally(() => {
        if (!cancelled) setInspectionLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [file]);

  useEffect(() => {
    let cancelled = false;
    if (typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);
    const yt = params.get("youtube");
    const login = params.get("login");
    const connectAfterLogin = params.get("connect_youtube") === "1";
    const message = params.get("message") ?? "";
    let nextError: string | null = null;
    let nextNotice: string | null = null;

    if (yt === "error") nextError = `YouTube 채널 연결에 실패했습니다${message ? `: ${message}` : "."}`;
    if (yt === "login_required") nextError = "먼저 Google로 로그인해 주세요.";
    if (login === "error") nextError = `로그인에 실패했습니다${message ? `: ${message}` : "."}`;
    if (yt === "connected") nextNotice = "YouTube 채널 연결이 완료되었습니다.";
    if (login === "ok" && !connectAfterLogin) nextNotice = "Google 로그인 완료.";

    if (yt || login || connectAfterLogin || params.has("message")) {
      params.delete("youtube");
      params.delete("login");
      params.delete("message");
      params.delete("connect_youtube");
      const query = params.toString();
      window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    }

    if (connectAfterLogin && login !== "error" && yt !== "error") {
      navigateForOAuth(youtubeConnectUrl(getCleanReturnUrl()));
      return;
    }

    void Promise.resolve().then(async () => {
      await Promise.all([loadAuth(), loadYouTubeStatus()]);
      if (cancelled) return;
      if (nextError) {
        setNotice(null);
        setError(nextError);
        return;
      }
      if (nextNotice) {
        setError(null);
        setNotice(nextNotice);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!jobId) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const nextJob = await getJob(jobId);
        if (cancelled) return;
        setJob(nextJob);
        if (nextJob.status === "completed") {
          const results = await getResults(jobId);
          if (!cancelled) setClips(results.clips);
          if (!cancelled) loadStudioSummary();
          return;
        }
        if (nextJob.status === "failed") return;
        window.setTimeout(poll, 2500);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "작업 상태를 가져오지 못했습니다.");
      }
    };

    poll();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  useEffect(() => {
    if (!selectedClip || templates.length) return;
    let cancelled = false;
    getRenderTemplates()
        .then((nextTemplates) => {
          if (!cancelled) setTemplates(nextTemplates);
        })
        .catch((err) => setError(err instanceof Error ? err.message : "템플릿을 가져오지 못했습니다."));
    return () => {
      cancelled = true;
    };
  }, [selectedClip, templates.length]);

  const pickFile = (candidate: File | undefined) => {
    if (!candidate) return;
    if (!candidate.name.toLowerCase().endsWith(".mp4")) {
      setError("MP4 파일만 업로드할 수 있습니다.");
      return;
    }
    setFile(candidate);
    setPreviewDuration(null);
    setVideoInspection(null);
    setInspectionError(null);
    setInspectionLoading(true);
    setError(null);
    setNotice(null);
  };

  const onInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    pickFile(event.target.files?.[0]);
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    pickFile(event.dataTransfer.files?.[0]);
  };

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setClips([]);
    setJob(null);
    setDebugData(null);
    setStudioView("home");
    try {
      const response = await uploadVideo(file, subtitleMode, stylePreset);
      setJobId(response.job_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "업로드에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const submitYoutube = async () => {
    const url = youtubeUrl.trim();
    if (!url) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setClips([]);
    setJob(null);
    setDebugData(null);
    setStudioView("home");
    try {
      const response = await importFromYouTube(url, subtitleMode, stylePreset);
      setJobId(response.job_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "YouTube 영상을 가져오지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const refreshResults = async () => {
    try {
      setError(null);
      if (jobId) {
        const [nextJob, results] = await Promise.all([getJob(jobId), getResults(jobId)]);
        setJob(nextJob);
        setClips(results.clips);
        await loadStudioSummary();
        return;
      }
      await loadStudioSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : "결과를 새로고침하지 못했습니다.");
    }
  };

  const openDebug = async () => {
    if (!jobId) return;
    setDebugOpen(true);
    setDebugLoading(true);
    try {
      setDebugData(await getJobDebug(jobId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "디버그 정보를 가져오지 못했습니다.");
    } finally {
      setDebugLoading(false);
    }
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setError("클립보드 복사 권한을 확인해 주세요.");
    }
  };

  const replaceClip = (nextClip: Clip) => {
    setClips((current) => current.map((clip) => (clip.clip_id === nextClip.clip_id ? nextClip : clip)));
    selectClip(nextClip);
  };

  const regenerateTitleOptions = async () => {
    if (!selectedClip) return;
    setTitleLoading(true);
    setError(null);
    try {
      const response = await regenerateTitles(selectedClip.clip_id);
      setTitleOptions(response.options);
      setSelectedTitleOption(response.options[0] ?? null);
      setSelectedClip({ ...selectedClip, title_options: response.options });
      setClips((current) =>
        current.map((clip) => (clip.clip_id === selectedClip.clip_id ? { ...clip, title_options: response.options } : clip))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "제목 후보를 생성하지 못했습니다.");
    } finally {
      setTitleLoading(false);
    }
  };

  const uploadOverlay = async (event: ChangeEvent<HTMLInputElement>) => {
    const candidate = event.target.files?.[0];
    if (!candidate || !jobId) return;
    setAssetLoading(true);
    setError(null);
    try {
      const asset = await uploadOverlayAsset(jobId, candidate);
      setOverlayAsset(asset);
    } catch (err) {
      setError(err instanceof Error ? err.message : "오버레이 이미지를 업로드하지 못했습니다.");
    } finally {
      setAssetLoading(false);
      event.target.value = "";
    }
  };

  const applyCreativeSelection = async () => {
    if (!selectedClip) return;
    setCreativeBusy(true);
    setError(null);
    const payload: CreativeApplyRequest = {
      title: previewTitle || selectedClip.title,
      thumbnail_text: previewOverlayText || selectedClip.thumbnail_text || selectedClip.title,
      template_id: selectedTemplateId,
      asset_id: overlayAsset?.asset_id,
      overlay_position: overlayPosition,
      overlay_scale: overlayScale
    };
    try {
      const updated = await applyCreative(selectedClip.clip_id, payload);
      replaceClip(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "선택한 편집 설정을 렌더하지 못했습니다.");
    } finally {
      setCreativeBusy(false);
    }
  };

  const studioProjects = useMemo(() => studioSummary?.projects ?? [], [studioSummary]);
  const studioSchedule = useMemo(() => studioSummary?.schedule ?? [], [studioSummary]);
  const openStudioProject = studioProjects.find((project) => project.job_id === openProjectId) ?? null;
  const scheduleMonth = useMemo(() => {
    const firstScheduled = studioSchedule.find((item) => item.schedule_date)?.schedule_date ?? studioSchedule[0]?.updated_at;
    const date = firstScheduled ? new Date(firstScheduled) : new Date();
    const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
    return { year: safeDate.getFullYear(), month: safeDate.getMonth(), label: formatMonthLabel(safeDate.getFullYear(), safeDate.getMonth()) };
  }, [studioSchedule]);
  const scheduleCells = useMemo(() => {
    const first = new Date(scheduleMonth.year, scheduleMonth.month, 1);
    const start = new Date(scheduleMonth.year, scheduleMonth.month, 1 - first.getDay());
    const grouped = new Map<string, typeof studioSchedule>();

    studioSchedule.forEach((item) => {
      const value = item.schedule_date ?? item.updated_at;
      if (!value) return;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return;
      const key = dateKey(date);
      grouped.set(key, [...(grouped.get(key) ?? []), item]);
    });

    const todayKey = dateKey(new Date());
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      const key = dateKey(date);
      return {
        key,
        day: date.getDate(),
        currentMonth: date.getMonth() === scheduleMonth.month,
        today: key === todayKey,
        items: grouped.get(key) ?? []
      };
    });
  }, [scheduleMonth, studioSchedule]);
  const upcomingSchedule = useMemo(
    () =>
      [...studioSchedule]
        .sort((left, right) => timeValue(left.schedule_date ?? left.updated_at) - timeValue(right.schedule_date ?? right.updated_at))
        .slice(0, 5),
    [studioSchedule]
  );
  const uploadDuration = videoInspection?.duration_seconds ?? previewDuration;
  const uploadDurationLabel =
    typeof uploadDuration === "number" && Number.isFinite(uploadDuration) && uploadDuration > 0
      ? formatDuration(uploadDuration)
      : inspectionLoading
        ? "CHECK"
        : "READY";
  const subtitleCheckTone = inspectionLoading
    ? "checking"
    : inspectionError
      ? "error"
      : videoInspection?.has_subtitle_stream
        ? "found"
        : videoInspection
          ? "missing"
          : "idle";
  const subtitleCheckIcon =
    subtitleCheckTone === "checking" ? (
      <Loader2 className="spin" size={14} />
    ) : subtitleCheckTone === "found" ? (
      <CheckCircle2 size={14} />
    ) : subtitleCheckTone === "error" ? (
      <AlertCircle size={14} />
    ) : (
      <MessageCircle size={14} />
    );
  const subtitleCheckLabel =
    subtitleCheckTone === "checking"
      ? "자막 검사 중"
      : subtitleCheckTone === "found"
        ? "자막 있음"
        : subtitleCheckTone === "missing"
          ? "자막 없음"
          : subtitleCheckTone === "error"
            ? "검사 실패"
            : "자막 대기";
  const subtitleCheckDetail =
    subtitleCheckTone === "found"
      ? "자동 모드에서는 추가 자막을 건너뜁니다."
      : subtitleCheckTone === "missing"
        ? "STT로 자막을 만든 뒤 쇼츠 후보를 찾습니다."
        : subtitleCheckTone === "error"
          ? inspectionError
          : "영상 업로드와 동시에 확인합니다.";
  const renderSelectedUploadCard = (variant = "") =>
    file ? (
      <div className={`selected-upload-card ${variant}`}>
        <div className={`selected-upload-poster ${videoPreviewUrl ? "has-video" : ""}`}>
          {videoPreviewUrl ? (
            <video
              controls
              muted
              playsInline
              preload="metadata"
              src={videoPreviewUrl}
              onLoadedMetadata={(event) => {
                const duration = event.currentTarget.duration;
                if (Number.isFinite(duration)) setPreviewDuration(duration);
              }}
            />
          ) : null}
          <span className="selected-upload-duration">{uploadDurationLabel}</span>
          <span className="selected-upload-name">{file.name}</span>
          <i>
            <PlayCircle size={24} />
          </i>
        </div>
        <div className="selected-upload-footer">
          <div>
            <strong>업로드 완료</strong>
            <span className={`caption-inspection inspection-${subtitleCheckTone}`}>
              {subtitleCheckIcon}
              {subtitleCheckLabel}
            </span>
            <em>{subtitleCheckDetail}</em>
          </div>
          <button className="render-button" onClick={submit} disabled={!file || isWorking} type="button">
            {isWorking ? <Loader2 className="spin" size={18} /> : <WandSparkles size={18} />}
            {isWorking ? "분석 중" : "쇼츠 만들기"}
          </button>
        </div>
      </div>
    ) : null;
  const studioContent =
    studioView === "home" ? null : (
      <>
        {studioView === "projects" ? (
          <section className={openStudioProject ? "studio-view studio-project-detail" : "studio-view studio-projects-view"}>
            {openStudioProject ? (
              <>
                <button className="studio-back-button" type="button" onClick={() => setOpenProjectId(null)}>
                  <span>‹</span>
                  프로젝트
                </button>
                <div className="studio-head">
                  <div>
                    <span className="studio-eyebrow">이 영상에서 만든 쇼츠</span>
                    <h1>{openStudioProject.title}</h1>
                    <p className="board-subtitle">
                      {formatDate(openStudioProject.updated_at)}
                      {openStudioProject.duration ? ` · ${formatDuration(openStudioProject.duration)}` : ""}
                      {` · 쇼츠 ${openStudioProject.clip_count}개`}
                    </p>
                  </div>
                  <button className="board-action-primary" type="button" onClick={loadStudioSummary} disabled={studioLoading}>
                    <RefreshCw className={studioLoading ? "spin" : ""} size={16} />
                    새로고침
                  </button>
                </div>
                {openStudioProject.clips.length ? (
                  <div className="project-detail-grid">
                    {openStudioProject.clips.map((clip) => (
                      <article className="project-clip-card" key={clip.clip_id}>
                        <div className="project-clip-poster">
                          {clip.thumbnail_url ? (
                            // eslint-disable-next-line @next/next/no-img-element -- backend-generated local media
                            <img src={mediaUrl(clip.thumbnail_url)} alt="" />
                          ) : (
                            <span />
                          )}
                          <div className="poster-topline">
                            <div className="poster-score-chip">
                              <Zap size={13} />
                              <span>{clip.score}</span>
                            </div>
                            <span className="poster-duration">#{clip.rank}</span>
                          </div>
                          <div className="project-clip-caption">{clip.title}</div>
                          <em className={`publish-pill publish-${clip.status}`}>
                            {publishStatusLabels[clip.status] ?? clip.status}
                          </em>
                        </div>
                        <div className="project-clip-meta">
                          <h3>{clip.title}</h3>
                          <span>{formatDate(clip.updated_at)}</span>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="studio-empty">아직 생성된 쇼츠가 없습니다.</div>
                )}
              </>
            ) : (
              <div className="studio-list-shell">
                <div className="studio-head">
                  <div>
                    <h1>프로젝트</h1>
                    <p className="board-subtitle">업로드한 원본과 거기서 만들어진 쇼츠를 한곳에서 관리하세요.</p>
                  </div>
                  <label className="board-action-primary">
                    <input type="file" accept="video/mp4" onChange={onInputChange} />
                    <Plus size={16} />
                    새 영상
                  </label>
                </div>
                {studioProjects.length ? (
                  <div className="project-grid">
                    {studioProjects.map((project) => {
                      const cover = project.clips[0];
                      return (
                        <article className="project-card" key={project.job_id} onClick={() => setOpenProjectId(project.job_id)}>
                          <div className="project-cover">
                            {cover ? (
                              // eslint-disable-next-line @next/next/no-img-element -- backend-generated local media
                              <img src={mediaUrl(cover.thumbnail_url)} alt="" />
                            ) : (
                              <span />
                            )}
                            <span className="project-duration">{formatDuration(project.duration) || `${project.clip_count} clips`}</span>
                            <span className="project-short-count">
                              <PlayCircle size={15} />
                              쇼츠 {project.clip_count}개
                            </span>
                          </div>
                          <div className="project-body">
                            <h3>{project.title}</h3>
                            <div>
                              <span className="project-date">{formatDate(project.updated_at)}</span>
                              <em className={`publish-pill project-status job-${project.status}`}>{project.status}</em>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="studio-empty">아직 프로젝트가 없습니다. 홈에서 영상을 올리면 이곳에 쌓입니다.</div>
                )}
              </div>
            )}
          </section>
        ) : null}

        {studioView === "schedule" ? (
          <section className="studio-view schedule-view">
            <div className="studio-head">
              <div>
                <h1>예약 발행</h1>
                <p className="board-subtitle">YouTube에 예약 걸어둔 쇼츠를 달력에서 한눈에 확인하세요.</p>
              </div>
              <div className="schedule-actions">
                <div className="month-control">
                  <button type="button" title="이전 달">‹</button>
                  <span>{scheduleMonth.label}</span>
                  <button type="button" title="다음 달">›</button>
                </div>
                <button className="board-action-primary dark" type="button" onClick={loadStudioSummary} disabled={studioLoading}>
                  <Plus size={16} />
                  예약 추가
                </button>
              </div>
            </div>
            <div className="schedule-board">
              <div className="schedule-calendar">
                <div className="schedule-weekdays">
                  {weekDays.map((day) => (
                    <span key={day}>{day}</span>
                  ))}
                </div>
                <div className="schedule-days">
                  {scheduleCells.map((cell) => (
                    <div className={`schedule-day ${cell.currentMonth ? "" : "muted"} ${cell.today ? "today" : ""}`} key={cell.key}>
                      <span>{cell.day}</span>
                      {cell.items.slice(0, 2).map((item) => (
                        <a
                          className={`calendar-event publish-${item.status}`}
                          href={item.youtube_url ?? undefined}
                          key={item.publish_id}
                          target={item.youtube_url ? "_blank" : undefined}
                          rel={item.youtube_url ? "noreferrer" : undefined}
                        >
                          <b>{formatTime(item.schedule_date ?? item.updated_at)}</b>
                          <em>{item.title}</em>
                        </a>
                      ))}
                      {cell.items.length > 2 ? <small>+{cell.items.length - 2}</small> : null}
                    </div>
                  ))}
                </div>
              </div>
              <aside className="upcoming-panel">
                <div className="upcoming-head">
                  <span>
                    <CalendarDays size={16} />
                  </span>
                  <strong>다가오는 예약</strong>
                </div>
                <div className="upcoming-list">
                  {upcomingSchedule.length ? (
                    upcomingSchedule.map((item) => (
                      <div className="upcoming-item" key={item.publish_id}>
                        <div>
                          <b>{new Date(item.schedule_date ?? item.updated_at ?? "").getDate() || "-"}</b>
                          <span>{formatTime(item.schedule_date ?? item.updated_at)}</span>
                        </div>
                        <p>{item.title}</p>
                      </div>
                    ))
                  ) : (
                    <em>예약된 클립이 없습니다.</em>
                  )}
                </div>
              </aside>
            </div>
          </section>
        ) : null}

        {studioView === "analytics" ? (
          <section className="studio-view analytics-view">
            <div className="analytics-page-shell">
              <h1>분석</h1>
              <p>채널을 누르면 올라간 영상별 조회수·좋아요·댓글과 실제 반응을 볼 수 있어요.</p>
              <div className="channel-list">
                {(youtubeStatus?.channels ?? []).map((channel) => (
                  <article className="channel-card" key={channel.id} onClick={() => openAnalytics(channel.id)}>
                    {channel.thumbnail_url ? (
                      // eslint-disable-next-line @next/next/no-img-element -- external YouTube avatar
                      <img src={channel.thumbnail_url} alt="" />
                    ) : (
                      <span>{channel.title.slice(0, 1)}</span>
                    )}
                    <div className="channel-main">
                      <div>
                        <strong>{channel.title}</strong>
                        <em>{channel.google_account_email ?? channel.channel_id}</em>
                      </div>
                      <div className="channel-metrics">
                        <span>
                          연결 <b>{formatDate(channel.connected_at) || "활성"}</b>
                        </span>
                        <span>
                          발행 <b>{studioSummary?.published_count ?? 0}</b>
                        </span>
                        <span>
                          예약 <b>{studioSummary?.scheduled_count ?? 0}</b>
                        </span>
                      </div>
                    </div>
                    <span className="channel-up">
                      <TrendingUp size={15} />
                      Open
                    </span>
                    <button type="button" title="채널 분석 열기">
                      ›
                    </button>
                  </article>
                ))}
                {youtubeStatus?.channels.length ? null : (
                  <div className="studio-empty">YouTube 채널을 연결하면 채널 분석이 이 화면에 표시됩니다.</div>
                )}
              </div>
            </div>
          </section>
        ) : null}

      </>
    );

  return (
    <div className="app-shell">
      <aside className="side-rail" aria-label="Workspace navigation">
        <div className="workspace-switch">
          <span>S</span>
        </div>
        <div className="rail-group">
          <label className="rail-button rail-upload" title="영상 추가">
            <input type="file" accept="video/mp4" onChange={onInputChange} hidden />
            <Plus size={20} />
            <span>Add</span>
          </label>
          <button className={`rail-button ${studioView === "home" ? "active" : ""}`} type="button" title="홈" onClick={() => setStudioView("home")}>
            <LayoutGrid size={20} />
            <span>Home</span>
          </button>
          {studioNavItems
            .filter((item) => item.id !== "home")
            .map((item) => {
              const Icon = item.icon;
              return (
                <button
                  className={`rail-button ${studioView === item.id ? "active" : ""}`}
                  key={item.id}
                  type="button"
                  title={item.label}
                  onClick={() => {
                    setStudioView(item.id);
                    loadStudioSummary();
                  }}
                >
                  <Icon size={19} />
                  <span>{item.short}</span>
                </button>
              );
            })}
          {jobId ? (
            <button className="rail-button" type="button" title="파이프라인 디버그" onClick={openDebug}>
              <FileJson size={20} />
              <span>Debug</span>
            </button>
          ) : null}
        </div>
        <div className="rail-group rail-bottom">
          <div className="rail-divider" />
          {!authUser ? (
            <button className="rail-account" type="button" title="Google로 로그인" onClick={loginGoogle}>
              <LogIn size={20} />
              <span className="rail-status-dot dot-idle" />
            </button>
          ) : (
            <>
              {!youtubeStatus?.configured ? (
                <div className="rail-account" title="서버에 YouTube OAuth가 설정되지 않았습니다 (.env)">
                  <Youtube size={20} />
                  <span className="rail-status-dot dot-idle" />
                </div>
              ) : youtubeStatus.channels.length === 0 ? (
                <button className="rail-account" type="button" title="유튜브 채널 연결" onClick={connectYouTube}>
                  <Youtube size={20} />
                  <span className="rail-status-dot dot-warn" />
                </button>
              ) : (
                <button
                  className="rail-account"
                  type="button"
                  title={`${(youtubeStatus.channels.find((channel) => channel.is_default) ?? youtubeStatus.channels[0]).title} · 클릭하면 채널 추가`}
                  onClick={connectYouTube}
                >
                  <Youtube size={20} />
                  <span className="rail-status-dot dot-live" />
                </button>
              )}
              <button
                className="rail-account rail-user"
                type="button"
                title={`${authUser.email ?? authUser.name ?? "로그인됨"} · 클릭하면 로그아웃`}
                onClick={signOut}
              >
                {authUser.picture_url ? (
                  // eslint-disable-next-line @next/next/no-img-element -- external Google avatar
                  <img src={authUser.picture_url} alt="" className="rail-avatar" />
                ) : (
                  <LogOut size={20} />
                )}
              </button>
            </>
          )}
        </div>
      </aside>

      <div className="main-stage">
        <header className="app-topbar">
          <div className="project-name">
            <strong>STEP D</strong>
            <span>/</span>
            <em>{job?.original_filename ?? "AI 쇼츠 워크스페이스"}</em>
          </div>
          <div className="search-box" role="search" aria-label="클립 검색">
            <Search size={17} />
            <span>키워드나 장면을 검색</span>
            <kbd>Ctrl K</kbd>
          </div>
          <div className="top-actions">
            <button className="icon-ghost" type="button" title="알림">
              <Bell size={19} />
              <span className="notification-dot" />
            </button>
            <div className="credits" title="생성 크레딧">
              <Zap size={15} />
              <span>{studioSummary?.clip_count ?? clips.length}</span>
            </div>
            <label className="credit-button">
              <input type="file" accept="video/mp4" onChange={onInputChange} />
              <Plus size={16} />
              영상 추가
            </label>
          </div>
        </header>

        <main className={`clip-board ${studioView === "home" && !clips.length && !job ? "clip-board-empty" : ""}`}>
          {notice ? (
            <div className="status-banner status-banner-success">
              <CheckCircle2 size={16} />
              <span>{notice}</span>
            </div>
          ) : null}
          {error && !showHomeControls ? (
            <div className="status-banner status-banner-error">
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          ) : null}

          {showHomeResultsShell ? (
            <>
          <div className="board-toolbar">
            <div className="board-tabs">
              <span>클립 보드</span>
            </div>
          </div>

          <div className="board-title-row">
            <div>
              <span className="board-kicker">{clips.length ? "분석 완료" : "AI 쇼츠 스튜디오 · 베타"}</span>
              <h1>바이럴 클립 후보 <span>{boardCount}</span></h1>
              <p className="board-subtitle">
                점수가 높을수록 첫 3초 이탈률이 낮고 끝까지 볼 확률이 높아요. 카드를 눌러 제목·오버레이·유튜브 패키지를 편집하세요.
              </p>
                </div>
                <span className={`job-pill job-${job?.status ?? "ready"}`}>
                  {statusLabel}
                </span>
              </div>
            </>
          ) : null}

          {studioContent}
          {studioView === "home" ? (
            <>
          {showHomeControls ? (
            <>
          <section className="hook-panel">
            <div className="hook-copy">
              <h2>긴 영상을 터지는 쇼츠로, 한 번에.</h2>
              <p>
                STT로 후보를 먼저 좁히고, Gemini는 상위 장면만 확인합니다. 완성된 컷은 제목 후보·오버레이·유튜브 패키지까지 이어집니다.
              </p>
            </div>
          </section>

          <section className="upload-strip">
            <label
              className={`dark-upload ${dragging ? "dragging" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <input type="file" accept="video/mp4" onChange={onInputChange} />
              <UploadCloud size={19} />
              <span>{file ? file.name : "MP4를 끌어다 놓거나 클릭해서 선택"}</span>
            </label>
            <div className="youtube-import">
              <Youtube size={17} />
              <input
                type="url"
                inputMode="url"
                placeholder="또는 YouTube 링크 붙여넣기 (https://youtu.be/...)"
                value={youtubeUrl}
                onChange={(event) => setYoutubeUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submitYoutube();
                }}
              />
              <button type="button" onClick={submitYoutube} disabled={!youtubeUrl.trim() || isWorking}>
                {isWorking ? <Loader2 className="spin" size={16} /> : <WandSparkles size={16} />}
                {isWorking ? "가져오는 중" : "링크로 만들기"}
              </button>
            </div>
            <div className="subtitle-mode" aria-label="Caption mode">
              {subtitleModeOptions.map((option) => (
                <button
                  className={subtitleMode === option.id ? "active" : ""}
                  key={option.id}
                  onClick={() => setSubtitleMode(option.id)}
                  title={option.title}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="subtitle-mode style-preset" aria-label="Shorts style">
              {stylePresetOptions.map((option) => (
                <button
                  className={stylePreset === option.id ? "active" : ""}
                  key={option.id}
                  onClick={() => setStylePreset(option.id)}
                  title={option.title}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
            {file ? null : (
              <button className="render-button" onClick={submit} disabled={!file || isWorking} type="button">
                {isWorking ? <Loader2 className="spin" size={18} /> : <WandSparkles size={18} />}
                {isWorking ? "분석 중" : "쇼츠 만들기"}
              </button>
            )}
          </section>
          {file ? renderSelectedUploadCard("selected-upload-card-inline") : null}

          {job ? (
            <div className="progress-wrap">
              <div className="progress-label">
                <span>{job.status}</span>
                <span>{job.progress}%</span>
              </div>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${job.progress}%` }} />
              </div>
            </div>
          ) : null}

          {error || job?.error ? (
            <div className="error-box">
              <AlertCircle size={16} />
              <span>{error ?? job?.error}</span>
            </div>
          ) : null}
            </>
          ) : null}

          {clips.length ? (
            <div className="clip-grid">
              {clips.map((clip) => (
                <article className="clip-card" key={clip.clip_id} onClick={() => selectClip(clip)}>
                  <div className="poster">
                    {/* eslint-disable-next-line @next/next/no-img-element -- backend-generated local media is served directly */}
                    <img src={mediaUrl(clip.thumbnail_url)} alt={clip.title} />
                    <div className="poster-topline">
                      <div className="poster-score-chip">
                        <Zap size={13} />
                        <span>{clip.score}</span>
                      </div>
                      <span className="poster-duration">{Math.round(clip.duration_seconds)}초</span>
                    </div>
                    <div className="time-badge">
                      <b>{clip.start_time}</b>
                      <span>{clip.end_time}</span>
                    </div>
                    {clip.thumbnail_text ? <div className="hook-bubble">{clip.thumbnail_text}</div> : null}
                    <div className="play-chip">
                      <PlayCircle size={16} />
                      Preview
                    </div>
                  </div>
                  <div className="clip-info">
                    <div className="score-line">
                      <div className="score-pack">
                        <strong>{clip.score}</strong>
                        {clip.clip_briefing?.score_band ? (
                          <span className={`card-band ${scoreBandClass(clip.clip_briefing.score_band)}`}>
                            {scoreBandLabel(clip.clip_briefing.score_band)}
                          </span>
                        ) : null}
                      </div>
                      <div className="mini-actions" onClick={(event) => event.stopPropagation()}>
                        <button type="button" title="Preview" onClick={() => selectClip(clip)}>
                          <PlayCircle size={17} />
                        </button>
                        <a href={mediaUrl(clip.thumbnail_url)} target="_blank" rel="noreferrer" title="Open thumbnail">
                          <Package size={17} />
                        </a>
                        <a href={mediaUrl(clip.video_url)} download title="Download clip">
                          <Download size={17} />
                        </a>
                      </div>
                    </div>
                    <h3>{clip.title}</h3>
                    <p>{clip.reason}</p>
                    {clip.clip_briefing?.first_three_seconds ? (
                      <div className="card-briefing">
                        <span>First 3s</span>
                        <strong>{clip.clip_briefing.first_three_seconds}</strong>
                      </div>
                    ) : null}
                    {clip.korean_shorts_signals?.hook_terms?.length ? (
                      <div className="signal-row">
                        {clip.korean_shorts_signals.hook_terms.slice(0, 3).map((term) => (
                          <span key={term}>{term}</span>
                        ))}
                      </div>
                    ) : null}
                    {clip.clip_briefing?.risk_flags?.length ? (
                      <div className="risk-row">
                        {clip.clip_briefing.risk_flags.slice(0, 2).map((risk) => (
                          <span key={risk}>{risk}</span>
                        ))}
                      </div>
                    ) : null}
                    <div className="label-row">
                      {(clip.youtube_metadata?.labels ?? []).slice(0, 3).map((label) => (
                        <span key={label}>{label}</span>
                      ))}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ) : !job ? (
            <section className="empty-studio">
              <div className="empty-kicker">
                <span />
                AI 쇼츠 스튜디오 · 베타
              </div>
              <h2>
                긴 영상을 터지는 쇼츠로,
                <br />
                <span>한 번에.</span>
              </h2>
              <p>
                MP4 하나만 올리면 자막을 분석해 가장 터질 구간을 골라내고, 9:16 세로 쇼츠와 제목·해시태그까지 자동으로 만들어 드려요.
              </p>
              <label
                className={`hero-dropzone ${dragging ? "dragging" : ""}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
              >
                <input type="file" accept="video/mp4" onChange={onInputChange} />
                <span className="hero-drop-icon">
                  <UploadCloud size={28} />
                </span>
                <strong>{file ? file.name : "영상을 여기에 끌어다 놓으세요"}</strong>
                <small>MP4 · 최대 2시간 · 끌어다 놓거나 클릭해서 선택</small>
                <b>파일 선택하기</b>
              </label>
              {renderSelectedUploadCard()}
              <div className="empty-link-divider">
                <span />
                <em>또는 YouTube 링크로 시작</em>
                <span />
              </div>
              <div className="empty-youtube-row">
                <div>
                  <Youtube size={16} />
                  <input
                    type="url"
                    inputMode="url"
                    placeholder="https://youtube.com/watch?v=..."
                    value={youtubeUrl}
                    onChange={(event) => setYoutubeUrl(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") submitYoutube();
                    }}
                  />
                </div>
                <button type="button" onClick={submitYoutube} disabled={!youtubeUrl.trim() || isWorking}>
                  {isWorking ? <Loader2 className="spin" size={16} /> : <WandSparkles size={16} />}
                  가져오기
                </button>
              </div>
              <div className="workflow-grid">
                {workflowSteps.map(([step, title, description]) => (
                  <article key={step}>
                    <span>{step}</span>
                    <strong>{title}</strong>
                    <p>{description}</p>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
            </>
          ) : null}
        </main>
      </div>

      {selectedClip ? (
        <div className="modal-backdrop" onClick={() => setSelectedClip(null)}>
          <section className="clip-modal" onClick={(event) => event.stopPropagation()}>
            <button className="modal-close" type="button" onClick={() => setSelectedClip(null)} title="Close">
              <X size={18} />
            </button>
            <div className="modal-video">
              <video controls poster={mediaUrl(selectedClip.thumbnail_url)} src={mediaUrl(selectedClip.video_url)} />
              <div className="creative-preview-layer" aria-hidden="true">
                {previewOverlayText ? <div className="preview-title-strip">{previewOverlayText}</div> : null}
                {overlayAsset ? (
                  // eslint-disable-next-line @next/next/no-img-element -- user-uploaded local media is served directly
                  <img
                    className={`preview-overlay preview-${overlayPosition}`}
                    src={mediaUrl(overlayAsset.asset_url)}
                    alt=""
                    style={{ width: `${Math.round(overlayScale * 100)}%` }}
                  />
                ) : selectedTemplate?.badge_text ? (
                  <div className={`preview-badge preview-${overlayPosition}`}>{selectedTemplate.badge_text}</div>
                ) : null}
              </div>
            </div>
            <div className="modal-meta">
              <div className="modal-score">
                <strong>{selectedClip.score}</strong>
                <span>viral score</span>
              </div>
              <h2>{selectedClip.title}</h2>
              <p>{selectedClip.reason}</p>

              <div className="signal-panel">
                <div className="signal-head">
                  <span>{selectedClip.korean_shorts_signals.selection_basis}</span>
                  <b>{selectedClip.korean_shorts_signals.fallback ? "Fallback" : "Vision"}</b>
                </div>
                <div className="score-breakdown">
                  {selectedClip.korean_shorts_signals.score_breakdown.map((item) => (
                    <div className="score-metric" key={item.label}>
                      <div>
                        <span>{item.label}</span>
                        <strong>{Math.round(item.value)}</strong>
                      </div>
                      <i style={{ width: `${Math.max(0, Math.min(100, item.value))}%` }} />
                    </div>
                  ))}
                </div>
                <div className="signal-row modal-signal-row">
                  {[...selectedClip.korean_shorts_signals.hook_terms, ...selectedClip.korean_shorts_signals.labels]
                    .slice(0, 8)
                    .map((signal) => (
                      <span key={signal}>{signal}</span>
                    ))}
                </div>
                {selectedClip.korean_shorts_signals.boundary_reason ? (
                  <p className="boundary-note">Cut boundary: {selectedClip.korean_shorts_signals.boundary_reason}</p>
                ) : null}
              </div>

              <div className="briefing-panel">
                <div className="briefing-head">
                  <span>Korean Shorts briefing</span>
                  <b>{selectedClip.clip_briefing.score_band.replaceAll("_", " ")}</b>
                </div>
                <div className="briefing-hook">
                  <strong>{selectedClip.clip_briefing.first_three_seconds}</strong>
                  <p>{selectedClip.clip_briefing.why_it_works}</p>
                </div>
                <div className="briefing-columns">
                  <div>
                    <span>Retention</span>
                    {selectedClip.clip_briefing.retention_plan.slice(0, 3).map((item) => (
                      <p key={item}>{item}</p>
                    ))}
                  </div>
                  <div>
                    <span>Upload actions</span>
                    {selectedClip.clip_briefing.upload_actions.slice(0, 3).map((item) => (
                      <p key={item}>{item}</p>
                    ))}
                  </div>
                </div>
                {selectedClip.clip_briefing.risk_flags.length ? (
                  <div className="briefing-risks">
                    {selectedClip.clip_briefing.risk_flags.slice(0, 4).map((item) => (
                      <span key={item}>{item}</span>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="creative-workbench">
                <div className="creative-tabs" role="tablist" aria-label="Creative tools">
                  {(["titles", "overlay", "youtube"] as const).map((tab) => (
                    <button
                      className={modalTab === tab ? "active" : ""}
                      key={tab}
                      onClick={() => setModalTab(tab)}
                      type="button"
                    >
                      {tab === "titles" ? "Titles" : tab === "overlay" ? "Overlay" : "YouTube"}
                    </button>
                  ))}
                </div>

                {modalTab === "titles" ? (
                  <section className="creative-panel">
                    <div className="panel-headline">
                      <strong>Title options</strong>
                      <button onClick={regenerateTitleOptions} disabled={titleLoading} type="button">
                        {titleLoading ? <Loader2 className="spin" size={15} /> : <WandSparkles size={15} />}
                        Regenerate 5
                      </button>
                    </div>
                    <div className="title-option-list">
                      {(titleOptions.length ? titleOptions : selectedClip.title_options ?? []).map((option) => (
                        <button
                          className={selectedTitleOption?.id === option.id ? "title-option active" : "title-option"}
                          key={option.id}
                          onClick={() => setSelectedTitleOption(option)}
                          type="button"
                        >
                          <strong>{option.title}</strong>
                          <span>{option.overlay_text}</span>
                          <p>{option.reason}</p>
                        </button>
                      ))}
                      {!titleOptions.length && !(selectedClip.title_options ?? []).length ? (
                        <div className="empty-creative">Generate title options for this clip.</div>
                      ) : null}
                    </div>
                  </section>
                ) : null}

                {modalTab === "overlay" ? (
                  <section className="creative-panel">
                    <div className="template-grid">
                      {templates.map((template) => (
                        <button
                          className={selectedTemplateId === template.id ? "template-chip active" : "template-chip"}
                          key={template.id}
                          onClick={() => {
                            setSelectedTemplateId(template.id);
                            setOverlayPosition(template.position);
                            setOverlayScale(template.scale);
                            setOverlayAsset(null);
                          }}
                          type="button"
                        >
                          <strong>{template.label}</strong>
                          <span>{template.badge_text || "No badge"}</span>
                        </button>
                      ))}
                    </div>
                    <div className="overlay-controls">
                      <label>
                        Position
                        <select value={overlayPosition} onChange={(event) => setOverlayPosition(event.target.value)}>
                          <option value="top_right">Top right</option>
                          <option value="top_left">Top left</option>
                          <option value="top_center">Top center</option>
                          <option value="bottom_right">Bottom right</option>
                          <option value="bottom_left">Bottom left</option>
                        </select>
                      </label>
                      <label>
                        Scale
                        <input
                          max="0.4"
                          min="0.04"
                          onChange={(event) => setOverlayScale(Number(event.target.value))}
                          step="0.01"
                          type="range"
                          value={overlayScale}
                        />
                      </label>
                      <label className="asset-upload-button">
                        {assetLoading ? <Loader2 className="spin" size={15} /> : <UploadCloud size={15} />}
                        {overlayAsset ? overlayAsset.filename : "Upload PNG/JPG"}
                        <input accept="image/png,image/jpeg" onChange={uploadOverlay} type="file" />
                      </label>
                    </div>
                  </section>
                ) : null}

                {modalTab === "youtube" ? (
                  <section className="creative-panel youtube-panel">
                    <div className="metadata-row">
                      <strong>{selectedClip.youtube_metadata.youtube_title}</strong>
                      <button type="button" onClick={() => copyText(selectedClip.youtube_metadata.youtube_title)}>
                        <Clipboard size={14} />
                      </button>
                    </div>
                    <div className="metadata-row">
                      <span>{selectedClip.youtube_metadata.tags.join(", ")}</span>
                      <button type="button" onClick={() => copyText(selectedClip.youtube_metadata.tags.join(", "))}>
                        <Clipboard size={14} />
                      </button>
                    </div>
                    <div className="metadata-row">
                      <span>{selectedClip.youtube_metadata.description}</span>
                      <button type="button" onClick={() => copyText(selectedClip.youtube_metadata.description)}>
                        <Clipboard size={14} />
                      </button>
                    </div>
                    <div className="metadata-row">
                      <span>MP4, thumbnail, metadata.json, description.txt, tags.csv</span>
                      <a href={mediaUrl(selectedClip.youtube_package_url ?? `/api/clips/${selectedClip.clip_id}/youtube-package`)}>
                        <Download size={14} />
                        ZIP
                      </a>
                    </div>

                    <div className="youtube-publish">
                      {!youtubeStatus?.configured ? (
                        <p className="publish-hint">
                          서버에 YouTube OAuth가 설정되지 않았습니다. .env의 YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET를 채운 뒤 API를 재시작하세요.
                        </p>
                      ) : youtubeStatus.channels.length === 0 ? (
                        <button type="button" className="publish-connect" onClick={connectYouTube}>
                          <Youtube size={16} />
                          유튜브 채널 연결
                        </button>
                      ) : (
                        <>
                          <div className="publish-controls">
                            <label>
                              채널
                              <select
                                value={selectedChannelId ?? ""}
                                onChange={(event) => setSelectedChannelId(event.target.value)}
                              >
                                {youtubeStatus.channels.map((channel) => (
                                  <option key={channel.id} value={channel.id}>
                                    {channel.title}
                                    {channel.is_default ? " (기본)" : ""}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              공개 상태
                              <select value={publishPrivacy} onChange={(event) => setPublishPrivacy(event.target.value)}>
                                <option value="public">공개</option>
                                <option value="unlisted">일부공개</option>
                                <option value="private">비공개</option>
                              </select>
                            </label>
                            <button
                              type="button"
                              className="publish-button"
                              onClick={publishSelectedClip}
                              disabled={publishBusy}
                            >
                              {publishBusy ? <Loader2 className="spin" size={15} /> : <Youtube size={15} />}
                              유튜브에 업로드
                            </button>
                            <button type="button" className="publish-add-channel" onClick={connectYouTube}>
                              채널 추가
                            </button>
                            <button
                              type="button"
                              className="publish-add-channel"
                              onClick={() => openAnalytics(selectedChannelId)}
                            >
                              <BarChart3 size={14} />
                              채널 분석
                            </button>
                          </div>
                          {publishResult ? (
                            <div className={`publish-status status-${publishResult.status}`}>
                              {publishResult.status === "published" || publishResult.status === "scheduled" ? (
                                <>
                                  <CheckCircle2 size={14} />
                                  <span>{publishResult.status === "scheduled" ? "예약 업로드 완료" : "업로드 완료"}</span>
                                  {publishResult.youtube_url ? (
                                    <a href={publishResult.youtube_url} target="_blank" rel="noreferrer">
                                      영상 보기
                                      <ExternalLink size={12} />
                                    </a>
                                  ) : null}
                                </>
                              ) : publishResult.status === "failed" ? (
                                <>
                                  <AlertCircle size={14} />
                                  <span>업로드 실패: {publishResult.error ?? "알 수 없는 오류"}</span>
                                </>
                              ) : (
                                <>
                                  <Loader2 className="spin" size={14} />
                                  <span>유튜브에 업로드하는 중…</span>
                                </>
                              )}
                            </div>
                          ) : null}
                        </>
                      )}
                    </div>
                  </section>
                ) : null}

                <div className="creative-actions">
                  <button onClick={applyCreativeSelection} disabled={creativeBusy} type="button">
                    {creativeBusy ? <Loader2 className="spin" size={16} /> : <Scissors size={16} />}
                    Apply & Render
                  </button>
                  {selectedClip.render_revision ? <span>Revision {selectedClip.render_revision}</span> : null}
                </div>
              </div>

              <div className="metadata-grid">
                <div className="metadata-block wide">
                  <div className="metadata-head">
                    <Tags size={16} />
                    YouTube title
                    <button type="button" onClick={() => copyText(selectedClip.youtube_metadata.youtube_title)}>
                      <Clipboard size={14} />
                    </button>
                  </div>
                  <p>{selectedClip.youtube_metadata.youtube_title}</p>
                </div>
                <div className="metadata-block wide">
                  <div className="metadata-head">
                    <FileJson size={16} />
                    Description
                    <button type="button" onClick={() => copyText(selectedClip.youtube_metadata.description)}>
                      <Clipboard size={14} />
                    </button>
                  </div>
                  <pre>{selectedClip.youtube_metadata.description}</pre>
                </div>
                <div className="metadata-block">
                  <div className="metadata-head">
                    <Tags size={16} />
                    Tags
                    <button type="button" onClick={() => copyText(selectedClip.youtube_metadata.tags.join(", "))}>
                      <Clipboard size={14} />
                    </button>
                  </div>
                  <div className="tag-cloud">
                    {selectedClip.youtube_metadata.tags.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                </div>
                <div className="metadata-block">
                  <div className="metadata-head">
                    <Tags size={16} />
                    Labels
                  </div>
                  <div className="tag-cloud hot">
                    {selectedClip.youtube_metadata.labels.map((label) => (
                      <span key={label}>{label}</span>
                    ))}
                  </div>
                </div>
              </div>

              <div className="modal-actions">
                <a href={mediaUrl(selectedClip.video_url)} target="_blank" rel="noreferrer">
                  <ExternalLink size={16} />
                  Open MP4
                </a>
                <a href={mediaUrl(selectedClip.video_url)} download>
                  <Download size={16} />
                  Download
                </a>
                <a href={mediaUrl(selectedClip.thumbnail_url)} target="_blank" rel="noreferrer">
                  <Package size={16} />
                  Thumbnail
                </a>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {debugOpen ? (
        <aside className="debug-drawer">
          <div className="debug-head">
            <div>
              <span>Pipeline Debug</span>
              <strong>{jobId}</strong>
            </div>
            <button type="button" onClick={() => setDebugOpen(false)} title="Close debug">
              <X size={18} />
            </button>
          </div>
          {debugLoading ? (
            <div className="debug-loading">
              <Loader2 className="spin" size={18} />
              Loading debug data
            </div>
          ) : debugData ? (
            <div className="debug-body">
              {debugData.warnings.length ? (
                <div className="debug-warning">
                  <AlertCircle size={15} />
                  <span>{debugData.warnings[0]}</span>
                </div>
              ) : null}
              <div className="debug-stats">
                <span>{debugData.transcript_segment_count} STT segments</span>
                <span>{debugData.candidate_count} candidates</span>
                <span>{debugData.evaluations.length} evaluations</span>
              </div>
              <section>
                <h3>Transcript Preview</h3>
                <p>{debugData.transcript_preview || "Transcript is not ready yet."}</p>
              </section>
              <section>
                <h3>Top Candidates</h3>
                <div className="candidate-list">
                  {debugData.candidates.slice(0, 8).map((candidate) => (
                    <div className="candidate-row" key={candidate.id}>
                      <strong>{candidate.local_score}</strong>
                      <div>
                        <span>
                          {candidate.start_time} - {candidate.end_time}
                        </span>
                        {candidate.boundary_reason ? (
                          <p className="boundary-note">Boundary: {candidate.boundary_reason}</p>
                        ) : null}
                        <p>{candidate.transcript_preview}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
              <section>
                <h3>Artifacts</h3>
                <div className="artifact-links">
                  {Object.entries(debugData.artifacts).map(([name, url]) => (
                    <a href={mediaUrl(url)} target="_blank" rel="noreferrer" key={name}>
                      <FileJson size={14} />
                      {name}
                    </a>
                  ))}
                </div>
              </section>
            </div>
          ) : (
            <div className="debug-loading">No debug data</div>
          )}
        </aside>
      ) : null}

      {analyticsOpen ? (
        <div className="modal-backdrop" onClick={() => setAnalyticsOpen(false)}>
          <div className="analytics-modal" onClick={(event) => event.stopPropagation()}>
            <div className="analytics-head">
              <div className="analytics-title">
                <BarChart3 size={18} />
                <div>
                  <span>채널 분석</span>
                  <strong>{analyticsData?.channel_title ?? "YouTube"}</strong>
                </div>
              </div>
              <div className="analytics-head-actions">
                {(youtubeStatus?.channels.length ?? 0) > 1 ? (
                  <select
                    value={analyticsChannelId ?? ""}
                    onChange={(event) => changeAnalyticsChannel(event.target.value)}
                  >
                    {youtubeStatus?.channels.map((channel) => (
                      <option key={channel.id} value={channel.id}>
                        {channel.title}
                      </option>
                    ))}
                  </select>
                ) : null}
                <button
                  type="button"
                  className="analytics-refresh"
                  onClick={() => analyticsChannelId && loadAnalytics(analyticsChannelId, analyticsSort)}
                  disabled={analyticsLoading}
                  title="새로고침"
                >
                  <RefreshCw className={analyticsLoading ? "spin" : ""} size={15} />
                </button>
                <button type="button" onClick={() => setAnalyticsOpen(false)} title="Close">
                  <X size={18} />
                </button>
              </div>
            </div>

            {analyticsData ? (
              <div className="analytics-summary">
                <div className="analytics-card">
                  <Users size={15} />
                  <span>구독자</span>
                  <strong>
                    {analyticsData.totals.hidden_subscriber_count
                      ? "비공개"
                      : formatCount(analyticsData.totals.subscriber_count)}
                  </strong>
                </div>
                <div className="analytics-card">
                  <PlayCircle size={15} />
                  <span>영상 수</span>
                  <strong>{formatCount(analyticsData.totals.video_count)}</strong>
                </div>
                <div className="analytics-card">
                  <Eye size={15} />
                  <span>총 조회수</span>
                  <strong>{formatCount(analyticsData.totals.channel_view_count)}</strong>
                </div>
                <div className="analytics-card">
                  <TrendingUp size={15} />
                  <span>표본 {analyticsData.totals.sampled_videos}개 조회수</span>
                  <strong>{formatCount(analyticsData.totals.sampled_views)}</strong>
                </div>
                <div className="analytics-card">
                  <ThumbsUp size={15} />
                  <span>표본 좋아요</span>
                  <strong>{formatCount(analyticsData.totals.sampled_likes)}</strong>
                </div>
                <div className="analytics-card">
                  <MessageCircle size={15} />
                  <span>표본 댓글</span>
                  <strong>{formatCount(analyticsData.totals.sampled_comments)}</strong>
                </div>
              </div>
            ) : null}

            <div className="analytics-sort">
              {analyticsSortOptions.map((option) => (
                <button
                  type="button"
                  key={option.id}
                  className={analyticsSort === option.id ? "active" : ""}
                  onClick={() => changeAnalyticsSort(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="analytics-list">
              {analyticsLoading ? (
                <div className="analytics-empty">
                  <Loader2 className="spin" size={18} />
                  분석 데이터를 불러오는 중…
                </div>
              ) : analyticsData && analyticsData.videos.length ? (
                analyticsData.videos.map((video) => (
                  <a
                    className="analytics-row"
                    key={video.video_id}
                    href={video.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span className="analytics-rank">{video.rank}</span>
                    {video.thumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={video.thumbnail} alt="" className="analytics-thumb" />
                    ) : (
                      <span className="analytics-thumb placeholder" />
                    )}
                    <div className="analytics-info">
                      <strong>{video.title}</strong>
                      <span className="analytics-date">{formatDate(video.published_at)}</span>
                    </div>
                    <div className="analytics-metrics">
                      <span title="조회수">
                        <Eye size={13} />
                        {formatCount(video.view_count)}
                      </span>
                      <span title="좋아요">
                        <ThumbsUp size={13} />
                        {formatCount(video.like_count)}
                      </span>
                      <span title="댓글">
                        <MessageCircle size={13} />
                        {formatCount(video.comment_count)}
                      </span>
                    </div>
                  </a>
                ))
              ) : (
                <div className="analytics-empty">표시할 영상이 없습니다.</div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
