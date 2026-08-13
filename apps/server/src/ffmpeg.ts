/**
 * ffmpeg/ffprobe wrapper — used in Cloud Run (ffmpeg baked into Docker image).
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";

export type ProbeResult = {
  durationSec: number;
  width: number;
  height: number;
  codec: string;
  hasAudio: boolean;
  /** Frame rate parsed from r_frame_rate ("30000/1001" → 29.97). 0 when unknown. */
  fps: number;
};

/** #rrggbb 또는 rrggbb 문자열을 3~6자 안 되면 fallback으로 대체. ffmpeg color 필터에 넘길 값 정규화용. */
function normalizeHexColor(input: string | undefined, fallback: string): string {
  const v = (input ?? "").trim();
  const m = /^#?([0-9a-f]{6})$/i.exec(v);
  return m ? `#${m[1].toLowerCase()}` : fallback;
}

// 성공은 영구 캐시, 실패는 30초 간격으로만 재프로브한다.
// 부팅 1회 프로브를 상수로 들고 있으면 콜드스타트 CPU 경합에서 5초 타임아웃 오탐 한 번에
// 인스턴스 수명 내내 false 로 고착된다(실측 2026-08-13 — 이미지에 ffmpeg 이 있는데 /health
// 가 false). 반대로 스로틀 없이 매번 물으면 ffmpeg 없는 로컬 폴백 환경에서 요청마다 5초씩
// 동기 블로킹된다 — 그래서 실패 쪽만 간격을 둔다.
let ffmpegOk = false;
let lastProbeAt = 0;
export function hasFfmpeg(): boolean {
  if (ffmpegOk) return true;
  const now = Date.now();
  if (now - lastProbeAt < 30_000) return false;
  lastProbeAt = now;
  try {
    const out = execFileSync("ffmpeg", ["-version"], { timeout: 5000, encoding: "utf8", stdio: "pipe" });
    ffmpegOk = out.includes("ffmpeg version");
  } catch {
    ffmpegOk = false;
  }
  return ffmpegOk;
}

export function probe(filePath: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    // filePath may be a signed https:// URL (GCS range-read) — only guard local paths.
    const isUrl = /^https?:\/\//i.test(filePath);
    if (!isUrl && !fs.existsSync(filePath)) {
      return reject(new Error(`File not found: ${filePath}`));
    }
    execFile(
      "ffprobe",
      [
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        filePath,
      ],
      { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const data = JSON.parse(stdout);
          const format = data.format ?? {};
          const videoStream = (data.streams ?? []).find(
            (s: any) => s.codec_type === "video"
          );
          const audioStream = (data.streams ?? []).find(
            (s: any) => s.codec_type === "audio"
          );
          // r_frame_rate is "num/den" (e.g. "30000/1001" for NTSC 29.97). Zero-guard the
          // divisor — some containers report "0/0" for still images or bad streams.
          const rate = String(videoStream?.r_frame_rate ?? "");
          const [rnStr, rdStr] = rate.split("/");
          const rn = parseFloat(rnStr || "0");
          const rd = parseFloat(rdStr || "1");
          const fps = rd > 0 && rn > 0 ? rn / rd : 0;
          resolve({
            durationSec: parseFloat(format.duration ?? "0") || 0,
            width: videoStream?.width ?? 0,
            height: videoStream?.height ?? 0,
            codec: videoStream?.codec_name ?? "",
            hasAudio: !!audioStream,
            fps,
          });
        } catch (e) {
          reject(new Error(`ffprobe parse error: ${e}`));
        }
      }
    );
  });
}

export function captureThumbnail(
  inputPath: string,
  timeOffset: number,
  outputPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      [
        "-y",
        "-ss", String(timeOffset),
        "-i", inputPath,
        "-vframes", "1",
        "-q:v", "2",
        outputPath,
      ],
      { timeout: 30_000 },
      (err) => {
        if (err) return reject(err);
        if (!fs.existsSync(outputPath)) {
          return reject(new Error("Thumbnail not produced"));
        }
        resolve();
      }
    );
  });
}

/**
 * Remux a video to a browser-friendly progressive mp4 (single moov at the front, no
 * fragments) WITHOUT re-encoding (`-c copy` → fast). Uploaded files are frequently
 * fragmented (fMP4: tiny init moov + moof/mdat fragments) which a plain <video> element
 * can't stream. `input` may be a local path or an https signed URL.
 */
export function remuxFaststart(input: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      ["-y", "-i", input, "-c", "copy", "-movflags", "+faststart", "-f", "mp4", outputPath],
      { timeout: 300_000 },
      (err) => {
        if (err) return reject(err);
        if (!fs.existsSync(outputPath)) return reject(new Error("remux output not produced"));
        resolve();
      },
    );
  });
}

export type RenderShortOpts = {
  inputPath: string;
  /** Absolute source seconds. */
  startTime: number;
  endTime: number;
  outputPath: string;
  /** Target frame size (e.g. 1080×1920 for 9:16). */
  width: number;
  height: number;
  /** Optional ASS file to burn (title/channel/overlays). Requires a CJK font in the image. */
  assPath?: string | null;
  /** Optional ffmpeg video-filter fragment (colour grade), e.g. "eq=contrast=1.20,colorbalance=rm=0.15".
   *  Applied to the composited frame before the ASS burn so overlays stay ungraded. */
  videoFilters?: string | null;
  /** Optional ffmpeg audio-filter fragment, e.g. "volume=0.500" (may already include atempo
   *  for speed). Only pass when the source actually has an audio stream (ffmpeg errors on -af
   *  with no audio). */
  audioFilter?: string | null;
  /** Uniform playback speed (1 = normal, 2 = 2× fast, 0.5 = half). Burned via setpts AFTER
   *  the ASS/overlay burn so captions speed up in sync. Audio atempo is expected in audioFilter. */
  speed?: number;
  /** 배경 채우기 방식.
   *  - "blur"(기본, 하위호환): 원본 확대 블러 커버.
   *  - "solid": 단색 letterbox. bgColor(#rrggbb 또는 0xRRGGBB) 사용.
   *  - "image": TODO — 지금은 solid로 폴백. 이미지 파일 준비·filter graph 확장 후 활성. */
  bgType?: "solid" | "blur" | "image";
  /** bgType='solid'일 때의 letterbox 색 (예: "#0E0E12"). */
  bgColor?: string;
  /**
   * 축2 — 원본을 컨테이너에 어떻게 넣나. **프레임(frame)이 없을 때만** 본다.
   *  - "cover": 잘라 채우기(레터박스 없음, bgType 무의미).
   *  - "contain"/미설정: 맞춤(레터박스 + bgType 여백). 기존 동작.
   * 프레임이 있으면 frame.video.fit 이 우선이라 이 값은 무시된다.
   */
  fit?: "contain" | "cover";
  /** 프레임 템플릿 기하 (assets/shorts-template/<name>/meta.json).
   *  주면 배경 blur/solid 대신 **프레임 합성 경로**를 탄다: 검정 바탕 → 영상 사각형(cover)
   *  → bands → overlay.png 조각 → over bands. 편집기 미리보기와 같은 순서여야 한다. */
  frame?: {
    overlayPath: string;
    video: { x: number; y: number; w: number; h: number; fit?: "cover" | "contain" };
    bands: { x: number; y: number; w: number; h: number; color?: string; over?: boolean }[];
    overlayRegions: { x: number; y: number; w: number; h: number }[];
  } | null;
  /** 첫 3초 hook 프리롤 (2026-08-02 · docs/plans/shorts-hook-intro-3sec.md · Phase 3/α).
   *  설정 시 · 본문 앞에 hook 구간의 짧은 클립을 punch-in(전체화면 커버 + 살짝 그레이드)으로
   *  붙이고 cross-dissolve 로 본문에 이어붙인다. 이탈 방지용 attention retention.
   *  프리롤은 자막·타이틀 없이 순수 hook clip (본문 오버레이는 본문 프레임에만 번인). */
  hookPreroll?: {
    /** hook 대사가 시작하는 마스터 절대 초. (본문 start + hook_time_sec, 캘러가 클램프) */
    startTime: number;
    /** 프리롤 길이(초). 기본 3. */
    durationSec: number;
    /** 오디오 크로스페이드 포함 여부 (마스터에 오디오 있을 때만 true). */
    hasAudio?: boolean;
  } | null;
  /** 하단 브랜딩 아이콘/로고 — 프로그램에서 미리 설정한 이미지. **높이(h) 기준**으로
   *  스케일하고 가로는 비율 유지 + 화면 중앙 정렬((W-w)/2 식) — 정사각 아이콘과 가로
   *  워드마크 로고가 같은 코드로 자연스럽게 앉는다. ASS 번인 뒤에 얹는다.
   *  ⚠️ hookPreroll 경로에는 아직 미지원 — 캘러가 프리롤일 땐 넘기지 않는다. */
  badge?: { path: string; y: number; h: number } | null;
  /** AI multi-layout plan. Times are absolute master seconds and tracking centres are
   * normalized source-frame coordinates. The renderer intersects it with startTime/endTime
   * and deterministically fills every uncovered gap with `fit`. */
  reframePlan?: ReframeRenderPlan | null;
  /** In AI multi-layout mode captions stay visible during both layouts, while decorative
   * editor overlays are pre-clipped to fit intervals by the caller. `assPath` remains the
   * backwards-compatible all-in-one path used by basic mode. */
  captionAssPath?: string | null;
  decorationAssPath?: string | null;
};

export type ReframeTrackingKeyframe = {
  /** Absolute master second. */
  t: number;
  /** Normalized source-frame centre. */
  cx: number;
  cy: number;
  confidence?: number;
};

export type ReframeRenderSegment = {
  beatId?: string | number;
  /** Absolute master seconds. */
  start: number;
  end: number;
  layout: "fit" | "fill";
  score?: number;
  reasonCodes?: string[];
  tracking?: ReframeTrackingKeyframe[];
};

export type ReframeRenderPlan = {
  version: 1;
  mode: "ai_multi";
  sourceStart?: number;
  sourceEnd?: number;
  segments?: ReframeRenderSegment[];
  /** `beats` is accepted as a wire-format alias so the worker plan can stay beat-shaped. */
  beats?: ReframeRenderSegment[];
};

export type NormalizedReframeSegment = ReframeRenderSegment & {
  start: number;
  end: number;
  tracking: ReframeTrackingKeyframe[];
};

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/**
 * Validate, sort and fully cover an export window. Invalid/overlapping pieces never reach
 * ffmpeg; uncovered ranges intentionally become fit instead of silently inheriting a stale
 * crop. Export routes validate too, but keeping this boundary pure protects every caller.
 */
export function normalizeReframeSegments(
  plan: ReframeRenderPlan | null | undefined,
  windowStart: number,
  windowEnd: number,
): NormalizedReframeSegment[] {
  if (!plan || plan.mode !== "ai_multi" || !(windowEnd > windowStart)) return [];
  const raw = (Array.isArray(plan.segments) ? plan.segments : Array.isArray(plan.beats) ? plan.beats : [])
    .filter((s): s is ReframeRenderSegment => !!s && finite(s.start) && finite(s.end) && s.end > s.start
      && (s.layout === "fit" || s.layout === "fill"))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const out: NormalizedReframeSegment[] = [];
  let cursor = windowStart;
  for (const source of raw) {
    const start = Math.max(windowStart, cursor, source.start);
    const end = Math.min(windowEnd, source.end);
    if (end <= start + 1e-6) continue;
    if (start > cursor + 1e-6) {
      out.push({ start: cursor, end: start, layout: "fit", reasonCodes: ["uncovered_range"], tracking: [] });
    }
    const byTime = new Map<number, ReframeTrackingKeyframe>();
    for (const k of Array.isArray(source.tracking) ? source.tracking : []) {
      if (!k || !finite(k.t) || !finite(k.cx) || !finite(k.cy)) continue;
      // Keep one sample immediately outside each edge useful for interpolation, but reject
      // unrelated points from another beat/plan.
      if (k.t < source.start - 0.5 || k.t > source.end + 0.5) continue;
      byTime.set(k.t, {
        t: k.t,
        cx: clamp01(k.cx),
        cy: clamp01(k.cy),
        ...(finite(k.confidence) ? { confidence: clamp01(k.confidence) } : {}),
      });
    }
    const tracking = [...byTime.values()].sort((a, b) => a.t - b.t);
    out.push({ ...source, start, end, tracking });
    cursor = end;
    if (cursor >= windowEnd - 1e-6) break;
  }
  if (cursor < windowEnd - 1e-6) {
    out.push({ start: cursor, end: windowEnd, layout: "fit", reasonCodes: ["uncovered_range"], tracking: [] });
  }
  if (!out.length) {
    out.push({ start: windowStart, end: windowEnd, layout: "fit", reasonCodes: ["missing_plan"], tracking: [] });
  }
  return out;
}

const ffNum = (v: number): string => {
  const s = Number(v.toFixed(6)).toString();
  return s === "-0" ? "0" : s;
};

/** Piecewise-linear focus expression for ffmpeg's per-frame crop x/y evaluation. */
export function trackingAxisExpression(
  tracking: ReframeTrackingKeyframe[],
  axis: "cx" | "cy",
  segmentStart: number,
): string {
  const pts = tracking
    .filter((k) => finite(k?.t) && finite(k?.[axis]))
    .map((k) => ({ t: Math.max(0, k.t - segmentStart), v: clamp01(k[axis]) }))
    .sort((a, b) => a.t - b.t);
  if (!pts.length) return "0.5";
  if (pts.length === 1) return ffNum(pts[0].v);
  let expr = ffNum(pts[pts.length - 1].v);
  for (let i = pts.length - 2; i >= 0; i--) {
    const a = pts[i], b = pts[i + 1];
    const dt = Math.max(0.000001, b.t - a.t);
    const lerp = `${ffNum(a.v)}+(${ffNum(b.v - a.v)})*clip((t-${ffNum(a.t)})/${ffNum(dt)},0,1)`;
    expr = `if(lt(t,${ffNum(b.t)}),${lerp},${expr})`;
  }
  return expr;
}

/**
 * 이미지를 원형으로 잘라 PNG 로 저장 (하단 브랜딩 아이콘용). geq 로 원 밖 알파를 0 으로.
 * size 는 정사각 한 변(px) — 렌더에서 다시 줄이지 않도록 최종 크기로 만든다.
 */
export function circleCrop(srcPath: string, dstPath: string, size: number): Promise<void> {
  const vf =
    `scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size},format=rgba,` +
    `geq=a='if(lte((X-W/2)*(X-W/2)+(Y-H/2)*(Y-H/2),(W/2)*(W/2)),alpha(X,Y),0)'` +
    `:r='r(X,Y)':g='g(X,Y)':b='b(X,Y)'`;
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-y", "-i", srcPath, "-vf", vf, "-frames:v", "1", dstPath],
      { timeout: 30_000 }, (err) => {
        if (err) return reject(err);
        if (!fs.existsSync(dstPath)) return reject(new Error("circleCrop output not produced"));
        resolve();
      });
  });
}

/** 프리롤→본문 cross-dissolve 길이(초). 프로토타입(render_shorts.py) 검증값. */
const HOOK_XFADE_SEC = 0.25;

/**
 * renderShort 의 hook-preroll 분기 — 2입력 xfade.
 *   입력0 = 프리롤(hook 구간) · 입력1 = 본문(원 세그먼트).
 * 본문은 기존 renderShort 와 동일한 커버/그레이드/자막/속도 처리를 거친 뒤,
 * 프리롤(punch-in 전체화면 + 살짝 채도·대비 강조)과 cross-dissolve 로 이어붙는다.
 * xfade 는 두 입력의 fps 가 같아야 하므로 두 스트림 모두 fps=30 으로 정규화한다(쇼츠 표준).
 */
function renderShortWithPreroll(opts: RenderShortOpts & { hookPreroll: NonNullable<RenderShortOpts["hookPreroll"]> }): Promise<void> {
  const { inputPath, startTime, endTime, outputPath, width: W, height: H, assPath, videoFilters, audioFilter } = opts;
  const bodyDur = endTime - startTime;
  if (bodyDur <= 0) return Promise.reject(new Error("Invalid render duration"));
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
  const pre = opts.hookPreroll;
  const preDur = Math.max(0.5, pre.durationSec);
  const preStart = Math.max(0, pre.startTime);
  const preEnd = preStart + preDur;

  const bgMode = opts.bgType === "solid" || opts.bgType === "image" ? "solid" : "blur";
  const solidColor = normalizeHexColor(opts.bgColor, "#0E0E12");

  // ── 본문(입력1) 체인 — 기존 renderShort 와 동일 구성, 입력 라벨만 [1:v] ──
  let vf: string;
  if (opts.fit === "cover") {
    // 축2 "채우기": 잘라 채운다(레터박스 없음).
    vf = `[1:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[bc0]`;
  } else if (bgMode === "solid") {
    const colorHex = `0x${solidColor.slice(1)}`;
    vf =
      `color=c=${colorHex}:s=${W}x${H}:d=${(bodyDur / speed).toFixed(3)}[bbg];` +
      `[1:v]scale=${W}:${H}:force_original_aspect_ratio=decrease[bfg];` +
      `[bbg][bfg]overlay=(W-w)/2:(H-h)/2:shortest=1[bc0]`;
  } else {
    vf =
      `[1:v]split=2[ba0][bb0];` +
      `[ba0]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:1[bbg];` +
      `[bb0]scale=${W}:${H}:force_original_aspect_ratio=decrease[bfg];` +
      `[bbg][bfg]overlay=(W-w)/2:(H-h)/2[bc0]`;
  }
  let last = "[bc0]";
  if (videoFilters) { vf += `;${last}${videoFilters}[bcg]`; last = "[bcg]"; }
  if (assPath) {
    const esc = assPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
    vf += `;${last}ass='${esc}'[bca]`; last = "[bca]";
  }
  if (speed !== 1) { vf += `;${last}setpts=PTS/${speed}[bcs]`; last = "[bcs]"; }
  // 본문 fps/sar 정규화 (xfade 호환).
  vf += `;${last}fps=30,setsar=1[bodyv]`;

  // ── 프리롤(입력0) — punch-in 전체화면 커버 + 살짝 채도·대비 강조 ──
  vf +=
    `;[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
    `eq=saturation=1.20:contrast=1.05,fps=30,setsar=1[prev]`;

  // ── xfade: 프리롤 → 본문 (offset = preDur - transition) ──
  const xfadeOffset = Math.max(0, preDur - HOOK_XFADE_SEC).toFixed(3);
  vf += `;[prev][bodyv]xfade=transition=fade:duration=${HOOK_XFADE_SEC}:offset=${xfadeOffset}[v]`;

  const withAudio = pre.hasAudio === true;
  if (withAudio) {
    // 본문 오디오에 volume/atempo(속도) 적용 후 · 프리롤 오디오와 크로스페이드.
    vf += `;[1:a]${audioFilter ? audioFilter : "anull"}[ba];[0:a]anull[pa]`;
    vf += `;[pa][ba]acrossfade=d=${HOOK_XFADE_SEC}[a]`;
  }

  const args = [
    "-y",
    "-ss", String(preStart), "-to", String(preEnd), "-i", inputPath,
    "-ss", String(startTime), "-to", String(endTime), "-i", inputPath,
    "-filter_complex", vf,
    "-map", "[v]",
    ...(withAudio ? ["-map", "[a]"] : []),
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-movflags", "+faststart",
    outputPath,
  ];

  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { timeout: 300_000 }, (err) => {
      if (err) return reject(err);
      if (!fs.existsSync(outputPath)) return reject(new Error("Preroll render output not produced"));
      resolve();
    });
  });
}

function escapeAssPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function trackingValueAt(
  tracking: ReframeTrackingKeyframe[],
  axis: "cx" | "cy",
  absoluteTime: number,
): number {
  const pts = tracking
    .filter((k) => finite(k?.t) && finite(k?.[axis]))
    .sort((a, b) => a.t - b.t);
  if (!pts.length) return 0.5;
  if (absoluteTime <= pts[0].t) return clamp01(pts[0][axis]);
  if (absoluteTime >= pts[pts.length - 1].t) return clamp01(pts[pts.length - 1][axis]);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (absoluteTime <= b.t) {
      const f = (absoluteTime - a.t) / Math.max(0.000001, b.t - a.t);
      return clamp01(a[axis] + (b[axis] - a[axis]) * f);
    }
  }
  return 0.5;
}

type DynamicBodyGraph = {
  graph: string;
  last: string;
  segments: NormalizedReframeSegment[];
};

/**
 * Build only the AI body video graph. Keeping this separate lets the hook-preroll path use
 * exactly the same beat cuts/crops/overlays instead of falling back to the legacy static body.
 */
function buildDynamicBodyGraph(
  opts: RenderShortOpts,
  sourceInput: number,
  templateInput: number | null,
  badgeInput: number | null,
  prefix: string,
): DynamicBodyGraph {
  const W = opts.width, H = opts.height;
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
  const segments = normalizeReframeSegments(opts.reframePlan, opts.startTime, opts.endTime);
  const parts: string[] = [];
  const srcLabels = segments.map((_, i) => `[${prefix}src${i}]`).join("");
  if (segments.length === 1) parts.push(`[${sourceInput}:v]setpts=PTS-STARTPTS,null${srcLabels}`);
  else parts.push(`[${sourceInput}:v]setpts=PTS-STARTPTS,split=${segments.length}${srcLabels}`);

  const fr = opts.frame;
  const fitCount = segments.filter((s) => s.layout === "fit").length;
  const tplUseCount = fr && templateInput != null ? fitCount * fr.overlayRegions.length : 0;
  const tplLabels = Array.from({ length: tplUseCount }, (_, i) => `[${prefix}tpl${i}]`);
  if (tplUseCount === 1) parts.push(`[${templateInput}:v]null${tplLabels[0]}`);
  else if (tplUseCount > 1) parts.push(`[${templateInput}:v]split=${tplUseCount}${tplLabels.join("")}`);
  let tplUse = 0;

  const bgMode = opts.bgType === "solid" || opts.bgType === "image" ? "solid" : "blur";
  const solidColor = normalizeHexColor(opts.bgColor, "#0E0E12");

  segments.forEach((segment, i) => {
    const relStart = segment.start - opts.startTime;
    const relEnd = segment.end - opts.startTime;
    const dur = relEnd - relStart;
    const src = `[${prefix}src${i}]`;
    let cur: string;

    if (segment.layout === "fill") {
      const cx = trackingAxisExpression(segment.tracking, "cx", segment.start);
      const cy = trackingAxisExpression(segment.tracking, "cy", segment.start);
      // After `increase`, iw/ih are the scaled source dimensions. Mapping normalized source
      // centres through those dimensions is equivalent because scale preserves aspect ratio.
      const x = `max(0,min(iw-ow,(${cx})*iw-ow/2))`;
      const y = `max(0,min(ih-oh,(${cy})*ih-oh/2))`;
      parts.push(
        `${src}trim=start=${ffNum(relStart)}:end=${ffNum(relEnd)},setpts=PTS-STARTPTS,` +
        `scale=${W}:${H}:force_original_aspect_ratio=increase,` +
        `crop=${W}:${H}:x='${x}':y='${y}'[${prefix}raw${i}]`,
      );
      cur = `${prefix}raw${i}`;
    } else if (fr) {
      const v = fr.video;
      // AI `fit` has a product-level meaning: preserve the entire 16:9 source. A template's
      // legacy static slot may say cover (broadcast-drama), but carrying that into this mode
      // would turn a low-score safety fallback into another crop.
      const fit = `scale=${v.w}:${v.h}:force_original_aspect_ratio=decrease,` +
        `pad=${v.w}:${v.h}:(ow-iw)/2:(oh-ih)/2:black`;
      parts.push(`color=c=black:s=${W}x${H}:d=${ffNum(dur)}[${prefix}base${i}]`);
      parts.push(
        `${src}trim=start=${ffNum(relStart)}:end=${ffNum(relEnd)},setpts=PTS-STARTPTS,${fit},setsar=1[${prefix}fg${i}]`,
      );
      parts.push(`[${prefix}base${i}][${prefix}fg${i}]overlay=${v.x}:${v.y}:shortest=1[${prefix}comp${i}]`);
      cur = `${prefix}comp${i}`;
      const boxes = (over: boolean) => fr.bands.filter((b) => !!b.over === over)
        .map((b) => `drawbox=x=${b.x}:y=${b.y}:w=${b.w}:h=${b.h}:color=${b.color ?? "black"}:t=fill`)
        .join(",");
      const under = boxes(false);
      if (under) {
        parts.push(`[${cur}]${under}[${prefix}under${i}]`);
        cur = `${prefix}under${i}`;
      }
      fr.overlayRegions.forEach((r, ri) => {
        const tpl = tplLabels[tplUse++];
        parts.push(`${tpl}crop=${r.w}:${r.h}:${r.x}:${r.y}[${prefix}frg${i}_${ri}]`);
        parts.push(
          `[${cur}][${prefix}frg${i}_${ri}]overlay=${r.x}:${r.y}:eof_action=repeat:repeatlast=1[${prefix}fov${i}_${ri}]`,
        );
        cur = `${prefix}fov${i}_${ri}`;
      });
      const over = boxes(true);
      if (over) {
        parts.push(`[${cur}]${over}[${prefix}over${i}]`);
        cur = `${prefix}over${i}`;
      }
    } else if (bgMode === "solid") {
      const colorHex = `0x${solidColor.slice(1)}`;
      parts.push(`color=c=${colorHex}:s=${W}x${H}:d=${ffNum(dur)}[${prefix}bg${i}]`);
      parts.push(
        `${src}trim=start=${ffNum(relStart)}:end=${ffNum(relEnd)},setpts=PTS-STARTPTS,` +
        `scale=${W}:${H}:force_original_aspect_ratio=decrease[${prefix}fg${i}]`,
      );
      parts.push(
        `[${prefix}bg${i}][${prefix}fg${i}]overlay=(W-w)/2:(H-h)/2:shortest=1[${prefix}solid${i}]`,
      );
      cur = `${prefix}solid${i}`;
    } else {
      parts.push(
        `${src}trim=start=${ffNum(relStart)}:end=${ffNum(relEnd)},setpts=PTS-STARTPTS,split=2` +
        `[${prefix}ba${i}][${prefix}bb${i}]`,
      );
      parts.push(
        `[${prefix}ba${i}]scale=${W}:${H}:force_original_aspect_ratio=increase,` +
        `crop=${W}:${H},boxblur=20:1[${prefix}bg${i}]`,
      );
      parts.push(
        `[${prefix}bb${i}]scale=${W}:${H}:force_original_aspect_ratio=decrease[${prefix}fg${i}]`,
      );
      parts.push(`[${prefix}bg${i}][${prefix}fg${i}]overlay=(W-w)/2:(H-h)/2[${prefix}blur${i}]`);
      cur = `${prefix}blur${i}`;
    }
    parts.push(`[${cur}]fps=30,format=yuv420p,setsar=1[${prefix}seg${i}]`);
  });

  if (segments.length === 1) parts.push(`[${prefix}seg0]null[${prefix}base]`);
  else {
    const labels = segments.map((_, i) => `[${prefix}seg${i}]`).join("");
    parts.push(`${labels}concat=n=${segments.length}:v=1:a=0[${prefix}base]`);
  }
  let last = `[${prefix}base]`;
  if (opts.videoFilters) {
    parts.push(`${last}${opts.videoFilters}[${prefix}grade]`);
    last = `[${prefix}grade]`;
  }
  // Decorations first, captions last, matching the former single ASS event order while
  // allowing decorations to be absent during fill beats.
  const assLayers = [opts.decorationAssPath, opts.assPath, opts.captionAssPath].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  assLayers.forEach((p, i) => {
    parts.push(`${last}ass='${escapeAssPath(p)}'[${prefix}ass${i}]`);
    last = `[${prefix}ass${i}]`;
  });

  const fitIntervals = segments.filter((s) => s.layout === "fit")
    .map((s) => ({ start: s.start - opts.startTime, end: s.end - opts.startTime }));
  if (opts.badge && badgeInput != null && fitIntervals.length) {
    const enable = fitIntervals
      .map((x) => `gte(t,${ffNum(x.start)})*lt(t,${ffNum(x.end)})`)
      .join("+");
    parts.push(`[${badgeInput}:v]scale=-1:${opts.badge.h}[${prefix}badge]`);
    parts.push(
      `${last}[${prefix}badge]overlay=(W-w)/2:${opts.badge.y}:enable='${enable}'[${prefix}badged]`,
    );
    last = `[${prefix}badged]`;
  }
  if (speed !== 1) {
    parts.push(`${last}setpts=PTS/${speed}[${prefix}speed]`);
    last = `[${prefix}speed]`;
  }
  return { graph: parts.join(";"), last, segments };
}

function dynamicInputArgs(opts: RenderShortOpts, startTime: number, endTime?: number): string[] {
  return [
    "-ss", String(startTime),
    ...(endTime != null ? ["-t", String(Math.max(0, endTime - startTime))] : []),
    "-i", opts.inputPath,
  ];
}

/** AI beat renderer without a hook preroll. */
function renderDynamicShort(opts: RenderShortOpts): Promise<void> {
  const duration = opts.endTime - opts.startTime;
  if (duration <= 0) return Promise.reject(new Error("Invalid render duration"));
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
  const frameIndex = opts.frame ? 1 : null;
  const badgeIndex = opts.badge ? (opts.frame ? 2 : 1) : null;
  const body = buildDynamicBodyGraph(opts, 0, frameIndex, badgeIndex, "rf");
  const args = [
    "-y",
    ...dynamicInputArgs(opts, opts.startTime),
    ...(opts.frame ? ["-i", opts.frame.overlayPath] : []),
    ...(opts.badge ? ["-i", opts.badge.path] : []),
    "-t", String(duration / speed),
    "-filter_complex", body.graph,
    "-map", body.last,
    "-map", "0:a?",
    ...(opts.audioFilter ? ["-af", opts.audioFilter] : []),
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-movflags", "+faststart",
    opts.outputPath,
  ];
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { timeout: 300_000 }, (err) => {
      if (err) return reject(err);
      if (!fs.existsSync(opts.outputPath)) return reject(new Error("AI reframe output not produced"));
      resolve();
    });
  });
}

/** AI beat renderer with the legacy hook clip prepended to the exact same dynamic body. */
function renderDynamicShortWithPreroll(
  opts: RenderShortOpts & { hookPreroll: NonNullable<RenderShortOpts["hookPreroll"]> },
): Promise<void> {
  const bodyDur = opts.endTime - opts.startTime;
  if (bodyDur <= 0) return Promise.reject(new Error("Invalid render duration"));
  const pre = opts.hookPreroll;
  const preDur = Math.max(0.5, pre.durationSec);
  const preStart = Math.max(0, pre.startTime);
  const preEnd = preStart + preDur;
  const frameIndex = opts.frame ? 2 : null;
  const badgeIndex = opts.badge ? (opts.frame ? 3 : 2) : null;
  const body = buildDynamicBodyGraph(opts, 1, frameIndex, badgeIndex, "rfb");
  const focusSeg = body.segments.find((s) => preStart >= s.start && preStart < s.end)
    ?? body.segments.find((s) => s.tracking.length > 0);
  const cx = focusSeg ? trackingValueAt(focusSeg.tracking, "cx", preStart) : 0.5;
  const cy = focusSeg ? trackingValueAt(focusSeg.tracking, "cy", preStart) : 0.5;
  const x = `max(0,min(iw-ow,${ffNum(cx)}*iw-ow/2))`;
  const y = `max(0,min(ih-oh,${ffNum(cy)}*ih-oh/2))`;
  const parts = [body.graph];
  parts.push(
    `[0:v]setpts=PTS-STARTPTS,scale=${opts.width}:${opts.height}:force_original_aspect_ratio=increase,` +
    `crop=${opts.width}:${opts.height}:x='${x}':y='${y}',` +
    `eq=saturation=1.20:contrast=1.05,fps=30,setsar=1[rfpre]`,
  );
  parts.push(`${body.last}fps=30,setsar=1[rfbody]`);
  const xfadeOffset = Math.max(0, preDur - HOOK_XFADE_SEC);
  parts.push(
    `[rfpre][rfbody]xfade=transition=fade:duration=${HOOK_XFADE_SEC}:offset=${ffNum(xfadeOffset)}[v]`,
  );
  if (pre.hasAudio === true) {
    parts.push(`[1:a]${opts.audioFilter || "anull"}[rfa_body]`);
    parts.push(`[0:a]anull[rfa_pre]`);
    parts.push(`[rfa_pre][rfa_body]acrossfade=d=${HOOK_XFADE_SEC}[a]`);
  }
  const args = [
    "-y",
    ...dynamicInputArgs(opts, preStart, preEnd),
    ...dynamicInputArgs(opts, opts.startTime, opts.endTime),
    ...(opts.frame ? ["-i", opts.frame.overlayPath] : []),
    ...(opts.badge ? ["-i", opts.badge.path] : []),
    "-filter_complex", parts.join(";"),
    "-map", "[v]",
    ...(pre.hasAudio === true ? ["-map", "[a]"] : []),
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-movflags", "+faststart",
    opts.outputPath,
  ];
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { timeout: 300_000 }, (err) => {
      if (err) return reject(err);
      if (!fs.existsSync(opts.outputPath)) return reject(new Error("AI reframe preroll output not produced"));
      resolve();
    });
  });
}

/**
 * Render construct F (plan §2.4 — the single expensive render). Reframes the trimmed
 * segment to the target aspect with a blurred-cover background + centered fit foreground
 * (scale+boxblur+overlay filtergraph), then burns the ASS overlay via libass. One ffmpeg
 * pass. `inputPath` may be a local path or an https signed URL (range-seek via -ss).
 */
export function renderShort(opts: RenderShortOpts): Promise<void> {
  const dynamic = normalizeReframeSegments(opts.reframePlan, opts.startTime, opts.endTime).length > 0;
  if (dynamic) {
    return opts.hookPreroll && opts.hookPreroll.durationSec > 0
      ? renderDynamicShortWithPreroll(opts as RenderShortOpts & { hookPreroll: NonNullable<RenderShortOpts["hookPreroll"]> })
      : renderDynamicShort(opts);
  }
  // 첫 3초 hook 프리롤이 요청되면 · 2입력 xfade 경로로 분기(본문 처리 로직은 renderShortWithPreroll
  // 안에서 동일하게 재현). 아래 단일 입력 경로는 프리롤 없을 때 그대로 유지(무회귀).
  if (opts.hookPreroll && opts.hookPreroll.durationSec > 0) {
    return renderShortWithPreroll(opts as RenderShortOpts & { hookPreroll: NonNullable<RenderShortOpts["hookPreroll"]> });
  }
  const { inputPath, startTime, endTime, outputPath, width: W, height: H, assPath, videoFilters, audioFilter } = opts;
  const duration = endTime - startTime;
  if (duration <= 0) return Promise.reject(new Error("Invalid render duration"));
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
  // Sped-up video is shorter (duration/speed); the output -t must match or slow-mo would be
  // truncated back to the source length.
  const outDur = duration / speed;

  // 배경 채우기 방식 결정 — blur(기본): 원본 확대 블러 커버 · solid: 단색 letterbox.
  // image는 아직 solid로 폴백(파일 준비 파이프라인 없음). 프리뷰가 3종 모두 표시하므로
  // 렌더가 solid만 되도 최소한 프리뷰↔렌더 일관성이 solid·blur 두 경로에서 성립.
  const bgMode = opts.bgType === "solid" || opts.bgType === "image" ? "solid" : "blur";
  const solidColor = normalizeHexColor(opts.bgColor, "#0E0E12");
  let vf: string;
  const fr = opts.frame;
  if (fr) {
    // 프레임 경로. drawbox 는 필터 인자 순서가 x,y,w,h 라 meta.json 을 그대로 옮기면 된다.
    const boxes = (over: boolean) =>
      fr.bands.filter((b) => !!b.over === over)
        .map((b) => `drawbox=x=${b.x}:y=${b.y}:w=${b.w}:h=${b.h}:color=${b.color ?? "black"}:t=fill`)
        .join(",");
    const v = fr.video;
    const fit = v.fit === "contain"
      ? `scale=${v.w}:${v.h}:force_original_aspect_ratio=decrease,pad=${v.w}:${v.h}:(ow-iw)/2:(oh-ih)/2:black`
      : `scale=${v.w}:${v.h}:force_original_aspect_ratio=increase,crop=${v.w}:${v.h}`;
    // ⚠️ color 에 d= 를 빼면 무한 입력이라 인코딩이 안 끝난다.
    vf = `color=c=black:s=${W}x${H}:d=${outDur.toFixed(3)}[base];` +
         `[0:v]${fit},setsar=1[fgv];` +
         `[base][fgv]overlay=${v.x}:${v.y}:shortest=1[comp0]`;
    const under = boxes(false);
    vf += under ? `;[comp0]${under}[comp1]` : `;[comp0]copy[comp1]`;
    let cur = "comp1";
    fr.overlayRegions.forEach((r, i) => {
      vf += `;[1:v]crop=${r.w}:${r.h}:${r.x}:${r.y}[frg${i}]`;
      vf += `;[${cur}][frg${i}]overlay=${r.x}:${r.y}[fov${i}]`;
      cur = `fov${i}`;
    });
    const overBoxes = boxes(true);
    vf += overBoxes ? `;[${cur}]${overBoxes}[v0]` : `;[${cur}]copy[v0]`;
  } else if (opts.fit === "cover") {
    // 축2 "채우기": 프레임 없이 원본을 잘라 컨테이너를 꽉 채운다(레터박스·배경 없음).
    // increase 로 키워 넘치는 부분을 crop. bgType 은 여백이 없으므로 무의미.
    vf = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[v0]`;
  } else if (bgMode === "solid") {
    // 축2 "맞춤"(레터박스) + 검정/단색 여백. fit-to-frame foreground 를 단색 캔버스에 오버레이.
    // color 필터는 지속 프레임 만들고, -shortest 없이 -t로 컷하므로 무한 스트림도 안전.
    const colorHex = `0x${solidColor.slice(1)}`;
    vf =
      `color=c=${colorHex}:s=${W}x${H}:d=${outDur.toFixed(3)}[bg];` +
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2:shortest=1[v0]`;
  } else {
    // 축2 "맞춤"(레터박스) + 원본 블러 여백. 전경은 decrease(맞춤), 뒤는 같은 영상의 크롭·블러.
    vf =
      `split=2[a][b];` +
      `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:1[bg];` +
      `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2[v0]`;
  }
  let last = "[v0]";
  // Colour grade the composited frame BEFORE the ASS burn, so titles/captions stay crisp
  // and are not tinted by the operator's brightness/contrast/warmth adjustments.
  if (videoFilters) {
    vf += `;${last}${videoFilters}[vg]`;
    last = "[vg]";
  }
  if (assPath) {
    // Escape the path for the filtergraph (backslash, colon, single-quote).
    const esc = assPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
    vf += `;${last}ass='${esc}'[vout]`;
    last = "[vout]";
  }
  // 브랜딩 아이콘 — ASS 뒤에 얹는다(자막·타이틀과 같은 레이어 감각). 이미지 입력은 1프레임이라
  // overlay 기본 eof_action=repeat 로 전체 길이에 유지된다.
  if (opts.badge) {
    const bi = 1 + (fr ? 1 : 0);
    vf += `;[${bi}:v]scale=-1:${opts.badge.h}[bdg]` +
          `;${last}[bdg]overlay=(W-w)/2:${opts.badge.y}[vbdg]`;
    last = "[vbdg]";
  }
  // Speed LAST — after the burn, so the captions/overlays already baked into the frames
  // speed up in lockstep and never desync.
  if (speed !== 1) {
    vf += `;${last}setpts=PTS/${speed}[vspd]`;
    last = "[vspd]";
  }

  const args = [
    "-y",
    "-ss", String(startTime),
    "-i", inputPath,
    // 프레임 PNG 는 입력 1번 — filtergraph 의 [1:v] 와 짝이 맞아야 한다.
    ...(fr ? ["-i", fr.overlayPath] : []),
    // 브랜딩 아이콘은 그다음 입력 (fr 유무에 따라 [1:v] 또는 [2:v]).
    ...(opts.badge ? ["-i", opts.badge.path] : []),
    "-t", String(outDur),
    "-filter_complex", vf,
    "-map", last,
    "-map", "0:a?",
    ...(audioFilter ? ["-af", audioFilter] : []),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-movflags", "+faststart",
    outputPath,
  ];

  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { timeout: 300_000 }, (err) => {
      if (err) return reject(err);
      if (!fs.existsSync(outputPath)) return reject(new Error("Render output not produced"));
      resolve();
    });
  });
}

export function trimEncode(
  inputPath: string,
  startTime: number,
  endTime: number,
  outputPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const duration = endTime - startTime;
    if (duration <= 0) {
      return reject(new Error("Invalid trim duration"));
    }
    execFile(
      "ffmpeg",
      [
        "-y",
        "-ss", String(startTime),
        "-i", inputPath,
        "-t", String(duration),
        "-c:v", "libx264",
        "-preset", "fast",
        "-c:a", "aac",
        "-movflags", "+faststart",
        outputPath,
      ],
      { timeout: 120_000 },
      (err) => {
        if (err) return reject(err);
        if (!fs.existsSync(outputPath)) {
          return reject(new Error("Trim output not produced"));
        }
        resolve();
      }
    );
  });
}
