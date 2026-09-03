/**
 * 리포트 서술 — 집계 결과를 **문장으로** 옮긴다. 그리고 그 문장을 믿지 않는다.
 *
 * ## 두 가지를 막는다
 *
 * 1. **지어낸 숫자.** 모델은 표를 보고 요약하다가 없는 수를 만든다("전월 대비 약 20%" 같은
 *    반올림, 합계 오산). 보고서에서 그건 오타가 아니라 **틀린 보고**다 — 그대로 윗선에 간다.
 *    그래서 본문의 모든 숫자를 집계 결과와 대조하고, 없는 수가 있으면 한 번 다시 쓰게 하고,
 *    그래도 남으면 **서술을 버린다**(표만 내보낸다). 서술이 없는 보고서는 아쉬울 뿐이지만,
 *    틀린 숫자가 든 보고서는 위험하다.
 *
 * 2. **평가 문장.** "성과가 좋았다"는 사실이 아니라 판단이고, 판단은 사용자 몫이다
 *    (사용자 결정 2026-09-03 · 사실·비교치만). 금칙어가 걸리면 다시 쓰게 한다.
 *
 * ## 왜 순수 함수로 뽑아 뒀나
 *
 * `collectAllowedNumbers`·`fabricatedNumbers`·`evaluativeWords` 는 모델 없이 테스트된다.
 * 이 방어선이 진짜로 도는지는 **LLM 을 부르지 않고** 확인할 수 있어야 한다.
 */
import { geminiChat } from "../ai/gemini.ts";
import { SUPPORT, SUPPORT_LOCATION } from "../ai/models.ts";
import type { ReportData } from "./aggregate.ts";

/**
 * 판단으로 읽히는 말. **자동 배포·성과 같은 제품 용어는 넣지 않는다** — "성과" 자체는
 * 화면 이름이라 금칙어로 두면 정상 문장이 걸린다. 걸러야 하는 건 값매김이다.
 */
export const EVALUATIVE_WORDS = [
  "좋았", "좋은 성과", "우수", "성공적", "훌륭", "탁월", "만족스러", "긍정적",
  "부진", "저조", "실망", "아쉬운 성과", "개선됐", "개선되었", "악화",
  "인상적", "고무적", "기대 이상", "기대 이하",
];

/** 반올림 오차 허용. 소수 첫째 자리까지 같으면 같은 수로 본다. */
const EPS = 0.05;

function pushNumber(set: Set<number>, n: unknown): void {
  const v = typeof n === "number" ? n : Number(n);
  if (Number.isFinite(v)) set.add(Math.abs(v));
}

/**
 * 본문에 나와도 되는 숫자의 집합.
 *
 * 원값만 허용하면 "전월 대비 18% 늘었다" 처럼 **정당한 파생값**이 전부 걸린다. 그래서
 * 파생도 우리가 미리 계산해 넣는다 — 모델이 계산하게 두는 게 아니라, **우리가 계산한
 * 것과 같을 때만** 통과시키는 것이다.
 */
export function collectAllowedNumbers(data: ReportData): Set<number> {
  const out = new Set<number>();
  // 0·100 은 비율 문장의 바탕이라 늘 허용한다.
  out.add(0); out.add(100);

  const totals: number[] = [];

  for (const m of data.headline) {
    pushNumber(out, m.value);
    if (m.delta != null) {
      pushNumber(out, m.delta);
      const base = m.value - m.delta;
      if (base !== 0) pushNumber(out, Math.round((m.delta / base) * 1000) / 10);
    }
    totals.push(Number(m.value));
  }

  for (const s of data.sections) {
    pushNumber(out, s.rows.length);
    for (const row of [...s.rows, ...(s.total ? [s.total] : [])]) {
      for (const cell of row) if (typeof cell === "number") { pushNumber(out, cell); totals.push(cell); }
    }
    if (s.total) for (const cell of s.total) if (typeof cell === "number") totals.push(cell);
  }

  // 기간 문자열의 숫자(연·월·일)는 사실이다.
  for (const day of [data.period.from, data.period.to, data.period.compare?.from, data.period.compare?.to]) {
    for (const part of String(day ?? "").split("-")) pushNumber(out, Number(part));
  }

  // 비중(%) — 어떤 값이 어떤 합계에서 차지하는 몫. 두 집합이 작아 곱해도 부담이 없다.
  const values = [...out];
  const bases = [...new Set(totals.filter((t) => t !== 0))];
  for (const v of values) {
    for (const b of bases) {
      const pct = Math.round((v / Math.abs(b)) * 1000) / 10;
      if (Number.isFinite(pct) && pct >= 0 && pct <= 100) out.add(pct);
    }
  }
  return out;
}

/** 본문에서 숫자를 뽑는다. 천 단위 콤마는 떼고, 퍼센트는 그 수 자체로 본다. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
    const v = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(v)) out.push(Math.abs(v));
  }
  return out;
}

/** 집계에 없는 숫자들. 비어 있어야 통과다. */
export function fabricatedNumbers(text: string, allowed: Set<number>): number[] {
  const bad: number[] = [];
  for (const n of numbersIn(text)) {
    let ok = false;
    for (const a of allowed) {
      if (Math.abs(a - n) <= EPS) { ok = true; break; }
    }
    if (!ok && !bad.includes(n)) bad.push(n);
  }
  return bad;
}

export function evaluativeWords(text: string): string[] {
  return EVALUATIVE_WORDS.filter((w) => text.includes(w));
}

/** 모델에게 주는 집계 요약. 표를 통째로 주지 않는다 — 상위 몇 줄이면 문장을 쓰기에 충분하다. */
function factsFor(data: ReportData): string {
  const lines: string[] = [
    `제목: ${data.title}`,
    `기간: ${data.period.from} ~ ${data.period.to}` +
      (data.period.compare ? ` (비교 기간: ${data.period.compare.from} ~ ${data.period.compare.to})` : ""),
    "핵심 수치:",
    ...data.headline.map((m) =>
      `  - ${m.label}: ${m.value}${m.unit}` +
      (m.delta != null ? ` (직전 기간 대비 ${m.delta >= 0 ? "+" : ""}${m.delta}${m.unit})` : "") +
      (m.note ? ` · ${m.note}` : "")),
  ];
  for (const s of data.sections) {
    lines.push(`표 「${s.title}」 (${s.columns.join(" · ")}):`);
    for (const row of s.rows.slice(0, 8)) lines.push(`  - ${row.join(" · ")}`);
    if (s.rows.length > 8) lines.push(`  - …외 ${s.rows.length - 8}행`);
    if (s.total) lines.push(`  - 합계: ${s.total.join(" · ")}`);
  }
  return lines.join("\n");
}

/**
 * 고정 지시. **systemInstruction 으로 보낸다** — 모든 요청에 글자 그대로 같아야 프롬프트
 * 캐시가 걸린다(chatbot/agent.ts SYSTEM 주석). 집계 결과는 매번 다르므로 맨 뒤로 간다.
 * 여기에 워크스페이스 값을 넣지 마라 — 회사를 가로질러 공유되는 접두사다.
 */
const RULES =
  "너는 운영·성과 보고서의 요약 문단을 쓴다. 사용자가 준 집계 결과만 보고 쓴다.\n\n" +
  "규칙:\n" +
  "1. **주어진 수치에 없는 숫자를 절대 쓰지 마라.** 직접 계산하지도 마라. 필요한 비교치는 이미 들어 있다.\n" +
  "2. 평가하지 마라. '좋다·우수하다·성공적이다·부진하다' 같은 말을 쓰지 마라. " +
  "사실과 비교치만 적는다. 판단은 이 보고서를 읽는 사람이 한다.\n" +
  "3. 3~5문장. 표를 반복해 읽지 말고, 무엇이 얼마였고 직전 기간과 어떻게 달랐는지만 적는다.\n" +
  "4. 마크다운 표·제목을 만들지 마라. 문단만 쓴다.";

export interface Narration {
  text: string;
  warnings: string[];
}

/**
 * 서술 한 편. 실패해도 **던지지 않는다** — 서술은 보고서의 부속이고, 없으면 표만 나가면 된다.
 * 무슨 일이 있었는지는 `warnings` 로 올라가 화면이 "초안 확인 필요" 를 띄운다.
 */
export async function narrate(data: ReportData): Promise<Narration> {
  if (data.empty) {
    return {
      text: `${data.period.from}부터 ${data.period.to}까지 집계된 기록이 없습니다.`,
      warnings: [],
    };
  }

  const allowed = collectAllowedNumbers(data);
  const facts = factsFor(data);
  const warnings: string[] = [];
  let last = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    const extra = attempt === 0 ? "" :
      "\n\n(앞선 답에 위에 없는 숫자나 평가 문장이 있었다. 위 수치만 그대로 인용해 다시 써라.)";
    let text = "";
    try {
      const out = await geminiChat(
        [{ role: "user", parts: [{ text: `${facts}${extra}` }] }],
        { system: RULES, model: SUPPORT, location: SUPPORT_LOCATION, temperature: 0.2, maxOutputTokens: 700 },
      );
      text = out.text.trim();
    } catch (e) {
      warnings.push(`서술 생성에 실패했습니다 (${String(e).slice(0, 120)}). 표만 내보냅니다.`);
      return { text: "", warnings };
    }
    if (!text) continue;
    last = text;

    const bad = fabricatedNumbers(text, allowed);
    const evals = evaluativeWords(text);
    if (!bad.length && !evals.length) return { text, warnings };

    if (attempt === 1) {
      // 두 번 시도해도 안 되면 **버린다.** 여기서 통과시키면 방어선이 없는 것과 같다.
      if (bad.length) warnings.push(`집계에 없는 숫자(${bad.slice(0, 5).join(", ")})가 있어 서술을 뺐습니다.`);
      if (evals.length) warnings.push(`평가 문장(${evals.slice(0, 3).join(", ")})이 있어 서술을 뺐습니다.`);
      return { text: "", warnings };
    }
  }

  if (!last) warnings.push("서술이 비어 있어 표만 내보냅니다.");
  return { text: "", warnings };
}
