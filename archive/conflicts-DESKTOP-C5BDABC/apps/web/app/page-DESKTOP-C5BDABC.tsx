"use client";

import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clipboard,
  Clock3,
  Download,
  ExternalLink,
  FileJson,
  Film,
  Loader2,
  Pause,
  Play,
  PlayCircle,
  Plus,
  RefreshCw,
  Scissors,
  Search,
  Tags,
  Trash2,
  Type,
  UploadCloud,
  WandSparkles,
  X,
  Youtube
} from "lucide-react";
import {
  autoPublishJobToYouTube,
  Clip,
  EditorOverlay,
  EditorProject,
  EditorSegment,
  getJob,
  getJobDebug,
  getResults,
  getVideos,
  getYouTubeChannels,
  getYouTubeConfig,
  getYouTubePublishes,
  Job,
  JobDebug,
  mediaUrl,
  publishClipToYouTube,
  rerenderClip,
  setDefaultYouTubeChannel,
  SourceVideo,
  startYouTubeOAuth,
  updateClip,
  uploadVideo,
  YouTubeChannel,
  YouTubeConfig,
  YouTubePublish
} from "@/lib/api";

type Draft = {
  title: string;
  reason: string;
  thumbnailText: string;
  youtubeTitle: string;
  description: string;
  tags: string;
};

const T = {
  edit: "\uD3B8\uC9D1",
  close: "\uB2EB\uAE30"
};

const statusLabel: Record<string, string> = {
  pending: "Queued",
  processing: "Processing",
  completed: "Completed",
  failed: "Failed"
};

const publishLabel: Record<string, string> = {
  pending: "Pending",
  uploading: "Uploading",
  scheduled: "Scheduled",
  published: "Published",
  failed: "Failed"
};

function draftFromClip(clip: Clip): Draft {
  return {
    title: clip.title,
    reason: clip.reason,
    thumbnailText: clip.thumbnail_text ?? "",
    youtubeTitle: clip.youtube_metadata.youtube_title,
    description: clip.youtube_metadata.description,
    tags: clip.youtube_metadata.tags.join(", ")
  };
}

function defaultProject(clip: Clip): EditorProject {
  return {
    render_title: clip.youtube_metadata.youtube_title || clip.title,
    aspect_ratio: "9:16-fit",
    segments: [
      {
        segmentId: crypto.randomUUID(),
        start: clip.start_seconds,
        end: clip.end_seconds
      }
    ],
    overlays: []
  };
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds || 0);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  const cs = Math.floor((safe % 1) * 100);
  return `${m}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function previewTitleLines(title: string): string[] {
  const value = title.trim();
  if (!value) return [];
  const words = value.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > 16 && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
    if (lines.length === 1) break;
  }
  if (current) lines.push(current);
  return lines.slice(0, 2);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function initialOAuthNotice(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const connected = params.get("youtube_connected");
  const oauthError = params.get("youtube_error");
  if (connected) return `YouTube channel connected: ${connected}`;
  if (oauthError) return `YouTube connection failed: ${oauthError}`;
  return null;
}

async function waitForRenderedClip(jobId: string, clipId: string): Promise<Clip> {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    await delay(attempt === 0 ? 700 : 1500);
    const result = await getResults(jobId);
    const clip = result.clips.find((item) => item.clip_id === clipId);
    if (!clip) continue;
    if (clip.edit_status === "failed") {
      throw new Error(clip.edit_error || "Render failed.");
    }
    if (clip.edit_status === "rendered") {
      return clip;
    }
  }
  throw new Error("Render is still running. Refresh again in a moment.");
}

export default function Home() {
  const [videos, setVideos] = useState<SourceVideo[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [activeClipId, setActiveClipId] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rerendering, setRerendering] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [autoPublishing, setAutoPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(() => initialOAuthNotice());
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugData, setDebugData] = useState<JobDebug | null>(null);
  const [youtubeConfig, setYouTubeConfig] = useState<YouTubeConfig | null>(null);
  const [youtubeChannels, setYouTubeChannels] = useState<YouTubeChannel[]>([]);
  const [selectedYoutubeChannelId, setSelectedYoutubeChannelId] = useState<string>("");
  const [publishPrivacy, setPublishPrivacy] = useState("");
  const [publishSchedule, setPublishSchedule] = useState("");
  const [autoMaxClips, setAutoMaxClips] = useState(5);
  const [autoMinScore, setAutoMinScore] = useState(0);
  const [publishes, setPublishes] = useState<YouTubePublish[]>([]);
  const [draft, setDraft] = useState<Draft>({
    title: "",
    reason: "",
    thumbnailText: "",
    youtubeTitle: "",
    description: "",
    tags: ""
  });
  const [editorClip, setEditorClip] = useState<Clip | null>(null);

  const selectedVideo = useMemo(
    () => videos.find((video) => video.job_id === selectedJobId) ?? null,
    [selectedJobId, videos]
  );
  const activeClip = useMemo(
    () => clips.find((clip) => clip.clip_id === activeClipId) ?? clips[0] ?? null,
    [activeClipId, clips]
  );
  const publishByClip = useMemo(() => {
    const map = new Map<string, YouTubePublish>();
    for (const publish of publishes) {
      if (!map.has(publish.clip_id)) map.set(publish.clip_id, publish);
    }
    return map;
  }, [publishes]);
  const activePublish = useMemo(
    () => (activeClip ? publishByClip.get(activeClip.clip_id) ?? null : null),
    [activeClip, publishByClip]
  );
  const hasRunningPublish = useMemo(
    () => publishes.some((publish) => publish.status === "pending" || publish.status === "uploading"),
    [publishes]
  );
  const publishCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const publish of publishes) counts[publish.status] = (counts[publish.status] ?? 0) + 1;
    return counts;
  }, [publishes]);
  const selectedYoutubeChannel = useMemo(
    () => youtubeChannels.find((channel) => channel.channel_id === selectedYoutubeChannelId || channel.id === selectedYoutubeChannelId) ?? null,
    [selectedYoutubeChannelId, youtubeChannels]
  );
  const selectedChannelUploadReady = selectedYoutubeChannel
    ? selectedYoutubeChannel.upload_ready
    : youtubeChannels.length === 0 && Boolean(youtubeConfig?.legacy_refresh_configured);
  const canPublishToYouTube = Boolean(
    youtubeConfig?.configured && selectedChannelUploadReady && (youtubeChannels.length > 0 || youtubeConfig.legacy_refresh_configured)
  );
  const effectivePublishPrivacy = publishPrivacy || youtubeConfig?.privacy_status || "private";
  const selectedScheduleDate = useMemo(() => {
    if (!publishSchedule) return undefined;
    const date = new Date(publishSchedule);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }, [publishSchedule]);

  const refreshYouTubeState = async () => {
    const [yt, channelData, publishData] = await Promise.all([
      getYouTubeConfig(),
      getYouTubeChannels(),
      getYouTubePublishes(selectedJobId ?? undefined)
    ]);
    setYouTubeConfig(yt);
    setYouTubeChannels(channelData.channels);
    setPublishes(publishData.publishes);
    setSelectedYoutubeChannelId((current) => {
      if (current && channelData.channels.some((channel) => channel.channel_id === current || channel.id === current)) {
        return current;
      }
      return channelData.channels.find((channel) => channel.is_default)?.channel_id || channelData.channels[0]?.channel_id || "";
    });
  };

  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      try {
        const [videoData, yt, channelData] = await Promise.all([getVideos(), getYouTubeConfig(), getYouTubeChannels()]);
        if (cancelled) return;
        setVideos(videoData.videos);
        setYouTubeConfig(yt);
        setPublishPrivacy((current) => current || yt.privacy_status || "private");
        setYouTubeChannels(channelData.channels);
        setSelectedYoutubeChannelId((current) => current || channelData.channels.find((channel) => channel.is_default)?.channel_id || channelData.channels[0]?.channel_id || "");
        setSelectedJobId((current) => current ?? videoData.videos[0]?.job_id ?? null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load initial data.");
      }
    };
    boot();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("youtube_connected");
    const oauthError = params.get("youtube_error");
    if (!connected && !oauthError) return;
    window.history.replaceState({}, "", window.location.pathname);
    const load = async () => {
      try {
        const [yt, channelData, publishData] = await Promise.all([
          getYouTubeConfig(),
          getYouTubeChannels(),
          getYouTubePublishes(selectedJobId ?? undefined)
        ]);
        setYouTubeConfig(yt);
        setPublishPrivacy((current) => current || yt.privacy_status || "private");
        setYouTubeChannels(channelData.channels);
        setPublishes(publishData.publishes);
        setSelectedYoutubeChannelId((current) => (
          current && channelData.channels.some((channel) => channel.channel_id === current || channel.id === current)
            ? current
            : channelData.channels.find((channel) => channel.is_default)?.channel_id || channelData.channels[0]?.channel_id || ""
        ));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to refresh YouTube channels.");
      }
    };
    void load();
  }, [selectedJobId]);

  useEffect(() => {
    if (!selectedJobId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const [nextJob, result, publishData] = await Promise.all([
          getJob(selectedJobId),
          getResults(selectedJobId),
          getYouTubePublishes(selectedJobId)
        ]);
        if (cancelled) return;
        setJob(nextJob);
        setClips(result.clips);
        setPublishes(publishData.publishes);
        const nextActiveId = activeClipId && result.clips.some((clip) => clip.clip_id === activeClipId)
          ? activeClipId
          : result.clips[0]?.clip_id ?? null;
        setActiveClipId(nextActiveId);
        const nextClip = result.clips.find((clip) => clip.clip_id === nextActiveId);
        if (nextClip) setDraft(draftFromClip(nextClip));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load video result.");
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [activeClipId, selectedJobId]);

  useEffect(() => {
    if (!job || (job.status !== "pending" && job.status !== "processing")) return;
    const timer = window.setInterval(async () => {
      if (!selectedJobId) return;
      try {
        const [videoData, nextJob, result] = await Promise.all([getVideos(), getJob(selectedJobId), getResults(selectedJobId)]);
        setVideos(videoData.videos);
        setJob(nextJob);
        setClips(result.clips);
      } catch {
        // Keep polling view quiet.
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [job, selectedJobId]);

  useEffect(() => {
    if (!selectedJobId || !hasRunningPublish) return;
    const timer = window.setInterval(async () => {
      try {
        const publishData = await getYouTubePublishes(selectedJobId);
        setPublishes(publishData.publishes);
      } catch {
        // Keep background publish polling quiet; explicit refresh still reports errors.
      }
    }, 4000);
    return () => window.clearInterval(timer);
  }, [hasRunningPublish, selectedJobId]);

  const pickFile = (candidate: File | undefined) => {
    if (!candidate) return;
    if (!candidate.name.toLowerCase().endsWith(".mp4")) {
      setError("Only MP4 files are supported.");
      return;
    }
    setFile(candidate);
    setError(null);
  };

  const upload = async () => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const response = await uploadVideo(file);
      const videoData = await getVideos();
      setVideos(videoData.videos);
      setSelectedJobId(response.job_id);
      setFile(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  };

  const refresh = async () => {
    try {
      const [videoData, yt, channelData] = await Promise.all([getVideos(), getYouTubeConfig(), getYouTubeChannels()]);
      setVideos(videoData.videos);
      setYouTubeConfig(yt);
      setPublishPrivacy((current) => current || yt.privacy_status || "private");
      setYouTubeChannels(channelData.channels);
      if (selectedJobId) {
        const [nextJob, result, publishData] = await Promise.all([
          getJob(selectedJobId),
          getResults(selectedJobId),
          getYouTubePublishes(selectedJobId)
        ]);
        setJob(nextJob);
        setClips(result.clips);
        setPublishes(publishData.publishes);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed.");
    }
  };

  const connectYouTube = async () => {
    setError(null);
    try {
      const response = await startYouTubeOAuth(window.location.href);
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Google OAuth auth_url is external.
      window.location.assign(response.auth_url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "YouTube connect failed.");
    }
  };

  const makeDefaultChannel = async () => {
    if (!selectedYoutubeChannelId) return;
    try {
      const channel = await setDefaultYouTubeChannel(selectedYoutubeChannelId);
      await refreshYouTubeState();
      setSelectedYoutubeChannelId(channel.channel_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set default channel.");
    }
  };

  const saveMetadata = async (): Promise<Clip | null> => {
    if (!activeClip) return null;
    setSaving(true);
    setError(null);
    try {
      const response = await updateClip(activeClip.clip_id, {
        title: draft.title,
        reason: draft.reason,
        thumbnail_text: draft.thumbnailText,
        youtube_metadata: {
          youtube_title: draft.youtubeTitle,
          description: draft.description,
          tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean)
        }
      });
      setClips((items) => items.map((clip) => (clip.clip_id === response.clip.clip_id ? response.clip : clip)));
      return response.clip;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
      return null;
    } finally {
      setSaving(false);
    }
  };

  const saveAndRerender = async () => {
    const saved = await saveMetadata();
    if (!saved || !selectedJobId) return;
    setRerendering(true);
    try {
      const response = await rerenderClip(saved.clip_id);
      setClips((items) => items.map((clip) => (clip.clip_id === response.clip.clip_id ? response.clip : clip)));
      const rendered = await waitForRenderedClip(selectedJobId, saved.clip_id);
      setClips((items) => items.map((clip) => (clip.clip_id === rendered.clip_id ? rendered : clip)));
      setDraft(draftFromClip(rendered));
      setVideos((await getVideos()).videos);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Render request failed.");
    } finally {
      setRerendering(false);
    }
  };

  const publish = async () => {
    const saved = await saveMetadata();
    if (!saved) return;
    setPublishing(true);
    setError(null);
    try {
      const publishResult = await publishClipToYouTube(saved.clip_id, {
        title: draft.youtubeTitle,
        description: draft.description,
        tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
        privacy_status: effectivePublishPrivacy,
        category_id: youtubeConfig?.category_id ?? "24",
        schedule_date: selectedScheduleDate,
        youtube_channel_id: selectedYoutubeChannel?.channel_id || selectedYoutubeChannelId || undefined
      });
      setPublishes((items) => [publishResult, ...items.filter((item) => item.publish_id !== publishResult.publish_id)]);
      setNotice(`YouTube publish queued: ${publishResult.title}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "YouTube publish failed.");
    } finally {
      setPublishing(false);
    }
  };

  const autoPublish = async () => {
    if (!selectedJobId) return;
    setAutoPublishing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await autoPublishJobToYouTube(selectedJobId, {
        max_clips: Math.min(10, Math.max(1, autoMaxClips)),
        min_score: Math.min(100, Math.max(0, autoMinScore)),
        privacy_status: effectivePublishPrivacy,
        category_id: youtubeConfig?.category_id ?? "24",
        schedule_date: selectedScheduleDate,
        youtube_channel_id: selectedYoutubeChannel?.channel_id || selectedYoutubeChannelId || undefined,
        skip_existing: true
      });
      const ids = new Set(result.publishes.map((item) => item.publish_id));
      setPublishes((items) => [...result.publishes, ...items.filter((item) => !ids.has(item.publish_id))]);
      setNotice(result.queued_count ? `Auto publish queued: ${result.queued_count} clips` : "No new clips to auto publish.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Auto publish failed.");
    } finally {
      setAutoPublishing(false);
    }
  };

  const openDebug = async () => {
    if (!selectedJobId) return;
    setDebugOpen(true);
    try {
      setDebugData(await getJobDebug(selectedJobId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load debug data.");
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setError("Clipboard permission is blocked.");
    }
  };

  const handleEditorSaved = (clip: Clip) => {
    setClips((items) => items.map((item) => (item.clip_id === clip.clip_id ? clip : item)));
    setActiveClipId(clip.clip_id);
    setDraft(draftFromClip(clip));
  };

  return (
    <div className="studio-shell">
      <aside className="video-rail">
        <div className="brand-block">
          <div className="brand-mark">S</div>
          <div>
            <strong>Shorts Studio</strong>
            <span>AI clip pipeline</span>
          </div>
        </div>

        <label
          className={`upload-card ${dragging ? "dragging" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event: DragEvent<HTMLLabelElement>) => {
            event.preventDefault();
            setDragging(false);
            pickFile(event.dataTransfer.files?.[0]);
          }}
        >
          <input type="file" accept="video/mp4" onChange={(event: ChangeEvent<HTMLInputElement>) => pickFile(event.target.files?.[0])} />
          <UploadCloud size={19} />
          <span>{file ? file.name : "Upload MP4"}</span>
        </label>
        <button className="primary-action" disabled={!file || uploading} onClick={upload} type="button">
          {uploading ? <Loader2 className="spin" size={16} /> : <WandSparkles size={16} />}
          Generate
        </button>

        <div className="rail-heading">
          <span>Source videos</span>
          <button onClick={refresh} type="button" title="Refresh">
            <RefreshCw size={15} />
          </button>
        </div>
        <div className="source-list">
          {videos.map((video) => (
            <button
              className={`source-item ${video.job_id === selectedJobId ? "active" : ""}`}
              key={video.job_id}
              onClick={() => {
                setSelectedJobId(video.job_id);
                setDebugData(null);
              }}
              type="button"
            >
              <div className="source-thumb">
                {video.thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element -- local generated thumbnail
                  <img src={mediaUrl(video.thumbnail_url)} alt="" />
                ) : (
                  <Film size={18} />
                )}
              </div>
              <div className="source-meta">
                <strong>{video.original_filename}</strong>
                <span>{statusLabel[video.status]} · {video.clip_count} clips</span>
              </div>
              <StatusDot status={video.status} />
            </button>
          ))}
          {!videos.length ? <p className="empty-copy">No uploaded videos yet.</p> : null}
        </div>
      </aside>

      <main className="workbench">
        <header className="workbench-top">
          <div>
            <span className="eyebrow">Source video</span>
            <h1>{selectedVideo?.original_filename ?? "Upload a video to generate shorts"}</h1>
          </div>
          <div className="top-tools">
            <div className="search-lite">
              <Search size={15} />
              <span>Search title, tags, moments</span>
            </div>
            <button onClick={openDebug} disabled={!selectedJobId} type="button">
              <FileJson size={16} />
              Debug
            </button>
            <button onClick={autoPublish} disabled={!selectedJobId || !clips.length || !canPublishToYouTube || autoPublishing} type="button">
              {autoPublishing ? <Loader2 className="spin" size={16} /> : <Youtube size={16} />}
              Auto publish
            </button>
          </div>
        </header>

        {error ? (
          <div className="notice error">
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        ) : null}
        {notice ? (
          <div className="notice subtle">
            <CheckCircle2 size={16} />
            <span>{notice}</span>
          </div>
        ) : null}

        {job ? (
          <section className="source-summary">
            <Metric label="Status" value={statusLabel[job.status]} />
            <Metric label="Progress" value={`${job.progress}%`} />
            <Metric label="Shorts" value={`${clips.length}`} />
            <Metric label="Top score" value={clips.length ? `${Math.max(...clips.map((clip) => clip.score))}` : "-"} />
            <Metric label="Publishing" value={`${publishCounts.pending ?? 0}/${publishCounts.uploading ?? 0}/${publishCounts.published ?? 0}`} />
            <div className="publish-control-bar">
              <label>
                <span>Privacy</span>
                <select value={effectivePublishPrivacy} onChange={(event) => setPublishPrivacy(event.target.value)}>
                  <option value="private">Private</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="public">Public</option>
                </select>
              </label>
              <label>
                <span>Auto clips</span>
                <input
                  min={1}
                  max={10}
                  type="number"
                  value={autoMaxClips}
                  onChange={(event) => setAutoMaxClips(Math.min(10, Math.max(1, Number(event.target.value) || 1)))}
                />
              </label>
              <label>
                <span>Min score</span>
                <input
                  min={0}
                  max={100}
                  type="number"
                  value={autoMinScore}
                  onChange={(event) => setAutoMinScore(Math.min(100, Math.max(0, Number(event.target.value) || 0)))}
                />
              </label>
              <label>
                <span>Schedule</span>
                <input
                  type="datetime-local"
                  value={publishSchedule}
                  onChange={(event) => setPublishSchedule(event.target.value)}
                />
              </label>
            </div>
            <div className="progress-track">
              <div style={{ width: `${job.progress}%` }} />
            </div>
          </section>
        ) : null}

        <section className="clip-workspace">
          <div className="clip-column">
            <div className="section-title">
              <div>
                <span>Generated shorts</span>
                <strong>{clips.length || 0} clips</strong>
              </div>
            </div>
            <div className="clip-list">
              {clips.map((clip) => {
                const publishState = publishByClip.get(clip.clip_id);
                return (
                  <button
                    className={`short-row ${clip.clip_id === activeClip?.clip_id ? "active" : ""}`}
                    key={clip.clip_id}
                    onClick={() => {
                      setActiveClipId(clip.clip_id);
                      setDraft(draftFromClip(clip));
                    }}
                    type="button"
                  >
                    <div className="short-poster">
                      {/* eslint-disable-next-line @next/next/no-img-element -- local generated thumbnail */}
                      <img src={mediaUrl(clip.thumbnail_url)} alt={clip.title} />
                      <span>{clip.start_time}</span>
                    </div>
                    <div className="short-info">
                      <div>
                        <strong>{clip.title}</strong>
                        <p>{clip.reason}</p>
                      </div>
                      <div className="short-footer">
                        <span className="score">{clip.score}</span>
                        <span>{clip.duration_seconds}s</span>
                        {publishState ? <span className={`publish-pill ${publishState.status}`}>{publishLabel[publishState.status] ?? publishState.status}</span> : null}
                        {clip.edit_status ? <span>{clip.edit_status}</span> : null}
                      </div>
                    </div>
                  </button>
                );
              })}
              {!clips.length ? (
                <div className="empty-state">
                  <Scissors size={28} />
                  <strong>No shorts yet</strong>
                  <span>Generated clips will appear here after the pipeline finishes.</span>
                </div>
              ) : null}
            </div>
          </div>

          <aside className="editor-panel">
            {activeClip ? (
              <>
                <div className="editor-preview">
                  <video controls poster={mediaUrl(activeClip.thumbnail_url)} src={mediaUrl(activeClip.video_url)} />
                </div>
                {activeClip.edit_error ? (
                  <div className="notice error">
                    <AlertCircle size={16} />
                    <span>{activeClip.edit_error}</span>
                  </div>
                ) : activeClip.edit_status ? (
                  <div className="notice subtle">
                    <PlayCircle size={16} />
                    <span>Render status: {activeClip.edit_status}</span>
                  </div>
                ) : null}
                <div className="editor-toolbar">
                  <a href={mediaUrl(activeClip.video_url)} target="_blank" rel="noreferrer">
                    <ExternalLink size={15} />
                    Open
                  </a>
                  <a href={mediaUrl(activeClip.video_url)} download>
                    <Download size={15} />
                    Download
                  </a>
                </div>

                {activePublish ? (
                  <div className={`publish-status-card ${activePublish.status}`}>
                    <div>
                      <Youtube size={16} />
                      <strong>{publishLabel[activePublish.status] ?? activePublish.status}</strong>
                    </div>
                    <span>{activePublish.youtube_channel_title || selectedYoutubeChannel?.title || "YouTube channel"}</span>
                    {activePublish.youtube_url ? (
                      <a href={activePublish.youtube_url} target="_blank" rel="noreferrer">
                        <ExternalLink size={14} />
                        Open on YouTube
                      </a>
                    ) : null}
                    {activePublish.error ? <p>{activePublish.error}</p> : null}
                  </div>
                ) : null}

                <div className="form-stack">
                  <Field label="Clip title">
                    <input value={draft.title} onChange={(event) => setDraft((prev) => ({ ...prev, title: event.target.value }))} />
                  </Field>
                  <Field label="Top overlay / YouTube title">
                    <input value={draft.youtubeTitle} onChange={(event) => setDraft((prev) => ({ ...prev, youtubeTitle: event.target.value }))} />
                  </Field>
                  <Field label="Reason">
                    <textarea value={draft.reason} rows={3} onChange={(event) => setDraft((prev) => ({ ...prev, reason: event.target.value }))} />
                  </Field>
                  <Field label="YouTube description">
                    <textarea value={draft.description} rows={6} onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))} />
                  </Field>
                  <Field label="Tags">
                    <input value={draft.tags} onChange={(event) => setDraft((prev) => ({ ...prev, tags: event.target.value }))} />
                  </Field>
                </div>

                <div className="channel-box">
                  <div className="channel-box-head">
                    <Youtube size={16} />
                    <strong>YouTube channel</strong>
                  </div>
                  {youtubeChannels.length ? (
                    <>
                      <div className="channel-picker">
                        <select value={selectedYoutubeChannelId} onChange={(event) => setSelectedYoutubeChannelId(event.target.value)}>
                          {youtubeChannels.map((channel) => (
                            <option key={channel.id} value={channel.channel_id}>
                              {channel.title}{channel.is_default ? " (default)" : ""}
                            </option>
                          ))}
                        </select>
                        <button onClick={makeDefaultChannel} type="button">
                          Default
                        </button>
                      </div>
                      {selectedYoutubeChannel ? (
                        <div className="channel-profile">
                          {selectedYoutubeChannel.google_account_picture_url ? (
                            // eslint-disable-next-line @next/next/no-img-element -- Google profile image from OAuth userinfo
                            <img src={selectedYoutubeChannel.google_account_picture_url} alt="" />
                          ) : (
                            <span className="profile-initial">
                              {(selectedYoutubeChannel.google_account_name || selectedYoutubeChannel.title).slice(0, 1)}
                            </span>
                          )}
                          <div>
                            <div className="channel-profile-title">
                              <strong>{selectedYoutubeChannel.google_account_name || "Google profile"}</strong>
                              <b className={selectedYoutubeChannel.upload_ready ? "ready" : "warn"}>
                                {selectedYoutubeChannel.upload_ready ? "Ready" : "Reconnect"}
                              </b>
                            </div>
                            <span>{selectedYoutubeChannel.google_account_email || "Email not shared"}</span>
                            <em>Channel: {selectedYoutubeChannel.title}</em>
                          </div>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <p>No YouTube channel connected.</p>
                  )}
                  <button className="connect-youtube" onClick={connectYouTube} type="button">
                    <Youtube size={15} />
                    Connect Google
                  </button>
                </div>

                <div className="editor-actions">
                  <button onClick={() => setEditorClip(activeClip)} disabled={saving} type="button">
                    <Scissors size={16} />
                    {T.edit}
                  </button>
                  <button onClick={saveAndRerender} disabled={saving || rerendering} type="button">
                    {rerendering ? <Loader2 className="spin" size={16} /> : <PlayCircle size={16} />}
                    Re-render title
                  </button>
                  <button onClick={() => copy(draft.description)} type="button">
                    <Clipboard size={16} />
                    Copy desc
                  </button>
                  <button className="youtube-button" onClick={publish} disabled={publishing || !canPublishToYouTube} type="button">
                    {publishing ? <Loader2 className="spin" size={16} /> : <Youtube size={16} />}
                    YouTube
                  </button>
                </div>

                {!youtubeConfig?.configured ? (
                  <div className="notice subtle">
                    <Youtube size={16} />
                    <span>Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env to enable Google login.</span>
                  </div>
                ) : selectedYoutubeChannel && !selectedYoutubeChannel.upload_ready ? (
                  <div className="notice subtle">
                    <Youtube size={16} />
                    <span>Reconnect this Google channel to refresh upload permission.</span>
                  </div>
                ) : !canPublishToYouTube ? (
                  <div className="notice subtle">
                    <Youtube size={16} />
                    <span>Connect a YouTube channel before publishing.</span>
                  </div>
                ) : null}

                <div className="tag-strip">
                  {(draft.tags ? draft.tags.split(",") : []).map((tag) => tag.trim()).filter(Boolean).slice(0, 12).map((tag) => (
                    <span key={tag}>
                      <Tags size={12} />
                      {tag}
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <div className="empty-state panel-empty">
                <Film size={30} />
                <strong>Select a short</strong>
                <span>Edit metadata, render title overlays, and publish to YouTube here.</span>
              </div>
            )}
          </aside>
        </section>
      </main>

      {debugOpen ? (
        <DebugPanel debugData={debugData} onClose={() => setDebugOpen(false)} />
      ) : null}

      {editorClip ? (
        <AenaStyleEditor
          clip={editorClip}
          draft={draft}
          jobId={selectedJobId}
          onClose={() => setEditorClip(null)}
          onError={setError}
          onSaved={handleEditorSaved}
        />
      ) : null}
    </div>
  );
}

function AenaStyleEditor({
  clip,
  draft,
  jobId,
  onClose,
  onError,
  onSaved
}: {
  clip: Clip;
  draft: Draft;
  jobId: string | null;
  onClose: () => void;
  onError: (message: string | null) => void;
  onSaved: (clip: Clip) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [project, setProject] = useState<EditorProject>(() => clip.editor_project ?? defaultProject(clip));
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(Math.max(0.1, clip.end_seconds - clip.start_seconds));
  const [playing, setPlaying] = useState(false);
  const [inPoint, setInPoint] = useState<number | null>(null);
  const [outPoint, setOutPoint] = useState<number | null>(null);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(project.segments[0]?.segmentId ?? null);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(project.overlays[0]?.overlayId ?? null);
  const [zoom, setZoom] = useState(1);
  const [saving, setSaving] = useState(false);

  const baseStart = clip.start_seconds;
  const selectedOverlay = project.overlays.find((overlay) => overlay.overlayId === selectedOverlayId) ?? null;
  const renderTitleLines = useMemo(
    () => previewTitleLines(project.render_title || draft.youtubeTitle || clip.title),
    [clip.title, draft.youtubeTitle, project.render_title]
  );

  const seek = (time: number) => {
    const safe = Math.max(0, Math.min(duration, time));
    if (videoRef.current) videoRef.current.currentTime = safe;
    setCurrentTime(safe);
  };

  const addSegment = () => {
    const start = inPoint ?? currentTime;
    const end = outPoint ?? Math.min(duration, start + 8);
    if (end <= start) return;
    const segment: EditorSegment = {
      segmentId: crypto.randomUUID(),
      start: baseStart + start,
      end: baseStart + end
    };
    setProject((prev) => ({ ...prev, segments: [...prev.segments, segment].sort((a, b) => a.start - b.start) }));
    setSelectedSegmentId(segment.segmentId);
    setInPoint(null);
    setOutPoint(null);
  };

  const removeSegment = () => {
    if (!selectedSegmentId) return;
    setProject((prev) => {
      const next = prev.segments.filter((segment) => segment.segmentId !== selectedSegmentId);
      return { ...prev, segments: next.length ? next : prev.segments };
    });
    setSelectedSegmentId(null);
  };

  const addOverlay = () => {
    const overlay: EditorOverlay = {
      overlayId: crypto.randomUUID(),
      type: "text",
      text: draft.youtubeTitle || clip.title,
      x: 92,
      y: 115,
      width: 900,
      fontSize: 72,
      fontWeight: 900,
      color: "white",
      strokeColor: "black",
      strokeWidth: 5,
      opacity: 1,
      textAlign: "center"
    };
    setProject((prev) => ({ ...prev, overlays: [...prev.overlays, overlay] }));
    setSelectedOverlayId(overlay.overlayId);
  };

  const updateOverlay = (overlayId: string, changes: Partial<EditorOverlay>) => {
    setProject((prev) => ({
      ...prev,
      overlays: prev.overlays.map((overlay) => (overlay.overlayId === overlayId ? { ...overlay, ...changes } : overlay))
    }));
  };

  const startOverlayDrag = (event: React.MouseEvent<HTMLButtonElement>, overlay: EditorOverlay) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedOverlayId(overlay.overlayId);
    const stage = event.currentTarget.parentElement;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = overlay.x;
    const originY = overlay.y;

    const move = (moveEvent: MouseEvent) => {
      const dx = ((moveEvent.clientX - startX) / rect.width) * 1080;
      const dy = ((moveEvent.clientY - startY) / rect.height) * 1920;
      updateOverlay(overlay.overlayId, {
        x: Math.round(Math.max(0, Math.min(1080, originX + dx))),
        y: Math.round(Math.max(0, Math.min(1920, originY + dy)))
      });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const removeOverlay = () => {
    if (!selectedOverlayId) return;
    setProject((prev) => ({ ...prev, overlays: prev.overlays.filter((overlay) => overlay.overlayId !== selectedOverlayId) }));
    setSelectedOverlayId(null);
  };

  const saveAndRender = async () => {
    setSaving(true);
    onError(null);
    try {
      const normalized: EditorProject = {
        ...project,
        render_title: project.render_title || draft.youtubeTitle || clip.title,
        segments: project.segments.length ? project.segments : defaultProject(clip).segments
      };
      const saved = await updateClip(clip.clip_id, {
        title: draft.title,
        reason: draft.reason,
        youtube_metadata: {
          youtube_title: normalized.render_title,
          description: draft.description,
          tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean)
        },
        editor_project: normalized
      });
      onSaved(saved.clip);
      const queued = await rerenderClip(saved.clip.clip_id);
      onSaved(queued.clip);
      const rendered = jobId ? await waitForRenderedClip(jobId, saved.clip.clip_id) : queued.clip;
      onSaved(rendered);
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Editor render failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="aena-editor">
      <div className="aena-toolbar">
        <button onClick={onClose} type="button">
          <X size={16} />
          {T.close}
        </button>
        <strong>{clip.title}</strong>
        <div className="aena-time">
          <span>{formatTime(currentTime)}</span>
          <span>/</span>
          <span>{formatTime(duration)}</span>
          {inPoint !== null ? <b>IN {formatTime(inPoint)}</b> : null}
          {outPoint !== null ? <b>OUT {formatTime(outPoint)}</b> : null}
        </div>
        <div className="aena-toolbar-actions">
          <button onClick={addOverlay} type="button">
            <Type size={15} />
            Text
          </button>
          <button onClick={saveAndRender} disabled={saving} type="button">
            {saving ? <Loader2 className="spin" size={15} /> : <PlayCircle size={15} />}
            Save & render
          </button>
        </div>
      </div>

      <div className="aena-main">
        <div className="aena-viewer">
          <div className="aena-canvas">
            <video
              ref={videoRef}
              src={mediaUrl(clip.video_url)}
              poster={mediaUrl(clip.thumbnail_url)}
              onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || duration)}
              onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
            />
            <div className="overlay-stage">
              {renderTitleLines.length ? (
                <div className="canvas-render-title" aria-hidden="true">
                  {renderTitleLines.map((line, index) => (
                    <span className={index === 1 ? "accent" : undefined} key={`${line}-${index}`}>
                      {line}
                    </span>
                  ))}
                </div>
              ) : null}
              {project.overlays.map((overlay) => (
                <button
                  key={overlay.overlayId}
                  className={`canvas-overlay ${overlay.overlayId === selectedOverlayId ? "active" : ""}`}
                  onClick={() => setSelectedOverlayId(overlay.overlayId)}
                  onMouseDown={(event) => startOverlayDrag(event, overlay)}
                  style={{
                    left: `${(overlay.x / 1080) * 100}%`,
                    top: `${(overlay.y / 1920) * 100}%`,
                    width: `${(overlay.width / 1080) * 100}%`,
                    color: overlay.color,
                    opacity: overlay.opacity,
                    fontSize: `${Math.max(12, overlay.fontSize / 5)}px`,
                    fontWeight: overlay.fontWeight,
                    textAlign: overlay.textAlign,
                    WebkitTextStroke: `${Math.max(0, overlay.strokeWidth / 5)}px ${overlay.strokeColor}`
                  }}
                  type="button"
                >
                  {overlay.text}
                </button>
              ))}
            </div>
          </div>
          <div className="aena-player-controls">
            <button onClick={() => {
              const video = videoRef.current;
              if (!video) return;
              if (video.paused) video.play().catch(() => undefined);
              else video.pause();
            }} type="button">
              {playing ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <button onClick={() => seek(Math.max(0, currentTime - 1))} type="button">-1s</button>
            <button onClick={() => seek(Math.min(duration, currentTime + 1))} type="button">+1s</button>
            <button onClick={() => setInPoint(currentTime)} type="button">Set IN</button>
            <button onClick={() => setOutPoint(currentTime)} type="button">Set OUT</button>
            <button onClick={addSegment} type="button">
              <Plus size={15} />
              Segment
            </button>
            <button onClick={removeSegment} type="button">
              <Trash2 size={15} />
              Segment
            </button>
          </div>
        </div>

        <aside className="aena-side">
          <Field label="Render title">
            <input value={project.render_title} onChange={(event) => setProject((prev) => ({ ...prev, render_title: event.target.value }))} />
          </Field>
          <Field label="Aspect">
            <select value={project.aspect_ratio} onChange={(event) => setProject((prev) => ({ ...prev, aspect_ratio: event.target.value as EditorProject["aspect_ratio"] }))}>
              <option value="9:16-fit">9:16 fit</option>
              <option value="9:16-crop">9:16 crop</option>
            </select>
          </Field>
          <div className="aena-segment-list">
            <div className="aena-side-head">
              <strong>Segments</strong>
              <span>{project.segments.length}</span>
            </div>
            {project.segments.map((segment) => (
              <button
                className={segment.segmentId === selectedSegmentId ? "active" : ""}
                key={segment.segmentId}
                onClick={() => {
                  setSelectedSegmentId(segment.segmentId);
                  seek(Math.max(0, segment.start - baseStart));
                }}
                type="button"
              >
                <span>{formatTime(segment.start - baseStart)}</span>
                <span>{formatTime(segment.end - baseStart)}</span>
              </button>
            ))}
          </div>

          {selectedOverlay ? (
            <div className="overlay-inspector">
              <div className="aena-side-head">
                <strong>Text overlay</strong>
                <button onClick={removeOverlay} type="button">
                  <Trash2 size={14} />
                </button>
              </div>
              <Field label="Text">
                <textarea value={selectedOverlay.text} rows={3} onChange={(event) => updateOverlay(selectedOverlay.overlayId, { text: event.target.value })} />
              </Field>
              <div className="two-fields">
                <Field label="X">
                  <input type="number" value={selectedOverlay.x} onChange={(event) => updateOverlay(selectedOverlay.overlayId, { x: Number(event.target.value) })} />
                </Field>
                <Field label="Y">
                  <input type="number" value={selectedOverlay.y} onChange={(event) => updateOverlay(selectedOverlay.overlayId, { y: Number(event.target.value) })} />
                </Field>
              </div>
              <div className="two-fields">
                <Field label="Size">
                  <input type="number" value={selectedOverlay.fontSize} onChange={(event) => updateOverlay(selectedOverlay.overlayId, { fontSize: Number(event.target.value) })} />
                </Field>
                <Field label="Stroke">
                  <input type="number" value={selectedOverlay.strokeWidth} onChange={(event) => updateOverlay(selectedOverlay.overlayId, { strokeWidth: Number(event.target.value) })} />
                </Field>
              </div>
              <div className="two-fields">
                <Field label="Color">
                  <input type="color" value={selectedOverlay.color.startsWith("#") ? selectedOverlay.color : "#ffffff"} onChange={(event) => updateOverlay(selectedOverlay.overlayId, { color: event.target.value })} />
                </Field>
                <Field label="Opacity">
                  <input type="number" min={0} max={1} step={0.1} value={selectedOverlay.opacity} onChange={(event) => updateOverlay(selectedOverlay.overlayId, { opacity: Number(event.target.value) })} />
                </Field>
              </div>
            </div>
          ) : (
            <div className="empty-state mini">
              <Type size={24} />
              <span>Add or select a text overlay.</span>
            </div>
          )}
        </aside>
      </div>

      <div className="aena-timeline">
        <div className="timeline-tools">
          <span>Timeline</span>
          <button onClick={() => setZoom(Math.max(1, zoom - 1))} type="button">-</button>
          <b>{zoom}x</b>
          <button onClick={() => setZoom(Math.min(20, zoom + 1))} type="button">+</button>
          <button onClick={() => setZoom(1)} type="button">fit</button>
        </div>
        <div className="timeline-scroll">
          <div className="timeline-track" style={{ width: `${100 * zoom}%` }} onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const ratio = (event.clientX - rect.left) / rect.width;
            seek(duration * ratio);
          }}>
            {project.segments.map((segment) => {
              const left = ((segment.start - baseStart) / duration) * 100;
              const width = ((segment.end - segment.start) / duration) * 100;
              return (
                <button
                  className={`timeline-segment ${segment.segmentId === selectedSegmentId ? "active" : ""}`}
                  key={segment.segmentId}
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedSegmentId(segment.segmentId);
                    seek(Math.max(0, segment.start - baseStart));
                  }}
                  style={{ left: `${left}%`, width: `${Math.max(0.5, width)}%` }}
                  type="button"
                />
              );
            })}
            {inPoint !== null ? <div className="timeline-marker in" style={{ left: `${(inPoint / duration) * 100}%` }} /> : null}
            {outPoint !== null ? <div className="timeline-marker out" style={{ left: `${(outPoint / duration) * 100}%` }} /> : null}
            <div className="timeline-playhead" style={{ left: `${(currentTime / duration) * 100}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function DebugPanel({ debugData, onClose }: { debugData: JobDebug | null; onClose: () => void }) {
  return (
    <aside className="debug-panel">
      <div className="debug-head">
        <strong>STT / Candidates</strong>
        <button onClick={onClose} type="button">Close</button>
      </div>
      {debugData ? (
        <div className="debug-content">
          <div className="debug-metrics">
            <Metric label="STT segments" value={String(debugData.transcript_segment_count)} />
            <Metric label="Candidates" value={String(debugData.candidate_count)} />
            <Metric label="Evaluations" value={String(debugData.evaluations.length)} />
          </div>
          {debugData.warnings.length ? (
            <div className="notice error">
              <AlertCircle size={16} />
              <span>{debugData.warnings[0]}</span>
            </div>
          ) : null}
          <h3>Transcript</h3>
          <p>{debugData.transcript_preview || "Transcript is not ready yet."}</p>
          <h3>Top candidates</h3>
          <div className="debug-candidates">
            {debugData.candidates.slice(0, 10).map((candidate) => (
              <div key={candidate.id}>
                <strong>{candidate.local_score}</strong>
                <span>{candidate.start_time} - {candidate.end_time}</span>
                <p>{candidate.transcript_preview}</p>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="debug-content">
          <Loader2 className="spin" size={18} />
        </div>
      )}
    </aside>
  );
}

function StatusDot({ status }: { status: string }) {
  if (status === "completed") return <CheckCircle2 className="status-icon completed" size={16} />;
  if (status === "failed") return <AlertCircle className="status-icon failed" size={16} />;
  return <Clock3 className="status-icon processing" size={16} />;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
