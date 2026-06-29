import type { EditorState } from "@/app/components/ShortcutEditor";
import type {
  Clip as BackendClip,
  PplAnalysis,
  StudioProject,
  StudioScheduleItem,
  YouTubeChannel,
} from "@/lib/api";
import {
  fmtDateDots,
  fmtDur,
  isRecord,
  jobStatusKo,
  parseSchedDate,
  publishStateKo,
  relDays,
  resolveMedia,
  youtubeId,
} from "./format";
import { CHANNEL_COLORS } from "./theme";

/* ============================================================================
 * Shared view-model types + backend→UI mappers, extracted from app/page.tsx.
 * ========================================================================== */

export type TitleOption = { id: string; text: string; overlay: string; note: string };
export type ThumbTextOption = { id: string; text: string; note: string };

export type Clip = {
  id: string;
  jobId?: string;
  rank: number;
  score: number;
  start: string;
  end: string;
  durSec: number;
  startSec: number;
  endSec: number;
  caption: string;
  title: string;
  reason: string;
  transcript?: string;
  labels: string[];
  yt: { title: string; tags: string[] };
  description: string;
  publishTags: string[];
  category?: string;
  madeForKids?: boolean;
  uploadNote?: string;
  thumbnailText?: string | null;
  titleOptions: TitleOption[];
  thumbTextOptions: ThumbTextOption[];
  editStatus?: string | null;
  videoUrl?: string;
  thumbnailUrl?: string;
  sourceThumbnailUrl?: string;
  packageUrl?: string | null;
  pplAnalysis?: PplAnalysis | null;
  initialEditorState?: Partial<EditorState>;
};

export type ProjectCard = {
  id: string;
  title: string;
  date: string;
  dur: string;
  posterIdx: number;
  status: string;
  source: string;
  ytId: string | null;
  thumb?: string | null;
  sourceUrl?: string | null;
  originalVideoUrl?: string | null;
  shorts: { clipId: string; state: string }[];
};

export type SchedItem = {
  publishId: string;
  clipId: string;
  day: number;
  month: number;
  year: number;
  time: string;
  title: string;
  status: string;
  rawStatus: string;
  scheduleStamp?: string | null;
  thumb?: string | null;
};

export type PickerClip = {
  clipId: string;
  jobId: string;
  title: string;
  thumb?: string | null;
  score: number;
  status: string;
  project: string;
};

export type CommentItem = { author: string; text: string; likes: number; time: string };

export type ChannelVideo = {
  id: string;
  title: string;
  date: string;
  views: string;
  likes: string;
  comments: string;
  posterIdx: number;
  url?: string;
  thumbnailUrl?: string | null;
};

export type ChannelCard = {
  id: string;
  channelId: string;
  name: string;
  handle: string;
  description: string;
  styleNote: string;
  thumbnailUrl?: string | null;
  connectedAt?: string | null;
  subs: string;
  views: string;
  color: string;
  up: string;
  videos: ChannelVideo[];
  loaded: boolean;
  isDefault: boolean;
};

export type Privacy = "public" | "unlisted" | "private";
export const PRIVACY_LABELS: Record<Privacy, string> = {
  public: "공개",
  unlisted: "일부 공개",
  private: "비공개",
};

const fallbackTitleOptions = (clip: BackendClip): TitleOption[] => {
  const caption = clip.thumbnail_text || clip.transcript?.slice(0, 18) || clip.title;
  return [
    {
      id: `${clip.clip_id}-title`,
      text: clip.youtube_metadata?.youtube_title || clip.title,
      overlay: caption,
      note: clip.reason || "AI가 추천한 쇼츠 제목입니다.",
    },
  ];
};

export const mapBackendClip = (clip: BackendClip): Clip => {
  const options = clip.title_options?.length
    ? clip.title_options.map((option, index) => ({
        id: option.id || `${clip.clip_id}-${index}`,
        text: option.title,
        overlay: option.overlay_text || clip.thumbnail_text || clip.title,
        note: option.reason || option.style,
      }))
    : fallbackTitleOptions(clip);
  const labels = clip.korean_shorts_signals?.labels?.length
    ? clip.korean_shorts_signals.labels.slice(0, 4)
    : clip.youtube_metadata?.labels?.slice(0, 4) || ["AI선별"];
  const thumbTextOptions = (clip.thumbnail_text_options || [])
    .map((option, index) => ({
      id: option.id || `${clip.clip_id}-thumb-${index}`,
      text: option.text,
      note: option.reason || option.style || "",
    }))
    .filter((option) => option.text);
  const savedEditorState = isRecord(clip.creative_settings?.editor_state)
    ? (clip.creative_settings.editor_state as Partial<EditorState>)
    : undefined;

  return {
    id: clip.clip_id,
    jobId: clip.job_id,
    rank: clip.rank,
    score: Math.round(clip.score),
    start: clip.start_time,
    end: clip.end_time,
    startSec: clip.start_seconds,
    endSec: clip.end_seconds,
    durSec: Math.max(1, Math.round(clip.duration_seconds)),
    caption: clip.thumbnail_text || clip.transcript?.slice(0, 32) || clip.title,
    title: clip.title,
    transcript: clip.transcript,
    reason: clip.clip_briefing?.why_it_works || clip.reason,
    labels,
    yt: {
      title: clip.youtube_metadata?.youtube_title || clip.title,
      tags: clip.youtube_metadata?.hashtags?.length
        ? clip.youtube_metadata.hashtags
        : clip.youtube_metadata?.tags || [],
    },
    description: clip.youtube_metadata?.description || "",
    publishTags: clip.youtube_metadata?.tags?.length
      ? clip.youtube_metadata.tags
      : clip.youtube_metadata?.hashtags || [],
    category: clip.youtube_metadata?.category,
    madeForKids: clip.youtube_metadata?.made_for_kids,
    uploadNote: clip.youtube_metadata?.upload_note,
    thumbnailText: clip.youtube_metadata?.thumbnail_text || clip.thumbnail_text,
    titleOptions: options,
    thumbTextOptions,
    editStatus: clip.edit_status ?? null,
    videoUrl: resolveMedia(clip.video_url),
    thumbnailUrl: resolveMedia(clip.thumbnail_url),
    sourceThumbnailUrl: resolveMedia(clip.source_thumbnail_url),
    packageUrl: resolveMedia(clip.youtube_package_url),
    pplAnalysis: clip.ppl_analysis ?? null,
    initialEditorState: savedEditorState,
  };
};

export const mapStudioProject = (p: StudioProject, idx: number): ProjectCard => {
  const ytId = youtubeId(p.source_url);
  const firstClipThumb = (p.clips || []).map((c) => c.thumbnail_url).find(Boolean);
  // Prefer the YouTube source thumbnail (the "original video photo"); fall back
  // to a generated clip frame for uploads.
  const thumb = ytId
    ? `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`
    : firstClipThumb
    ? resolveMedia(firstClipThumb) ?? null
    : null;
  return {
    id: p.job_id,
    title: p.original_filename || p.title || "프로젝트",
    date: fmtDateDots(p.created_at),
    dur: fmtDur(p.duration),
    posterIdx: idx,
    status: jobStatusKo(p.status),
    source: p.source || "upload",
    ytId,
    thumb,
    sourceUrl: p.source_url,
    originalVideoUrl: resolveMedia(p.original_video_url),
    shorts: (p.clips || []).map((c) => ({ clipId: c.clip_id, state: publishStateKo(c.status) })),
  };
};

export const mapScheduleItem = (s: StudioScheduleItem): SchedItem | null => {
  if (s.status === "cancelled") return null;
  const d = parseSchedDate(s.schedule_date, s.updated_at || s.created_at);
  if (!d) return null;
  return {
    publishId: s.publish_id,
    clipId: s.clip_id,
    day: d.getDate(),
    month: d.getMonth(),
    year: d.getFullYear(),
    time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
    title: s.title,
    status: publishStateKo(s.status),
    rawStatus: s.status,
    scheduleStamp: s.schedule_date,
    thumb: s.thumbnail_url,
  };
};

export const mapChannel = (ch: YouTubeChannel, idx: number): ChannelCard => ({
  id: ch.id,
  channelId: ch.channel_id,
  name: ch.title,
  handle: ch.google_account_email ? "@" + ch.google_account_email.split("@")[0] : ch.channel_id,
  description: (ch.description || "").trim(),
  styleNote: (ch.style_note || "").trim(),
  thumbnailUrl: ch.thumbnail_url,
  connectedAt: ch.connected_at,
  subs: "—",
  views: "—",
  color: CHANNEL_COLORS[idx % CHANNEL_COLORS.length],
  up: "",
  videos: [],
  loaded: false,
  isDefault: ch.is_default,
});
