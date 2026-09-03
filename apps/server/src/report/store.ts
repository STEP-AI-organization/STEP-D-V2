/**
 * 리포트 저장소 (`report_doc` · 0051).
 *
 * ## 집계 원본(`data`)을 왜 같이 저장하나
 *
 * 본문(markdown)만 남기면 재생성도 검산도 못 한다. 숫자는 전부 결정론 집계가 낳으므로 그
 * JSON 을 함께 두면 ① 같은 기간을 다시 뽑아 대조할 수 있고 ② 나중에 "이 숫자 어디서 나왔냐"
 * 에 답할 수 있다. HTML 은 **파생물이라 저장하지 않는다** — 저장하면 본문과 어긋난 사본이 생긴다.
 *
 * 회사 격리는 RLS 가 한다(0051). 사람 격리(`user_id`)는 여기 조건이 한다 — 챗봇 대화와 같은
 * 규칙이다(chatbot/store.ts 주석).
 */
import { getPool } from "../db-pg.ts";
import { newId } from "../ids.ts";
import type { ReportData } from "./aggregate.ts";
import type { ReportSpec } from "./spec.ts";

/** 리포트를 만든 사람. 회사는 RLS 가 보므로 여기서는 사람만 알면 된다. */
export interface Actor {
  id: string;
  tenantId: string;
}

/** 목록에 보여 주는 개수. */
export const REPORT_LIST_LIMIT = 20;

export interface ReportRow {
  id: string;
  threadId: string | null;
  request: string;
  spec: ReportSpec;
  /** 집계 원본. 렌더·검산이 그대로 다시 읽는다. */
  data: ReportData;
  markdown: string;
  warnings: string[];
  createdAt: number;
}

export async function saveReport(
  user: Actor,
  r: { threadId?: string | null; request: string; spec: unknown; data: unknown; markdown: string; warnings: string[] },
): Promise<string> {
  const id = newId("rp");
  await getPool().query(
    `INSERT INTO report_doc (id, user_id, thread_id, request, spec, data, markdown, warnings, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9)`,
    [id, user.id, r.threadId ?? null, r.request,
     JSON.stringify(r.spec ?? {}), JSON.stringify(r.data ?? {}),
     r.markdown, JSON.stringify(r.warnings ?? []), Date.now()],
  );
  return id;
}

export async function getReport(user: Actor, id: string): Promise<ReportRow | null> {
  const { rows } = await getPool().query(
    `SELECT id, thread_id AS "threadId", request, spec, data, markdown, warnings,
            created_at AS "createdAt"
       FROM report_doc WHERE id = $1 AND user_id = $2`,
    [id, user.id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id, threadId: r.threadId ?? null, request: r.request ?? "",
    spec: r.spec as ReportSpec, data: r.data as ReportData, markdown: r.markdown ?? "",
    warnings: Array.isArray(r.warnings) ? r.warnings : [],
    // BIGINT 는 pg 가 문자열로 준다(정밀도 보존). 숫자로 돌려주지 않으면 화면이 문자열 비교를 한다.
    createdAt: Number(r.createdAt),
  };
}

/** 목록에는 **본문·집계를 싣지 않는다** — 목록 한 번이 수백 KB 가 되면 안 된다. */
export async function listReports(user: Actor, limit = REPORT_LIST_LIMIT): Promise<
  { id: string; request: string; kind: string; createdAt: number; warnings: number }[]
> {
  const { rows } = await getPool().query(
    `SELECT id, request, spec->>'kind' AS kind, created_at AS "createdAt",
            jsonb_array_length(COALESCE(warnings, '[]'::jsonb)) AS warnings
       FROM report_doc WHERE user_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [user.id, Math.min(limit, REPORT_LIST_LIMIT)],
  );
  return rows.map((r: any) => ({
    id: r.id, request: r.request, kind: r.kind ?? "",
    createdAt: Number(r.createdAt), warnings: Number(r.warnings ?? 0),
  }));
}
