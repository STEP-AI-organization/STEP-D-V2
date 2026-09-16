/**
 * OpenAI 텍스트 생성 — 메타데이터 실험용 (2026-09-16 · GPT-5.6 Luna).
 *
 * Gemini 2.5 은퇴(flash-lite 2027-01-28 종료) 대비 + 단가 실험($0.20/$1.20 — 2.5-flash 대비
 * 출력 절반 이하). gemini.ts 와 같은 성격의 자리다 — 작은 동기 서버 호출 전용이고, 무거운
 * AI 는 core/ 파이썬이 한다. SDK 를 넣지 않고 REST 를 직접 친다(gemini.ts 와 같은 이유 —
 * 호출이 한 모양뿐인데 의존성을 늘릴 게 없다).
 *
 * 게이트: `OPENAI_METADATA_MODEL` + `OPENAI_API_KEY` **둘 다** 있어야 켜진다.
 * 미설정·오타·빈값 = OFF(Gemini 그대로) — upload-gate.ts 와 같은 실패 방향이다.
 */

export interface OpenAIGenOpts {
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface OpenAIGenResult {
  /** Raw model text (프롬프트가 JSON 을 시켰으면 JSON 문자열 — 파싱은 호출부가 parseJsonLoose 로). */
  text: string;
  /** 빈 text 의 원인 추적용("length"·"content_filter" 등) — gemini.ts finishReason 과 같은 역할. */
  finishReason?: string;
}

/**
 * 메타데이터 생성을 Luna 로 돌릴 것인가. 켜져 있으면 모델명, 아니면 null(= Gemini 유지).
 * 모델명만 있고 키가 없는 반쪽 설정도 null — 라우트가 죽는 것보다 Gemini 로 도는 게 낫고,
 * 어느 쪽으로 돌았는지는 라우트 로그가 남긴다.
 */
export function openaiMetadataModel(): string | null {
  const model = (process.env.OPENAI_METADATA_MODEL || "").trim();
  if (!model) return null;
  if (!(process.env.OPENAI_API_KEY || "").trim()) {
    console.warn(`[openai] OPENAI_METADATA_MODEL=${model} 인데 OPENAI_API_KEY 가 없다 — Gemini 폴백`);
    return null;
  }
  return model;
}

/**
 * One-shot chat.completions. geminiGenerate 와 같은 계약 — text 를 돌려주고, 전송·API 오류는
 * 던진다(호출부가 4xx/5xx 로 바꾼다). response_format 은 걸지 않는다 — 메타 프롬프트는
 * schema 없이 JSON 을 프롬프트로 시키는 AENA 결론(잘림 부분 복구)을 그대로 따른다.
 */
export async function openaiGenerate(prompt: string, opts: OpenAIGenOpts): Promise<OpenAIGenResult> {
  const key = (process.env.OPENAI_API_KEY || "").trim();
  if (!key) throw new Error("OPENAI_API_KEY 없음 (openaiMetadataModel 게이트를 거치지 않고 불렸다)");

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      messages: [{ role: "user", content: prompt }],
      temperature: opts.temperature ?? 0.3,
      // 구 이름 max_tokens 는 최신 모델이 거부한다 — max_completion_tokens 로.
      max_completion_tokens: opts.maxOutputTokens ?? 2048,
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`OpenAI chat.completions ${resp.status}: ${detail.slice(0, 300)}`);
  }
  const data = (await resp.json()) as any;
  const choice = data?.choices?.[0];
  const text = String(choice?.message?.content ?? "").trim();
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined;
  // gemini.ts 와 같은 원칙 — 빈 본문을 조용히 넘기면 "모델이 안 만들었다" 로 오해한다.
  if (!text && finishReason) console.warn(`[openai] 빈 응답 — finish_reason=${finishReason}`);
  return { text, finishReason };
}
