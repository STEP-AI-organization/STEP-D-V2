/**
 * 웹 스모크 — 진짜 크롬이 진짜 프로덕션 빌드를 연다.
 *
 * 띄우고 정리하는 건 `scripts/smoke.mts` 가 한다. 여기는 **묻는 것만** 있다.
 * 실행: `pnpm --filter @stepd/web smoke`
 *
 * ## 여기 무엇을 넣고 무엇을 안 넣나
 *
 * 넣는 것은 **브라우저 없이는 증명할 수 없는 것**뿐이다:
 *   · 미들웨어가 실제로 리다이렉트하는가 (엣지 런타임은 빌드해야만 돈다)
 *   · 스토어가 부팅·폴링에서 **어느 엔드포인트를 부르는가**
 *   · 304 를 받았을 때 화면이 빈 상태로 되돌아가지 않는가
 *
 * **화면의 글자·DOM 은 안 본다.** 프론트가 개편 중이라 셀렉터에 걸면 매주 빨개지고,
 * 그러면 사람이 무시하게 된다. 순수 함수로 증명되는 것도 여기 넣지 않는다 — 단위 테스트가
 * 훨씬 빠르다.
 *
 * ⚠️ `*.smoke.ts` 확장자는 의도적이다. `pnpm test` 는 `src/**\/*.test.ts` 를 돌리므로
 *    이 파일은 거기 안 끼어든다(거긴 브라우저도 서버도 없다).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser, type Page } from "playwright";

const BASE = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:4300";

/**
 * 번들에 박힌 `NEXT_PUBLIC_API_URL` 과 **같아야 한다** — 라우트 가로채기가 이 접두사로 걸린다.
 * 짝은 `scripts/smoke.mts` 의 `API_BASE`.
 *
 * ⚠️ **env 로 받지 않는다.** 처음엔 `process.env.SMOKE_API_BASE` 로 넘겼는데, Git Bash 에서
 * 직접 돌리면 MSYS 경로 변환이 `/api/proxy/api` 를 `C:/Program Files/Git/api/proxy/api` 로
 * 바꿔 버린다. 그러면 패턴이 아무것도 안 잡는데 **에러는 안 나고** 그냥 "요청이 없다" 로
 * 보인다 — 원인이 테스트 코드에 없어서 찾는 데 오래 걸리는 종류다.
 * (같은 함정이 Cloud Run env 갱신에서도 났다 — 그래서 그쪽은 PowerShell 로 한다.)
 */
const API = "/api/proxy/api";

/** 서버가 굽는 세션 쿠키. 미들웨어는 **있는지만** 본다. */
const SESSION_COOKIE = "stepd_session";

/**
 * 조건이 참이 될 때까지 기다린다. **`waitUntil: "networkidle"` 을 쓰지 말 것.**
 *
 * 처음에 그걸로 "앱이 떴다" 를 판정했는데 틀렸다 — networkidle 은 "500ms 동안 조용했다" 라서,
 * HTML·청크를 받은 뒤 **하이드레이션이 끝나 fetch 가 나가기 전**의 조용한 틈에 먼저 걸린다
 * (실측 1.1초 만에 반환 · 그 시점 요청 기록은 비어 있었다). 기다려야 하는 것은 정적인
 * "조용함" 이 아니라 **일어나기를 바라는 그 일** 자체다.
 */
async function waitFor(what: string, cond: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${timeoutMs}ms 안에 일어나지 않았다: ${what}`);
}

/**
 * 부팅 때 스토어가 같이 부르는 것들. **모양이 맞아야 한다.**
 *
 * 처음엔 이걸 안 두고 나머지를 전부 `{}` 로 채웠는데, `store.tsx` 의 연결 상태 조회가
 * `youtube.some(...)`·`naver.accounts.some(...)` 을 부르면서 **페이지가 예외를 던졌다.**
 * 그쪽 코드에 `.catch(() => [])` 가 달려 있어 안전해 보이지만, 그건 **거절만** 잡는다 —
 * 200 인데 모양이 다른 응답은 그대로 통과해 `.some` 에서 터진다.
 *
 * 스모크가 이걸 흉내내야 하는 이유는 하나다: 그 예외가 나면 트리가 언마운트되면서
 * **폴링 루프도 같이 죽어**, 정작 재려던 것이 "안 도는 것" 처럼 보인다.
 */
const BOOT_STUBS: Record<string, unknown> = {
  // ⚠️ 전부 **감싼 모양**이다(`{channels}`·`{accounts}`). 배열을 그대로 주면
  //    `data.channels` 가 undefined 가 되어 `.some` 에서 터진다 — 실제로 그렇게 한 번 헤맸다.
  //    (`fetchNaverAccounts` 만 `?? []` 로 방어하고 유튜브·Meta·TikTok 은 안 한다.)
  "/youtube/channels": { channels: [] },
  "/meta/accounts": { accounts: [] },
  "/tiktok/accounts": { accounts: [] },
  "/naver/accounts": { accounts: [], sessionStoreReady: false },
  "/credits": { balance: 0, currency: "KRW" },
  "/health": { ok: true },
};

/** 회차 하나짜리 최소 상태. `pipeline` 만 바꿔 유휴/활성을 만든다. */
function stateFixture(stageStatus: "idle" | "progress") {
  return {
    programs: [{ id: "p1", title: "스모크 프로그램" }],
    episodes: [{
      id: "e1",
      programId: "p1",
      title: "1회",
      pipeline: { stage: "analyze", stageStatus, progress: stageStatus === "progress" ? 42 : undefined },
    }],
    recommendations: [],
    clips: [],
    jobs: [],
    connections: { youtube: false, instagram: false, facebook: false, tiktok: false },
    media: [],
  };
}

describe("smoke — 로그인 관문 (미들웨어)", () => {
  let browser: Browser;

  before(async () => { browser = await chromium.launch(); });
  after(async () => { await browser?.close(); });

  it("세션 쿠키가 없으면 보호 화면에서 로그인으로 보낸다", async () => {
    // 미들웨어는 **빌드된 엣지 런타임에서만** 돈다 — 유닛 테스트로는 증명이 안 되는 자리다.
    const page = await browser.newPage();
    try {
      // **보호 경로**여야 한다 — 공개 경로로 재면 리다이렉트가 안 일어나는 게 정상이라 늘 통과한다.
      const res = await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
      assert.ok(res, "응답이 없다");
      assert.match(
        page.url(),
        /\/login\?next=%2Fdashboard$/,
        `로그인으로 안 보냈다 (지금 URL: ${page.url()})`,
      );
    } finally {
      await page.close();
    }
  });

  it("공개 경로는 그대로 열린다 — 로그인 화면이 자기 자신으로 리다이렉트되면 무한루프다", async () => {
    const page = await browser.newPage();
    try {
      for (const p of ["/login", "/terms", "/privacy"]) {
        const res = await page.goto(`${BASE}${p}`, { waitUntil: "domcontentloaded" });
        assert.equal(res?.status(), 200, `${p} 가 200 이 아니다 (${res?.status()})`);
        assert.ok(page.url().endsWith(p), `${p} 에서 ${page.url()} 로 튕겼다`);
      }
    } finally {
      await page.close();
    }
  });
});

/**
 * 스토어 폴링은 **화면이 아니라 루트 레이아웃**에 있다(`AppDataProvider`). 그래서 데이터에
 * 굶주린 화면을 열 필요가 없고, **열면 안 된다**:
 *
 * 처음엔 `/dashboard` 에서 쟀는데 스모크가 계속 "폴링이 안 돈다" 고 나왔다. 원인은 제품이
 * 아니라 **테스트 fixture** 였다 — 최소 상태에 없는 필드를 화면이 읽다가
 * `Cannot read properties of undefined (reading 'toLocaleString')` 로 크래시했고,
 * 트리가 언마운트되면서 폴링 효과도 같이 죽었다. 그러면 증상이 "폴링 버그" 로 보인다.
 *
 * 그래서 폴링은 **`/login`** 에서 잰다. 공개 경로라 미들웨어와 무관하고, 화면이 스토어
 * 데이터를 안 쓰므로 fixture 를 실물처럼 채울 필요가 없다. 재는 대상(어느 엔드포인트를
 * 부르는가)은 어느 경로에서나 같다.
 *
 * ⚠️ 화면이 **실제 데이터로 안 깨지는지**는 여기서 증명되지 않는다. 그건 실물에 가까운
 *    fixture 가 필요하고, 프론트 개편이 끝난 뒤에 별도로 붙이는 게 맞다.
 */
const POLL_PAGE = "/login";

describe("smoke — 스토어가 부르는 것 (부팅 · 폴링)", () => {
  let browser: Browser;

  before(async () => { browser = await chromium.launch(); });
  after(async () => { await browser?.close(); });

  /**
   * 로그인된 페이지 하나. API 는 전부 가로채고, `/api/state*` 호출만 기록한다.
   *
   * `calls` 는 경로만 담는다 — 이 스모크가 묻는 건 "무엇을 불렀나" 지 "무엇을 받았나" 가 아니다.
   */
  async function loggedInPage(opts: { stageStatus: "idle" | "progress" }) {
    const page = await browser.newPage();
    const calls: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.context().addCookies([{
      name: SESSION_COOKIE, value: "smoke-not-a-real-session",
      domain: "127.0.0.1", path: "/",
    }]);

    await page.route(`**${API}/**`, async (route) => {
      const url = new URL(route.request().url());
      const p = url.pathname.replace(API, "");
      if (p === "/state" || p === "/state/progress") calls.push(p);

      if (p === "/auth/me") {
        return route.fulfill({
          json: { user: { id: "u1", email: "smoke@e2e.local", name: "스모크", role: "cp" }, authRequired: true },
        });
      }
      if (p === "/state") return route.fulfill({ json: stateFixture(opts.stageStatus) });
      if (p === "/state/progress") {
        return route.fulfill({
          json: { episodes: [{ id: "e1", pipeline: stateFixture(opts.stageStatus).episodes[0].pipeline }], jobs: [] },
        });
      }
      if (p in BOOT_STUBS) return route.fulfill({ json: BOOT_STUBS[p] as object });
      // 나머지는 화면이 부르든 말든 빈 응답 — 이 스모크의 관심사가 아니다.
      return route.fulfill({ json: {} });
    });

    return { page, calls, errors };
  }

  it("부팅하면 /api/state 를 부른다", async () => {
    const { page, calls, errors } = await loggedInPage({ stageStatus: "idle" });
    try {
      await page.goto(`${BASE}${POLL_PAGE}`, { waitUntil: "domcontentloaded" });
      await waitFor("부팅 /api/state", () => calls.includes("/state"));
      assert.deepEqual(errors, [], `페이지가 예외를 던졌다:\n${errors.join("\n")}`);
    } finally {
      await page.close();
    }
  });

  it("**분석이 도는 동안에는 /api/state/progress 로 갈아탄다** — 전체를 8초마다 받지 않는다", async () => {
    // 2026-09-14 배선의 클라이언트 쪽 절반이다. 서버가 그 라우트를 준다는 건 apps/server e2e 가
    // 보지만, **브라우저가 그걸 실제로 고르는지**(isActive 판정 → 경로 선택)는 여기서만 증명된다.
    // 이게 깨지면 아무 에러도 안 나고 조용히 옛 동작(전체 폴링)으로 돌아간다.
    const { page, calls, errors } = await loggedInPage({ stageStatus: "progress" });
    try {
      await page.goto(`${BASE}${POLL_PAGE}`, { waitUntil: "domcontentloaded" });
      await waitFor("부팅 /api/state", () => calls.includes("/state"));

      // 활성 주기는 8초다. 한 틱을 기다린다.
      await waitFor(
        "활성 틱의 /api/state/progress",
        () => calls.includes("/state/progress"),
        25_000,
      );

      // 갈아탔다는 건 **전체를 다시 안 받았다**는 뜻이기도 하다. 진행률 틱마다 전체까지
      // 받으면 아낀 게 없으므로, 진행률이 먼저 온 것을 확인한다.
      assert.ok(
        calls.indexOf("/state/progress") > calls.indexOf("/state"),
        `순서가 이상하다 (부른 것: ${JSON.stringify(calls)})`,
      );
      assert.deepEqual(errors, [], `페이지가 예외를 던졌다:\n${errors.join("\n")}`);
    } finally {
      await page.close();
    }
  });

  it("304(안 바뀜)를 받아도 화면이 무너지지 않는다", async () => {
    // `fetchStateProgress` 는 304 에 `null` 을 돌려준다. 호출부가 그걸 **실패로 오해하면**
    // 연결 상태가 내려가고 목록이 비어 화면이 깜빡인다.
    //
    // ⚠️ 이 테스트의 첫 판은 **공허하게 통과했다.** 가로채기가 안 걸려도(=진짜 프록시가 502를
    //    주는데도) "대시보드에 남아 있다" 는 참이었기 때문이다. 그래서 지금은 **304 를 실제로
    //    돌려줬다는 사실**(progressHits)을 먼저 확인하고 나서 화면을 본다. 조건이 성립하지
    //    않으면 통과가 아니라 실패여야 한다.
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.context().addCookies([{
      name: SESSION_COOKIE, value: "smoke-not-a-real-session", domain: "127.0.0.1", path: "/",
    }]);

    let progressHits = 0;
    await page.route(`**${API}/**`, async (route) => {
      const p = new URL(route.request().url()).pathname.replace(API, "");
      if (p === "/auth/me") {
        return route.fulfill({
          json: { user: { id: "u1", email: "smoke@e2e.local", name: "스모크", role: "cp" }, authRequired: true },
        });
      }
      // 활성 상태로 둬야 8초 틱이 돌아 진행률 경로를 밟는다(유휴는 45초라 못 기다린다).
      if (p === "/state") return route.fulfill({ json: stateFixture("progress") });
      if (p === "/state/progress") {
        progressHits += 1;
        return route.fulfill({ status: 304, headers: { etag: 'W/"smoke"' }, body: "" });
      }
      if (p in BOOT_STUBS) return route.fulfill({ json: BOOT_STUBS[p] as object });
      return route.fulfill({ json: {} });
    });

    try {
      await page.goto(`${BASE}${POLL_PAGE}`, { waitUntil: "domcontentloaded" });
      await waitFor("304 를 돌려준 진행률 요청", () => progressHits > 0, 25_000);
      // 304 를 한 번 더 받게 둔다 — 한 번은 넘어가고 반복에서 무너지는 경우가 있다.
      await waitFor("두 번째 304", () => progressHits > 1, 25_000);

      assert.ok(page.url().includes(POLL_PAGE), `${POLL_PAGE} 에서 튕겼다 (${page.url()})`);
      assert.deepEqual(errors, [], `304 처리에서 예외가 났다:\n${errors.join("\n")}`);
    } finally {
      await page.close();
    }
  });
});
