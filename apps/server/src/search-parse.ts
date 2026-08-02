/**
 * 자연어 쿼리 파서 — "그 프로 작년쯤 OO 나온 편" 같은 실무자 쿼리를 구조 필터로 쪼갠다.
 *
 * 설계 §4: 방송사 실무자 쿼리는 semantic보다 **필터**다. 프로그램·회차·방영일·출연자
 * 필터가 검색 품질의 대부분을 결정한다 — 그래서 쿼리 파서가 사실상 핵심이다.
 *
 * 검색은 동기 쿼리라 워커 파이썬을 스폰하지 않고 Vertex Gemini(gemini-2.5-flash)를 직접
 * 부른다(search-embed와 같은 ADC 규약). 실패하면 룰 폴백 — 로스터 인물명 매칭 + 장면유형
 * 키워드 + 쇼츠 힌트만. 날짜(작년/지난달) 해석은 LLM만 한다. core/search.py의 parse_query가
 * 같은 로직의 파이썬 참조 구현.
 */
import { GoogleAuth } from "google-auth-library";

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "step-d";
const LOCATION = process.env.VERTEX_LOCATION || "asia-northeast3";
const MODEL = process.env.QUERY_PARSE_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash";

let auth: GoogleAuth | undefined;
function getAuth(): GoogleAuth {
  auth ??= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  return auth;
}
let warned = false;

export interface ParsedQuery {
  characters: string[];
  sceneType?: string;   // "interview" | "on_scene"
  isShort?: boolean;
  airedFrom?: string;   // YYYY-MM-DD
  airedTo?: string;
  semantic: string;     // 구조 신호를 걷어낸 나머지 의미쿼리
}

const SCENE_KW: Record<string, string> = {
  "인터뷰": "interview", "인터뷰컷": "interview", "인뷰": "interview",
  "현장": "on_scene", "현장컷": "on_scene",
};

/** 룰 폴백 — roster 인물명 부분일치 + 장면유형 키워드 + 쇼츠 힌트. 날짜는 안 건드림. */
export function parseQueryRules(q: string, roster: string[] = []): ParsedQuery {
  const characters = roster.filter((name) => name && q.includes(name));
  let sceneType: string | undefined;
  for (const [kw, label] of Object.entries(SCENE_KW)) {
    if (q.includes(kw)) { sceneType = label; break; }
  }
  const low = q.toLowerCase();
  const isShort = ["쇼츠", "숏폼", "터진", "하이라이트"].some((w) => low.includes(w)) ? true : undefined;

  let semantic = q;
  for (const token of [...characters, ...Object.keys(SCENE_KW)]) semantic = semantic.split(token).join(" ");
  semantic = semantic.replace(/\s+/g, " ").trim();

  return { characters, sceneType, isShort, semantic };
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    characters: { type: "array", items: { type: "string" } },
    sceneType: { type: "string" },
    isShort: { type: "boolean" },
    airedFrom: { type: "string" },
    airedTo: { type: "string" },
    semantic: { type: "string" },
  },
  required: ["semantic"],
};

function buildPrompt(q: string, roster: string[], today: string): string {
  return [
    "방송 클립 검색 쿼리를 구조 필터로 분해한다. 아래 JSON 스키마로만 답하라.",
    `오늘 날짜: ${today}`,
    roster.length ? `등장 인물 후보(이 목록 안에서만 characters 채우기): ${roster.join(", ")}` : "등장 인물 후보 목록 없음 — characters는 쿼리에 나온 사람 이름만.",
    "",
    "규칙:",
    "- characters: 쿼리가 지목한 인물. 후보 목록이 있으면 그 안에서만.",
    "- sceneType: 인터뷰룸 정면컷이면 'interview', 현장이면 'on_scene', 없으면 생략.",
    "- isShort: '터진/하이라이트/쇼츠' 뉘앙스면 true, 없으면 생략.",
    "- airedFrom/airedTo: '작년쯤','지난달','올해 초' 같은 표현을 오늘 기준 YYYY-MM-DD 범위로. 없으면 생략.",
    "- semantic: 위 구조 신호를 걷어낸 나머지 의미(상황·감정·대사). 없으면 빈 문자열.",
    "",
    `쿼리: ${q}`,
  ].join("\n");
}

/** 자연어 쿼리 → 구조 필터. LLM 실패 시 룰 폴백. */
export async function parseQuery(
  q: string,
  opts?: { roster?: string[]; today?: string },
): Promise<ParsedQuery> {
  const query = (q || "").trim();
  const roster = opts?.roster ?? [];
  if (!query) return { characters: [], semantic: "" };
  const today = opts?.today || new Date().toISOString().slice(0, 10);

  try {
    const token = await getAuth().getAccessToken();
    if (!token) throw new Error("no access token");
    const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: buildPrompt(query, roster, today) }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA, temperature: 0 },
      }),
    });
    if (!res.ok) throw new Error(`vertex ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("empty candidate");
    const j = JSON.parse(text) as Partial<ParsedQuery>;
    // roster가 있으면 characters를 로스터로 한정(환각 방지)
    const chars = Array.isArray(j.characters) ? j.characters.filter((c) => typeof c === "string") : [];
    const characters = roster.length ? chars.filter((c) => roster.includes(c)) : chars;
    return {
      characters,
      sceneType: j.sceneType || undefined,
      isShort: typeof j.isShort === "boolean" ? j.isShort : undefined,
      airedFrom: j.airedFrom || undefined,
      airedTo: j.airedTo || undefined,
      semantic: (j.semantic ?? "").trim(),
    };
  } catch (e) {
    if (!warned) {
      console.warn(`[search-parse] LLM 파싱 실패 → 룰 폴백 (${String(e).slice(0, 160)})`);
      warned = true;
    }
    return parseQueryRules(query, roster);
  }
}
