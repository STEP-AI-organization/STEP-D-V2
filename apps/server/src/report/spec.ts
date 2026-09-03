/**
 * 자연어 요청 → **리포트 스펙**. 리포트의 첫 단계.
 *
 * ## 왜 스펙을 따로 두나
 *
 * "8월 채널 성과 보고서" 한 줄에는 세 가지가 섞여 있다 — 무엇을(종류), 언제(기간),
 * 무엇과 비교해서(대조군). 이걸 풀지 않고 바로 문서를 쓰게 하면 모델이 기간을 자기 마음대로
 * 잡고, 그 기간에 맞는 숫자를 **자기가 만들어** 낸다.
 *
 * 그래서 모델은 여기서 **구조만 정한다.** 숫자는 그다음 단계(aggregate.ts)가 SQL 로 낳는다.
 * `ai/search-parse.ts`(자연어 질의 → 검색 필터)가 같은 패턴의 먼저 구현이다.
 *
 * ## 모델이 못 알아들으면
 *
 * 던지지 않고 **이번 달 운영 실적**으로 떨어뜨린다. 사람이 보고 기간을 고치는 게,
 * "무슨 말인지 모르겠다" 를 받고 다시 쓰는 것보다 빠르다.
 */
import { geminiChat, parseJsonLoose } from "../ai/gemini.ts";
import { SUPPORT, SUPPORT_LOCATION } from "../ai/models.ts";
import { kstDayKey } from "../billing/credits.ts";

export const REPORT_KINDS = ["channel-performance", "operations", "usage-cost"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const KIND_LABEL: Record<ReportKind, string> = {
  "channel-performance": "채널 성과 보고",
  operations: "운영 실적 보고",
  "usage-cost": "사용량 보고",
};

export interface ReportSpec {
  kind: ReportKind;
  /** KST 달력일 "YYYY-MM-DD" — 포함. */
  from: string;
  /** KST 달력일 "YYYY-MM-DD" — 포함. */
  to: string;
  /** 직전 같은 길이의 기간과 비교할지. */
  compareToPrevious: boolean;
  title: string;
}

/** 한 번에 뽑을 수 있는 최대 기간(일). 넘으면 잘라낸다 — 표가 사람이 못 읽을 만큼 길어진다. */
export const MAX_PERIOD_DAYS = 366;

const DAY = 24 * 60 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** KST 달력일 → 그 날 00:00(KST)의 epoch ms. */
export function kstDayStart(day: string): number {
  return Date.parse(`${day}T00:00:00+09:00`);
}
/** KST 달력일 → 그 날 23:59:59.999(KST)의 epoch ms. 기간 끝은 **그 날을 포함**한다. */
export function kstDayEnd(day: string): number {
  return Date.parse(`${day}T23:59:59.999+09:00`);
}

/** 이번 달 1일 ~ 오늘(KST). 아무 말이 없을 때의 기본 기간. */
export function thisMonth(now: Date = new Date()): { from: string; to: string } {
  const today = kstDayKey(now);
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

/** 직전 같은 길이의 기간. "전월 대비" 가 아니라 **같은 일수 대비**다 — 달마다 길이가 달라서. */
export function previousPeriod(spec: Pick<ReportSpec, "from" | "to">): { from: string; to: string } {
  const start = kstDayStart(spec.from);
  const end = kstDayStart(spec.to);
  const days = Math.round((end - start) / DAY) + 1;
  return {
    from: kstDayKey(new Date(start - days * DAY)),
    to: kstDayKey(new Date(start - DAY)),
  };
}

/**
 * 모델이 준 값을 **쓸 수 있는 스펙으로** 만든다. 순수 함수 — 테스트가 여기를 본다.
 *
 * 방어하는 것들: 모르는 종류 · 날짜 아닌 문자열 · 뒤집힌 기간 · 미래 · 지나치게 긴 기간.
 * 전부 "거절" 이 아니라 **가장 가까운 말이 되는 값**으로 눌러 담는다.
 */
export function normalizeSpec(raw: unknown, now: Date = new Date()): ReportSpec {
  const r = (raw ?? {}) as Record<string, unknown>;
  const today = kstDayKey(now);
  const fallback = thisMonth(now);

  const kind: ReportKind = (REPORT_KINDS as readonly string[]).includes(String(r.kind))
    ? (String(r.kind) as ReportKind)
    : "operations";

  let from = DAY_RE.test(String(r.from ?? "")) ? String(r.from) : fallback.from;
  let to = DAY_RE.test(String(r.to ?? "")) ? String(r.to) : fallback.to;

  // 아직 오지 않은 날은 데이터가 없다. "8월 보고서" 를 8월 3일에 뽑아도 3일까지만 나온다.
  if (to > today) to = today;
  if (from > to) from = to;

  if ((kstDayStart(to) - kstDayStart(from)) / DAY + 1 > MAX_PERIOD_DAYS) {
    from = kstDayKey(new Date(kstDayStart(to) - (MAX_PERIOD_DAYS - 1) * DAY));
  }

  const title = String(r.title ?? "").trim() || `${KIND_LABEL[kind]} (${from} ~ ${to})`;
  return { kind, from, to, compareToPrevious: r.compareToPrevious !== false, title };
}

/** 고정 지시 — 모든 요청에 글자 그대로 같이 나간다(캐시 접두사). 워크스페이스 값 금지. */
const SPEC_RULES = [
  "사용자의 요청을 보고서 스펙으로 옮겨라. JSON 만 출력한다.",
  "",
  "종류는 셋 중 하나다.",
  "- channel-performance: 조회수·시청시간·구독·수익 등 채널 성과",
  "- operations: 분석·제작·배포 건수와 실패 등 운영 실적",
  "- usage-cost: 크레딧 사용량·충전 내역",
  "",
  "종류를 못 고르겠으면 operations 로 한다 — '보고서 하나 만들어줘' 처럼 막연한 요청의 기본값이다.",
  "",
  "기간이 없으면 이번 달 1일부터 오늘까지로 한다.",
  "'지난달' 은 지난달 1일부터 말일까지다. 날짜는 KST 기준 YYYY-MM-DD 로 쓴다.",
  "'전체 기간'·'지금까지'·'다 뽑아줘' 는 오늘로부터 1년 전까지로 본다(그 이상은 어차피 잘린다).",
  "title 은 사용자가 쓴 말을 살린다.",
].join("\n");

const SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: [...REPORT_KINDS] },
    from: { type: "string", description: "시작일 YYYY-MM-DD (KST)" },
    to: { type: "string", description: "종료일 YYYY-MM-DD (KST · 포함)" },
    compareToPrevious: { type: "boolean" },
    title: { type: "string", description: "보고서 제목 — 사용자가 쓴 말을 살린다" },
  },
  required: ["kind", "from", "to"],
};

/**
 * 요청문 → 스펙. 실패하면 던지지 않고 기본 스펙을 돌려준다(위 주석 참고).
 * `now` 를 받는 이유는 테스트 때문만이 아니다 — "이번 달" 의 뜻이 호출 시각에 달려 있어서,
 * 그 시각을 인자로 드러내야 나중에 같은 리포트를 재현할 수 있다.
 */
export async function parseSpec(request: string, now: Date = new Date()): Promise<ReportSpec> {
  try {
    const out = await geminiChat(
      // 바뀌는 것(오늘 날짜·요청문)은 **맨 뒤**에. 고정 지시는 systemInstruction 으로 —
      // 앞부분이 매번 같아야 프롬프트 캐시가 걸린다(chatbot/agent.ts SYSTEM 주석).
      [{ role: "user", parts: [{ text: `오늘: ${kstDayKey(now)} (KST)\n요청: ${request}` }] }],
      { system: SPEC_RULES, model: SUPPORT, location: SUPPORT_LOCATION, schema: SCHEMA, temperature: 0, maxOutputTokens: 512 },
    );
    return normalizeSpec(parseJsonLoose(out.text), now);
  } catch (e) {
    console.warn("[report] 리포트 스펙 해석 실패 — 기본 스펙으로 진행:", e);
    return normalizeSpec({ title: request }, now);
  }
}
