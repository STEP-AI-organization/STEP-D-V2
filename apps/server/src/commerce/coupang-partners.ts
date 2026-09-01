/**
 * 쿠팡파트너스 링크 발급 — 로그인된 크롬에 CDP 로 붙어 콘솔 내부 API 를 호출한다.
 *
 * ## 왜 브라우저인가 (그리고 언제 없어지는가)
 *
 * 쿠팡파트너스 **공개 Open API 는 최종승인(누적 판매 15만원) 후에야 발급**된다. 승인 전에는
 * 콘솔뿐이고, 콘솔은 로그인 세션을 요구한다. 그래서 과도기 동안만 브라우저를 쓴다 —
 * 승인 후에는 서버에서 공식 딥링크 API 를 부르면 되고 이 파일은 사라진다.
 * (근거·실측: `docs/research/commerce-product-matching-probe-2026-08.md`)
 *
 * ## DOM 을 만지지 않는다
 *
 * 처음엔 화면을 몰았다 — 검색 → 카드 hover → 뜨는 '링크 생성' 버튼을 **좌표로** 클릭.
 * 됐지만 셀렉터·오버레이·좌표에 전부 의존해서 콘솔이 조금만 바뀌면 깨진다.
 * 트래픽을 떠 보니 콘솔이 하는 일은 **fetch 두 번**이 전부였다(2026-08-27 실측):
 *
 *   POST /api/v1/search            {page:{pageNumber,size}, filter:"검색어", deliveryTypes:[]}
 *   POST /api/v1/banner/iframe/url {product:{type,itemId,productId,vendorItemId,...}}
 *                                   → data.shortUrl = "https://link.coupang.com/a/XXXX"
 *
 * 그래서 지금은 **로그인된 페이지 컨텍스트 안에서 그 두 개를 직접 부른다.** DOM·hover·좌표가
 * 전부 사라져 유지보수 지점이 "이 엔드포인트 두 개"로 줄었다. 쿠키·Akamai 센서값은 진짜
 * 브라우저 것을 그대로 타므로 봇 차단도 걸리지 않는다(서버에서 직접 HTTP 를 치면 걸린다).
 *
 * ⚠️ **비공식 내부 API 다.** 예고 없이 바뀔 수 있다 — 저볼륨(회차당 몇 건) 전제로만 쓰고,
 *    승인 후 공식 API 로 갈아탄다.
 *
 * ## 절대 규칙 — 생성된 링크를 열지 않는다
 *
 * 자기 클릭은 **즉시 계정 정지** 사유다. 이 파일은 `partners.coupang.com` 밖으로 절대
 * 이동하지 않고, 방어선으로 `link.coupang.com` 으로의 문서 이동을 라우트 단계에서 막는다.
 * 링크 검증이 필요해도 열지 마라 — 형식 검증은 `commerce.ts` 가 문자열로 한다.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { isAffiliateUrl, type AffiliateLink, type ProductCandidate } from "./commerce.ts";

/**
 * 로그인된 크롬의 CDP 주소. 그 크롬은 사람이 **한 번** 로그인해 둔 전용 프로필로 떠 있어야 한다:
 *   chrome.exe --remote-debugging-port=9223 --user-data-dir=%LOCALAPPDATA%\stepd\partners-chrome-profile
 * 전용 프로필인 이유 둘 — ① 기본 프로필에는 최신 크롬이 디버그 포트를 안 열어준다
 * ② 세션이 그 프로필에만 남는다(쿠키를 서버로 올리지 않는다).
 */
const CDP_URL = process.env.COUPANG_CDP_URL || "http://127.0.0.1:9223";
const CONSOLE_ORIGIN = "https://partners.coupang.com";
/** 연속 호출 간격 — 내부 API 를 몰아치지 않는다(저볼륨 전제를 코드로 지킨다). */
const GAP_MS = Number(process.env.COUPANG_GAP_MS ?? 1200);

/** 검색 응답의 상품 한 건. 링크 발급 요청에 그대로 되돌려 줘야 하는 필드들이다. */
export interface CoupangProduct {
  productId: number;
  itemId: number;
  vendorItemId: number;
  title: string;
  image?: string;
  originPrice?: number;
  salesPrice?: number;
  deliveryBadgeImage?: string;
  travel?: boolean;
  isAdult?: boolean;
  isSoldOut?: boolean;
  ratingCount?: number;
}

/** 발급 결과 한 건 — 성공이면 link 가 채워진다. 실패도 사유와 함께 돌려준다(운영 판단용). */
export interface IssueResult {
  query: string;
  ok: boolean;
  /** 실패 사유(운영자에게 보여줄 문장). 성공 시 없음. */
  error?: string;
  link?: AffiliateLink;
  /**
   * 같은 검색어의 다른 상품 후보 — **검토 화면에서 갈아끼우라고** 남긴다.
   * 검색 응답에 이미 36개가 오므로 몇 개 보관하는 건 공짜다. 링크는 고를 때 발급한다
   * (안 쓸 후보까지 미리 발급하면 링크만 늘어난다).
   */
  candidates?: ProductCandidate[];
}

/** 검색어 + 장면 근거. 근거는 검토 화면이 "왜 이 상품인가" 를 보여주는 데 쓴다. */
export interface QueryInput {
  query: string;
  reason?: string;
}

/** 검색 결과에서 검토용으로 남길 후보 수. */
const KEEP_CANDIDATES = 4;

export class PartnersUnavailableError extends Error {
  readonly code = "partners_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "PartnersUnavailableError";
  }
}

/**
 * 주입한 세션이 죽었다 — **사람이 다시 로그인해야 한다.**
 *
 * 브라우저가 없어서 못 한 것(`PartnersUnavailableError`, 재시도 가치 있음)과 구분한다.
 * 이건 재시도해도 영원히 안 되므로, 호출부가 계정을 `session_expired` 로 표시해
 * 사람에게 보이게 만들어야 한다 — 조용히 0건 발급으로 끝나면 아무도 모른다.
 */
export class PartnersSessionExpiredError extends Error {
  readonly code = "partners_session_expired";
  constructor(message = "쿠팡파트너스 세션이 만료됐습니다 — 해당 계정으로 다시 로그인해야 합니다.") {
    super(message);
    this.name = "PartnersSessionExpiredError";
  }
}

/** 한 번의 브라우저 실행 결과. */
export interface IssueBatch {
  results: IssueResult[];
  /**
   * 실행 후의 세션. 쿠팡이 쿠키를 회전시키므로 **저장해 두면 세션이 더 오래 산다.**
   * 주입 모드에서만 값이 있다(CDP 모드는 그 크롬의 프로필이 알아서 유지한다).
   */
  storageState: unknown | null;
}

/**
 * 어떤 상품을 고를 것인가 — **결정론.**
 *
 * 검색 응답은 이미 쿠팡랭킹순이라 1위가 곧 플랫폼의 판단이다. 우리는 거기에 규칙만 더한다:
 *  - 성인용품·품절·여행상품 제외 (영상 설명란에 나가면 안 되거나 링크가 무효)
 *  - **후기 있는 상품 우선** — 후기 0건은 광고·신규 등록이라 추천에 얹기 위험하다.
 *    전부 후기 0 이면 그냥 1위를 쓴다(빈손보다 낫다).
 *
 * 순위를 LLM 에 시키지 않는 이유는 원칙이다 — 실행마다 결과가 바뀌면 측정할 수 없다.
 */
export function pickProduct(products: CoupangProduct[]): CoupangProduct | null {
  const valid = (products ?? []).filter(
    (p) => p && !p.isAdult && !p.isSoldOut && !p.travel && p.productId && p.itemId && p.title,
  );
  if (valid.length === 0) return null;
  return valid.find((p) => Number(p.ratingCount ?? 0) > 0) ?? valid[0];
}

/** 쿠팡 상품 페이지 URL — 감사용(설명란에는 안 나간다). */
function productUrlOf(p: CoupangProduct): string {
  return `https://www.coupang.com/vp/products/${p.productId}`;
}

/** 상품 → 검토 화면에 남길 후보 형태. */
function toCandidate(p: CoupangProduct): ProductCandidate {
  return {
    productId: p.productId,
    itemId: p.itemId,
    vendorItemId: p.vendorItemId,
    title: p.title,
    price: Number(p.salesPrice ?? p.originPrice ?? 0) || undefined,
    imageUrl: p.image,
    ratingCount: Number(p.ratingCount ?? 0) || undefined,
  };
}

/**
 * 파트너스 콘솔을 열어 콜백에 넘긴다. 모드가 둘이다:
 *
 *  - **세션 주입(운영 · storageState 있음)** — 크롬을 새로 띄우고 그 회사 세션을 넣는다.
 *    회사마다 계정이 다르므로(커미션 정산이 계정 단위라 계정 자체를 갈라야 한다) 잡마다
 *    해당 테넌트의 세션을 주입해 쓴다. 크롬을 N개 상시 띄워 둘 필요가 없다.
 *    (실측 2026-08-27: 빈 브라우저에 쿠키 37개만 주입하니 그 계정으로 로그인됐다.)
 *  - **CDP 접속(개발 · storageState 없음)** — 사람이 미리 로그인해 둔 크롬에 붙는다.
 *    개발기에서 손으로 확인할 때 쓴다.
 *
 * ⚠️ **headless 로 돌리지 마라.** 세션이 유효해도 Akamai 가 막는다(실측: 쿠키를 정상 주입한
 *    headless 크롬이 Access Denied HTML 을 받았고, 같은 세션의 headed 크롬은 통과했다).
 *    봇 판정은 쿠키가 아니라 브라우저 자체를 본다 — 그래서 이 잡은 화면이 있는 PC 에서만 돈다.
 *
 * 연결·자기클릭 방어선·shim·로그인 확인이 전부 여기 한 번에 있다 — 두 벌이 되면 한쪽만 고쳐진다.
 */
async function withPartnersPage<T>(
  storageState: unknown | null,
  fn: (page: Page) => Promise<T>,
): Promise<{ result: T; storageState: unknown | null }> {
  const inject = storageState != null;
  let browser: Browser;
  let ctx: BrowserContext;
  let ownsBrowser = false;

  if (inject) {
    try {
      browser = await chromium.launch({
        channel: "chrome",
        headless: false,   // ⚠️ 위 주석 참조 — headless 는 세션이 유효해도 차단된다.
        args: ["--disable-blink-features=AutomationControlled"],
      });
      ownsBrowser = true;
      ctx = await browser.newContext({
        storageState: storageState as any,
        locale: "ko-KR",
        timezoneId: "Asia/Seoul",
        viewport: { width: 1280, height: 900 },
      });
    } catch (e) {
      throw new PartnersUnavailableError(
        "크롬을 띄우지 못했습니다. 이 잡은 **화면이 있는 PC**에서만 돕니다(headless 는 봇 차단). " +
          `원인: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  } else {
    try {
      browser = await chromium.connectOverCDP(CDP_URL, { timeout: 10_000 });
    } catch (e) {
      throw new PartnersUnavailableError(
        `쿠팡파트너스 브라우저에 붙지 못했습니다 (${CDP_URL}). ` +
          "전용 프로필 크롬이 --remote-debugging-port 로 떠 있고 파트너스에 로그인돼 있어야 합니다. " +
          `원인: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const existing = browser.contexts()[0];
    if (!existing) throw new PartnersUnavailableError("브라우저 컨텍스트가 없습니다 (크롬이 막 떴을 수 있습니다).");
    ctx = existing;
  }

  try {
    const page: Page =
      ctx.pages().find((p) => p.url().startsWith(CONSOLE_ORIGIN)) ?? (await ctx.newPage());

    // 방어선 — **제휴 리다이렉트 호스트로 나가는 요청을 통째로 막는다.**
    //
    // 우리 코드는 goto 하지 않지만, 콘솔 자신이 링크를 만들면 미리보기 배너 `<iframe
    // src="https://coupa.ng/...">` 를 렌더한다 — 그 iframe 로드가 곧 제휴 리다이렉트를
    // 타는 것이라 **클릭으로 집계될 수 있다**(2026-08-27 실측: DOM 방식으로 링크를 만들던
    // 초기 실험 횟수만큼 리포트에 클릭이 찍혀 있었다. API 전용 경로에서는 안 늘었다).
    // 자기 클릭은 계정 정지 사유라, 이동뿐 아니라 **하위 리소스 요청까지** 끊는다.
    // 우리 흐름은 이 호스트가 전혀 필요 없으므로 막아서 잃는 게 없다.
    await page.route(/(^|\/\/|\.)((link\.coupang\.com)|(coupa\.ng))\//, (route) => {
      console.warn("[coupang] 제휴 리다이렉트 차단 — 자기 클릭은 계정 정지 사유다:", route.request().url());
      return route.abort();
    });

    if (!page.url().startsWith(CONSOLE_ORIGIN)) {
      await page.goto(`${CONSOLE_ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(2500);
    }

    await installNameShim(page);

    // 로그인 확인 — 비로그인이면 API 가 200 에 **빈 데이터**를 준다(rCode 는 0 인데 계정 정보가
    // 없다). 그래서 rCode 만 보면 안 되고 계정 신원(email)이 있는지까지 봐야 한다.
    const who = await page.evaluate(async () => {
      try {
        const r = await fetch("/api/v1/config", { credentials: "include" });
        const j = (await r.json()) as any;
        return { rCode: j?.rCode ?? null, email: j?.data?.settings?.email ?? null };
      } catch {
        return { rCode: null, email: null };
      }
    });
    if (!who.email) {
      // 주입 모드면 세션이 죽은 것이고(사람이 재로그인), CDP 모드면 아직 로그인을 안 한 것이다.
      if (inject) throw new PartnersSessionExpiredError();
      throw new PartnersUnavailableError(
        "쿠팡파트너스에 로그인돼 있지 않습니다. 전용 프로필 크롬에서 사람이 1회 로그인해야 합니다.",
      );
    }

    const result = await fn(page);
    // 쿠키가 회전하므로 실행 후 상태를 돌려준다 — 저장해 두면 세션이 더 오래 산다.
    const fresh = inject ? await ctx.storageState().catch(() => null) : null;
    return { result, storageState: fresh };
  } finally {
    // 주입 모드는 우리가 띄웠으니 닫는다. CDP 모드는 **붙은 것**이라 close() 가 연결만 끊고
    // 사람이 로그인해 둔 크롬은 그대로 살아 있다(다음 잡이 다시 붙는다).
    if (ownsBrowser) await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/**
 * 검색어 목록 → 제휴 링크 + 대체 후보. 실패한 건은 `ok:false` 로 함께 돌려준다
 * (전체를 던지지 않는다 — 5개 중 1개가 0건이라고 나머지 4개를 버릴 이유가 없다).
 *
 * 발급된 링크는 **status 가 붙지 않은 채로** 나간다 — 승인은 사람이 하는 별개 단계다
 * (`commerce.ts` 의 `normalizeStatus` 가 그런 링크를 `pending` 으로 읽는다).
 */
export async function issueCoupangLinks(
  queries: (string | QueryInput)[],
  /** 이 회사의 로그인 세션. 없으면 개발용 CDP 모드로 떨어진다. */
  storageState: unknown | null = null,
): Promise<IssueBatch> {
  const seen = new Set<string>();
  const wanted: QueryInput[] = [];
  for (const q of queries) {
    const query = String((typeof q === "string" ? q : q?.query) ?? "").trim();
    if (!query || seen.has(query.toLowerCase())) continue;
    seen.add(query.toLowerCase());
    wanted.push({ query, reason: typeof q === "string" ? undefined : q?.reason });
  }
  if (wanted.length === 0) return { results: [], storageState: null };

  const out = await withPartnersPage(storageState, async (page) => {
    const acc: IssueResult[] = [];
    for (const q of wanted) {
      try {
        acc.push(await issueOne(page, q));
      } catch (e) {
        acc.push({ query: q.query, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      await page.waitForTimeout(GAP_MS);
    }
    return acc;
  });
  return { results: out.result, storageState: out.storageState };
}

/**
 * 후보 하나를 지정해 링크를 발급한다 — 검토 화면의 **"이거 말고 저거"**(교체) 경로.
 * 검색을 다시 하지 않는다: 후보에 발급에 필요한 식별자가 이미 다 들어 있다.
 */
export async function issueLinkForCandidate(
  candidate: ProductCandidate,
  query: string,
  reason?: string,
  storageState: unknown | null = null,
): Promise<{ result: IssueResult; storageState: unknown | null }> {
  if (!candidate?.productId || !candidate?.itemId) {
    return {
      result: { query, ok: false, error: "후보 상품 정보가 불완전합니다 (productId·itemId 필요)" },
      storageState: null,
    };
  }
  return withPartnersPage(storageState, async (page) => {
    const product: CoupangProduct = {
      productId: candidate.productId,
      itemId: candidate.itemId,
      vendorItemId: candidate.vendorItemId,
      title: candidate.title,
      image: candidate.imageUrl,
      salesPrice: candidate.price,
      originPrice: candidate.price,
    };
    return generateLink(page, product, query, reason);
  });
}

/**
 * `page.evaluate` 로 보낼 함수가 esbuild 변환을 거쳐도 깨지지 않게 하는 shim.
 *
 * ⚠️ **실측 버그 (2026-08-27)**. 워커는 프로덕션에서도 tsx(esbuild)로 돈다(`pnpm worker`).
 * esbuild 의 `keepNames` 는 이름이 붙는 함수마다 `__name(fn, "…")` 래퍼를 씌우는데,
 * `page.evaluate` 는 함수를 **소스 문자열로 직렬화해 브라우저로 보낸다** — 브라우저에는
 * 그 헬퍼가 없으니 `ReferenceError: __name is not defined` 로 통째로 실패한다.
 * 유닛 테스트로는 절대 안 잡힌다(브라우저가 없으니까). 실제 모듈 스모크에서 잡혔다.
 *
 * 그래서 **문자열 evaluate**(문자열은 변환을 안 거친다)로 헬퍼를 먼저 심어 둔다.
 * 이미 있으면 덮지 않는다.
 */
async function installNameShim(page: Page): Promise<void> {
  await page.evaluate("globalThis.__name = globalThis.__name || function (f) { return f; }");
}

/** 검색어 하나 → 상품 선택 → 링크 발급 + 대체 후보 보관. 페이지 컨텍스트 안에서 fetch 두 번. */
async function issueOne(page: Page, input: QueryInput): Promise<IssueResult> {
  const query = input.query;
  // ⚠️ evaluate 콜백 안에 **이름 붙는 내부 함수를 만들지 마라**(`const post = () => …`).
  //    esbuild 가 __name 래퍼를 씌워 브라우저에서 터진다 — installNameShim 이 방어선이지만,
  //    애초에 안 만드는 쪽이 안전하다. 인자로 넘기는 익명 화살표는 이름이 없어 괜찮다.
  const res = await page.evaluate(async (q: string) => {
    const r = await fetch("/api/v1/search", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ page: { pageNumber: 0, size: 36 }, filter: q, deliveryTypes: [] }),
    });
    const j = (await r.json().catch(() => null)) as any;
    return {
      status: r.status,
      rCode: j?.rCode,
      rMessage: j?.rMessage,
      products: (j?.data?.products ?? []) as CoupangProduct[],
    };
  }, query);

  if (res.status !== 200 || res.rCode !== "0") {
    return { query, ok: false, error: `검색 실패 (status ${res.status} · rCode ${res.rCode ?? "?"} ${res.rMessage ?? ""})`.trim() };
  }
  const product = pickProduct(res.products);
  if (!product) return { query, ok: false, error: "검색 결과에 걸 만한 상품이 없습니다" };

  // 검토 화면이 갈아끼울 수 있게 유효 후보를 남긴다.
  // ⚠️ **지금 고른 상품도 목록에 포함한다.** 빼면 다른 걸로 바꿨다가 되돌아올 수 없다
  //    (발급에 필요한 itemId·vendorItemId 를 잃는다). 어느 게 현재인지는 링크의
  //    productId 로 알 수 있으므로 목록에 남겨 두는 편이 항상 안전하다.
  const valid = res.products.filter(
    (p) => p && !p.isAdult && !p.isSoldOut && !p.travel && p.productId && p.itemId && p.title,
  );
  const candidates = [product, ...valid.filter((p) => p.productId !== product.productId)]
    .slice(0, KEEP_CANDIDATES)
    .map(toCandidate);

  const out = await generateLink(page, product, query, input.reason);
  return { ...out, candidates };
}

/** 상품 하나 → 제휴 단축 URL. 검색 없이 발급만 한다(교체 경로도 이걸 쓴다). */
async function generateLink(
  page: Page,
  product: CoupangProduct,
  query: string,
  reason?: string,
): Promise<IssueResult> {
  const gen = await page.evaluate(async (p: CoupangProduct) => {
    const r = await fetch("/api/v1/banner/iframe/url", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        product: {
          type: "PRODUCT",
          itemId: p.itemId,
          productId: p.productId,
          vendorItemId: p.vendorItemId,
          image: p.image,
          title: p.title,
          originPrice: p.originPrice,
          salesPrice: p.salesPrice,
          deliveryBadgeImage: p.deliveryBadgeImage,
          travel: false,
        },
      }),
    });
    const j = (await r.json().catch(() => null)) as any;
    return { status: r.status, rCode: j?.rCode, rMessage: j?.rMessage, shortUrl: j?.data?.shortUrl ?? null };
  }, product);

  if (gen.status !== 200 || gen.rCode !== "0" || !gen.shortUrl) {
    return {
      query,
      ok: false,
      error: `링크 발급 실패 (status ${gen.status} · rCode ${gen.rCode ?? "?"} ${gen.rMessage ?? ""})`.trim(),
    };
  }
  // 형식 검증 — 여기를 통과 못 한 값은 절대 설명란으로 못 간다(commerce.ts 가 다시 본다).
  if (!isAffiliateUrl(gen.shortUrl)) {
    return { query, ok: false, error: `제휴 링크 형식이 아닙니다: ${String(gen.shortUrl).slice(0, 80)}` };
  }

  return {
    query,
    ok: true,
    link: {
      provider: "coupang",
      query,
      reason,
      productName: product.title,
      productUrl: productUrlOf(product),
      productId: product.productId,
      price: Number(product.salesPrice ?? product.originPrice ?? 0) || undefined,
      imageUrl: product.image,
      url: gen.shortUrl,
      // status 를 붙이지 않는다 — 승인은 사람의 별개 단계다(읽는 쪽이 pending 으로 본다).
      createdAt: Date.now(),
    },
  };
}
