"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ShortcutEditor, type EditorState, type ShortcutEditorDraft } from "./components/ShortcutEditor";
import {
  analyzePpl,
  API_BASE_URL,
  applyCreative,
  autoDistribute,
  cancelPublish,
  cancelYouTubeChannelDraft,
  clipDownloadUrl,
  confirmManyYouTubeChannelDraft,
  deleteJob,
  disconnectChannel,
  getChannelAnalytics,
  getChannelInsights,
  getJob,
  getPublishStatus,
  getResults,
  getStudioSummary,
  reschedulePublish,
  getVideoComments,
  getYouTubeChannelDraft,
  getYouTubeStatus,
  importFromYouTube,
  inspectVideo,
  mediaUrl,
  publishToYouTube,
  regenerateThumbnailTexts,
  regenerateTitles,
  renderHighlight,
  retrimClip,
  savePplLinks,
  setDefaultChannel,
  updateChannelStyleNote,
  uploadVideo,
  youtubeConnectUrl,
  type Clip as BackendClip,
  type StudioProject,
  type StudioScheduleItem,
  type SubtitleMode,
  type VideoInspection,
  type ChannelInsights,
  type HighlightRenderResponse,
  type PplAnalysis,
  type YouTubeChannel,
  type YouTubeChannelDraft,
  type YouTubePublish,
} from "@/lib/api";

/* ----------------------------- DATA ----------------------------- */

const ACCENT = "#FF4A1C";

const POSTERS = [
  { g: "linear-gradient(160deg,#FF8A4C 0%,#3A1D10 80%)", glow: "rgba(255,138,76,.55)" },
  { g: "linear-gradient(160deg,#6C5CE7 0%,#15102A 80%)", glow: "rgba(108,92,231,.55)" },
  { g: "linear-gradient(160deg,#15A088 0%,#0B1C19 80%)", glow: "rgba(21,160,136,.5)" },
  { g: "linear-gradient(160deg,#E84A5F 0%,#1E0C11 80%)", glow: "rgba(232,74,95,.5)" },
  { g: "linear-gradient(160deg,#3C77C2 0%,#0C1521 80%)", glow: "rgba(60,119,194,.5)" },
  { g: "linear-gradient(160deg,#D69E2E 0%,#1B140A 80%)", glow: "rgba(214,158,46,.5)" },
  { g: "linear-gradient(160deg,#B24FA0 0%,#180D1A 80%)", glow: "rgba(178,79,160,.5)" },
  { g: "linear-gradient(160deg,#E0673B 0%,#1A0D07 80%)", glow: "rgba(224,103,59,.5)" },
];

type TitleOption = { id: string; text: string; overlay: string; note: string };
type ThumbTextOption = { id: string; text: string; note: string };
type Clip = {
  id: string; rank: number; score: number; start: string; end: string; durSec: number;
  startSec: number; endSec: number;
  caption: string; title: string; reason: string; transcript?: string; labels: string[];
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

const SAMPLE_CLIPS: Clip[] = [
  {
    id: "sample-clip-1",
    rank: 1,
    score: 94,
    start: "02:14",
    end: "02:58",
    durSec: 44,
    startSec: 134,
    endSec: 178,
    caption: "이 장면 진짜 댓글 터집니다",
    title: "대화 흐름이 한 번에 뒤집히는 순간",
    reason: "첫 3초에 반전 포인트가 바로 나오고, 뒤이어 감정 리액션이 이어져 쇼츠 훅으로 쓰기 좋습니다.",
    labels: ["반전", "리액션", "댓글유도"],
    yt: { title: "이 장면 진짜 댓글 터집니다 #하이라이트", tags: ["쇼츠", "하이라이트", "반전"] },
    description: "긴 영상에서 바로 잘라 쓰기 좋은 하이라이트 샘플입니다.",
    publishTags: ["쇼츠", "하이라이트", "반전"],
    titleOptions: [
      { id: "sample-clip-1-t1", text: "대화 흐름이 한 번에 뒤집히는 순간", overlay: "이 장면 진짜 댓글 터집니다", note: "반전 포인트를 바로 노출합니다." },
      { id: "sample-clip-1-t2", text: "방금 표정 보고 다시 돌려봤습니다", overlay: "표정이 다 했네", note: "리액션 중심 훅입니다." },
    ],
    thumbTextOptions: [
      { id: "sample-clip-1-th1", text: "댓글 터짐", note: "참여 유도형 문구" },
      { id: "sample-clip-1-th2", text: "표정 주목", note: "장면 집중형 문구" },
    ],
  },
  {
    id: "sample-clip-2",
    rank: 2,
    score: 89,
    start: "06:02",
    end: "06:39",
    durSec: 37,
    startSec: 362,
    endSec: 399,
    caption: "여기서 분위기가 완전히 바뀜",
    title: "갑자기 모두가 조용해진 이유",
    reason: "장면 전환과 대사 밀도가 좋아 중간 이탈을 줄이기 쉬운 구간입니다.",
    labels: ["몰입", "전환", "대사"],
    yt: { title: "갑자기 모두가 조용해진 이유", tags: ["몰입", "토크", "쇼츠"] },
    description: "샘플 클립 설명입니다.",
    publishTags: ["몰입", "토크", "쇼츠"],
    titleOptions: [
      { id: "sample-clip-2-t1", text: "갑자기 모두가 조용해진 이유", overlay: "분위기 급반전", note: "긴장감을 앞에 배치합니다." },
    ],
    thumbTextOptions: [
      { id: "sample-clip-2-th1", text: "급반전", note: "전환 강조" },
    ],
  },
  {
    id: "sample-clip-3",
    rank: 3,
    score: 84,
    start: "11:20",
    end: "12:01",
    durSec: 41,
    startSec: 680,
    endSec: 721,
    caption: "짧게 잘라도 맥락이 살아있어요",
    title: "긴 영상에서 바로 쇼츠 되는 구간",
    reason: "앞뒤 설명 없이도 이해되는 독립 장면이라 바로 편집 테스트에 쓰기 좋습니다.",
    labels: ["요약", "독립장면", "입문"],
    yt: { title: "긴 영상에서 바로 쇼츠 되는 구간", tags: ["편집", "쇼츠", "요약"] },
    description: "샘플 클립 설명입니다.",
    publishTags: ["편집", "쇼츠", "요약"],
    titleOptions: [
      { id: "sample-clip-3-t1", text: "긴 영상에서 바로 쇼츠 되는 구간", overlay: "바로 써도 됨", note: "편집 완성도를 강조합니다." },
    ],
    thumbTextOptions: [
      { id: "sample-clip-3-th1", text: "바로 써도 됨", note: "완성형 문구" },
    ],
  },
];

type Privacy = "public" | "unlisted" | "private";
const PRIVACY_LABELS: Record<Privacy, string> = { public: "공개", unlisted: "일부 공개", private: "비공개" };

type PublishDraft = {
  clipId: string;
  mode: "now" | "schedule";
  channelDbId: string;
  title: string;
  description: string;
  tags: string;
  privacy: Privacy;
  scheduleLocal: string;
};

type HighlightDraft = {
  title: string;
  clipIds: string[];
  aspect: "landscape" | "vertical" | "square";
  maxDurationSeconds: number;
  result?: HighlightRenderResponse | null;
};

const PUBLISH_STATUS_META: Record<string, { label: string; color: string; bg: string; bd: string }> = {
  pending: { label: "발행 대기 중", color: "#8C6A1E", bg: "#FBF3E3", bd: "#EFD9A8" },
  uploading: { label: "업로드 중", color: "#A04A2E", bg: "#FFF4EF", bd: "#F0D9CE" },
  published: { label: "발행 완료", color: "#1F8A5B", bg: "#E7F5EE", bd: "#BFE6D2" },
  scheduled: { label: "예약 완료", color: "#3C77C2", bg: "#EAF1FB", bd: "#CFE0F5" },
  failed: { label: "발행 실패", color: "#C0392B", bg: "#FDECEA", bd: "#F5C9C2" },
};

const PUB_INPUT: CSSProperties = { width: "100%", padding: "10px 12px", border: "1px solid #E1D8C6", borderRadius: 10, background: "#fff", fontSize: 13.5, color: "#16120D", fontFamily: "inherit", outline: "none" };
const PUB_LABEL: CSSProperties = { display: "block", fontSize: 11, fontWeight: 700, letterSpacing: ".04em", color: "#A0957F", textTransform: "uppercase", marginBottom: 7 };
const NUDGE_BTN: CSSProperties = { width: 30, height: 36, flex: "0 0 auto", border: "1px solid #E1D8C6", borderRadius: 9, background: "#fff", color: "#5B5346", fontSize: 17, fontWeight: 700, cursor: "pointer", lineHeight: 1 };
const TRIM_INPUT: CSSProperties = { width: "100%", minWidth: 0, textAlign: "center", padding: "8px 4px", border: "1px solid #E1D8C6", borderRadius: 9, fontSize: 13.5, fontWeight: 700, color: "#16120D", fontFamily: "'Space Mono',monospace", outline: "none" };

const parseTagInput = (raw: string): string[] =>
  raw.split(/[,\n]/).map(t => t.trim().replace(/^#/, "")).filter(Boolean).slice(0, 30);

const toScheduleStamp = (local: string): string => {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}00` : "";
};

const defaultScheduleLocal = (): string => {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const defaultDateLocal = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const STAGE_DEFS = [
  { name:"음성 전사", desc:"OpenAI STT로 전체 자막을 추출해요" },
  { name:"하이라이트 후보 추출", desc:"자막에서 터질 구간 20~30개를 골라요" },
  { name:"AI 장면 평가", desc:"Gemini가 상위 후보의 대표 프레임만 채점해요" },
  { name:"세로 쇼츠 렌더", desc:"9:16 캔버스에 자막·제목을 입혀 렌더해요" },
];

const TEMPLATES = [
  { id:"clean", label:"클린 자막", badge:"미니멀 흰 자막" },
  { id:"pop", label:"팝 하이라이트", badge:"형광 하이라이트 강조" },
  { id:"news", label:"뉴스 바", badge:"하단 띠 자막" },
  { id:"badge", label:"코너 배지", badge:"우상단 로고 배지" },
];

const POSITIONS = [
  { id:"top_center", label:"상단 중앙" },
  { id:"top_left", label:"좌상단" },
  { id:"top_right", label:"우상단" },
  { id:"bottom_left", label:"좌하단" },
  { id:"bottom_right", label:"우하단" },
];

type NavKey = "home" | "projects" | "schedule" | "analytics" | "autopublish";
const NAV: { key: NavKey; label: string; short: string }[] = [
  { key:"home", label:"홈", short:"홈" },
  { key:"projects", label:"프로젝트", short:"프로젝트" },
  { key:"schedule", label:"예약 발행", short:"예약" },
  { key:"analytics", label:"채널", short:"채널" },
  { key:"autopublish", label:"자동 배포", short:"자동배포" },
];

/* ----------------------------- SVG HELPERS ----------------------------- */

const Icon = ({ d, size = 18, stroke = "currentColor", strokeWidth = 1.8, fill = "none", style }: { d: string | string[]; size?: number; stroke?: string; strokeWidth?: number; fill?: string; style?: CSSProperties }) => {
  const paths = Array.isArray(d) ? d : [d];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={style}>
      {paths.map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
};

const navIconDefs: Record<NavKey, string[]> = {
  home: ["M3 10.5 12 3l9 7.5", "M5 9.5V20h14V9.5"],
  projects: ["M3 4h18v14H3z", "M3 9h18", "M9 18v3", "M15 18v3"],
  schedule: ["M3 4.5h18v16H3z", "M3 9h18", "M8 2.5v4", "M16 2.5v4"],
  analytics: ["M4 20V10", "M10 20V4", "M16 20v-7", "M22 20H2"],
  autopublish: ["M21 8a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2Z", "m10 9 5 3-5 3V9Z"],
};

const resolveMedia = (path?: string | null) => path ? mediaUrl(path) : undefined;

const formatDuration = (seconds?: number | null) => {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "";
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
};

const stageFromProgress = (progress: number) => {
  if (progress < 26) return 0;
  if (progress < 54) return 1;
  if (progress < 82) return 2;
  return 3;
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "알 수 없는 오류가 발생했어요";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// Extract the 11-char YouTube video id from watch / youtu.be / shorts / embed URLs.
const youtubeId = (url?: string | null): string | null => {
  if (!url) return null;
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /\/shorts\/([a-zA-Z0-9_-]{11})/,
    /\/embed\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
};

const fallbackTitleOptions = (clip: BackendClip): TitleOption[] => {
  const caption = clip.thumbnail_text || clip.transcript?.slice(0, 18) || clip.title;
  return [
    { id: `${clip.clip_id}-title`, text: clip.youtube_metadata?.youtube_title || clip.title, overlay: caption, note: clip.reason || "AI가 추천한 쇼츠 제목입니다." },
  ];
};

const mapBackendClip = (clip: BackendClip): Clip => {
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
    .filter(option => option.text);
  const savedEditorState = isRecord(clip.creative_settings?.editor_state)
    ? (clip.creative_settings.editor_state as Partial<EditorState>)
    : undefined;

  return {
    id: clip.clip_id,
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
      tags: clip.youtube_metadata?.hashtags?.length ? clip.youtube_metadata.hashtags : clip.youtube_metadata?.tags || [],
    },
    description: clip.youtube_metadata?.description || "",
    publishTags: clip.youtube_metadata?.tags?.length ? clip.youtube_metadata.tags : clip.youtube_metadata?.hashtags || [],
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

/* ----------------------------- LIVE DATA TYPES + TRANSFORMS ----------------------------- */

type ProjectCard = { id: string; title: string; date: string; dur: string; posterIdx: number; status: string; source: string; ytId: string | null; sourceUrl?: string | null; originalVideoUrl?: string | null; shorts: { clipId: string; state: string }[] };
type SchedItem = { publishId: string; clipId: string; day: number; month: number; year: number; time: string; title: string; status: string; rawStatus: string; scheduleStamp?: string | null; thumb?: string | null };
type PickerClip = { clipId: string; jobId: string; title: string; thumb?: string | null; score: number; status: string; project: string };
type CommentItem = { author: string; text: string; likes: number; time: string };
type ChannelVideo = { id: string; title: string; date: string; views: string; likes: string; comments: string; posterIdx: number; url?: string; thumbnailUrl?: string | null };
type ChannelCard = {
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

const CHANNEL_COLORS = ["#FF4A1C", "#6C5CE7", "#1F8A5B", "#E0A21F", "#3C77C2", "#B24FA0", "#E0673B", "#15A088"];

const fmtCount = (n: number): string => {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1e8) return (n / 1e8).toFixed(n % 1e8 === 0 ? 0 : 1) + "억";
  if (n >= 1e4) return (n / 1e4).toFixed(n % 1e4 === 0 ? 0 : 1) + "만";
  return n.toLocaleString("ko-KR");
};

const fmtDateDots = (iso?: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
};

const relDays = (iso?: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (diff <= 0) return "오늘";
  if (diff === 1) return "어제";
  if (diff < 7) return `${diff}일 전`;
  if (diff < 30) return `${Math.floor(diff / 7)}주 전`;
  if (diff < 365) return `${Math.floor(diff / 30)}개월 전`;
  return `${Math.floor(diff / 365)}년 전`;
};

const fmtDur = (sec?: number | null): string => {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return `${m}:${String(ss).padStart(2, "0")}`;
};

const publishStateKo = (status?: string | null): string =>
  status === "published" ? "발행"
  : status === "scheduled" ? "예약"
  : status === "uploading" || status === "pending" ? "처리중"
  : status === "failed" ? "실패"
  : status === "cancelled" ? "취소"
  : "초안";

const jobStatusKo = (status?: string | null): string =>
  status === "completed" ? "완료"
  : status === "processing" ? "처리중"
  : status === "failed" ? "실패"
  : "대기";

const parseSchedDate = (raw?: string | null, fallbackIso?: string | null): Date | null => {
  if (raw && /^\d{14}$/.test(raw)) {
    return new Date(+raw.slice(0, 4), +raw.slice(4, 6) - 1, +raw.slice(6, 8), +raw.slice(8, 10), +raw.slice(10, 12), +raw.slice(12, 14));
  }
  const src = raw || fallbackIso;
  if (!src) return null;
  const d = new Date(src);
  return Number.isNaN(d.getTime()) ? null : d;
};

const fmtStamp = (raw?: string | null): string => {
  const d = parseSchedDate(raw);
  if (!d) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const mapStudioProject = (p: StudioProject, idx: number): ProjectCard => ({
  id: p.job_id,
  title: p.original_filename || p.title || "프로젝트",
  date: fmtDateDots(p.created_at),
  dur: fmtDur(p.duration),
  posterIdx: idx,
  status: jobStatusKo(p.status),
  source: p.source || "upload",
  ytId: youtubeId(p.source_url),
  sourceUrl: p.source_url,
  originalVideoUrl: resolveMedia(p.original_video_url),
  shorts: (p.clips || []).map(c => ({ clipId: c.clip_id, state: publishStateKo(c.status) })),
});

const mapScheduleItem = (s: StudioScheduleItem): SchedItem | null => {
  if (s.status === "cancelled") return null;
  const d = parseSchedDate(s.schedule_date, s.updated_at || s.created_at);
  if (!d) return null;
  return {
    publishId: s.publish_id,
    clipId: s.clip_id,
    day: d.getDate(), month: d.getMonth(), year: d.getFullYear(),
    time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
    title: s.title,
    status: publishStateKo(s.status),
    rawStatus: s.status,
    scheduleStamp: s.schedule_date,
    thumb: s.thumbnail_url,
  };
};

const mapChannel = (ch: YouTubeChannel, idx: number): ChannelCard => ({
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

/* ----------------------------- PPL OVERLAY PLAYER ----------------------------- */

const PPL_BOX_COLORS = ["#FF4A1C", "#27E0A0", "#5B8CFF", "#FFD400", "#FF49DB", "#15A088"];

// 9:16 player that draws brand/product bounding boxes synced to playback.
// Boxes are normalized 0..1 of the rendered frame, so a 9:16 box maps them directly.
function PplOverlayPlayer({ analysis, videoUrl, poster }: { analysis: PplAnalysis; videoUrl?: string; poster?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(0);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return undefined;
    const onTime = () => setT(v.currentTime);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("seeked", onTime);
    return () => { v.removeEventListener("timeupdate", onTime); v.removeEventListener("seeked", onTime); };
  }, []);
  const colorFor = (id: string) => {
    const idx = analysis.products.findIndex(p => p.id === id);
    return PPL_BOX_COLORS[(idx < 0 ? 0 : idx) % PPL_BOX_COLORS.length];
  };
  const detections = useMemo(() => {
    if (!analysis.frames.length) return [];
    let best = analysis.frames[0];
    for (const f of analysis.frames) {
      if (Math.abs(f.timestamp - t) < Math.abs(best.timestamp - t)) best = f;
    }
    return best.detections;
  }, [analysis, t]);
  return (
    <div style={{ position: "relative", width: "100%", maxWidth: 300, margin: "0 auto", aspectRatio: "9 / 16", borderRadius: 12, overflow: "hidden", background: "#000", boxShadow: "0 10px 30px -16px rgba(0,0,0,.6)" }}>
      {videoUrl ? (
        <video ref={videoRef} src={videoUrl} controls playsInline preload="metadata" poster={poster} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", background: "#050505" }} />
      ) : poster ? (
        <div style={{ position: "absolute", inset: 0, backgroundImage: `url(${poster})`, backgroundSize: "cover", backgroundPosition: "center" }} />
      ) : null}
      {detections.map((d, i) => {
        const color = colorFor(d.product_id);
        return (
          <div key={`${d.product_id}-${i}`} style={{ position: "absolute", left: `${d.box[0] * 100}%`, top: `${d.box[1] * 100}%`, width: `${d.box[2] * 100}%`, height: `${d.box[3] * 100}%`, border: `2px solid ${color}`, borderRadius: 5, boxShadow: "0 0 0 1px rgba(0,0,0,.45)", pointerEvents: "none", transition: "all .12s linear" }}>
            <span style={{ position: "absolute", left: -2, top: d.box[1] < 0.08 ? "100%" : -19, whiteSpace: "nowrap", fontSize: 10, fontWeight: 800, color: "#fff", background: color, padding: "1px 5px", borderRadius: 4, boxShadow: "0 2px 6px rgba(0,0,0,.4)" }}>
              {d.brand} · {d.product}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ----------------------------- COMPONENT ----------------------------- */

export default function Home() {
  // nav / global
  const [nav, setNav] = useState<NavKey>("home");
  const [openProject, setOpenProject] = useState<string | null>(null);
  const [openChannel, setOpenChannel] = useState<string | null>(null);
  const [openVideo, setOpenVideo] = useState<string | null>(null);
  const [schedMonth, setSchedMonth] = useState(0);

  // home flow
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
  const [projects, setProjects] = useState<ProjectCard[]>([]);
  const [sched, setSched] = useState<SchedItem[]>([]);
  const [channels, setChannels] = useState<ChannelCard[]>([]);
  const [videoComments, setVideoComments] = useState<Record<string, CommentItem[]>>({});
  const [studioLoaded, setStudioLoaded] = useState(false);
  const [channelDraftId, setChannelDraftId] = useState<string | null>(null);
  const [channelDraft, setChannelDraft] = useState<YouTubeChannelDraft | null>(null);
  const [selectedDraftChannelIds, setSelectedDraftChannelIds] = useState<string[]>([]);
  const [channelDraftLoading, setChannelDraftLoading] = useState(false);
  const [channelDraftSaving, setChannelDraftSaving] = useState(false);

  // results
  const [filter, setFilter] = useState<"top" | "all" | "short" | "custom">("top");
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [tab, setTab] = useState<"titles" | "overlay" | "youtube" | "ppl">("titles");

  // PPL (product placement) analysis — on-demand per clip
  const [pplData, setPplData] = useState<Record<string, PplAnalysis | null>>({});
  const [pplBusy, setPplBusy] = useState(false);
  const [pplLinkDraft, setPplLinkDraft] = useState<Record<string, string>>({});
  const [titleSeed, setTitleSeed] = useState(0);
  const [chosenTitle, setChosenTitle] = useState<Record<string, string>>({});
  const [revisions, setRevisions] = useState<Record<string, number>>({});
  const [template, setTemplate] = useState("clean");
  const [position, setPosition] = useState("top_center");
  const [hasOverlayAsset, setHasOverlayAsset] = useState(false);

  // publish flow
  const [publishDraft, setPublishDraft] = useState<PublishDraft | null>(null);
  const [publishDraftCache, setPublishDraftCache] = useState<Record<string, PublishDraft>>({});
  const [publishState, setPublishState] = useState<Record<string, YouTubePublish>>({});
  const [publishing, setPublishing] = useState(false);
  const [ytAuthed, setYtAuthed] = useState(false);
  const [defaultPrivacy, setDefaultPrivacy] = useState<Privacy>("private");
  const [channelBusy, setChannelBusy] = useState<string | null>(null);
  const publishPollers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // highlight render flow
  const [highlightDraft, setHighlightDraft] = useState<HighlightDraft | null>(null);
  const [highlightBusy, setHighlightBusy] = useState(false);

  // clip editor (titles / thumbnail text / re-cut / creative apply)
  const [chosenThumb, setChosenThumb] = useState<Record<string, string>>({});
  const [titleBusy, setTitleBusy] = useState(false);
  const [thumbBusy, setThumbBusy] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [retrimBusy, setRetrimBusy] = useState(false);
  const [trimDraft, setTrimDraft] = useState<{ clipId: string; start: number; end: number } | null>(null);
  const [editorClipId, setEditorClipId] = useState<string | null>(null);

  // candidate curation (session-local)
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [order, setOrder] = useState<string[]>([]);

  // channel style memo editor
  const [styleNoteDraft, setStyleNoteDraft] = useState<string | null>(null);
  const [styleNoteSaving, setStyleNoteSaving] = useState(false);

  // scheduling (calendar reschedule/cancel + auto-distribute)
  const [pickerClips, setPickerClips] = useState<PickerClip[]>([]);
  const [schedAction, setSchedAction] = useState<{ item: SchedItem; local: string } | null>(null);
  const [schedBusy, setSchedBusy] = useState(false);
  const [autoDist, setAutoDist] = useState<{ channelDbId: string; startDate: string; times: string; privacy: Privacy; selected: string[] } | null>(null);
  const [autoDistBusy, setAutoDistBusy] = useState(false);

  // channel insights (5순위)
  const [insights, setInsights] = useState<Record<string, ChannelInsights>>({});
  const [insightsBusy, setInsightsBusy] = useState<string | null>(null);

  // toast
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  };
  const sourcePreviewUrl = useMemo(() => selectedFile ? URL.createObjectURL(selectedFile) : null, [selectedFile]);

  // processing timer
  const procTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!sourcePreviewUrl) return undefined;
    return () => URL.revokeObjectURL(sourcePreviewUrl);
  }, [sourcePreviewUrl]);
  useEffect(() => () => {
    if (procTimer.current) clearInterval(procTimer.current);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    if (pollTimer.current) clearTimeout(pollTimer.current);
    Object.values(publishPollers.current).forEach(t => clearTimeout(t));
  }, []);

  /* ----- handlers ----- */
  const reset = () => {
    if (procTimer.current) clearInterval(procTimer.current);
    if (pollTimer.current) clearTimeout(pollTimer.current);
    setNav("home"); setView("empty"); setFileName(null); setProgress(0); setStageIndex(0);
    setSelectedFile(null); setYtPreviewId(null); setInspection(null); setInspecting(false); setBackendError(null); setBackendJobId(null); setBackendClips(null);
    setSelectedClipId(null); setEditorClipId(null); setOpenProject(null); setOpenChannel(null); setOpenVideo(null);
  };
  const switchNav = (k: NavKey) => {
    setNav(k); setOpenProject(null); setOpenChannel(null); setOpenVideo(null); setSelectedClipId(null); setEditorClipId(null);
  };
  const pickFile = (fileOrName?: File | string | null) => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    setProgress(0); setStageIndex(0); setBackendError(null); setBackendJobId(null); setBackendClips(null); setSelectedClipId(null);
    setYtPreviewId(null);
    if (fileOrName instanceof File) {
      setSelectedFile(fileOrName);
      setFileName(fileOrName.name || "업로드 영상.mp4");
      setInspection(null);
      setInspecting(true);
      inspectVideo(fileOrName)
        .then(info => {
          setInspection(info);
          if (info.has_subtitle_stream) showToast("내장 자막이 감지됐어요. 추가 자막 없이 진행할 수 있어요");
        })
        .catch(error => {
          setBackendError("영상 검사 실패: " + errorMessage(error));
          showToast("영상 검사에 실패했어요");
        })
        .finally(() => setInspecting(false));
      return;
    }
    setSelectedFile(null);
    setInspection(null);
    setInspecting(false);
    setFileName(fileOrName || "데모영상_토크쇼_풀버전.mp4");
  };
  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; pickFile(f || null);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); const f = e.dataTransfer.files?.[0]; setDragging(false); pickFile(f || "데모영상_토크쇼_풀버전.mp4");
  };
  const importYt = () => {
    const u = ytUrl.trim();
    if (!u) { showToast("유튜브 링크를 붙여넣어 주세요"); return; }
    const id = youtubeId(u);
    if (!id) { showToast("유효한 유튜브 링크가 아니에요. 영상 주소를 확인해 주세요"); return; }
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
        showToast(`쇼츠 후보 ${clips.length}개를 만들었어요`);
        return;
      }
      if (job.status === "failed") throw new Error(job.error || "작업이 실패했어요");
      pollTimer.current = setTimeout(() => { void pollJob(jobId); }, 1600);
    } catch (error) {
      setBackendError(errorMessage(error));
      setView(selectedFile ? "checking" : "empty");
      showToast("백엔드 작업을 확인하지 못했어요");
    }
  };
  const startBackendJob = async (subtitleMode: SubtitleMode) => {
    if (procTimer.current) clearInterval(procTimer.current);
    if (pollTimer.current) clearTimeout(pollTimer.current);
    setBackendError(null);
    setView("processing"); setProgress(1); setStageIndex(0);
    try {
      const response = selectedFile
        ? await uploadVideo(selectedFile, subtitleMode, "korean_pop")
        : await importFromYouTube(ytUrl.trim(), subtitleMode, "korean_pop");
      setBackendJobId(response.job_id);
      void pollJob(response.job_id);
    } catch (error) {
      setBackendError(errorMessage(error));
      setView(selectedFile ? "checking" : "empty");
      showToast("작업 시작에 실패했어요");
    }
  };
  const generate = () => {
    if (!fileName) return;
    if (selectedFile || ytUrl.trim()) { setView("checking"); return; }
    setView("checking");
  };
  const answerSubs = (hasExistingSubtitles: boolean) => {
    const mode: SubtitleMode = hasExistingSubtitles ? "off" : "on";
    if (selectedFile || ytUrl.trim()) { void startBackendJob(mode); return; }
    runProcessing();
  };
  const runProcessing = () => {
    setView("processing"); setProgress(0); setStageIndex(0);
    if (procTimer.current) clearInterval(procTimer.current);
    procTimer.current = setInterval(() => {
      setProgress(prev => {
        let p = prev + (Math.random() * 3.6 + 2.2);
        if (p >= 100) p = 100;
        const idx = p < 26 ? 0 : p < 54 ? 1 : p < 82 ? 2 : 3;
        setStageIndex(idx);
        if (p >= 100) {
          if (procTimer.current) clearInterval(procTimer.current);
          setTimeout(() => setView("results"), 700);
        }
        return p;
      });
    }, 230);
  };
  const copy = (text: string, label: string) => {
    try { navigator.clipboard.writeText(text); } catch {}
    showToast(label + "을(를) 복사했어요");
  };

  const cleanOAuthReturnUrl = () => {
    if (typeof window === "undefined") return "";
    const url = new URL(window.location.href);
    ["youtube", "draft", "login", "message", "connect_youtube"].forEach(key => url.searchParams.delete(key));
    return url.toString();
  };

  const connectYouTube = () => {
    if (typeof window === "undefined") return;
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- OAuth starts on the FastAPI host, outside Next routing.
    window.location.assign(youtubeConnectUrl(cleanOAuthReturnUrl() || window.location.href));
  };

  /* ----- derived ----- */
  const filtersList = ([["top","점수순"],["all","등장순"],["short","짧은순"],["custom","내 순서"]] as const).map(([k, l]) => ({
    key: k, label: l, on: filter === k,
  }));

  const loadStudio = async () => {
    try {
      const summary = await getStudioSummary();
      setProjects(summary.projects.map(mapStudioProject));
      setSched(summary.schedule.map(mapScheduleItem).filter((x): x is SchedItem => x !== null));
      setPickerClips(summary.projects.flatMap(p => (p.clips || []).map(c => ({
        clipId: c.clip_id, jobId: p.job_id, title: c.title, thumb: c.thumbnail_url, score: c.score, status: c.status, project: p.original_filename || p.title,
      }))));
    } catch {
      // backend may be unreachable; tabs render their empty states
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
      if (openChannel === channelDbId) { setOpenChannel(null); setOpenVideo(null); }
      await loadChannels();
      showToast("채널 연결을 해제했어요");
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setChannelBusy(null);
    }
  };

  const loadChannelDraft = async (draftId: string) => {
    setChannelDraftId(draftId);
    setChannelDraft(null);
    setSelectedDraftChannelIds([]);
    setChannelDraftLoading(true);
    try {
      const draft = await getYouTubeChannelDraft(draftId);
      setChannelDraft(draft);
      const unconnected = draft.channels.filter(ch => !ch.already_connected).map(ch => ch.channel_id);
      setSelectedDraftChannelIds(unconnected.length ? unconnected : draft.channels.slice(0, 1).map(ch => ch.channel_id));
    } catch (error) {
      setChannelDraftId(null);
      showToast(errorMessage(error));
    } finally {
      setChannelDraftLoading(false);
    }
  };

  const closeChannelDraft = async () => {
    const id = channelDraftId;
    setChannelDraftId(null);
    setChannelDraft(null);
    setSelectedDraftChannelIds([]);
    if (id) {
      try { await cancelYouTubeChannelDraft(id); } catch {}
    }
  };

  const confirmChannelDraft = async () => {
    if (!channelDraft || selectedDraftChannelIds.length === 0) return;
    const selected = channelDraft.channels.filter(ch => selectedDraftChannelIds.includes(ch.channel_id));
    setChannelDraftSaving(true);
    try {
      await confirmManyYouTubeChannelDraft(channelDraft.id, selectedDraftChannelIds);
      setChannelDraftId(null);
      setChannelDraft(null);
      setSelectedDraftChannelIds([]);
      await loadChannels();
      const allRefresh = selected.length > 0 && selected.every(ch => ch.already_connected);
      showToast(allRefresh ? `YouTube 채널 ${selected.length}개 연결을 갱신했어요` : `YouTube 채널 ${selected.length}개를 추가했어요`);
      setNav("analytics");
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setChannelDraftSaving(false);
    }
  };

  const toggleDraftChannel = (channelId: string) => {
    setSelectedDraftChannelIds(ids => ids.includes(channelId) ? ids.filter(id => id !== channelId) : [...ids, channelId]);
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadStudio();
      void loadChannels();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

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
        // If URL parsing fails, continue with the normal query handling.
      }
    }

    if (shouldClean) {
      ["youtube", "draft", "login", "message", "connect_youtube"].forEach(key => params.delete(key));
      window.history.replaceState(null, "", url.toString());
    }

    let action: (() => void) | null = null;
    if (youtube === "review" && draftId) {
      action = () => {
        setNav("analytics");
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
    if (login === "ok") {
      action = () => showToast("Google 로그인 완료");
    }
    if (!action) return;
    window.setTimeout(action, 0);
    return;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDeleteProject = async (e: React.MouseEvent, jobId: string) => {
    e.stopPropagation();
    if (!confirm("프로젝트를 삭제하면 영상과 쇼츠 클립이 모두 사라집니다. 계속할까요?")) return;
    try {
      await deleteJob(jobId);
      setProjects(prev => prev.filter(p => p.id !== jobId));
      if (openProject === jobId) setOpenProject(null);
      showToast("프로젝트를 삭제했어요");
    } catch {
      showToast("삭제에 실패했어요. 다시 시도해 주세요");
    }
  };

  const openProjectDetail = async (jobId: string) => {
    setOpenProject(jobId);
    setBackendClips(null);
    try {
      const results = await getResults(jobId);
      setBackendClips(results.clips.map(mapBackendClip));
    } catch {
      setBackendClips([]);
    }
  };
  const openChannelDetail = async (channelDbId: string) => {
    setOpenChannel(channelDbId);
    setOpenVideo(null);
    const existing = channels.find(c => c.id === channelDbId);
    if (existing?.loaded) { setOpenVideo(existing.videos[0]?.id || null); return; }
    try {
      const a = await getChannelAnalytics(channelDbId, { limit: 30, sort: "views" });
      const videos: ChannelVideo[] = a.videos.map((v, i) => ({
        id: v.video_id, title: v.title, date: relDays(v.published_at),
        views: fmtCount(v.view_count), likes: fmtCount(v.like_count), comments: fmtCount(v.comment_count),
        posterIdx: i, url: v.url, thumbnailUrl: v.thumbnail || (v.video_id ? `https://i.ytimg.com/vi/${v.video_id}/mqdefault.jpg` : null),
      }));
      setChannels(prev => prev.map(c => c.id === channelDbId ? {
        ...c,
        subs: a.totals.hidden_subscriber_count ? "비공개" : fmtCount(a.totals.subscriber_count),
        views: fmtCount(a.totals.channel_view_count),
        videos, loaded: true,
      } : c));
      setOpenVideo(videos[0]?.id || null);
    } catch {
      showToast("채널 분석을 불러오지 못했어요");
    }
  };
  useEffect(() => {
    if (!openChannel || !openVideo || videoComments[openVideo]) return;
    let cancelled = false;
    const vid = openVideo;
    getVideoComments(openChannel, vid, 20)
      .then(list => {
        if (cancelled) return;
        setVideoComments(prev => ({ ...prev, [vid]: list.map(c => ({ author: c.author, text: c.text, likes: c.likes, time: relDays(c.published_at) })) }));
      })
      .catch(() => { if (!cancelled) setVideoComments(prev => ({ ...prev, [vid]: [] })); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openChannel, openVideo]);

  const activeClips = useMemo(() => backendClips ?? (view === "results" ? SAMPLE_CLIPS : []), [backendClips, view]);

  const sortedClips = useMemo(() => {
    const list = activeClips.filter(c => !hidden.has(c.id));
    if (filter === "custom") {
      const base = activeClips.map(c => c.id);
      const known = order.filter(id => base.includes(id));
      const merged = [...known, ...base.filter(id => !known.includes(id))];
      const rank = (id: string) => merged.indexOf(id);
      list.sort((a, b) => rank(a.id) - rank(b.id));
    } else if (filter === "top") list.sort((a, b) => b.score - a.score);
    else if (filter === "short") list.sort((a, b) => a.durSec - b.durSec);
    else list.sort((a, b) => a.rank - b.rank);
    // pinned clips float to the top, keeping their relative order
    list.sort((a, b) => (pinned.has(b.id) ? 1 : 0) - (pinned.has(a.id) ? 1 : 0));
    return list;
  }, [activeClips, filter, hidden, pinned, order]);

  const hiddenCount = useMemo(() => activeClips.filter(c => hidden.has(c.id)).length, [activeClips, hidden]);

  const sel = activeClips.find(c => c.id === selectedClipId) || null;
  const editorClip = activeClips.find(c => c.id === editorClipId) || null;
  const selPoster = sel ? POSTERS[(sel.rank - 1) % POSTERS.length] : POSTERS[0];
  const titleBase = sel ? sel.titleOptions : [];
  const k = sel ? (titleBase.length ? titleSeed % titleBase.length : 0) : 0;
  const rotatedTitles = sel ? titleBase.slice(k).concat(titleBase.slice(0, k)) : [];
  const chosenTitleId = sel ? (chosenTitle[sel.id] || rotatedTitles[0]?.id) : null;
  const chosenOpt = rotatedTitles.find(o => o.id === chosenTitleId) || rotatedTitles[0];
  const chosenThumbText = sel ? chosenThumb[sel.id] : undefined;
  const overlayText = chosenThumbText || (chosenOpt ? chosenOpt.overlay : sel?.caption || "");

  const selPublish = sel ? publishState[sel.id] ?? null : null;
  const selPublishBusy = !!selPublish && (selPublish.status === "pending" || selPublish.status === "uploading");
  const defChannel = channels.find(c => c.isDefault) || channels[0] || null;
  const currentJobId = backendJobId || openProject || null;

  const openClipEditor = (clipId?: string) => {
    const id = clipId || selectedClipId || activeClips[0]?.id;
    if (!id) {
      showToast("편집할 클립을 먼저 선택하세요");
      return;
    }
    setEditorClipId(id);
  };

  const openHighlightDraft = () => {
    if (!activeClips.length) {
      showToast("하이라이트로 만들 클립이 없어요");
      return;
    }
    if (!currentJobId) {
      showToast("하이라이트 MP4 생성은 실제 분석된 프로젝트에서 사용할 수 있어요");
      return;
    }
    const preferred = sortedClips.filter(c => !hidden.has(c.id)).slice(0, 5);
    const initial = (preferred.length ? preferred : activeClips).slice(0, 5).map(c => c.id);
    setHighlightDraft({
      title: `${homeName.replace(/\.[^.]+$/, "")} 하이라이트`.slice(0, 80),
      clipIds: initial,
      aspect: "landscape",
      maxDurationSeconds: 720,
      result: null,
    });
  };

  const toggleHighlightClip = (clipId: string) => {
    setHighlightDraft(d => {
      if (!d) return d;
      const exists = d.clipIds.includes(clipId);
      return { ...d, result: null, clipIds: exists ? d.clipIds.filter(id => id !== clipId) : [...d.clipIds, clipId] };
    });
  };

  const doRenderHighlight = async () => {
    if (!highlightDraft || !currentJobId) return;
    if (!highlightDraft.title.trim()) { showToast("하이라이트 제목을 입력하세요"); return; }
    if (highlightDraft.clipIds.length === 0) { showToast("하이라이트에 넣을 클립을 선택하세요"); return; }
    setHighlightBusy(true);
    try {
      const res = await renderHighlight(currentJobId, {
        clip_ids: highlightDraft.clipIds,
        title: highlightDraft.title.trim(),
        aspect: highlightDraft.aspect,
        max_duration_seconds: highlightDraft.maxDurationSeconds,
      });
      setHighlightDraft(d => (d ? { ...d, result: res } : d));
      showToast("하이라이트 MP4를 만들었어요");
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setHighlightBusy(false);
    }
  };

  const schedulePublishPoll = (publishId: string, clipId: string) => {
    const tick = async () => {
      try {
        const p = await getPublishStatus(publishId);
        setPublishState(s => ({ ...s, [clipId]: p }));
        if (p.status === "pending" || p.status === "uploading") {
          publishPollers.current[clipId] = setTimeout(() => { void tick(); }, 2200);
        } else {
          delete publishPollers.current[clipId];
          if (p.status === "published") showToast("유튜브에 발행됐어요");
          else if (p.status === "scheduled") showToast("유튜브 예약 발행이 등록됐어요");
          else if (p.status === "failed") showToast("발행에 실패했어요" + (p.error ? `: ${p.error}` : ""));
          void loadStudio();
        }
      } catch {
        publishPollers.current[clipId] = setTimeout(() => { void tick(); }, 3500);
      }
    };
    void tick();
  };

  const openPublishDraft = (mode: "now" | "schedule") => {
    if (!sel) return;
    if (!ytAuthed) { showToast("먼저 Google로 로그인하고 채널을 연결하세요"); connectYouTube(); return; }
    if (channels.length === 0) {
      showToast("발행할 YouTube 채널을 먼저 연결하세요");
      setSelectedClipId(null);
      setNav("analytics");
      return;
    }
    const def = channels.find(c => c.isDefault) || channels[0];
    setPublishDraft({
      clipId: sel.id,
      mode,
      channelDbId: def.id,
      title: (chosenOpt?.text || sel.yt.title || sel.title).slice(0, 100),
      description: sel.description,
      tags: sel.publishTags.join(", "),
      privacy: defaultPrivacy,
      scheduleLocal: mode === "schedule" ? defaultScheduleLocal() : "",
    });
  };

  const doPublish = async () => {
    if (!publishDraft) return;
    const d = publishDraft;
    if (!d.title.trim()) { showToast("제목을 입력하세요"); return; }
    let scheduleDate: string | null = null;
    if (d.mode === "schedule") {
      const stamp = toScheduleStamp(d.scheduleLocal);
      if (!stamp) { showToast("예약 시간을 선택하세요"); return; }
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
        tags: parseTagInput(d.tags),
      });
      setPublishState(s => ({ ...s, [d.clipId]: res }));
      setPublishDraftCache(c => ({ ...c, [d.clipId]: d }));
      setPublishDraft(null);
      showToast(d.mode === "schedule" ? "유튜브 예약 발행을 등록했어요" : "유튜브 발행을 시작했어요");
      schedulePublishPoll(res.id, d.clipId);
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setPublishing(false);
    }
  };

  const replaceClip = (updated: BackendClip) => {
    const mapped = mapBackendClip(updated);
    setBackendClips(prev => (prev ? prev.map(c => (c.id === mapped.id ? mapped : c)) : prev));
  };

  const regenTitles = async () => {
    if (!sel) return;
    setTitleBusy(true);
    try {
      const res = await regenerateTitles(sel.id);
      const opts = res.options.map((o, i) => ({
        id: o.id || `${sel.id}-t${i}`,
        text: o.title,
        overlay: o.overlay_text || sel.caption,
        note: o.reason || o.style || "",
      }));
      if (opts.length) {
        setBackendClips(prev => (prev ? prev.map(c => (c.id === sel.id ? { ...c, titleOptions: opts } : c)) : prev));
        setTitleSeed(0);
        setChosenTitle(s => ({ ...s, [sel.id]: opts[0].id }));
      }
      showToast("AI 제목 5개를 새로 생성했어요");
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setTitleBusy(false);
    }
  };

  const runPpl = async () => {
    if (!sel) return;
    setPplBusy(true);
    try {
      const analysis = await analyzePpl(sel.id);
      setPplData(s => ({ ...s, [sel.id]: analysis }));
      const draft: Record<string, string> = {};
      (analysis?.products || []).forEach(p => { draft[`${sel.id}|${p.id}`] = p.affiliate_url || ""; });
      setPplLinkDraft(s => ({ ...s, ...draft }));
      showToast(analysis && analysis.products.length ? `PPL 분석 완료 · 상품 ${analysis.products.length}개` : "감지된 상품이 없어요");
    } catch (error) {
      showToast("PPL 분석 실패: " + errorMessage(error));
    } finally {
      setPplBusy(false);
    }
  };

  const savePpl = async () => {
    if (!sel) return;
    const current = pplData[sel.id] ?? sel.pplAnalysis;
    if (!current) return;
    const links: Record<string, string> = {};
    current.products.forEach(p => {
      const draft = pplLinkDraft[`${sel.id}|${p.id}`];
      if (draft !== undefined) links[p.id] = draft;
    });
    try {
      const updated = await savePplLinks(sel.id, links);
      setPplData(s => ({ ...s, [sel.id]: updated }));
      showToast("제휴 링크를 저장했어요");
    } catch (error) {
      showToast("저장 실패: " + errorMessage(error));
    }
  };

  const regenThumbs = async () => {
    if (!sel) return;
    setThumbBusy(true);
    try {
      const res = await regenerateThumbnailTexts(sel.id);
      const opts = res.options.map((o, i) => ({ id: o.id || `${sel.id}-th${i}`, text: o.text, note: o.reason || o.style || "" }));
      setBackendClips(prev => (prev ? prev.map(c => (c.id === sel.id ? { ...c, thumbTextOptions: opts } : c)) : prev));
      showToast("썸네일 문구 5개를 생성했어요");
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setThumbBusy(false);
    }
  };

  const doApplyCreative = async () => {
    if (!sel) return;
    setApplyBusy(true);
    try {
      const updated = await applyCreative(sel.id, {
        title: (chosenOpt?.text || sel.yt.title || sel.title).slice(0, 180),
        thumbnail_text: (overlayText || sel.caption || "").slice(0, 120),
        template_id: template,
        overlay_position: position,
        overlay_scale: 0.12,
      });
      replaceClip(updated);
      setRevisions(r => ({ ...r, [sel.id]: (r[sel.id] || 1) + 1 }));
      showToast("새 설정으로 세로 쇼츠를 다시 렌더했어요");
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setApplyBusy(false);
    }
  };

  const saveShortcutEditor = async (draft: ShortcutEditorDraft) => {
    const target = activeClips.find(c => c.id === editorClipId);
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
        metadata_overrides: {
          editor_state: draft.editorState,
          burn_overlays: draft.burnOverlays,
        },
      });
      replaceClip(updated);
      setRevisions(r => ({ ...r, [target.id]: (r[target.id] || 1) + 1 }));
      showToast("편집기 설정으로 다시 렌더했어요");
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setApplyBusy(false);
    }
  };

  const openTrim = () => {
    if (!sel) return;
    setTrimDraft({ clipId: sel.id, start: Math.max(0, Number(sel.startSec.toFixed(1))), end: Number(sel.endSec.toFixed(1)) });
  };

  const doRetrim = async () => {
    if (!sel || !trimDraft) return;
    if (trimDraft.end - trimDraft.start < 1) { showToast("클립은 최소 1초 이상이어야 해요"); return; }
    setRetrimBusy(true);
    try {
      const updated = await retrimClip(sel.id, { start_seconds: trimDraft.start, end_seconds: trimDraft.end });
      replaceClip(updated);
      setRevisions(r => ({ ...r, [sel.id]: (r[sel.id] || 1) + 1 }));
      setTrimDraft(null);
      showToast("새 구간으로 다시 잘랐어요");
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setRetrimBusy(false);
    }
  };

  const togglePin = (id: string) => setPinned(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const hideCandidate = (id: string) => {
    setHidden(prev => new Set(prev).add(id));
    if (selectedClipId === id) setSelectedClipId(null);
    showToast("후보를 목록에서 숨겼어요");
  };
  const restoreHidden = () => { setHidden(new Set()); showToast("숨긴 후보를 모두 복원했어요"); };
  const moveCandidate = (id: string, dir: -1 | 1) => {
    const base = sortedClips.map(c => c.id);
    const known = order.filter(x => base.includes(x));
    const merged = [...known, ...base.filter(x => !known.includes(x))];
    const i = merged.indexOf(id);
    const j = i + dir;
    if (i >= 0 && j >= 0 && j < merged.length) {
      [merged[i], merged[j]] = [merged[j], merged[i]];
      setOrder(merged);
    }
    if (filter !== "custom") setFilter("custom");
  };

  const loadInsights = async (channelDbId: string) => {
    setInsightsBusy(channelDbId);
    try {
      const data = await getChannelInsights(channelDbId);
      setInsights(prev => ({ ...prev, [channelDbId]: data }));
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setInsightsBusy(null);
    }
  };

  const saveStyleNote = async (channelDbId: string) => {
    if (styleNoteDraft === null) return;
    setStyleNoteSaving(true);
    try {
      const updated = await updateChannelStyleNote(channelDbId, styleNoteDraft);
      const note = (updated.style_note || "").trim();
      setChannels(prev => prev.map(c => (c.id === channelDbId ? { ...c, styleNote: note } : c)));
      setStyleNoteDraft(null);
      showToast("채널 스타일 메모를 저장했어요");
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setStyleNoteSaving(false);
    }
  };

  const openReschedule = (item: SchedItem) => {
    const d = parseSchedDate(item.scheduleStamp);
    let local = defaultScheduleLocal();
    if (d) {
      const pad = (n: number) => String(n).padStart(2, "0");
      local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    setSchedAction({ item, local });
  };

  const doReschedule = async () => {
    if (!schedAction) return;
    const stamp = toScheduleStamp(schedAction.local);
    if (!stamp) { showToast("예약 시간을 선택하세요"); return; }
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
    if (!ytAuthed || channels.length === 0) { showToast("먼저 Google 로그인 후 채널을 연결하세요"); setNav("analytics"); return; }
    if (pickerClips.length === 0) { showToast("먼저 쇼츠를 만들어 주세요"); return; }
    const def = channels.find(c => c.isDefault) || channels[0];
    setAutoDist({ channelDbId: def.id, startDate: defaultDateLocal(), times: "18:00", privacy: defaultPrivacy, selected: [] });
  };

  const toggleAutoClip = (clipId: string) => setAutoDist(d => {
    if (!d) return d;
    const has = d.selected.includes(clipId);
    return { ...d, selected: has ? d.selected.filter(x => x !== clipId) : [...d.selected, clipId] };
  });

  const doAutoDistribute = async () => {
    if (!autoDist) return;
    if (autoDist.selected.length === 0) { showToast("배포할 쇼츠를 선택하세요"); return; }
    const startDate = autoDist.startDate.replace(/-/g, "");
    if (!/^\d{8}$/.test(startDate)) { showToast("시작 날짜를 선택하세요"); return; }
    const times = autoDist.times.split(",").map(t => t.trim()).filter(t => /^\d{1,2}:\d{2}$/.test(t));
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

  const selProj = projects.find(p => p.id === openProject) || null;
  const selChan = channels.find(c => c.id === openChannel) || null;
  const selInsights = selChan ? insights[selChan.id] ?? null : null;
  const curVideo = selChan ? (selChan.videos.find(v => v.id === openVideo) || selChan.videos[0]) : null;
  const selectedDraftChannels = channelDraft ? channelDraft.channels.filter(ch => selectedDraftChannelIds.includes(ch.channel_id)) : [];
  const publishChannel = publishDraft ? channels.find(c => c.id === publishDraft.channelDbId) || null : null;
  const publishClip = publishDraft ? activeClips.find(c => c.id === publishDraft.clipId) || null : null;
  const publishPreviewTags = publishDraft ? parseTagInput(publishDraft.tags) : [];
  const publishScheduleStamp = publishDraft?.mode === "schedule" ? toScheduleStamp(publishDraft.scheduleLocal) : null;
  const highlightSelectedClips = highlightDraft ? highlightDraft.clipIds.map(id => activeClips.find(c => c.id === id)).filter((c): c is Clip => !!c) : [];
  const highlightTotalSeconds = highlightSelectedClips.reduce((sum, clip) => sum + clip.durSec, 0);
  const autoDistTimesCount = autoDist ? Math.max(1, autoDist.times.split(",").map(t => t.trim()).filter(t => /^\d{1,2}:\d{2}$/.test(t)).length) : 1;

  const isProjectList = nav === "projects" && !selProj;
  const isProjectDetail = nav === "projects" && !!selProj;
  const isChannelList = nav === "analytics" && !selChan;
  const isChannelDetail = nav === "analytics" && !!selChan;
  const isSchedule = nav === "schedule";
  const isAutopublish = nav === "autopublish";
  const isEmpty = nav === "home" && view === "empty";
  const isChecking = nav === "home" && view === "checking";
  const isProcessing = nav === "home" && view === "processing";
  const isResults = nav === "home" && view === "results";

  const homeName = fileName || (view === "results" ? "데모영상_토크쇼_풀버전.mp4" : "AI 쇼츠 워크스페이스");

  // schedule calendar
  const calNow = new Date();
  const Y = calNow.getFullYear(); const M = calNow.getMonth() + schedMonth;
  const base = new Date(Y, M, 1);
  const monthLabel = `${base.getFullYear()}년 ${base.getMonth() + 1}월`;
  const firstDow = base.getDay();
  const dim = new Date(Y, M + 1, 0).getDate();
  const prevDim = new Date(Y, M, 0).getDate();
  const today = (base.getMonth() === calNow.getMonth() && base.getFullYear() === calNow.getFullYear()) ? calNow.getDate() : -1;
  const schedByDay: Record<number, SchedItem[]> = {};
  sched.filter(it => it.year === base.getFullYear() && it.month === base.getMonth())
    .forEach(it => { (schedByDay[it.day] = schedByDay[it.day] || []).push(it); });
  type Cell = { num: number; cellBg: string; numColor: string; items: { time: string; title: string; bg: string; fg: string; bd: string; item?: SchedItem }[] };
  const cells: Cell[] = [];
  for (let i = 0; i < firstDow; i++) cells.push({ num: prevDim - firstDow + 1 + i, cellBg: "#FBF8F1", numColor: "#CBC0AC", items: [] });
  for (let d = 1; d <= dim; d++) {
    const items = (schedByDay[d] || []).map(it => {
      const pill = it.status === "발행" ? { bg: "#E7F5EE", fg: "#1F8A5B", bd: "#BFE6D2" } : { bg: "#16120D", fg: "#fff", bd: "#16120D" };
      return { time: it.time, title: it.title, ...pill, item: it };
    });
    const isToday = d === today;
    cells.push({ num: d, cellBg: isToday ? "#FFF4EF" : "#fff", numColor: isToday ? "#C83920" : "#16120D", items });
  }
  let nextNum = 1;
  while (cells.length % 7 !== 0) cells.push({ num: nextNum++, cellBg: "#FBF8F1", numColor: "#CBC0AC", items: [] });
  const weeks: Cell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  const weekDays = ["일", "월", "화", "수", "목", "금", "토"];
  const upcoming = sched.filter(it => it.status === "예약").slice(0, 6);
  const autoQueue = sched.filter(it => it.status === "예약");

  const stPill = (st: string) =>
    st === "발행" ? { bg: "#E7F5EE", fg: "#1F8A5B", bd: "#BFE6D2" }
    : st === "예약" ? { bg: "#FBF1EC", fg: "#C83920", bd: "#F0D9CE" }
    : { bg: "#F3EEE3", fg: "#8C8273", bd: "#EAE1D0" };

  const scoreColors = (score: number) => ({
    bg: score >= 95 ? ACCENT : score >= 90 ? "#E0A21F" : "rgba(255,255,255,.94)",
    fg: score >= 90 ? "#fff" : "#16120D",
  });

  const steps = [
    { n: 1, title: "영상 업로드", desc: "긴 MP4를 끌어다 놓기만 하면 끝", icon: ["M12 16V4", "M8 8l4-4 4 4", "M4 18v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1"] },
    { n: 2, title: "자막 분석", desc: "전체 음성을 텍스트로 전사", icon: ["M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z", "M5 11a7 7 0 0 0 14 0", "M12 18v3"] },
    { n: 3, title: "AI 컷 선별", desc: "터질 구간만 골라 점수화", icon: ["M5 7h14", "M5 12h9", "M5 17h5", "M19 14l-4 7", "M15 14l4 7"] },
    { n: 4, title: "쇼츠 완성", desc: "세로 영상 · 제목 · 태그까지", icon: ["M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z", "M12 18h.01"] },
  ];

  const upPoster = POSTERS[0];

  /* ----------------------------- RENDER ----------------------------- */
  return (
    <div style={{ minHeight: "100vh", display: "flex", background: "#EFE8DA", color: "#1B1712", fontFamily: "'Pretendard',system-ui,sans-serif", WebkitFontSmoothing: "antialiased" }}>
      <GlobalStyle />

      {/* LEFT RAIL */}
      <aside style={{ position: "sticky", top: 0, height: "100vh", width: 72, flex: "0 0 72px", background: "#16120D", display: "flex", flexDirection: "column", alignItems: "center", gap: 22, padding: "18px 0 16px", zIndex: 30 }}>
        <div style={{ width: 40, height: 40, borderRadius: 12, background: ACCENT, display: "grid", placeItems: "center", boxShadow: "0 8px 20px -6px rgba(255,74,28,.7)", cursor: "pointer" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M8 5.5v13l11-6.5-11-6.5Z" fill="#fff" /><rect x="4" y="5" width="2.4" height="14" rx="1.2" fill="#fff" /></svg>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, width: "100%" }}>
          {NAV.map(n => {
            const on = nav === n.key;
            return (
              <button key={n.key} onClick={() => switchNav(n.key)} title={n.label}
                className="sc-railbtn"
                style={{ position: "relative", width: 56, height: 50, border: 0, borderRadius: 13, background: on ? "#26201A" : "transparent", color: on ? "#fff" : "#8B8073", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, cursor: "pointer", transition: "all .14s" }}>
                <span style={{ display: "grid", placeItems: "center" }}><Icon d={navIconDefs[n.key]} /></span>
                <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: "-.03em", whiteSpace: "nowrap" }}>{n.short}</span>
              </button>
            );
          })}
        </div>
        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, width: "100%" }}>
          <button onClick={() => openClipEditor()} className="sc-railbtn" style={{ width: 46, height: 42, border: 0, borderRadius: 12, background: "transparent", color: "#FF4A1C", display: "grid", placeItems: "center", cursor: "pointer" }} title="편집">
            <Icon d={["M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7", "M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z"]} size={20} />
          </button>
          <button className="sc-railbtn" style={{ width: 46, height: 42, border: 0, borderRadius: 12, background: "transparent", color: "#E0B23A", display: "grid", placeItems: "center", cursor: "pointer" }} title="업그레이드">
            <Icon d={["m3 8 4.5 3L12 4l4.5 7L21 8l-1.6 10H4.6L3 8Z"]} size={20} />
          </button>
          <button className="sc-railbtn" style={{ width: 46, height: 42, border: 0, borderRadius: 12, background: "transparent", color: "#8B8073", display: "grid", placeItems: "center", cursor: "pointer" }} title="도움말">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M9.5 9.2a2.5 2.5 0 1 1 3.4 2.3c-.9.4-1.4 1-1.4 1.9v.4" /><circle cx="12" cy="17" r=".6" fill="currentColor" /></svg>
          </button>
          <div style={{ width: 34, height: 34, borderRadius: "50%", background: "#41372C", color: "#F4ECDD", display: "grid", placeItems: "center", fontSize: 13, fontWeight: 700, marginTop: 4, cursor: "pointer" }} title="내 계정">제</div>
        </div>
      </aside>

      {/* MAIN */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {/* TOP BAR */}
        <header style={{ height: 64, flex: "0 0 64px", display: "flex", alignItems: "center", gap: 18, padding: "0 26px", borderBottom: "1px solid #E1D8C6", background: "rgba(245,240,231,.72)", backdropFilter: "blur(10px)", position: "sticky", top: 0, zIndex: 20 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
            <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 19, letterSpacing: "-.02em", color: "#16120D" }}>STEP D</span>
            <span style={{ color: "#7A7060", fontSize: 14, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{homeName}</span>
          </div>
          <div style={{ flex: 1, maxWidth: 460, height: 40, display: "flex", alignItems: "center", gap: 9, padding: "0 13px", border: "1px solid #E1D8C6", borderRadius: 11, background: "#FBF7EF", color: "#9b9082", cursor: "text" }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" /></svg>
            <span style={{ flex: 1, fontSize: 13.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>키워드나 장면을 검색…</span>
            <kbd style={{ fontFamily: "'Space Mono',monospace", fontSize: 11, border: "1px solid #E1D8C6", borderRadius: 6, padding: "1px 6px", background: "#fff", color: "#9b9082" }}>⌘K</kbd>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14 }}>
            <button style={{ position: "relative", width: 38, height: 38, border: 0, background: "transparent", color: "#5B5346", display: "grid", placeItems: "center", cursor: "pointer", borderRadius: 10 }} title="알림">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>
              <span style={{ position: "absolute", top: 5, right: 5, width: 8, height: 8, borderRadius: "50%", background: ACCENT, border: "2px solid #F5F0E7" }} />
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: 7, height: 38, padding: "0 12px", borderRadius: 10, background: "#FBF3E3", border: "1px solid #EFD9A8", color: "#9A7B1E", fontSize: 13.5, fontWeight: 600, cursor: "pointer" }} title="남은 크레딧">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 13h6l-1 9 9-12h-6l1-8Z" /></svg>
              <span style={{ fontFamily: "'Space Grotesk',sans-serif" }}>373</span>
            </div>
            <button onClick={reset} style={{ height: 38, padding: "0 16px", border: 0, borderRadius: 11, background: "#16120D", color: "#fff", display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13.5, fontWeight: 600, cursor: "pointer" }}>
              <Icon d={["M12 5v14", "M5 12h14"]} size={16} strokeWidth={2} />영상 추가
            </button>
          </div>
        </header>

        {/* BODY */}
        <main style={{ flex: 1, minWidth: 0, overflow: "auto" }}>
          {isEmpty && (
            <div style={{ maxWidth: 960, margin: "0 auto", padding: "52px 28px 80px" }}>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 13px", borderRadius: 999, background: "#fff", border: "1px solid #E6DDCB", color: "#A04A2E", fontSize: 12.5, fontWeight: 600, marginBottom: 22 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: ACCENT }} />AI 쇼츠 스튜디오 · 베타
              </div>
              <h1 style={{ margin: 0, fontSize: "clamp(34px,5vw,50px)", lineHeight: 1.12, letterSpacing: "-.03em", fontWeight: 800, color: "#16120D" }}>긴 영상을 터지는 쇼츠로,<br /><span style={{ color: ACCENT }}>한 번에.</span></h1>
              <p style={{ margin: "20px 0 36px", fontSize: 17, lineHeight: 1.6, color: "#6E6457", maxWidth: "50ch" }}>MP4 하나만 올리면 자막을 분석해 가장 터질 구간을 골라내고, 9:16 세로 쇼츠와 제목·해시태그까지 자동으로 만들어 드려요.</p>

              {/* DROPZONE */}
              <label onDragOver={e => { e.preventDefault(); if (!dragging) setDragging(true); }} onDragLeave={e => { e.preventDefault(); setDragging(false); }} onDrop={onDrop}
                style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, textAlign: "center", padding: "54px 24px", borderRadius: 22, border: `2px dashed ${dragging ? ACCENT : "#D8CDB6"}`, background: dragging ? "#FFF4EF" : "#FBF7EF", cursor: "pointer", transition: "border-color .18s,background .18s" }}>
                <input type="file" accept="video/mp4" style={{ display: "none" }} onChange={onFileInput} />
                <div style={{ width: 64, height: 64, borderRadius: 18, background: "#16120D", display: "grid", placeItems: "center", boxShadow: "0 14px 30px -12px rgba(22,18,13,.6)" }}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4m0 0L7 9m5-5 5 5" /><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" /></svg>
                </div>
                <div>
                  <div style={{ fontSize: 19, fontWeight: 700, color: "#16120D" }}>{dragging ? "여기에 놓으세요" : fileName ? "다른 영상으로 바꾸기" : "영상을 여기에 끌어다 놓으세요"}</div>
                  <div style={{ marginTop: 6, fontSize: 13.5, color: "#8C8273" }}>MP4 · 최대 2시간 · 끌어다 놓거나 클릭해서 선택</div>
                </div>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 7, height: 42, padding: "0 20px", borderRadius: 11, background: ACCENT, color: "#fff", fontSize: 14, fontWeight: 700, boxShadow: "0 10px 22px -10px rgba(255,74,28,.8)" }}>파일 선택하기</span>
              </label>

              <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ flex: 1, height: 1, background: "#E4DBC9" }} />
                <span style={{ fontSize: 12, color: "#A0957F", fontWeight: 600 }}>또는 유튜브 링크로 가져오기</span>
                <div style={{ flex: 1, height: 1, background: "#E4DBC9" }} />
              </div>
              <div style={{ marginTop: 14, display: "flex", gap: 9 }}>
                <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 10, height: 50, padding: "0 14px", border: "1px solid #E1D8C6", borderRadius: 12, background: "#fff" }}>
                  <span style={{ width: 28, height: 28, borderRadius: 7, background: "#FF0000", display: "grid", placeItems: "center", flex: "0 0 auto" }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="#fff"><path d="M21.6 7.2a2.8 2.8 0 0 0-2-2C17.9 4.8 12 4.8 12 4.8s-5.9 0-7.6.4a2.8 2.8 0 0 0-2 2A29 29 0 0 0 2 12a29 29 0 0 0 .4 4.8 2.8 2.8 0 0 0 2 2c1.7.4 7.6.4 7.6.4s5.9 0 7.6-.4a2.8 2.8 0 0 0 2-2A29 29 0 0 0 22 12a29 29 0 0 0-.4-4.8ZM10 15V9l5.2 3L10 15Z" /></svg>
                  </span>
                  <input value={ytUrl} onChange={e => setYtUrl(e.target.value)} placeholder="https://youtube.com/watch?v=…" style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: "transparent", fontSize: 14, color: "#16120D", fontFamily: "inherit" }} />
                </div>
                <button onClick={importYt} style={{ flex: "0 0 auto", height: 50, padding: "0 20px", border: 0, borderRadius: 12, background: "#16120D", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 7 }}>
                  <Icon d={["M9 17H7A5 5 0 0 1 7 7h2", "M15 7h2a5 5 0 0 1 0 10h-2", "M8 12h8"]} size={16} strokeWidth={1.9} />가져오기
                </button>
              </div>

              {!!fileName && (
                <div style={{ marginTop: 18, borderRadius: 18, background: "#fff", border: "1px solid #E6DDCB", boxShadow: "0 1px 2px rgba(40,30,20,.04)", overflow: "hidden", animation: "scRise .35s ease both" }}>
                  <div style={{ position: "relative", aspectRatio: "16/9", background: upPoster.g, overflow: "hidden" }}>
                    {sourcePreviewUrl && (
                      <video src={sourcePreviewUrl} controls muted playsInline preload="metadata" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", background: "#050505", zIndex: 1 }} />
                    )}
                    {!sourcePreviewUrl && ytPreviewId && (
                      <iframe src={`https://www.youtube.com/embed/${ytPreviewId}`} title="유튜브 미리보기" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0, background: "#050505", zIndex: 1 }} />
                    )}
                    {!ytPreviewId && <div style={{ position: "absolute", inset: 0, background: `radial-gradient(120% 80% at 50% 8%,${upPoster.glow},transparent 60%)` }} />}
                    {!ytPreviewId && <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg,rgba(0,0,0,.12),transparent 38%,rgba(0,0,0,.6))" }} />}
                    {!ytPreviewId && <span style={{ position: "absolute", top: 12, right: 12, zIndex: 2, fontFamily: "'Space Mono',monospace", fontSize: 12, fontWeight: 700, color: "#fff", background: "rgba(0,0,0,.5)", padding: "4px 9px", borderRadius: 8, backdropFilter: "blur(4px)" }}>{formatDuration(inspection?.duration_seconds) || "42:18"}</span>}
                    {!ytPreviewId && <span style={{ position: "absolute", bottom: 12, left: 14, right: 14, zIndex: 2, fontSize: 13, fontWeight: 700, color: "#fff", textShadow: "0 1px 8px rgba(0,0,0,.65)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{fileName}</span>}
                    {!sourcePreviewUrl && !ytPreviewId && <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
                      <span style={{ width: 58, height: 58, borderRadius: "50%", background: "rgba(255,255,255,.92)", display: "grid", placeItems: "center", boxShadow: "0 10px 24px rgba(0,0,0,.45)" }}>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="#16120D"><path d="M8 5.5v13l11-6.5-11-6.5Z" /></svg>
                      </span>
                    </div>}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "15px 16px" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14.5, fontWeight: 700, color: "#16120D" }}>{inspecting ? "자막 검사 중" : inspection?.has_subtitle_stream ? "내장 자막 감지" : "업로드 완료"}</div>
                      <div style={{ fontSize: 12.5, color: "#8C8273", marginTop: 3, display: "flex", alignItems: "center", gap: 6 }}>
                        <Icon d={["M3 6h18v12H3z"]} size={14} stroke="#C83920" strokeWidth={1.9} />{inspection?.has_subtitle_stream ? "추가 자막 없이 진행하도록 선택할 수 있어요" : "쇼츠 만들기를 누르면 자막 유무를 확인하고 진행해요"}
                      </div>
                    </div>
                    <button onClick={generate} style={{ flex: "0 0 auto", height: 46, padding: "0 22px", border: 0, borderRadius: 12, background: "#16120D", color: "#fff", display: "inline-flex", alignItems: "center", gap: 9, fontSize: 14.5, fontWeight: 700, cursor: "pointer" }}>
                      <Icon d={["M5 3v4", "M3 5h4", "M6 17v4", "M4 19h4", "M13 3l2.5 6.5L22 12l-6.5 2.5L13 21l-2.5-6.5L4 12l6.5-2.5L13 3Z"]} size={17} />쇼츠 만들기
                    </button>
                  </div>
                </div>
              )}

              {/* how it works */}
              <div style={{ marginTop: 48 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: ".04em", color: "#A0957F", textTransform: "uppercase" }}>어떻게 작동하나요</span>
                  <button onClick={() => setView("results")} style={{ border: 0, background: "transparent", color: "#A04A2E", fontSize: 13.5, fontWeight: 700, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}>
                    샘플 결과 먼저 둘러보기<Icon d={["M5 12h14", "M13 6l6 6-6 6"]} size={15} strokeWidth={2} />
                  </button>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
                  {steps.map(st => (
                    <div key={st.n} style={{ padding: "18px 16px", borderRadius: 16, background: "#fff", border: "1px solid #EAE1D0" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12 }}>
                        <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 12, fontWeight: 700, color: "#C8392099" }}>0{st.n}</span>
                        <span style={{ width: 34, height: 34, borderRadius: 10, background: "#F4EFE4", color: "#C83920", display: "grid", placeItems: "center" }}><Icon d={st.icon} /></span>
                      </div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#16120D" }}>{st.title}</div>
                      <div style={{ marginTop: 5, fontSize: 12.5, lineHeight: 1.5, color: "#8C8273" }}>{st.desc}</div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "#8C8273" }}>
                  <Icon d={["M12 3 4 6v5c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6l-8-3Z", "m9 12 2 2 4-4"]} size={15} stroke="#1F8A5B" strokeWidth={2} />
                  전체 영상을 AI에 통째로 보내지 않아요. 자막으로 먼저 후보를 추려 <b style={{ color: "#5B5346", fontWeight: 700 }}>비용을 최대 90%까지 절약</b>합니다.
                </div>
              </div>
            </div>
          )}

          {isChecking && (
            <div style={{ maxWidth: 540, margin: "0 auto", padding: "56px 28px 80px", textAlign: "center" }}>
              <div style={{ position: "relative", width: 240, margin: "0 auto 28px", borderRadius: 16, overflow: "hidden", aspectRatio: "16/9", background: upPoster.g, boxShadow: "0 24px 50px -24px rgba(20,15,10,.6)" }}>
                {sourcePreviewUrl && (
                  <video src={sourcePreviewUrl} controls muted playsInline preload="metadata" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", background: "#050505", zIndex: 1 }} />
                )}
                {!sourcePreviewUrl && ytPreviewId && (
                  <iframe src={`https://www.youtube.com/embed/${ytPreviewId}`} title="유튜브 미리보기" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0, background: "#050505", zIndex: 1 }} />
                )}
                {!ytPreviewId && <div style={{ position: "absolute", inset: 0, background: `radial-gradient(120% 80% at 50% 8%,${upPoster.glow},transparent 60%)` }} />}
                {!ytPreviewId && <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg,rgba(0,0,0,.1),rgba(0,0,0,.5))" }} />}
                {!ytPreviewId && <span style={{ position: "absolute", bottom: 10, left: 12, right: 12, zIndex: 2, fontSize: 12, fontWeight: 700, color: "#fff", textShadow: "0 1px 8px rgba(0,0,0,.65)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{fileName}</span>}
              </div>
              <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, letterSpacing: "-.02em", color: "#16120D" }}>이 영상에 자막이 있나요?</h1>
              <p style={{ margin: "12px auto 28px", fontSize: 14.5, lineHeight: 1.6, color: "#6E6457", maxWidth: "42ch" }}>{inspection?.has_subtitle_stream ? "파일 안에서 자막 스트림을 찾았어요. 이미 자막이 보이는 영상이면 추가 자막 없이 분석하세요." : "자막이 있으면 추가 자막을 넣지 않아요. 없으면 음성 전사(STT)로 쇼츠용 자막을 먼저 만들어요."}</p>
              {backendError && (
                <div style={{ margin: "-10px auto 18px", padding: "10px 12px", borderRadius: 12, background: "#FFF4EF", border: "1px solid #F0D9CE", color: "#A04A2E", fontSize: 12.5, fontWeight: 600, lineHeight: 1.45, maxWidth: 440 }}>{backendError}</div>
              )}
              <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
                <button onClick={() => answerSubs(true)} style={{ flex: 1, maxWidth: 220, height: 54, border: "1px solid #E1D8C6", borderRadius: 14, background: "#fff", color: "#16120D", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 9, fontSize: 15, fontWeight: 700, cursor: "pointer" }}>
                  <Icon d={["M3 6h18v12H3z", "M7 12h4", "M14 12h3"]} size={19} stroke="#1F8A5B" strokeWidth={1.9} />자막 있어요
                </button>
                <button onClick={() => answerSubs(false)} style={{ flex: 1, maxWidth: 220, height: 54, border: 0, borderRadius: 14, background: ACCENT, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 9, fontSize: 15, fontWeight: 700, cursor: "pointer", boxShadow: "0 12px 26px -12px rgba(255,74,28,.9)" }}>
                  <Icon d={["M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z", "M5 11a7 7 0 0 0 14 0", "M12 18v3"]} size={19} strokeWidth={1.9} />자막 없어요
                </button>
              </div>
            </div>
          )}

          {isProcessing && (
            <div style={{ maxWidth: 760, margin: "0 auto", padding: "64px 28px 80px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 34 }}>
                <div style={{ width: 52, height: 52, borderRadius: 14, background: "#16120D", display: "grid", placeItems: "center" }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2.2" strokeLinecap="round" style={{ animation: "scSpin 1s linear infinite" }}><path d="M12 3a9 9 0 1 0 9 9" /></svg>
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: ".04em", color: "#A0957F", textTransform: "uppercase" }}>분석 중</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "#16120D" }}>{fileName}</div>
                  {backendJobId && <div style={{ marginTop: 4, fontSize: 11.5, color: "#9A8F7E", fontFamily: "'Space Mono',monospace" }}>JOB {backendJobId}</div>}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 10 }}>
                <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-.02em", color: "#16120D" }}>{STAGE_DEFS[stageIndex].name}</div>
                <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 30, fontWeight: 700, color: ACCENT }}>{Math.round(progress)}%</div>
              </div>
              <div style={{ height: 10, borderRadius: 999, background: "#E2D9C8", overflow: "hidden", position: "relative" }}>
                <div style={{ height: "100%", width: `${Math.round(progress)}%`, background: "linear-gradient(90deg,#FF7A3C,#FF4A1C)", borderRadius: 999, transition: "width .25s ease" }} />
              </div>
              <div style={{ marginTop: 34, display: "flex", flexDirection: "column", gap: 10 }}>
                {STAGE_DEFS.map((st, i) => {
                  const done = i < stageIndex || progress >= 100;
                  const active = i === stageIndex && progress < 100;
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 14, padding: "16px 18px", borderRadius: 14, background: active ? "#fff" : done ? "#FBF7EF" : "#F2ECE0", border: `1px solid ${active ? ACCENT : done ? "#E6DDCB" : "#EAE1D0"}`, transition: "background .25s,border-color .25s" }}>
                      <div style={{ width: 30, height: 30, flex: "0 0 auto", borderRadius: "50%", border: `2px solid ${done || active ? ACCENT : "#CFC4AE"}`, background: done ? ACCENT : active ? "#FFF4EF" : "transparent", color: "#fff", display: "grid", placeItems: "center" }}>
                        {done && <Icon d={["m5 12 5 5L20 6"]} size={14} stroke="#fff" strokeWidth={3} />}
                        {active && <Icon d={["M12 3a9 9 0 1 0 9 9"]} size={14} stroke={ACCENT} strokeWidth={2.6} style={{ animation: "scSpin 1s linear infinite" }} />}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14.5, fontWeight: 700, color: done || active ? "#16120D" : "#A89D8B" }}>{st.name}</div>
                        <div style={{ fontSize: 12.5, color: "#9A8F7E", marginTop: 2 }}>{st.desc}</div>
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 700, color: done ? "#1F8A5B" : active ? ACCENT : "#B5AA97", fontFamily: "'Space Mono',monospace" }}>{done ? "완료" : active ? "진행 중" : "대기"}</span>
                    </div>
                  );
                })}
              </div>
              <div style={{ marginTop: 24, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 12.5, color: "#9A8F7E" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                보통 10분 영상 기준 1~2분 정도 걸려요. 창을 닫아도 분석은 계속됩니다.
              </div>
            </div>
          )}

          {isResults && (
            <div style={{ padding: "24px 28px 90px" }}>
              <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 20, flexWrap: "wrap", marginBottom: 22 }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, fontWeight: 700, letterSpacing: ".03em", color: "#A0957F", textTransform: "uppercase", marginBottom: 8 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "#1F8A5B" }}><Icon d={["m5 12 5 5L20 6"]} size={15} strokeWidth={2.4} />분석 완료</span>
                    · {homeName}
                  </div>
                  <h1 style={{ margin: 0, fontSize: 30, fontWeight: 800, letterSpacing: "-.02em", color: "#16120D" }}>바이럴 클립 후보 <span style={{ color: "#C0B6A2", fontWeight: 700 }}>{activeClips.length}</span></h1>
                  <p style={{ margin: "8px 0 0", fontSize: 14, color: "#8C8273" }}>점수가 높을수록 첫 3초 이탈률이 낮고 끝까지 볼 확률이 높아요. 카드를 눌러 제목·자막·유튜브 패키지를 편집하세요.</p>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button onClick={openHighlightDraft} style={{ height: 40, padding: "0 14px", border: "1px solid #E1D8C6", borderRadius: 11, background: "#fff", color: "#5B5346", display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13.5, fontWeight: 700, cursor: "pointer" }}>
                    <Icon d={["M4 5h16v14H4z", "m10 9 5 3-5 3V9Z"]} size={16} />하이라이트 만들기
                  </button>
                  <button onClick={reset} style={{ height: 40, padding: "0 16px", border: 0, borderRadius: 11, background: "#16120D", color: "#fff", display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13.5, fontWeight: 700, cursor: "pointer" }}>
                    <Icon d={["M12 5v14", "M5 12h14"]} size={16} strokeWidth={2} />새 영상
                  </button>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 24, paddingBottom: 18, borderBottom: "1px solid #E4DBC9" }}>
                <span style={{ fontSize: 13, color: "#9A8F7E", fontWeight: 600, marginRight: 4 }}>정렬</span>
                {filtersList.map(f => (
                  <button key={f.key} onClick={() => setFilter(f.key)} style={{ height: 34, padding: "0 14px", border: `1px solid ${f.on ? "#16120D" : "#E1D8C6"}`, borderRadius: 999, background: f.on ? "#16120D" : "#fff", color: f.on ? "#fff" : "#5B5346", fontSize: 13, fontWeight: 600, cursor: "pointer", transition: "all .15s" }}>{f.label}</button>
                ))}
                <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
                  {hiddenCount > 0 && (
                    <button onClick={restoreHidden} style={{ height: 30, padding: "0 11px", border: "1px solid #E1D8C6", borderRadius: 999, background: "#fff", color: "#5B5346", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>숨김 {hiddenCount}개 복원</button>
                  )}
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "#9A8F7E" }}>
                    <Icon d={["M12 8v4", "M12 16h.01"]} size={14} strokeWidth={2} />{filter === "custom" ? "카드의 ↑↓로 순서 변경 · 📌 고정" : "마우스를 올리면 미리보기가 재생돼요"}
                  </div>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 22 }}>
                {sortedClips.map(c => {
                  const p = POSTERS[(c.rank - 1) % POSTERS.length];
                  const sc = scoreColors(c.score);
                  return (
                    <article key={c.id} className="sc-card" onClick={() => { setSelectedClipId(c.id); setTab("titles"); }}
                      style={{ borderRadius: 18, background: "#fff", border: `1.5px solid ${pinned.has(c.id) ? ACCENT : "#EAE1D0"}`, overflow: "hidden", cursor: "pointer", boxShadow: "0 1px 2px rgba(40,30,20,.04)", transition: "transform .18s,box-shadow .18s,border-color .18s" }}>
                      <div style={{ position: "relative", aspectRatio: "9/16", background: p.g, overflow: "hidden" }}>
                        {c.thumbnailUrl && <div style={{ position: "absolute", inset: 0, backgroundImage: `url(${c.thumbnailUrl})`, backgroundSize: "cover", backgroundPosition: "center" }} />}
                        <div style={{ position: "absolute", inset: 0, background: `radial-gradient(120% 60% at 50% 18%,${p.glow},transparent 60%)` }} />
                        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg,rgba(0,0,0,.28),transparent 26%,transparent 58%,rgba(0,0,0,.72))" }} />
                        <div style={{ position: "absolute", top: 10, left: 10, right: 10, display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
                          <div style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 28, padding: "0 10px 0 8px", borderRadius: 999, background: sc.bg, color: sc.fg, boxShadow: "0 6px 14px -6px rgba(0,0,0,.5)" }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 13h6l-1 9 9-12h-6l1-8Z" /></svg>
                            <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 14, fontWeight: 700 }}>{c.score}</span>
                          </div>
                          <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 11, fontWeight: 700, color: "#fff", background: "rgba(0,0,0,.45)", padding: "4px 8px", borderRadius: 7, backdropFilter: "blur(4px)" }}>{c.durSec}초</span>
                        </div>
                        <div style={{ position: "absolute", left: 14, right: 14, bottom: 14 }}>
                          <div style={{ fontSize: 12, color: "rgba(255,255,255,.82)", fontFamily: "'Space Mono',monospace" }}>{c.start} – {c.end}</div>
                        </div>
                      </div>
                      <div style={{ padding: "14px 15px 16px" }}>
                        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, lineHeight: 1.4, color: "#16120D", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{c.title}</h3>
                        <p style={{ margin: "7px 0 12px", fontSize: 12.5, lineHeight: 1.5, color: "#8C8273", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{c.reason}</p>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                          {c.labels.map(lb => (
                            <span key={lb} style={{ fontSize: 11, fontWeight: 600, color: "#7A7060", background: "#F3EEE3", border: "1px solid #EAE1D0", borderRadius: 999, padding: "3px 9px" }}>{lb}</span>
                          ))}
                        </div>
                        <div onClick={e => e.stopPropagation()} style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 6 }}>
                          <button onClick={() => togglePin(c.id)} title={pinned.has(c.id) ? "고정 해제" : "고정"}
                            style={{ height: 30, padding: "0 10px", border: `1px solid ${pinned.has(c.id) ? ACCENT : "#E1D8C6"}`, borderRadius: 9, background: pinned.has(c.id) ? "#FFF4EF" : "#fff", color: pinned.has(c.id) ? "#A04A2E" : "#5B5346", display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                            <Icon d={["M9 4h6l-1 7 3 3v2H7v-2l3-3-1-7Z", "M12 16v5"]} size={13} strokeWidth={1.8} />고정
                          </button>
                          <button onClick={() => openClipEditor(c.id)} title="편집기 열기"
                            style={{ height: 30, padding: "0 10px", border: "1px solid #F0D9CE", borderRadius: 9, background: "#FFF4EF", color: "#C83920", display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                            <Icon d={["M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7", "M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z"]} size={13} strokeWidth={1.8} />편집
                          </button>
                          <button onClick={() => moveCandidate(c.id, -1)} title="위로" style={{ width: 30, height: 30, flex: "0 0 auto", border: "1px solid #E1D8C6", borderRadius: 9, background: "#fff", color: "#5B5346", display: "grid", placeItems: "center", cursor: "pointer" }}>
                            <Icon d={["M12 19V5", "M5 12l7-7 7 7"]} size={14} strokeWidth={2} />
                          </button>
                          <button onClick={() => moveCandidate(c.id, 1)} title="아래로" style={{ width: 30, height: 30, flex: "0 0 auto", border: "1px solid #E1D8C6", borderRadius: 9, background: "#fff", color: "#5B5346", display: "grid", placeItems: "center", cursor: "pointer" }}>
                            <Icon d={["M12 5v14", "M19 12l-7 7-7-7"]} size={14} strokeWidth={2} />
                          </button>
                          <button onClick={() => hideCandidate(c.id)} title="후보에서 숨기기" style={{ width: 30, height: 30, flex: "0 0 auto", marginLeft: "auto", border: "1px solid #F0D9CE", borderRadius: 9, background: "#FFF6F4", color: "#C0392B", display: "grid", placeItems: "center", cursor: "pointer" }}>
                            <Icon d={["M4 7h16", "M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2", "M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"]} size={14} strokeWidth={1.8} />
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          )}

          {isProjectList && (
            <div style={{ maxWidth: 1120, margin: "0 auto", padding: "30px 28px 80px" }}>
              <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 18, marginBottom: 24 }}>
                <div>
                  <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800, letterSpacing: "-.02em", color: "#16120D" }}>프로젝트</h1>
                  <p style={{ margin: "8px 0 0", fontSize: 14, color: "#8C8273" }}>업로드한 영상과 거기서 만들어진 쇼츠를 한곳에서 관리하세요. 영상을 누르면 만들어진 쇼츠가 열려요.</p>
                </div>
                <button onClick={reset} style={{ height: 40, padding: "0 16px", border: 0, borderRadius: 11, background: "#16120D", color: "#fff", display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13.5, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
                  <Icon d={["M12 5v14", "M5 12h14"]} size={16} strokeWidth={2} />새 영상
                </button>
              </div>
              {studioLoaded && projects.length === 0 && (
                <div style={{ padding: "60px 20px", textAlign: "center", color: "#9A8F7E", fontSize: 14, background: "#fff", border: "1px solid #EAE1D0", borderRadius: 18 }}>
                  아직 프로젝트가 없어요. 홈에서 영상을 올리거나 YouTube 링크로 쇼츠를 만들어 보세요.
                </div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: 18 }}>
                {projects.map(pj => {
                  const po = POSTERS[pj.posterIdx % POSTERS.length];
                  return (
                    <article key={pj.id} className="sc-card" onClick={() => void openProjectDetail(pj.id)}
                      style={{ borderRadius: 18, background: "#fff", border: "1px solid #EAE1D0", overflow: "hidden", cursor: "pointer", boxShadow: "0 1px 2px rgba(40,30,20,.04)", transition: "transform .18s,box-shadow .18s,border-color .18s" }}>
                      <div style={{ position: "relative", aspectRatio: "16/9", background: po.g, overflow: "hidden" }}>
                        {pj.ytId ? (
                          // eslint-disable-next-line @next/next/no-img-element -- external YouTube thumbnail
                          <img src={`https://i.ytimg.com/vi/${pj.ytId}/hqdefault.jpg`} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
                        ) : pj.originalVideoUrl ? (
                          <video src={`${pj.originalVideoUrl}#t=1`} muted playsInline preload="metadata" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", background: "#0E0E12" }} />
                        ) : (
                          <div style={{ position: "absolute", inset: 0, background: `radial-gradient(120% 80% at 50% 8%,${po.glow},transparent 60%)` }} />
                        )}
                        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg,rgba(0,0,0,.12),transparent 40%,rgba(0,0,0,.62))" }} />
                        <span style={{ position: "absolute", top: 10, right: 10, fontFamily: "'Space Mono',monospace", fontSize: 11, fontWeight: 700, color: "#fff", background: "rgba(0,0,0,.5)", padding: "3px 8px", borderRadius: 7 }}>{pj.dur}</span>
                        <span style={{ position: "absolute", bottom: 11, left: 13, display: "inline-flex", alignItems: "center", gap: 6, color: "#fff", fontSize: 12.5, fontWeight: 700, textShadow: "0 1px 6px rgba(0,0,0,.6)" }}>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2" /><path d="m10 9 5 3-5 3V9Z" fill="currentColor" stroke="none" /></svg>
                          쇼츠 {pj.shorts.length}개
                        </span>
                      </div>
                      <div style={{ padding: "13px 15px 15px" }}>
                        <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 700, color: "#16120D", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{pj.title}</h3>
                        <div style={{ marginTop: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <span style={{ fontSize: 12.5, color: "#8C8273", fontFamily: "'Space Mono',monospace" }}>{pj.date}</span>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 11.5, fontWeight: 700, color: "#1F8A5B", background: "#E7F5EE", border: "1px solid #BFE6D2", borderRadius: 999, padding: "2px 9px" }}>{pj.status}</span>
                            <button onClick={e => void handleDeleteProject(e, pj.id)} title="프로젝트 삭제" style={{ display: "grid", placeItems: "center", width: 28, height: 28, border: "1px solid #EAE1D0", borderRadius: 8, background: "#fff", color: "#B0A090", cursor: "pointer", padding: 0, flexShrink: 0 }}
                              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "#FEF2F2"; (e.currentTarget as HTMLButtonElement).style.color = "#DC2626"; (e.currentTarget as HTMLButtonElement).style.borderColor = "#FECACA"; }}
                              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "#fff"; (e.currentTarget as HTMLButtonElement).style.color = "#B0A090"; (e.currentTarget as HTMLButtonElement).style.borderColor = "#EAE1D0"; }}>
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                            </button>
                          </div>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          )}

          {isProjectDetail && selProj && (
            <div style={{ padding: "24px 28px 90px" }}>
              <button onClick={() => setOpenProject(null)} style={{ display: "inline-flex", alignItems: "center", gap: 7, height: 34, padding: "0 13px 0 9px", border: "1px solid #E1D8C6", borderRadius: 10, background: "#fff", color: "#5B5346", fontSize: 13, fontWeight: 600, cursor: "pointer", marginBottom: 18 }}>
                <Icon d={["M15 18 9 12l6-6"]} size={16} strokeWidth={2} />프로젝트
              </button>
              <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 18, flexWrap: "wrap", marginBottom: 22 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: ".03em", color: "#A0957F", textTransform: "uppercase", marginBottom: 7 }}>이 영상에서 만든 쇼츠</div>
                  <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, letterSpacing: "-.02em", color: "#16120D", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "60ch" }}>{selProj.title}</h1>
                  <p style={{ margin: "8px 0 0", fontSize: 13.5, color: "#8C8273", fontFamily: "'Space Mono',monospace" }}>{selProj.date} · {selProj.dur} · 쇼츠 {selProj.shorts.length}개</p>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button onClick={openHighlightDraft} style={{ height: 40, padding: "0 16px", border: 0, borderRadius: 11, background: "#16120D", color: "#fff", display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13.5, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
                    <Icon d={["M4 5h16v14H4z", "m10 9 5 3-5 3V9Z"]} size={16} strokeWidth={1.9} />하이라이트 만들기
                  </button>
                  <button onClick={() => showToast("다운로드를 시작했어요")} style={{ height: 40, padding: "0 16px", border: "1px solid #E1D8C6", borderRadius: 11, background: "#fff", color: "#5B5346", display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13.5, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                    <Icon d={["M12 3v12m0 0 4-4m-4 4-4-4", "M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"]} size={16} strokeWidth={1.9} />전체 다운로드
                  </button>
                </div>
              </div>

              {/* 원본 영상 미리보기 — 유튜브 임포트면 유튜브 화면, MP4 업로드면 첫 프레임 */}
              {(selProj.ytId || selProj.originalVideoUrl) && (
                <section style={{ marginBottom: 26, background: "#fff", border: "1px solid #EAE1D0", borderRadius: 18, overflow: "hidden", boxShadow: "0 1px 2px rgba(40,30,20,.04)" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 18px", borderBottom: "1px solid #F1EADD" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                      <span style={{ width: 30, height: 30, borderRadius: 8, background: "#16120D", color: ACCENT, display: "grid", placeItems: "center", flex: "0 0 auto" }}>
                        <Icon d={["M4 5h16v14H4z", "m10 9 5 3-5 3V9Z"]} size={16} strokeWidth={1.9} />
                      </span>
                      <span style={{ fontSize: 14, fontWeight: 700, color: "#16120D" }}>원본 영상</span>
                      <span style={{ display: "inline-flex", alignItems: "center", height: 22, padding: "0 9px", borderRadius: 999, fontSize: 11, fontWeight: 700, background: selProj.ytId ? "#FDECEA" : "#EEF3FB", color: selProj.ytId ? "#C0392B" : "#3C77C2", border: `1px solid ${selProj.ytId ? "#F5C9C2" : "#CFE0F5"}` }}>
                        {selProj.ytId ? "유튜브" : "업로드 MP4"}
                      </span>
                    </div>
                    {selProj.ytId && selProj.sourceUrl && (
                      <a href={selProj.sourceUrl} target="_blank" rel="noreferrer" style={{ flex: "0 0 auto", display: "inline-flex", alignItems: "center", gap: 5, height: 30, padding: "0 11px", borderRadius: 9, background: "#fff", border: "1px solid #E1D8C6", color: "#5B5346", fontSize: 12, fontWeight: 700, textDecoration: "none" }}>
                        <Icon d={["M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6", "M15 3h6v6", "M10 14 21 3"]} size={14} strokeWidth={1.9} />유튜브에서 보기
                      </a>
                    )}
                  </div>
                  <div style={{ padding: 18 }}>
                    <div style={{ position: "relative", width: "100%", maxWidth: 640, margin: "0 auto", aspectRatio: "16/9", borderRadius: 12, overflow: "hidden", background: "#050505" }}>
                      {selProj.ytId ? (
                        <iframe src={`https://www.youtube.com/embed/${selProj.ytId}`} title="원본 유튜브 영상" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }} />
                      ) : (
                        <video src={`${selProj.originalVideoUrl}#t=0.1`} controls playsInline preload="metadata" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", background: "#050505" }} />
                      )}
                    </div>
                  </div>
                </section>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(216px,1fr))", gap: 22 }}>
                {selProj.shorts.map((sh, i) => {
                  const c = activeClips.find(x => x.id === sh.clipId);
                  if (!c) return null;
                  const po = POSTERS[(c.rank - 1) % POSTERS.length];
                  const pill = stPill(sh.state);
                  const sc = scoreColors(c.score);
                  return (
                    <article key={i} className="sc-card" onClick={() => { setSelectedClipId(c.id); setTab("titles"); }}
                      style={{ borderRadius: 18, background: "#fff", border: "1px solid #EAE1D0", overflow: "hidden", cursor: "pointer", boxShadow: "0 1px 2px rgba(40,30,20,.04)", transition: "transform .18s,box-shadow .18s,border-color .18s" }}>
                      <div style={{ position: "relative", aspectRatio: "9/16", background: po.g, overflow: "hidden" }}>
                        {c.thumbnailUrl && <div style={{ position: "absolute", inset: 0, backgroundImage: `url(${c.thumbnailUrl})`, backgroundSize: "cover", backgroundPosition: "center" }} />}
                        <div style={{ position: "absolute", inset: 0, background: `radial-gradient(120% 60% at 50% 18%,${po.glow},transparent 60%)` }} />
                        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg,rgba(0,0,0,.28),transparent 30%,transparent 58%,rgba(0,0,0,.72))" }} />
                        <div style={{ position: "absolute", top: 10, left: 10, right: 10, display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
                          <div style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 28, padding: "0 10px 0 8px", borderRadius: 999, background: sc.bg, color: sc.fg, boxShadow: "0 6px 14px -6px rgba(0,0,0,.5)" }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 13h6l-1 9 9-12h-6l1-8Z" /></svg>
                            <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 14, fontWeight: 700 }}>{c.score}</span>
                          </div>
                          <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 11, fontWeight: 700, color: "#fff", background: "rgba(0,0,0,.45)", padding: "4px 8px", borderRadius: 7 }}>{c.durSec}초</span>
                        </div>
                        <div style={{ position: "absolute", left: 12, bottom: 12 }}>
                          <span style={{ display: "inline-flex", alignItems: "center", height: 24, padding: "0 9px", borderRadius: 999, fontSize: 11, fontWeight: 700, background: pill.bg, color: pill.fg, border: `1px solid ${pill.bd}` }}>{sh.state}</span>
                        </div>
                      </div>
                      <div style={{ padding: "13px 15px 15px" }}>
                        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, lineHeight: 1.4, color: "#16120D", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{c.title}</h3>
                        <div style={{ marginTop: 8, fontSize: 11.5, color: "#9A8F7E", fontFamily: "'Space Mono',monospace" }}>{c.start} – {c.end}</div>
                        <div onClick={e => e.stopPropagation()} style={{ marginTop: 12, display: "flex", gap: 8 }}>
                          <button onClick={() => openClipEditor(c.id)} style={{ flex: 1, height: 34, border: "1px solid #F0D9CE", borderRadius: 10, background: "#FFF4EF", color: "#C83920", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>
                            <Icon d={["M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7", "M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z"]} size={14} strokeWidth={1.8} />편집
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          )}

          {isSchedule && (
            <div style={{ padding: "26px 28px 60px" }}>
              <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 18, flexWrap: "wrap", marginBottom: 22 }}>
                <div>
                  <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800, letterSpacing: "-.02em", color: "#16120D" }}>예약 발행</h1>
                  <p style={{ margin: "8px 0 0", fontSize: 14, color: "#8C8273" }}>유튜브에 예약 걸어둔 쇼츠를 달력에서 한눈에 확인하세요.</p>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <button onClick={() => setSchedMonth(m => m - 1)} style={{ width: 34, height: 34, border: "1px solid #E1D8C6", borderRadius: 9, background: "#fff", color: "#5B5346", display: "grid", placeItems: "center", cursor: "pointer" }}><Icon d={["M15 18 9 12l6-6"]} size={16} strokeWidth={2} /></button>
                    <span style={{ minWidth: 120, textAlign: "center", fontSize: 15, fontWeight: 700, color: "#16120D", fontFamily: "'Space Grotesk',sans-serif" }}>{monthLabel}</span>
                    <button onClick={() => setSchedMonth(m => m + 1)} style={{ width: 34, height: 34, border: "1px solid #E1D8C6", borderRadius: 9, background: "#fff", color: "#5B5346", display: "grid", placeItems: "center", cursor: "pointer" }}><Icon d={["m9 18 6-6-6-6"]} size={16} strokeWidth={2} /></button>
                  </div>
                  <button onClick={openAutoDist} style={{ height: 40, padding: "0 16px", border: 0, borderRadius: 11, background: "#16120D", color: "#fff", display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13.5, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
                    <Icon d={["M12 5v14", "M5 12h14"]} size={16} strokeWidth={2} />예약 자동 배치
                  </button>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 280px", gap: 20, alignItems: "start" }}>
                <div style={{ background: "#fff", border: "1px solid #EAE1D0", borderRadius: 18, overflow: "hidden" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", borderBottom: "1px solid #EFE7D8" }}>
                    {weekDays.map(wd => <div key={wd} style={{ padding: "11px 0", textAlign: "center", fontSize: 12, fontWeight: 700, color: "#A0957F" }}>{wd}</div>)}
                  </div>
                  {weeks.map((wk, wi) => (
                    <div key={wi} style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)" }}>
                      {wk.map((dy, di) => (
                        <div key={di} style={{ minHeight: 104, borderRight: "1px solid #F1EADD", borderBottom: "1px solid #F1EADD", padding: "7px 7px 8px", display: "flex", flexDirection: "column", gap: 5, background: dy.cellBg }}>
                          <span style={{ fontSize: 12, fontWeight: 700, color: dy.numColor, fontFamily: "'Space Mono',monospace" }}>{dy.num}</span>
                          {dy.items.map((ev, ei) => (
                            <button key={ei} onClick={() => ev.item && openReschedule(ev.item)} title="예약 변경 / 취소" style={{ textAlign: "left", borderRadius: 7, padding: "4px 7px", background: ev.bg, color: ev.fg, border: `1px solid ${ev.bd}`, cursor: "pointer", width: "100%" }}>
                              <div style={{ fontSize: 10, fontWeight: 700, fontFamily: "'Space Mono',monospace", opacity: .85 }}>{ev.time}</div>
                              <div style={{ fontSize: 10.5, fontWeight: 600, lineHeight: 1.25, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ev.title}</div>
                            </button>
                          ))}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
                <div style={{ background: "#fff", border: "1px solid #EAE1D0", borderRadius: 18, padding: 18 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                    <span style={{ width: 30, height: 30, borderRadius: 8, background: "#16120D", color: ACCENT, display: "grid", placeItems: "center" }}>
                      <Icon d={["M2 6a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2Z"]} size={16} strokeWidth={1.9} />
                    </span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: "#16120D" }}>다가오는 예약</span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                    {upcoming.length === 0 && (
                      <div style={{ fontSize: 12.5, color: "#9A8F7E", padding: "10px 2px" }}>예약된 쇼츠가 없어요. ‘예약 자동 배치’로 채워 보세요.</div>
                    )}
                    {upcoming.map((up, i) => (
                      <button key={i} onClick={() => openReschedule(up)} style={{ textAlign: "left", display: "flex", gap: 11, padding: 11, borderRadius: 12, background: "#FBF7EF", border: "1px solid #EFE7D8", cursor: "pointer", width: "100%" }}>
                        <div style={{ flex: "0 0 auto", width: 42, textAlign: "center" }}>
                          <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 17, fontWeight: 700, color: "#C83920", lineHeight: 1 }}>{up.day}일</div>
                          <div style={{ fontSize: 10.5, color: "#9A8F7E", fontFamily: "'Space Mono',monospace", marginTop: 3 }}>{up.time}</div>
                        </div>
                        <div style={{ flex: 1, minWidth: 0, alignSelf: "center" }}>
                          <div style={{ fontSize: 12.5, fontWeight: 600, color: "#16120D", lineHeight: 1.35, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{up.title}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {isChannelList && (
            <div style={{ maxWidth: 1000, margin: "0 auto", padding: "30px 28px 80px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
                <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800, letterSpacing: "-.02em", color: "#16120D" }}>채널</h1>
                <button onClick={connectYouTube} style={{ height: 40, padding: "0 18px", borderRadius: 12, border: "1px solid #FF4A1C", background: "#FF4A1C", color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>+ 채널 추가</button>
              </div>
              <p style={{ margin: "0 0 26px", fontSize: 14, color: "#8C8273" }}>채널을 누르면 올라간 영상별 조회수·좋아요·댓글과 실제 댓글을 볼 수 있어요.</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {channels.length === 0 && (
                  <div style={{ padding: "50px 20px", textAlign: "center", color: "#9A8F7E", fontSize: 14, background: "#fff", border: "1px solid #EAE1D0", borderRadius: 16 }}>
                    연결된 채널이 없어요. 먼저 Google로 로그인하고 YouTube 채널을 연결해 주세요.
                  </div>
                )}
                {channels.map(ch => (
                  <article key={ch.id} className="sc-card" onClick={() => void openChannelDetail(ch.id)}
                    style={{ display: "flex", alignItems: "center", gap: 18, padding: "18px 20px", borderRadius: 16, background: "#fff", border: "1px solid #EAE1D0", cursor: "pointer", boxShadow: "0 1px 2px rgba(40,30,20,.04)", transition: "transform .16s,box-shadow .16s,border-color .16s" }}>
                    {ch.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- external YouTube channel avatar
                      <img src={ch.thumbnailUrl} alt="" style={{ width: 62, height: 62, borderRadius: "50%", objectFit: "cover", flex: "0 0 auto", border: "2px solid #FFF4EF", boxShadow: "0 8px 18px -14px rgba(22,18,13,.7)" }} />
                    ) : (
                      <div style={{ width: 62, height: 62, borderRadius: "50%", background: ch.color, color: "#fff", display: "grid", placeItems: "center", fontSize: 22, fontWeight: 800, flex: "0 0 auto" }}>{ch.name.slice(0, 1)}</div>
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <span style={{ fontSize: 16, fontWeight: 800, color: "#16120D", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ch.name}</span>
                        <span style={{ fontSize: 12, color: "#9A8F7E", fontFamily: "'Space Mono',monospace" }}>{ch.handle}</span>
                        {ch.isDefault && (
                          <span style={{ flex: "0 0 auto", fontSize: 11, fontWeight: 800, color: "#C83920", background: "#FBF1EC", border: "1px solid #F0D9CE", borderRadius: 999, padding: "2px 8px" }}>기본</span>
                        )}
                      </div>
                      <p style={{ margin: "7px 0 0", color: "#6E6457", fontSize: 13, lineHeight: 1.45, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                        {ch.description || "채널 설명이 비어 있어요."}
                      </p>
                      <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 12.5, color: "#8C8273" }}>구독자 <b style={{ color: "#16120D", fontFamily: "'Space Grotesk',sans-serif" }}>{ch.subs}</b></span>
                        <span style={{ fontSize: 12.5, color: "#8C8273" }}>총 조회수 <b style={{ color: "#16120D", fontFamily: "'Space Grotesk',sans-serif" }}>{ch.views}</b></span>
                        <span style={{ fontSize: 12.5, color: "#8C8273" }}>영상 <b style={{ color: "#16120D", fontFamily: "'Space Grotesk',sans-serif" }}>{ch.videos.length}</b></span>
                        <span style={{ fontSize: 12.5, color: "#8C8273" }}>연결 <b style={{ color: "#16120D", fontFamily: "'Space Grotesk',sans-serif" }}>{fmtDateDots(ch.connectedAt) || "완료"}</b></span>
                        <span style={{ fontSize: 11.5, color: "#A0957F", fontFamily: "'Space Mono',monospace", maxWidth: 180, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ch.channelId}</span>
                      </div>
                    </div>
                    <div onClick={e => e.stopPropagation()} style={{ display: "flex", alignItems: "center", gap: 8, flex: "0 0 auto" }}>
                      {!ch.isDefault && (
                        <button onClick={() => void makeDefaultChannel(ch.id)} disabled={channelBusy === ch.id}
                          style={{ height: 32, padding: "0 12px", border: "1px solid #E1D8C6", borderRadius: 9, background: "#fff", color: "#5B5346", fontSize: 12, fontWeight: 700, cursor: channelBusy === ch.id ? "not-allowed" : "pointer", whiteSpace: "nowrap" }}>기본으로</button>
                      )}
                      <button onClick={() => void removeChannel(ch.id, ch.name)} disabled={channelBusy === ch.id}
                        style={{ height: 32, padding: "0 12px", border: "1px solid #F0D9CE", borderRadius: 9, background: "#FFF6F4", color: "#C0392B", fontSize: 12, fontWeight: 700, cursor: channelBusy === ch.id ? "not-allowed" : "pointer", whiteSpace: "nowrap" }}>연결 해제</button>
                    </div>
                    <Icon d={["m9 18 6-6-6-6"]} size={18} stroke="#C0B6A2" strokeWidth={2} style={{ flex: "0 0 auto" }} />
                  </article>
                ))}
              </div>
            </div>
          )}

          {isChannelDetail && selChan && (
            <div style={{ padding: "24px 28px 60px" }}>
              <button onClick={() => { setOpenChannel(null); setOpenVideo(null); setStyleNoteDraft(null); }} style={{ display: "inline-flex", alignItems: "center", gap: 7, height: 34, padding: "0 13px 0 9px", border: "1px solid #E1D8C6", borderRadius: 10, background: "#fff", color: "#5B5346", fontSize: 13, fontWeight: 600, cursor: "pointer", marginBottom: 18 }}>
                <Icon d={["M15 18 9 12l6-6"]} size={16} strokeWidth={2} />채널 목록
              </button>
              <div style={{ display: "flex", alignItems: "center", gap: 18, marginBottom: 22, padding: 18, borderRadius: 18, background: "#fff", border: "1px solid #EAE1D0" }}>
                {selChan.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- external YouTube channel avatar
                  <img src={selChan.thumbnailUrl} alt="" style={{ width: 74, height: 74, borderRadius: "50%", objectFit: "cover", flex: "0 0 auto", border: "2px solid #FFF4EF" }} />
                ) : (
                  <div style={{ width: 74, height: 74, borderRadius: "50%", background: selChan.color, color: "#fff", display: "grid", placeItems: "center", fontSize: 26, fontWeight: 800, flex: "0 0 auto" }}>{selChan.name.slice(0, 1)}</div>
                )}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                    <div style={{ fontSize: 22, fontWeight: 800, color: "#16120D", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{selChan.name}</div>
                    {selChan.isDefault && (
                      <span style={{ flex: "0 0 auto", fontSize: 11, fontWeight: 800, color: "#C83920", background: "#FBF1EC", border: "1px solid #F0D9CE", borderRadius: 999, padding: "2px 8px" }}>기본 채널</span>
                    )}
                  </div>
                  <div style={{ marginTop: 5, fontSize: 13, color: "#8C8273" }}>
                    <span style={{ fontFamily: "'Space Mono',monospace" }}>{selChan.handle}</span>
                    <span> · 구독자 {selChan.subs} · 조회수 {selChan.views} · 연결 {fmtDateDots(selChan.connectedAt) || "완료"}</span>
                  </div>
                  <p style={{ margin: "9px 0 0", maxWidth: 760, fontSize: 13.5, lineHeight: 1.5, color: "#5B5346", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                    {selChan.description || "채널 설명이 비어 있어요."}
                  </p>
                  <div style={{ marginTop: 8, fontSize: 11.5, color: "#A0957F", fontFamily: "'Space Mono',monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{selChan.channelId}</div>

                  <div style={{ marginTop: 14 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
                      <Icon d={["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"]} size={13} stroke="#C83920" strokeWidth={1.9} />
                      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".04em", color: "#A0957F", textTransform: "uppercase" }}>콘텐츠 스타일 메모</span>
                      {styleNoteDraft === null && (
                        <button onClick={() => setStyleNoteDraft(selChan.styleNote)} style={{ marginLeft: 6, height: 24, padding: "0 9px", border: "1px solid #E1D8C6", borderRadius: 8, background: "#fff", color: "#5B5346", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>{selChan.styleNote ? "편집" : "추가"}</button>
                      )}
                    </div>
                    {styleNoteDraft === null ? (
                      <p style={{ margin: 0, maxWidth: 760, fontSize: 13, lineHeight: 1.5, color: selChan.styleNote ? "#5B5346" : "#A0957F", whiteSpace: "pre-wrap" }}>
                        {selChan.styleNote || "예: 이 채널은 예능톤, 자막 크게, 제목 자극적으로. 발행 시 참고할 스타일을 적어 두세요."}
                      </p>
                    ) : (
                      <div style={{ maxWidth: 760 }}>
                        <textarea value={styleNoteDraft} onChange={e => setStyleNoteDraft(e.target.value)} rows={3} maxLength={2000} placeholder="예: 이 채널은 예능톤, 자막 크게, 제목 자극적으로" style={{ ...PUB_INPUT, resize: "vertical", lineHeight: 1.5 }} />
                        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                          <button onClick={() => setStyleNoteDraft(null)} disabled={styleNoteSaving} style={{ height: 34, padding: "0 14px", border: "1px solid #E1D8C6", borderRadius: 9, background: "#fff", color: "#5B5346", fontSize: 12.5, fontWeight: 700, cursor: styleNoteSaving ? "not-allowed" : "pointer" }}>취소</button>
                          <button onClick={() => void saveStyleNote(selChan.id)} disabled={styleNoteSaving} style={{ height: 34, padding: "0 16px", border: 0, borderRadius: 9, background: styleNoteSaving ? "#D8CDB6" : "#16120D", color: "#fff", fontSize: 12.5, fontWeight: 700, cursor: styleNoteSaving ? "not-allowed" : "pointer" }}>{styleNoteSaving ? "저장 중…" : "저장"}</button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div style={{ marginBottom: 20, background: "#fff", border: "1px solid #EAE1D0", borderRadius: 18, padding: 18 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: selInsights ? 14 : 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 30, height: 30, borderRadius: 8, background: "#16120D", color: ACCENT, display: "grid", placeItems: "center" }}>
                      <Icon d={["M4 20V10", "M10 20V4", "M16 20v-7", "M22 20H2"]} size={16} strokeWidth={2} />
                    </span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: "#16120D" }}>스타일 인사이트 <span style={{ color: "#A0957F", fontWeight: 600 }}>· 이 채널에서 잘 먹히는 패턴</span></span>
                  </div>
                  <button onClick={() => void loadInsights(selChan.id)} disabled={insightsBusy === selChan.id} style={{ height: 34, padding: "0 14px", border: "1px solid #E1D8C6", borderRadius: 10, background: "#fff", color: "#A04A2E", fontSize: 12.5, fontWeight: 700, cursor: insightsBusy === selChan.id ? "not-allowed" : "pointer" }}>
                    {insightsBusy === selChan.id ? "분석 중…" : selInsights ? "새로고침" : "분석하기"}
                  </button>
                </div>
                {selInsights && (
                  <div>
                    {selInsights.recommendations.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: selInsights.best_videos.length ? 16 : 0 }}>
                        {selInsights.recommendations.map((r, i) => (
                          <div key={i} style={{ display: "flex", gap: 9, padding: "10px 12px", borderRadius: 11, background: "#FBF7EF", border: "1px solid #EFE7D8" }}>
                            <Icon d={["M9 18h6", "M10 22h4", "M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2V17h6v-.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 2Z"]} size={16} stroke="#C83920" strokeWidth={1.8} style={{ flex: "0 0 auto", marginTop: 1 }} />
                            <span style={{ fontSize: 13, lineHeight: 1.5, color: "#5B5346" }}>{r}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {selInsights.best_videos.length > 0 && (
                      <div>
                        <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".04em", color: "#A0957F", textTransform: "uppercase", marginBottom: 10 }}>베스트 쇼츠 랭킹</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          {selInsights.best_videos.slice(0, 5).map(v => (
                            <a key={v.video_id} href={v.url} target="_blank" rel="noreferrer" style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 11, border: "1px solid #EFE7D8", background: "#fff", textDecoration: "none" }}>
                              <span style={{ width: 26, height: 26, borderRadius: 8, background: v.rank === 1 ? ACCENT : "#F3EEE3", color: v.rank === 1 ? "#fff" : "#7A7060", display: "grid", placeItems: "center", fontSize: 13, fontWeight: 800, fontFamily: "'Space Grotesk',sans-serif", flex: "0 0 auto" }}>{v.rank}</span>
                              <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700, color: "#16120D", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v.title}</span>
                              <span style={{ fontSize: 12, color: "#8C8273", flex: "0 0 auto", fontFamily: "'Space Grotesk',sans-serif" }}>{fmtCount(v.views)} 조회 · {v.duration_seconds}초</span>
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 380px", gap: 20, alignItems: "start" }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: ".03em", color: "#A0957F", textTransform: "uppercase", marginBottom: 12 }}>업로드된 영상</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {selChan.loaded && selChan.videos.length === 0 && (
                      <div style={{ padding: "36px 18px", borderRadius: 14, background: "#fff", border: "1px solid #EAE1D0", color: "#9A8F7E", fontSize: 13.5, textAlign: "center" }}>아직 표시할 업로드 영상이 없어요.</div>
                    )}
                    {selChan.videos.map(v => {
                      const po = POSTERS[v.posterIdx % POSTERS.length];
                      const on = v.id === openVideo;
                      const thumb = v.thumbnailUrl || (v.id ? `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg` : null);
                      return (
                        <article key={v.id} onClick={() => setOpenVideo(v.id)} style={{ display: "flex", gap: 14, padding: 12, borderRadius: 14, background: on ? "#FFF4EF" : "#fff", border: `1.5px solid ${on ? ACCENT : "#EAE1D0"}`, cursor: "pointer", transition: "all .14s" }}>
                          <div style={{ position: "relative", width: 84, height: 50, borderRadius: 9, background: po.g, flex: "0 0 auto", overflow: "hidden" }}>
                            {thumb && (
                              // eslint-disable-next-line @next/next/no-img-element -- external YouTube video thumbnail
                              <img src={thumb} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
                            )}
                            <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg,rgba(0,0,0,.05),rgba(0,0,0,.5))" }} />
                            <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}><svg width="20" height="20" viewBox="0 0 24 24" fill="#fff"><path d="M8 5.5v13l11-6.5-11-6.5Z" /></svg></span>
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#16120D", lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 1, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{v.title}</h3>
                            <div style={{ marginTop: 7, display: "flex", alignItems: "center", gap: 16, fontSize: 12, color: "#8C8273" }}>
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="2.6" /></svg>{v.views}</span>
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "#C83920" }}><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M7 11v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3Z" /></svg>{v.likes}</span>
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-12.7 7.4L3 21l2.1-5.3A8.5 8.5 0 1 1 21 11.5Z" /></svg>{v.comments}</span>
                              <span style={{ marginLeft: "auto", fontFamily: "'Space Mono',monospace", fontSize: 11, color: "#A0957F" }}>{v.date}</span>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </div>
                <div style={{ background: "#fff", border: "1px solid #EAE1D0", borderRadius: 18, padding: 18, position: "sticky", top: 14 }}>
                  {curVideo && (curVideo.thumbnailUrl || curVideo.id) && (
                    <a href={curVideo.url} target="_blank" rel="noreferrer" style={{ display: "block", position: "relative", width: "100%", aspectRatio: "16 / 9", borderRadius: 12, overflow: "hidden", marginBottom: 13, background: "#1A1510" }}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- external YouTube video thumbnail */}
                      <img src={curVideo.thumbnailUrl || `https://i.ytimg.com/vi/${curVideo.id}/hqdefault.jpg`} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
                      <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "linear-gradient(180deg,rgba(0,0,0,.05),rgba(0,0,0,.35))" }}>
                        <span style={{ width: 44, height: 44, borderRadius: "50%", background: "rgba(200,57,32,.92)", display: "grid", placeItems: "center" }}><svg width="20" height="20" viewBox="0 0 24 24" fill="#fff"><path d="M8 5.5v13l11-6.5-11-6.5Z" /></svg></span>
                      </span>
                    </a>
                  )}
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: "#16120D", lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{curVideo?.title}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, margin: "14px 0 16px" }}>
                    <div style={{ textAlign: "center", padding: "11px 6px", borderRadius: 11, background: "#FBF7EF", border: "1px solid #EFE7D8" }}>
                      <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 17, fontWeight: 700, color: "#16120D" }}>{curVideo?.views}</div>
                      <div style={{ fontSize: 10.5, color: "#9A8F7E", marginTop: 3 }}>조회수</div>
                    </div>
                    <div style={{ textAlign: "center", padding: "11px 6px", borderRadius: 11, background: "#FBF1EC", border: "1px solid #F0D9CE" }}>
                      <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 17, fontWeight: 700, color: "#C83920" }}>{curVideo?.likes}</div>
                      <div style={{ fontSize: 10.5, color: "#9A8F7E", marginTop: 3 }}>좋아요</div>
                    </div>
                    <div style={{ textAlign: "center", padding: "11px 6px", borderRadius: 11, background: "#FBF7EF", border: "1px solid #EFE7D8" }}>
                      <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 17, fontWeight: 700, color: "#16120D" }}>{curVideo?.comments}</div>
                      <div style={{ fontSize: 10.5, color: "#9A8F7E", marginTop: 3 }}>댓글</div>
                    </div>
                  </div>
                  <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".04em", color: "#A0957F", textTransform: "uppercase", marginBottom: 11 }}>댓글</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 13, maxHeight: 420, overflowY: "auto" }}>
                    {!openVideo || videoComments[openVideo] === undefined ? (
                      <div style={{ fontSize: 12.5, color: "#9A8F7E", padding: "8px 0" }}>댓글을 불러오는 중…</div>
                    ) : videoComments[openVideo].length === 0 ? (
                      <div style={{ fontSize: 12.5, color: "#9A8F7E", padding: "8px 0" }}>표시할 댓글이 없어요.</div>
                    ) : videoComments[openVideo].map((cm, i) => (
                      <div key={i} style={{ display: "flex", gap: 11 }}>
                        <div style={{ width: 32, height: 32, borderRadius: "50%", background: "#41372C", color: "#F4ECDD", display: "grid", placeItems: "center", fontSize: 13, fontWeight: 700, flex: "0 0 auto" }}>{(cm.author.replace(/^@/, "")[0] || "?").toUpperCase()}</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                            <span style={{ fontSize: 12.5, fontWeight: 700, color: "#16120D" }}>{cm.author}</span>
                            <span style={{ fontSize: 11, color: "#A0957F", fontFamily: "'Space Mono',monospace" }}>{cm.time}</span>
                          </div>
                          <div style={{ marginTop: 3, fontSize: 13, lineHeight: 1.5, color: "#5B5346" }}>{cm.text}</div>
                          <div style={{ marginTop: 6, display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, color: "#9A8F7E", fontWeight: 600 }}>
                            <Icon d={["M7 11v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3Z"]} size={13} strokeWidth={1.9} />{cm.likes}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {isAutopublish && (
            <div style={{ maxWidth: 760, margin: "0 auto", padding: "30px 28px 80px" }}>
              <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800, letterSpacing: "-.02em", color: "#16120D" }}>자동 배포</h1>
              <p style={{ margin: "8px 0 22px", fontSize: 14, color: "#8C8273" }}>쇼츠 자세히 보기에서 <b style={{ color: "#5B5346", fontWeight: 700 }}>예약 걸기</b>를 누르면 여기 대기열에 쌓여요. 정해진 시간이 되면 유튜브에 자동으로 올라갑니다.</p>
              <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "12px 14px", borderRadius: 13, background: "#fff", border: "1px solid #EAE1D0", marginBottom: 16 }}>
                <span style={{ width: 34, height: 34, borderRadius: 9, background: "#FF0000", display: "grid", placeItems: "center", flex: "0 0 auto" }}>
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="#fff"><path d="M21.6 7.2a2.8 2.8 0 0 0-2-2C17.9 4.8 12 4.8 12 4.8s-5.9 0-7.6.4a2.8 2.8 0 0 0-2 2A29 29 0 0 0 2 12a29 29 0 0 0 .4 4.8 2.8 2.8 0 0 0 2 2c1.7.4 7.6.4 7.6.4s5.9 0 7.6-.4a2.8 2.8 0 0 0 2-2A29 29 0 0 0 22 12a29 29 0 0 0-.4-4.8ZM10 15V9l5.2 3L10 15Z" /></svg>
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: "#16120D" }}>숏폼 스튜디오</span>
                  <span style={{ fontSize: 12, color: "#9A8F7E", fontFamily: "'Space Mono',monospace", marginLeft: 7 }}>@shortcut.studio</span>
                </div>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 700, color: "#1F8A5B", flex: "0 0 auto" }}>
                  <Icon d={["m5 12 5 5L20 6"]} size={13} strokeWidth={2.6} />연결됨
                </span>
              </div>
              <div style={{ background: "#fff", border: "1px solid #EAE1D0", borderRadius: 16, padding: 20 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "#16120D" }}>자동 발행 대기열</span>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: "#C83920", background: "#FBF1EC", border: "1px solid #F0D9CE", borderRadius: 999, padding: "3px 10px" }}>{autoQueue.length}개 예약됨</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {autoQueue.map((q, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 13px", borderRadius: 12, background: "#FBF7EF", border: "1px solid #EFE7D8" }}>
                      <span style={{ width: 34, height: 34, borderRadius: 9, background: "#16120D", color: "#fff", display: "grid", placeItems: "center", flex: "0 0 auto" }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 8v4l3 2" /><circle cx="12" cy="12" r="9" /></svg>
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#16120D", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{q.title}</div>
                        <div style={{ fontSize: 11, color: "#9A8F7E", marginTop: 2, fontFamily: "'Space Mono',monospace" }}>{q.day}일 {q.time} 예정</div>
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#C83920", background: "#fff", border: "1px solid #F0D9CE", borderRadius: 999, padding: "3px 10px", flex: "0 0 auto" }}>예약</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {editorClip && (
        <ShortcutEditor
          key={editorClip.id}
          clip={{ ...editorClip, channelName: defChannel?.name || "공식 채널명" }}
          onClose={() => setEditorClipId(null)}
          onSave={saveShortcutEditor}
          saving={applyBusy}
        />
      )}

      {/* CLIP MODAL */}
      {sel && (
        <div onClick={() => setSelectedClipId(null)} style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(20,15,10,.62)", backdropFilter: "blur(6px)", display: "grid", placeItems: "center", padding: 24, animation: "scFade .2s ease both" }}>
          <section onClick={e => e.stopPropagation()} style={{ position: "relative", width: "min(1040px,96vw)", maxHeight: "92vh", display: "grid", gridTemplateColumns: "340px minmax(0,1fr)", background: "#F6F1E8", borderRadius: 22, overflow: "hidden", boxShadow: "0 40px 90px -30px rgba(0,0,0,.7)", animation: "scPop .3s ease both" }}>
            {/* LEFT video stage */}
            <div style={{ background: "#16120D", padding: "22px 20px", display: "flex", flexDirection: "column" }}>
              <div style={{ position: "relative", flex: 1, borderRadius: 14, background: selPoster.g, overflow: "hidden", minHeight: 380 }}>
                {sel.videoUrl && (
                  <video src={sel.videoUrl} controls playsInline preload="metadata" poster={sel.thumbnailUrl} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", background: "#050505", zIndex: 1 }} />
                )}
                {!sel.videoUrl && sel.thumbnailUrl && <div style={{ position: "absolute", inset: 0, backgroundImage: `url(${sel.thumbnailUrl})`, backgroundSize: "cover", backgroundPosition: "center" }} />}
                <div style={{ position: "absolute", inset: 0, background: `radial-gradient(120% 60% at 50% 18%,${selPoster.glow},transparent 60%)`, pointerEvents: "none" }} />
                <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg,rgba(0,0,0,.34),transparent 30%,transparent 56%,rgba(0,0,0,.74))", pointerEvents: "none" }} />
                <div style={{ position: "absolute", top: 12, left: 12, zIndex: 2, display: "inline-flex", alignItems: "center", gap: 6, height: 28, padding: "0 11px 0 9px", borderRadius: 999, background: scoreColors(sel.score).bg, color: scoreColors(sel.score).fg }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 13h6l-1 9 9-12h-6l1-8Z" /></svg>
                  <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 14, fontWeight: 700 }}>{sel.score}</span>
                </div>
                {!sel.videoUrl && <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
                  <span style={{ width: 58, height: 58, borderRadius: "50%", background: "rgba(255,255,255,.92)", display: "grid", placeItems: "center", boxShadow: "0 10px 24px rgba(0,0,0,.5)", cursor: "pointer" }}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="#16120D"><path d="M8 5.5v13l11-6.5-11-6.5Z" /></svg>
                  </span>
                </div>}
                {!sel.videoUrl && (
                  <div style={{ position: "absolute", left: 14, right: 14, bottom: 14, zIndex: 2 }}>
                    <div style={{ height: 4, borderRadius: 999, background: "rgba(255,255,255,.28)", overflow: "hidden" }}><div style={{ height: "100%", width: "34%", background: ACCENT, borderRadius: 999 }} /></div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 7, fontFamily: "'Space Mono',monospace", fontSize: 11, color: "rgba(255,255,255,.78)" }}>
                      <span>{sel.start}</span><span>{sel.end}</span>
                    </div>
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                <a href={sel.videoUrl ? clipDownloadUrl(sel.id) : "#"} download onClick={e => { if (!sel.videoUrl) { e.preventDefault(); return; } showToast("다운로드를 시작했어요"); }} style={{ flex: 1, height: 44, border: "1px solid #3A3128", borderRadius: 11, background: "#221C16", color: "#F4ECDD", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 13.5, fontWeight: 700, textDecoration: "none", cursor: "pointer" }}>
                  <Icon d={["M12 3v12m0 0 4-4m-4 4-4-4", "M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"]} size={16} strokeWidth={1.9} />MP4 다운로드
                </a>
                <button onClick={() => setTab("youtube")} style={{ flex: 1, height: 44, border: 0, borderRadius: 11, background: ACCENT, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 13.5, fontWeight: 700, cursor: "pointer", boxShadow: "0 10px 22px -12px rgba(255,74,28,.9)" }}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M21.6 7.2a2.8 2.8 0 0 0-2-2C17.9 4.8 12 4.8 12 4.8s-5.9 0-7.6.4a2.8 2.8 0 0 0-2 2A29 29 0 0 0 2 12a29 29 0 0 0 .4 4.8 2.8 2.8 0 0 0 2 2c1.7.4 7.6.4 7.6.4s5.9 0 7.6-.4a2.8 2.8 0 0 0 2-2A29 29 0 0 0 22 12a29 29 0 0 0-.4-4.8ZM10 15V9l5.2 3L10 15Z" /></svg>유튜브 배포
                </button>
              </div>
            </div>

            {/* RIGHT editor */}
            <div style={{ padding: "24px 26px", overflow: "auto", maxHeight: "92vh", position: "relative" }}>
              <button onClick={() => setSelectedClipId(null)} style={{ position: "absolute", top: 16, right: 16, width: 36, height: 36, border: "1px solid #E1D8C6", borderRadius: 10, background: "#fff", color: "#5B5346", display: "grid", placeItems: "center", cursor: "pointer", zIndex: 2 }}>
                <Icon d={["M6 6l12 12", "M18 6 6 18"]} size={17} strokeWidth={2} />
              </button>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 34, fontWeight: 700, color: ACCENT, lineHeight: 1 }}>{sel.score}</span>
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".06em", color: "#A0957F", textTransform: "uppercase" }}>바이럴 점수</span>
                <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 600, color: "#7A7060", background: "#F3EEE3", border: "1px solid #EAE1D0", borderRadius: 999, padding: "3px 9px" }}>리비전 {revisions[sel.id] || 1}</span>
              </div>
              <h2 style={{ margin: "6px 0 0", fontSize: 21, fontWeight: 800, lineHeight: 1.32, letterSpacing: "-.01em", color: "#16120D", paddingRight: 44 }}>{sel.title}</h2>
              <p style={{ margin: "10px 0 18px", fontSize: 13.5, lineHeight: 1.6, color: "#8C8273" }}>{sel.reason}</p>
              <button onClick={() => openClipEditor(sel.id)} style={{ width: "100%", height: 44, border: "1px solid #F0D9CE", borderRadius: 12, background: "#FFF4EF", color: "#C83920", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 13.5, fontWeight: 800, cursor: "pointer", marginBottom: 14 }}>
                <Icon d={["M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7", "M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z"]} size={16} strokeWidth={1.9} />풀스크린 편집기 열기
              </button>

              {/* tabs */}
              <div style={{ display: "flex", gap: 6, padding: 4, background: "#EBE3D4", borderRadius: 12, marginBottom: 18 }}>
                {(["titles", "overlay", "youtube", "ppl"] as const).map(t => {
                  const labels = { titles: "제목", overlay: "자막 스타일", youtube: "유튜브", ppl: "PPL" };
                  const on = tab === t;
                  return (
                    <button key={t} onClick={() => setTab(t)} style={{ flex: 1, height: 38, border: 0, borderRadius: 9, background: on ? "#fff" : "transparent", color: on ? "#16120D" : "#7A7060", fontSize: 13.5, fontWeight: 700, cursor: "pointer", boxShadow: on ? "0 2px 6px rgba(40,30,20,.1)" : "none", transition: "all .15s" }}>{labels[t]}</button>
                  );
                })}
              </div>

              {tab === "ppl" && (() => {
                const ppl = pplData[sel.id] ?? sel.pplAnalysis ?? null;
                const fmt1 = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
                return (
                  <div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 6 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 700, color: "#16120D" }}>PPL 상품 분석 <span style={{ color: "#A0957F" }}>· 화면 속 브랜드·상품 감지</span></div>
                      <button onClick={() => void runPpl()} disabled={pplBusy || !sel.videoUrl} style={{ height: 32, padding: "0 12px", border: "1px solid #E1D8C6", borderRadius: 9, background: "#fff", color: "#A04A2E", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, cursor: pplBusy || !sel.videoUrl ? "not-allowed" : "pointer", opacity: pplBusy || !sel.videoUrl ? 0.6 : 1, whiteSpace: "nowrap" }}>
                        <Icon d={["M3 12a9 9 0 0 1 15-6.7L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-15 6.7L3 16", "M3 21v-5h5"]} size={14} strokeWidth={2} style={pplBusy ? { animation: "scSpin 1s linear infinite" } : undefined} />
                        {pplBusy ? "분석 중…" : ppl ? "다시 분석" : "분석 시작"}
                      </button>
                    </div>
                    <p style={{ margin: "0 0 14px", fontSize: 12.5, lineHeight: 1.6, color: "#9A8F7E" }}>재생되는 쇼츠에서 브랜드·상품을 인식해 화면 위에 박스로 표시하고, 협찬·제휴에 쓸 노출 리포트를 만들어요.</p>

                    {!sel.videoUrl && (
                      <div style={{ padding: "16px 14px", borderRadius: 12, background: "#FBF3E3", border: "1px solid #EFD9A8", color: "#8C6A1E", fontSize: 12.5, lineHeight: 1.5 }}>렌더된 쇼츠 영상이 있어야 PPL 분석을 할 수 있어요. 먼저 클립을 렌더해 주세요.</div>
                    )}

                    {pplBusy && (
                      <div style={{ padding: "18px 14px", borderRadius: 12, background: "#fff", border: "1px solid #EAE1D0", color: "#7A7060", fontSize: 12.5, display: "flex", alignItems: "center", gap: 10 }}>
                        <Icon d={["M3 12a9 9 0 0 1 15-6.7L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-15 6.7L3 16", "M3 21v-5h5"]} size={16} strokeWidth={2} style={{ animation: "scSpin 1s linear infinite" }} />
                        프레임을 추출하고 Gemini가 상품을 인식하는 중이에요… (10~30초)
                      </div>
                    )}

                    {!ppl && !pplBusy && sel.videoUrl && (
                      <div style={{ padding: "22px 16px", textAlign: "center", borderRadius: 12, background: "#fff", border: "1px dashed #D9CEB6", color: "#9A8F7E", fontSize: 12.5 }}>아직 분석하지 않았어요. <b style={{ color: "#A04A2E" }}>분석 시작</b>을 눌러 화면 속 상품을 찾아보세요.</div>
                    )}

                    {ppl && (
                      <>
                        <PplOverlayPlayer analysis={ppl} videoUrl={sel.videoUrl} poster={sel.sourceThumbnailUrl || sel.thumbnailUrl} />
                        <div style={{ margin: "10px 0 16px", fontSize: 11, color: "#9A8F7E", textAlign: "center", fontFamily: "'Space Mono',monospace" }}>{ppl.frame_count}개 프레임 분석 · 상품 {ppl.products.length}개 감지 · 재생하면 박스가 따라와요</div>

                        {ppl.products.length === 0 ? (
                          <div style={{ padding: "18px 14px", textAlign: "center", borderRadius: 12, background: "#fff", border: "1px solid #EAE1D0", color: "#9A8F7E", fontSize: 12.5 }}>감지된 브랜드·상품이 없어요. 로고가 또렷한 구간이 있다면 다시 분석해 보세요.</div>
                        ) : (
                          <>
                            <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: ".04em", color: "#A0957F", textTransform: "uppercase", margin: "0 0 9px" }}>협찬 노출 리포트</div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
                              {ppl.products.map((p, i) => (
                                <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 13px", borderRadius: 12, background: "#fff", border: "1px solid #EAE1D0" }}>
                                  <span style={{ flex: "0 0 auto", width: 12, height: 12, borderRadius: 3, background: PPL_BOX_COLORS[i % PPL_BOX_COLORS.length] }} />
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontSize: 13.5, fontWeight: 700, color: "#16120D", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.brand} · {p.product}</div>
                                    <div style={{ marginTop: 3, fontSize: 11, color: "#9A8F7E", fontFamily: "'Space Mono',monospace" }}>노출 {fmt1(p.exposure_seconds)}초 · {fmt1(p.first_seen)}s–{fmt1(p.last_seen)}s{p.category ? ` · ${p.category}` : ""}</div>
                                  </div>
                                  <span style={{ flex: "0 0 auto", fontSize: 11, fontWeight: 700, color: "#7A7060", background: "#F3EEE3", border: "1px solid #EAE1D0", borderRadius: 999, padding: "3px 9px" }}>{Math.round(p.confidence * 100)}%</span>
                                </div>
                              ))}
                            </div>

                            <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: ".04em", color: "#A0957F", textTransform: "uppercase", margin: "0 0 9px" }}>상품 태깅 · 제휴 링크</div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                              {ppl.products.map(p => {
                                const key = `${sel.id}|${p.id}`;
                                return (
                                  <div key={p.id}>
                                    <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#16120D", marginBottom: 5 }}>{p.brand} · {p.product}</label>
                                    <input value={pplLinkDraft[key] ?? p.affiliate_url ?? ""} onChange={e => setPplLinkDraft(s => ({ ...s, [key]: e.target.value }))} placeholder="제휴/쇼핑 링크 URL을 붙여넣으세요" style={{ ...PUB_INPUT }} />
                                  </div>
                                );
                              })}
                            </div>
                            <button onClick={() => void savePpl()} style={{ marginTop: 14, width: "100%", height: 42, border: 0, borderRadius: 11, background: "#16120D", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                              <Icon d={["M5 12l5 5L20 7"]} size={16} strokeWidth={2.2} />제휴 링크 저장
                            </button>
                          </>
                        )}
                      </>
                    )}
                  </div>
                );
              })()}

              {tab === "titles" && (
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: "#16120D" }}>AI 추천 제목 <span style={{ color: "#A0957F" }}>· 마음에 드는 걸 고르세요</span></div>
                    <button onClick={() => void regenTitles()} disabled={titleBusy} style={{ height: 32, padding: "0 12px", border: "1px solid #E1D8C6", borderRadius: 9, background: "#fff", color: "#A04A2E", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, cursor: titleBusy ? "not-allowed" : "pointer", opacity: titleBusy ? 0.6 : 1 }}>
                      <Icon d={["M3 12a9 9 0 0 1 15-6.7L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-15 6.7L3 16", "M3 21v-5h5"]} size={14} strokeWidth={2} style={titleBusy ? { animation: "scSpin 1s linear infinite" } : undefined} />{titleBusy ? "생성 중…" : "5개 다시 생성"}
                    </button>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {rotatedTitles.map(o => {
                      const on = o.id === chosenTitleId;
                      return (
                        <button key={o.id} onClick={() => setChosenTitle(s => ({ ...s, [sel.id]: o.id }))} style={{ textAlign: "left", padding: "13px 15px", border: `1.5px solid ${on ? ACCENT : "#E6DDCB"}`, borderRadius: 13, background: on ? "#FFF4EF" : "#fff", cursor: "pointer", display: "flex", gap: 12, alignItems: "flex-start", transition: "all .15s" }}>
                          <span style={{ flex: "0 0 auto", width: 20, height: 20, borderRadius: "50%", border: `2px solid ${on ? ACCENT : "#CFC4AE"}`, background: on ? ACCENT : "transparent", marginTop: 2, display: "grid", placeItems: "center" }}>
                            {on && <Icon d={["m5 12 5 5L20 6"]} size={11} stroke="#fff" strokeWidth={3} />}
                          </span>
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ display: "block", fontSize: 14.5, fontWeight: 700, color: "#16120D", lineHeight: 1.4 }}>{o.text}</span>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 11.5, color: "#A04A2E", fontWeight: 600 }}>
                              <Icon d={["M4 6h16v12H4z", "M4 10h16"]} size={12} strokeWidth={2} />자막: {o.overlay}
                            </span>
                            <span style={{ display: "block", marginTop: 4, fontSize: 11.5, color: "#9A8F7E" }}>{o.note}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid #EFE7D8" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 700, color: "#16120D" }}>썸네일 문구 <span style={{ color: "#A0957F" }}>· 영상 위 굵은 자막</span></div>
                      <button onClick={() => void regenThumbs()} disabled={thumbBusy} style={{ height: 32, padding: "0 12px", border: "1px solid #E1D8C6", borderRadius: 9, background: "#fff", color: "#A04A2E", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, cursor: thumbBusy ? "not-allowed" : "pointer", opacity: thumbBusy ? 0.6 : 1 }}>
                        <Icon d={["M3 12a9 9 0 0 1 15-6.7L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-15 6.7L3 16", "M3 21v-5h5"]} size={14} strokeWidth={2} style={thumbBusy ? { animation: "scSpin 1s linear infinite" } : undefined} />{thumbBusy ? "생성 중…" : "5개 생성"}
                      </button>
                    </div>
                    {sel.thumbTextOptions.length === 0 ? (
                      <div style={{ fontSize: 12.5, color: "#9A8F7E", padding: "10px 12px", border: "1px dashed #E1D8C6", borderRadius: 11, background: "#FBF7EF" }}>‘5개 생성’을 눌러 썸네일 문구 후보를 만들어 보세요.</div>
                    ) : (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                        {sel.thumbTextOptions.map(t => {
                          const on = (chosenThumb[sel.id] || "") === t.text;
                          return (
                            <button key={t.id} title={t.note} onClick={() => setChosenThumb(s => ({ ...s, [sel.id]: on ? "" : t.text }))} style={{ padding: "9px 13px", border: `1.5px solid ${on ? ACCENT : "#E6DDCB"}`, borderRadius: 999, background: on ? "#FFF4EF" : "#fff", color: on ? "#A04A2E" : "#16120D", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>{t.text}</button>
                          );
                        })}
                      </div>
                    )}
                    <div style={{ marginTop: 8, fontSize: 11.5, color: "#9A8F7E" }}>선택한 문구는 미리보기 자막에 반영되고, 아래 ‘이 설정으로 렌더’ 시 영상에 입혀져요.</div>
                  </div>
                </div>
              )}

              {tab === "overlay" && (
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: "#16120D", marginBottom: 12 }}>자막 스타일 <span style={{ color: "#A0957F" }}>· 영상 위에 입힐 텍스트 배지</span></div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 8, marginBottom: 18 }}>
                    {TEMPLATES.map(tpl => {
                      const on = template === tpl.id;
                      return (
                        <button key={tpl.id} onClick={() => setTemplate(tpl.id)} style={{ textAlign: "left", padding: "13px 14px", border: `1.5px solid ${on ? ACCENT : "#E6DDCB"}`, borderRadius: 13, background: on ? "#FFF4EF" : "#fff", cursor: "pointer", transition: "all .15s" }}>
                          <span style={{ display: "block", fontSize: 13.5, fontWeight: 700, color: "#16120D" }}>{tpl.label}</span>
                          <span style={{ display: "block", marginTop: 5, fontSize: 11.5, color: "#9A8F7E" }}>{tpl.badge}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#16120D", marginBottom: 10 }}>위치</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 18 }}>
                    {POSITIONS.map(p => {
                      const on = position === p.id;
                      return (
                        <button key={p.id} onClick={() => setPosition(p.id)} style={{ height: 32, padding: "0 13px", border: `1px solid ${on ? "#16120D" : "#E1D8C6"}`, borderRadius: 999, background: on ? "#16120D" : "#fff", color: on ? "#fff" : "#5B5346", fontSize: 12.5, fontWeight: 600, cursor: "pointer", transition: "all .15s" }}>{p.label}</button>
                      );
                    })}
                  </div>
                  <label style={{ display: "flex", alignItems: "center", gap: 12, padding: "15px 16px", border: "1.5px dashed #D8CDB6", borderRadius: 13, background: "#fff", cursor: "pointer" }}>
                    <input type="file" accept="image/png,image/jpeg" style={{ display: "none" }} onChange={e => { if (e.target.files?.[0]) { setHasOverlayAsset(true); showToast("오버레이 이미지를 올렸어요"); } }} />
                    <span style={{ width: 40, height: 40, borderRadius: 10, background: "#F3EEE3", color: "#A04A2E", display: "grid", placeItems: "center", flex: "0 0 auto" }}>
                      <Icon d={["M12 16V4", "M8 8l4-4 4 4", "M4 18v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1"]} size={20} />
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 13.5, fontWeight: 700, color: "#16120D" }}>{hasOverlayAsset ? "이미지 업로드 완료 ✓" : "이미지 직접 업로드"}</span>
                      <span style={{ display: "block", fontSize: 11.5, color: "#9A8F7E", marginTop: 2 }}>내 로고나 워터마크 PNG/JPG를 올려 합성하세요</span>
                    </span>
                  </label>
                </div>
              )}

              {tab === "youtube" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ border: "1px solid #E6DDCB", borderRadius: 13, background: "#fff", padding: 14 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                      <span style={{ width: 26, height: 26, borderRadius: 7, background: "#FF0000", display: "grid", placeItems: "center", flex: "0 0 auto" }}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="#fff"><path d="M21.6 7.2a2.8 2.8 0 0 0-2-2C17.9 4.8 12 4.8 12 4.8s-5.9 0-7.6.4a2.8 2.8 0 0 0-2 2A29 29 0 0 0 2 12a29 29 0 0 0 .4 4.8 2.8 2.8 0 0 0 2 2c1.7.4 7.6.4 7.6.4s5.9 0 7.6-.4a2.8 2.8 0 0 0 2-2A29 29 0 0 0 22 12a29 29 0 0 0-.4-4.8ZM10 15V9l5.2 3L10 15Z" /></svg>
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#16120D" }}>유튜브 발행</span>
                      <span style={{ marginLeft: "auto", fontSize: 11, color: "#9A8F7E", fontFamily: "'Space Mono',monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 150 }}>{defChannel ? defChannel.name : "채널 미연결"}</span>
                    </div>

                    {selPublish && (() => {
                      const meta = PUBLISH_STATUS_META[selPublish.status] || PUBLISH_STATUS_META.pending;
                      return (
                        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "11px 12px", borderRadius: 11, background: meta.bg, border: `1px solid ${meta.bd}`, marginBottom: 10 }}>
                          {selPublishBusy
                            ? <Icon d={["M12 3a9 9 0 1 0 9 9"]} size={17} stroke={meta.color} strokeWidth={2.4} style={{ animation: "scSpin 1s linear infinite", flex: "0 0 auto" }} />
                            : selPublish.status === "failed"
                              ? <Icon d={["M12 8v5", "M12 16h.01"]} size={17} stroke={meta.color} strokeWidth={2.2} style={{ flex: "0 0 auto" }} />
                              : <Icon d={["m5 12 5 5L20 6"]} size={17} stroke={meta.color} strokeWidth={2.6} style={{ flex: "0 0 auto" }} />}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: meta.color }}>{meta.label}</div>
                            {selPublish.status === "scheduled" && selPublish.schedule_date && (
                              <div style={{ fontSize: 11.5, color: "#5B5346", marginTop: 2, fontFamily: "'Space Mono',monospace" }}>{fmtStamp(selPublish.schedule_date)} 공개 예정</div>
                            )}
                            {selPublish.status === "failed" && selPublish.error && (
                              <div style={{ fontSize: 11.5, color: "#9A5046", marginTop: 2, lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{selPublish.error}</div>
                            )}
                            {selPublish.channel_title && selPublish.status !== "failed" && (
                              <div style={{ fontSize: 11.5, color: "#9A8F7E", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{selPublish.channel_title}</div>
                            )}
                          </div>
                          {(selPublish.status === "published" || selPublish.status === "scheduled") && selPublish.youtube_url && (
                            <a href={selPublish.youtube_url} target="_blank" rel="noreferrer" style={{ flex: "0 0 auto", height: 32, padding: "0 12px", display: "inline-flex", alignItems: "center", gap: 5, borderRadius: 9, background: "#fff", border: `1px solid ${meta.bd}`, color: meta.color, fontSize: 12, fontWeight: 700, textDecoration: "none" }}>
                              <Icon d={["M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6", "M15 3h6v6", "M10 14 21 3"]} size={13} strokeWidth={2} />영상 보기
                            </a>
                          )}
                          {selPublish.status === "failed" && (
                            <button onClick={() => { const cached = publishDraftCache[sel.id]; if (cached) setPublishDraft(cached); else openPublishDraft("now"); }} style={{ flex: "0 0 auto", height: 32, padding: "0 13px", borderRadius: 9, border: 0, background: meta.color, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>재시도</button>
                          )}
                        </div>
                      );
                    })()}

                    {channels.length === 0 ? (
                      <button onClick={connectYouTube} style={{ width: "100%", height: 44, border: 0, borderRadius: 11, background: "#16120D", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 13.5, fontWeight: 700, cursor: "pointer" }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="#fff"><path d="M21.6 7.2a2.8 2.8 0 0 0-2-2C17.9 4.8 12 4.8 12 4.8s-5.9 0-7.6.4a2.8 2.8 0 0 0-2 2A29 29 0 0 0 2 12a29 29 0 0 0 .4 4.8 2.8 2.8 0 0 0 2 2c1.7.4 7.6.4 7.6.4s5.9 0 7.6-.4a2.8 2.8 0 0 0 2-2A29 29 0 0 0 22 12a29 29 0 0 0-.4-4.8ZM10 15V9l5.2 3L10 15Z" /></svg>
                        채널 연결하고 발행하기
                      </button>
                    ) : (
                      <div style={{ display: "flex", gap: 8 }}>
                        <button onClick={() => openPublishDraft("schedule")} disabled={selPublishBusy} style={{ flex: 1, height: 44, border: "1px solid #2A231B", borderRadius: 11, background: "#16120D", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 13.5, fontWeight: 700, cursor: selPublishBusy ? "not-allowed" : "pointer", opacity: selPublishBusy ? 0.55 : 1 }}>
                          <Icon d={["M12 8v4l3 2", "M3 4.5h18v16H3z", "M3 9h18"]} size={16} strokeWidth={1.9} />예약 발행
                        </button>
                        <button onClick={() => openPublishDraft("now")} disabled={selPublishBusy} style={{ flex: 1, height: 44, border: 0, borderRadius: 11, background: ACCENT, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 13.5, fontWeight: 700, cursor: selPublishBusy ? "not-allowed" : "pointer", boxShadow: "0 10px 22px -12px rgba(255,74,28,.9)", opacity: selPublishBusy ? 0.55 : 1 }}>
                          <Icon d={["M12 3v12m0 0 4-4m-4 4-4-4", "M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"]} size={16} strokeWidth={1.9} />지금 발행
                        </button>
                      </div>
                    )}
                  </div>
                  <div style={{ border: "1px solid #E6DDCB", borderRadius: 13, background: "#fff", padding: "13px 14px" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 6 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".05em", color: "#A0957F", textTransform: "uppercase" }}>유튜브 제목</span>
                      <button onClick={() => copy(sel.yt.title, "유튜브 제목")} style={{ width: 28, height: 28, border: "1px solid #E1D8C6", borderRadius: 8, background: "#FBF7EF", color: "#7A7060", display: "grid", placeItems: "center", cursor: "pointer" }} title="복사">
                        <Icon d={["M9 9h11v11H9z", "M5 15V5a2 2 0 0 1 2-2h10"]} size={14} strokeWidth={1.8} />
                      </button>
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#16120D", lineHeight: 1.45 }}>{sel.yt.title}</div>
                  </div>
                  <div style={{ border: "1px solid #E6DDCB", borderRadius: 13, background: "#fff", padding: "13px 14px" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 9 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".05em", color: "#A0957F", textTransform: "uppercase" }}>태그 · 해시태그</span>
                      <button onClick={() => copy(sel.yt.tags.map(t => "#" + t).join(" "), "태그")} style={{ width: 28, height: 28, border: "1px solid #E1D8C6", borderRadius: 8, background: "#FBF7EF", color: "#7A7060", display: "grid", placeItems: "center", cursor: "pointer" }} title="복사">
                        <Icon d={["M9 9h11v11H9z", "M5 15V5a2 2 0 0 1 2-2h10"]} size={14} strokeWidth={1.8} />
                      </button>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {sel.yt.tags.map(t => (
                        <span key={t} style={{ fontSize: 12, fontWeight: 600, color: "#A04A2E", background: "#FBF1EC", border: "1px solid #F0D9CE", borderRadius: 999, padding: "4px 10px" }}>#{t}</span>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <div style={{ marginTop: 20, paddingTop: 18, borderTop: "1px solid #E4DBC9", display: "flex", flexDirection: "column", gap: 12 }}>
                {trimDraft && trimDraft.clipId === sel.id ? (
                  <div style={{ padding: 14, border: "1px solid #E6DDCB", borderRadius: 13, background: "#FBF7EF" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 12, fontSize: 13, fontWeight: 700, color: "#16120D" }}>
                      <Icon d={["M7 4v16", "M17 4v16", "M3 8h4", "M17 8h4", "M3 16h4", "M17 16h4"]} size={15} stroke="#C83920" strokeWidth={1.9} />구간 미세조정 (초)
                    </div>
                    <div style={{ display: "flex", gap: 12 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#A0957F", marginBottom: 5 }}>시작</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <button onClick={() => setTrimDraft(d => (d ? { ...d, start: Math.max(0, Number((d.start - 0.5).toFixed(1))) } : d))} style={NUDGE_BTN}>−</button>
                          <input type="number" step={0.1} min={0} value={trimDraft.start} onChange={e => setTrimDraft(d => (d ? { ...d, start: Math.max(0, Number(e.target.value) || 0) } : d))} style={TRIM_INPUT} />
                          <button onClick={() => setTrimDraft(d => (d ? { ...d, start: Number((d.start + 0.5).toFixed(1)) } : d))} style={NUDGE_BTN}>+</button>
                        </div>
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#A0957F", marginBottom: 5 }}>끝</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <button onClick={() => setTrimDraft(d => (d ? { ...d, end: Math.max(0, Number((d.end - 0.5).toFixed(1))) } : d))} style={NUDGE_BTN}>−</button>
                          <input type="number" step={0.1} min={0} value={trimDraft.end} onChange={e => setTrimDraft(d => (d ? { ...d, end: Math.max(0, Number(e.target.value) || 0) } : d))} style={TRIM_INPUT} />
                          <button onClick={() => setTrimDraft(d => (d ? { ...d, end: Number((d.end + 0.5).toFixed(1)) } : d))} style={NUDGE_BTN}>+</button>
                        </div>
                      </div>
                    </div>
                    <div style={{ marginTop: 8, fontSize: 11.5, color: "#9A8F7E" }}>길이 {Math.max(0, trimDraft.end - trimDraft.start).toFixed(1)}초 · 다시 자르면 자막도 새 구간에 맞춰 렌더돼요.</div>
                    <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                      <button onClick={() => setTrimDraft(null)} disabled={retrimBusy} style={{ flex: 1, height: 42, border: "1px solid #E1D8C6", borderRadius: 11, background: "#fff", color: "#5B5346", fontSize: 13.5, fontWeight: 700, cursor: retrimBusy ? "not-allowed" : "pointer" }}>취소</button>
                      <button onClick={() => void doRetrim()} disabled={retrimBusy} style={{ flex: 1.5, height: 42, border: 0, borderRadius: 11, background: "#16120D", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 13.5, fontWeight: 700, cursor: retrimBusy ? "not-allowed" : "pointer", opacity: retrimBusy ? 0.6 : 1 }}>
                        {retrimBusy ? "자르는 중…" : "이 구간으로 다시 자르기"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button onClick={openTrim} style={{ height: 42, border: "1px solid #E1D8C6", borderRadius: 12, background: "#fff", color: "#5B5346", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 13.5, fontWeight: 700, cursor: "pointer" }}>
                    <Icon d={["M7 4v16", "M17 4v16", "M3 8h4", "M17 8h4", "M3 16h4", "M17 16h4"]} size={16} stroke="#C83920" strokeWidth={1.9} />컷 시작/끝 미세조정 · {sel.start} – {sel.end}
                  </button>
                )}
                <button onClick={() => void doApplyCreative()} disabled={applyBusy} style={{ height: 46, border: 0, borderRadius: 12, background: applyBusy ? "#D8CDB6" : ACCENT, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 9, fontSize: 14.5, fontWeight: 700, cursor: applyBusy ? "not-allowed" : "pointer", boxShadow: applyBusy ? "none" : "0 12px 26px -12px rgba(255,74,28,.9)" }}>
                  {applyBusy
                    ? <><Icon d={["M12 3a9 9 0 1 0 9 9"]} size={17} stroke="#fff" strokeWidth={2.4} style={{ animation: "scSpin 1s linear infinite" }} />렌더 중…</>
                    : <><Icon d={["M18 5.03l-4.53 4.53", "M5 19h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2Z"]} size={17} strokeWidth={1.9} />이 설정으로 렌더</>}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}

      {/* CHANNEL CONFIRM MODAL */}
      {channelDraftId && (
        <div style={{ position: "fixed", inset: 0, zIndex: 90, display: "grid", placeItems: "center", padding: 22, background: "rgba(22,18,13,.42)", backdropFilter: "blur(8px)" }}>
          <div style={{ width: "min(560px,100%)", maxHeight: "min(720px,calc(100vh - 44px))", overflow: "auto", borderRadius: 18, background: "#FFFDF8", border: "1px solid #E6DDCB", boxShadow: "0 30px 80px -36px rgba(22,18,13,.65)", padding: 22, animation: "scPop .2s ease both" }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 18 }}>
              <span style={{ width: 42, height: 42, borderRadius: 12, background: "#FF0000", display: "grid", placeItems: "center", flex: "0 0 auto" }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff"><path d="M21.6 7.2a2.8 2.8 0 0 0-2-2C17.9 4.8 12 4.8 12 4.8s-5.9 0-7.6.4a2.8 2.8 0 0 0-2 2A29 29 0 0 0 2 12a29 29 0 0 0 .4 4.8 2.8 2.8 0 0 0 2 2c1.7.4 7.6.4 7.6.4s5.9 0 7.6-.4a2.8 2.8 0 0 0 2-2A29 29 0 0 0 22 12a29 29 0 0 0-.4-4.8ZM10 15V9l5.2 3L10 15Z" /></svg>
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h2 style={{ margin: 0, fontSize: 21, fontWeight: 800, color: "#16120D" }}>유튜브 채널 추가</h2>
                <p style={{ margin: "6px 0 0", fontSize: 13.5, lineHeight: 1.5, color: "#7A7060" }}>
                  로그인한 Google 계정에서 채널을 불러왔어요. 추가할 채널을 확인해 주세요.
                </p>
              </div>
              <button onClick={() => void closeChannelDraft()} disabled={channelDraftSaving} style={{ width: 34, height: 34, border: "1px solid #E1D8C6", borderRadius: 10, background: "#fff", color: "#7A7060", display: "grid", placeItems: "center", cursor: channelDraftSaving ? "not-allowed" : "pointer", flex: "0 0 auto" }} title="닫기">
                <Icon d={["M6 6l12 12", "M18 6 6 18"]} size={16} strokeWidth={2} />
              </button>
            </div>

            {channelDraftLoading ? (
              <div style={{ display: "grid", placeItems: "center", minHeight: 180, color: "#8C8273", fontSize: 14 }}>
                채널을 불러오는 중…
              </div>
            ) : channelDraft && channelDraft.channels.length > 0 ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 12px", borderRadius: 12, background: "#FBF7EF", border: "1px solid #EFE7D8", marginBottom: 14 }}>
                  {channelDraft.google_account_picture_url ? (
                    // eslint-disable-next-line @next/next/no-img-element -- Google profile avatar
                    <img src={channelDraft.google_account_picture_url} alt="" style={{ width: 30, height: 30, borderRadius: "50%", objectFit: "cover", flex: "0 0 auto" }} />
                  ) : (
                    <span style={{ width: 30, height: 30, borderRadius: "50%", background: "#41372C", color: "#F4ECDD", display: "grid", placeItems: "center", fontSize: 12, fontWeight: 800, flex: "0 0 auto" }}>{(channelDraft.google_account_name || channelDraft.google_account_email || "G").slice(0, 1)}</span>
                  )}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#16120D", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{channelDraft.google_account_name || "Google 계정"}</div>
                    <div style={{ fontSize: 12, color: "#8C8273", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{channelDraft.google_account_email || "YouTube 권한 연결됨"}</div>
                  </div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                  {channelDraft.channels.map((candidate, idx) => {
                    const selected = selectedDraftChannelIds.includes(candidate.channel_id);
                    return (
                      <button key={candidate.channel_id} onClick={() => toggleDraftChannel(candidate.channel_id)}
                        style={{ width: "100%", display: "flex", alignItems: "center", gap: 13, padding: 12, borderRadius: 13, border: `1.5px solid ${selected ? ACCENT : "#E6DDCB"}`, background: selected ? "#FFF4EF" : "#fff", color: "#16120D", textAlign: "left", cursor: "pointer" }}>
                        {candidate.thumbnail_url ? (
                          // eslint-disable-next-line @next/next/no-img-element -- external YouTube avatar
                          <img src={candidate.thumbnail_url} alt="" style={{ width: 46, height: 46, borderRadius: "50%", objectFit: "cover", flex: "0 0 auto" }} />
                        ) : (
                          <span style={{ width: 46, height: 46, borderRadius: "50%", background: CHANNEL_COLORS[idx % CHANNEL_COLORS.length], color: "#fff", display: "grid", placeItems: "center", fontSize: 18, fontWeight: 800, flex: "0 0 auto" }}>{candidate.title.slice(0, 1)}</span>
                        )}
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                            <span style={{ fontSize: 15, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{candidate.title}</span>
                            {candidate.already_connected && (
                              <span style={{ flex: "0 0 auto", borderRadius: 999, background: "#E7F5EE", color: "#1F8A5B", border: "1px solid #BFE6D2", padding: "2px 8px", fontSize: 11, fontWeight: 700 }}>연결됨</span>
                            )}
                          </span>
                          <span style={{ display: "block", marginTop: 4, fontSize: 12, color: "#8C8273", fontFamily: "'Space Mono',monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{candidate.channel_id}</span>
                        </span>
                        <span style={{ width: 22, height: 22, borderRadius: "50%", border: `2px solid ${selected ? ACCENT : "#D8CDB6"}`, background: selected ? ACCENT : "#fff", display: "grid", placeItems: "center", flex: "0 0 auto" }}>
                          {selected && <Icon d="m6 11 3 3 7-7" size={14} stroke="#fff" strokeWidth={2.6} />}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div style={{ marginTop: 18, display: "flex", gap: 10 }}>
                  <button onClick={() => void closeChannelDraft()} disabled={channelDraftSaving} style={{ flex: 1, height: 44, border: "1px solid #E1D8C6", borderRadius: 11, background: "#fff", color: "#5B5346", fontSize: 13.5, fontWeight: 700, cursor: channelDraftSaving ? "not-allowed" : "pointer" }}>취소</button>
                  <button onClick={() => void confirmChannelDraft()} disabled={selectedDraftChannels.length === 0 || channelDraftSaving} style={{ flex: 1.4, height: 44, border: 0, borderRadius: 11, background: selectedDraftChannels.length > 0 && !channelDraftSaving ? ACCENT : "#D8CDB6", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 13.5, fontWeight: 800, cursor: selectedDraftChannels.length > 0 && !channelDraftSaving ? "pointer" : "not-allowed", boxShadow: selectedDraftChannels.length > 0 && !channelDraftSaving ? "0 10px 22px -12px rgba(255,74,28,.9)" : "none" }}>
                    {channelDraftSaving ? "추가 중…" : selectedDraftChannels.length === 1 ? "1개 채널 추가" : `${selectedDraftChannels.length}개 채널 추가`}
                  </button>
                </div>
              </>
            ) : (
              <div style={{ padding: "38px 16px 10px", textAlign: "center" }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#16120D" }}>불러온 채널이 없어요</div>
                <p style={{ margin: "8px auto 18px", maxWidth: 360, fontSize: 13.5, lineHeight: 1.5, color: "#7A7060" }}>다른 Google 계정으로 다시 로그인하거나 YouTube 채널을 만든 뒤 연결해 주세요.</p>
                <button onClick={() => void closeChannelDraft()} style={{ height: 42, padding: "0 18px", border: 0, borderRadius: 11, background: "#16120D", color: "#fff", fontSize: 13.5, fontWeight: 700, cursor: "pointer" }}>확인</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* HIGHLIGHT RENDER MODAL */}
      {highlightDraft && (
        <div onClick={() => { if (!highlightBusy) setHighlightDraft(null); }} style={{ position: "fixed", inset: 0, zIndex: 94, display: "grid", placeItems: "center", padding: 22, background: "rgba(22,18,13,.5)", backdropFilter: "blur(8px)", animation: "scFade .2s ease both" }}>
          <div onClick={e => e.stopPropagation()} style={{ width: "min(760px,100%)", maxHeight: "min(840px,calc(100vh - 44px))", overflow: "auto", borderRadius: 18, background: "#FFFDF8", border: "1px solid #E6DDCB", boxShadow: "0 30px 80px -36px rgba(22,18,13,.65)", padding: 22, animation: "scPop .2s ease both" }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 18 }}>
              <span style={{ width: 42, height: 42, borderRadius: 12, background: "#16120D", color: ACCENT, display: "grid", placeItems: "center", flex: "0 0 auto" }}>
                <Icon d={["M4 5h16v14H4z", "m10 9 5 3-5 3V9Z"]} size={20} strokeWidth={1.9} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#16120D" }}>하이라이트 만들기</h2>
                <p style={{ margin: "6px 0 0", fontSize: 13, lineHeight: 1.5, color: "#7A7060" }}>선택한 후보 클립을 하나의 MP4로 이어붙입니다. 방송/유튜브용 16:9부터 쇼츠형 세로 하이라이트까지 만들 수 있어요.</p>
              </div>
              <button onClick={() => { if (!highlightBusy) setHighlightDraft(null); }} style={{ width: 34, height: 34, border: "1px solid #E1D8C6", borderRadius: 10, background: "#fff", color: "#7A7060", display: "grid", placeItems: "center", cursor: highlightBusy ? "not-allowed" : "pointer", flex: "0 0 auto" }} title="닫기">
                <Icon d={["M6 6l12 12", "M18 6 6 18"]} size={16} strokeWidth={2} />
              </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 220px", gap: 16, alignItems: "start" }}>
              <div>
                <div style={{ marginBottom: 14 }}>
                  <span style={PUB_LABEL}>하이라이트 제목</span>
                  <input value={highlightDraft.title} maxLength={120} onChange={e => setHighlightDraft(d => (d ? { ...d, result: null, title: e.target.value } : d))} style={PUB_INPUT} />
                </div>

                <div style={{ marginBottom: 14 }}>
                  <span style={PUB_LABEL}>포맷</span>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
                    {([
                      ["landscape", "16:9", "방송/유튜브"],
                      ["vertical", "9:16", "세로 하이라이트"],
                      ["square", "1:1", "SNS 컷"],
                    ] as const).map(([value, label, note]) => {
                      const on = highlightDraft.aspect === value;
                      return (
                        <button key={value} onClick={() => setHighlightDraft(d => (d ? { ...d, result: null, aspect: value } : d))} style={{ minWidth: 0, height: 58, border: `1.5px solid ${on ? "#16120D" : "#E1D8C6"}`, borderRadius: 12, background: on ? "#16120D" : "#fff", color: on ? "#fff" : "#5B5346", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3 }}>
                          <span style={{ fontSize: 14, fontWeight: 800 }}>{label}</span>
                          <span style={{ fontSize: 10.5, color: on ? "#F4ECDD" : "#A0957F", whiteSpace: "nowrap" }}>{note}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div style={{ marginBottom: 14 }}>
                  <span style={PUB_LABEL}>최대 길이</span>
                  <div style={{ display: "flex", gap: 8 }}>
                    {[180, 360, 720].map(seconds => {
                      const on = highlightDraft.maxDurationSeconds === seconds;
                      return (
                        <button key={seconds} onClick={() => setHighlightDraft(d => (d ? { ...d, result: null, maxDurationSeconds: seconds } : d))} style={{ flex: 1, height: 38, border: `1.5px solid ${on ? ACCENT : "#E1D8C6"}`, borderRadius: 10, background: on ? "#FFF4EF" : "#fff", color: on ? "#C83920" : "#5B5346", fontSize: 12.5, fontWeight: 800, cursor: "pointer" }}>{formatDuration(seconds)}</button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <span style={PUB_LABEL}>클립 선택 · {highlightDraft.clipIds.length}개</span>
                  <div style={{ display: "grid", gap: 8, maxHeight: 280, overflow: "auto", paddingRight: 3 }}>
                    {sortedClips.map((clip, index) => {
                      const on = highlightDraft.clipIds.includes(clip.id);
                      const order = highlightDraft.clipIds.indexOf(clip.id) + 1;
                      return (
                        <button key={clip.id} onClick={() => toggleHighlightClip(clip.id)} style={{ width: "100%", minWidth: 0, display: "grid", gridTemplateColumns: "34px minmax(0,1fr) auto", gap: 10, alignItems: "center", padding: "10px 11px", borderRadius: 12, border: `1.5px solid ${on ? ACCENT : "#E6DDCB"}`, background: on ? "#FFF4EF" : "#fff", color: "#16120D", cursor: "pointer", textAlign: "left" }}>
                          <span style={{ width: 26, height: 26, borderRadius: "50%", background: on ? ACCENT : "#F4EFE4", color: on ? "#fff" : "#A0957F", display: "grid", placeItems: "center", fontSize: 11.5, fontWeight: 800, fontFamily: "'Space Mono',monospace" }}>{on ? order : index + 1}</span>
                          <span style={{ minWidth: 0 }}>
                            <span style={{ display: "block", fontSize: 13, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{clip.title}</span>
                            <span style={{ display: "block", marginTop: 2, fontSize: 11.5, color: "#9A8F7E", fontFamily: "'Space Mono',monospace" }}>{clip.start} - {clip.end} · {clip.durSec}초</span>
                          </span>
                          <span style={{ width: 20, height: 20, borderRadius: "50%", border: `2px solid ${on ? ACCENT : "#D8CDB6"}`, background: on ? ACCENT : "#fff", display: "grid", placeItems: "center" }}>
                            {on && <Icon d="m6 11 3 3 7-7" size={12} stroke="#fff" strokeWidth={2.6} />}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div style={{ position: "sticky", top: 0, display: "grid", gap: 12 }}>
                <div style={{ padding: 14, borderRadius: 13, background: "#FBF7EF", border: "1px solid #EFE7D8" }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "#A0957F", marginBottom: 9 }}>요약</div>
                  <div style={{ display: "grid", gap: 7, fontSize: 12.5, color: "#5B5346" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}><span>선택</span><b style={{ color: "#16120D" }}>{highlightDraft.clipIds.length}개</b></div>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}><span>예상 길이</span><b style={{ color: "#16120D" }}>{formatDuration(Math.min(highlightTotalSeconds, highlightDraft.maxDurationSeconds))}</b></div>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}><span>포맷</span><b style={{ color: "#16120D" }}>{highlightDraft.aspect === "landscape" ? "16:9" : highlightDraft.aspect === "vertical" ? "9:16" : "1:1"}</b></div>
                  </div>
                </div>

                {highlightDraft.result && (
                  <div style={{ padding: 12, borderRadius: 13, background: "#fff", border: "1px solid #E6DDCB" }}>
                    <video src={mediaUrl(highlightDraft.result.video_url)} controls playsInline style={{ width: "100%", aspectRatio: highlightDraft.result.aspect === "vertical" ? "9/16" : highlightDraft.result.aspect === "square" ? "1/1" : "16/9", background: "#050505", borderRadius: 10, objectFit: "contain" }} />
                    <a href={mediaUrl(highlightDraft.result.video_url)} download style={{ marginTop: 10, height: 38, borderRadius: 10, background: "#16120D", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", gap: 7, fontSize: 12.5, fontWeight: 800, textDecoration: "none" }}>
                      <Icon d={["M12 3v12m0 0 4-4m-4 4-4-4", "M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"]} size={15} strokeWidth={1.9} />MP4 다운로드
                    </a>
                  </div>
                )}
              </div>
            </div>

            <div style={{ marginTop: 18, display: "flex", gap: 10 }}>
              <button onClick={() => { if (!highlightBusy) setHighlightDraft(null); }} disabled={highlightBusy} style={{ flex: 1, height: 46, border: "1px solid #E1D8C6", borderRadius: 11, background: "#fff", color: "#5B5346", fontSize: 13.5, fontWeight: 700, cursor: highlightBusy ? "not-allowed" : "pointer" }}>닫기</button>
              <button onClick={() => void doRenderHighlight()} disabled={highlightBusy || highlightDraft.clipIds.length === 0} style={{ flex: 1.35, height: 46, border: 0, borderRadius: 11, background: highlightBusy || highlightDraft.clipIds.length === 0 ? "#D8CDB6" : ACCENT, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 13.5, fontWeight: 800, cursor: highlightBusy || highlightDraft.clipIds.length === 0 ? "not-allowed" : "pointer", boxShadow: highlightBusy ? "none" : "0 12px 26px -12px rgba(255,74,28,.9)" }}>
                {highlightBusy ? <><Icon d={["M12 3a9 9 0 1 0 9 9"]} size={16} stroke="#fff" strokeWidth={2.4} style={{ animation: "scSpin 1s linear infinite" }} />생성 중…</> : <><Icon d={["M4 5h16v14H4z", "m10 9 5 3-5 3V9Z"]} size={16} strokeWidth={1.9} />하이라이트 MP4 생성</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PRE-PUBLISH CONFIRM MODAL */}
      {publishDraft && (
        <div onClick={() => { if (!publishing) setPublishDraft(null); }} style={{ position: "fixed", inset: 0, zIndex: 95, display: "grid", placeItems: "center", padding: 22, background: "rgba(22,18,13,.5)", backdropFilter: "blur(8px)", animation: "scFade .2s ease both" }}>
          <div onClick={e => e.stopPropagation()} style={{ width: "min(520px,100%)", maxHeight: "min(780px,calc(100vh - 44px))", overflow: "auto", borderRadius: 18, background: "#FFFDF8", border: "1px solid #E6DDCB", boxShadow: "0 30px 80px -36px rgba(22,18,13,.65)", padding: 22, animation: "scPop .2s ease both" }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 18 }}>
              <span style={{ width: 42, height: 42, borderRadius: 12, background: "#FF0000", display: "grid", placeItems: "center", flex: "0 0 auto" }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff"><path d="M21.6 7.2a2.8 2.8 0 0 0-2-2C17.9 4.8 12 4.8 12 4.8s-5.9 0-7.6.4a2.8 2.8 0 0 0-2 2A29 29 0 0 0 2 12a29 29 0 0 0 .4 4.8 2.8 2.8 0 0 0 2 2c1.7.4 7.6.4 7.6.4s5.9 0 7.6-.4a2.8 2.8 0 0 0 2-2A29 29 0 0 0 22 12a29 29 0 0 0-.4-4.8ZM10 15V9l5.2 3L10 15Z" /></svg>
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#16120D" }}>{publishDraft.mode === "schedule" ? "예약 발행 확인" : "지금 발행 확인"}</h2>
                <p style={{ margin: "6px 0 0", fontSize: 13, lineHeight: 1.5, color: "#7A7060" }}>발행 정보를 확인하고 필요하면 수정하세요. 발행 후에는 유튜브 스튜디오에서 관리됩니다.</p>
              </div>
              <button onClick={() => { if (!publishing) setPublishDraft(null); }} style={{ width: 34, height: 34, border: "1px solid #E1D8C6", borderRadius: 10, background: "#fff", color: "#7A7060", display: "grid", placeItems: "center", cursor: publishing ? "not-allowed" : "pointer", flex: "0 0 auto" }} title="닫기">
                <Icon d={["M6 6l12 12", "M18 6 6 18"]} size={16} strokeWidth={2} />
              </button>
            </div>

            {/* channel */}
            <div style={{ marginBottom: 14 }}>
              <span style={PUB_LABEL}>채널</span>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {channels.map((c, idx) => {
                  const on = c.id === publishDraft.channelDbId;
                  return (
                    <button key={c.id} onClick={() => setPublishDraft(d => (d ? { ...d, channelDbId: c.id } : d))}
                      style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: 11, borderRadius: 12, border: `1.5px solid ${on ? ACCENT : "#E6DDCB"}`, background: on ? "#FFF4EF" : "#fff", color: "#16120D", textAlign: "left", cursor: "pointer" }}>
                      {c.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element -- external YouTube avatar
                        <img src={c.thumbnailUrl} alt="" style={{ width: 38, height: 38, borderRadius: "50%", objectFit: "cover", flex: "0 0 auto" }} />
                      ) : (
                        <span style={{ width: 38, height: 38, borderRadius: "50%", background: CHANNEL_COLORS[idx % CHANNEL_COLORS.length], color: "#fff", display: "grid", placeItems: "center", fontSize: 15, fontWeight: 800, flex: "0 0 auto" }}>{c.name.slice(0, 1)}</span>
                      )}
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                          <span style={{ fontSize: 14, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</span>
                          {c.isDefault && <span style={{ flex: "0 0 auto", fontSize: 10.5, fontWeight: 800, color: "#C83920", background: "#FBF1EC", border: "1px solid #F0D9CE", borderRadius: 999, padding: "1px 7px" }}>기본</span>}
                        </span>
                        <span style={{ display: "block", marginTop: 3, fontSize: 11.5, color: "#9A8F7E", fontFamily: "'Space Mono',monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.handle}</span>
                      </span>
                      <span style={{ width: 20, height: 20, borderRadius: "50%", border: `2px solid ${on ? ACCENT : "#D8CDB6"}`, background: on ? ACCENT : "#fff", display: "grid", placeItems: "center", flex: "0 0 auto" }}>
                        {on && <Icon d="m6 11 3 3 7-7" size={12} stroke="#fff" strokeWidth={2.6} />}
                      </span>
                    </button>
                  );
                })}
              </div>
              {publishChannel?.styleNote && (
                <div style={{ marginTop: 9, display: "flex", gap: 8, padding: "10px 12px", borderRadius: 10, background: "#FBF7EF", border: "1px solid #EFE7D8" }}>
                  <Icon d={["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"]} size={14} stroke="#C83920" strokeWidth={1.9} style={{ flex: "0 0 auto", marginTop: 1 }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#A0957F", marginBottom: 2 }}>이 채널 스타일 메모</div>
                    <div style={{ fontSize: 12.5, lineHeight: 1.45, color: "#5B5346", whiteSpace: "pre-wrap" }}>{publishChannel.styleNote}</div>
                  </div>
                </div>
              )}
            </div>

            {/* title */}
            <div style={{ marginBottom: 14 }}>
              <span style={PUB_LABEL}>제목 · {publishDraft.title.length}/100</span>
              <input value={publishDraft.title} maxLength={100} onChange={e => setPublishDraft(d => (d ? { ...d, title: e.target.value } : d))} style={PUB_INPUT} />
            </div>

            {/* description */}
            <div style={{ marginBottom: 14 }}>
              <span style={PUB_LABEL}>설명</span>
              <textarea value={publishDraft.description} onChange={e => setPublishDraft(d => (d ? { ...d, description: e.target.value } : d))} rows={4} style={{ ...PUB_INPUT, resize: "vertical", lineHeight: 1.5 }} />
            </div>

            {/* tags */}
            <div style={{ marginBottom: 14 }}>
              <span style={PUB_LABEL}>태그 · 쉼표로 구분</span>
              <input value={publishDraft.tags} onChange={e => setPublishDraft(d => (d ? { ...d, tags: e.target.value } : d))} placeholder="예능, 토크쇼, 하이라이트" style={PUB_INPUT} />
            </div>

            {/* privacy */}
            <div style={{ marginBottom: 14 }}>
              <span style={PUB_LABEL}>공개 범위</span>
              <div style={{ display: "flex", gap: 8 }}>
                {(["public", "unlisted", "private"] as const).map(p => {
                  const on = publishDraft.privacy === p;
                  return (
                    <button key={p} onClick={() => setPublishDraft(d => (d ? { ...d, privacy: p } : d))} style={{ flex: 1, height: 40, border: `1.5px solid ${on ? "#16120D" : "#E1D8C6"}`, borderRadius: 10, background: on ? "#16120D" : "#fff", color: on ? "#fff" : "#5B5346", fontSize: 13, fontWeight: 700, cursor: "pointer", transition: "all .14s" }}>{PRIVACY_LABELS[p]}</button>
                  );
                })}
              </div>
              {publishDraft.mode === "schedule" && publishDraft.privacy !== "private" && (
                <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "#A0957F", lineHeight: 1.45 }}>예약 발행은 예약 시간까지 비공개로 보관된 뒤 선택한 공개 범위로 전환됩니다.</p>
              )}
            </div>

            {/* schedule */}
            {publishDraft.mode === "schedule" && (
              <div style={{ marginBottom: 14 }}>
                <span style={PUB_LABEL}>예약 시간 (KST)</span>
                <input type="datetime-local" value={publishDraft.scheduleLocal} onChange={e => setPublishDraft(d => (d ? { ...d, scheduleLocal: e.target.value } : d))} style={PUB_INPUT} />
              </div>
            )}

            {/* metadata preview */}
            <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid #EFE7D8" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <Icon d={["M4 4h16v16H4z", "M8 8h8", "M8 12h8", "M8 16h5"]} size={16} stroke="#C83920" strokeWidth={1.9} />
                <span style={{ fontSize: 13.5, fontWeight: 800, color: "#16120D" }}>업로드될 메타데이터 미리보기</span>
              </div>
              <div style={{ display: "grid", gap: 8, padding: 12, borderRadius: 12, background: "#FBF7EF", border: "1px solid #EFE7D8" }}>
                <div style={{ display: "grid", gridTemplateColumns: "82px minmax(0,1fr)", gap: 10, alignItems: "start" }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: "#A0957F" }}>채널</span>
                  <span style={{ minWidth: 0, fontSize: 12.5, fontWeight: 700, color: "#16120D", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{publishChannel?.name || "선택된 채널"}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "82px minmax(0,1fr)", gap: 10, alignItems: "start" }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: "#A0957F" }}>제목</span>
                  <span style={{ minWidth: 0, fontSize: 13, lineHeight: 1.45, fontWeight: 800, color: "#16120D", overflowWrap: "anywhere" }}>{publishDraft.title.trim() || "제목 없음"} <span style={{ color: "#A0957F", fontWeight: 700 }}>({publishDraft.title.trim().length}/100)</span></span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "82px minmax(0,1fr)", gap: 10, alignItems: "start" }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: "#A0957F" }}>설명</span>
                  <span style={{ minWidth: 0, maxHeight: 96, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12.5, lineHeight: 1.5, color: publishDraft.description.trim() ? "#3A3025" : "#A0957F" }}>{publishDraft.description.trim() || "설명 없이 업로드됩니다."}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "82px minmax(0,1fr)", gap: 10, alignItems: "start" }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: "#A0957F" }}>태그</span>
                  <div style={{ minWidth: 0, display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {publishPreviewTags.length ? publishPreviewTags.map(tag => (
                      <span key={tag} style={{ maxWidth: "100%", padding: "4px 8px", borderRadius: 999, background: "#fff", border: "1px solid #E6DDCB", color: "#5B5346", fontSize: 11.5, fontWeight: 700, overflowWrap: "anywhere" }}>{tag}</span>
                    )) : (
                      <span style={{ fontSize: 12.5, color: "#A0957F" }}>태그 없이 업로드됩니다.</span>
                    )}
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "82px minmax(0,1fr)", gap: 10, alignItems: "start" }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: "#A0957F" }}>공개</span>
                  <span style={{ minWidth: 0, fontSize: 12.5, color: "#3A3025" }}>{PRIVACY_LABELS[publishDraft.privacy]}{publishDraft.mode === "schedule" ? ` · ${publishScheduleStamp ? `${fmtStamp(publishScheduleStamp)} KST` : "예약 시간 미선택"}` : " · 즉시 발행"}</span>
                </div>
                {(publishClip?.thumbnailText || publishClip?.category || typeof publishClip?.madeForKids === "boolean") && (
                  <div style={{ display: "grid", gridTemplateColumns: "82px minmax(0,1fr)", gap: 10, alignItems: "start" }}>
                    <span style={{ fontSize: 11, fontWeight: 800, color: "#A0957F" }}>참고</span>
                    <span style={{ minWidth: 0, fontSize: 12.5, lineHeight: 1.5, color: "#7A7060" }}>
                      {publishClip?.thumbnailText ? `썸네일 문구: ${publishClip.thumbnailText}` : ""}
                      {publishClip?.thumbnailText && (publishClip?.category || typeof publishClip?.madeForKids === "boolean") ? " · " : ""}
                      {publishClip?.category ? `카테고리: ${publishClip.category}` : ""}
                      {publishClip?.category && typeof publishClip?.madeForKids === "boolean" ? " · " : ""}
                      {typeof publishClip?.madeForKids === "boolean" ? `아동용: ${publishClip.madeForKids ? "예" : "아니오"}` : ""}
                    </span>
                  </div>
                )}
                {publishScheduleStamp && (
                  <div style={{ marginTop: 2, paddingTop: 8, borderTop: "1px solid #EFE7D8", fontSize: 11.5, color: "#9A8F7E", fontFamily: "'Space Mono',monospace" }}>schedule_date: {publishScheduleStamp}</div>
                )}
              </div>
            </div>

            <div style={{ marginTop: 18, display: "flex", gap: 10 }}>
              <button onClick={() => { if (!publishing) setPublishDraft(null); }} disabled={publishing} style={{ flex: 1, height: 46, border: "1px solid #E1D8C6", borderRadius: 11, background: "#fff", color: "#5B5346", fontSize: 13.5, fontWeight: 700, cursor: publishing ? "not-allowed" : "pointer" }}>취소</button>
              <button onClick={() => void doPublish()} disabled={publishing} style={{ flex: 1.5, height: 46, border: 0, borderRadius: 11, background: publishing ? "#D8CDB6" : ACCENT, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 13.5, fontWeight: 800, cursor: publishing ? "not-allowed" : "pointer", boxShadow: publishing ? "none" : "0 12px 26px -12px rgba(255,74,28,.9)" }}>
                {publishing
                  ? <><Icon d={["M12 3a9 9 0 1 0 9 9"]} size={16} stroke="#fff" strokeWidth={2.4} style={{ animation: "scSpin 1s linear infinite" }} />발행 중…</>
                  : publishDraft.mode === "schedule"
                    ? <><Icon d={["M12 8v4l3 2", "M3 4.5h18v16H3z", "M3 9h18"]} size={16} strokeWidth={1.9} />예약 발행</>
                    : <><Icon d={["M12 3v12m0 0 4-4m-4 4-4-4", "M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"]} size={16} strokeWidth={1.9} />지금 발행</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* RESCHEDULE / CANCEL MODAL */}
      {schedAction && (
        <div onClick={() => { if (!schedBusy) setSchedAction(null); }} style={{ position: "fixed", inset: 0, zIndex: 96, display: "grid", placeItems: "center", padding: 22, background: "rgba(22,18,13,.5)", backdropFilter: "blur(8px)", animation: "scFade .2s ease both" }}>
          <div onClick={e => e.stopPropagation()} style={{ width: "min(440px,100%)", borderRadius: 18, background: "#FFFDF8", border: "1px solid #E6DDCB", boxShadow: "0 30px 80px -36px rgba(22,18,13,.65)", padding: 22, animation: "scPop .2s ease both" }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 16 }}>
              <span style={{ width: 40, height: 40, borderRadius: 11, background: "#16120D", color: ACCENT, display: "grid", placeItems: "center", flex: "0 0 auto" }}>
                <Icon d={["M12 8v4l3 2", "M3 4.5h18v16H3z", "M3 9h18"]} size={19} strokeWidth={1.9} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h2 style={{ margin: 0, fontSize: 19, fontWeight: 800, color: "#16120D" }}>예약 변경 · 취소</h2>
                <p style={{ margin: "4px 0 0", fontSize: 13, color: "#7A7060", lineHeight: 1.45, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{schedAction.item.title}</p>
              </div>
              <button onClick={() => { if (!schedBusy) setSchedAction(null); }} style={{ width: 34, height: 34, border: "1px solid #E1D8C6", borderRadius: 10, background: "#fff", color: "#7A7060", display: "grid", placeItems: "center", cursor: schedBusy ? "not-allowed" : "pointer", flex: "0 0 auto" }}>
                <Icon d={["M6 6l12 12", "M18 6 6 18"]} size={16} strokeWidth={2} />
              </button>
            </div>
            <span style={PUB_LABEL}>새 예약 시간 (KST)</span>
            <input type="datetime-local" value={schedAction.local} onChange={e => setSchedAction(a => (a ? { ...a, local: e.target.value } : a))} style={PUB_INPUT} />
            <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
              <button onClick={() => void doCancelSched()} disabled={schedBusy} style={{ flex: 1, height: 46, border: "1px solid #F0D9CE", borderRadius: 11, background: "#FFF6F4", color: "#C0392B", fontSize: 13.5, fontWeight: 700, cursor: schedBusy ? "not-allowed" : "pointer" }}>예약 취소</button>
              <button onClick={() => void doReschedule()} disabled={schedBusy} style={{ flex: 1.4, height: 46, border: 0, borderRadius: 11, background: schedBusy ? "#D8CDB6" : ACCENT, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 13.5, fontWeight: 800, cursor: schedBusy ? "not-allowed" : "pointer", boxShadow: schedBusy ? "none" : "0 12px 26px -12px rgba(255,74,28,.9)" }}>{schedBusy ? "처리 중…" : "시간 변경"}</button>
            </div>
          </div>
        </div>
      )}

      {/* AUTO-DISTRIBUTE MODAL */}
      {autoDist && (
        <div onClick={() => { if (!autoDistBusy) setAutoDist(null); }} style={{ position: "fixed", inset: 0, zIndex: 96, display: "grid", placeItems: "center", padding: 22, background: "rgba(22,18,13,.5)", backdropFilter: "blur(8px)", animation: "scFade .2s ease both" }}>
          <div onClick={e => e.stopPropagation()} style={{ width: "min(640px,100%)", maxHeight: "min(840px,calc(100vh - 44px))", overflow: "auto", borderRadius: 18, background: "#FFFDF8", border: "1px solid #E6DDCB", boxShadow: "0 30px 80px -36px rgba(22,18,13,.65)", padding: 22, animation: "scPop .2s ease both" }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 16 }}>
              <span style={{ width: 42, height: 42, borderRadius: 12, background: "#16120D", color: ACCENT, display: "grid", placeItems: "center", flex: "0 0 auto" }}>
                <Icon d={["M3 4.5h18v16H3z", "M3 9h18", "M8 2.5v4", "M16 2.5v4", "m9 15 2 2 4-4"]} size={20} strokeWidth={1.8} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#16120D" }}>예약 자동 배치</h2>
                <p style={{ margin: "5px 0 0", fontSize: 13, color: "#7A7060", lineHeight: 1.45 }}>고른 쇼츠를 시작 날짜부터 하루에 시간대 수만큼 나눠 예약합니다.</p>
              </div>
              <button onClick={() => { if (!autoDistBusy) setAutoDist(null); }} style={{ width: 34, height: 34, border: "1px solid #E1D8C6", borderRadius: 10, background: "#fff", color: "#7A7060", display: "grid", placeItems: "center", cursor: autoDistBusy ? "not-allowed" : "pointer", flex: "0 0 auto" }}>
                <Icon d={["M6 6l12 12", "M18 6 6 18"]} size={16} strokeWidth={2} />
              </button>
            </div>

            <div style={{ marginBottom: 14 }}>
              <span style={PUB_LABEL}>채널</span>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {channels.map(c => {
                  const on = c.id === autoDist.channelDbId;
                  return <button key={c.id} onClick={() => setAutoDist(d => (d ? { ...d, channelDbId: c.id } : d))} style={{ height: 36, padding: "0 13px", border: `1.5px solid ${on ? ACCENT : "#E1D8C6"}`, borderRadius: 999, background: on ? "#FFF4EF" : "#fff", color: on ? "#A04A2E" : "#5B5346", fontSize: 13, fontWeight: 700, cursor: "pointer", maxWidth: 200, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</button>;
                })}
              </div>
            </div>

            <div style={{ display: "flex", gap: 12, marginBottom: 14 }}>
              <div style={{ flex: 1 }}>
                <span style={PUB_LABEL}>시작 날짜</span>
                <input type="date" value={autoDist.startDate} onChange={e => setAutoDist(d => (d ? { ...d, startDate: e.target.value } : d))} style={PUB_INPUT} />
              </div>
              <div style={{ flex: 1 }}>
                <span style={PUB_LABEL}>하루 발행 시간 (쉼표)</span>
                <input value={autoDist.times} onChange={e => setAutoDist(d => (d ? { ...d, times: e.target.value } : d))} placeholder="09:00, 18:00" style={PUB_INPUT} />
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <span style={PUB_LABEL}>공개 범위</span>
              <div style={{ display: "flex", gap: 8 }}>
                {(["public", "unlisted", "private"] as const).map(p => {
                  const on = autoDist.privacy === p;
                  return <button key={p} onClick={() => setAutoDist(d => (d ? { ...d, privacy: p } : d))} style={{ flex: 1, height: 40, border: `1.5px solid ${on ? "#16120D" : "#E1D8C6"}`, borderRadius: 10, background: on ? "#16120D" : "#fff", color: on ? "#fff" : "#5B5346", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>{PRIVACY_LABELS[p]}</button>;
                })}
              </div>
            </div>

            <div style={{ marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={PUB_LABEL}>쇼츠 선택 · {autoDist.selected.length}개</span>
              <span style={{ fontSize: 11.5, color: "#9A8F7E" }}>{autoDist.selected.length > 0 ? `하루 ${autoDistTimesCount}개씩 · 약 ${Math.ceil(autoDist.selected.length / autoDistTimesCount)}일` : "쇼츠를 골라 주세요"}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 9, maxHeight: 280, overflow: "auto", padding: 2 }}>
              {pickerClips.length === 0 && (
                <div style={{ gridColumn: "1 / -1", padding: "26px 12px", textAlign: "center", color: "#9A8F7E", fontSize: 13 }}>아직 만든 쇼츠가 없어요.</div>
              )}
              {pickerClips.map(pc => {
                const i = autoDist.selected.indexOf(pc.clipId);
                const on = i >= 0;
                return (
                  <button key={pc.clipId} onClick={() => toggleAutoClip(pc.clipId)} style={{ position: "relative", textAlign: "left", border: `1.5px solid ${on ? ACCENT : "#E6DDCB"}`, borderRadius: 12, background: on ? "#FFF4EF" : "#fff", padding: 8, cursor: "pointer", display: "flex", flexDirection: "column", gap: 7 }}>
                    <div style={{ position: "relative", aspectRatio: "16/10", borderRadius: 8, overflow: "hidden", background: "#EAE1D0" }}>
                      {pc.thumb && (
                        // eslint-disable-next-line @next/next/no-img-element -- generated clip thumbnail
                        <img src={mediaUrl(pc.thumb)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      )}
                      {on && <span style={{ position: "absolute", top: 5, right: 5, width: 20, height: 20, borderRadius: "50%", background: ACCENT, color: "#fff", display: "grid", placeItems: "center" }}><Icon d={["m5 12 5 5L20 6"]} size={12} stroke="#fff" strokeWidth={3} /></span>}
                      {on && <span style={{ position: "absolute", bottom: 5, left: 5, width: 18, height: 18, borderRadius: "50%", background: "rgba(0,0,0,.7)", color: "#fff", display: "grid", placeItems: "center", fontSize: 10, fontWeight: 800 }}>{i + 1}</span>}
                    </div>
                    <div style={{ fontSize: 11.5, fontWeight: 700, color: "#16120D", lineHeight: 1.3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{pc.title}</div>
                  </button>
                );
              })}
            </div>

            <div style={{ marginTop: 18, display: "flex", gap: 10 }}>
              <button onClick={() => { if (!autoDistBusy) setAutoDist(null); }} disabled={autoDistBusy} style={{ flex: 1, height: 46, border: "1px solid #E1D8C6", borderRadius: 11, background: "#fff", color: "#5B5346", fontSize: 13.5, fontWeight: 700, cursor: autoDistBusy ? "not-allowed" : "pointer" }}>취소</button>
              <button onClick={() => void doAutoDistribute()} disabled={autoDistBusy || autoDist.selected.length === 0} style={{ flex: 1.5, height: 46, border: 0, borderRadius: 11, background: autoDistBusy || autoDist.selected.length === 0 ? "#D8CDB6" : ACCENT, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 13.5, fontWeight: 800, cursor: autoDistBusy || autoDist.selected.length === 0 ? "not-allowed" : "pointer" }}>{autoDistBusy ? "배치 중…" : `${autoDist.selected.length}개 예약 배치`}</button>
            </div>
          </div>
        </div>
      )}

      {/* TOAST */}
      {toast && (
        <div style={{ position: "fixed", left: "50%", bottom: 32, zIndex: 80, transform: "translateX(-50%)", display: "inline-flex", alignItems: "center", gap: 10, padding: "13px 20px", borderRadius: 13, background: "#16120D", color: "#fff", fontSize: 13.5, fontWeight: 600, boxShadow: "0 18px 40px -16px rgba(0,0,0,.6)", animation: "scToast .25s ease both" }}>
          <span style={{ width: 20, height: 20, borderRadius: "50%", background: "#1F8A5B", display: "grid", placeItems: "center", flex: "0 0 auto" }}>
            <Icon d={["m5 12 5 5L20 6"]} size={13} stroke="#fff" strokeWidth={2.6} />
          </span>
          {toast}
        </div>
      )}
    </div>
  );
}

function GlobalStyle() {
  return (
    <style>{`
      html,body{margin:0;padding:0;background:#EFE8DA;}
      *{box-sizing:border-box}
      ::selection{background:#FF4A1C;color:#fff}
      @keyframes scSpin{to{transform:rotate(360deg)}}
      @keyframes scPop{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}
      @keyframes scFade{from{opacity:0}to{opacity:1}}
      @keyframes scRise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
      @keyframes scToast{from{opacity:0;transform:translate(-50%,14px)}to{opacity:1;transform:translate(-50%,0)}}
      ::-webkit-scrollbar{width:10px;height:10px}
      ::-webkit-scrollbar-thumb{background:#cfc6b4;border-radius:99px;border:3px solid #EFE8DA}
      .sc-card:hover{transform:translateY(-4px);box-shadow:0 22px 40px -22px rgba(40,30,20,.4);border-color:#E0D3B8 !important;}
      .sc-railbtn:hover{background:#221C16 !important;color:#E9E2D4 !important;}
    `}</style>
  );
}

// silence unused import warnings for ReactNode (kept for future extension)
export type _Unused = ReactNode;
