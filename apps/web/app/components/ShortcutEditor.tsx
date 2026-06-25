"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowRight,
  Check,
  FileText,
  LayoutTemplate,
  MessageCircle,
  Move,
  MousePointer2,
  Palette,
  Pause,
  Play,
  RefreshCw,
  Save,
  Scissors,
  Sparkles,
  Type,
  Upload,
  UserCircle,
  X,
  Youtube,
  Zap,
  ZoomIn,
} from "lucide-react";

export type ShortcutEditorClip = {
  id: string;
  title: string;
  caption: string;
  reason?: string;
  transcript?: string;
  start: string;
  end: string;
  durSec: number;
  videoUrl?: string;
  thumbnailUrl?: string;
  sourceThumbnailUrl?: string;
  yt?: {
    title: string;
    tags: string[];
  };
  channelName?: string;
  initialEditorState?: Partial<EditorState>;
};

export type ShortcutEditorDraft = {
  title: string;
  thumbnailText: string;
  templateId: string;
  overlayPosition: "top_right" | "top_left" | "bottom_right" | "bottom_left" | "top_center";
  overlayScale: number;
  editorState: EditorState;
  burnOverlays: BurnOverlay[];
};

export type BurnOverlay = {
  kind: "text" | "image";
  role?: string;
  text?: string;
  src?: string;
  x: number;
  y: number;
  width?: number;
  widthPct?: number;
  align?: "left" | "center" | "right";
  fontSize?: number;
  color?: string;
  font?: FontKey;
  boxColor?: string;
  boxAlpha?: number;
  boxBorder?: number;
  shadow?: boolean;
};

type ShortcutEditorProps = {
  clip: ShortcutEditorClip;
  onClose: () => void;
  onSave: (draft: ShortcutEditorDraft) => void | Promise<void>;
  saving?: boolean;
};

type EditorTab = "title" | "channel" | "layout" | "captions" | "elements";
type AspectKey = "16:9" | "4:3" | "1:1" | "4:5" | "3:4" | "9:16";
type OverlayType = "image" | "cta" | "sticker" | "arrow" | "bubble";

type EditorOverlay = {
  id: string;
  type: OverlayType;
  x: number;
  y: number;
  src?: string;
};

export type EditorState = {
  templatePresetId: TemplatePresetId;
  tab: EditorTab;
  aspect: AspectKey;
  zoom: number;
  dualFrame: boolean;
  deadzone: boolean;
  ytLayout: boolean;
  bg: string;
  accent: string;
  titleAlign: "left" | "center" | "right";
  titleLines: TitleLine[];
  bottomText: string;
  botTextOn: boolean;
  botSize: number;
  botColor: string;
  botSpacing: number;
  botFont: FontKey;
  showChannel: boolean;
  showSource: boolean;
  chanIconSize: number;
  chanNameOn: boolean;
  chanSource: "yt" | "custom";
  chanOpen: boolean;
  chanName: string;
  sourceTitle: string;
  chanNameSize: number;
  chanNameColor: string;
  chanNameSpacing: number;
  captionsOn: boolean;
  hl: string;
  hookTab: "hook" | "speed" | "silence";
  hookOn: boolean;
  playing: boolean;
  t: number;
  overlays: EditorOverlay[];
  titleX: number;
  titleY: number;
  videoY: number;
  footX: number;
  footY: number;
  bottomX: number;
  bottomY: number;
  speed: number;
  trimMode: boolean;
  trimIn: number;
  trimOut: number;
};

type MoveKey = "titleX" | "titleY" | "footX" | "footY" | "bottomX" | "bottomY";
type TemplatePresetId = "stacked_channel" | "full_bleed" | "caption_card" | "news_bar" | "comment_hook";

const ACCENT = "#FF4A1C";
const PANEL = "#F6F1E8";
const LINE = "#E1D8C6";
const TEXT = "#16120D";
const MUTED = "#8C8273";
const SOFT = "#FBF7EF";
// Burned overlays are rendered by ffmpeg with GmarketSans Bold; use the same
// face in the preview so on-screen text matches the baked output.
const OVERLAY_FONT = "'GmarketSansBold','Pretendard',system-ui,sans-serif";

// Per-line title font. Keys are baked into burn overlays and mapped to the
// matching bundled Gmarket weight by the backend (_overlay_font_path).
type FontKey = "bold" | "medium" | "light";
const TITLE_FONTS: { key: FontKey; label: string; family: string; weight: number }[] = [
  { key: "bold", label: "볼드", family: "GmarketSansBold", weight: 800 },
  { key: "medium", label: "미디엄", family: "GmarketSansMedium", weight: 600 },
  { key: "light", label: "라이트", family: "GmarketSansLight", weight: 300 },
];
function titleFont(font: FontKey): { family: string; weight: number } {
  const found = TITLE_FONTS.find(item => item.key === font) || TITLE_FONTS[0];
  return { family: `'${found.family}','Pretendard',system-ui,sans-serif`, weight: found.weight };
}

// A single title line. The whole title is a list of these, seeded from the
// LLM shorts title; each line is styled (color / size / spacing / font) on its own.
type TitleLine = { id: string; text: string; on: boolean; size: number; color: string; spacing: number; font: FontKey };

type TemplatePreset = {
  id: TemplatePresetId;
  label: string;
  hint: string;
  aspect: AspectKey;
  zoom: number;
  bg: string;
  accent: string;
  titleAlign: "left" | "center" | "right";
  titleX: number;
  titleY: number;
  videoY: number;
  footX: number;
  footY: number;
  bottomX: number;
  bottomY: number;
  dualFrame: boolean;
  ytLayout: boolean;
  botTextOn: boolean;
  botSize: number;
  botColor: string;
  botFont: FontKey;
  showChannel: boolean;
  showSource: boolean;
  chanIconSize: number;
  chanNameSize: number;
  chanNameColor: string;
  chanNameSpacing: number;
  titleSize: number;
  titleColor: string;
  titleFont: FontKey;
  titleSpacing: number;
  previewBand: string;
};

const ASPECTS: { k: AspectKey; css: string; h: string; tY: number; vY: number; bY: number }[] = [
  { k: "16:9", css: "16 / 9", h: "34%", tY: 12, vY: 40, bY: 78 },
  { k: "4:3", css: "4 / 3", h: "44%", tY: 9, vY: 34, bY: 80 },
  { k: "1:1", css: "1 / 1", h: "56%", tY: 8, vY: 26, bY: 86 },
  { k: "4:5", css: "4 / 5", h: "66%", tY: 6, vY: 17, bY: 88 },
  { k: "3:4", css: "3 / 4", h: "72%", tY: 6, vY: 13, bY: 90 },
  { k: "9:16", css: "9 / 16", h: "100%", tY: 6, vY: 0, bY: 90 },
];

const COLORS = ["#FF4A1C", "#FFD400", "#27E0A0", "#5B8CFF", "#FF49DB", "#FFFFFF"];
const BG_SWATCHES = [
  { label: "화이트", color: "#ffffff" },
  { label: "블랙", color: "#0E0E12" },
  { label: "네이비", color: "#10162B" },
  { label: "크림", color: "#FBF3E4" },
];

const TEMPLATE_PRESETS: TemplatePreset[] = [
  {
    id: "stacked_channel",
    label: "상단 제목 + 채널",
    hint: "가로 원본을 쇼츠로 가장 무난하게",
    aspect: "16:9",
    zoom: 100,
    bg: "#ffffff",
    accent: ACCENT,
    titleAlign: "center",
    titleX: 6,
    titleY: 7,
    videoY: 33,
    footX: 8,
    footY: 76,
    bottomX: 6,
    bottomY: 88,
    dualFrame: false,
    ytLayout: false,
    botTextOn: false,
    botSize: 22,
    botColor: TEXT,
    botFont: "bold",
    showChannel: true,
    showSource: false,
    chanIconSize: 22,
    chanNameSize: 15,
    chanNameColor: TEXT,
    chanNameSpacing: 0,
    titleSize: 32,
    titleColor: TEXT,
    titleFont: "bold",
    titleSpacing: 0,
    previewBand: "34%",
  },
  {
    id: "full_bleed",
    label: "풀스크린 세로",
    hint: "이미 세로 영상이면 제일 자연스럽게",
    aspect: "9:16",
    zoom: 100,
    bg: "#0E0E12",
    accent: "#FFD400",
    titleAlign: "center",
    titleX: 6,
    titleY: 5,
    videoY: 0,
    footX: 8,
    footY: 88,
    bottomX: 6,
    bottomY: 90,
    dualFrame: false,
    ytLayout: false,
    botTextOn: false,
    botSize: 22,
    botColor: "#FFFFFF",
    botFont: "bold",
    showChannel: true,
    showSource: false,
    chanIconSize: 22,
    chanNameSize: 14,
    chanNameColor: "#FFFFFF",
    chanNameSpacing: 0,
    titleSize: 27,
    titleColor: "#FFFFFF",
    titleFont: "bold",
    titleSpacing: 0,
    previewBand: "100%",
  },
  {
    id: "caption_card",
    label: "캡션 카드",
    hint: "토크·예능 하이라이트용",
    aspect: "4:5",
    zoom: 104,
    bg: "#FBF3E4",
    accent: "#27A376",
    titleAlign: "center",
    titleX: 6,
    titleY: 6,
    videoY: 18,
    footX: 8,
    footY: 83,
    bottomX: 6,
    bottomY: 89,
    dualFrame: false,
    ytLayout: false,
    botTextOn: false,
    botSize: 22,
    botColor: TEXT,
    botFont: "medium",
    showChannel: true,
    showSource: true,
    chanIconSize: 24,
    chanNameSize: 14,
    chanNameColor: TEXT,
    chanNameSpacing: 0,
    titleSize: 28,
    titleColor: TEXT,
    titleFont: "bold",
    titleSpacing: 0,
    previewBand: "66%",
  },
  {
    id: "news_bar",
    label: "뉴스 바",
    hint: "정보형·이슈형 헤드라인",
    aspect: "16:9",
    zoom: 100,
    bg: "#10162B",
    accent: "#FFD400",
    titleAlign: "left",
    titleX: 6,
    titleY: 6,
    videoY: 30,
    footX: 8,
    footY: 90,
    bottomX: 6,
    bottomY: 83,
    dualFrame: false,
    ytLayout: false,
    botTextOn: true,
    botSize: 18,
    botColor: "#FFFFFF",
    botFont: "medium",
    showChannel: true,
    showSource: false,
    chanIconSize: 20,
    chanNameSize: 12,
    chanNameColor: "#FFD400",
    chanNameSpacing: 1,
    titleSize: 27,
    titleColor: "#FFFFFF",
    titleFont: "bold",
    titleSpacing: 0,
    previewBand: "34%",
  },
  {
    id: "comment_hook",
    label: "댓글 유도 훅",
    hint: "반응 갈리는 장면용",
    aspect: "1:1",
    zoom: 108,
    bg: "#16120D",
    accent: "#FF49DB",
    titleAlign: "center",
    titleX: 6,
    titleY: 7,
    videoY: 34,
    footX: 8,
    footY: 86,
    bottomX: 6,
    bottomY: 90,
    dualFrame: false,
    ytLayout: false,
    botTextOn: false,
    botSize: 22,
    botColor: "#FFFFFF",
    botFont: "bold",
    showChannel: true,
    showSource: false,
    chanIconSize: 24,
    chanNameSize: 13,
    chanNameColor: "#FFFFFF",
    chanNameSpacing: 0,
    titleSize: 34,
    titleColor: "#FFD400",
    titleFont: "bold",
    titleSpacing: 0,
    previewBand: "56%",
  },
];

const TABS: { key: EditorTab; label: string; icon: ReactNode }[] = [
  { key: "title", label: "텍스트", icon: <Type size={16} /> },
  { key: "channel", label: "채널", icon: <UserCircle size={16} /> },
  { key: "layout", label: "레이아웃", icon: <LayoutTemplate size={16} /> },
  { key: "captions", label: "자막", icon: <FileText size={16} /> },
  { key: "elements", label: "요소", icon: <Palette size={16} /> },
];

const HOOK_TABS: { key: EditorState["hookTab"]; label: string; title: string; row: string; value: string }[] = [
  { key: "hook", label: "하이라이트 훅", title: "첫 3초 훅", row: "훅 길이", value: "3초" },
  { key: "speed", label: "배속 설정", title: "리듬 보정", row: "재생 속도", value: "1.0x" },
  { key: "silence", label: "무음 제거", title: "무음 제거", row: "감지 민감도", value: "보통" },
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatSeconds(total: number): string {
  const safe = Math.max(0, Math.floor(total));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function trimText(text: string, fallback: string, max = 32): string {
  const clean = text.replace(/\s+/g, " ").trim() || fallback;
  return clean.length > max ? clean.slice(0, max).trim() : clean;
}

// The unified title is seeded as one line from the LLM-generated shorts title
// (youtube_metadata.youtube_title -> clip.yt.title), so "여기 나오는 정보 = LLM 제목".
function seedTitleText(clip: ShortcutEditorClip): string {
  return trimText(clip.yt?.title || clip.caption || clip.title, clip.title, 60);
}

function seedChannelName(clip: ShortcutEditorClip): string {
  return trimText(clip.channelName || "공식 채널명", "공식 채널명", 28);
}

function isTemplatePresetId(value: unknown): value is TemplatePresetId {
  return TEMPLATE_PRESETS.some(preset => preset.id === value);
}

function templatePreset(id: unknown): TemplatePreset {
  return TEMPLATE_PRESETS.find(preset => preset.id === id) || TEMPLATE_PRESETS[0];
}

function styleTitleLines(lines: TitleLine[], preset: TemplatePreset, clip: ShortcutEditorClip): TitleLine[] {
  const source = lines.length ? lines : [{ id: "t1", text: seedTitleText(clip), on: true, size: preset.titleSize, color: preset.titleColor, spacing: preset.titleSpacing, font: preset.titleFont }];
  return source.map((line, index) => ({
    ...line,
    on: line.on ?? true,
    size: Math.max(16, preset.titleSize - index * 3),
    color: preset.titleColor,
    spacing: preset.titleSpacing,
    font: preset.titleFont,
  }));
}

function applyTemplatePreset(state: EditorState, presetId: TemplatePresetId, clip: ShortcutEditorClip): EditorState {
  const preset = templatePreset(presetId);
  return {
    ...state,
    templatePresetId: preset.id,
    aspect: preset.aspect,
    zoom: preset.zoom,
    dualFrame: preset.dualFrame,
    ytLayout: preset.ytLayout,
    bg: preset.bg,
    accent: preset.accent,
    titleAlign: preset.titleAlign,
    titleLines: styleTitleLines(state.titleLines, preset, clip),
    botTextOn: preset.botTextOn,
    botSize: preset.botSize,
    botColor: preset.botColor,
    botFont: preset.botFont,
    showChannel: preset.showChannel,
    showSource: preset.showSource,
    chanIconSize: preset.chanIconSize,
    chanNameOn: true,
    chanNameSize: preset.chanNameSize,
    chanNameColor: preset.chanNameColor,
    chanNameSpacing: preset.chanNameSpacing,
    titleX: preset.titleX,
    titleY: preset.titleY,
    videoY: preset.videoY,
    footX: preset.footX,
    footY: preset.footY,
    bottomX: preset.bottomX,
    bottomY: preset.bottomY,
  };
}

function mergeInitialState(base: EditorState, saved: Partial<EditorState> | undefined, clip: ShortcutEditorClip): EditorState {
  if (!saved) return base;
  const savedPreset = isTemplatePresetId(saved.templatePresetId) ? saved.templatePresetId : base.templatePresetId;
  const merged = {
    ...applyTemplatePreset(base, savedPreset, clip),
    ...saved,
    templatePresetId: savedPreset,
  };
  if (!Array.isArray(saved.titleLines) || saved.titleLines.length === 0) {
    merged.titleLines = base.titleLines;
  }
  if (!Array.isArray(saved.overlays)) {
    merged.overlays = base.overlays;
  }
  if (!cleanOverlayText(merged.chanName) || (merged.chanSource === "yt" && merged.chanName === "공식 채널명")) {
    merged.chanName = seedChannelName(clip);
  }
  merged.trimOut = Math.max(1, Math.min(Math.round(clip.durSec || 44), Number(merged.trimOut) || Math.round(clip.durSec || 44)));
  merged.t = clamp(Number(merged.t) || 0, 0, Math.max(1, merged.trimOut));
  return merged;
}

function makeInitialState(clip: ShortcutEditorClip): EditorState {
  const duration = Math.max(8, Math.round(clip.durSec || 44));
  const base: EditorState = {
    templatePresetId: "stacked_channel",
    tab: "layout",
    aspect: "9:16",
    zoom: 100,
    dualFrame: false,
    deadzone: false,
    ytLayout: false,
    bg: "#ffffff",
    accent: ACCENT,
    titleAlign: "center",
    titleLines: [{ id: "t1", text: seedTitleText(clip), on: true, size: 30, color: TEXT, spacing: 0, font: "bold" }],
    bottomText: trimText(clip.title, "아래 제목을 입력하세요", 34),
    botTextOn: false,
    botSize: 24,
    botColor: TEXT,
    botSpacing: 0,
    botFont: "bold",
    showChannel: false,
    showSource: false,
    chanIconSize: 22,
    chanNameOn: true,
    chanSource: "yt",
    chanOpen: true,
    chanName: seedChannelName(clip),
    sourceTitle: trimText(clip.yt?.title || clip.title, "원본 영상 제목", 44),
    chanNameSize: 14,
    chanNameColor: TEXT,
    chanNameSpacing: 0,
    captionsOn: false,
    hl: ACCENT,
    hookTab: "hook",
    hookOn: true,
    playing: false,
    t: Math.min(21.4, duration - 1),
    overlays: [],
    titleX: 6,
    titleY: 7,
    videoY: 0,
    footX: 8,
    footY: 80,
    bottomX: 6,
    bottomY: 90,
    speed: 1,
    trimMode: false,
    trimIn: 0,
    trimOut: duration,
  };
  return mergeInitialState(applyTemplatePreset(base, "stacked_channel", clip), clip.initialEditorState, clip);
}

// The preview canvas is locked to 9:16 at 720px tall, which is the basis the
// backend uses to scale overlay px -> render px (see _scale_preview_px).
const PREVIEW_H = 720;
const PREVIEW_W = (PREVIEW_H * 9) / 16;

function pctFromPreviewPx(px: number): number {
  return (px / PREVIEW_H) * 100;
}

function cleanOverlayText(text?: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

let measureCanvas: HTMLCanvasElement | null = null;

// Wrap text to the overlay's pixel width using the same font/size the bake uses,
// so the line breaks the backend draws match what shows in the preview. Returns
// the text with "\n" between lines (the backend preserves these breaks).
function wrapOverlayText(text: string, fontPx: number, fontWeight: number, widthPct: number): string {
  const clean = cleanOverlayText(text);
  if (!clean || typeof document === "undefined") return clean;
  if (!measureCanvas) measureCanvas = document.createElement("canvas");
  const ctx = measureCanvas.getContext("2d");
  if (!ctx) return clean;
  ctx.font = `${fontWeight} ${fontPx}px ${OVERLAY_FONT}`;
  const maxWidthPx = (widthPct / 100) * PREVIEW_W;
  const fits = (value: string) => ctx.measureText(value).width <= maxWidthPx;
  const lines: string[] = [];
  let current = "";
  for (const word of clean.split(" ")) {
    const next = current ? `${current} ${word}` : word;
    if (fits(next)) {
      current = next;
      continue;
    }
    if (current) {
      lines.push(current);
      current = "";
    }
    if (fits(word)) {
      current = word;
      continue;
    }
    let chunk = "";
    for (const ch of word) {
      if (chunk && !fits(chunk + ch)) {
        lines.push(chunk);
        chunk = ch;
      } else {
        chunk += ch;
      }
    }
    current = chunk;
  }
  if (current) lines.push(current);
  return lines.join("\n");
}

function buildBurnOverlays(state: EditorState): BurnOverlay[] {
  const overlays: BurnOverlay[] = [];
  let titleCursorY = state.titleY;
  state.titleLines.forEach((line, index) => {
    if (!line.on || !cleanOverlayText(line.text)) return;
    const wrapped = wrapOverlayText(line.text, line.size, titleFont(line.font).weight, 88);
    overlays.push({
      kind: "text",
      role: `title_line_${index + 1}`,
      text: wrapped,
      x: state.titleX,
      y: titleCursorY,
      widthPct: 88,
      align: state.titleAlign,
      fontSize: line.size,
      color: line.color,
      font: line.font,
      shadow: true,
    });
    const lineCount = wrapped.split("\n").length;
    titleCursorY += pctFromPreviewPx(line.size * 1.22 * lineCount + 2);
  });
  if ((state.aspect === "16:9" || state.aspect === "4:3" || state.aspect === "1:1") && state.botTextOn && cleanOverlayText(state.bottomText)) {
    overlays.push({
      kind: "text",
      role: "bottom_title",
      text: wrapOverlayText(state.bottomText, state.botSize, titleFont(state.botFont).weight, 88),
      x: state.bottomX,
      y: state.bottomY,
      widthPct: 88,
      align: state.titleAlign,
      fontSize: state.botSize,
      color: state.botColor,
      font: state.botFont,
      boxColor: state.templatePresetId === "news_bar" ? "#10162B" : undefined,
      boxAlpha: state.templatePresetId === "news_bar" ? 0.92 : undefined,
      boxBorder: state.templatePresetId === "news_bar" ? 10 : undefined,
      shadow: true,
    });
  }
  if (state.showChannel && state.chanNameOn && cleanOverlayText(state.chanName)) {
    overlays.push({
      kind: "text",
      role: "channel_name",
      text: wrapOverlayText(state.chanName, state.chanNameSize, 700, 84),
      x: state.footX,
      y: state.footY,
      widthPct: 84,
      align: "center",
      fontSize: state.chanNameSize,
      color: state.chanNameColor,
      shadow: true,
    });
  }
  if (state.showChannel && state.showSource && cleanOverlayText(state.sourceTitle)) {
    overlays.push({
      kind: "text",
      role: "source_title",
      text: wrapOverlayText(state.sourceTitle, 12.5, 600, 84),
      x: state.footX,
      y: state.footY + pctFromPreviewPx(state.chanNameSize + 10),
      widthPct: 84,
      align: "center",
      fontSize: 12.5,
      color: "#8C8273",
      shadow: true,
    });
  }

  state.overlays.forEach(overlay => {
    if (overlay.type === "image" && overlay.src) {
      overlays.push({
        kind: "image",
        role: "uploaded_image",
        src: overlay.src,
        x: overlay.x,
        y: overlay.y,
        width: 120,
      });
      return;
    }
    if (overlay.type === "cta") {
      overlays.push({
        kind: "text",
        role: "cta",
        text: "지금 확인",
        x: overlay.x,
        y: overlay.y,
        fontSize: 14,
        color: "#FFFFFF",
        boxColor: "#FF4A1C",
        boxAlpha: 1,
        boxBorder: 12,
        shadow: false,
      });
      return;
    }
    if (overlay.type === "sticker") {
      overlays.push({
        kind: "text",
        role: "sticker",
        text: "이거 실화?",
        x: overlay.x,
        y: overlay.y,
        fontSize: 16,
        color: "#16120D",
        boxColor: "#FFD400",
        boxAlpha: 1,
        boxBorder: 8,
        shadow: false,
      });
      return;
    }
    if (overlay.type === "bubble") {
      overlays.push({
        kind: "text",
        role: "bubble",
        text: "한마디 하자면...",
        x: overlay.x,
        y: overlay.y,
        fontSize: 14,
        color: "#16120D",
        boxColor: "#FFFFFF",
        boxAlpha: 0.95,
        boxBorder: 10,
        shadow: true,
      });
      return;
    }
    if (overlay.type === "arrow") {
      overlays.push({
        kind: "text",
        role: "arrow",
        text: "→",
        x: overlay.x,
        y: overlay.y,
        fontSize: 48,
        color: "#FF4A1C",
        shadow: true,
      });
    }
  });

  return overlays;
}

function buildCaptionLines(clip: ShortcutEditorClip, duration: number) {
  const source = [
    clip.transcript,
    clip.transcript ? "" : clip.caption,
    clip.transcript ? "" : "지금 이 장면이 쇼츠에서 가장 먼저 잡혀야 해요",
  ]
    .filter(Boolean)
    .join(" ");
  const words = source.replace(/[,.!?]/g, "").split(/\s+/).filter(Boolean);
  // Break into short, readable caption lines (~6 words) so a full transcript
  // doesn't overflow the preview. Falls back to a single line when empty.
  const PER_LINE = 6;
  const chunkCount = Math.max(1, Math.ceil(words.length / PER_LINE));
  const chunks = Array.from({ length: chunkCount }, (_, i) =>
    words.slice(i * PER_LINE, (i + 1) * PER_LINE).join(" ") || "핵심 장면을 바로 보여줘요",
  );
  const span = duration / chunks.length;
  return chunks.map((text, index) => ({ t0: index * span, t1: (index + 1) * span, text }));
}

function Toggle({
  checked,
  onChange,
  tone = "#1F8A5B",
  title,
}: {
  checked: boolean;
  onChange: () => void;
  tone?: string;
  title?: string;
}) {
  return (
    <button
      onClick={onChange}
      title={title}
      style={{
        width: 44,
        height: 25,
        border: 0,
        borderRadius: 999,
        background: checked ? tone : "#CFC6B4",
        position: "relative",
        cursor: "pointer",
        transition: "background .16s",
        flex: "0 0 auto",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: checked ? 21 : 2,
          width: 21,
          height: 21,
          borderRadius: "50%",
          background: "#fff",
          boxShadow: "0 1px 3px rgba(0,0,0,.3)",
          transition: "left .16s",
        }}
      />
    </button>
  );
}

function PanelCard({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        border: "1px solid #E7DECC",
        borderRadius: 12,
        background: "#fff",
        padding: 14,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".04em", color: "#A0957F", textTransform: "uppercase", marginBottom: 10 }}>
      {children}
    </div>
  );
}

function ColorButton({
  color,
  active,
  onClick,
  round = 8,
  title,
}: {
  color: string;
  active: boolean;
  onClick: () => void;
  round?: number | string;
  title?: string;
}) {
  const dark = color !== "#FFFFFF" && color !== "#FFD400" && color !== "#ffffff" && color !== "#FBF3E4";
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 32,
        height: 32,
        borderRadius: round,
        background: color,
        border: `2px solid ${active ? ACCENT : "transparent"}`,
        boxShadow: "inset 0 0 0 1px #E1D8C6",
        cursor: "pointer",
        display: "grid",
        placeItems: "center",
      }}
    >
      {active && <Check size={14} strokeWidth={3.2} color={dark ? "#fff" : TEXT} />}
    </button>
  );
}

function RangeRow({
  label,
  value,
  suffix = "px",
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  suffix?: string;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 }}>
        <span style={{ fontSize: 12.5, color: "#5B5346" }}>{label}</span>
        <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 12.5, fontWeight: 700, color: TEXT }}>
          {value}{suffix}
        </span>
      </div>
      <input type="range" min={min} max={max} value={value} onChange={e => onChange(Number(e.target.value))} style={{ width: "100%" }} />
    </div>
  );
}

function EditableText({
  value,
  onChange,
  style,
}: {
  value: string;
  onChange: (value: string) => void;
  style: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current && document.activeElement !== ref.current && ref.current.textContent !== value) {
      ref.current.textContent = value;
    }
  }, [value]);

  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      onBlur={event => onChange(event.currentTarget.innerText.replace(/\s+/g, " ").trim())}
      style={{ cursor: "text", outline: "none", overflowWrap: "anywhere", ...style }}
    >
      {value}
    </div>
  );
}

export function ShortcutEditor({ clip, onClose, onSave, saving = false }: ShortcutEditorProps) {
  const [state, setState] = useState<EditorState>(() => makeInitialState(clip));
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const raf = useRef<number | null>(null);
  const overlaySeq = useRef(0);
  const titleSeq = useRef(Math.max(1, state.titleLines.length));
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const duration = Math.max(8, Math.round(clip.durSec || 44));

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    if (raf.current) cancelAnimationFrame(raf.current);
  }, []);

  const flash = (message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(null), 1900);
  };

  useEffect(() => {
    if (!state.playing) {
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = null;
      videoRef.current?.pause();
      return undefined;
    }

    let last = performance.now();
    const loop = (now: number) => {
      const delta = (now - last) / 1000;
      last = now;
      setState(prev => {
        const start = prev.trimMode ? prev.trimIn : 0;
        const end = prev.trimMode ? prev.trimOut : duration;
        let next = prev.t + delta * prev.speed;
        if (next >= end) next = start;
        return { ...prev, t: next };
      });
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    void videoRef.current?.play().catch(() => undefined);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = null;
    };
  }, [duration, state.playing]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (Number.isFinite(video.duration) && Math.abs(video.currentTime - state.t) > 0.45) {
      video.currentTime = Math.min(state.t, Math.max(0, video.duration - 0.1));
    }
    if (state.playing) void video.play().catch(() => undefined);
    else video.pause();
  }, [state.playing, state.t]);

  const captionLines = useMemo(() => buildCaptionLines(clip, duration), [clip, duration]);
  const activeLine = useMemo(() => {
    const found = captionLines.find(line => state.t >= line.t0 && state.t < line.t1);
    return found || captionLines[captionLines.length - 1];
  }, [captionLines, state.t]);
  const capWords = useMemo(() => {
    const words = activeLine.text.split(/\s+/).filter(Boolean);
    const span = Math.max(0.3, (activeLine.t1 - activeLine.t0) / Math.max(1, words.length));
    return words.map((word, index) => {
      const t0 = activeLine.t0 + index * span;
      const active = state.t >= t0 && state.t < t0 + span;
      return { word, active };
    });
  }, [activeLine, state.t]);

  const aspect = ASPECTS.find(item => item.k === state.aspect) || ASPECTS[5];
  // Clean, original-aspect frame for the preview so caption-card layouts don't
  // leak the finished short's baked-in blur bands / title. Falls back to the
  // rendered thumbnail for clips created before clean frames existed.
  const previewFrame = clip.sourceThumbnailUrl || clip.thumbnailUrl;
  const darkBg = state.bg !== "#ffffff" && state.bg !== "#FFFFFF" && state.bg !== "#FBF3E4";
  const titleShadow = darkBg ? "0 2px 10px rgba(0,0,0,.5)" : "none";
  const footMuted = darkBg ? "#B9B2A4" : MUTED;
  const bottomShow = (state.aspect === "16:9" || state.aspect === "4:3" || state.aspect === "1:1") && state.botTextOn;
  const newsBottomBar = state.templatePresetId === "news_bar";
  const selectedHook = HOOK_TABS.find(item => item.key === state.hookTab) || HOOK_TABS[0];
  const playPct = `${(state.t / duration) * 100}%`;
  const trimInPct = `${(state.trimIn / duration) * 100}%`;
  const trimOutPct = `${(state.trimOut / duration) * 100}%`;
  const trimWidth = `${((state.trimOut - state.trimIn) / duration) * 100}%`;

  const set = <K extends keyof EditorState>(key: K, value: EditorState[K]) => {
    setState(prev => ({ ...prev, [key]: value }));
  };

  const seek = (next: number) => {
    setState(prev => ({ ...prev, t: clamp(next, 0, duration) }));
  };

  const onScrub = (event: ReactMouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    seek(((event.clientX - rect.left) / rect.width) * duration);
  };

  const startTrim = (which: "in" | "out") => (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const track = event.currentTarget.closest("[data-editor-track]");
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const move = (ev: MouseEvent) => {
      const value = clamp(((ev.clientX - rect.left) / rect.width) * duration, 0, duration);
      setState(prev => {
        if (which === "in") return { ...prev, trimIn: Math.min(value, prev.trimOut - 1), t: Math.max(value, prev.t) };
        return { ...prev, trimOut: Math.max(value, prev.trimIn + 1), t: Math.min(value, prev.t) };
      });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const startMove = (xKey: MoveKey, yKey: MoveKey) => (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const canvas = event.currentTarget.closest("[data-editor-canvas]");
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const sx = event.clientX;
    const sy = event.clientY;
    const x0 = Number(state[xKey]);
    const y0 = Number(state[yKey]);
    const move = (ev: MouseEvent) => {
      const nx = clamp(x0 + ((ev.clientX - sx) / Math.max(1, rect.width)) * 100, -12, 94);
      const ny = clamp(y0 + ((ev.clientY - sy) / Math.max(1, rect.height)) * 100, -4, 97);
      setState(prev => ({ ...prev, [xKey]: nx, [yKey]: ny }));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const startVideoMove = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const canvas = event.currentTarget.closest("[data-editor-canvas]");
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const sy = event.clientY;
    const y0 = state.videoY;
    const move = (ev: MouseEvent) => {
      const next = clamp(y0 + ((ev.clientY - sy) / Math.max(1, rect.height)) * 100, -10, 90);
      setState(prev => ({ ...prev, videoY: next }));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const startOverlayMove = (id: string) => (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const canvas = event.currentTarget.closest("[data-editor-canvas]");
    if (!canvas) return;
    const overlay = state.overlays.find(item => item.id === id);
    if (!overlay) return;
    const rect = canvas.getBoundingClientRect();
    const sx = event.clientX;
    const sy = event.clientY;
    const x0 = overlay.x;
    const y0 = overlay.y;
    const move = (ev: MouseEvent) => {
      const nx = clamp(x0 + ((ev.clientX - sx) / Math.max(1, rect.width)) * 100, -12, 95);
      const ny = clamp(y0 + ((ev.clientY - sy) / Math.max(1, rect.height)) * 100, -6, 97);
      setState(prev => ({
        ...prev,
        overlays: prev.overlays.map(item => (item.id === id ? { ...item, x: nx, y: ny } : item)),
      }));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const addOverlay = (type: OverlayType, src?: string) => {
    const id = `ov${++overlaySeq.current}`;
    const n = state.overlays.length;
    setState(prev => ({
      ...prev,
      overlays: [...prev.overlays, { id, type, src, x: 34 + (n % 3) * 7, y: 44 + (n % 4) * 6 }],
    }));
    flash(({ image: "이미지", cta: "CTA 버튼", sticker: "스티커", arrow: "화살표", bubble: "말풍선" }[type]) + "를 추가했어요");
  };

  const removeOverlay = (id: string) => {
    setState(prev => ({ ...prev, overlays: prev.overlays.filter(item => item.id !== id) }));
  };

  const updateTitleLine = (id: string, patch: Partial<TitleLine>) => {
    setState(prev => ({ ...prev, titleLines: prev.titleLines.map(line => (line.id === id ? { ...line, ...patch } : line)) }));
  };

  const addTitleLine = () => {
    const id = `t${++titleSeq.current}`;
    setState(prev => ({
      ...prev,
      titleLines: [...prev.titleLines, { id, text: "새 제목 줄", on: true, size: 26, color: ACCENT, spacing: 0, font: "bold" }],
    }));
    flash("제목 줄을 추가했어요");
  };

  const removeTitleLine = (id: string) => {
    setState(prev => (prev.titleLines.length <= 1 ? prev : { ...prev, titleLines: prev.titleLines.filter(line => line.id !== id) }));
  };

  const onUploadImage = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => addOverlay("image", String(reader.result || ""));
    reader.readAsDataURL(file);
  };

  const resetEditor = () => {
    setState(makeInitialState(clip));
    flash("스타일을 초기화했어요");
  };

  const applyPreset = (presetId: TemplatePresetId) => {
    const preset = templatePreset(presetId);
    setState(prev => applyTemplatePreset(prev, preset.id, clip));
    flash(`${preset.label} 템플릿을 적용했어요`);
  };

  const handleSave = async () => {
    const enabledTitle = state.titleLines.filter(line => line.on && line.text.trim()).map(line => line.text.trim());
    const title = enabledTitle.join(" ").trim() || clip.title;
    const thumbnailText = enabledTitle[0] || clip.caption || clip.title;
    const templateId = state.templatePresetId;
    const overlayPosition = state.ytLayout ? "bottom_right" : state.aspect === "16:9" ? "top_center" : "top_right";
    await onSave({
      title,
      thumbnailText,
      templateId,
      overlayPosition,
      overlayScale: templateId === "news_bar" ? 0.14 : 0.12,
      editorState: state,
      burnOverlays: buildBurnOverlays(state),
    });
    flash("편집 설정을 저장했어요");
  };

  const renderOverlay = (overlay: EditorOverlay) => (
    <div key={overlay.id} style={{ position: "absolute", left: `${overlay.x}%`, top: `${overlay.y}%`, zIndex: 7 }}>
      <div
        onMouseDown={startOverlayMove(overlay.id)}
        style={{ position: "absolute", top: -10, left: -10, width: 22, height: 22, borderRadius: 6, background: TEXT, display: "grid", placeItems: "center", cursor: "move", zIndex: 2 }}
        title="이동"
      >
        <Move size={12} color="#fff" />
      </div>
      <button
        onClick={() => removeOverlay(overlay.id)}
        style={{ position: "absolute", top: -10, right: -10, width: 22, height: 22, border: 0, borderRadius: "50%", background: "#E11", color: "#fff", display: "grid", placeItems: "center", cursor: "pointer", zIndex: 2, fontSize: 14, lineHeight: 1 }}
        title="삭제"
      >
        ×
      </button>
      {overlay.type === "image" && overlay.src && (
        // eslint-disable-next-line @next/next/no-img-element -- user uploaded local preview
        <img src={overlay.src} alt="" style={{ display: "block", width: 120, maxWidth: "46vw", borderRadius: 8, boxShadow: "0 6px 18px -8px rgba(0,0,0,.5)" }} />
      )}
      {overlay.type === "cta" && <span style={{ display: "inline-flex", alignItems: "center", height: 34, padding: "0 17px", borderRadius: 999, background: ACCENT, color: "#fff", fontSize: 14, fontWeight: 800 }}>지금 확인</span>}
      {overlay.type === "sticker" && <span style={{ display: "inline-block", transform: "rotate(-4deg)", background: "#FFD400", color: TEXT, fontSize: 16, fontWeight: 800, padding: "6px 12px", borderRadius: 8 }}>이거 실화?</span>}
      {overlay.type === "arrow" && (
        <svg width="60" height="38" viewBox="0 0 64 40" fill="none" stroke={ACCENT} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 20h44M38 8l14 12-14 12" />
        </svg>
      )}
      {overlay.type === "bubble" && <span style={{ display: "inline-block", background: "#fff", color: TEXT, fontSize: 14, fontWeight: 700, padding: "8px 13px", borderRadius: 12, boxShadow: "0 4px 12px rgba(0,0,0,.18)" }}>한마디 하자면...</span>}
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 120, height: "100vh", display: "flex", flexDirection: "column", background: "#EFE8DA", color: TEXT, fontFamily: "'Pretendard',system-ui,sans-serif", WebkitFontSmoothing: "antialiased", overflow: "hidden" }}>
      <style>{`
        .shortcut-editor input[type=range]{-webkit-appearance:none;appearance:none;height:5px;border-radius:99px;background:#D8CDB6;outline:none}
        .shortcut-editor input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:#FF4A1C;cursor:pointer;box-shadow:0 0 0 4px rgba(255,74,28,.18)}
        .shortcut-editor button:disabled{opacity:.55;cursor:not-allowed}
        @media (max-width: 900px){
          .shortcut-editor-body{display:block !important;overflow:auto !important}
          .shortcut-editor-stage{min-height:640px}
          .shortcut-editor-panel{width:auto !important}
          .shortcut-editor-transport{gap:10px !important;overflow-x:auto}
        }
      `}</style>

      <div className="shortcut-editor" style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ height: 54, flex: "0 0 54px", display: "flex", alignItems: "center", gap: 10, padding: "0 24px", borderBottom: `1px solid ${LINE}`, background: "#F1EADF", zIndex: 30 }}>
          <span style={{ color: "#1F8A5B", display: "grid", placeItems: "center", flex: "0 0 auto" }}><Check size={18} /></span>
          <span style={{ fontSize: 14, fontWeight: 600, color: "#5B5346", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            쇼츠 제목, 자막, 레이아웃을 미리 보면서 조정하세요.
          </span>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
            <button onClick={resetEditor} style={{ height: 38, padding: "0 15px", border: `1px solid ${LINE}`, borderRadius: 10, background: SOFT, color: "#5B5346", display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              <RefreshCw size={15} />초기화
            </button>
            <button onClick={() => void handleSave()} disabled={saving} style={{ height: 38, padding: "0 18px", border: 0, borderRadius: 10, background: ACCENT, color: "#fff", display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 700, cursor: "pointer", boxShadow: "0 8px 18px -9px rgba(255,74,28,.9)" }}>
              <Save size={15} />{saving ? "저장 중..." : "저장하기"}
            </button>
            <button onClick={onClose} style={{ width: 38, height: 38, border: `1px solid ${LINE}`, borderRadius: 10, background: "#fff", color: "#5B5346", display: "grid", placeItems: "center", cursor: "pointer" }} title="닫기">
              <X size={17} />
            </button>
          </div>
        </div>

        <div className="shortcut-editor-body" style={{ flex: 1, minHeight: 0, display: "flex" }}>
          <div className="shortcut-editor-stage" style={{ flex: 1, minWidth: 0, position: "relative", display: "grid", placeItems: "center", padding: 28, background: "#E7DFD0", overflow: "auto" }}>
            <div style={{ position: "absolute", inset: 0, backgroundImage: "radial-gradient(#d4cab5 1px,transparent 1px)", backgroundSize: "22px 22px", opacity: 0.5 }} />
            <div data-editor-canvas style={{ position: "relative", height: 720, flex: "0 0 auto", aspectRatio: "9 / 16", background: state.bg, borderRadius: 16, overflow: "hidden", boxShadow: "0 30px 70px -30px rgba(20,15,10,.6)" }}>
              {state.titleLines.some(line => line.on) && (
                <div style={{ position: "absolute", top: `${state.titleY}%`, left: `${state.titleX}%`, width: "88%", zIndex: 5 }}>
                  <div onMouseDown={startMove("titleX", "titleY")} style={{ position: "absolute", top: -11, left: -11, width: 22, height: 22, borderRadius: 6, background: TEXT, display: "grid", placeItems: "center", cursor: "move", zIndex: 4 }} title="이동">
                    <Move size={12} color="#fff" />
                  </div>
                  {state.titleLines.map((line, index) => {
                    if (!line.on) return null;
                    const f = titleFont(line.font);
                    return (
                      <EditableText
                        key={line.id}
                        value={line.text}
                        onChange={value => updateTitleLine(line.id, { text: value || line.text })}
                        style={{ fontFamily: f.family, fontSize: line.size, fontWeight: f.weight, lineHeight: 1.22, letterSpacing: line.spacing, color: line.color, textAlign: state.titleAlign, textShadow: titleShadow, marginTop: index === 0 ? 0 : 2 }}
                      />
                    );
                  })}
                </div>
              )}

              <div style={{ position: "absolute", top: `${state.videoY}%`, left: 0, width: "100%" }}>
                <div style={{ position: "relative", width: "100%", aspectRatio: aspect.css, overflow: "hidden", background: "#0E0E12" }}>
                  {clip.videoUrl ? (
                    <video ref={videoRef} src={clip.videoUrl} playsInline preload="metadata" poster={previewFrame} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", transform: `scale(${state.zoom / 100})`, transformOrigin: "center", background: "#050505" }} />
                  ) : previewFrame ? (
                    <div style={{ position: "absolute", inset: 0, backgroundImage: `url(${previewFrame})`, backgroundSize: "cover", backgroundPosition: "center", transform: `scale(${state.zoom / 100})` }} />
                  ) : (
                    <div style={{ position: "absolute", inset: 0, transform: `scale(${state.zoom / 100})`, background: "linear-gradient(120deg,#FF8A4C 0%,#B6491F 52%,#2A160C 100%)" }} />
                  )}
                  <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", opacity: 0.14, transform: "rotate(-20deg) scale(1.6)", fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 14, letterSpacing: ".2em", color: "#fff", lineHeight: 2.6, whiteSpace: "nowrap", overflow: "hidden", pointerEvents: "none" }}>
                    STEP D STEP D STEP D<br />STEP D STEP D STEP D<br />STEP D STEP D STEP D<br />STEP D STEP D STEP D
                  </div>
                  {state.dualFrame && <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 2, background: ACCENT }} />}
                  <div onClick={() => set("playing", !state.playing)} style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", cursor: "pointer" }}>
                    <span style={{ width: 52, height: 52, borderRadius: "50%", background: ACCENT, display: "grid", placeItems: "center", boxShadow: "0 10px 24px rgba(255,74,28,.5)", opacity: state.playing ? 0 : 1, transition: "opacity .18s" }}>
                      <Play size={22} fill="#fff" color="#fff" />
                    </span>
                  </div>
                </div>
                <div onMouseDown={startVideoMove} style={{ position: "absolute", left: "50%", top: 8, transform: "translateX(-50%)", width: 28, height: 28, borderRadius: 7, background: "#fff", border: `1px solid ${ACCENT}`, display: "grid", placeItems: "center", cursor: "move", zIndex: 4, boxShadow: "0 3px 8px rgba(0,0,0,.2)" }} title="영상 이동">
                  <Move size={14} color="#C83920" />
                </div>
              </div>

              {state.captionsOn && capWords.length > 0 && (
                // Frame-relative so it matches the ASS subtitle, which is burned over
                // the whole 1080x1920 frame (Alignment 2, MarginV 220 -> ~11.5% from
                // the bottom). Font 26px ≈ ASS 70px scaled to the 720px canvas.
                <div style={{ position: "absolute", left: "7%", right: "7%", bottom: "11.5%", zIndex: 6, pointerEvents: "none" }}>
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: "2px 7px" }}>
                    {capWords.map((word, index) => (
                      <span key={`${word.word}-${index}`} style={{ fontFamily: OVERLAY_FONT, fontSize: 26, fontWeight: 800, lineHeight: 1.2, color: word.active ? state.hl : "#fff", WebkitTextStroke: "0.6px rgba(0,0,0,.92)", textShadow: "0 2px 6px rgba(0,0,0,.85)", transition: "color .1s" }}>
                        {word.word}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {state.showChannel && (
                <div style={{ position: "absolute", top: `${state.footY}%`, left: `${state.footX}%`, width: "84%", textAlign: "center", zIndex: 5 }}>
                  <div onMouseDown={startMove("footX", "footY")} style={{ position: "absolute", top: -11, left: 0, width: 22, height: 22, borderRadius: 6, background: TEXT, display: "grid", placeItems: "center", cursor: "move", zIndex: 4 }} title="채널 컴포넌트 이동">
                    <Move size={12} color="#fff" />
                  </div>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 7, justifyContent: "center" }}>
                    <span style={{ width: state.chanIconSize, height: state.chanIconSize, borderRadius: "50%", background: ACCENT, color: "#fff", display: "grid", placeItems: "center", flex: "0 0 auto" }}>
                      <Zap size="60%" fill="currentColor" />
                    </span>
                    {state.chanNameOn && (
                      <EditableText
                        value={state.chanName}
                        onChange={value => setState(prev => ({ ...prev, chanSource: "custom", chanName: value || prev.chanName }))}
                        style={{ fontFamily: OVERLAY_FONT, fontSize: state.chanNameSize, fontWeight: 700, letterSpacing: state.chanNameSpacing, color: state.chanNameColor }}
                      />
                    )}
                  </div>
                  {state.showSource && (
                    <EditableText
                      value={state.sourceTitle}
                      onChange={value => set("sourceTitle", value || state.sourceTitle)}
                      style={{ fontFamily: OVERLAY_FONT, fontSize: 12.5, fontWeight: 600, color: footMuted, marginTop: 6 }}
                    />
                  )}
                </div>
              )}

              {bottomShow && (
                <div style={{ position: "absolute", top: `${state.bottomY}%`, left: `${state.bottomX}%`, width: "88%", zIndex: 5 }}>
                  <div onMouseDown={startMove("bottomX", "bottomY")} style={{ position: "absolute", top: -11, left: -11, width: 22, height: 22, borderRadius: 6, background: TEXT, display: "grid", placeItems: "center", cursor: "move", zIndex: 4 }} title="이동">
                    <Move size={12} color="#fff" />
                  </div>
                  <EditableText
                    value={state.bottomText}
                    onChange={value => set("bottomText", value || state.bottomText)}
                    style={{
                      fontFamily: OVERLAY_FONT,
                      fontSize: state.botSize,
                      fontWeight: 800,
                      lineHeight: 1.22,
                      letterSpacing: state.botSpacing,
                      color: state.botColor,
                      textAlign: state.titleAlign,
                      textShadow: titleShadow,
                      background: newsBottomBar ? "rgba(16,22,43,.92)" : undefined,
                      borderRadius: newsBottomBar ? 8 : undefined,
                      padding: newsBottomBar ? "8px 10px" : undefined,
                    }}
                  />
                </div>
              )}

              {state.deadzone && <div style={{ position: "absolute", inset: "7% 6%", border: "1.5px dashed rgba(255,74,28,.55)", borderRadius: 6, pointerEvents: "none" }} />}

              {state.ytLayout && (
                <>
                  <div style={{ position: "absolute", right: 9, bottom: "13%", display: "flex", flexDirection: "column", gap: 15, alignItems: "center", pointerEvents: "none", color: "#fff", zIndex: 6 }}>
                    {["5.1K", "좋아요", "275", "공유", "리믹스"].map((label, index) => (
                      <div key={label} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                        {index === 0 ? <Check size={27} fill="currentColor" /> : index === 2 ? <MessageCircle size={27} fill="currentColor" /> : <Youtube size={27} fill="currentColor" />}
                        <span style={{ fontSize: 11, fontWeight: 700 }}>{label}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ position: "absolute", left: 11, right: 64, bottom: 10, pointerEvents: "none", color: "#fff", zIndex: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
                      <span style={{ width: 26, height: 26, borderRadius: "50%", background: "#fff", color: ACCENT, display: "grid", placeItems: "center", flex: "0 0 auto" }}><Zap size={15} fill="currentColor" /></span>
                      <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap" }}>@{state.chanName}</span>
                      <span style={{ height: 26, padding: "0 12px", display: "inline-flex", alignItems: "center", borderRadius: 999, background: "#fff", color: "#0E0E12", fontSize: 12, fontWeight: 800, flex: "0 0 auto" }}>구독</span>
                    </div>
                    <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.4, textShadow: "0 1px 6px rgba(0,0,0,.7)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{state.titleLines.filter(line => line.on).map(line => line.text).join(" ")}</div>
                  </div>
                </>
              )}

              {state.overlays.map(renderOverlay)}
            </div>
          </div>

          <aside className="shortcut-editor-panel" style={{ width: 380, flex: "0 0 380px", background: PANEL, borderLeft: `1px solid ${LINE}`, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, padding: "14px 14px 0" }}>
              {TABS.map(tab => {
                const active = state.tab === tab.key;
                return (
                  <button key={tab.key} onClick={() => set("tab", tab.key)} style={{ height: 32, padding: "0 12px", border: `1px solid ${active ? TEXT : LINE}`, borderRadius: 8, background: active ? TEXT : "#fff", color: active ? "#fff" : "#5B5346", fontSize: 12.5, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 6 }}>
                    {tab.icon}{tab.label}
                  </button>
                );
              })}
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: 18 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                <span style={{ color: ACCENT, display: "grid", placeItems: "center" }}>{TABS.find(tab => tab.key === state.tab)?.icon}</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: TEXT }}>{TABS.find(tab => tab.key === state.tab)?.label} 설정</span>
              </div>

              {state.tab === "layout" && (
                <div>
                  <SectionLabel>디자인 템플릿</SectionLabel>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 9, marginBottom: 22 }}>
                    {TEMPLATE_PRESETS.map(preset => {
                      const active = state.templatePresetId === preset.id;
                      return (
                        <button
                          key={preset.id}
                          onClick={() => applyPreset(preset.id)}
                          style={{
                            minHeight: 76,
                            border: `1.5px solid ${active ? ACCENT : "#E7DECC"}`,
                            borderRadius: 12,
                            background: active ? "#FFF1EC" : "#fff",
                            color: TEXT,
                            cursor: "pointer",
                            display: "grid",
                            gridTemplateColumns: "46px minmax(0,1fr)",
                            gap: 12,
                            alignItems: "center",
                            padding: "10px 12px",
                            textAlign: "left",
                          }}
                        >
                          <span style={{ width: 38, height: 58, borderRadius: 8, background: preset.bg, border: `1px solid ${active ? ACCENT : "#D8CDB6"}`, position: "relative", overflow: "hidden", boxShadow: "inset 0 0 0 1px rgba(0,0,0,.03)" }}>
                            <span style={{ position: "absolute", left: 5, right: 5, top: 6, height: 5, borderRadius: 999, background: preset.titleColor }} />
                            <span style={{ position: "absolute", left: 0, right: 0, top: `${preset.videoY}%`, height: preset.previewBand, background: "linear-gradient(135deg,#2A160C,#FF8A4C)", display: "block" }} />
                            {preset.showChannel && <span style={{ position: "absolute", left: 8, right: 8, top: `${preset.footY}%`, height: 4, borderRadius: 999, background: preset.chanNameColor }} />}
                          </span>
                          <span style={{ minWidth: 0 }}>
                            <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                              <span style={{ fontSize: 13.5, fontWeight: 800, color: active ? "#C83920" : TEXT, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{preset.label}</span>
                              {active && <Check size={14} color={ACCENT} strokeWidth={3} />}
                            </span>
                            <span style={{ display: "block", marginTop: 4, fontSize: 11.5, color: "#8C8273", lineHeight: 1.35 }}>{preset.hint}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  <SectionLabel>레이아웃</SectionLabel>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 22 }}>
                    {ASPECTS.map(item => {
                      const active = state.aspect === item.k;
                      return (
                        <button key={item.k} onClick={() => setState(prev => ({ ...prev, aspect: item.k, titleY: item.tY, videoY: item.vY, bottomY: item.bY }))} style={{ border: `1.5px solid ${active ? ACCENT : "#E7DECC"}`, borderRadius: 11, background: active ? "#FFF1EC" : "#fff", padding: "11px 8px 8px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                          <span style={{ width: 32, height: 54, borderRadius: 7, border: `2px solid ${active ? ACCENT : "#CFC6B4"}`, display: "block", position: "relative", overflow: "hidden", background: "#fff" }}>
                            <span style={{ position: "absolute", left: 0, right: 0, top: "50%", transform: "translateY(-50%)", height: item.h, background: active ? "linear-gradient(120deg,#FF8A4C,#2A160C)" : "#D8CDB6", display: "grid", placeItems: "center" }}>
                              <Play size={10} fill={active ? "#fff" : SOFT} color={active ? "#fff" : SOFT} />
                            </span>
                          </span>
                          <span style={{ fontSize: 11.5, fontWeight: 700, color: active ? "#C83920" : "#5B5346", fontFamily: "'Space Mono',monospace" }}>{item.k}</span>
                        </button>
                      );
                    })}
                  </div>

                  <PanelCard style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600 }}>듀얼 프레임</span>
                    <Toggle checked={state.dualFrame} onChange={() => set("dualFrame", !state.dualFrame)} tone={ACCENT} />
                  </PanelCard>

                  <PanelCard style={{ marginBottom: 14 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                      <ZoomIn size={16} color={ACCENT} />
                      <span style={{ fontSize: 13.5, fontWeight: 700 }}>영상 크기</span>
                      <span style={{ marginLeft: "auto", fontFamily: "'Space Mono',monospace", fontSize: 12.5, fontWeight: 700 }}>{state.zoom}%</span>
                    </div>
                    <input type="range" min={80} max={140} value={state.zoom} onChange={e => set("zoom", Number(e.target.value))} style={{ width: "100%" }} />
                  </PanelCard>

                  <button onClick={() => { setState(prev => ({ ...prev, videoY: 34, zoom: 100 })); flash("중앙 정렬했어요"); }} style={{ width: "100%", height: 42, border: `1px solid #E7DECC`, borderRadius: 10, background: "#fff", color: TEXT, fontSize: 13, fontWeight: 700, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, marginBottom: 9 }}>
                    <Move size={15} color={ACCENT} />중앙 정렬
                  </button>
                  <div style={{ display: "flex", gap: 9, marginBottom: 14 }}>
                    <button onClick={() => { setState(prev => ({ ...prev, titleX: 6, footX: 8 })); flash("수평 정렬했어요"); }} style={{ flex: 1, height: 42, border: `1px solid #E7DECC`, borderRadius: 10, background: "#fff", color: TEXT, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>수평</button>
                    <button onClick={() => { setState(prev => ({ ...prev, videoY: 34 })); flash("수직 정렬했어요"); }} style={{ flex: 1, height: 42, border: `1px solid #E7DECC`, borderRadius: 10, background: "#fff", color: TEXT, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>수직</button>
                  </div>
                  <PanelCard style={{ display: "grid", gap: 13 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}><span style={{ fontSize: 13.5, fontWeight: 600 }}>안전 영역 표시</span><Toggle checked={state.deadzone} onChange={() => set("deadzone", !state.deadzone)} tone={ACCENT} /></div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}><span style={{ fontSize: 13.5, fontWeight: 600 }}>유튜브 쇼츠 UI</span><Toggle checked={state.ytLayout} onChange={() => set("ytLayout", !state.ytLayout)} tone={ACCENT} /></div>
                  </PanelCard>
                </div>
              )}

              {state.tab === "title" && (
                <div style={{ display: "grid", gap: 13 }}>
                  <PanelCard>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                      <span style={{ fontSize: 13.5, fontWeight: 800, display: "inline-flex", alignItems: "center", gap: 8 }}><Type size={16} color={ACCENT} />제목 정렬</span>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      {(["left", "center", "right"] as const).map(key => {
                        const active = state.titleAlign === key;
                        const Icon = key === "left" ? AlignLeft : key === "right" ? AlignRight : AlignCenter;
                        return (
                          <button key={key} onClick={() => set("titleAlign", key)} style={{ flex: 1, height: 38, border: `1px solid ${active ? ACCENT : LINE}`, borderRadius: 10, background: active ? "#FFF1EC" : "#fff", color: active ? "#C83920" : "#5B5346", display: "grid", placeItems: "center", cursor: "pointer" }}>
                            <Icon size={18} />
                          </button>
                        );
                      })}
                    </div>
                  </PanelCard>

                  <div style={{ fontSize: 11.5, color: "#9A8F7E", lineHeight: 1.5, padding: "0 2px" }}>
                    제목은 LLM이 뽑아준 쇼츠 제목으로 채워져요. 줄을 추가해 나누고, 줄마다 색·크기·글씨체를 따로 지정할 수 있어요. 미리보기에서 글자를 눌러 내용을 고치세요.
                  </div>
                  {state.titleLines.map((line, index) => (
                    <TextLinePanel
                      key={line.id}
                      title={`제목 줄 ${index + 1}`}
                      enabled={line.on}
                      onToggle={() => updateTitleLine(line.id, { on: !line.on })}
                      size={line.size}
                      onSize={value => updateTitleLine(line.id, { size: value })}
                      spacing={line.spacing}
                      onSpacing={value => updateTitleLine(line.id, { spacing: value })}
                      color={line.color}
                      onColor={value => updateTitleLine(line.id, { color: value })}
                      font={line.font}
                      onFont={value => updateTitleLine(line.id, { font: value })}
                      onRemove={state.titleLines.length > 1 ? () => removeTitleLine(line.id) : undefined}
                    />
                  ))}
                  <button onClick={addTitleLine} style={{ height: 42, border: `1.5px dashed ${LINE}`, borderRadius: 11, background: "#fff", color: "#5B5346", fontSize: 13, fontWeight: 700, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7 }}>
                    <Type size={15} color={ACCENT} />+ 제목 줄 추가
                  </button>

                  <TextLinePanel
                    title="아래 제목"
                    enabled={state.botTextOn}
                    onToggle={() => set("botTextOn", !state.botTextOn)}
                    size={state.botSize}
                    onSize={value => set("botSize", value)}
                    spacing={state.botSpacing}
                    onSpacing={value => set("botSpacing", value)}
                    color={state.botColor}
                    onColor={value => set("botColor", value)}
                    font={state.botFont}
                    onFont={value => set("botFont", value)}
                  />
                </div>
              )}

              {state.tab === "channel" && (
                <div style={{ display: "grid", gap: 12 }}>
                  <PanelCard>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 700 }}><UserCircle size={16} color={ACCENT} />채널 프로필</span>
                      <Toggle checked={state.showChannel} onChange={() => set("showChannel", !state.showChannel)} />
                    </div>
                    <RangeRow label="프로필 이미지 크기" value={state.chanIconSize} min={16} max={48} onChange={value => set("chanIconSize", value)} />
                  </PanelCard>
                  <PanelCard>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 13 }}>
                      <span style={{ fontSize: 13.5, fontWeight: 700 }}>표시할 채널명</span>
                      <Toggle checked={state.chanNameOn} onChange={() => set("chanNameOn", !state.chanNameOn)} />
                    </div>
                    <button onClick={() => setState(prev => ({ ...prev, chanSource: "yt", chanName: seedChannelName(clip) }))} style={{ width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "7px 2px", border: 0, background: "transparent", cursor: "pointer", marginBottom: 4 }}>
                      <Radio active={state.chanSource === "yt"} />
                      <span style={{ fontSize: 13, color: TEXT }}>유튜브 채널 이름 사용</span>
                    </button>
                    <button onClick={() => set("chanSource", "custom")} style={{ width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "7px 2px", border: 0, background: "transparent", cursor: "pointer", marginBottom: 12 }}>
                      <Radio active={state.chanSource === "custom"} />
                      <span style={{ fontSize: 13, color: TEXT }}>채널명 직접 입력</span>
                    </button>
                    <div style={{ border: "1px solid #EAE1D0", borderRadius: 11, background: SOFT, overflow: "hidden" }}>
                      <button onClick={() => set("chanOpen", !state.chanOpen)} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 13px", border: 0, background: "transparent", cursor: "pointer" }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: TEXT }}>{state.chanName}</span>
                        <span style={{ color: "#A0957F" }}>{state.chanOpen ? "접기" : "열기"}</span>
                      </button>
                      {state.chanOpen && (
                        <div style={{ padding: "0 13px 14px" }}>
                          <RangeRow label="크기" value={state.chanNameSize} min={10} max={28} onChange={value => set("chanNameSize", value)} />
                          <div style={{ fontSize: 12.5, color: "#5B5346", margin: "12px 0 8px" }}>색상</div>
                          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                            {COLORS.map(color => <ColorButton key={color} color={color} active={state.chanNameColor === color} onClick={() => set("chanNameColor", color)} />)}
                          </div>
                          <RangeRow label="자간" value={state.chanNameSpacing} min={0} max={6} onChange={value => set("chanNameSpacing", value)} />
                        </div>
                      )}
                    </div>
                  </PanelCard>
                  <PanelCard style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600 }}>원본 영상 제목 표시</span>
                    <Toggle checked={state.showSource} onChange={() => set("showSource", !state.showSource)} />
                  </PanelCard>
                </div>
              )}

              {state.tab === "captions" && (
                <div>
                  <PanelCard style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
                    <div>
                      <div style={{ fontSize: 13.5, fontWeight: 600 }}>자막 표시</div>
                      <div style={{ fontSize: 11.5, color: "#9A8F7E", marginTop: 1 }}>미리보기 영상 위 자막을 렌더합니다.</div>
                    </div>
                    <Toggle checked={state.captionsOn} onChange={() => set("captionsOn", !state.captionsOn)} />
                  </PanelCard>
                  <SectionLabel>강조 색상</SectionLabel>
                  <div style={{ display: "flex", gap: 9, marginBottom: 20 }}>
                    {COLORS.map(color => <ColorButton key={color} color={color} active={state.hl === color} onClick={() => set("hl", color)} round="50%" />)}
                  </div>
                  <PanelCard>
                    <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                      {HOOK_TABS.map(item => {
                        const active = state.hookTab === item.key;
                        return (
                          <button key={item.key} onClick={() => set("hookTab", item.key)} style={{ flex: 1, height: 34, border: 0, borderRadius: 9, background: active ? TEXT : "transparent", color: active ? "#fff" : MUTED, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{item.label}</button>
                        );
                      })}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                      <span style={{ fontSize: 13.5, fontWeight: 700 }}>{selectedHook.title}</span>
                      <Toggle checked={state.hookOn} onChange={() => set("hookOn", !state.hookOn)} tone="#7C5BD0" />
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", padding: 11, borderRadius: 10, background: SOFT, border: "1px solid #EFE7D8" }}>
                      <span style={{ fontSize: 12.5, color: "#5B5346" }}>{selectedHook.row}</span>
                      <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 12.5, fontWeight: 700 }}>{selectedHook.value}</span>
                    </div>
                  </PanelCard>
                </div>
              )}

              {state.tab === "elements" && (
                <div>
                  <SectionLabel>이미지 업로드</SectionLabel>
                  <label style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 7, height: 96, border: "1.5px dashed #D8CDB6", borderRadius: 12, background: "#fff", cursor: "pointer", marginBottom: 18 }}>
                    <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { onUploadImage(event.target.files?.[0]); event.currentTarget.value = ""; }} style={{ display: "none" }} />
                    <span style={{ width: 38, height: 38, borderRadius: 11, background: TEXT, color: "#fff", display: "grid", placeItems: "center" }}><Upload size={19} /></span>
                    <span style={{ fontSize: 12.5, fontWeight: 700 }}>PNG, JPG 올리기</span>
                  </label>

                  <SectionLabel>요소 추가</SectionLabel>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9, marginBottom: 22 }}>
                    <ElementButton icon={<MousePointer2 size={18} />} label="CTA 버튼" onClick={() => addOverlay("cta")} />
                    <ElementButton icon={<Sparkles size={18} />} label="스티커" onClick={() => addOverlay("sticker")} />
                    <ElementButton icon={<ArrowRight size={18} />} label="화살표" onClick={() => addOverlay("arrow")} />
                    <ElementButton icon={<MessageCircle size={18} />} label="말풍선" onClick={() => addOverlay("bubble")} />
                  </div>

                  <SectionLabel>배경 색상</SectionLabel>
                  <div style={{ display: "flex", gap: 9 }}>
                    {BG_SWATCHES.map(item => <ColorButton key={item.color} color={item.color} active={state.bg === item.color} onClick={() => set("bg", item.color)} title={item.label} />)}
                  </div>
                </div>
              )}
            </div>
          </aside>
        </div>

        <div className="shortcut-editor-transport" style={{ height: 80, flex: "0 0 80px", display: "flex", alignItems: "center", gap: 18, padding: "0 22px", borderTop: `1px solid ${LINE}`, background: "#F5F0E7", zIndex: 20 }}>
          <button onClick={() => set("playing", !state.playing)} style={{ width: 44, height: 44, border: 0, borderRadius: "50%", background: TEXT, color: "#fff", display: "grid", placeItems: "center", cursor: "pointer", flex: "0 0 auto", boxShadow: "0 6px 16px -6px rgba(22,18,13,.7)" }} title="재생/정지">
            {state.playing ? <Pause size={18} fill="#fff" /> : <Play size={18} fill="#fff" />}
          </button>
          <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 13, fontWeight: 700, flex: "0 0 auto" }}>
            <span style={{ color: "#C83920" }}>{formatSeconds(state.t)}</span><span style={{ color: "#A0957F" }}> / {formatSeconds(duration)}</span>
          </div>

          <div data-editor-track onClick={onScrub} style={{ flex: 1, position: "relative", height: 44, borderRadius: 10, background: "#EBE3D4", cursor: "pointer", overflow: "hidden", display: "flex", alignItems: "center", minWidth: 180 }}>
            <div style={{ position: "absolute", left: 6, right: 6, height: 24, display: "flex", gap: 2 }}>
              {Array.from({ length: 16 }, (_, index) => (
                <div key={index} style={{ flex: 1, height: "100%", borderRadius: 3, background: `linear-gradient(120deg,${["#FF8A4C", "#B6491F", "#2A160C"][index % 3]},#1a120b)`, opacity: 0.5 }} />
              ))}
            </div>
            {state.trimMode && (
              <>
                <div style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: trimInPct, background: "rgba(20,15,10,.45)" }} />
                <div style={{ position: "absolute", top: 0, bottom: 0, left: trimOutPct, right: 0, background: "rgba(20,15,10,.45)" }} />
                <div style={{ position: "absolute", top: 0, bottom: 0, left: trimInPct, width: trimWidth, border: `2px solid ${ACCENT}`, borderRadius: 6, boxSizing: "border-box", pointerEvents: "none" }} />
                <div onMouseDown={startTrim("in")} style={{ position: "absolute", top: 0, bottom: 0, left: trimInPct, width: 12, transform: "translateX(-50%)", background: ACCENT, borderRadius: 4, cursor: "ew-resize", zIndex: 6, display: "grid", placeItems: "center" }}><span style={{ width: 2, height: 14, background: "#fff", borderRadius: 2 }} /></div>
                <div onMouseDown={startTrim("out")} style={{ position: "absolute", top: 0, bottom: 0, left: trimOutPct, width: 12, transform: "translateX(-50%)", background: ACCENT, borderRadius: 4, cursor: "ew-resize", zIndex: 6, display: "grid", placeItems: "center" }}><span style={{ width: 2, height: 14, background: "#fff", borderRadius: 2 }} /></div>
              </>
            )}
            <div style={{ position: "absolute", top: 0, bottom: 0, left: playPct, width: 2, background: ACCENT, zIndex: 5, pointerEvents: "none" }}>
              <span style={{ position: "absolute", top: -2, left: -6, width: 14, height: 14, borderRadius: "50%", background: ACCENT, boxShadow: "0 2px 6px rgba(255,74,28,.7)" }} />
            </div>
          </div>

          <button onClick={() => set("trimMode", !state.trimMode)} style={{ height: 40, padding: "0 15px", border: `1px solid ${state.trimMode ? ACCENT : LINE}`, borderRadius: 10, background: state.trimMode ? ACCENT : "#fff", color: state.trimMode ? "#fff" : TEXT, display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 700, cursor: "pointer", flex: "0 0 auto" }} title="구간 자르기">
            <Scissors size={15} />자르기
          </button>
          <button onClick={() => set("speed", state.speed === 0.5 ? 1 : state.speed === 1 ? 1.5 : state.speed === 1.5 ? 2 : 0.5)} style={{ height: 40, padding: "0 14px", border: `1px solid ${LINE}`, borderRadius: 10, background: "#fff", color: TEXT, fontFamily: "'Space Mono',monospace", fontSize: 13, fontWeight: 700, cursor: "pointer", flex: "0 0 auto" }} title="재생 속도">
            {state.speed}x
          </button>
        </div>

        {toast && (
          <div style={{ position: "fixed", left: "50%", bottom: 28, zIndex: 140, transform: "translateX(-50%)", display: "inline-flex", alignItems: "center", gap: 10, padding: "12px 19px", borderRadius: 13, background: TEXT, color: "#fff", fontSize: 13, fontWeight: 600, boxShadow: "0 18px 40px -16px rgba(0,0,0,.6)" }}>
            <span style={{ width: 19, height: 19, borderRadius: "50%", background: "#1F8A5B", display: "grid", placeItems: "center", flex: "0 0 auto" }}><Check size={12} strokeWidth={2.6} /></span>
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}

function TextLinePanel({
  title,
  enabled,
  onToggle,
  size,
  onSize,
  spacing,
  onSpacing,
  color,
  onColor,
  font,
  onFont,
  onRemove,
}: {
  title: string;
  enabled: boolean;
  onToggle: () => void;
  size: number;
  onSize: (value: number) => void;
  spacing: number;
  onSpacing: (value: number) => void;
  color: string;
  onColor: (value: string) => void;
  font?: FontKey;
  onFont?: (value: FontKey) => void;
  onRemove?: () => void;
}) {
  return (
    <PanelCard style={{ border: `1.5px solid ${enabled ? "#E0D3B8" : "#ECE5D6"}` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 800, color: enabled ? TEXT : "#A89C87" }}>
          <span style={{ width: 20, height: 20, borderRadius: 6, background: enabled ? ACCENT : "#CFC6B4", color: "#fff", display: "grid", placeItems: "center" }}><Type size={12} /></span>
          {title}
        </span>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {onRemove && (
            <button onClick={onRemove} title="줄 삭제" style={{ width: 26, height: 26, border: "1px solid #F0D9CE", borderRadius: 8, background: "#FFF6F4", color: "#C0392B", display: "grid", placeItems: "center", cursor: "pointer" }}>
              <X size={14} />
            </button>
          )}
          <Toggle checked={enabled} onChange={onToggle} />
        </div>
      </div>
      {enabled && (
        <div style={{ marginTop: 14 }}>
          <RangeRow label="크기" value={size} min={14} max={48} onChange={onSize} />
          {font && onFont && (
            <>
              <div style={{ fontSize: 12.5, color: "#5B5346", margin: "12px 0 8px" }}>글씨체</div>
              <div style={{ display: "flex", gap: 7 }}>
                {TITLE_FONTS.map(item => {
                  const active = font === item.key;
                  return (
                    <button key={item.key} onClick={() => onFont(item.key)} style={{ flex: 1, height: 38, border: `1.5px solid ${active ? ACCENT : LINE}`, borderRadius: 9, background: active ? "#FFF1EC" : "#fff", color: active ? "#C83920" : "#5B5346", fontFamily: `'${item.family}',sans-serif`, fontSize: 13.5, cursor: "pointer" }}>
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </>
          )}
          <div style={{ fontSize: 12.5, color: "#5B5346", margin: "12px 0 8px" }}>색상</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {COLORS.map(item => <ColorButton key={item} color={item} active={color === item} onClick={() => onColor(item)} />)}
          </div>
          <RangeRow label="자간" value={spacing} min={0} max={8} onChange={onSpacing} />
        </div>
      )}
    </PanelCard>
  );
}

function ElementButton({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ height: 74, border: "1px solid #E7DECC", borderRadius: 11, background: "#fff", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, cursor: "pointer", color: "#5B5346" }}>
      <span style={{ display: "grid", placeItems: "center", color: ACCENT }}>{icon}</span>
      <span style={{ fontSize: 12, fontWeight: 600, color: TEXT }}>{label}</span>
    </button>
  );
}

function Radio({ active }: { active: boolean }) {
  return (
    <span style={{ width: 18, height: 18, borderRadius: "50%", border: `2px solid ${active ? ACCENT : "#CFC6B4"}`, display: "grid", placeItems: "center", flex: "0 0 auto" }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: active ? ACCENT : "transparent" }} />
    </span>
  );
}
