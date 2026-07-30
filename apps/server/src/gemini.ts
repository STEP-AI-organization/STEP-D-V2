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
}

export interface GeminiResult {
  /** Raw model text (JSON string when a schema was used). */
  text: string;
  /** Grounding source URIs/titles when the googleSearch tool was used. */
  sources: string[];
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
  return { text, sources };
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
