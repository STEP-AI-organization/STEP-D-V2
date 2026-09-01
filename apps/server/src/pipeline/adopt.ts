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
} from "../db-pg.ts";
import { newId } from "../ids.ts";

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

  // ⚠️ 예전엔 여기서 회차·추천의 **권리 이슈를 클립으로 승계**했다. 권리 게이트가
  // 2026-08-31 에 제거되면서(사용자 결정 · rights_issue 0행) 승계할 대상도 소비처도 없어졌다.
  return true;
}

