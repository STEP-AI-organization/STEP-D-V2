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

// ── 제휴 제공자 레지스트리 ────────────────────────────────────────────────────
//
// 제공자가 늘어날 수 있다(2026-08-31: 토스쇼핑 쉐어링크 검토 — 수수료 10% 로 쿠팡보다 높다).
// 그래서 "쿠팡" 이 코드 곳곳에 박히지 않게 여기 한 곳으로 모은다.
//
// ▶ **제공자 추가 = 아래 항목 1개 + 발급기 1개 + 세션 등록.** 절차:
//   1) `COMMERCE_PROVIDERS` 에 { id, label, disclosure, linkPattern } 한 줄 추가
//   2) 발급기 모듈 작성 (쿠팡은 `coupang-partners.ts` — 로그인된 크롬에 CDP 로 붙어
//      콘솔 내부 API 호출). 워커 `commerce.link` 잡에서 provider 로 갈라 부른다
//   3) 회사별 계정 세션 등록 (`commerce_account` · provider 컬럼이 이미 있다)
// 그 외(URL 검증·문구·설명란 조립)는 이 레지스트리를 순회하므로 건드릴 필요 없다.
//
// ⚠️ **대가성 문구는 우리가 짓지 않는다.** 그 제공자 화면이 "이 문장을 기재하라" 고
//    명시한 원문을 그대로 옮긴다 — 공정위 심사지침과 각 사 약관이 걸린 자리다.
//    문구를 확인하지 못한 제공자는 **레지스트리에 넣지 않는다**(넣는 순간 그 문구로 발행된다).
export type CommerceProviderId = "coupang";

export interface CommerceProvider {
  id: CommerceProviderId;
  /** 화면·로그에 보이는 이름. */
  label: string;
  /** 대가성 문구 — 제공자가 명시한 **원문 그대로**. */
  disclosure: string;
  /**
   * 제휴 링크로 인정할 URL 모양.
   * ⚠️ **상품 페이지 URL 은 반드시 제외한다.** 그건 정산이 안 되는 맨 링크라,
   *    붙여도 수익이 0 이면서 "링크는 걸렸다" 로 보이는 조용한 실패가 된다.
   */
  linkPattern: RegExp;
}

export const COMMERCE_PROVIDERS: readonly CommerceProvider[] = [
  {
    id: "coupang",
    label: "쿠팡 파트너스",
    // 실측(2026-08-26 · 파트너스 콘솔 "링크 생성" 화면 *활동 시 주의 사항*):
    //   "게시글 작성 시, 아래 문구를 반드시 기재해 주세요."
    disclosure: "이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.",
    // 공백·따옴표·꺾쇠가 섞이면 거부 — DOM 에서 긁어온 값이라 앞뒤에 마크업 조각이 붙어
    // 올 수 있고, 그게 그대로 공개 설명란에 나가면 링크가 깨진 채로 발행된다.
    linkPattern: /^https:\/\/link\.coupang\.com\/[^\s"'<>\\]+$/,
  },
];

/** 하위호환 — 예전 이름을 쓰는 곳(테스트·문서)이 있어 남긴다. 정본은 레지스트리다. */
export const COUPANG_DISCLOSURE = COMMERCE_PROVIDERS[0].disclosure;

export function providerById(id: unknown): CommerceProvider | undefined {
  return COMMERCE_PROVIDERS.find((p) => p.id === String(id ?? ""));
}

/** URL 이 어느 제공자의 제휴 링크인가. 아무 데도 안 맞으면 undefined(= 안 나간다). */
export function providerOfUrl(url: unknown): CommerceProvider | undefined {
  const s = String(url ?? "").trim();
  if (s.length > 200) return undefined;
  return COMMERCE_PROVIDERS.find((p) => p.linkPattern.test(s));
}

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

/**
 * 링크의 승인 상태. **`approved` 만 설명란에 나간다.**
 *
 * 기본값이 `pending` 인 것이 이 기능의 안전 방향이다 — 아무도 안 본 링크가 방송사 채널에
 * 나가는 것보다, 검토가 밀려 링크가 안 붙는 쪽이 낫다. 자동화는 **찾아 놓는 일**까지 하고,
 * 무엇을 실제로 걸지는 사람이 정한다(부담은 자동이, 판단은 사람이).
 */
export type LinkStatus = "pending" | "approved" | "rejected";

/** 발급까지 끝난 제휴 링크. `approved` 여야 설명란에 나간다. */
export interface AffiliateLink {
  /** 어느 제휴 제공자의 링크인가 — URL 모양으로 판정한다(레지스트리). */
  provider: CommerceProviderId;
  /** 이 링크를 찾게 한 검색어. */
  query: string;
  /** 이 검색어가 나온 장면 근거 — 검토 화면에서 "왜 이 상품인가"를 설명한다. */
  reason?: string;
  /** 실제로 고른 상품명. 설명란에 사람이 읽을 이름으로 나간다. */
  productName: string;
  /** 쿠팡 상품 페이지 URL — 감사·재발급용. 설명란에는 안 나간다(제휴 링크가 아니라 정산이 안 된다). */
  productUrl?: string;
  /** 상품 식별자 — 후보 교체(pick)와 중복 판정에 쓴다. */
  productId?: number;
  /** 판매가·썸네일 — 검토 화면이 "이게 맞나"를 판단할 재료다. 설명란에는 안 나간다. */
  price?: number;
  imageUrl?: string;
  /** 제휴 단축 URL. **설명란에 나가는 유일한 URL.** */
  url: string;
  /** 승인 상태. 없으면 `pending` 으로 본다(옛 데이터 방어 — 모르는 건 안 내보낸다). */
  status?: LinkStatus;
  /** 누가 언제 상태를 정했나 — 방송사 채널에 나가는 판단이라 기록이 필요하다. */
  decidedBy?: string;
  decidedAt?: number;
  createdAt: number;
}

/** 검토 화면에서 "이거 말고 저거" 를 고를 수 있게 남겨 두는 후보. 링크는 고를 때 발급한다. */
export interface ProductCandidate {
  productId: number;
  itemId: number;
  vendorItemId: number;
  title: string;
  price?: number;
  imageUrl?: string;
  ratingCount?: number;
}

/** 상태 정규화 — 모르는 값·빈값은 전부 `pending`(= 안 나간다). */
export function normalizeStatus(v: unknown): LinkStatus {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "approved" || s === "rejected" ? s : "pending";
}

/**
 * 제휴 링크 URL 검증 — **등록된 제공자 중 하나의 링크 모양**이어야 통과한다.
 *
 * ⚠️ 상품 페이지 URL(예: `www.coupang.com/vp/products/...`)은 거부된다.
 *    그건 제휴 링크가 아니라 정산이 안 되는 맨 링크다 — 붙여도 수익이 0 이라
 *    "링크는 걸렸는데 돈은 안 들어온다" 는 최악의 조용한 실패가 된다.
 */
export function isAffiliateUrl(url: unknown): boolean {
  return providerOfUrl(url) !== undefined;
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

/**
 * 저장된 링크 목록에서 **형식이 성립하는 것 전부** — 상태는 안 본다.
 * 검토 화면이 쓰는 목록이다(거절된 것도 보여야 사람이 되돌릴 수 있다).
 * 실제로 설명란에 나갈 것은 `approvedLinks()` 로 따로 거른다.
 */
export function usableLinks(raw: unknown, max = MAX_LINKS_PER_CLIP): AffiliateLink[] {
  if (!Array.isArray(raw)) return [];
  const out: AffiliateLink[] = [];
  const seen = new Set<string>();
  for (const l of raw) {
    if (!l || typeof l !== "object") continue;
    const url = String((l as any).url ?? "").trim();
    // 제공자는 **URL 이 정한다** — 저장된 provider 필드를 믿지 않는다. 필드는 옛 데이터에
    // 없거나 틀릴 수 있고, 그러면 엉뚱한 제공자의 대가성 문구가 붙는다.
    const provider = providerOfUrl(url);
    if (!provider || seen.has(url)) continue;
    const productName = String((l as any).productName ?? "").replace(/\s+/g, " ").trim();
    if (!productName) continue;
    seen.add(url);
    const num = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
    out.push({
      provider: provider.id,
      query: String((l as any).query ?? "").trim(),
      reason: (l as any).reason ? String((l as any).reason).slice(0, 200) : undefined,
      productName,
      productUrl: (l as any).productUrl ? String((l as any).productUrl) : undefined,
      productId: num((l as any).productId),
      price: num((l as any).price),
      imageUrl: (l as any).imageUrl ? String((l as any).imageUrl) : undefined,
      url,
      status: normalizeStatus((l as any).status),
      decidedBy: (l as any).decidedBy ? String((l as any).decidedBy).slice(0, 120) : undefined,
      decidedAt: num((l as any).decidedAt),
      createdAt: Number((l as any).createdAt ?? 0),
    });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * **설명란에 실제로 나갈 링크.** 승인된 것만.
 *
 * 여기가 "우리가 조절한다"의 코드상 실체다. 발급(자동)과 게시(사람 승인)를 갈라 놓아,
 * 파이프라인이 상품을 잘못 골라도 그게 곧바로 방송사 채널로 나가지 않는다.
 */
export function approvedLinks(raw: unknown, max = MAX_LINKS_PER_CLIP): AffiliateLink[] {
  return usableLinks(raw, Number.MAX_SAFE_INTEGER)
    .filter((l) => l.status === "approved")
    .slice(0, max);
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
 * **승인된 링크만 붙는다.** 미검토(pending)·거절(rejected)은 없는 것처럼 다룬다 —
 * 사람이 확인하지 않은 상품이 방송사 채널에 나가지 않게 하는 것이 이 함수의 마지막 방어선이다.
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
  if (COMMERCE_PROVIDERS.some((p) => base.includes(p.disclosure))
      || base.includes(COMMERCE_BLOCK_HEADER)) return base;

  const links = approvedLinks(rawLinks, opts.maxLinks ?? MAX_LINKS_PER_CLIP);
  if (links.length === 0) return base;

  const lines = links.map((l) => `· ${shortenProductName(l.productName)} ${l.url}`);
  // **실제로 붙은 링크의 제공자 문구만** 넣는다. 안 쓴 제공자의 문구가 나가면 거짓 고지고,
  // 쓴 제공자의 문구가 빠지면 미고지다 — 둘 다 약관·심사지침 위반 쪽이라 링크에서 역산한다.
  const disclosures = [...new Set(links.map((l) => l.provider))]
    .map((id) => providerById(id)?.disclosure)
    .filter((d): d is string => !!d);
  // 순서가 중요하다: 링크 → 문구. 문구가 링크보다 위에 있으면 잘렸을 때 링크만 남는다.
  const block = [COMMERCE_BLOCK_HEADER, ...lines, "", ...disclosures].join("\n");
  return base.trim() ? `${base.trim()}\n\n${block}` : block;
}
