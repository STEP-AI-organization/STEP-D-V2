/**
 * 리포트 집계 — **모든 숫자는 여기서만 나온다.**
 *
 * ## 이 파일의 계약
 *
 * 모델은 이 결과를 **읽고 문장을 쓸 뿐** 값을 만들지 않는다(narrate.ts 가 그걸 강제한다).
 * 반대로 여기서는 문장을 쓰지 않는다 — 라벨과 숫자만 낸다. 두 일이 한 파일에 섞이면
 * "이 숫자 어디서 나왔냐" 에 답할 수 없게 된다.
 *
 * ## 검산을 결과에 담는다
 *
 * 표의 합과 헤드라인이 어긋난 보고서는 **틀린 보고서가 아니라 못 믿을 보고서**다. 목업
 * (AENA 실적 화면)이 각주에 "채널 카드 합 = 표 합계 = 헤드라인" 을 적어 둔 이유가 그것이다.
 * 사람이 눈으로 하던 그 대조를 여기서 계산해 `crosscheck` 로 넘긴다 — 어긋나면
 * 내보내기가 막힌다.
 *
 * 테넌트 격리는 RLS 가 한다. 이 파일 SQL 에 tenant 조건이 없는 건 의도다.
 */
import { getPool } from "../db-pg.ts";
import { kstDayEnd, kstDayStart, previousPeriod, KIND_LABEL, type ReportSpec } from "./spec.ts";

// ── 산출물 모양 ──────────────────────────────────────────────────────────────────
// 세 종류가 **같은 모양**을 낸다. 그래야 렌더·서술·검산이 종류를 몰라도 된다
// (새 종류를 추가할 때 고칠 곳이 집계 함수 하나로 끝난다).

export interface Metric {
  label: string;
  value: number;
  unit: string;
  /** 직전 기간 대비 증감. 비교를 안 했으면 없음. */
  delta?: number;
  note?: string;
}

export interface Section {
  title: string;
  columns: string[];
  rows: (string | number)[][];
  /** 합계 행. 있으면 검산 대상이 된다. */
  total?: (string | number)[];
  note?: string;
}

export interface SourceNote {
  what: string;
  /** 이 데이터가 언제 기준인지. null = 조회 시점(실시간). */
  asOf: string | null;
}

export interface Crosscheck {
  name: string;
  expected: number;
  actual: number;
  ok: boolean;
}

export interface ReportData {
  kind: ReportSpec["kind"];
  title: string;
  period: { from: string; to: string; compare?: { from: string; to: string } };
  headline: Metric[];
  sections: Section[];
  sources: SourceNote[];
  crosscheck: Crosscheck[];
  /** 기간 안에 자료가 하나도 없었나 — 서술이 "없는 것을 있다고" 쓰지 않게 알린다. */
  empty: boolean;
}

const CHANNEL_LABEL: Record<string, string> = {
  youtube: "유튜브", instagram: "인스타그램", facebook: "페이스북",
  tiktok: "틱톡", naver: "네이버", smr: "SMR",
};

/** 자동 경로로 나간 배포인가 — `publish-notify.ts` 의 AUTO_ORIGINS 와 **같은 축**이다. */
const AUTO_ORIGINS = new Set(["automation", "factory"]);

function check(name: string, expected: number, actual: number): Crosscheck {
  return { name, expected, actual, ok: expected === actual };
}

function sum(ns: number[]): number {
  return ns.reduce((a, b) => a + b, 0);
}

// ── 종류 1 · 채널 성과 ───────────────────────────────────────────────────────────

async function channelPerformance(spec: ReportSpec): Promise<ReportData> {
  const prev = spec.compareToPrevious ? previousPeriod(spec) : null;

  const channels = await getPool().query(
    `SELECT channelid AS id, channelname AS name, lastsyncedat AS "lastSyncedAt"
       FROM youtube_channels WHERE status <> 'disconnected' ORDER BY channelname`,
  );

  // 기간별 합계. 두 기간을 한 쿼리로 — 왕복을 줄이려는 게 아니라 **같은 스냅샷**에서
  // 읽어야 비교가 성립하기 때문이다(사이에 동기화가 끼면 대조군만 갱신될 수 있다).
  const agg = await getPool().query(
    `SELECT channelid AS id,
            CASE WHEN day >= $1 AND day <= $2 THEN 'now' ELSE 'prev' END AS bucket,
            SUM(views)::bigint                                    AS views,
            SUM(estimatedminuteswatched)::bigint                  AS minutes,
            SUM(subscribersgained - subscriberslost)::bigint      AS subs,
            SUM(COALESCE(estimatedrevenue, 0))::numeric           AS revenue,
            MAX(fetchedat)::bigint                                AS fetched
       FROM channel_analytics
      WHERE (day >= $1 AND day <= $2) OR ($3::text IS NOT NULL AND day >= $3 AND day <= $4)
      GROUP BY 1, 2`,
    [spec.from, spec.to, prev?.from ?? null, prev?.to ?? null],
  );

  const now = new Map<string, any>();
  const before = new Map<string, any>();
  let fetchedMax = 0;
  for (const r of agg.rows) {
    (r.bucket === "now" ? now : before).set(r.id, r);
    fetchedMax = Math.max(fetchedMax, Number(r.fetched ?? 0));
  }

  const rows: (string | number)[][] = [];
  for (const ch of channels.rows) {
    const a = now.get(ch.id);
    rows.push([
      ch.name || ch.id,
      Number(a?.views ?? 0),
      Number(a?.minutes ?? 0),
      Number(a?.subs ?? 0),
      Math.round(Number(a?.revenue ?? 0)),
    ]);
  }
  // 값이 큰 채널부터. 보고서를 읽는 사람은 위 세 줄만 본다.
  rows.sort((x, y) => Number(y[1]) - Number(x[1]));

  const totals = {
    views: sum(rows.map((r) => Number(r[1]))),
    minutes: sum(rows.map((r) => Number(r[2]))),
    subs: sum(rows.map((r) => Number(r[3]))),
    revenue: sum(rows.map((r) => Number(r[4]))),
  };
  const prevTotals = {
    views: sum([...before.values()].map((r) => Number(r.views ?? 0))),
    minutes: sum([...before.values()].map((r) => Number(r.minutes ?? 0))),
    subs: sum([...before.values()].map((r) => Number(r.subs ?? 0))),
  };

  const headline: Metric[] = [
    { label: "조회수", value: totals.views, unit: "회", ...(prev ? { delta: totals.views - prevTotals.views } : {}) },
    { label: "시청시간", value: totals.minutes, unit: "분", ...(prev ? { delta: totals.minutes - prevTotals.minutes } : {}) },
    { label: "구독 순증", value: totals.subs, unit: "명", ...(prev ? { delta: totals.subs - prevTotals.subs } : {}) },
    { label: "추정 수익", value: totals.revenue, unit: "원", note: "유튜브 추정치 · 확정 정산액이 아님" },
  ];

  return {
    kind: spec.kind,
    title: spec.title,
    period: { from: spec.from, to: spec.to, ...(prev ? { compare: prev } : {}) },
    headline,
    sections: [{
      title: "채널별",
      columns: ["채널", "조회수", "시청시간(분)", "구독 순증", "추정 수익(원)"],
      rows,
      total: ["합계", totals.views, totals.minutes, totals.subs, totals.revenue],
    }],
    sources: [{
      what: "유튜브 채널 지표",
      asOf: fetchedMax ? new Date(fetchedMax).toISOString() : null,
    }],
    crosscheck: [
      check("채널별 조회수 합 = 헤드라인 조회수", totals.views, sum(rows.map((r) => Number(r[1])))),
      check("채널별 시청시간 합 = 헤드라인 시청시간", totals.minutes, sum(rows.map((r) => Number(r[2])))),
    ],
    empty: totals.views === 0 && totals.minutes === 0 && rows.length === 0,
  };
}

// ── 종류 2 · 운영 실적 ───────────────────────────────────────────────────────────

async function operations(spec: ReportSpec): Promise<ReportData> {
  const from = kstDayStart(spec.from);
  const to = kstDayEnd(spec.to);

  // 배포 — 프로그램 × 채널 × (자동/수동). 목업의 표가 이 결과 하나로 만들어진다.
  //
  // ⚠️ `publishedAt` 은 JSONB 안의 문자열이라 **바로 캐스팅하면 안 된다.** 옛 기록에 숫자가
  //    아닌 값이 하나라도 섞여 있으면 쿼리 전체가 죽고, WHERE 절의 정규식 검사와 캐스팅을
  //    나란히 두는 것만으로는 순서가 보장되지 않는다. LATERAL 로 먼저 걸러서 캐스팅한다.
  const dist = await getPool().query(
    `SELECT COALESCE(NULLIF(e.data->>'programTitle', ''), '(프로그램 미지정)') AS program,
            d->>'channel'                                                     AS channel,
            COALESCE(d->>'origin', '')                                        AS origin,
            COUNT(*)::int                                                     AS n
       FROM entities e,
            jsonb_array_elements(COALESCE(e.data->'distributions', '[]'::jsonb)) d,
            LATERAL (SELECT CASE WHEN d->>'publishedAt' ~ '^[0-9]+$'
                                 THEN (d->>'publishedAt')::bigint END AS pub) p
      WHERE e.kind = 'clip'
        AND d->>'status' IN ('published', 'recorded')
        AND p.pub BETWEEN $1 AND $2
      GROUP BY 1, 2, 3`,
    [from, to],
  );

  const jobs = await getPool().query(
    `SELECT type, status, COUNT(*)::int AS n
       FROM job_queue
      WHERE updatedAt BETWEEN $1 AND $2
        AND type IN ('content.analyze', 'clip.render', 'distribution.publish', 'naver.publish')
      GROUP BY 1, 2`,
    [from, to],
  );

  const fails = await getPool().query(
    `SELECT type, COALESCE(NULLIF(split_part(error, E'\\n', 1), ''), '(사유 없음)') AS reason,
            COUNT(*)::int AS n
       FROM job_queue
      WHERE status = 'failed' AND updatedAt BETWEEN $1 AND $2
      GROUP BY 1, 2 ORDER BY n DESC LIMIT 5`,
    [from, to],
  );

  // 프로그램 × 채널 표.
  const channelKeys = [...new Set(dist.rows.map((r: any) => r.channel))].sort();
  const programs = [...new Set(dist.rows.map((r: any) => r.program))];
  const cell = new Map<string, number>();
  let autoTotal = 0;
  for (const r of dist.rows) {
    cell.set(`${r.program} ${r.channel}`, (cell.get(`${r.program} ${r.channel}`) ?? 0) + r.n);
    if (AUTO_ORIGINS.has(r.origin)) autoTotal += r.n;
  }

  const rows: (string | number)[][] = programs.map((p) => {
    const cells = channelKeys.map((c) => cell.get(`${p} ${c}`) ?? 0);
    return [p, ...cells, sum(cells)];
  });
  rows.sort((x, y) => Number(y[y.length - 1]) - Number(x[x.length - 1]));

  const channelTotals = channelKeys.map((_, i) => sum(rows.map((r) => Number(r[i + 1]))));
  const grandTotal = sum(channelTotals);

  const jobCount = (type: string, status: string) =>
    Number(jobs.rows.find((r: any) => r.type === type && r.status === status)?.n ?? 0);

  const headline: Metric[] = [
    { label: "배포", value: grandTotal, unit: "건", note: "영상 × 채널" },
    { label: "자동 배포", value: autoTotal, unit: "건", note: "위 배포 중 자동 경로" },
    { label: "분석 완료", value: jobCount("content.analyze", "done"), unit: "회차" },
    { label: "실패", value: sum(fails.rows.map((r: any) => Number(r.n))), unit: "건", note: "모든 작업 종류 합" },
  ];

  const sections: Section[] = [{
    title: "프로그램 × 채널 배포",
    columns: ["프로그램", ...channelKeys.map((c) => CHANNEL_LABEL[c] ?? c), "합계"],
    rows,
    total: ["합계", ...channelTotals, grandTotal],
    note: `자동 경로 ${autoTotal}건 포함`,
  }];

  if (fails.rows.length) {
    sections.push({
      title: "실패 사유",
      columns: ["작업", "사유", "건수"],
      rows: fails.rows.map((r: any) => [r.type, String(r.reason).slice(0, 120), Number(r.n)]),
    });
  }

  return {
    kind: spec.kind,
    title: spec.title,
    period: { from: spec.from, to: spec.to },
    headline,
    sections,
    sources: [
      { what: "배포 기록 (게시 완료 시각 기준)", asOf: null },
      { what: "작업 기록", asOf: null },
    ],
    crosscheck: [
      check("채널별 합 = 표 합계", grandTotal, sum(channelTotals)),
      check("프로그램별 합 = 표 합계", grandTotal, sum(rows.map((r) => Number(r[r.length - 1])))),
      check("헤드라인 배포 건수 = 표 합계", grandTotal, Number(headline[0].value)),
    ],
    empty: grandTotal === 0 && jobCount("content.analyze", "done") === 0,
  };
}

// ── 종류 3 · 사용량 ──────────────────────────────────────────────────────────────

const REASON_LABEL: Record<string, string> = {
  usage: "사용(분석·배포)", topup: "충전", grant: "무상 지급",
  adjust: "정정", refund: "환불",
};

async function usageCost(spec: ReportSpec): Promise<ReportData> {
  const from = new Date(kstDayStart(spec.from));
  const to = new Date(kstDayEnd(spec.to));

  const { rows } = await getPool().query(
    `SELECT reason,
            SUM(delta)::int                    AS delta,
            COUNT(*)::int                      AS n,
            SUM(COALESCE(amount_krw, 0))::int  AS krw
       FROM credit_ledger
      WHERE occurred_at >= $1 AND occurred_at <= $2
      GROUP BY reason ORDER BY reason`,
    [from, to],
  );

  const used = -sum(rows.filter((r: any) => Number(r.delta) < 0).map((r: any) => Number(r.delta)));
  const added = sum(rows.filter((r: any) => Number(r.delta) > 0).map((r: any) => Number(r.delta)));
  const krw = sum(rows.map((r: any) => Number(r.krw ?? 0)));

  const table: (string | number)[][] = rows.map((r: any) => [
    REASON_LABEL[r.reason] ?? r.reason, Number(r.n), Number(r.delta), Number(r.krw ?? 0),
  ]);

  return {
    kind: spec.kind,
    title: spec.title,
    period: { from: spec.from, to: spec.to },
    headline: [
      { label: "사용한 크레딧", value: used, unit: "개", note: "1개 = 분석 1분" },
      { label: "충전·지급된 크레딧", value: added, unit: "개" },
      { label: "결제 금액", value: krw, unit: "원", note: "부가세 포함 청구액" },
    ],
    sections: [{
      title: "내역",
      columns: ["항목", "건수", "크레딧 증감", "금액(원)"],
      rows: table,
      total: ["합계", sum(table.map((r) => Number(r[1]))), added - used, krw],
    }],
    sources: [{ what: "크레딧 원장", asOf: null }],
    crosscheck: [
      check("증감 합 = 충전 − 사용", added - used, sum(table.map((r) => Number(r[2])))),
      check("금액 합 = 헤드라인 결제 금액", krw, sum(table.map((r) => Number(r[3])))),
    ],
    empty: rows.length === 0,
  };
}

// ── 진입점 ───────────────────────────────────────────────────────────────────────

/**
 * 스펙 하나 → 집계 하나. 새 종류를 추가할 때 고칠 곳은 이 표와 함수 하나다.
 * 종류가 늘어도 렌더·서술·검산은 손대지 않는다(위 `ReportData` 계약).
 */
export async function aggregate(spec: ReportSpec): Promise<ReportData> {
  switch (spec.kind) {
    case "channel-performance": return channelPerformance(spec);
    case "usage-cost":          return usageCost(spec);
    case "operations":
    default:                    return operations(spec);
  }
}

export { KIND_LABEL };
