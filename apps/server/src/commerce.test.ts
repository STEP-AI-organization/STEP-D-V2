/**
 * 커머스 제휴 링크 — 게이트·문구·조립 불변식.
 *
 * 이 기능의 실패는 둘 다 **돈이나 계정**과 직결된다:
 *  - 대가성 문구 없이 링크가 나가면 → 고객사 파트너스 계정 정지
 *  - 링크가 만들어졌는데 설명란에 안 붙으면 → 수익 0 (이 리포 최빈 실패모드:
 *    "기능은 있는데 출력이 소비처에 미도달")
 * 그래서 순수 함수 검증 + **소스 스캔으로 배선까지** 잠근다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, beforeEach, afterEach } from "node:test";

import {
  COMMERCE_BLOCK_HEADER,
  COUPANG_DISCLOSURE,
  MAX_LINKS_PER_CLIP,
  approvedLinks,
  commerceLinksEnabled,
  isAffiliateUrl,
  normalizeStatus,
  parseProductQueries,
  usableLinks,
  withCommerceLinks,
} from "./commerce.ts";
import { pickProduct, type CoupangProduct } from "./coupang-partners.ts";
import { buildMetadataPrompt } from "./clip-metadata.ts";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => fs.readFileSync(path.join(SRC, f), "utf-8");

const LINK = (n: string) => `https://link.coupang.com/a/${n}`;
/** 기본이 `approved` 인 이유: 대부분의 테스트가 "붙는 링크" 를 전제로 조립을 검증한다.
 *  승인 게이트 자체는 아래 "승인한 것만 나간다" 블록이 따로 본다. */
const link = (query: string, productName: string, url: string, status: string = "approved") =>
  ({ provider: "coupang" as const, query, productName, url, status, createdAt: 1 });

let saved: string | undefined;
beforeEach(() => { saved = process.env.COMMERCE_LINKS_ENABLED; });
afterEach(() => {
  if (saved === undefined) delete process.env.COMMERCE_LINKS_ENABLED;
  else process.env.COMMERCE_LINKS_ENABLED = saved;
});
const gateOn = () => { process.env.COMMERCE_LINKS_ENABLED = "1"; };

describe("게이트 — 실패 방향은 항상 OFF", () => {
  it("미설정·빈값·오타는 전부 OFF", () => {
    for (const v of [undefined, "", "  ", "flase", "TRUE1", "0", "no", "off", "y"]) {
      if (v === undefined) delete process.env.COMMERCE_LINKS_ENABLED;
      else process.env.COMMERCE_LINKS_ENABLED = v;
      assert.equal(commerceLinksEnabled(), false, `"${v}" 가 게이트를 켰다`);
    }
  });

  it("명시적 truthy 만 ON", () => {
    for (const v of ["true", "1", "on", "yes", "enabled", " TRUE ", "On"]) {
      process.env.COMMERCE_LINKS_ENABLED = v;
      assert.equal(commerceLinksEnabled(), true, `"${v}" 가 게이트를 못 켰다`);
    }
  });

  it("게이트가 꺼져 있으면 설명이 한 글자도 안 바뀐다", () => {
    delete process.env.COMMERCE_LINKS_ENABLED;
    const desc = "원래 설명\n\n#Shorts";
    assert.equal(withCommerceLinks(desc, [link("차량용 탈취제", "에이센트 탈취제", LINK("aaa"))], "youtube"), desc);
  });
});

describe("링크 URL 검증 — 아무 URL 이나 공개 설명란에 나가지 않는다", () => {
  it("제휴 단축 링크만 통과한다", () => {
    assert.ok(isAffiliateUrl("https://link.coupang.com/a/gwui1XI3B6"));
    assert.ok(isAffiliateUrl("https://link.coupang.com/re/AFFSDP?lptag=x"));
  });

  it("쿠팡 **상품** URL 은 거부한다 — 정산이 안 되는 맨 링크다", () => {
    assert.equal(isAffiliateUrl("https://www.coupang.com/vp/products/8890852277"), false);
  });

  it("http·타 도메인·공백·스크립트는 거부한다", () => {
    for (const bad of [
      "http://link.coupang.com/a/x",
      "https://link.coupang.com.evil.kr/a/x",
      "https://evil.kr/link.coupang.com/a/x",
      "https://link.coupang.com/a/x y",
      'javascript:alert(1)',
      "", null, undefined, 42,
    ]) {
      assert.equal(isAffiliateUrl(bad as unknown), false, `통과하면 안 되는 값: ${String(bad)}`);
    }
  });
});

describe("설명란 조립", () => {
  it("대가성 문구가 **반드시** 함께 나간다", () => {
    gateOn();
    const out = withCommerceLinks("설명", [link("초콜릿 케이크", "베키아에누보 파베 케이크", LINK("bbb"))], "youtube");
    assert.ok(out.includes(COUPANG_DISCLOSURE), "대가성 문구 누락 = 계정 정지 사유");
    assert.ok(out.includes(LINK("bbb")));
    assert.ok(out.startsWith("설명"), "원문이 앞에 남아야 한다");
  });

  it("문구가 링크보다 **뒤**에 온다 — 잘려도 링크만 남는 일이 없게", () => {
    gateOn();
    const out = withCommerceLinks("설명", [link("q", "상품", LINK("ccc"))], "youtube");
    assert.ok(out.indexOf(LINK("ccc")) < out.indexOf(COUPANG_DISCLOSURE));
  });

  it("멱등 — 두 번 조립해도 문구·링크가 중복되지 않는다", () => {
    gateOn();
    const links = [link("q", "상품", LINK("ddd"))];
    const once = withCommerceLinks("설명", links, "youtube");
    const twice = withCommerceLinks(once, links, "youtube");
    assert.equal(twice, once);
    assert.equal(twice.split(COUPANG_DISCLOSURE).length - 1, 1);
  });

  it("링크가 없으면 원문 그대로 — 발급이 늦어도 발행을 막지 않는다", () => {
    gateOn();
    assert.equal(withCommerceLinks("설명", [], "youtube"), "설명");
    assert.equal(withCommerceLinks("설명", undefined, "youtube"), "설명");
    assert.equal(withCommerceLinks("설명", null, "youtube"), "설명");
  });

  it("형식이 깨진 링크만 있으면 블록 자체를 안 만든다", () => {
    gateOn();
    const bad = [{ provider: "coupang", query: "q", productName: "상품", url: "https://www.coupang.com/vp/products/1" }];
    assert.equal(withCommerceLinks("설명", bad, "youtube"), "설명");
  });

  it("YouTube 외 채널에는 붙지 않는다 — 확인된 채널부터 하나씩", () => {
    gateOn();
    const links = [link("q", "상품", LINK("eee"))];
    for (const ch of ["navertv", "naverclip", "instagram", "facebook", "tiktok"]) {
      assert.equal(withCommerceLinks("설명", links, ch), "설명", `${ch} 에 상업 링크가 샜다`);
    }
  });

  it("링크 개수 상한을 지킨다", () => {
    gateOn();
    const many = Array.from({ length: 10 }, (_, i) => link(`q${i}`, `상품${i}`, LINK(`u${i}`)));
    const out = withCommerceLinks("설명", many, "youtube");
    assert.equal(out.split("link.coupang.com").length - 1, MAX_LINKS_PER_CLIP);
  });

  it("상품명의 옵션 꼬리를 잘라 읽히게 만든다", () => {
    gateOn();
    const out = withCommerceLinks(
      "", [link("q", "에이센트 차량용 고체 탈취제 프레쉬 린넨, 1개, 210g", LINK("fff"))], "youtube");
    assert.ok(out.includes(COMMERCE_BLOCK_HEADER));
    assert.equal(out.includes(", 1개, 210g"), false, "옵션 꼬리가 그대로 나갔다");
  });
});

describe("승인한 것만 나간다 — 이게 '우리가 조절한다'의 실체다", () => {
  it("미검토(pending)는 안 붙는다 — 아무도 안 본 상품이 방송사 채널에 나가면 안 된다", () => {
    gateOn();
    const out = withCommerceLinks("설명", [link("q", "상품", LINK("p1"), "pending")], "youtube");
    assert.equal(out, "설명");
  });

  it("거절(rejected)은 안 붙는다", () => {
    gateOn();
    assert.equal(withCommerceLinks("설명", [link("q", "상품", LINK("p2"), "rejected")], "youtube"), "설명");
  });

  it("**status 가 아예 없는 옛 링크도 안 붙는다** — 모르는 건 안 내보낸다", () => {
    gateOn();
    const legacy = [{ provider: "coupang", query: "q", productName: "상품", url: LINK("p3"), createdAt: 1 }];
    assert.equal(withCommerceLinks("설명", legacy, "youtube"), "설명");
  });

  it("승인된 것만 골라 붙는다 — 섞여 있어도", () => {
    gateOn();
    const out = withCommerceLinks("설명", [
      link("a", "거절된 상품", LINK("r1"), "rejected"),
      link("b", "승인된 상품", LINK("ok1"), "approved"),
      link("c", "미검토 상품", LINK("p4"), "pending"),
    ], "youtube");
    assert.ok(out.includes(LINK("ok1")));
    assert.equal(out.includes(LINK("r1")), false, "거절된 링크가 샜다");
    assert.equal(out.includes(LINK("p4")), false, "미검토 링크가 샜다");
    assert.ok(out.includes(COUPANG_DISCLOSURE));
  });

  it("승인 상한은 승인된 것들 중에서 센다 — 거절이 자리를 잡아먹지 않는다", () => {
    gateOn();
    const many = [
      ...Array.from({ length: 5 }, (_, i) => link(`r${i}`, `거절${i}`, LINK(`rr${i}`), "rejected")),
      ...Array.from({ length: 5 }, (_, i) => link(`a${i}`, `승인${i}`, LINK(`aa${i}`), "approved")),
    ];
    const out = withCommerceLinks("설명", many, "youtube");
    assert.equal(out.split("link.coupang.com").length - 1, MAX_LINKS_PER_CLIP);
    assert.equal(out.includes("/a/rr"), false, "거절된 것이 상한을 채웠다");
  });

  it("normalizeStatus — 모르는 값은 전부 pending", () => {
    for (const v of [undefined, null, "", "  ", "APPROVE", "ok", "yes", 1, {}]) {
      assert.equal(normalizeStatus(v), "pending", `${String(v)} 가 pending 이 아니다`);
    }
    assert.equal(normalizeStatus("approved"), "approved");
    assert.equal(normalizeStatus(" REJECTED "), "rejected");
  });

  it("검토 목록(usableLinks)에는 거절된 것도 남는다 — 사람이 되돌릴 수 있어야 한다", () => {
    const all = usableLinks([
      link("a", "승인", LINK("z1"), "approved"),
      link("b", "거절", LINK("z2"), "rejected"),
      link("c", "미검토", LINK("z3"), "pending"),
    ], 99);
    assert.deepEqual(all.map((l) => l.status), ["approved", "rejected", "pending"]);
    assert.deepEqual(approvedLinks(all, 99).map((l) => l.query), ["a"]);
  });
});

describe("상품 쿼리 파싱 — 못 믿을 LLM 출력을 다룬다", () => {
  it("객체·문자열 둘 다 받는다", () => {
    const out = parseProductQueries([{ query: "차량용 탈취제", reason: "담배 냄새" }, "프리지어 꽃다발"]);
    assert.deepEqual(out.map((q) => q.query), ["차량용 탈취제", "프리지어 꽃다발"]);
  });

  it("너무 짧거나 긴 것, 중복, 배열이 아닌 것을 버린다", () => {
    assert.deepEqual(parseProductQueries("문자열"), []);
    assert.deepEqual(parseProductQueries(null), []);
    assert.deepEqual(parseProductQueries(["a", "x".repeat(50)]), []);
    assert.equal(parseProductQueries(["케이크", "케이크", "케 이 크"]).length, 2);
  });

  it("개수 상한을 지킨다", () => {
    assert.equal(parseProductQueries(Array.from({ length: 20 }, (_, i) => `상품${i}`)).length, 5);
  });
});

describe("상품 선택 — 결정론이다 (LLM 에 순위를 시키지 않는다)", () => {
  const p = (over: Partial<CoupangProduct>): CoupangProduct => ({
    productId: 1, itemId: 2, vendorItemId: 3, title: "상품", ...over,
  });

  it("성인용품·품절·여행상품을 제외한다", () => {
    assert.equal(pickProduct([p({ isAdult: true }), p({ isSoldOut: true }), p({ travel: true })]), null);
  });

  it("후기 있는 상품을 우선한다", () => {
    const picked = pickProduct([
      p({ productId: 10, title: "광고성 신규", ratingCount: 0 }),
      p({ productId: 11, title: "후기 있는 것", ratingCount: 120 }),
    ]);
    assert.equal(picked?.productId, 11);
  });

  it("전부 후기 0 이면 1위를 쓴다 — 빈손보다 낫다", () => {
    const picked = pickProduct([p({ productId: 20 }), p({ productId: 21 })]);
    assert.equal(picked?.productId, 20);
  });

  it("같은 입력에 항상 같은 결과", () => {
    const list = [p({ productId: 30, ratingCount: 5 }), p({ productId: 31, ratingCount: 900 })];
    assert.equal(pickProduct(list)?.productId, pickProduct(list)?.productId);
  });
});

describe("프롬프트 — 게이트가 꺼져 있으면 종전과 동일하다", () => {
  const src = { program: "나는 SOLO", workingTitle: "제목", summary: "요약" };

  it("OFF 면 productQueries 지시가 한 글자도 없다", () => {
    const out = buildMetadataPrompt(src);
    assert.equal(out.includes("productQueries"), false);
    assert.equal(out.includes("상품 검색어"), false);
  });

  it("ON 이면 지시와 출력 필드가 함께 들어간다", () => {
    const out = buildMetadataPrompt({ ...src, wantProductQueries: true });
    assert.ok(out.includes("productQueries"));
    assert.ok(out.includes("빈 배열"), "없으면 빈 배열이라는 지시가 빠지면 억지로 만들어낸다");
  });

  it("플래그만 다르고 나머지는 그대로 — 켜면 블록이 더해질 뿐이다", () => {
    const off = buildMetadataPrompt(src);
    const on = buildMetadataPrompt({ ...src, wantProductQueries: true });
    assert.ok(on.length > off.length);
    // 제목·장르팩 등 기존 블록은 그대로 유지된다
    assert.ok(on.includes("[장르: 공통]") === off.includes("[장르: 공통]"));
  });
});

describe("배선 — 만든 링크가 실제로 설명란까지 간다", () => {
  it("worker 의 metaForChannel 이 withCommerceLinks 를 통과시킨다", () => {
    const w = read("worker.ts");
    const fn = /function metaForChannel[\s\S]*?\n\}(?=\r?\n)/.exec(w)?.[0] ?? "";
    assert.notEqual(fn, "", "metaForChannel 을 못 찾았다");
    assert.match(fn, /withCommerceLinks\(/,
      "발행 조립에 커머스 블록이 안 붙는다 — 링크를 만들어도 설명란에 도달하지 않는다");
    // 두 갈래(저장된 채널메타 / 폴백) 모두 통과해야 한다.
    assert.equal((fn.match(/withLinks\(/g) ?? []).length, 2,
      "metaForChannel 의 두 반환 경로 중 하나가 커머스 블록을 건너뛴다");
  });

  it("발행 후 메타 수정(updatemeta)이 링크를 벗기지 않는다", () => {
    const w = read("worker.ts");
    const fn = /async function handleDistributionUpdateMeta[\s\S]*?\n\}(?=\r?\n)/.exec(w)?.[0] ?? "";
    assert.notEqual(fn, "", "handleDistributionUpdateMeta 를 못 찾았다");
    assert.match(fn, /withCommerceLinks\(/,
      "저장본을 그대로 올려 링크·대가성 문구가 사라진다 (제목 수정 한 번에 정지 사유가 된다)");
  });

  it("commerce.link 잡이 도는 레인에 있다", () => {
    const w = read("worker.ts");
    const lanes = /const JOB_LANES[^=]*=\s*\{([\s\S]*?)\n\};/.exec(w)?.[1] ?? "";
    assert.match(lanes, /commerce:\s*\["commerce\.link"\]/, "commerce.link 이 레인에 없다");
    const all = /ALL_LANE_TYPES[^=]*=\s*\[([\s\S]*?)\];/.exec(w)?.[1] ?? "";
    assert.equal(all.includes("commerce"), false,
      '머신 전용 잡이 "all" 워커 범위에 샜다 — 로그인된 브라우저가 없는 워커가 집으면 100% 실패한다');
  });
});

describe("자기 클릭 금지 — 생성된 링크를 절대 열지 않는다", () => {
  it("어떤 소스도 link.coupang.com 으로 이동하지 않는다", () => {
    const offenders: string[] = [];
    for (const f of fs.readdirSync(SRC).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const src = read(f)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      // goto/open/navigate 계열 호출 인자에 link.coupang.com 이 들어오면 자기 클릭이다.
      for (const m of src.matchAll(/\.(goto|navigate)\s*\(([^)]*)\)/g)) {
        if (/link\.coupang\.com/.test(m[2])) offenders.push(`${f}: ${m[0].slice(0, 80)}`);
      }
    }
    assert.deepEqual(offenders, [], `자기 클릭 경로: ${offenders.join(" / ")} — 즉시 계정 정지 사유다`);
  });

  it("발급 모듈이 제휴 링크 이동을 라우트에서도 막는다", () => {
    const src = read("coupang-partners.ts");
    assert.match(src, /page\.route\(/, "방어선(라우트 차단)이 없다");
    assert.match(src, /isNavigationRequest\(\)[\s\S]{0,120}abort\(\)/,
      "제휴 링크로의 문서 이동을 abort 하지 않는다");
  });
});

/**
 * 실측 회귀 (2026-08-27) — 유닛 테스트로는 절대 안 잡히는 종류라 소스로 잠근다.
 *
 * 워커는 프로덕션에서도 tsx(esbuild)로 돈다. esbuild 의 keepNames 가 함수마다 `__name(...)`
 * 래퍼를 씌우는데, `page.evaluate` 는 함수를 소스 문자열로 직렬화해 브라우저로 보내므로
 * 브라우저에 없는 그 헬퍼를 부르다 `ReferenceError: __name is not defined` 로 전량 실패한다.
 * 처음 구현이 정확히 이 이유로 0건 발급이었다(스크래치 PoC 는 순수 .mjs 라 멀쩡했다).
 */
describe("esbuild __name 회귀 — page.evaluate 가 브라우저에서 터지지 않는다", () => {
  const src = read("coupang-partners.ts");

  it("__name shim 을 **문자열** evaluate 로 심는다 (문자열은 변환을 안 거친다)", () => {
    assert.match(src, /page\.evaluate\(\s*["'`]globalThis\.__name/,
      "shim 이 없거나 문자열이 아니다 — 함수로 넘기면 그 함수 자체가 변환돼 같은 이유로 터진다");
  });

  it("shim 설치가 첫 evaluate 보다 먼저 온다", () => {
    const shimAt = src.indexOf("installNameShim(page)");
    const firstEval = src.indexOf("page.evaluate(async");
    assert.ok(shimAt > 0, "installNameShim 호출이 없다");
    assert.ok(shimAt < firstEval, "shim 을 심기 전에 함수 evaluate 를 먼저 부른다");
  });

  it("evaluate 콜백 안에 이름 붙는 내부 함수를 만들지 않는다", () => {
    const offenders: string[] = [];
    // page.evaluate(async (…) => { … }) 의 본문만 괄호 균형으로 잘라 본다.
    for (const m of src.matchAll(/page\.evaluate\(async/g)) {
      let i = m.index! + "page.evaluate(".length;
      for (let depth = 1; i < src.length && depth > 0; i++) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") depth--;
      }
      const body = src.slice(m.index!, i);
      // `const f = (…) => …` / `const f = async (…) =>` / `function f(` 는 전부 이름이 붙는다.
      for (const bad of body.matchAll(/\b(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/g)) {
        offenders.push(bad[0].slice(0, 50));
      }
      for (const bad of body.matchAll(/\bfunction\s+\w+\s*\(/g)) offenders.push(bad[0]);
    }
    assert.deepEqual(offenders, [],
      `evaluate 안의 이름 붙는 함수: ${offenders.join(" / ")} — esbuild 가 __name 을 씌워 브라우저에서 터진다`);
  });
});

describe("usableLinks — 저장된 값에서 쓸 수 있는 것만", () => {
  it("중복 URL·이름 없는 항목·잘못된 형식을 걸러낸다", () => {
    const out = usableLinks([
      link("a", "상품A", LINK("x1")),
      link("b", "상품B", LINK("x1")),          // URL 중복
      { provider: "coupang", query: "c", productName: "", url: LINK("x2") },  // 이름 없음
      { provider: "coupang", query: "d", productName: "상품D", url: "https://coupang.com/x" }, // 형식
      link("e", "상품E", LINK("x3")),
      null, "문자열", 7,
    ]);
    assert.deepEqual(out.map((l) => l.query), ["a", "e"]);
  });
});
