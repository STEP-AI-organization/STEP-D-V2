/**
 * 사용량 시계열(`/api/superadmin/usage/trend`) — **날짜 경계와 단가 표본**을 고정한다.
 *
 * 이 두 개가 조용히 틀리는 자리다:
 *  · 날짜를 UTC 로 자르면 한국 새벽 0~9시 작업이 **전날로 붙는다.** 그래프는 멀쩡해 보이는데
 *    "어제 얼마 썼지" 가 안 맞는다. 어드민은 한국 사람이 보는 화면이다.
 *  · 단가를 상수 채움 행까지 섞어 내면, 그건 실측 추이가 아니라 **우리가 짐작한 값의 그래프**다.
 *    (같은 실수로 2026-09-03 에 원장이 원가를 43% 부풀리고 있던 게 잡혔다.)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const index = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8");
const route = index.slice(index.indexOf('app.get("/api/superadmin/usage/trend"'));
const body = route.slice(0, route.indexOf("\n});"));

describe("사용량 시계열", () => {
  it("라우트가 있고 superadmin 만 본다", () => {
    assert.ok(body.length > 0, "usage/trend 라우트를 못 찾았다");
    assert.match(body, /requireSuperadmin\(c\)/);
    assert.match(body, /action: "usage\.trend\.view"/, "횡단 열람은 감사에 남긴다");
  });

  it("**KST 로 자른다** — UTC 로 자르면 새벽 작업이 전날로 붙는다", () => {
    assert.ok(body.includes("AT TIME ZONE 'Asia/Seoul'"), "날짜를 KST 로 안 자른다");
    assert.ok(!/date_trunc\('day',\s*occurred_at\)/.test(body),
      "date_trunc(occurred_at) 은 UTC 기준이다");
  });

  it("매출도 **같은 기준**으로 자른다 — 원가와 매출이 다른 날에 붙으면 마진이 흔들린다", () => {
    const revenueCut = /credit_topup[\s\S]*?AT TIME ZONE 'Asia\/Seoul'/.test(body)
      || body.split("credit_topup")[0].includes("AT TIME ZONE 'Asia/Seoul'");
    assert.ok(revenueCut, "충전액을 KST 로 안 자른다");
  });

  it("**단가는 measured 행만** — 상수 채움을 섞으면 짐작을 그래프로 그리는 것이다", () => {
    assert.ok(body.includes("cost_source='measured'"));
    assert.ok(body.includes("const per60 = (measuredCost: number, measuredMin: number) =>"),
      "단가 계산이 한 곳에 없다 — 두 벌이면 합계와 추이가 갈린다");
  });

  it("실측이 없는 날은 **0 이 아니라 null** — 없는 것과 0 은 다르다", () => {
    assert.match(body, /measuredMin > 0 \? Math\.round\([\s\S]{0,60}\) : null/);
  });

  it("직전 **같은 길이** 구간을 같이 준다 — 'vs 이전 기간' 이 이 값이다", () => {
    assert.ok(body.includes("const prevIv = `${days * 2} days`"));
    assert.ok(body.includes("previous:"));
  });

  it("원가 없이 충전만 있는 날도 점으로 남긴다 — 매출 그래프에 구멍이 나면 안 된다", () => {
    assert.ok(body.includes("for (const [day, revenueKrw] of revByDay)"));
  });

  it("회사별 시계열은 **요청할 때만** 준다 — 스파크라인 안 쓰는 화면엔 무거운 짐이다", () => {
    assert.ok(body.includes('c.req.query("byTenant") === "1"'));
    assert.ok(body.includes("...(wantByTenant ? { byTenant } : {})"));
  });
});
