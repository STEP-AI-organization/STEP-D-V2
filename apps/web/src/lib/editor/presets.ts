/**
 * STEP-D editor — declarative EditorState + template presets.
 *
 * Borrowed from StepD's ShortcutEditor contract (plan §3): the whole edit is one
 * serializable state object; the renderer re-derives output from it. Overlay
 * positions are percentages so they survive aspect changes, and the preview canvas
 * shares the renderer's px basis (WYSIWYG). Real ffmpeg/STT bake wires in at M6.
 */

export type AspectKey = "9:16" | "16:9" | "1:1" | "4:5";
/**
 * 프레임 템플릿 디렉토리 이름 (`assets/shorts-template/<name>`).
 * 예전 하드코딩 5종("stacked_channel" 등)은 캔바 프레임으로 대체됐다. 문자열로 열어둬야
 * 캔바에서 템플릿을 추가할 때 웹 코드를 안 고친다 — 목록은 서버가 준다.
 * 저장된 구 클립의 값이 그대로 남아 있을 수 있는데, 목록에 없으면 프레임 없이 렌더된다.
 */
export type TemplateId = string;
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

/** 채널 뱃지의 부가 줄. TitleLine의 서브셋 — 색은 흰색 고정, 시간창·키프레임 없음. */
export interface ChannelExtraLine {
  id: string;
  text: string;
  /** 폰트 크기(px). 미설정 시 채널명 크기의 약 75%. */
  size?: number;
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
 * Syllable-weighted (Korean: 1 글자 ≈ 1 음절); single-token captions gain nothing and return [].
 *
 * ⚠️ 현재 호출자 0 — 에디터 프리뷰의 단어별 하이라이트를 걷어내면서(2026-07-24, 한국 방송은
 * word-by-word 를 쓰지 않는다) 짝이던 프리뷰가 사라졌다. **서버 synthesizeWords 와 동기화할
 * 의무가 있는 미러가 아니다** — 프리뷰 하이라이트를 되살릴 때 그때 다시 맞추면 된다.
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

/** Keyword (content-word) indices to colour-emphasize.
 *  ⚠️ 위 synthesizeCaptionWords 와 같은 이유로 현재 호출자 0 — 동기화 대상 아님. */
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
  /** 축1 — 컨테이너(출력) 방향/비율. 실무는 가로(16:9)·세로(9:16) 둘이 전부다. */
  aspect: AspectKey;
  /**
   * 축2 — **원본을 컨테이너에 어떻게 넣나.**
   *  - "contain"(맞춤): 원본 그대로 넣어 남는 여백은 레터박스(뒤는 bgType 검정/블러).
   *  - "cover"(채우기): 원본을 잘라 컨테이너를 꽉 채운다.
   * 예전엔 이 축이 **프레임 템플릿 video.fit 안에만** 있어 프레임 없이는 사용자가 못 골랐다.
   * 이제 독립 필드로 꺼낸다. 프레임이 있으면 그 프레임의 fit 이 이 값의 시드가 된다(applyTemplate).
   */
  fit?: "contain" | "cover";
  bg: string;
  accent: string;
  titleLines: TitleLine[];
  titleAlign: "left" | "center" | "right";
  titleX: number; // %
  titleY: number; // %
  showChannel: boolean;
  channelName: string;
  channelY: number; // %
  /** 채널 뱃지 아이콘 — 업로드 이미지의 data URL(base64). 미설정이면 이니셜('CH') 대체. */
  channelIconDataUrl?: string;
  /** 채널 뱃지 스타일 프리셋 id. 클릭 시 layout·shape·아이콘 크기·라벨 크기가 프리셋 기본값으로
   *  세팅된다(그 후 사용자 개별 조정 가능). 프리셋이 부족하면 CHANNEL_BADGE_PRESETS에 추가. */
  channelBadgeTemplate?: ChannelBadgeTemplate;
  /** 아이콘/이니셜 지름(px). 프리셋 선택 시 함께 세팅되지만 슬라이더로 독립 조정 가능. */
  channelIconSize?: number;
  /** 채널명 텍스트 크기(px). 아이콘과 독립적으로 조정 가능. */
  channelLabelSize?: number;
  /** 채널명 아래에 붙는 부가 줄들. 제목의 titleLines처럼 자유롭게 추가/제거 가능.
   *  줄 하나당 텍스트 + 크기. 비어 있으면 렌더 안 함. */
  channelExtraLines?: ChannelExtraLine[];
  /** 프로그램 기본 아이콘(brandIconDataUrl)을 이 클립에서 끈다 — 하단 "제목만" 스타일. */
  channelIconOff?: boolean;
  /** 아이콘/로고의 세로 위치(%). 미지정이면 채널명 텍스트 위에 자동 배치. */
  channelIconY?: number;
  /** 방영시간 박스 라벨 (broadcast-standard) — 텍스트·위치(%)·박스 색. */
  channelBoxText?: string;
  channelBoxY?: number;
  channelBoxColor?: string;
  /** 아이콘·텍스트 배치. horizontal=[아이콘 텍스트], vertical=[아이콘]/[텍스트]. 프리셋이 세팅. */
  channelLayout?: "horizontal" | "vertical";
  /** 아이콘 모양. circle=원, rounded=둥근 사각, square=사각. 프리셋이 세팅. */
  channelIconShape?: "circle" | "rounded" | "square";
  /** 배경 채우기 방식. solid=단색(state.bg), blur=원본 영상 확대 블러, image=업로드 이미지.
   *  기존 저장분·미설정은 solid로 폴백(예전은 blur가 강제였는데 UX 정리로 solid를 기본). */
  bgType?: "solid" | "blur" | "image";
  /** bgType='image'일 때 표시할 이미지의 data URL(base64). */
  bgImageDataUrl?: string;
  /** 배경 이미지에서 실제로 프레임에 채울 사각형 영역(원본 이미지 대비 %). 미설정이면
   *  기존 object-fit:cover 동작(중앙 크롭). aspect는 영상 종횡비에 맞춰 UI가 강제한다. */
  bgImageCrop?: { xPct: number; yPct: number; wPct: number; hPct: number };
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
  /** YouTube (기타 배포처) 업로드 메타 — 헤더 메타데이터 팝오버가 편집·저장한다.
   *  생성 버튼이 title/desc/tags를 자막·소스 rec에서 뽑아 채운다. */
  uploadMeta?: {
    title: string;
    description: string;
    tags: string[];
  };
  /** trimIn/trimOut의 좌표계 표시.
   *  - "segment" (또는 undefined): 옛 저장분 — 값이 clip.startTime 기준 세그먼트 상대(0..segLen).
   *  - "master": 새 저장분 — 값이 마스터 전체(초) 기준 절대. 에디터가 원본 전체 타임라인을 보여주고
   *    사용자가 AI 추천 창 밖까지 트림을 확장할 수 있게 하면서부터 사용.
   *  ensureTracks가 옛 저장분을 감지해 "master"로 마이그레이션한다. */
  trimBase?: "segment" | "master";
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

// ── 채널 뱃지 프리셋 ────────────────────────────────────────────────────────────
// 자주 쓰는 조합을 이름으로 묶는다. 클릭 시 layout·shape·아이콘/라벨 크기가 모두 세팅.
// 프리셋 선택 후에도 슬라이더로 개별 크기 override 가능 (프리셋은 시작점일 뿐).
export type ChannelBadgeTemplate = "circle_inline" | "logo_stack";
export interface ChannelBadgePreset {
  id: ChannelBadgeTemplate;
  label: string;
  hint: string;
  patch: {
    channelLayout: "horizontal" | "vertical";
    channelIconShape: "circle" | "rounded" | "square";
    channelIconSize: number;
    channelLabelSize: number;
  };
}
export const CHANNEL_BADGE_PRESETS: ChannelBadgePreset[] = [
  {
    id: "circle_inline",
    label: "원형 배지",
    hint: "가장 무난 · YouTube 기본 스타일",
    patch: { channelLayout: "horizontal", channelIconShape: "circle", channelIconSize: 24, channelLabelSize: 14 },
  },
  {
    id: "logo_stack",
    label: "로고 블록",
    hint: "아이콘 위·이름 아래 · 프로그램 로고형",
    patch: { channelLayout: "vertical", channelIconShape: "rounded", channelIconSize: 48, channelLabelSize: 16 },
  },
];

// ── 기본 채널 아이콘 프리셋 ─────────────────────────────────────────────────────
// 각 플랫폼 공식 favicon(각 도메인이 직접 서빙)을 apps/web/public/channel-icons/*.png
// 로 정적 배포. 클릭 시 state.channelIconDataUrl에 해당 파일 경로가 세팅되고, <img src>는
// data URL / URL path 둘 다 그대로 로드한다.
export interface ChannelIconPreset {
  id: string;
  label: string;
  /** 정적 파일 경로 또는 data URL. state.channelIconDataUrl에 그대로 세팅된다. */
  src: string;
}
export const CHANNEL_ICON_PRESETS: ChannelIconPreset[] = [
  { id: "soop", label: "SOOP", src: "/channel-icons/soop.png" },
  { id: "youtube", label: "YouTube", src: "/channel-icons/youtube.png" },
  { id: "chzzk", label: "치지직", src: "/channel-icons/chzzk.png" },
  { id: "kbs", label: "KBS", src: "/channel-icons/kbs.png" },
  { id: "mbc", label: "MBC", src: "/channel-icons/mbc.png" },
  { id: "sbs", label: "SBS", src: "/channel-icons/sbs.png" },
  { id: "jtbc", label: "JTBC", src: "/channel-icons/jtbc.png" },
  { id: "tvn", label: "tvN", src: "/channel-icons/tvn.png" },
];

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

/** @deprecated 캔바 프레임 템플릿으로 대체됨. 구 클립의 templateId 하위호환용으로만 남긴다. */
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

/**
 * @param title 초기 제목
 * @param masterDurationSec 마스터(원본) 전체 길이 — 타임라인 상한
 * @param trimIn 마스터 절대 초 — 초기 트림 IN (AI 추천 시작). 미지정 시 0.
 * @param trimOut 마스터 절대 초 — 초기 트림 OUT (AI 추천 끝). 미지정 시 masterDurationSec.
 */
export function makeInitialEditorState(
  title: string,
  masterDurationSec: number,
  trimIn = 0,
  trimOut?: number,
  titleLine1?: string,  // 2026-07-29: 두 줄 제목 (AI가 line1/line2 생성한 경우)
  titleLine2?: string,
  programTitle?: string, // 2026-08-12: 하단 브랜딩 (TVING 풍 기본 템플릿)
): EditorState {
  const dur = Math.max(1, masterDurationSec);
  const inAbs = Math.max(0, Math.min(trimIn, dur - 0.1));
  const outAbs = Math.min(dur, Math.max(inAbs + 0.1, trimOut ?? dur));
  // 강조색 규칙(사용자 확정 2026-08-12): 두 줄이면 둘째 줄만, 한 줄이면 통째로 색.
  // 서버 자동 렌더 시드(factory.ts autoEditorState)와 같은 모양이어야 한다.
  const initialLines = (titleLine1 && titleLine2)
    ? [
        { id: "t1", text: titleLine1, size: 30, color: "#FFFFFF" },
        { id: "t2", text: titleLine2, size: 30, color: "#3B82F6" },  // Tailwind blue-500
      ]
    : [{ id: "t1", text: title, size: 30, color: "#FF4040" }];
  return {
    // TVING 쇼츠 스타일이 기본 (2026-08-12): 검정 레터박스 + 상단 훅 + 하단 프로그램명.
    // broadcast-clean 은 assets/shorts-template/ 의 실존 프레임이다.
    templateId: "broadcast-clean",
    aspect: "9:16",
    fit: "contain",
    bgType: "solid",
    bg: "#000000",
    accent: "#FFD400",
    titleLines: initialLines,
    titleAlign: "center",
    titleX: 50,
    titleY: 11,
    showChannel: true,
    channelName: programTitle || "",
    channelY: 88,
    channelLabelSize: 30,
    channelIconSize: 40,
    // 방송 원본은 번인 자막이 이미 있다 — AI 자막을 겹쳐 굽지 않는 게 기본.
    captionsOn: false,
    captionStyle: "korean_pop",
    highlightColor: "#FFD400",
    showSafeArea: false,
    elements: [],
    trimIn: inAbs,
    trimOut: outAbs,
    tracks: [makeMainTrack(inAbs, outAbs, dur)],
    speed: 1,
    // "첫 3초 훅" 프리롤 — opt-in(기본 OFF). ON 시 /export 가 hook 구간을 프리롤로 붙인다
    // (docs/plans/shorts-hook-intro-3sec.md · Phase 3). 실제 배선 전엔 no-op 이었어 기본 ON 이었지만
    // 배선 후엔 배포물을 바꾸므로 편집자가 명시적으로 켜도록 OFF 로 둔다.
    hookOn: false,
    silenceCut: false,
    // Gemini STT가 발화 시작을 살짝 앞서 marking하는 경향 관찰 — 자막이 영상보다 먼저 뜸.
    // 기본값 0ms로 뒤로 밀어 다수 케이스 커버. 필요 시 하단 timeline UI에서 ±100ms 조정.
    // 2026-07-24 사용자 지적: "살짝 자막이 더 빨라".
    offsetMs: 0,
    trimBase: "master",
  };
}

/** Saved editorState from before multi-track has no `tracks` — hydrate a main track
 *  from the master trim so old clips keep working unchanged. Tracks saved before
 *  speed-ramping / volume get their defaults filled in (uniform speed, full volume). */
/** 저장된 EditorState 로드 시 스키마 진화 대응 — 옛 클립을 새 필드로 안전 마이그레이션.
 *  원칙: 필드가 없으면 안전한 기본값 자동 채움 → undefined 접근으로 인한 크래시 방지.
 *  새 필드 추가 시 여기 fallback을 반드시 등록할 것 (안 하면 옛 클립 로드가 폭발한다). */
/**
 * @param durationSec 마스터(원본) 전체 길이 — 새 절대 좌표계 기준.
 * @param segmentStart 옛 저장분의 세그먼트 시작(마스터 절대 초). trimBase가 "segment" 혹은
 *   undefined면 이 값을 trimIn/trimOut에 더해 절대 좌표계로 마이그레이션한다.
 */
export function ensureTracks(state: EditorState, durationSec: number, segmentStart = 0): EditorState {
  const dur = Math.max(1, durationSec);

  // Legacy migration: segment-relative → master-absolute. 옛 저장분은 clip.startTime 원점 기준
  // 상대 초였으므로 지금 좌표계로 옮기려면 segmentStart를 더해준다. 값이 이미 masterDur 근처면
  // 절대 좌표로 저장된 상태로 간주하고 건드리지 않는다 (재이동 방지).
  const isSegmentRel = state.trimBase !== "master" && segmentStart > 0;
  const shift = isSegmentRel ? segmentStart : 0;
  const trimIn = Math.max(0, Math.min(dur, (state.trimIn ?? 0) + shift));
  const trimOut = Math.max(trimIn + 0.1, Math.min(dur, (state.trimOut ?? dur) + shift));

  const tracks =
    Array.isArray(state.tracks) && state.tracks.length > 0
      ? state.tracks.map((tr) => ({
          ...tr,
          trimIn: Math.max(0, Math.min(dur, (tr.trimIn ?? 0) + shift)),
          trimOut: Math.max(0.1, Math.min(dur, (tr.trimOut ?? dur) + shift)),
          startTime: Math.max(0, (tr.startTime ?? 0) + shift),
          duration: dur,
          speedPoints: Array.isArray(tr.speedPoints) ? tr.speedPoints : [],
          volume: typeof tr.volume === "number" ? tr.volume : 1,
          muted: tr.muted === true,
          transition: tr.transition ?? { type: "cut" as const, duration: 0 },
        }))
      : [makeMainTrack(trimIn, trimOut, dur)];

  // titleLines·elements의 keyframes가 undefined거나 배열 아닌 경우 빈 배열로 정규화.
  // sampleKeyframes는 undefined도 처리하지만, 다른 소비자(server render·인덱스 접근)가 배열 가정할 수 있음.
  // ⚠️ id 를 백필한다. factory 가 예전에 id 없이 titleLines 를 만들었고(2026-08-12 수정),
  //    그렇게 저장된 클립을 열면 편집기가 l.id === undefined 로 두 줄을 다 매칭해 붕괴한다.
  //    이미 저장된 것까지 방어하려면 여기서 채운다.
  const titleLines = Array.isArray(state.titleLines)
    ? state.titleLines.map((l, i) => ({
        ...l,
        id: l.id || `t${i}`,
        keyframes: Array.isArray(l.keyframes) ? l.keyframes : [],
      }))
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
    // 종횡비·핏·배경·강조색
    aspect: state.aspect ?? "9:16",
    // 구 클립엔 fit 이 없다. contain 이 지금까지의 비프레임 동작(레터박스)과 같아 무회귀.
    fit: state.fit ?? "contain",
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
    channelIconDataUrl: typeof state.channelIconDataUrl === "string" ? state.channelIconDataUrl : undefined,
    channelBadgeTemplate:
      state.channelBadgeTemplate && CHANNEL_BADGE_PRESETS.some((p) => p.id === state.channelBadgeTemplate)
        ? state.channelBadgeTemplate
        : undefined,
    channelIconSize: typeof state.channelIconSize === "number" && state.channelIconSize > 0 ? state.channelIconSize : undefined,
    channelLabelSize: typeof state.channelLabelSize === "number" && state.channelLabelSize > 0 ? state.channelLabelSize : undefined,
    channelExtraLines: Array.isArray(state.channelExtraLines)
      ? state.channelExtraLines
          .filter((l): l is ChannelExtraLine => !!l && typeof (l as ChannelExtraLine).id === "string" && typeof (l as ChannelExtraLine).text === "string")
          .map((l) => ({ id: l.id, text: l.text, size: typeof l.size === "number" && l.size > 0 ? l.size : undefined }))
      : undefined,
    channelLayout: state.channelLayout === "vertical" ? "vertical" : state.channelLayout === "horizontal" ? "horizontal" : undefined,
    channelIconShape:
      state.channelIconShape === "rounded" || state.channelIconShape === "square" || state.channelIconShape === "circle"
        ? state.channelIconShape
        : undefined,
    // 배경 채우기 방식 — 예전 렌더는 항상 blur cover였으나 UX 정리로 solid를 기본.
    bgType: state.bgType === "blur" || state.bgType === "image" ? state.bgType : "solid",
    bgImageDataUrl: typeof state.bgImageDataUrl === "string" ? state.bgImageDataUrl : undefined,
    bgImageCrop:
      state.bgImageCrop &&
      typeof state.bgImageCrop === "object" &&
      ["xPct", "yPct", "wPct", "hPct"].every((k) => typeof (state.bgImageCrop as Record<string, unknown>)[k] === "number")
        ? state.bgImageCrop
        : undefined,
    // 세이프에어리어·필터
    showSafeArea: typeof state.showSafeArea === "boolean" ? state.showSafeArea : false,
    // 속도·훅
    speed: typeof state.speed === "number" && state.speed > 0 ? state.speed : 1,
    hookOn: typeof state.hookOn === "boolean" ? state.hookOn : false,
    silenceCut: typeof state.silenceCut === "boolean" ? state.silenceCut : false,
    // 저장된 값 있으면 유지 (사용자 조정 보호) · 없으면 0 기본값 (STT 이른 marking 보정).
    offsetMs: typeof state.offsetMs === "number" ? state.offsetMs : 0,
    // 트림 — 위에서 계산한 마이그레이션·클램프 결과를 그대로 사용 (원 state.trimIn/trimOut을
    // 다시 쓰면 legacy 시프트가 되돌려진다).
    trimIn,
    trimOut,
    // 마이그레이션 완료 표시. 다음 로드부터는 shift 안 됨.
    trimBase: "master" as const,
  };
}

/** 프레임 템플릿의 텍스트 슬롯(서버가 %·px 로 변환해 내려준 것). api.ts FrameTextSlot 미러. */
export interface TemplateTextSlot {
  slot: string;
  x: number;      // % (center면 50)
  y: number;      // %
  align: "center" | "left";
  size: number;   // px (1080 폭 캔버스 기준)
  color: string;
}
export interface TemplateFrame {
  name: string;
  /** 이 프레임이 원본을 어떻게 넣는지(맞춤/채우기) — applyTemplate 이 editorState.fit 시드로 쓴다. */
  video?: { fit?: "contain" | "cover" };
  text: TemplateTextSlot[];
}

/**
 * 프레임 템플릿 선택.
 *
 * ⚠️ 예전에는 기하(띠·영상 사각형)만 바꾸고 제목·채널 텍스트는 손대지 않았다. 그래서
 * 템플릿을 적용하면 텍스트가 원래 자유배치 자리에 그대로 남아 프레임 띠 위에 겹치거나
 * 어긋나 **오버레이가 지저분**했다(사용자 지적 2026-08-12).
 *
 * 이제 템플릿은 **텍스트·채널 배치까지 정의하는 한 벌**이다. 슬롯을 편집기 요소에 매핑해
 * 위치·크기·색을 세팅한다:
 *   title1 → titleLines[0] · titleX/titleY · titleAlign
 *   title2 → titleLines[1]
 *   program / schedule → 채널(브랜딩) 블록 위치
 * **슬롯이 없는 요소는 숨긴다** — 채널 슬롯이 없는 템플릿에서 채널 배지가 남으면 안 된다.
 * 배치 후 사용자는 드래그로 미세 조정할 수 있다(템플릿은 기본값일 뿐).
 *
 * `frame` 을 못 받으면(목록 로딩 전 등) 예전처럼 캔버스 기본값만 손댄다.
 */
export function applyTemplate(state: EditorState, id: TemplateId, frame?: TemplateFrame | null): EditorState {
  const legacy = TEMPLATE_PRESETS.find((p) => p.id === id);
  if (legacy) {
    // 구 프리셋 id 로 저장된 클립을 열었을 때만 예전 패치를 적용한다(하위호환).
    return { ...state, templateId: id, ...legacy.patch };
  }

  // 프레임의 fit 을 editorState.fit 시드로 복사한다 — 이후 렌더·미리보기는 editorState.fit 만
  // 읽으므로 두 값이 어긋날 일이 없다(조사 함정 #1). 프레임 fit 이 없으면 contain(레터박스).
  const frameFit = frame?.video?.fit === "cover" ? "cover" : "contain";
  const base: EditorState = { ...state, templateId: id, aspect: "9:16", fit: frameFit, bgType: "solid", bg: "#000000" };
  if (!frame || !Array.isArray(frame.text)) return base;

  const slot = (name: string) => frame.text.find((s) => s.slot === name);
  const t1 = slot("title1");
  const t2 = slot("title2");
  // 브랜딩 슬롯은 템플릿마다 이름이 다르다(program=프로그램명 · schedule=방영시간).
  const brand = slot("program") ?? slot("schedule");

  const next: EditorState = { ...base };

  // ── 제목 ──────────────────────────────────────────────
  if (t1) {
    next.titleX = t1.x;
    next.titleY = t1.y;
    next.titleAlign = t1.align === "left" ? "left" : "center";
    // ⚠️ **크기(size)는 슬롯에서 가져오지 않는다.** 슬롯 size 는 1080폭 캔버스 기준 px 인데
    //    미리보기는 line.size 를 **절대 px** 로 그린다(스테이지 폭이 1080 이 아님) — 슬롯 64 를
    //    그대로 넣으면 좁은 미리보기에서 제목이 2배로 거대해져 프레임을 침범했다(2026-08-12).
    //    위치·정렬·색만 슬롯으로 덮고, 크기는 사용자가 정한 값을 유지한다. 크기 단위 정합은
    //    저장된 클립 전부에 영향을 줘서 별도 작업이다.
    const lines = state.titleLines.length ? state.titleLines : [{ id: "t1", text: "", size: 30, color: t1.color }];
    next.titleLines = lines.map((l, i) => {
      const s = i === 0 ? t1 : i === 1 ? (t2 ?? null) : null;
      // 슬롯이 없는 줄(3줄째 등)은 그대로 둔다 — 지우면 사용자 문구가 사라진다.
      return s ? { ...l, color: s.color } : l;
    });
  }

  // ── 채널/브랜딩 ───────────────────────────────────────
  if (brand) {
    next.showChannel = true;
    next.channelY = brand.y;
    // 방영시간 슬롯이면 시간 박스 위치도 같이 맞춘다(broadcast-standard 계열).
    if (slot("schedule")) next.channelBoxY = brand.y;
  } else {
    // 이 템플릿엔 채널/브랜딩 슬롯이 없다 → 배지를 숨긴다(겹침 방지).
    next.showChannel = false;
  }

  return next;
}
