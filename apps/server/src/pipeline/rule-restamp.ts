/**
 * 계획(자동배포 rule)의 모양을 바꾸면 **아직 안 나간 클립을 그 모양으로 다시 찍는다.**
 *
 * 왜 필요한가 (2026-08-28 ENA 실사용에서 걸린 것):
 * `editorState` 는 **채택 시점에 한 번 굳는다.** 그래서 계획에서 템플릿·색·글꼴을 바꿔도
 * 이미 채택돼 렌더까지 끝난 클립은 **옛 모양 그대로 게시된다.** 사용자는 화면에서 바꿨으니
 * 바뀐 줄 아는데 채널에는 옛것이 올라간다 — "저장은 됐는데 반영이 안 된다"는 이 리포의
 * 최빈 실패모드이고, 이번엔 고객 채널까지 나갈 뻔했다(11건을 손으로 되돌렸다).
 *
 * 규칙 셋:
 *  1. **대기 중인 것만.** 이미 배포된 클립은 건드리지 않는다 — 채널에 올라간 것과 DB 가
 *     달라지면 나중에 무엇이 나갔는지 못 읽는다.
 *  2. **모양이 실제로 바뀌었을 때만.** 계획을 켜고 끄기만 해도 전부 재렌더되면 시간과 비용이
 *     샌다(클립당 인코딩 1회).
 *  3. **사람이 편집기에서 손댄 값은 보존한다.** 트림·훅 문구는 계획의 모양이 아니라 그 클립의
 *     결정이다. 계획을 바꿨다고 남의 편집을 지우면 안 된다.
 */
import { getEntity, listEntities, putEntity } from "../db-pg.ts";

/** 계획에서 '모양' 에 해당하는 것들. 이 지문이 바뀔 때만 다시 찍는다. */
export function layoutFingerprint(rule: {
  templateId?: unknown; layout?: unknown; orientation?: unknown;
} | null | undefined): string {
  if (!rule) return "";
  const l = (rule.layout ?? {}) as Record<string, unknown>;
  // 키 순서에 흔들리지 않게 정렬해서 직렬화한다 — JSON.stringify 는 삽입 순서를 따르므로
  // 같은 내용이 다른 문자열이 되면 "안 바뀌었는데 전부 재렌더" 가 된다.
  const layout = Object.keys(l).sort().map((k) => [k, l[k]]);
  return JSON.stringify([String(rule.templateId ?? ""), String(rule.orientation ?? ""), layout]);
}

/**
 * 편집기에서 사람이 정한 값 — 다시 찍어도 그대로 둔다.
 * (계획의 모양이 아니라 그 클립 하나의 결정이다)
 */
export const PRESERVED_KEYS = [
  "trimIn", "trimOut", "hookOn", "hookCaption", "hookTtsOn", "speed", "keyframes",
] as const;

/** 새 시드 위에 보존 키를 덮어 최종 editorState 를 만든다. */
export function mergeRestamped(
  prev: Record<string, unknown> | undefined,
  fresh: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...fresh };
  for (const k of PRESERVED_KEYS) {
    if (prev && prev[k] !== undefined) out[k] = prev[k];
  }
  return out;
}

/** 아직 어느 채널로도 안 나간 클립인가. 배포 행이 하나라도 있으면 손대지 않는다. */
export function isPending(clip: { distributions?: unknown }): boolean {
  const d = clip.distributions;
  return !Array.isArray(d) || d.length === 0;
}

export interface RestampResult {
  /** 이 계획이 만든 클립 수 */
  scanned: number;
  /** 실제로 다시 찍은 수 (= 재렌더 대기가 된 수) */
  restamped: number;
  ids: string[];
}

/**
 * 계획이 만든 **대기 중** 클립을 현재 계획 모양으로 다시 찍고 재렌더 대기로 돌린다.
 *
 * `rendered:false` 가 핵심이다 — `/export` 는 editorState 를 통째로 해시해 캐시 키를 만들기
 * 때문에 내용이 바뀌면 어차피 다시 굽지만, 순방은 `rendered === false` 인 클립에만 렌더를
 * 요청한다. 그리고 게시 자격 검사도 `rendered !== false` 라, 다시 굽기 전에는 나가지 않는다.
 */
export async function restampPendingClips(rule: {
  id: string; templateId?: unknown; layout?: unknown;
}): Promise<RestampResult> {
  const { autoEditorState } = await import("./factory.ts");
  const clips = await listEntities<any>("clip");
  const mine = clips.filter((c) => c && c.automationRuleId === rule.id);
  const targets = mine.filter(isPending);

  const ids: string[] = [];
  for (const clip of targets) {
    const ep = clip.episodeId ? await getEntity<any>("episode", clip.episodeId) : undefined;
    const program = ep?.programId ? await getEntity<any>("program", ep.programId) : undefined;
    // 추천이 있으면 그것을, 없으면(정리됐거나 수동 생성) 클립이 들고 있는 같은 필드로 대체한다 —
    // autoEditorState 가 읽는 입력은 제목 줄·훅뿐이라 클립만으로도 같은 결과가 나온다.
    const rec = clip.sourceRecommendationId
      ? await getEntity<any>("recommendation", clip.sourceRecommendationId)
      : undefined;
    const recLike = rec ?? {
      title: clip.title, titleLine1: clip.titleLine1, titleLine2: clip.titleLine2,
      hookQuote: clip.hookQuote, hookTimeSec: clip.hookTimeSec,
      kind: clip.clipType === "T6" ? "short" : "clip",
      startTime: clip.startTime, endTime: clip.endTime,
    };

    const layout = { ...((rule as any).layout ?? {}) };
    // 순방(automation-cycle)과 **같은 기본값**을 쓴다 — 로고는 계획이 명시하지 않으면 끈다.
    // 여기만 다르면 "다시 찍었더니 처음 채택과 모양이 다르다" 가 된다.
    if (layout.logo === undefined) layout.logo = false;

    const fresh = autoEditorState(
      recLike, ep?.programTitle ?? clip.programTitle ?? "", program,
      (rule as any).templateId, layout, clip.aspectRatio,
    ) as Record<string, unknown>;
    fresh.captionsOn = (rule as any).layout?.subtitles !== false;
    if (clip.aspectRatio) fresh.aspect = clip.aspectRatio;

    await putEntity("clip", clip.id, {
      ...clip,
      editorState: mergeRestamped(clip.editorState as Record<string, unknown> | undefined, fresh),
      rendered: false,
    });
    ids.push(clip.id);
  }
  return { scanned: mine.length, restamped: ids.length, ids };
}
