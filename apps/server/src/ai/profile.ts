/**
 * STEP-D — Program understanding profile.
 *
 * A per-program "이해 프로파일" that captures how THIS show works — its format grammar,
 * what moments to watch for, how much each hook type matters, its taboos/memes, edit tone,
 * target length, cast type. It's stored on the program entity and fed into candidate
 * scoring so the pick is program-aware (master plan: 최종점수 = 융합 × 채널적합 × 프로그램적합).
 *
 * The schema is FIXED (below). All AI generation goes through Vertex Gemini (src/gemini.ts);
 * the model output is validated/normalized here so downstream (storage + scoring) can trust
 * the shape. Non-destructive: a program with no profile scores exactly as before.
 */

export const HOOK_KEYS = ["반전", "감정고조", "돌직구", "질문", "정보성", "웃음", "갈등", "공감"] as const;
export type HookKey = (typeof HOOK_KEYS)[number];
export type HookWeights = Record<HookKey, number>;

export interface ProgramProfile {
  programName: string;
  formatGrammar: string;
  watchPoints: string[];
  hookWeights: HookWeights;
  taboos: string[];
  memes: string[];
  editTone: string;
  /** Free-form target length hint, e.g. "30~45초" or "45". Scoring parses a number out of it. */
  targetLength: string;
  castType: string;
  /** Only present for the web-search mode — provenance URLs/titles. */
  sources?: string[];
}

export type GenerateMode = "direct" | "websearch" | "planning";

const asString = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v.trim() : v == null ? fallback : String(v).trim() || fallback;

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => asString(x)).filter(Boolean) : [];

/** Coerce hookWeights to all 8 keys as finite numbers; missing/invalid → 1.0 (neutral). */
function normalizeHookWeights(v: unknown): HookWeights {
  const src = (v && typeof v === "object" ? (v as Record<string, unknown>) : {}) as Record<string, unknown>;
  const out = {} as HookWeights;
  for (const k of HOOK_KEYS) {
    const n = Number(src[k]);
    out[k] = Number.isFinite(n) && n >= 0 ? n : 1.0;
  }
  return out;
}

/**
 * Validate + normalize any raw object into a full ProgramProfile. Never throws — missing
 * fields get safe defaults so a partial model output still yields a usable (neutral) profile.
 */
export function normalizeProfile(raw: unknown): ProgramProfile {
  const r = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as Record<string, unknown>;
  const profile: ProgramProfile = {
    programName: asString(r.programName),
    formatGrammar: asString(r.formatGrammar),
    watchPoints: asStringArray(r.watchPoints),
    hookWeights: normalizeHookWeights(r.hookWeights),
    taboos: asStringArray(r.taboos),
    memes: asStringArray(r.memes),
    editTone: asString(r.editTone),
    targetLength: asString(r.targetLength),
    castType: asString(r.castType),
  };
  const sources = asStringArray(r.sources);
  if (sources.length) profile.sources = sources;
  return profile;
}

/** True only when a profile carries at least some signal (not an all-empty shell). */
export function profileHasSignal(p: ProgramProfile | undefined | null): boolean {
  if (!p) return false;
  return Boolean(
    p.formatGrammar ||
      p.watchPoints.length ||
      p.taboos.length ||
      p.editTone ||
      p.targetLength ||
      HOOK_KEYS.some((k) => p.hookWeights[k] !== 1.0),
  );
}

// ── Gemini response schema (fixed) ──────────────────────────────────────────────
// Mirrors ProgramProfile so the model returns exactly these fields.
export const PROFILE_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    programName: { type: "STRING" },
    formatGrammar: { type: "STRING" },
    watchPoints: { type: "ARRAY", items: { type: "STRING" } },
    hookWeights: {
      type: "OBJECT",
      properties: Object.fromEntries(HOOK_KEYS.map((k) => [k, { type: "NUMBER" }])),
      required: [...HOOK_KEYS],
    },
    taboos: { type: "ARRAY", items: { type: "STRING" } },
    memes: { type: "ARRAY", items: { type: "STRING" } },
    editTone: { type: "STRING" },
    targetLength: { type: "STRING" },
    castType: { type: "STRING" },
  },
  required: [
    "programName",
    "formatGrammar",
    "watchPoints",
    "hookWeights",
    "taboos",
    "memes",
    "editTone",
    "targetLength",
    "castType",
  ],
} as const;

// ── Prompts (3 modes) ───────────────────────────────────────────────────────────
// NOTE: 사용자 제공 verbatim 프롬프트 3종으로 교체 예정. 아래는 동일 스키마를 산출하는
// 임시 프롬프트다 (구조·필드는 확정, 문구만 사용자본으로 스왑).
const SCHEMA_HINT = `아래 JSON 스키마로만 답하라(다른 텍스트 금지):
{
  "programName": 프로그램명,
  "formatGrammar": 이 프로그램의 포맷 문법(구조/전개 방식)을 1~3문장,
  "watchPoints": [클립으로 쓸 때 주목할 순간들 3~8개],
  "hookWeights": {"반전":수,"감정고조":수,"돌직구":수,"질문":수,"정보성":수,"웃음":수,"갈등":수,"공감":수}  // 각 0.5~2.0, 이 프로그램에서 그 훅이 얼마나 중요한지,
  "taboos": [피해야 할 장면/편집 금기 0~6개],
  "memes": [이 프로그램 특유의 밈/유행어 0~8개],
  "editTone": 편집 톤(예: 빠른 예능 컷 / 잔잔한 다큐 톤),
  "targetLength": 목표 쇼츠 길이(예: "30~45초"),
  "castType": 출연진 유형(예: 고정 MC + 게스트)
}`;

/** Mode 1 — direct input: 프로그램명/장르/설명 → 프로파일. */
export const PROMPT_DIRECT = `너는 한국 방송/예능 편성·클립 전문가다. 주어진 프로그램 정보로 "이해 프로파일"을 만들어라.
정보가 부족하면 장르 관례로 합리적으로 추정하되, 지어내되 과장하지 마라.
${SCHEMA_HINT}`;

/** Mode 2 — web-search auto-collect: 프로그램명 → 웹검색 근거 → 프로파일 + sources. */
export const PROMPT_WEBSEARCH = `너는 한국 방송/예능 편성·클립 전문가다. 프로그램명을 웹에서 조사해(위키/방송사/커뮤니티/기사) 사실에 근거한 "이해 프로파일"을 만들어라.
근거로 삼은 출처(제목 또는 URL)를 sources 배열에도 넣어라. 확인 안 되는 건 비워라.
${SCHEMA_HINT}
추가 필드: "sources": [참고한 출처 문자열들]`;

/** Mode 3 — unaired planning doc: 기획정보 → 프로파일 (memes 빈 배열). */
export const PROMPT_PLANNING = `너는 한국 방송/예능 기획·클립 전문가다. 아직 방영 전인 프로그램의 기획의도서/기획정보로 "이해 프로파일"을 만들어라.
아직 방영 전이므로 memes 는 빈 배열([])로 둔다. 나머지는 기획정보에 근거해 추정하라.
${SCHEMA_HINT}`;

export function promptForMode(mode: GenerateMode): string {
  return mode === "websearch" ? PROMPT_WEBSEARCH : mode === "planning" ? PROMPT_PLANNING : PROMPT_DIRECT;
}
