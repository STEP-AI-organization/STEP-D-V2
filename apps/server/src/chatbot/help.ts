/**
 * 도우미가 읽는 지식 — `docs/help/*.md` 하나뿐이다.
 *
 * ## 왜 기존 `docs/` 를 안 물리나
 *
 * 리포의 문서는 **우리를 위한 것**이다. 회차당 원가·마진·모델 이름·인프라 구성·다른 고객사
 * 이름이 섞여 있다. 그걸 지식으로 주면 도우미는 그중 하나를 자연스럽게 인용하고, 사용자
 * 화면에는 **에러가 아니라 잘 쓴 답변처럼** 나온다. 새는 걸 알아채는 사람이 없다.
 *
 * 그래서 사용자용 문서를 따로 쓰고 **그것만** 읽는다. 문서 자체가 방어선이다
 * (`chatbot-help.test.ts` 가 금지어를 검사한다).
 *
 * ## 왜 임베딩을 안 쓰나
 *
 * 문서가 열두 편이다. 벡터 검색은 이 규모에서 정확도를 못 올리면서 실패 지점(Vertex 호출)만
 * 하나 늘린다. 대신 **결정론적으로** 고른다 — 지금 보고 있는 화면의 문서 한 편 + 질문
 * 키워드가 맞는 두 편. 같은 질문에 늘 같은 문서가 실리므로 답이 이상할 때 원인을 좁힐 수 있다.
 */
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../repo-root.ts";
import { knownScreen } from "./catalog.ts";

/**
 * `<repo>/docs/help`.
 *
 * ⚠️ **서버 이미지에 이 폴더가 들어가야 한다.** `apps/server/Dockerfile` 은 기본적으로
 * `apps/server`·`core`·`assets/*` 만 COPY 하므로, `COPY docs/help docs/help` 가 빠지면
 * 로컬은 멀쩡하고 **프로덕션만 지식이 빈 채로** 돈다(도우미가 "문서를 못 찾았다"가 아니라
 * 그냥 일반론으로 답한다 — 아무도 눈치채지 못하는 종류의 고장이다).
 * `chatbot-help.test.ts` 가 그 COPY 줄의 존재를 검사한다.
 */
export const HELP_DIR = path.join(REPO_ROOT, "docs", "help");

export interface HelpDoc {
  /** 파일 이름(확장자 제외). 답변 근거를 기록할 때 이 이름을 쓴다. */
  name: string;
  /** 이 문서가 설명하는 화면 경로. 카탈로그에 있는 값이어야 한다. */
  screen: string | null;
  title: string;
  keywords: string[];
  /** 프런트매터를 뺀 본문. */
  body: string;
}

/** 문서 한 편이 프롬프트에서 차지할 수 있는 최대 길이. 넘으면 뒤를 자른다. */
export const DOC_CHAR_LIMIT = 3_000;
/** 한 번에 싣는 문서 수. 현재 화면 1편 + 질문 매칭 2편. */
export const MAX_DOCS = 3;

/**
 * 아주 작은 프런트매터 파서. YAML 라이브러리를 들이지 않는다 — 우리가 쓰는 건
 * `key: value` 와 `keywords: [a, b]` 두 형태뿐이고, 형태가 늘어나면 문서가 아니라
 * 파서를 고치게 된다(그러면 문서를 쓰는 사람이 파서를 알아야 한다).
 */
function parseFrontMatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-zA-Z_]+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: raw.slice(m[0].length) };
}

function parseList(v: string | undefined): string[] {
  if (!v) return [];
  return v.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

let cache: HelpDoc[] | null = null;

/**
 * 문서 전체를 읽는다. 프로세스 수명 동안 캐시한다 — 파일은 이미지에 구워져 있어 런타임에
 * 안 바뀐다. 폴더가 없으면 **빈 배열**을 돌려주고 호출부가 그 사실을 답변에 반영한다
 * (조용히 일반론으로 답하지 않게).
 */
export function loadHelpDocs(): HelpDoc[] {
  if (cache) return cache;
  let files: string[] = [];
  try {
    files = fs.readdirSync(HELP_DIR).filter((f) => f.endsWith(".md")).sort();
  } catch {
    console.warn(`[chatbot] 도움말 폴더가 없다: ${HELP_DIR} — 도우미가 제품 지식 없이 답하게 된다`);
    cache = [];
    return cache;
  }
  cache = files.map((f) => {
    const raw = fs.readFileSync(path.join(HELP_DIR, f), "utf-8");
    const { meta, body } = parseFrontMatter(raw);
    return {
      name: f.replace(/\.md$/, ""),
      screen: meta.screen || null,
      title: meta.title || f,
      keywords: parseList(meta.keywords),
      body: body.trim(),
    };
  });
  return cache;
}

/** 테스트·개발에서 파일을 고치고 다시 읽을 때. */
export function clearHelpCache(): void {
  cache = null;
}

/**
 * 조사·기호를 털어 낸 검색용 토큰. 한국어는 형태소 분석 없이 부분일치로 충분하다.
 *
 * ⚠️ **NFC 로 맞춘다.** 같은 "크레딧" 이라도 조합형(NFD)으로 오면 코드포인트가 달라
 * `includes` 가 **한 번도 안 맞는다.** 문서 키워드는 파일에서 읽어 NFC 이고, 질문은
 * 클라이언트에 따라 NFD 로 온다(맥·iOS 입력, 일부 셸). 그러면 증상이 "검색이 안 된다"가
 * 아니라 **"도우미가 제품을 모른다"** 로 나타난다 — 문서를 못 고르니 일반론으로 답하고,
 * 에러는 하나도 안 난다. 실측 2026-09-03 에 이걸로 한참 헤맸다.
 */
function normalize(s: string): string {
  return s.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * 질문 + 현재 화면 → 실을 문서.
 *
 * 점수는 **규칙이 정한다**(모델이 아니라). 화면 일치가 가장 세고, 그다음이 키워드,
 * 그다음이 제목이다. 동점이면 파일 이름 순 — 같은 입력에 늘 같은 답이 나오게.
 */
export function selectDocs(question: string, screen?: string | null): HelpDoc[] {
  const docs = loadHelpDocs();
  if (!docs.length) return [];

  const q = normalize(question);
  // `/episodes/ep_1` 처럼 id 가 붙은 경로도 상위 화면으로 접어 맞춘다.
  const here = screen ? (knownScreen(screen)?.href ?? null) : null;

  const scored = docs.map((doc, i) => {
    let score = 0;
    if (here && doc.screen === here) score += 100;
    for (const k of doc.keywords) {
      if (k && q.includes(normalize(k))) score += 10;
    }
    if (doc.title && q.includes(normalize(doc.title))) score += 5;
    // 본문 제목(## …)에 질문의 말이 그대로 있으면 약한 가점. 본문 전체를 훑지는 않는다 —
    // 흔한 단어가 긴 문서를 늘 이기게 된다.
    for (const h of doc.body.match(/^#{2,3} .+$/gm) ?? []) {
      if (q && normalize(h).split(" ").some((w) => w.length >= 2 && q.includes(w))) { score += 2; break; }
    }
    return { doc, score, i };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, MAX_DOCS)
    .map((s) => s.doc);
}

/** 프롬프트에 싣는 형태. 잘렸으면 잘렸다고 밝힌다 — 모델이 뒷부분을 지어내지 않게. */
export function docText(doc: HelpDoc): string {
  const body = doc.body.length > DOC_CHAR_LIMIT
    ? `${doc.body.slice(0, DOC_CHAR_LIMIT)}\n…(이 문서는 여기서 잘렸다)`
    : doc.body;
  return `### ${doc.title} (${doc.name}${doc.screen ? ` · ${doc.screen}` : ""})\n${body}`;
}
