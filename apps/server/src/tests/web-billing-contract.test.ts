/**
 * 제품 웹 ↔ 서버 결제 배선 — **모양이 맞물려 있는가.**
 *
 * 2026-09-14: 어드민 결제 시험으로 서버·PG·원장·인보이스가 도는 것은 증명됐다. 남은 위험은
 * 다른 자리다 — **웹이 그 경로에 같은 모양으로 닿는가.** 여기가 어긋나면 서버는 멀쩡한데
 * 제품에서만 카드 등록이 400/415 로 막히고, 서버 테스트는 전부 초록이라 아무도 모른다.
 *
 * 둘은 다른 패키지라 타입을 공유하지 않는다(웹은 fetch 로 JSON 을 만들고, 서버는 `unknown`
 * 을 검증한다). 그래서 **양쪽 소스를 읽어 필드 이름을 맞춰 본다.**
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const SRC = path.join(import.meta.dirname, "..");
const REPO = path.resolve(SRC, "..", "..", "..");
const read = (...p: string[]) => fs.readFileSync(path.join(...p), "utf-8").replace(/\r\n/g, "\n");

const WEB_API = read(REPO, "apps", "web", "src", "lib", "data", "api.ts");
const CREDENTIAL = read(SRC, "billing", "card-credential.ts");
const BILLING_CARD = read(SRC, "billing", "billing-card.ts");
const REGISTER = read(SRC, "billing", "card-register.ts");
const INDEX = read(SRC, "index.ts");

/** 웹의 `registerCard` 본문. */
function webRegister(): string {
  const at = WEB_API.indexOf("export async function registerCard(");
  assert.ok(at > 0, "웹에 registerCard 가 없다 — 제품에서 카드를 등록할 방법이 사라졌다");
  return WEB_API.slice(at, WEB_API.indexOf("\n}\n", at));
}

describe("카드 등록 — 웹이 보내는 것과 서버가 요구하는 것", () => {
  it("웹이 **자동결제 동의를 실어 보낸다** — 없으면 서버가 400 으로 막는다", () => {
    assert.match(webRegister(), /autoChargeConsent/,
      "웹이 동의를 안 보낸다 — 제품에서 카드 등록이 consent_required 로 전부 실패한다");
    assert.match(REGISTER, /body\.autoChargeConsent !== true/, "서버가 동의를 확인하지 않는다");
    // 제품 라우트는 동의를 **면제하지 않는다**(어드민만 면제다 — 거긴 운영자가 우리 카드로 확인하는 자리).
    const route = INDEX.slice(INDEX.indexOf('app.post("/api/billing/card/issue"'));
    assert.match(route.slice(0, 900), /requireConsent: true/);
  });

  it("웹이 JSON content-type 을 붙인다 — 서버가 415 로 막는다", () => {
    assert.match(webRegister(), /"Content-Type": "application\/json"/,
      "content-type 이 없다 — 서버가 json_required 로 415 를 낸다");
  });

  it("**세션 쿠키를 싣는다** — 없으면 로그인해도 401 이다", () => {
    assert.match(webRegister(), /credentials: "include"/);
  });

  it("카드 필드 이름이 서버 검증과 같다", () => {
    const web = WEB_API.slice(WEB_API.indexOf("export interface CardCredentialInput"),
                              WEB_API.indexOf("export async function registerCard("));
    // 서버가 `read("...")` 로 꺼내는 키들 — 이름이 하나라도 다르면 그 값만 조용히 빠진다.
    for (const key of ["number", "expiryMonth", "expiryYear",
                       "birthOrBusinessRegistrationNumber", "passwordTwoDigits"]) {
      assert.ok(CREDENTIAL.includes(`"${key}"`), `서버가 ${key} 를 안 읽는다`);
      assert.ok(web.includes(key), `웹 타입에 ${key} 가 없다 — 그 값이 서버에 안 간다`);
    }
  });

  it("구매자 3종 이름이 같다 — 이니시스 필수값이라 빠지면 **결제 단계**에서 거절된다", () => {
    for (const key of ["fullName", "email", "phoneNumber"]) {
      assert.ok(BILLING_CARD.includes(key), `서버 checkCustomer 가 ${key} 를 모른다`);
      assert.ok(webRegister().includes("buyer"), "웹이 buyer 를 안 보낸다");
    }
    const web = WEB_API.slice(WEB_API.indexOf("export async function registerCard("),
                              WEB_API.indexOf("export interface CardIssuePrep"));
    for (const key of ["fullName", "email", "phoneNumber"]) {
      assert.ok(web.includes(key), `웹 buyer 에 ${key} 가 없다`);
    }
  });

  it("웹이 실패를 삼키지 않는다 — 등록 안 됐는데 됐다고 하면 최악이다", () => {
    assert.match(webRegister(), /if \(!res\.ok\) throw/,
      "res.ok 를 안 본다 — 400/502 를 성공으로 읽어 '등록됐습니다' 를 띄운다");
  });

  it("화면이 그 함수를 실제로 부른다 — api 만 있고 버튼이 없으면 기능이 없는 것이다", () => {
    const saved = read(REPO, "apps", "web", "src", "components", "billing", "saved-card.tsx");
    assert.match(saved, /registerCard\(\{ credential, buyer, autoChargeConsent: true \}\)/,
      "결제수단 화면이 registerCard 를 안 부른다");
  });
});

describe("충전은 자동이다 — 수동 경로는 의도적으로 안 쓴다", () => {
  /**
   * `topupWithCard`(수동 저장카드 충전)는 **웹 화면 어디에서도 안 불린다.** 버그가 아니라
   * 정책이다 — "잔액이 소진되면 자동으로 충전한다" 로 고정했고(2026-08-26), 크레딧 화면에서
   * 수동 구매를 걷어냈다. 서버 라우트는 살아 있어 되돌릴 수 있다.
   *
   * 이 테스트는 **그 사실이 사실인지** 확인한다. 어느 날 버튼이 생기면 여기서 알게 되고,
   * 그때 이 주석이 "왜 없었는지" 를 알려 준다.
   */
  it("웹에 수동 충전 버튼이 없다 (있으면 정책이 바뀐 것이다)", () => {
    const webSrc = path.join(REPO, "apps", "web", "src");
    const hits: string[] = [];
    (function walk(d: string) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.tsx?$/.test(e.name)) continue;
        if (p.endsWith(path.join("lib", "data", "api.ts"))) continue;   // 정의 자체는 제외
        if (fs.readFileSync(p, "utf-8").includes("topupWithCard")) hits.push(p);
      }
    })(webSrc);
    assert.deepEqual(hits, [],
      `수동 충전을 부르는 화면이 생겼다: ${hits.join(", ")}\n` +
      "→ 자동결제 고정정책(2026-08-26)이 바뀐 것이라면 이 테스트와 크레딧 화면 문구를 같이 고칠 것.");
  });

  it("서버 라우트는 남아 있다 — 되돌릴 수 있어야 한다", () => {
    assert.ok(INDEX.includes('app.post("/api/credits/topup/card"'),
      "수동 충전 라우트를 지웠다 — 정책을 되돌리려면 서버부터 다시 만들어야 한다");
  });
});
