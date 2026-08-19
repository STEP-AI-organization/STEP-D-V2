/**
 * 채널별 업로드 메타데이터 — 규격·장르팩·프롬프트 조립.
 *
 * **이 모듈은 순수하다.** DB·네트워크·env 를 읽지 않는다. 실제 생성(Gemini 호출)과 저장은
 * 라우트가 하고, 여기는 "무엇을 물어볼지" 와 "채널 규격에 맞는지" 만 안다 — 그래야 테스트가 된다.
 *
 * ## 왜 채널별인가
 *
 * 예전에는 클립 하나에 `title`·`synopsis` 한 벌만 두고 모든 채널에 그대로 썼다. 그런데 규격이
 * 서로 다르다 — **네이버 클립은 제목 필드가 아예 없고 설명 10자 이상 + 카테고리 1·2차가 필수**다.
 * 그래서 발행 시점에 사람이 손으로 메우고 있었다. 채널마다 담을 미리 만들어 두고 사람이
 * 고치는 쪽이 실무 동선에 맞는다.
 *
 * ## AENA(사내 실서비스) 에서 가져온 것
 *
 *  - **장르팩 분기가 품질의 핵심이다.** 드라마와 예능은 좋은 제목의 모양이 다르다.
 *  - **프롬프트는 블록 조립.** 빈 블록은 빼고 `\n\n` 으로 잇는다 — 조건부 문자열 연결보다
 *    블록이 늘고 줄 때 안전하다.
 *  - ⚠️ **`response_schema`(structured output)를 쓰지 않는다.** AENA 실서비스 결론이다.
 *    스키마를 걸면 MAX_TOKENS 로 잘렸을 때 **파싱 자체가 실패해 배치가 통째로 유실**된다.
 *    `responseMimeType=json` + 말미에 형식 예시만 두고, 잘림은 부분 JSON 복구로 처리한다.
 *
 * ## 사실 규칙
 *
 * 인물 이름은 **프로그램에 사전등록된 캐스트가 정본**이다(등록이 primary · 화면자막이 보조).
 * 모델에게 이름을 지어내게 두면 방송 콘텐츠에서 바로 사고가 된다.
 */

/** 메타데이터를 만들 수 있는 채널. `DISTRIBUTION_CHANNELS`(웹)·`publish-guard`(서버)와 같은 id. */
export type MetaChannel =
  | "youtube" | "navertv" | "naverclip" | "instagram" | "facebook" | "tiktok";

export const META_CHANNELS: MetaChannel[] =
  ["youtube", "navertv", "naverclip", "instagram", "facebook", "tiktok"];

/**
 * 쇼츠 최소 보장 해시태그 — 쇼츠는 **제목·설명 모두** 최소 이 태그를 단다(사용자 2026-08-19).
 * `#Shorts` 가 YouTube 가 Short 로 분류하는 표준 태그다. 클립(16:9)에는 붙이지 않는다.
 */
export const SHORTS_TAG = "#Shorts";

export interface ChannelSpec {
  label: string;
  /** 제목 최대 길이. **null 이면 그 채널에 제목 필드가 없다**(네이버 클립). */
  titleMax: number | null;
  /** 설명 최대 길이. */
  descMax: number;
  /** 설명 최소 길이. 미만이면 그 채널이 등록을 거부한다. */
  descMin: number;
  /** 태그 필드 최대 개수. 0 이면 태그 필드가 없어 해시태그로 녹여야 한다. */
  tagsMax: number;
  /**
   * **제목 끝에 붙일 해시태그 개수.**
   *
   * YouTube(특히 쇼츠)는 `제목 #나는솔로` 처럼 제목에 프로그램 해시태그를 다는 게 유입의 축이다 —
   * 같은 프로그램 클립끼리 묶이고 검색·추천에 함께 걸린다. 설명에만 넣으면 그 효과가 약하다.
   * 다른 채널은 제목 해시태그가 관행이 아니거나 제목 필드 자체가 없어 0 이다.
   */
  titleHashtags: number;
  /** 해시태그를 설명 본문에 붙여야 하는가(태그 필드가 없거나 관행상 본문에 넣는 채널). */
  hashtagsInDescription: boolean;
  /** 발행 전에 사람이 카테고리를 골라야 하는가. */
  needsCategory: boolean;
  /** 이 규격의 근거. 화면에 그대로 보여줘도 되는 문장으로 쓴다. */
  note: string;
}

/**
 * 실측 기준 채널 규격.
 *
 * ⚠️ 숫자는 플랫폼이 조용히 바꾼다. 여기가 틀리면 **발행 직전에 거부**되므로,
 * `validateForChannel` 이 사전 검증에 쓰고 화면도 같은 값을 보여준다 — 한 곳만 고치면 된다.
 */
export const CHANNEL_SPECS: Record<MetaChannel, ChannelSpec> = {
  youtube: {
    label: "YouTube", titleMax: 100, descMax: 5000, descMin: 0, tagsMax: 15,
    // 제목에 프로그램 해시태그를 다는 게 유입의 축이다 (`… #프로그램 #서브 #쇼츠`).
    // 3 = 레퍼런스 모양(#프로그램 #서브 #쇼츠). #쇼츠 는 소스가 비어도 항상 보장된다(아래 참조).
    titleHashtags: 3,
    hashtagsInDescription: true, needsCategory: false,
    note: "제목 100자 · 설명 5000자 · 태그 필드 별도. **제목 끝에 #프로그램 …#쇼츠 해시태그를 붙인다** — 같은 프로그램 클립끼리 묶인다.",
  },
  navertv: {
    label: "네이버 TV", titleMax: 120, descMax: 3000, descMin: 0, tagsMax: 10,
    titleHashtags: 0,
    hashtagsInDescription: false, needsCategory: true,
    note: "가로 VOD. 제목 120자 · 설명 3000자 · 카테고리 필요.",
  },
  naverclip: {
    // ⚠️ 실측(2026-08-11): 제목 입력 자체가 없다. 설명 10자 미만이면 등록 버튼이 비활성이고,
    //    카테고리는 1차·2차 둘 다 골라야 한다. 이 세 가지가 발행 실패의 대부분이었다.
    label: "네이버 클립", titleMax: null, descMax: 300, descMin: 10, tagsMax: 10,
    titleHashtags: 0,
    hashtagsInDescription: true, needsCategory: true,
    note: "제목 필드가 없다 — 설명 300자 하나가 전부다. 10자 이상 · 카테고리 1·2차 필수.",
  },
  instagram: {
    label: "Instagram", titleMax: null, descMax: 2200, descMin: 0, tagsMax: 30,
    titleHashtags: 0,
    hashtagsInDescription: true, needsCategory: false,
    note: "캡션 2200자 하나. 해시태그를 캡션 안에 넣는다.",
  },
  facebook: {
    label: "Facebook", titleMax: 255, descMax: 5000, descMin: 0, tagsMax: 0,
    titleHashtags: 0,
    hashtagsInDescription: true, needsCategory: false,
    note: "태그 필드가 없다 — 해시태그는 본문에.",
  },
  tiktok: {
    label: "TikTok", titleMax: null, descMax: 2200, descMin: 0, tagsMax: 0,
    titleHashtags: 0,
    hashtagsInDescription: true, needsCategory: false,
    note: "캡션 하나. 해시태그가 곧 분류다.",
  },
};

// ── 장르팩 ────────────────────────────────────────────────────────────────────
//
// AENA 가 "품질 핵심" 이라고 지목한 부분. 지금 스코프는 드라마·예능 2종이다
// (two-genre-scope 결정). 나머지 장르는 공통팩으로 돌린다 — 검증 안 된 장르에
// 프롬프트를 늘리면 품질을 확인할 방법이 없다.

export type GenreKey = "drama" | "variety" | "common";

export interface GenrePack {
  label: string;
  /** 이 장르에서 "좋은 제목" 의 모양. */
  titleGuide: string;
  /** 설명에서 지켜야 할 것. */
  descGuide: string;
  /** 이 장르에서 특히 하면 안 되는 것. */
  taboo: string;
}

export const GENRE_PACKS: Record<GenreKey, GenrePack> = {
  drama: {
    label: "드라마",
    // 드라마는 결말을 흘리면 시청 이유가 사라진다. 화면자막이 없어 인물은 등록 캐스트가 정본.
    titleGuide:
      "- 인물의 **선택·감정**을 앞에 둔다. 배역명을 쓰되 등록된 이름만.\n" +
      "- 다음 장면이 궁금해지는 지점에서 끊는다. 결말·반전의 **정답을 제목에 쓰지 않는다.**",
    descGuide:
      "- 회차·상황을 한 문장으로 세우고, 인물 관계를 짧게 덧붙인다.\n" +
      "- 대사 인용은 한 줄까지. 장면 전체를 요약해 버리면 볼 이유가 없어진다.",
    taboo:
      "- **스포일러 금지**: 사망·정체·배신·재회의 결과를 제목·설명 첫 줄에 쓰지 마라.\n" +
      "- 배우 본명과 배역명을 섞지 마라. 등록된 표기 하나로 통일한다.",
  },
  variety: {
    label: "예능",
    // 예능은 웃음의 트리거가 곧 제목이다. 자막 톤(어그로)은 허용하되 날조는 금지.
    titleGuide:
      "- **웃음이 터지는 지점**을 그대로 쓴다. 실제 대사 인용이 가장 강하다.\n" +
      "- 물음표·말줄임표로 여운을 남겨도 된다. 다만 자막에 없는 감정을 붙이지 마라.",
    descGuide:
      "- 누가 무엇을 했는지 사실만. 리액션을 대신 설명하려 들지 않는다.\n" +
      "- 출연자 이름을 앞쪽에 둔다 — 검색은 대체로 사람 이름으로 들어온다.",
    taboo:
      "- 자막에 없는 상황·수치·인물을 만들지 마라(가장 흔한 사고다).\n" +
      "- 비하·외모 평가로 읽힐 표현 금지.",
  },
  common: {
    label: "공통",
    titleGuide: "- 이 구간에서 실제로 벌어진 일을 가장 짧게 말한다.",
    descGuide: "- 상황을 2~3문장으로. 근거 없는 형용사를 붙이지 않는다.",
    taboo: "- 근거 없는 사실을 만들지 마라.",
  },
};

/** 프로그램 장르 문자열 → 장르팩. 모르는 값은 공통팩(추측해서 틀린 팩을 쓰는 것보다 낫다). */
export function genrePackFor(genre: unknown): GenrePack {
  const g = String(genre ?? "").toLowerCase();
  if (g.includes("drama") || g.includes("드라마") || g.includes("영화")) return GENRE_PACKS.drama;
  if (g.includes("variety") || g.includes("예능")) return GENRE_PACKS.variety;
  return GENRE_PACKS.common;
}

// ── 프롬프트 조립 ──────────────────────────────────────────────────────────────

export interface MetaSource {
  /** 프로그램명 — 검색 유입의 축이라 제목·태그 어디엔가 반드시 들어간다. */
  program?: string;
  /** 회차 표기(예: "16기 3회"). */
  episode?: string;
  genre?: string;
  /** 프로그램에 **사전등록된** 출연자. 이름의 정본이다. */
  cast?: string[];
  /** 이 클립에 실제로 나온 인물(분석 결과) — cast 와 교차 확인용. */
  people?: string[];
  /** 분석이 붙인 클립 제목·요약. 원본 자막보다 이게 먼저다(이미 산 정보다). */
  workingTitle?: string;
  summary?: string;
  /** 훅 대사 원문 인용 — 제목 재료로 가장 강하다. */
  hookQuote?: string;
  /** 훅 유형(분석이 분류한 8종 중 하나). */
  hookType?: string;
  /** 자막 일부. 없을 수도 있다(대사 없는 리액션 클립) — 없다고 실패시키지 않는다. */
  captions?: string[];
  durationSec?: number;
  /** 프로그램별 운영자 커스텀 지시(program.titlePrompt) — 제목·문구 기본 규칙 위에 얹는다. */
  titlePrompt?: string;
}

/** 값이 있는 블록만 `\n\n` 으로 잇는다. AENA 의 조립 방식. */
function joinBlocks(blocks: (string | null | undefined)[]): string {
  return blocks.filter((b) => typeof b === "string" && b.trim()).join("\n\n");
}

/**
 * 메타데이터 생성 프롬프트.
 *
 * **채널별로 나눠 묻지 않는다.** 한 번에 "바탕" 한 벌을 만들고, 채널 규격은
 * `normalizeForChannel` 이 결정론적으로 맞춘다 — 채널 수만큼 LLM 을 부르면 6배 비싸지고
 * 채널 간 내용이 서로 달라져 운영자가 검토할 수 없다.
 */
export function buildMetadataPrompt(src: MetaSource): string {
  const pack = genrePackFor(src.genre);
  const cast = (src.cast ?? []).filter(Boolean);
  const people = (src.people ?? []).filter(Boolean);
  const caps = (src.captions ?? []).filter(Boolean).slice(0, 40);

  return joinBlocks([
    // ① 역할
    "너는 한국 방송 클립을 채널에 올리는 업로드 담당자다. 과장 없이, 사실만으로 사람을 끌어오는 문구를 쓴다.",

    // ② 과제
    "이 클립 하나에 대해 **바탕 메타데이터 한 벌**을 만든다. 채널별 길이 조정은 시스템이 하므로 " +
    "너는 길이에 얽매이지 말고 가장 좋은 표현을 쓴다.",

    // ③ 장르팩 — AENA 가 품질 핵심이라 한 블록
    `[장르: ${pack.label}]\n[제목]\n${pack.titleGuide}\n[설명]\n${pack.descGuide}\n[금지]\n${pack.taboo}`,

    // ④ 프로그램 메타
    joinBlocks([
      src.program ? `[프로그램] ${src.program}` : null,
      src.episode ? `[회차] ${src.episode}` : null,
      src.durationSec ? `[길이] ${Math.round(src.durationSec)}초` : null,
    ]),

    // ⑤ 출연진 — 이름의 정본
    cast.length
      ? `[등록 출연자 — 이름은 이 표기만 쓴다]\n${cast.join(" · ")}\n` +
        "여기 없는 사람 이름을 새로 만들지 마라. 확실하지 않으면 이름 없이 상황만 쓴다."
      : "[출연자] 등록된 명단이 없다 — **이름을 추측해 쓰지 마라.** 상황으로만 표현한다.",

    // ⑥ 이 클립의 분석 결과 (이미 만들어 둔 것 — 자막보다 먼저 본다)
    joinBlocks([
      src.workingTitle ? `[분석이 붙인 제목] ${src.workingTitle}` : null,
      src.summary ? `[구간 요약] ${src.summary}` : null,
      src.hookQuote ? `[훅 대사(원문 인용)] "${src.hookQuote}"` : null,
      src.hookType ? `[훅 유형] ${src.hookType}` : null,
      people.length ? `[이 구간 등장 인물] ${people.join(" · ")}` : null,
    ]),

    // ⑦ 자막 — 있으면 근거, 없어도 진행한다
    caps.length
      ? `[자막]\n${caps.join("\n")}`
      : "[자막] 이 구간에는 대사가 거의 없다. 위 요약과 인물 정보만으로 쓴다.",

    // ⑧ 절대 규칙
    "[절대 규칙]\n" +
    "- 위에 주어진 것 밖의 사실을 만들지 마라. 인물·장소·수치·행동 전부.\n" +
    "- 등록 출연자 명단에 없는 이름을 쓰지 마라.\n" +
    "- 낚시성 표현으로 내용을 왜곡하지 마라. 안 나온 일을 났다고 쓰면 안 된다.",

    // ⑧.5 프로그램별 운영자 지시 — 프로그램 상세에서 운영자가 직접 입력(program.titlePrompt).
    //     기본 규칙 위에 얹는 추가 지시. 값 없으면 블록 자체 생략.
    src.titlePrompt?.trim()
      ? "## 프로그램별 운영자 지시\n" +
        // 1000자 컷 — 운영자 입력이라 길이 통제가 없다. 프롬프트 낭비 방지.
        `${src.titlePrompt.trim().slice(0, 1000)}\n` +
        "(위 지시는 이 프로그램 운영자가 직접 입력했다. 기본 규칙은 유지한 채 추가로 반영하라.)"
      : null,

    // ⑨ 출력 형식 — ⚠️ response_schema 를 쓰지 않는다(잘림 복구를 위해)
    "아래 JSON 만 출력한다. 설명·마크다운·코드펜스 금지.\n" +
    '{"title":"제목 한 줄","description":"설명 3~5문장","tags":["태그","태그"],"hashtags":["#태그","#태그"]}\n' +
    "- title: 가장 강한 한 줄. 40자 이내로 쓴다(채널별 축약은 시스템이 한다).\n" +
    "- description: 3~5문장. 해시태그는 여기 넣지 말고 hashtags 로 분리한다.\n" +
    "- tags: 5~10개. 인물명·프로그램명·상황 키워드. 앞에 # 을 붙이지 않는다.\n" +
    "- hashtags: 5~8개(추천 해시태그). # 을 붙인 형태. 프로그램·인물·상황·감정 키워드를 폭넓게.",
  ]);
}

// ── 채널 규격 맞추기 (결정론) ──────────────────────────────────────────────────

/** LLM 이 만든 바탕 한 벌. */
export interface BaseMetadata {
  title: string;
  description: string;
  tags: string[];
  hashtags: string[];
}

/** 채널 규칙에서 메타에 영향을 주는 부분만. `channel-rules.ts` 의 ChannelRule 부분집합. */
export interface MetaRule {
  titlePrefix?: string;
  /** `{program}`·`{episode}` 치환이 되는 해시태그 템플릿. */
  hashtagTemplate?: string;
}

export interface ChannelMetadata {
  channel: MetaChannel;
  /** 제목. 그 채널에 제목 필드가 없으면 null. */
  title: string | null;
  description: string;
  tags: string[];
  /** 사람이 손대야 하는 것 — 발행 전에 화면이 물어봐야 한다. */
  needsCategory: boolean;
  /** 규격 위반 사유. 비어 있어야 발행할 수 있다. */
  problems: string[];
}

/** 잘라내되 단어 중간에서 끊지 않는다. 말줄임은 붙이지 않는다 — 제목에 …이 남으면 지저분하다. */
function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim();
}

/**
 * 제목에 붙일 해시태그 고르기.
 *
 * **프로그램 해시태그가 1순위다.** 운영자가 제목에 `#나는솔로` 를 다는 이유는 그 프로그램
 * 클립끼리 묶기 위해서지, 아무 키워드나 달려는 게 아니다. 프로그램명이 있으면 그것부터 넣고,
 * 남는 자리를 나머지 해시태그로 채운다.
 *
 * 공백은 지운다 — `#나는 솔로` 는 유튜브에서 `#나는` 까지만 해시태그로 인식된다.
 */
function pickTitleHashtags(hashtags: string[], program: string | undefined, want: number): string[] {
  if (want <= 0) return [];
  const norm = (t: string) => `#${t.replace(/^#/, "").replace(/\s+/g, "")}`;
  const out: string[] = [];
  const push = (t: string) => {
    const v = norm(t);
    if (v.length > 1 && !out.includes(v)) out.push(v);
  };
  if (program?.trim()) push(program.trim());
  for (const h of hashtags) {
    if (out.length >= want) break;
    push(h);
  }
  return out.slice(0, want);
}

function fillTemplate(tpl: string, vars: { program?: string; episode?: string }): string {
  return tpl
    .replace(/\{program\}/g, vars.program ?? "")
    .replace(/\{episode\}/g, vars.episode ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 바탕 한 벌 → 그 채널에 그대로 올릴 수 있는 형태.
 *
 * **여기는 LLM 을 부르지 않는다.** 길이 맞춤·접두어·해시태그 배치는 규칙이지 창작이 아니다.
 * 결정론이어야 같은 입력에 같은 결과가 나오고, 운영자가 고친 값이 다음 생성에 덮이지 않는다.
 *
 * ⚠️ 채널 규칙(`titlePrefix`·`hashtagTemplate`)이 **드디어 여기서 쓰인다.** 그 필드들은
 * 2026-08-12 까지 화면에서 입력만 받고 읽는 코드가 한 곳도 없었다 — 운영자가 채워도
 * 아무 데도 안 갔다.
 */
export function normalizeForChannel(
  base: BaseMetadata,
  channel: MetaChannel,
  rule: MetaRule = {},
  vars: { program?: string; episode?: string } = {},
  /** 쇼츠(9:16)인가 — 쇼츠면 제목·설명에 SHORTS_TAG 를 보장한다. 클립(16:9)이면 안 붙인다. */
  isShort = true,
): ChannelMetadata {
  const spec = CHANNEL_SPECS[channel];
  const problems: string[] = [];

  const prefix = (rule.titlePrefix ?? "").trim();
  const ruleTags = fillTemplate(rule.hashtagTemplate ?? "", vars)
    .split(/\s+/).filter((t) => t.startsWith("#"));
  const hashtags = [...new Set([...ruleTags, ...(base.hashtags ?? [])])].filter(Boolean);

  // 제목 — 접두어 + 본문 + **제목 해시태그**
  //
  // YouTube 는 `제목 #나는솔로` 처럼 제목에 프로그램 해시태그를 다는 게 유입의 축이다.
  // 해시태그 자리를 **먼저 확보한 뒤** 본문을 자른다 — 본문을 상한까지 채우고 나서 붙이면
  // 정작 중요한 해시태그가 잘려 나간다.
  let title: string | null = null;
  let titleTags: string[] = [];
  if (spec.titleMax !== null) {
    // 프로그램 해시태그를 최우선으로 — 채널 규칙 템플릿에서 온 것이 그 자리다.
    titleTags = pickTitleHashtags(hashtags, vars.program, spec.titleHashtags);
    if (spec.titleHashtags > 0) {
      // ⚠️ **제목은 해시태그 없이 나가면 안 된다**(YouTube 쇼츠 유입축). 규칙 템플릿·Gemini
      //    해시태그가 둘 다 비고 프로그램조차 없어 titleTags 가 통째로 비면, 클립 자체 데이터로
      //    채운다 — 하드코딩이 아니라 이 클립에서 나온 것만 쓴다.
      //    소스 순서: 프로그램명 → base.tags(등록 캐스트·인물명이 녹아 있는 자리). #쇼츠 자리를
      //    하나 남겨(want-1) 최후의 보루가 항상 들어가게 한다.
      if (titleTags.length === 0) {
        titleTags = pickTitleHashtags(base.tags ?? [], vars.program, Math.max(1, spec.titleHashtags - 1));
      }
      // #Shorts 보장(쇼츠만) — 이미 있으면 그대로, 없고 자리가 남으면 붙인다(레퍼런스:
      // `#프로그램 #서브 #Shorts`). 그래도 비면(프로그램·태그 전무) SHORTS_TAG 하나라도 남긴다
      // — YouTube 쇼츠는 해시태그 0개로 안 나간다. 클립(16:9)이면 이 보장을 걸지 않는다.
      if (isShort) {
        const hasShorts = titleTags.some((t) => t.toLowerCase() === SHORTS_TAG.toLowerCase());
        if (!hasShorts && titleTags.length < spec.titleHashtags) titleTags.push(SHORTS_TAG);
        if (titleTags.length === 0) titleTags.push(SHORTS_TAG);
      }
    }
    const suffix = titleTags.length ? ` ${titleTags.join(" ")}` : "";
    const head = prefix ? `${prefix} ` : "";
    const room = spec.titleMax - head.length - suffix.length;
    const body = room > 0 ? clip(base.title, room) : "";
    title = `${head}${body}${suffix}`.trim();
    if (!body) problems.push("제목이 비어 있습니다(접두어·해시태그가 상한을 다 써버렸습니다).");
  }

  // 설명 — 제목 필드가 없는 채널은 제목을 설명 첫 줄로 올린다(안 그러면 그 문구가 사라진다).
  // 쇼츠면 설명 해시태그 맨 앞에 SHORTS_TAG 를 보장한다(제목·설명 모두 · 사용자 2026-08-19).
  // ⚠️ title 로직이 쓰는 `hashtags` 는 오염하지 않는다(base.tags 폴백이 깨진다) — 설명 전용 리스트.
  const buildDesc = (tags: string[]) => {
    const parts: string[] = [];
    if (spec.titleMax === null && base.title.trim()) parts.push(base.title.trim());
    if (base.description.trim()) parts.push(base.description.trim());
    if (spec.hashtagsInDescription && tags.length) parts.push(tags.join(" "));
    return clip(parts.join("\n\n"), spec.descMax);
  };
  const hasShortsTag = hashtags.some((h) => h.toLowerCase() === SHORTS_TAG.toLowerCase());
  const descHashtags = isShort && !hasShortsTag ? [SHORTS_TAG, ...hashtags] : hashtags;
  const description = buildDesc(descHashtags);   // 실제 설명 — 쇼츠면 #Shorts 포함
  // 하한 판정용 — 보장 #Shorts 를 뺀 실내용. 빈 설명이 자동 #Shorts 로 10자를 넘겨 "짧음"
  // 문제를 가리면 안 된다(사람이 실제 내용을 채우게 한다).
  const descForMin = buildDesc(hashtags);

  // 하한 미달은 **자동으로 채우지 않는다.** 지어낸 문장으로 길이를 맞추면 사실이 흔들린다.
  if (descForMin.length < spec.descMin) {
    problems.push(
      `${spec.label} 은 설명이 ${spec.descMin}자 이상이어야 합니다 (현재 ${descForMin.length}자).`,
    );
  }

  const tags = spec.tagsMax > 0
    ? [...new Set((base.tags ?? []).map((t) => t.replace(/^#/, "").trim()).filter(Boolean))]
        .slice(0, spec.tagsMax)
    : [];

  if (spec.needsCategory) {
    // 카테고리는 사람 몫이다 — 자동 판정하면 틀린 분류로 발행되고 되돌리기가 번거롭다.
    problems.push(`${spec.label} 은 발행 전에 카테고리를 골라야 합니다.`);
  }

  return { channel, title, description, tags, needsCategory: spec.needsCategory, problems };
}

/** 사람이 고친 뒤 다시 검증. 발행 버튼을 누르기 전에 이걸 통과해야 한다. */
export function validateForChannel(meta: Pick<ChannelMetadata, "title" | "description">,
                                   channel: MetaChannel): string[] {
  const spec = CHANNEL_SPECS[channel];
  const out: string[] = [];
  if (spec.titleMax !== null) {
    const t = (meta.title ?? "").trim();
    if (!t) out.push("제목이 비어 있습니다.");
    else if (t.length > spec.titleMax) out.push(`제목이 ${spec.titleMax}자를 넘습니다 (${t.length}자).`);
  }
  const d = (meta.description ?? "").trim();
  if (d.length < spec.descMin) out.push(`설명이 ${spec.descMin}자 미만입니다 (${d.length}자).`);
  if (d.length > spec.descMax) out.push(`설명이 ${spec.descMax}자를 넘습니다 (${d.length}자).`);
  return out;
}
