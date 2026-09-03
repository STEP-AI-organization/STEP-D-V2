/**
 * 리포트 한 편을 만드는 흐름. 네 단계가 **한 방향으로만** 흐른다.
 *
 *   요청문 → ① 스펙(모델) → ② 집계(SQL) → ③ 서술(모델) → ④ 문서
 *
 * 모델이 두 번 나오지만 하는 일이 다르다. ①은 **무엇을 뽑을지**만 정하고, ③은 ②가 낳은
 * 숫자를 **읽기만** 한다. 숫자가 모델을 지나가는 지점이 없다 — 그게 이 구조의 전부다.
 *
 * 검산이 어긋나면 여기서 던지지 않는다. 화면에서는 보이되(무엇이 어긋났는지 알아야 고친다)
 * **내보내기가 막힌다**(라우트가 `crosscheckFailures` 로 판정). 못 믿을 표가 첨부파일이
 * 되어 회의에 들어가는 것만은 막는다.
 */
import { aggregate, type ReportData } from "./aggregate.ts";
import { narrate } from "./narrate.ts";
import { crosscheckFailures, toHtml, toMarkdown } from "./render.ts";
import { parseSpec, type ReportSpec } from "./spec.ts";
import { saveReport, type Actor } from "./store.ts";

export interface BuiltReport {
  reportId: string;
  spec: ReportSpec;
  data: ReportData;
  markdown: string;
  warnings: string[];
}

/** 요청문 하나 → 저장된 리포트 하나. */
export async function buildReport(
  user: Actor,
  request: string,
  opts: { threadId?: string | null; now?: Date } = {},
): Promise<BuiltReport> {
  const now = opts.now ?? new Date();
  const spec = await parseSpec(request, now);
  const data = await aggregate(spec);
  const narration = await narrate(data);

  const warnings = [...narration.warnings];
  for (const f of crosscheckFailures(data)) {
    warnings.push(`검산 불일치 — ${f}. 내보내기는 막혀 있습니다.`);
  }

  const markdown = toMarkdown(data, narration.text, now);
  const reportId = await saveReport(user, {
    threadId: opts.threadId ?? null,
    request, spec, data, markdown, warnings,
  });

  return { reportId, spec, data, markdown, warnings };
}

export { aggregate, crosscheckFailures, toHtml, toMarkdown, parseSpec };
export type { ReportData, ReportSpec };
