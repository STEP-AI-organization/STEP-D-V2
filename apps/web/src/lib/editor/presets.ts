/**
 * STEP-D editor — declarative EditorState + template presets.
 *
 * Borrowed from StepD's ShortcutEditor contract (plan §3): the whole edit is one
 * serializable state object; the renderer re-derives output from it. Overlay
 * positions are percentages so they survive aspect changes, and the preview canvas
 * shares the renderer's px basis (WYSIWYG). Real ffmpeg/STT bake wires in at M6.
 */

export type AspectKey = "9:16" | "16:9" | "1:1" | "4:5";
export type TemplateId =
  | "stacked_channel"
  | "full_bleed"
  | "caption_card"
  | "news_bar"
  | "comment_hook";
export type CaptionStyle = "korean_pop" | "clean" | "news";
export type ElementType = "cta" | "sticker" | "arrow" | "bubble";

export interface TitleLine {
  id: string;
  text: string;
  size: number;
  color: string;
}

export interface EditorElement {
  id: string;
  type: ElementType;
  x: number; // %
  y: number; // %
  text: string;
  size?: number; // font px; falls back to a per-type default
}

/** Default font size (px) for a freshly added element. */
export function defaultElementSize(type: ElementType): number {
  return type === "arrow" ? 40 : 14;
}

export interface EditorTrack {
  id: string;
  label: string;
  /** Track-relative seconds (0 = track start) */
  trimIn: number;
  trimOut: number;
  /** Position on master timeline */
  startTime: number;
  duration: number;
  /** For future: media source. For MVP, all tracks share the same video */
  mediaId?: string;
}

export function makeMainTrack(trimIn: number, trimOut: number, duration: number): EditorTrack {
  return { id: "track-main", label: "메인", trimIn, trimOut, startTime: 0, duration };
}

export interface EditorState {
  templateId: TemplateId;
  aspect: AspectKey;
  bg: string;
  accent: string;
  titleLines: TitleLine[];
  titleAlign: "left" | "center" | "right";
  titleX: number; // %
  titleY: number; // %
  showChannel: boolean;
  channelName: string;
  channelY: number; // %
  captionsOn: boolean;
  captionStyle: CaptionStyle;
  highlightColor: string;
  showSafeArea: boolean;
  elements: EditorElement[];
  trimIn: number; // seconds
  trimOut: number; // seconds
  /** Vertical layers (phase 1: all share the same video). tracks[0] is the main track,
   *  whose trim mirrors trimIn/trimOut (the master trim the render actually cuts). */
  tracks: EditorTrack[];
  speed: number;
  hookOn: boolean;
  silenceCut: boolean;
  offsetMs: number; // ±sync fine-tune
}

export const ASPECTS: Record<AspectKey, { label: string; ratio: number }> = {
  "9:16": { label: "세로 9:16", ratio: 9 / 16 },
  "4:5": { label: "세로 4:5", ratio: 4 / 5 },
  "1:1": { label: "정사각 1:1", ratio: 1 },
  "16:9": { label: "가로 16:9", ratio: 16 / 9 },
};

export const CAPTION_STYLES: Record<CaptionStyle, string> = {
  korean_pop: "코리안 팝",
  clean: "클린",
  news: "뉴스",
};

export const COLOR_SWATCHES = ["#FFFFFF", "#FFD400", "#27E0A0", "#5B8CFF", "#FF49DB", "#16120D"];
export const BG_SWATCHES = ["#0E0E12", "#10162B", "#FBF3E4", "#FFFFFF"];

export const ELEMENT_DEFAULTS: Record<ElementType, string> = {
  cta: "지금 확인",
  sticker: "이거 실화?",
  arrow: "→",
  bubble: "한마디 하자면…",
};

export interface TemplatePreset {
  id: TemplateId;
  label: string;
  hint: string;
  patch: Partial<EditorState>;
}

/** 5 genre-tuned one-click layouts (StepD parity). Each repositions all layers. */
export const TEMPLATE_PRESETS: TemplatePreset[] = [
  {
    id: "stacked_channel",
    label: "상단 제목 + 채널",
    hint: "가로 원본을 쇼츠로 가장 무난하게",
    patch: { aspect: "9:16", bg: "#0E0E12", accent: "#FFD400", titleAlign: "center", titleY: 8, showChannel: true, channelY: 82, captionStyle: "korean_pop" },
  },
  {
    id: "full_bleed",
    label: "풀스크린 세로",
    hint: "이미 세로 영상이면 제일 자연스럽게",
    patch: { aspect: "9:16", bg: "#000000", accent: "#FFD400", titleAlign: "center", titleY: 6, showChannel: true, channelY: 88, captionStyle: "clean" },
  },
  {
    id: "caption_card",
    label: "캡션 카드",
    hint: "토크·예능 하이라이트용",
    patch: { aspect: "4:5", bg: "#FBF3E4", accent: "#27A376", titleAlign: "center", titleY: 7, showChannel: true, channelY: 84, captionStyle: "korean_pop" },
  },
  {
    id: "news_bar",
    label: "뉴스 바",
    hint: "정보형·이슈형 헤드라인",
    patch: { aspect: "16:9", bg: "#10162B", accent: "#FFD400", titleAlign: "left", titleY: 10, showChannel: true, channelY: 88, captionStyle: "news" },
  },
  {
    id: "comment_hook",
    label: "댓글 유도 훅",
    hint: "반응 갈리는 장면용",
    patch: { aspect: "1:1", bg: "#16120D", accent: "#FF49DB", titleAlign: "center", titleY: 8, showChannel: true, channelY: 86, captionStyle: "korean_pop" },
  },
];

export function makeInitialEditorState(title: string, durationSec: number): EditorState {
  const dur = Math.max(1, durationSec);
  return {
    templateId: "stacked_channel",
    aspect: "9:16",
    bg: "#0E0E12",
    accent: "#FFD400",
    titleLines: [{ id: "t1", text: title, size: 30, color: "#FFFFFF" }],
    titleAlign: "center",
    titleX: 50,
    titleY: 8,
    showChannel: true,
    channelName: "전참시 공식",
    channelY: 82,
    captionsOn: true,
    captionStyle: "korean_pop",
    highlightColor: "#FFD400",
    showSafeArea: false,
    elements: [],
    trimIn: 0,
    trimOut: dur,
    tracks: [makeMainTrack(0, dur, dur)],
    speed: 1,
    hookOn: true,
    silenceCut: false,
    offsetMs: 0,
  };
}

/** Saved editorState from before multi-track has no `tracks` — hydrate a main track
 *  from the master trim so old clips keep working unchanged. */
export function ensureTracks(state: EditorState, durationSec: number): EditorState {
  if (Array.isArray(state.tracks) && state.tracks.length > 0) return state;
  const dur = Math.max(1, durationSec);
  return { ...state, tracks: [makeMainTrack(state.trimIn ?? 0, state.trimOut ?? dur, dur)] };
}

export function applyTemplate(state: EditorState, id: TemplateId): EditorState {
  const preset = TEMPLATE_PRESETS.find((p) => p.id === id);
  if (!preset) return state;
  return { ...state, templateId: id, ...preset.patch };
}
