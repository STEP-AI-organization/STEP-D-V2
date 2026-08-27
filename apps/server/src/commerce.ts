/**
 * 커머스 제휴 링크 — 게이트·대가성 문구·설명란 조립 (쿠팡파트너스, 2026-08-26).
 *
 * **이 모듈은 순수하다.** DB·네트워크를 만지지 않는다(env 는 게이트 하나만 읽는다).
 * 실제 링크 발급은 워커(`coupang-partners.ts`)가, 저장은 라우트가 한다 — 여기는
 * "무엇을 물어볼지"·"무엇을 붙일지"만 안다. `clip-metadata.ts` 와 같은 자세다.
 *
 * ## 왜 이 기능이 있나
 *
 * 편집자에게 쇼츠 발행은 이미 일이고, 그 위에 "상품 찾기 → 링크 발급 → 문구 붙이기" 를
 * 얹으면 아무도 안 한다. 실제로 아무도 안 해서 이 수익은 0원이 아니라 **존재하지 않는다.**
 * 우리는 그걸 자동 배포 경로에 얹어 편집자 추가 노동 0 으로 만든다.
 * 근거·실측: `docs/research/commerce-product-matching-probe-2026-08.md`
 *
 * ## 안전 원칙 셋 (전부 계정 정지와 직결)
 *
 *  1. **자기 클릭 금지.** 우리 시스템은 생성된 제휴 링크를 **절대 열지 않는다.**
 *     검증이 필요해도 열지 않는다 — 자가 클릭은 즉시 정지 사유다.
 *  2. **대가성 문구는 옵션이 아니다.** 링크가 하나라도 붙으면 문구가 같이 나간다.
 *     그래서 설명란 본문에 미리 굽지 않고 **발행 조립 시점에** 붙인다 — 편집 화면에서
 *     사람이 지울 수 있는 자리에 두면 언젠가 지워지고, 그 순간 고객사 계정이 정지된다.
 *  3. **링크 형식을 코드가 검증한다.** `link.coupang.com` https URL 이 아니면 안 붙인다.
 *     자동화 버그가 엉뚱한 URL 을 공개 설명란에 밀어 넣는 경로를 막는다.
 */

/** 게이트를 켜는 값. 그 외(미설정·오타·빈값)는 전부 OFF — upload-gate 와 같은 방식. */
const TRUTHY = new Set(["true", "1", "on", "yes", "enabled"]);

/**
 * 커머스 링크 기능 스위치. **기본 OFF.**
 *
 * 실패 방향을 고정한다: 잘못된 env 의 결과가 "링크가 안 붙음" 이어야지
 * "실수로 제휴 링크가 공개 발행됨" 이면 안 된다. 호출 시점에 읽어서 재배포로 껐다 켤 수 있게 한다.
 */
export function commerceLinksEnabled(): boolean {
  return TRUTHY.has(String(process.env.COMMERCE_LINKS_ENABLED ?? "").trim().toLowerCase());
}

/**
 * 대가성 문구 — **쿠팡파트너스 링크 생성 화면이 직접 명시한 문장 그대로.**
 *
 * 실측(2026-08-26 · 파트너스 콘솔 "링크 생성" 화면 *활동 시 주의 사항*):
 *   "게시글 작성 시, 아래 문구를 반드시 기재해 주세요."
 * 우리가 문장을 다듬지 않는다 — 공정위 심사지침·쿠팡 약관이 걸린 자리라 원문이 정본이다.
 */
export const COUPANG_DISCLOSURE =
  "이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.";

/** 설명란에서 링크 묶음이 시작되는 줄. 재조립 멱등 판정에도 쓴다. */
export const COMMERCE_BLOCK_HEADER = "▼ 영상 속 상품";

/**
 * 링크를 붙일 채널. **지금은 YouTube 뿐이다.**
 *
 * 쿠팡파트너스의 실제 수익 경로가 유튜브 설명란이고(연구문서 §2), 네이버·인스타·틱톡은
 * ① 링크가 클릭되지 않거나 ② 플랫폼별 외부 상업링크 정책이 확인되지 않았다.
 * 확인되지 않은 채널에 자동으로 상업 링크를 내보내는 것이 이 기능의 최악 실패 모드다 —
 * 확인된 곳부터 하나씩 늘린다.
 */
export const COMMERCE_CHANNELS: readonly string[] = ["youtube"];

/** 설명란에 붙일 링크 최대 개수. 많이 붙일수록 스팸으로 읽히고 클릭률이 떨어진다. */
export const MAX_LINKS_PER_CLIP = 3;

/** 한 클립에서 뽑을 상품 쿼리 최대 개수(LLM 출력 상한 · 발급 잡의 작업량 상한). */
export const MAX_QUERIES_PER_CLIP = 5;

/** 영상 한 구간에서 뽑아낸 "살 만한 물건" 하나. 아직 상품이 아니라 **검색어**다. */
export interface ProductQuery {
  /** 쿠팡에 그대로 넣을 검색어. */
  query: string;
  /** 왜 이 물건인가 — 장면 근거. 운영자가 검토할 때 읽는다. */
  reason: string;
}

/** 발급까지 끝난 제휴 링크. 이 모양이 되어야 설명란에 나갈 수 있다. */
export interface AffiliateLink {
  provider: "coupang";
  /** 이 링크를 찾게 한 검색어. */
  query: string;
  /** 실제로 고른 상품명. 설명란에 사람이 읽을 이름으로 나간다. */
  productName: string;
  /** 쿠팡 상품 페이지 URL — 감사·재발급용. 설명란에는 안 나간다(제휴 링크가 아니라 정산이 안 된다). */
  productUrl?: string;
  /** 제휴 단축 URL. **설명란에 나가는 유일한 URL.** */
  url: string;
  createdAt: number;
}

/**
 * 제휴 링크 URL 검증.
 *
 * `link.coupang.com` https URL 만 통과시킨다. 공백·따옴표·꺾쇠가 섞이면 거부 —
 * DOM 에서 긁어온 값이라 앞뒤에 마크업 조각이 붙어 올 수 있고, 그게 그대로 공개
 * 설명란에 나가면 링크가 깨진 채로 발행된다.
 *
 * ⚠️ 쿠팡 **상품** URL(`www.coupang.com/vp/products/...`)은 여기서 거부된다.
 *    그건 제휴 링크가 아니라 정산이 안 되는 맨 링크다 — 붙여도 수익이 0 이라
 *    "링크는 걸렸는데 돈은 안 들어온다" 는 최악의 조용한 실패가 된다.
 */
export function isAffiliateUrl(url: unknown): boolean {
  const s = String(url ?? "").trim();
  if (!/^https:\/\/link\.coupang\.com\/[^\s"'<>\\]+$/.test(s)) return false;
  return s.length <= 200;
}

/** LLM 이 돌려준 productQueries 를 쓸 수 있는 모양으로 정리. 못 믿을 입력을 다룬다. */
export function parseProductQueries(raw: unknown): ProductQuery[] {
  if (!Array.isArray(raw)) return [];
  const out: ProductQuery[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    // 문자열만 온 경우도 받는다 — 모델이 형식을 단순화하는 일이 흔하다.
    const query = String((typeof item === "string" ? item : item?.query) ?? "")
      .replace(/\s+/g, " ")
      .trim();
    // 너무 짧으면 검색이 무의미하고, 너무 길면 쿠팡 검색이 0건을 낸다.
    if (query.length < 2 || query.length > 40) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const reason = String((typeof item === "string" ? "" : item?.reason) ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    out.push({ query, reason });
    if (out.length >= MAX_QUERIES_PER_CLIP) break;
  }
  return out;
}

/** 저장된 링크 목록에서 실제로 붙일 수 있는 것만. 형식 검증 + 중복 제거 + 상한. */
export function usableLinks(raw: unknown, max = MAX_LINKS_PER_CLIP): AffiliateLink[] {
  if (!Array.isArray(raw)) return [];
  const out: AffiliateLink[] = [];
  const seen = new Set<string>();
  for (const l of raw) {
    if (!l || typeof l !== "object") continue;
    const url = String((l as any).url ?? "").trim();
    if (!isAffiliateUrl(url) || seen.has(url)) continue;
    const productName = String((l as any).productName ?? "").replace(/\s+/g, " ").trim();
    if (!productName) continue;
    seen.add(url);
    out.push({
      provider: "coupang",
      query: String((l as any).query ?? "").trim(),
      productName,
      productUrl: (l as any).productUrl ? String((l as any).productUrl) : undefined,
      url,
      createdAt: Number((l as any).createdAt ?? 0),
    });
    if (out.length >= max) break;
  }
  return out;
}

/** 상품명이 길면 설명란이 지저분해진다. 옵션·용량 꼬리를 자른다. */
function shortenProductName(name: string, max = 40): string {
  // 쿠팡 상품명은 "브랜드 제품명, 1개, 210g" 처럼 콤마로 옵션이 붙는다 — 앞부분이 본체다.
  const head = name.split(",")[0].trim() || name.trim();
  if (head.length <= max) return head;
  const cut = head.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim();
}

/**
 * 발행 직전 설명란 조립 — 링크 묶음 + 대가성 문구를 **뒤에 붙인다.**
 *
 * 저장된 설명 본문은 건드리지 않는다. 사람이 편집 화면에서 고친 문구를 그대로 두고,
 * 상업 표기만 발행 시점에 얹는 구조라야 ① 문구가 지워질 수 없고 ② 링크 발급이 늦어도
 * 발행이 안 막힌다(링크 없으면 그냥 원문 그대로 나간다).
 *
 * **멱등**하다 — 이미 붙어 있으면 다시 붙이지 않는다. `distribution.updatemeta`(발행 후
 * 메타 수정)가 같은 설명을 다시 조립하는 경로가 있어서 필요하다.
 *
 * @param channel 채널 id. `COMMERCE_CHANNELS` 밖이면 원문을 그대로 돌려준다.
 */
export function withCommerceLinks(
  description: string,
  rawLinks: unknown,
  channel: string,
  opts: { maxLinks?: number } = {},
): string {
  const base = String(description ?? "");
  if (!commerceLinksEnabled()) return base;
  if (!COMMERCE_CHANNELS.includes(channel)) return base;
  // 이미 붙어 있다(재조립) — 문구가 두 번 나가면 그것대로 이상하다.
  if (base.includes(COUPANG_DISCLOSURE) || base.includes(COMMERCE_BLOCK_HEADER)) return base;

  const links = usableLinks(rawLinks, opts.maxLinks ?? MAX_LINKS_PER_CLIP);
  if (links.length === 0) return base;

  const lines = links.map((l) => `· ${shortenProductName(l.productName)} ${l.url}`);
  // 순서가 중요하다: 링크 → 문구. 문구가 링크보다 위에 있으면 잘렸을 때 링크만 남는다.
  const block = [COMMERCE_BLOCK_HEADER, ...lines, "", COUPANG_DISCLOSURE].join("\n");
  return base.trim() ? `${base.trim()}\n\n${block}` : block;
}
