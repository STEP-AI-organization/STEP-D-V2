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
import { chromium, type Browser, type Page } from "playwright";
import { isAffiliateUrl, type AffiliateLink } from "./commerce.ts";

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

/** 발급 결과 한 건 — 성공이면 url 이 채워진다. 실패도 사유와 함께 돌려준다(운영 판단용). */
export interface IssueResult {
  query: string;
  ok: boolean;
  reason?: string;
  link?: AffiliateLink;
}

export class PartnersUnavailableError extends Error {
  readonly code = "partners_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "PartnersUnavailableError";
  }
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

/**
 * 검색어 목록 → 제휴 링크. 실패한 건은 `ok:false` 로 함께 돌려준다(전체를 던지지 않는다) —
 * 5개 중 1개가 0건이라고 나머지 4개를 버릴 이유가 없다.
 */
export async function issueCoupangLinks(queries: string[]): Promise<IssueResult[]> {
  const wanted = [...new Set(queries.map((q) => String(q ?? "").trim()).filter(Boolean))];
  if (wanted.length === 0) return [];

  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL, { timeout: 10_000 });
  } catch (e) {
    throw new PartnersUnavailableError(
      `쿠팡파트너스 브라우저에 붙지 못했습니다 (${CDP_URL}). ` +
        "전용 프로필 크롬이 --remote-debugging-port 로 떠 있고 파트너스에 로그인돼 있어야 합니다. " +
        `원인: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  try {
    const ctx = browser.contexts()[0];
    if (!ctx) throw new PartnersUnavailableError("브라우저 컨텍스트가 없습니다 (크롬이 막 떴을 수 있습니다).");

    const page: Page =
      ctx.pages().find((p) => p.url().startsWith(CONSOLE_ORIGIN)) ?? (await ctx.newPage());

    // 방어선 — 제휴 링크로의 **문서 이동**을 아예 막는다. 우리 코드는 goto 하지 않지만,
    // 콘솔 스크립트나 미래의 실수로도 자기 클릭이 나가지 않게 못을 박는다.
    await page.route("**://link.coupang.com/**", (route) => {
      const req = route.request();
      if (req.isNavigationRequest()) {
        console.warn("[coupang] 제휴 링크 이동 차단 — 자기 클릭은 계정 정지 사유다:", req.url());
        return route.abort();
      }
      return route.continue();
    });

    if (!page.url().startsWith(CONSOLE_ORIGIN)) {
      await page.goto(`${CONSOLE_ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(2500);
    }

    await installNameShim(page);

    // 로그인 확인 — 비로그인이면 API 가 200 에 빈 데이터를 주기도 해서 원인이 안 보인다.
    const signedIn = await page.evaluate(async () => {
      try {
        const r = await fetch("/api/v1/config", { credentials: "include" });
        const j = (await r.json()) as any;
        return j?.rCode === "0" && !!j?.data;
      } catch {
        return false;
      }
    });
    if (!signedIn) {
      throw new PartnersUnavailableError(
        "쿠팡파트너스에 로그인돼 있지 않습니다. 전용 프로필 크롬에서 사람이 1회 로그인해야 합니다.",
      );
    }

    const out: IssueResult[] = [];
    for (const query of wanted) {
      try {
        out.push(await issueOne(page, query));
      } catch (e) {
        out.push({ query, ok: false, reason: e instanceof Error ? e.message : String(e) });
      }
      await page.waitForTimeout(GAP_MS);
    }
    return out;
  } finally {
    // connectOverCDP 는 **붙은 것**이지 띄운 게 아니다 — close() 는 연결만 끊고
    // 사람이 로그인해 둔 크롬은 그대로 살아 있다(다음 잡이 다시 붙는다).
    await browser.close().catch(() => {});
  }
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

/** 검색어 하나 → 상품 선택 → 링크 발급. 페이지 컨텍스트 안에서 fetch 두 번. */
async function issueOne(page: Page, query: string): Promise<IssueResult> {
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
    return { query, ok: false, reason: `검색 실패 (status ${res.status} · rCode ${res.rCode ?? "?"} ${res.rMessage ?? ""})`.trim() };
  }
  const product = pickProduct(res.products);
  if (!product) return { query, ok: false, reason: "검색 결과에 걸 만한 상품이 없습니다" };

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
      reason: `링크 발급 실패 (status ${gen.status} · rCode ${gen.rCode ?? "?"} ${gen.rMessage ?? ""})`.trim(),
    };
  }
  // 형식 검증 — 여기를 통과 못 한 값은 절대 설명란으로 못 간다(commerce.ts 가 다시 본다).
  if (!isAffiliateUrl(gen.shortUrl)) {
    return { query, ok: false, reason: `제휴 링크 형식이 아닙니다: ${String(gen.shortUrl).slice(0, 80)}` };
  }

  return {
    query,
    ok: true,
    link: {
      provider: "coupang",
      query,
      productName: product.title,
      productUrl: productUrlOf(product),
      url: gen.shortUrl,
      createdAt: Date.now(),
    },
  };
}
