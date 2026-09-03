/**
 * Minimal Vertex AI Gemini client for the Node server (interactive endpoints).
 *
 * The core/ python pipeline is the heavy AI path; this is only for small, synchronous
 * server-side calls (e.g. generating a program profile). We hit the Vertex REST
 * `generateContent` endpoint directly with an ADC access token — no heavy SDK. Same
 * project/region as core (GOOGLE_CLOUD_PROJECT / VERTEX_LOCATION), so it stays in-country.
 *
 * Auth: Application Default Credentials. On Cloud Run this is the runtime service account,
 * which MUST hold roles/aiplatform.user for these calls to work (see docs/ops). Locally it's
 * `gcloud auth application-default login`. Any failure surfaces as a thrown error the caller
 * turns into a 4xx/5xx — nothing else in the server depends on this.
 */
import fs from "node:fs";
import { GoogleAuth } from "google-auth-library";
import { TEXT as MODEL } from "./models.ts";

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "step-d";
const LOCATION = process.env.VERTEX_LOCATION || "asia-northeast3";

// GOOGLE_APPLICATION_CREDENTIALS가 존재하지 않는 파일을 가리키면(과거 gcp-keys/ 삭제 등의 흔한
// 로컬 상태) google-auth-library가 ENOENT를 던지고 ADC(gcloud auth application-default)
// 폴백조차 안 한다. 서버 시작 시 한 번 깨끗이 정리해서 gcloud ADC로 폴백하게 한다.
(function clearBrokenCredentialsPath() {
  const p = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!p) return;
  try {
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
      console.warn(
        `[gemini] GOOGLE_APPLICATION_CREDENTIALS points to a missing file (${p}); ` +
        `falling back to gcloud ADC (~/.config/gcloud/application_default_credentials.json).`,
      );
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    }
  } catch {
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }
})();

let _auth: GoogleAuth | null = null;
function auth(): GoogleAuth {
  if (!_auth) _auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
  return _auth;
}

export type GeminiTool = { googleSearch: Record<string, never> };

export interface GeminiJsonOpts {
  /** JSON schema (Vertex `responseSchema`) — omit when using tools (grounding forbids it). */
  schema?: unknown;
  temperature?: number;
  maxOutputTokens?: number;
  /** e.g. [{ googleSearch: {} }] for web-search grounding. */
  tools?: GeminiTool[];
  /** 추론(thinking) 토큰 허용 여부. 기본은 **schema 가 있으면 끔** — 아래 주석 참고.
   *  산문 생성처럼 추론이 결과를 좌우하는 호출만 명시적으로 true 로 켠다. */
  thinking?: boolean;
}

export interface GeminiResult {
  /** Raw model text (JSON string when a schema was used). */
  text: string;
  /** Grounding source URIs/titles when the googleSearch tool was used. */
  sources: string[];
  /** 왜 끝났는지 — 빈 text 의 원인 추적용("MAX_TOKENS"·"SAFETY" 등). 호출부가 로그에 싣는다. */
  finishReason?: string;
}

/**
 * One-shot generateContent. Returns the text plus any grounding sources. Throws on transport
 * / auth / API errors. When `tools` is set we DON'T send responseSchema (Vertex rejects the
 * combination) — the prompt must ask for JSON and the caller parses leniently.
 */
export async function geminiGenerate(prompt: string, opts: GeminiJsonOpts = {}): Promise<GeminiResult> {
  const client = await auth().getClient();
  const token = (await client.getAccessToken()).token;
  if (!token) throw new Error("no ADC access token (Vertex auth failed)");

  const url =
    `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}` +
    `/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;

  const generationConfig: Record<string, unknown> = {
    temperature: opts.temperature ?? 0.3,
    maxOutputTokens: opts.maxOutputTokens ?? 4096,
  };
  if (opts.schema && !opts.tools) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = opts.schema;
  }
  // ⚠️ **Gemini 2.5+ 는 thinking 토큰도 maxOutputTokens 안에서 쓴다.** 그래서 예산이 작으면
  // 추론이 그걸 다 먹고 본문 파트가 **빈 채로** 돌아온다 — 예외도 안 나고 text 가 "" 다.
  // 실제로 제목 재생성(maxOutputTokens 1024)이 이 경로로 늘 빈손이었고, 화면엔 원인을 알 수
  // 없는 "no titles generated" 만 떴다(2026-08-20 사용자 지적).
  // core 는 같은 함정을 이미 겪고 schema JSON 호출의 thinking 을 껐다(beat_annot.py:441
  // "schema JSON 이라 reasoning 불필요"). 서버도 같은 규칙을 쓴다 —
  // **구조화 출력(schema)이면 기본 끔**, 산문 생성은 종전대로 둔다(thinking: true 로 복귀).
  const thinkingOn = opts.thinking ?? !(opts.schema && !opts.tools);
  if (!thinkingOn) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig,
  };
  if (opts.tools?.length) body.tools = opts.tools;

  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Vertex generateContent ${resp.status}: ${detail.slice(0, 300)}`);
  }
  const data = (await resp.json()) as any;
  const cand = data?.candidates?.[0];
  const text: string = (cand?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("").trim();

  const sources: string[] = [];
  for (const g of cand?.groundingMetadata?.groundingChunks ?? []) {
    const w = g?.web;
    const s = (w?.title || w?.uri || "").trim();
    if (s && !sources.includes(s)) sources.push(s);
  }
  // 빈 본문은 조용히 넘기면 호출부가 "모델이 안 만들었다" 로 오해한다 — 실제로는 예산 소진
  // (MAX_TOKENS)·안전차단(SAFETY)인 경우가 많다. 이유를 같이 올려 로그에서 바로 갈리게 한다.
  const finishReason = typeof cand?.finishReason === "string" ? cand.finishReason : undefined;
  if (!text && finishReason) {
    console.warn(`[gemini] 빈 응답 — finishReason=${finishReason} · thoughts=${data?.usageMetadata?.thoughtsTokenCount ?? "?"}`);
  }
  return { text, sources, finishReason };
}

// ── 멀티턴 + 함수호출 (워크스페이스 도우미) ──────────────────────────────────────
//
// 위 `geminiGenerate` 는 **프롬프트 문자열 하나짜리** 라 대화를 이어갈 수도, 도구를 부를
// 수도 없다. 도우미는 둘 다 필요해서 형제 함수를 하나 더 둔다 — 인증·URL 조립·에러 처리는
// 같은 것을 쓰고, 다른 것은 요청 본문뿐이다. (위 함수는 손대지 않는다: 부르는 곳이
// 프로그램 프로필·제목 생성 등 여럿이고, 그쪽은 지금 형태로 충분하다.)

export type ChatPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

export interface ChatTurn {
  /** Vertex 규약: 모델의 발화는 `"model"` 이다(`"assistant"` 가 아니다). */
  role: "user" | "model";
  parts: ChatPart[];
}

export interface GeminiFunctionTool {
  functionDeclarations: unknown[];
}

export interface GeminiChatOpts {
  /** 시스템 지시. 매 턴 같은 내용이라 대화 이력에 섞지 않고 여기로 준다. */
  system?: string;
  tools?: GeminiFunctionTool[];
  /** 모델·리전 오버라이드. **둘은 세트다**(models.ts SUPPORT 주석 참고). */
  model?: string;
  location?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** 기본 끔. 대화형 응답은 속도가 곧 품질이고, 추론 토큰은 예산만 먹는다. */
  thinking?: boolean;
  /** 구조화 출력. tools 와 함께 쓸 수 없다(Vertex 가 거부한다). */
  schema?: unknown;
}

export interface GeminiChatResult {
  text: string;
  /** 모델이 부르자고 한 도구들. 비어 있으면 그냥 답한 것이다. */
  calls: { name: string; args: Record<string, unknown> }[];
  finishReason?: string;
  /** 원가를 실측으로 말할 수 있게 그대로 올린다 — 추정으로 적지 않기 위해. */
  usage?: { input: number; output: number };
}

/**
 * Vertex 호스트. **`global` 은 리전 접두사가 없다** — `global-aiplatform.googleapis.com`
 * 이라는 호스트는 존재하지 않아서, 접두사를 붙이면 DNS 단계에서 죽는다.
 */
function vertexHost(location: string): string {
  return location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
}

/**
 * 멀티턴 한 번. **루프를 돌지 않는다** — 도구를 부르자고 하면 그 사실만 돌려주고,
 * 실제로 부르고 다시 물어보는 것은 호출부(support/agent.ts)가 한다. 여기서 루프를 돌면
 * "몇 번까지 도는가" 라는 정책이 클라이언트 안에 숨는다.
 */
export async function geminiChat(turns: ChatTurn[], opts: GeminiChatOpts = {}): Promise<GeminiChatResult> {
  const client = await auth().getClient();
  const token = (await client.getAccessToken()).token;
  if (!token) throw new Error("no ADC access token (Vertex auth failed)");

  const model = opts.model || MODEL;
  const location = opts.location || LOCATION;
  const url =
    `https://${vertexHost(location)}/v1/projects/${PROJECT}` +
    `/locations/${location}/publishers/google/models/${model}:generateContent`;

  const generationConfig: Record<string, unknown> = {
    temperature: opts.temperature ?? 0.2,
    maxOutputTokens: opts.maxOutputTokens ?? 2048,
  };
  if (opts.schema && !opts.tools?.length) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = opts.schema;
  }
  // 기본 끔 — 위 geminiGenerate 주석의 함정(추론이 예산을 다 먹고 본문이 빈 채 온다)이
  // 대화에서는 더 자주 터진다. 예산이 2048 로 작기 때문이다.
  if (!(opts.thinking ?? false)) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const body: Record<string, unknown> = { contents: turns, generationConfig };
  if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };
  if (opts.tools?.length) body.tools = opts.tools;

  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Vertex generateContent(${model}@${location}) ${resp.status}: ${detail.slice(0, 300)}`);
  }

  const data = (await resp.json()) as any;
  const cand = data?.candidates?.[0];
  const parts: any[] = cand?.content?.parts ?? [];
  const text = parts.map((p) => p?.text ?? "").join("").trim();
  const calls = parts
    .filter((p) => p?.functionCall?.name)
    .map((p) => ({ name: String(p.functionCall.name), args: (p.functionCall.args ?? {}) as Record<string, unknown> }));

  const usage = data?.usageMetadata
    ? {
        input: Number(data.usageMetadata.promptTokenCount ?? 0),
        output: Number(data.usageMetadata.candidatesTokenCount ?? 0),
      }
    : undefined;

  const finishReason = typeof cand?.finishReason === "string" ? cand.finishReason : undefined;
  if (!text && !calls.length && finishReason) {
    console.warn(`[gemini] 도우미 빈 응답 — finishReason=${finishReason} · model=${model}@${location}`);
  }
  return { text, calls, finishReason, usage };
}

/** Parse a JSON object out of model text (handles ```json fences / leading prose). */
export function parseJsonLoose(text: string): unknown {
  const t = (text || "").trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through to brace extraction */
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      /* give up */
    }
  }
  return {};
}
