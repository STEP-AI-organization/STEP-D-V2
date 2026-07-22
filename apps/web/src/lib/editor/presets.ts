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
export type CaptionStyle =
  | "korean_pop"    // 예능 팝 (기본, 두꺼운 검은 스트로크)
  | "clean"         // 미니멀 (얇은 그림자)
  | "news"          // 뉴스 바 (검은 박스)
  | "yellow_pop"    // 노란 팝 (하하PD 학습 신호 · 강한 노랑)
  | "cyan_neon"     // 시안 네온 (Z세대 릴즈 유행)
  | "pink_bubble"   // 핑크 버블
  | "outline_bold"  // 굵은 아웃라인만
  | "shadow_soft"   // 부드러운 그림자
  | "highlight_bar" // 형광펜 하이라이트
  | "typewriter";   // 타자기 검정 박스
export type ElementType = "cta" | "sticker" | "arrow" | "bubble";

export interface KeyframePoint {
  time: number; // seconds relative to element start (= clip trim-in)
  x?: number; // % — elements: absolute stage position, title lines: offset from layout
  y?: number; // %
  scale?: number; // 0.5–2.0
  opacity?: number; // 0–1
  rotation?: number; // degrees
}

export interface KeyframeSample {
  x?: number;
  y?: number;
  scale: number;
  opacity: number;
  rotation: number;
}

/** Linear per-property interpolation across keyframes; values hold at both ends.
 *  null = no keyframes → caller renders the static layout unchanged (backward compat).
 *  안전장치: 저장된 상태 복원 시 keyframes에 NaN·undefined·time 누락이 섞이면 좌표가
 *  NaN으로 점프해 오버레이가 화면에서 사라지거나 렌더 오류가 난다. 유효성 검증을 진입에서
 *  강제해, 잘못된 keyframe은 조용히 필터하고 나머지로만 보간한다. */
export function sampleKeyframes(keyframes: KeyframePoint[] | undefined, time: number): KeyframeSample | null {
  if (!keyframes || keyframes.length === 0) return null;
  // time 자체가 유한수인지 방어 (NaN이 들어오면 모든 비교가 false라 last를 반환 → 부드럽지 못한 점프)
  if (!Number.isFinite(time)) return null;
  // time이 유한하고 keyframes에 time 필드가 유효한 것만 사용. NaN·undefined·Infinity 배제.
  const sorted = keyframes
    .filter((k) => k && Number.isFinite(k.time))
    .slice()
    .sort((a, b) => a.time - b.time);
  if (sorted.length === 0) return null;
  function prop(key: "x" | "y" | "scale" | "opacity" | "rotation"): number | undefined {
    // 유한한 값만 남김 (NaN·Infinity 배제 — 이걸로 다음 보간이 오염되면 좌표 폭발)
    const pts = sorted.filter((k) => typeof k[key] === "number" && Number.isFinite(k[key] as number));
    if (pts.length === 0) return undefined;
    if (time <= pts[0].time) return pts[0][key];
    const last = pts[pts.length - 1];
    if (time >= last.time) return last[key];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (time >= a.time && time <= b.time) {
        // 동일 time 두 개 있을 때 0으로 나누기 방지 (기존 안전장치 유지)
        const f = b.time === a.time ? 0 : (time - a.time) / (b.time - a.time);
        const va = a[key] as number;
        const vb = b[key] as number;
        const out = va + (vb - va) * f;
        // 보간 결과가 유한한지 최종 확인 (극단 경우 대비)
        return Number.isFinite(out) ? out : va;
      }
    }
    return last[key];
  }
  return {
    x: prop("x"),
    y: prop("y"),
    scale: prop("scale") ?? 1,
    opacity: prop("opacity") ?? 1,
    rotation: prop("rotation") ?? 0,
  };
}

/** Timeline/panel keyframe selection: target = EditorElement.id or TitleLine.id, index = -1 none. */
export type KfSelection = { target: string; index: number } | null;

export interface FilterSettings {
  brightness: number; // 0–200, default 100
  contrast: number; // 0–200, default 100
  saturation: number; // 0–200, default 100
  warmth: number; // -100–100, default 0
}

export const DEFAULT_FILTERS: FilterSettings = { brightness: 100, contrast: 100, saturation: 100, warmth: 0 };

/** CSS filter string for the preview <video>. undefined = all defaults (no filter). */
export function filterCss(f?: FilterSettings): string | undefined {
  if (!f) return undefined;
  const parts: string[] = [];
  if (f.brightness !== 100) parts.push(`brightness(${f.brightness}%)`);
  if (f.contrast !== 100) parts.push(`contrast(${f.contrast}%)`);
  if (f.saturation !== 100) parts.push(`saturate(${f.saturation}%)`);
  // Warmth: sepia tints toward orange; the hue-rotate(180°) flip turns the tint cool.
  if (f.warmth > 0) parts.push(`sepia(${Math.round(f.warmth * 0.35)}%)`);
  else if (f.warmth < 0) parts.push(`sepia(${Math.round(-f.warmth * 0.35)}%) hue-rotate(180deg)`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export interface TitleLine {
  id: string;
  text: string;
  size: number;
  color: string;
  keyframes?: KeyframePoint[]; // absent/empty = static (backward compat)
  /** Visible window, segment-relative seconds. Omitted = shown for the full clip. */
  startSec?: number;
  endSec?: number;
}

export interface EditorElement {
  id: string;
  type: ElementType;
  x: number; // %
  y: number; // %
  text: string;
  size?: number; // font px; falls back to a per-type default
  keyframes?: KeyframePoint[]; // absent/empty = static (backward compat)
  /** Visible window, segment-relative seconds. Omitted = shown for the full clip. */
  startSec?: number;
  endSec?: number;
}

/** A caption word window (seconds). Mirrors the server's Caption word shape. */
export interface CaptionWord { word: string; start: number; end: number }

/**
 * Approximate per-word timings from a caption's text + [start,end] when STT gave none.
 * MUST match the server's synthesizeWords (apps/server/src/index.ts) so the preview's
 * word-by-word highlight lands exactly where the render burns it. Syllable-weighted
 * (Korean: 1 글자 ≈ 1 음절); single-token captions gain nothing and return [].
 */
export function synthesizeCaptionWords(text: string, start: number, end: number): CaptionWord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  const dur = end - start;
  if (tokens.length < 2 || !(dur > 0)) return [];
  const weights = tokens.map((t) => Math.max(1, [...t].length));
  const total = weights.reduce((a, b) => a + b, 0);
  const out: CaptionWord[] = [];
  let t = start;
  tokens.forEach((tok, i) => {
    const we = i === tokens.length - 1 ? end : t + (weights[i] / total) * dur;
    out.push({ word: tok, start: t, end: we });
    t = we;
  });
  return out;
}

/** Keyword (content-word) indices to colour-emphasize — mirror of the server's pickKeywordIdx. */
export function pickKeywordIdx(tokens: string[]): Set<number> {
  const scored = tokens
    .map((t, i) => ({ i, len: [...t.replace(/[^\p{L}\p{N}]/gu, "")].length }))
    .filter((x) => x.len >= 2);
  if (!scored.length) return new Set<number>();
  scored.sort((a, b) => b.len - a.len);
  const n = Math.max(1, Math.round(tokens.length / 3));
  return new Set(scored.slice(0, n).map((x) => x.i));
}

/** Whether a timed overlay (title line / element) is visible at segment time `t`. */
export function overlayVisibleAt(o: { startSec?: number; endSec?: number }, t: number): boolean {
  if (o.startSec != null && t < o.startSec) return false;
  if (o.endSec != null && t > o.endSec) return false;
  return true;
}

/** Default font size (px) for a freshly added element. */
export function defaultElementSize(type: ElementType): number {
  return type === "arrow" ? 40 : 14;
}

/** Speed keyframe: from `time` (track-timeline seconds) onward, play at `speed`. */
export interface SpeedPoint {
  time: number;
  speed: number;
}

export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;

/** Step-function speed at `time`: the last point at or before it wins; before the
 *  first point (or with no points) the uniform base speed applies. */
export function speedAt(points: SpeedPoint[] | undefined, time: number, base: number): number {
  if (!points || points.length === 0) return base;
  let speed = base;
  for (const p of [...points].sort((a, b) => a.time - b.time)) {
    if (p.time > time) break;
    speed = p.speed;
  }
  return speed;
}

export type TransitionType = "cut" | "crossfade";

export interface TrackTransition {
  type: TransitionType;
  /** Overlap seconds (crossfade only; 0 for cut). */
  duration: number;
}

export const XFADE_MIN = 0.5;
export const XFADE_MAX = 2;
export const XFADE_DEFAULT = 1;

export interface EditorTrack {
  id: string;
  label: string;
  /** Track-relative seconds (0 = track start) */
  trimIn: number;
  trimOut: number;
  /** Position on master timeline */
  startTime: number;
  duration: number;
  /** Speed ramping keyframes. Empty = uniform speed from EditorState.speed. */
  speedPoints: SpeedPoint[];
  /** 0..1 */
  volume: number;
  muted: boolean;
  /** Visual color filters. Absent = all defaults (no filter) — backward compat. */
  filters?: FilterSettings;
  /** How this track enters from the previous one. Absent = hard cut (backward compat). */
  transition?: TrackTransition;
  /** For future: media source. For MVP, all tracks share the same video */
  mediaId?: string;
}

export function makeMainTrack(trimIn: number, trimOut: number, duration: number): EditorTrack {
  return {
    id: "track-main",
    label: "메인",
    trimIn,
    trimOut,
    startTime: 0,
    duration,
    speedPoints: [],
    volume: 1,
    muted: false,
    transition: { type: "cut", duration: 0 },
  };
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
  /** Colour for keyword (content-word) emphasis in captions. Absent = same as highlightColor. */
  keywordColor?: string;
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
  yellow_pop: "노란 팝",
  cyan_neon: "시안 네온",
  pink_bubble: "핑크 버블",
  outline_bold: "굵은 아웃라인",
  shadow_soft: "부드러운 그림자",
  highlight_bar: "형광펜",
  typewriter: "타자기",
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
 *  from the master trim so old clips keep working unchanged. Tracks saved before
 *  speed-ramping / volume get their defaults filled in (uniform speed, full volume). */
/** 저장된 EditorState 로드 시 스키마 진화 대응 — 옛 클립을 새 필드로 안전 마이그레이션.
 *  원칙: 필드가 없으면 안전한 기본값 자동 채움 → undefined 접근으로 인한 크래시 방지.
 *  새 필드 추가 시 여기 fallback을 반드시 등록할 것 (안 하면 옛 클립 로드가 폭발한다). */
export function ensureTracks(state: EditorState, durationSec: number): EditorState {
  const dur = Math.max(1, durationSec);
  const tracks =
    Array.isArray(state.tracks) && state.tracks.length > 0
      ? state.tracks.map((tr) => ({
          ...tr,
          speedPoints: Array.isArray(tr.speedPoints) ? tr.speedPoints : [],
          volume: typeof tr.volume === "number" ? tr.volume : 1,
          muted: tr.muted === true,
          transition: tr.transition ?? { type: "cut" as const, duration: 0 },
        }))
      : [makeMainTrack(state.trimIn ?? 0, state.trimOut ?? dur, dur)];

  // titleLines·elements의 keyframes가 undefined거나 배열 아닌 경우 빈 배열로 정규화.
  // sampleKeyframes는 undefined도 처리하지만, 다른 소비자(server render·인덱스 접근)가 배열 가정할 수 있음.
  const titleLines = Array.isArray(state.titleLines)
    ? state.titleLines.map((l) => ({ ...l, keyframes: Array.isArray(l.keyframes) ? l.keyframes : [] }))
    : [];
  const elements = Array.isArray(state.elements)
    ? state.elements.map((e) => ({ ...e, keyframes: Array.isArray(e.keyframes) ? e.keyframes : [] }))
    : [];

  // 새 필드 fallback — 옛 클립엔 없을 수 있음. 여기 나열된 것 외에 새 필드가 추가되면 여기에도 추가.
  return {
    ...state,
    tracks,
    titleLines,
    elements,
    // 자막 관련 (2026-07-22 확장: 10 스타일)
    captionStyle: state.captionStyle ?? "korean_pop",
    captionsOn: typeof state.captionsOn === "boolean" ? state.captionsOn : true,
    highlightColor: state.highlightColor ?? "#FFD400",
    keywordColor: state.keywordColor ?? state.highlightColor ?? "#FFD400",
    // 종횡비·배경·강조색
    aspect: state.aspect ?? "9:16",
    bg: state.bg ?? "#0E0E12",
    accent: state.accent ?? "#FFD400",
    templateId: state.templateId ?? "stacked_channel",
    // 제목 배치
    titleAlign: state.titleAlign ?? "center",
    titleX: typeof state.titleX === "number" ? state.titleX : 50,
    titleY: typeof state.titleY === "number" ? state.titleY : 8,
    // 채널
    showChannel: typeof state.showChannel === "boolean" ? state.showChannel : true,
    channelName: state.channelName ?? "",
    channelY: typeof state.channelY === "number" ? state.channelY : 82,
    // 세이프에어리어·필터
    showSafeArea: typeof state.showSafeArea === "boolean" ? state.showSafeArea : false,
    // 속도·훅
    speed: typeof state.speed === "number" && state.speed > 0 ? state.speed : 1,
    hookOn: typeof state.hookOn === "boolean" ? state.hookOn : false,
    silenceCut: typeof state.silenceCut === "boolean" ? state.silenceCut : false,
    offsetMs: typeof state.offsetMs === "number" ? state.offsetMs : 0,
    // 트림 (안전 범위 클램프)
    trimIn: typeof state.trimIn === "number" && Number.isFinite(state.trimIn) ? Math.max(0, state.trimIn) : 0,
    trimOut:
      typeof state.trimOut === "number" && Number.isFinite(state.trimOut) && state.trimOut > (state.trimIn ?? 0)
        ? Math.min(dur, state.trimOut)
        : dur,
  };
}

export function applyTemplate(state: EditorState, id: TemplateId): EditorState {
  const preset = TEMPLATE_PRESETS.find((p) => p.id === id);
  if (!preset) return state;
  return { ...state, templateId: id, ...preset.patch };
}
