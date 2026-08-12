import crypto from "node:crypto";

export type ReframeMode = "basic" | "ai_multi";
export type ReframeStatus = "idle" | "queued" | "running" | "ready" | "stale" | "failed";

export interface ReframeTrackingPoint {
  /** Master-timeline seconds. */
  t: number;
  /** Normalized source-frame coordinates. */
  cx: number;
  cy: number;
  confidence?: number;
}

export interface ReframeSegment {
  beatId?: number | string;
  /** Master-timeline seconds. */
  start: number;
  end: number;
  layout: "fit" | "fill";
  score?: number;
  reasonCodes?: string[];
  tracking?: ReframeTrackingPoint[];
}

/** Compact, renderer-facing plan. The full planner output lives in object storage. */
export interface ReframePlan {
  version: 1;
  mode: "ai_multi";
  sourceStart: number;
  sourceEnd: number;
  segments: ReframeSegment[];
}

export interface ClipReframeError {
  code: string;
  message: string;
  at: number;
}

export interface ClipReframeState {
  mode: ReframeMode;
  status: ReframeStatus;
  /** Plan and tracking times use master-timeline seconds, never clip-relative seconds. */
  timeBase?: "master_absolute";
  revision: number;
  inputFingerprint?: string;
  requestId?: string;
  jobId?: string | null;
  planHash?: string;
  plan?: ReframePlan;
  overallScore?: number;
  reasonCodes?: string[];
  modelVersion?: string;
  /** Clip classification to restore when the operator switches back to basic mode. */
  basicAspectRatio?: string;
  artifactPath?: string;
  requestedAt?: number;
  startedAt?: number;
  completedAt?: number;
  updatedAt?: number;
  error?: ClipReframeError | null;
}

export const REFRAME_PIPELINE_VERSION =
  process.env.REFRAME_PIPELINE_VERSION?.trim() || "vision-safety-v1";

export function basicReframeState(now = Date.now()): ClipReframeState {
  return { mode: "basic", status: "idle", timeBase: "master_absolute", revision: now, updatedAt: now, error: null };
}

export function normalizeBeatIds(value: unknown): Array<number | string> {
  if (!Array.isArray(value)) return [];
  const out: Array<number | string> = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string" && typeof raw !== "number") continue;
    if (typeof raw === "number" && !Number.isFinite(raw)) continue;
    const v = typeof raw === "string" ? raw.trim() : raw;
    if (v === "") continue;
    const key = `${typeof v}:${String(v)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/** Fingerprints only planner inputs; editor overlays do not unnecessarily invalidate a plan. */
export function reframeFingerprint(clip: Record<string, unknown>): string {
  const beatIds = normalizeBeatIds(clip.beatIds)
    .map((v) => ({ type: typeof v, value: String(v) }))
    .sort((a, b) => `${a.type}:${a.value}`.localeCompare(`${b.type}:${b.value}`));
  const input = {
    version: REFRAME_PIPELINE_VERSION,
    clipId: String(clip.id ?? ""),
    sourceMediaId: String(clip.sourceMediaId ?? ""),
    start: finiteNumber(clip.startTime, "clip.startTime"),
    end: finiteNumber(clip.endTime, "clip.endTime"),
    beatIds,
  };
  if (!(input.end > input.start)) throw new Error("clip has no valid reframe range");
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 24);
}

export function effectiveReframeState(clip: Record<string, unknown>): ClipReframeState {
  const stored = clip.reframe && typeof clip.reframe === "object"
    ? clip.reframe as Partial<ClipReframeState>
    : null;
  if (!stored) return basicReframeState(0);
  if (stored.mode === "basic") {
    return {
      ...basicReframeState(Number(stored.updatedAt ?? stored.revision ?? 0)),
      ...stored,
      mode: "basic",
      status: "idle",
      timeBase: "master_absolute",
    };
  }
  if (stored.mode !== "ai_multi") return basicReframeState(0);
  const state = stored as ClipReframeState;
  let current: string;
  try {
    current = reframeFingerprint(clip);
  } catch {
    return { ...state, status: "stale" };
  }
  return state.inputFingerprint === current ? state : { ...state, status: "stale" };
}

export function normalizeReframePlan(
  raw: unknown,
  expected?: { start: number; end: number },
): ReframePlan {
  if (!raw || typeof raw !== "object") throw new Error("reframe plan must be an object");
  const obj = raw as Record<string, unknown>;
  if (Number(obj.version) !== 1) throw new Error("unsupported reframe plan version");
  if (obj.mode !== "ai_multi") throw new Error("reframe plan mode must be ai_multi");

  const source = obj.source && typeof obj.source === "object"
    ? obj.source as Record<string, unknown>
    : null;
  const rawSourceStart = finiteNumber(obj.sourceStart ?? source?.start, "plan.sourceStart");
  const rawSourceEnd = finiteNumber(obj.sourceEnd ?? source?.end, "plan.sourceEnd");
  if (!(rawSourceEnd > rawSourceStart)) throw new Error("invalid reframe source range");
  if (expected) {
    if (!(expected.end > expected.start)) throw new Error("invalid expected reframe range");
    if (Math.abs(rawSourceStart - expected.start) > 0.1 || Math.abs(rawSourceEnd - expected.end) > 0.1) {
      throw new Error("reframe plan source does not match the clip range");
    }
  }
  // Core emits the same floating-point bounds it received, but normalize the accepted
  // tolerance to the clip's canonical values so hashes and renderer intersections are exact.
  const sourceStart = expected?.start ?? rawSourceStart;
  const sourceEnd = expected?.end ?? rawSourceEnd;

  const rawSegments = Array.isArray(obj.segments)
    ? obj.segments
    : Array.isArray(obj.beats) ? obj.beats : null;
  if (!rawSegments?.length) throw new Error("reframe plan has no segments");

  const segments = rawSegments.map((value, index): ReframeSegment => {
    if (!value || typeof value !== "object") throw new Error(`segment ${index} must be an object`);
    const seg = value as Record<string, unknown>;
    const rawStart = finiteNumber(seg.start, `segment ${index}.start`);
    const rawEnd = finiteNumber(seg.end, `segment ${index}.end`);
    if (!(rawEnd > rawStart)) throw new Error(`segment ${index} has an invalid range`);
    if (rawStart < sourceStart - 0.05 || rawEnd > sourceEnd + 0.05) {
      throw new Error(`segment ${index} falls outside the source range`);
    }
    const start = Math.max(sourceStart, rawStart);
    const end = Math.min(sourceEnd, rawEnd);
    if (!(end > start)) throw new Error(`segment ${index} has no range after clamping`);
    if (seg.layout !== "fit" && seg.layout !== "fill") {
      throw new Error(`segment ${index} has an invalid layout`);
    }
    const score = seg.score == null ? undefined : finiteNumber(seg.score, `segment ${index}.score`);
    if (score != null && (score < 0 || score > 100)) throw new Error(`segment ${index}.score is out of range`);
    const reasonCodes = Array.isArray(seg.reasonCodes)
      ? Array.from(new Set(seg.reasonCodes
        .filter((v): v is string => typeof v === "string" && Boolean(v.trim()))
        .map((v) => v.trim().slice(0, 80))))
      : undefined;
    const tracking = Array.isArray(seg.tracking)
      ? seg.tracking.map((value, pointIndex): ReframeTrackingPoint => {
        if (!value || typeof value !== "object") throw new Error(`segment ${index} tracking ${pointIndex} is invalid`);
        const point = value as Record<string, unknown>;
        const rawT = finiteNumber(point.t, `segment ${index} tracking ${pointIndex}.t`);
        const cx = finiteNumber(point.cx, `segment ${index} tracking ${pointIndex}.cx`);
        const cy = finiteNumber(point.cy, `segment ${index} tracking ${pointIndex}.cy`);
        if (rawT < start - 0.05 || rawT > end + 0.05) throw new Error(`segment ${index} tracking time is out of range`);
        const t = Math.max(start, Math.min(end, rawT));
        if (cx < 0 || cx > 1 || cy < 0 || cy > 1) throw new Error(`segment ${index} tracking point is outside the frame`);
        const confidence = point.confidence == null
          ? undefined
          : finiteNumber(point.confidence, `segment ${index} tracking ${pointIndex}.confidence`);
        if (confidence != null && (confidence < 0 || confidence > 1)) {
          throw new Error(`segment ${index} tracking confidence is out of range`);
        }
        return { t, cx, cy, ...(confidence == null ? {} : { confidence }) };
      }).sort((a, b) => a.t - b.t)
      : undefined;
    const beatId = typeof seg.beatId === "number" || typeof seg.beatId === "string"
      ? seg.beatId
      : undefined;
    return {
      ...(beatId == null ? {} : { beatId }), start, end, layout: seg.layout,
      ...(score == null ? {} : { score }),
      ...(reasonCodes?.length ? { reasonCodes } : {}),
      ...(tracking?.length ? { tracking } : {}),
    };
  }).sort((a, b) => a.start - b.start || a.end - b.end);

  for (let i = 1; i < segments.length; i++) {
    if (segments[i].start < segments[i - 1].end - 0.01) {
      throw new Error(`reframe segments ${i - 1} and ${i} overlap`);
    }
  }
  return { version: 1, mode: "ai_multi", sourceStart, sourceEnd, segments };
}

export function reframePlanHash(plan: ReframePlan): string {
  return crypto.createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 24);
}

export function summarizeReframePlan(plan: ReframePlan): { overallScore?: number; reasonCodes: string[] } {
  let weighted = 0;
  let duration = 0;
  const reasons = new Set<string>();
  for (const seg of plan.segments) {
    for (const reason of seg.reasonCodes ?? []) reasons.add(reason);
    if (seg.score == null) continue;
    const weight = seg.end - seg.start;
    weighted += seg.score * weight;
    duration += weight;
  }
  return {
    ...(duration > 0 ? { overallScore: Number((weighted / duration).toFixed(1)) } : {}),
    reasonCodes: [...reasons],
  };
}

/**
 * Keep clip metadata aligned with the bytes most recently rendered. Downstream Shorts
 * filters and publish gates classify the clip from this field, not from editorState.
 *
 * The current Clip vocabulary only has canonical labels for landscape and portrait. Keep
 * an existing portrait subtype (letterbox/crop-sub) for a basic render; a newly vertical
 * render defaults to crop-main. Square/4:5 renders deliberately retain the existing label
 * until those ratios are added to the Clip domain enum.
 */
export function canonicalRenderedClipAspect(
  renderAspect: string,
  previousAspect: unknown,
): string | undefined {
  if (renderAspect === "16:9") return "16:9";
  if (renderAspect === "9:16") {
    const previous = typeof previousAspect === "string" ? previousAspect.trim() : "";
    return previous.startsWith("9:16") ? previous : "9:16-crop-main";
  }
  return typeof previousAspect === "string" && previousAspect.trim()
    ? previousAspect
    : undefined;
}

/** Returns render-relative windows where letterboxed Fit (and decorations) should be visible. */
export function fitIntervalsForPlan(
  plan: ReframePlan,
  renderStart: number,
  renderEnd: number,
): Array<{ start: number; end: number }> {
  if (!(renderEnd > renderStart)) return [];
  const fills = plan.segments
    .filter((segment) => segment.layout === "fill")
    .map((segment) => ({ start: Math.max(renderStart, segment.start), end: Math.min(renderEnd, segment.end) }))
    .filter((segment) => segment.end > segment.start + 0.001)
    .sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const fill of fills) {
    const last = merged.at(-1);
    if (last && fill.start <= last.end + 0.001) last.end = Math.max(last.end, fill.end);
    else merged.push({ ...fill });
  }
  const fit: Array<{ start: number; end: number }> = [];
  let cursor = renderStart;
  for (const fill of merged) {
    if (fill.start > cursor + 0.001) fit.push({ start: cursor - renderStart, end: fill.start - renderStart });
    cursor = Math.max(cursor, fill.end);
  }
  if (cursor < renderEnd - 0.001) fit.push({ start: cursor - renderStart, end: renderEnd - renderStart });
  return fit;
}

function finiteNumber(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label} must be finite`);
  return n;
}
