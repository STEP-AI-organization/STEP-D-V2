/**
 * 채택 커밋 — 추천 구간이 미디어가 되는 **유일한 지점** (FLOWS F2).
 *
 * 채택은 두 가지가 항상 같이 일어나야 한다:
 *   1. 클립 생성 + 추천 상태 뒤집기 (원자적으로)
 *   2. **권리·심의 이슈 승계** — "이슈가 승계되지 않은 미디어는 존재할 수 없다"(F2 Invariant)
 *
 * 예전엔 이 둘이 index.ts 의 adopt 라우트에만 붙어 있었고, factory 의 자동 채택 경로는
 * 1번만 했다. 그래서 **공장이 만든 미디어는 이슈를 물려받지 않았다.** 게이트가 fail-closed
 * 라 배포로 새지는 않았지만, 사람이 회차에 등록해 둔 이슈가 미디어에 안 붙는 건 그 자체로
 * 규칙 위반이다. 경로가 둘이면 한쪽만 고치게 된다 — 그래서 여기 하나로 모은다.
 */
import {
  appendGateAudit,
  commitAdoption,
  insertRightsIssue,
  isJudged,
  listRightsIssues,
  putRightsJudgement,
} from "./db-pg.ts";
import { inheritedIssues, type Issue } from "./gate.ts";
import { newId } from "./pipeline.ts";

/**
 * 채택을 커밋하고 이슈를 승계한다.
 *
 * @returns 커밋됐으면 true. false 면 그 추천은 이미 다른 요청이 채택했다(아무것도 안 썼다).
 */
export async function commitAndInherit(
  clipId: string,
  clip: unknown,
  recId: string,
  rec: { episodeId: string; startTime: number; endTime: number; [k: string]: unknown },
): Promise<boolean> {
  const ok = await commitAdoption(clipId, clip, recId, { ...rec, status: "adopted", adoptedClipId: clipId });
  if (!ok) return false;

  await inheritGateToClip({
    clipId,
    episodeId: rec.episodeId,
    recommendationId: recId,
    segment: { start: rec.startTime, end: rec.endTime },
  });
  return true;
}

/**
 * 회차·추천에 달린 이슈 중 **잘라낸 구간과 겹치는 것**을 미디어로 내린다 (F2-4).
 * 밴드 없는 이슈(대상 전체)는 무조건 따라온다.
 *
 * **판정도 함께 내려온다.** 회차가 "이슈 없음"으로 판정돼 있으면 거기서 잘라낸 미디어도
 * 판정된 것으로 본다 — 안 그러면 채택할 때마다 모든 미디어가 검수 대기로 되돌아가고,
 * 사람이 같은 판단을 회차당 수십 번 반복해야 한다.
 */
export async function inheritGateToClip(opts: {
  clipId: string;
  episodeId: string;
  recommendationId: string;
  segment: { start: number; end: number };
}): Promise<void> {
  const [epIssues, recIssues, epJudged, recJudged] = await Promise.all([
    listRightsIssues("episode", opts.episodeId),
    listRightsIssues("recommendation", opts.recommendationId),
    isJudged("episode", opts.episodeId),
    isJudged("recommendation", opts.recommendationId),
  ]);

  const rows = [...epIssues, ...recIssues];
  const asIssues: Issue[] = rows.map((r) => ({
    id: r.id, kind: r.kind, resolution: r.resolution,
    bandStart: r.bandStart, bandEnd: r.bandEnd, note: r.note,
  }));
  const carriedIds = new Set(inheritedIssues(opts.segment, asIssues).map((i) => i.id));

  for (const row of rows) {
    if (!carriedIds.has(row.id)) continue;
    await insertRightsIssue({
      id: newId("ri"),
      subjectType: "clip",
      subjectId: opts.clipId,
      kind: row.kind,
      resolution: row.resolution,
      bandStart: row.bandStart,
      bandEnd: row.bandEnd,
      note: row.note,
      actor: row.actor,
      inheritedFrom: row.id,
    });
  }

  if (epJudged || recJudged) {
    await putRightsJudgement("clip", opts.clipId, "승계", `${opts.recommendationId} 채택 시 판정 승계`);
  }

  await appendGateAudit({
    subjectType: "clip",
    subjectId: opts.clipId,
    action: "inherit",
    toState: carriedIds.size > 0 ? "issues" : epJudged || recJudged ? "judged" : "unjudged",
    actor: "system",
    basis: `채택 승계 — 이슈 ${carriedIds.size}건 · 판정 ${epJudged || recJudged ? "있음" : "없음"}`,
  });
}
