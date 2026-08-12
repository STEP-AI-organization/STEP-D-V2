import type { ClipReframe, ReframeSegment, ReframeTrackingPoint } from "@/lib/types";

export interface ReframeFrame {
  layout: "fit" | "fill";
  segment?: ReframeSegment;
  cx: number;
  cy: number;
}

export interface PendingTrimReframe {
  key: string;
  dueAt: number;
}

/** Pure scheduling decision used by the editor's trim debounce. */
export function resolvePendingTrimReframe(
  pending: PendingTrimReframe | null,
  currentKey: string,
  aiMode: boolean,
  requestInFlight: boolean,
  now: number,
): "drop" | "wait" | "run" {
  if (!pending || !aiMode || pending.key !== currentKey) return "drop";
  if (requestInFlight || now < pending.dueAt) return "wait";
  return "run";
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

function validPoints(points: ReframeTrackingPoint[] | undefined): ReframeTrackingPoint[] {
  return (points ?? [])
    .filter((point) =>
      Number.isFinite(point.t) && Number.isFinite(point.cx) && Number.isFinite(point.cy),
    )
    .slice()
    .sort((a, b) => a.t - b.t);
}

/** Linearly sample normalized tracking at a master-timeline instant. */
export function sampleReframeTracking(
  points: ReframeTrackingPoint[] | undefined,
  masterTime: number,
): { cx: number; cy: number } {
  const list = validPoints(points);
  if (list.length === 0 || !Number.isFinite(masterTime)) return { cx: 0.5, cy: 0.5 };
  if (masterTime <= list[0].t) return { cx: clamp01(list[0].cx), cy: clamp01(list[0].cy) };
  const last = list[list.length - 1];
  if (masterTime >= last.t) return { cx: clamp01(last.cx), cy: clamp01(last.cy) };
  for (let index = 0; index < list.length - 1; index++) {
    const a = list[index];
    const b = list[index + 1];
    if (masterTime > b.t) continue;
    const progress = b.t === a.t ? 0 : (masterTime - a.t) / (b.t - a.t);
    return {
      cx: clamp01(a.cx + (b.cx - a.cx) * progress),
      cy: clamp01(a.cy + (b.cy - a.cy) * progress),
    };
  }
  return { cx: clamp01(last.cx), cy: clamp01(last.cy) };
}

/** Resolve the planner's decision at an absolute source-master time. */
export function sampleReframeFrame(reframe: ClipReframe | undefined, masterTime: number): ReframeFrame {
  if (reframe?.mode !== "ai_multi" || reframe.status !== "ready") {
    return { layout: "fit", cx: 0.5, cy: 0.5 };
  }
  const segments = reframe.plan?.segments ?? [];
  const segment = segments.find((item, index) =>
    masterTime >= item.start && (masterTime < item.end || (index === segments.length - 1 && masterTime <= item.end)),
  );
  if (!segment) return { layout: "fit", cx: 0.5, cy: 0.5 };
  const focus = sampleReframeTracking(segment.tracking, masterTime);
  return { layout: segment.layout, segment, ...focus };
}

export const REFRAME_REASON_LABELS: Record<string, string> = {
  SCORE_THRESHOLD_MET: "세로 화면 전환 점수를 충족했어요",
  SINGLE_SUBJECT_SAFE: "한 명의 주요 인물을 안전하게 추적했어요",
  LOW_DETECTION_COVERAGE: "인물 감지 구간이 부족해 원본 구도를 유지해요",
  MULTI_PERSON_DOMINANCE: "여러 인물이 함께 보여 원본 구도를 유지해요",
  UNSAFE_VERTICAL_CROP: "세로 크롭 시 중요한 화면이 잘릴 수 있어요",
  LONG_DETECTION_GAP: "인물 추적이 오래 끊겨 원본 구도를 유지해요",
  MULTI_PERSON_AMBIGUOUS: "주요 인물을 안정적으로 고르기 어려워요",
  SCORE_BELOW_THRESHOLD: "세로 화면 전환 점수가 기준보다 낮아요",
  BEAT_GAP_FALLBACK: "분석되지 않은 짧은 구간은 원본 구도를 유지해요",
  EMPTY_TRACKING_PATH: "안전한 추적 경로가 없어 원본 구도를 유지해요",
};

export function reframeReasonLabel(code: string): string {
  return REFRAME_REASON_LABELS[code] ?? code.replaceAll("_", " ").toLowerCase();
}

export function reframeErrorMessage(reframe: ClipReframe | undefined): string | undefined {
  if (!reframe?.error) return undefined;
  return typeof reframe.error === "string" ? reframe.error : reframe.error.message;
}
