/**
 * 워크스페이스 도우미 — 한 턴을 조립하고, 도구를 돌리고, 답을 검사한다.
 *
 * ## 이 파일이 정하는 것
 *
 *  - **무엇을 보여 줄 것인가**: 화면 목록 + 지금 워크스페이스 현황 + 도움말 문서 세 편.
 *    전부가 아니라 셋인 이유는 원가가 대화 길이에 비례하기 때문이다(help.ts 주석).
 *  - **몇 번까지 도구를 부를 것인가**: 두 번. 모델이 도구를 계속 부르며 도는 것을 막는다.
 *  - **답을 그대로 내보낼 것인가**: 아니다. 링크는 화이트리스트를 통과해야 한다(catalog.ts).
 *
 * ## 하지 않는 것
 *
 * 실행하지 않는다. 분석 재시도·배포 재시도는 크레딧이 실제로 나가는 일이라 사람이 누른다.
 * 도우미는 **어느 화면의 무엇을 누르면 되는지**까지만 말한다.
 */
import { geminiChat, type ChatTurn } from "../ai/gemini.ts";
import { SUPPORT, SUPPORT_LOCATION } from "../ai/models.ts";
import type { Role } from "../auth/auth.ts";
import { sanitizeLinks, screenCatalogText, type AnswerLink } from "./catalog.ts";
import { docText, selectDocs } from "./help.ts";
import { loadSnapshot, snapshotText } from "./snapshot.ts";
import { READ_TOOL_DECLARATIONS, lookupMedia, recentFailures } from "./tools.ts";
import { buildReport } from "../report/index.ts";
import {
  CONTEXT_MESSAGES, MAX_THREAD_MESSAGES, SUMMARIZE_EVERY, appendMessage, countMessages, countUserMessagesSince,
  createThread, getThread, recentMessages, setSummary, type Actor,
} from "./store.ts";

/** 질문 길이 상한. 이보다 길면 붙여넣기지 질문이 아니다. */
export const MAX_MESSAGE_CHARS = 2_000;
/** 남용 방어 — 분당·일당 질문 수. 사람이 손으로 치는 속도를 훨씬 넘는 값이다. */
export const RATE_PER_MINUTE = 10;
export const RATE_PER_DAY = 200;
/** 도구 호출 왕복 상한. */
const MAX_TOOL_ROUNDS = 2;

export class ChatbotError extends Error {
  constructor(readonly code: "too_long" | "rate_limited" | "thread_not_found" | "thread_full", message: string) {
    super(message);
  }
}

export interface AskInput {
  user: { id: string; tenantId: string; role: Role };
  threadId?: string | null;
  message: string;
  /** 사용자가 보고 있는 화면 경로. 있으면 그 화면 문서를 우선 싣는다. */
  screen?: string | null;
}

export interface AskResult {
  threadId: string;
  reply: string;
  links: AnswerLink[];
  usedDocs: string[];
  /** 이 턴에 실제로 부른 도구 이름. 평가셋 채점이 "도구를 옳게 골랐나" 를 이걸로 본다. */
  toolsUsed: string[];
  /**
   * 이 턴에 리포트를 만들었으면 그 결과. 링크가 아니라 **내용**으로 돌려준다 —
   * 아직 리포트 화면이 없어서, 없는 경로를 링크로 주면 그게 곧 거짓말이 된다.
   *
   * `headline` 을 따로 주는 이유: 위젯은 380px 라 표가 안 읽힌다(실측 2026-09-03 — 마크다운
   * 원문을 그대로 띄우니 `<sub>` 태그와 파이프 표가 그대로 보였다). 위젯은 핵심 수치만
   * 그리고, 전문은 HTML 내보내기로 넘긴다.
   */
  report?: {
    id: string; title: string; period: string; markdown: string; warnings: string[];
    headline: { label: string; value: number; unit: string; delta?: number }[];
  };
}

const REPORT_TOOL = {
  name: "make_report",
  description:
    "운영·성과 보고서 초안을 만든다. 사용자가 '보고서', '리포트', '월간 정리', '실적 정리' 를 " +
    "요청할 때 쓴다. 요청 문장을 그대로 넘기면 종류와 기간은 알아서 정해진다.",
  parameters: {
    type: "object",
    properties: {
      request: { type: "string", description: "사용자의 요청 문장 그대로. 예: '8월 채널 성과 보고서'" },
    },
    required: ["request"],
  },
} as const;

/**
 * **모든 요청에 글자 하나까지 똑같이 나가는** 시스템 지시.
 *
 * ## 왜 고정인가 — 프롬프트 캐싱
 *
 * Gemini 는 요청의 **앞부분(prefix)이 이전 요청과 같으면** 그 부분을 캐시에서 읽는다(암시적
 * 캐싱 · 그 토큰은 대폭 싸진다). 캐시는 접두사 단위라, 앞쪽에 **자주 바뀌는 값이 하나라도
 * 있으면 그 뒤 전부가 매번 새 값**이 된다.
 *
 * 그래서 순서를 이렇게 잡는다:
 *
 *   systemInstruction : 규칙 + 화면 목록   ← 고정. 모든 사용자·모든 턴이 공유한다
 *   contents[0..n-1]  : 지난 대화           ← 스레드 안에서 고정(턴이 쌓여도 앞부분은 그대로)
 *   contents[n]       : 현황 + 도움말 + 질문 ← 매번 바뀌는 것은 전부 **맨 뒤**
 *
 * 예전에는 현황(크레딧 잔액!)과 도움말을 시스템 지시에 넣었다. 그러면 **크레딧이 1 줄
 * 때마다** 캐시가 통째로 깨진다 — 캐시가 가장 잘 들을 자리(고정된 화면 목록)를 변동값이
 * 무효화하는 구조였다.
 *
 * ⚠️ **여기에 워크스페이스 값을 절대 넣지 마라.** 이 문자열은 회사를 가로질러 공유되는
 *    캐시 접두사가 된다. 고객 데이터가 들어가는 순간 그건 캐시가 아니라 유출 경로다
 *    (`chatbot-prompt.test.ts` 가 이 파일을 스캔해 그걸 막는다).
 */
export const SYSTEM = [
  "당신은 이 영상 스튜디오 제품의 사용을 돕는 안내 도우미다. 사용자는 방송사·제작사의 실무자다.",
  "",
  "## 지키는 것",
  "1. **주어진 도움말과 현황에 있는 것만 말한다.** 모르면 모른다고 하고, 확인할 수 있는 화면을",
  "   알려 준다. 그럴듯하게 지어내지 마라 — 틀린 안내는 안 하느니만 못하다.",
  "2. **링크는 아래 화면 목록의 경로만 쓴다.** 목록에 없는 경로를 만들지 마라.",
  "   **화면 이름을 말하면 반드시 그 자리에 마크다운 링크를 건다.** '자동 배포 화면에서' 처럼",
  "   이름만 쓰지 마라 — [자동 배포](/automation) 로 쓴다. 사용자는 눌러서 가려고 묻는 것이다.",
  "   **화면 목록을 나열하지 마라.** 답을 모르더라도 가장 관련 있는 화면 한두 개만 짚는다.",
  "3. **당신은 아무것도 실행할 수 없다.** 분석·배포를 대신 돌려 주지 마라(그럴 수단이 없다).",
  "   어느 화면에서 무엇을 누르면 되는지까지 말한다.",
  "4. 우리 회사의 내부 구현(서버·모델·인프라)이나 원가·마진에는 답하지 않는다.",
  "   **다만 이 워크스페이스의 크레딧 잔액·사용량·요금 안내는 답한다** — 사용자 자신의 정보다.",
  "5. 짧게 쓴다. 3~6문장 또는 짧은 단계 목록. 존댓말.",
  "6. 사용자가 보고서·리포트·실적 정리를 요청하면 make_report 도구를 쓴다. 직접 숫자를 세지 마라.",
  "7. **현황은 질문이 그것을 물을 때만 쓴다.** 사용법을 물었는데 잔액·실패 건수를 끌어와",
  "   답을 바꾸지 마라. 바로 앞 대화에 이어지는 질문이면 그 맥락을 먼저 본다.",
  "",
  "## 제품 한눈에",
  "긴 방송 영상을 올리면 AI 가 볼 만한 구간을 찾아 짧은 영상으로 만들고, 채널에 올린다.",
  "① 프로그램 만들기(출연진 미리 등록) → ② 회차 원본 올리기 → ③ AI 분석 → ④ 추천 구간 채택",
  "→ ⑤ 편집(자막·제목·템플릿) → ⑥ 채널 배포 → ⑦ 성과 확인.",
  "②~⑥ 을 사람 없이 도는 것이 '자동 배포' 다.",
  "산출물은 둘이다 — **숏폼**(40~90초·세로·쇼츠/릴스/틱톡)과 **클립**(3~15분·가로·유튜브 일반).",
  "분석은 크레딧을 쓴다(1개 = 원본 1분). 잔액이 모자라면 분석이 **시작조차 안 하고** 보류된다 —",
  "'왜 안 돌아가나' 계열 질문의 첫 번째 확인 지점이다.",
  "",
  "## 답변 예시",
  "질문: 자동배포는 어디서 켜요?",
  "답: [자동 배포](/automation) 화면에서 계획을 만들면 됩니다. 프로그램·채널·요일·시각을 정하고",
  "저장하면 그때부터 돕니다. 처음이라면 승인 방식을 '승인 후 게시' 로 두고 며칠 지켜보세요.",
  "",
  "질문: 영상 올렸는데 분석이 안 시작해요.",
  "답: [영상 분석](/analyze) 화면에서 그 회차의 상태를 봐 주세요. 「분석 보류」라면 사유가 함께",
  "적혀 있고, 가장 흔한 사유는 크레딧 부족입니다. [크레딧](/credits) 에서 충전한 뒤",
  "「다시 시도」를 눌러야 시작됩니다 — 저절로 시작되지는 않습니다.",
  "",
  "질문: 영상 한 편 만드는 데 원가가 얼마예요?",
  "답: 죄송하지만 그건 안내해 드릴 수 없습니다. 대신 이 워크스페이스가 쓴 크레딧은",
  "[크레딧](/credits) 화면에서 확인하실 수 있습니다.",
  "(← 거절할 때도 갈 곳이 있으면 반드시 링크로 준다.)",
  "",
  "## 화면 목록",
  screenCatalogText(),
].join("\n");

/**
 * 매 턴 바뀌는 것 — **질문과 함께 맨 뒤에** 붙는다(위 SYSTEM 주석의 순서).
 *
 * ## 안쪽 순서도 정해져 있다: 도움말 → 현황 → 요약 → 질문
 *
 * 실측(2026-09-03)에서 현황을 맨 앞에 뒀더니, 잔액이 0 인 상태에서 **"자동배포 어디서
 * 켜요?" 에 크레딧 이야기로 답했다.** 작은 모델은 앞에 온 것을 주제로 잡는다. 규칙 문장을
 * 더 넣어도 안 잡혔고, **순서를 바꾸니 잡혔다** — 지시보다 배치가 세다.
 *
 * 그래서 도움말이 먼저 오고, 현황은 "묻거든 쓰라" 는 딱지를 달고 뒤에 온다.
 */
export function turnContext(snapshot: string, docs: string, summary: string | null, question: string): string {
  return [
    "## 도움말",
    docs || "(관련 문서를 찾지 못했다. 사용법을 아는 척하지 말고, 관련 화면을 알려 준 뒤 담당자 문의를 권할 것.)",
    "",
    "## 참고 — 지금 이 워크스페이스",
    "(아래는 배경 정보다. **질문이 이 값을 묻지 않으면 인용하지 마라.**)",
    snapshot,
    ...(summary ? ["", "## 앞선 대화 요약", summary] : []),
    "",
    "## 질문",
    question,
  ].join("\n");
}

/** 도구 실행. 모르는 이름은 조용히 빈 결과 — 모델이 이름을 잘못 부르는 일은 있다. */
async function runTool(
  name: string, args: Record<string, unknown>, user: Actor, threadId: string,
): Promise<{ response: Record<string, unknown>; report?: AskResult["report"] }> {
  if (name === "lookup_media") {
    return { response: { results: await lookupMedia(String(args.query ?? "")) } };
  }
  if (name === "recent_failures") {
    const kind = ["all", "job", "distribution"].includes(String(args.kind)) ? (String(args.kind) as any) : "all";
    return { response: { results: await recentFailures(kind) } };
  }
  if (name === "make_report") {
    const built = await buildReport(user, String(args.request ?? ""), { threadId });
    return {
      // 모델에게는 **본문을 주지 않는다.** 요약해 달라고 시킨 적이 없고, 주면 그 요약이
      // 표와 다른 말을 하게 된다. "만들었다"는 사실과 제목·경고만 준다.
      response: {
        ok: true, title: built.spec.title,
        period: `${built.spec.from} ~ ${built.spec.to}`,
        warnings: built.warnings,
        note: "보고서 본문은 사용자 화면에 그대로 표시된다. 내용을 다시 옮겨 적지 말 것.",
      },
      report: {
        id: built.reportId, title: built.spec.title,
        period: `${built.spec.from} ~ ${built.spec.to}`,
        markdown: built.markdown, warnings: built.warnings,
        headline: built.data.headline.map((m) => ({
          label: m.label, value: m.value, unit: m.unit, ...(m.delta != null ? { delta: m.delta } : {}),
        })),
      },
    };
  }
  return { response: { error: `알 수 없는 도구: ${name}` } };
}

/** 한 턴. 던지는 것은 `ChatbotError` 뿐이고, 나머지 실패는 답변 문구로 바뀐다. */
export async function ask(input: AskInput): Promise<AskResult> {
  const message = String(input.message ?? "").trim();
  if (!message) throw new ChatbotError("too_long", "질문을 입력해 주세요.");
  if (message.length > MAX_MESSAGE_CHARS) {
    throw new ChatbotError("too_long", `질문이 너무 깁니다 (${MAX_MESSAGE_CHARS}자까지).`);
  }

  const user: Actor = { id: input.user.id, tenantId: input.user.tenantId };
  const now = Date.now();
  const [perMinute, perDay] = await Promise.all([
    countUserMessagesSince(user, now - 60_000),
    countUserMessagesSince(user, now - 24 * 60 * 60_000),
  ]);
  if (perMinute >= RATE_PER_MINUTE || perDay >= RATE_PER_DAY) {
    throw new ChatbotError("rate_limited", "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.");
  }

  // 스레드 — 남의 것/없는 것은 똑같이 못 찾은 것으로 다룬다.
  let threadId = input.threadId ?? null;
  let summary: string | null = null;
  if (threadId) {
    const t = await getThread(user, threadId);
    if (!t) throw new ChatbotError("thread_not_found", "대화를 찾을 수 없습니다.");
    summary = t.summary;
    if ((await countMessages(threadId)) >= MAX_THREAD_MESSAGES) {
      throw new ChatbotError("thread_full", "이 대화가 너무 길어졌습니다. 새 대화를 시작해 주세요.");
    }
  } else {
    threadId = await createThread(user, message);
  }

  const [snapshot, history] = await Promise.all([
    loadSnapshot(input.user, input.screen),
    recentMessages(threadId, CONTEXT_MESSAGES),
  ]);
  // 문서 선택에는 **바로 앞 질문도 함께** 넣는다. "그 승인 방식은 왜 권해요?" 처럼 이어지는
  // 물음에는 키워드가 하나도 없어서, 이번 문장만 보면 엉뚱한 문서가 실린다(실측 2026-09-03:
  // 자동배포 대화 도중 크레딧 문서가 실려 답이 통째로 샜다).
  const lastAsked = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  const docs = selectDocs(`${lastAsked} ${message}`.trim(), input.screen);

  // 지난 대화는 **저장된 원문 그대로** 싣는다(현황·도움말을 다시 붙이지 않는다). 그래야
  // 다음 턴의 앞부분이 이번 턴이 보낸 것과 같아져 캐시가 걸린다 — 위 SYSTEM 주석의 순서.
  const turns: ChatTurn[] = [
    ...history.map((m): ChatTurn => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    { role: "user", parts: [{
      text: turnContext(snapshotText(snapshot), docs.map(docText).join("\n\n"), summary, message),
    }] },
  ];

  let reply = "";
  let report: AskResult["report"];
  const toolsUsed: string[] = [];
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    // 마지막 왕복에서는 도구를 빼고 답만 받는다 — 안 그러면 또 부르자고 해서 빈손으로 끝난다.
    const withTools = round < MAX_TOOL_ROUNDS;
    let out;
    try {
      out = await geminiChat(turns, {
        system: SYSTEM,
        model: SUPPORT,
        location: SUPPORT_LOCATION,
        ...(withTools ? { tools: [{ functionDeclarations: [...READ_TOOL_DECLARATIONS, REPORT_TOOL] }] } : {}),
        temperature: 0.3,
        maxOutputTokens: 1200,
      });
    } catch (e) {
      console.warn("[chatbot] 모델 호출 실패:", e);
      reply = "지금은 답변을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.";
      break;
    }

    if (!out.calls.length) { reply = out.text; break; }

    // 모델의 도구 호출과 그 결과를 대화에 그대로 이어 붙인다(Vertex 규약).
    turns.push({ role: "model", parts: out.calls.map((c) => ({ functionCall: { name: c.name, args: c.args } })) });
    for (const c of out.calls) if (!toolsUsed.includes(c.name)) toolsUsed.push(c.name);
    const responses = [];
    for (const call of out.calls) {
      try {
        const r = await runTool(call.name, call.args, user, threadId);
        if (r.report) report = r.report;
        responses.push({ functionResponse: { name: call.name, response: r.response } });
      } catch (e) {
        console.warn(`[chatbot] 도구 ${call.name} 실패:`, e);
        responses.push({ functionResponse: { name: call.name, response: { error: "조회에 실패했습니다." } } });
      }
    }
    turns.push({ role: "user", parts: responses });
  }

  if (!reply) {
    reply = report
      ? "보고서 초안을 만들었습니다. 아래에서 확인해 주세요."
      : "답변을 만들지 못했습니다. 질문을 조금 더 구체적으로 적어 주시겠어요?";
  }

  const clean = sanitizeLinks(reply);
  const usedDocs = docs.map((d) => d.name);

  await appendMessage(user, threadId, { role: "user", content: message });
  await appendMessage(user, threadId, {
    role: "assistant", content: clean.text, links: clean.links, usedDocs,
  });
  void refreshSummary(user, threadId, summary);

  return { threadId, reply: clean.text, links: clean.links, usedDocs, toolsUsed, ...(report ? { report } : {}) };
}

/**
 * 오래된 대화를 한 덩어리로 접는다. **응답을 막지 않는다** — 사용자는 이미 답을 받았고,
 * 요약은 다음 턴을 위한 준비다. 실패해도 다음 기회에 다시 시도된다.
 */
async function refreshSummary(user: Actor, threadId: string, previous: string | null): Promise<void> {
  try {
    const count = await countMessages(threadId);
    if (count <= CONTEXT_MESSAGES || count % SUMMARIZE_EVERY !== 0) return;

    const recent = await recentMessages(threadId, CONTEXT_MESSAGES);
    const text = recent.map((m) => `${m.role === "user" ? "사용자" : "도우미"}: ${m.content}`).join("\n");
    const out = await geminiChat(
      [{ role: "user", parts: [{ text:
        `아래는 지원 대화의 최근 부분이다. ${previous ? "이전 요약과 합쳐 " : ""}5문장 이내로 요약해라. ` +
        "무엇을 물었고 무엇을 안내했는지, 아직 해결되지 않은 것이 무엇인지만 적는다.\n\n" +
        (previous ? `이전 요약:\n${previous}\n\n` : "") + `대화:\n${text}` }] }],
      { model: SUPPORT, location: SUPPORT_LOCATION, temperature: 0.2, maxOutputTokens: 400 },
    );
    if (out.text.trim()) await setSummary(threadId, out.text.trim());
  } catch (e) {
    console.warn("[chatbot] 대화 요약 실패(무시):", e);
  }
}
