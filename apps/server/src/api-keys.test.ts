/**
 * 회사별 API 키 고정 (다회사 3단계).
 *
 * 이 경로가 뚫리면 **남의 회사 데이터가 통째로 나간다.** 그래서 실패 방향을 전부
 * "거부"로 잡고, 그게 유지되는지를 값과 소스 양쪽으로 잠근다:
 *
 *  - 모르는 키·폐기된 키·정지된 회사의 키 → 거부
 *  - 화이트리스트에 없는 라우트 → 거부 (새 라우트의 기본값이 "닫힘"이어야 한다)
 *  - 평문 키는 저장하지 않는다
 *  - 키 경로도 세션과 **같은 출구**(runWithTenant)를 지난다 — 격리를 두 벌 만들지 않는다
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  API_KEY_ROUTES,
  API_SCOPES,
  KEY_PREFIX_LIVE,
  PREFIX_LEN,
  bearerKey,
  checkRoute,
  formatKey,
  generateKey,
  hashKey,
  keyBlockReason,
  keyPrefix,
  looksLikeApiKey,
  normalizeScopes,
  shouldTouchLastUsed,
  type ApiKeyRow,
} from "./api-keys.ts";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => fs.readFileSync(path.resolve(SRC, f), "utf-8");

const liveRow = (over: Partial<ApiKeyRow> = {}): ApiKeyRow => ({
  id: "ak_1", tenantId: "t_kbs", scopes: ["media:write"],
  revokedAt: null, tenantStatus: "active", ...over,
});

describe("키 형식", () => {
  it("발급 키는 접두로 알아볼 수 있다", () => {
    const k = generateKey(true);
    assert.ok(k.startsWith(KEY_PREFIX_LIVE));
    assert.equal(keyPrefix(k).length, PREFIX_LEN);
    assert.ok(looksLikeApiKey(k));
  });

  it("매번 다른 키가 나온다", () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateKey()));
    assert.equal(keys.size, 50);
  });

  it("우리 키가 아니면 조회조차 하지 않는다", () => {
    // 엉뚱한 Bearer(구글 ID 토큰 등)로 DB 를 두드리지 않게 형식에서 먼저 거른다.
    for (const bad of ["", "abc", "Bearer x", "sk_live_abcdefgh", "stepd_live_", `${KEY_PREFIX_LIVE}短`]) {
      assert.equal(looksLikeApiKey(bad), false, bad);
    }
  });

  it("Authorization 헤더에서 키만 뽑는다", () => {
    const k = formatKey("abcdefghijkl");
    assert.equal(bearerKey(`Bearer ${k}`), k);
    assert.equal(bearerKey(`bearer ${k}`), k);
    assert.equal(bearerKey(`  Bearer   ${k}  `), k);
    // 세션 쿠키 경로로 흘러가야 하는 것들
    assert.equal(bearerKey(undefined), null);
    assert.equal(bearerKey("Basic abc"), null);
    assert.equal(bearerKey("Bearer eyJhbGciOiJSUzI1NiJ9.x.y"), null);
  });

  it("해시는 결정적이고 평문과 다르다", () => {
    const k = generateKey();
    assert.equal(hashKey(k), hashKey(k));
    assert.notEqual(hashKey(k), k);
    assert.equal(hashKey(k).length, 64);
    assert.notEqual(hashKey(k), hashKey(generateKey()));
  });
});

describe("스코프", () => {
  it("모르는 값은 버린다 (에러가 아니라)", () => {
    assert.deepEqual(normalizeScopes(["media:write", "admin:*", "media:write"]), ["media:write"]);
    assert.deepEqual(normalizeScopes("media:read, search:read"), ["media:read", "search:read"]);
    assert.deepEqual(normalizeScopes(undefined), []);
    assert.deepEqual(normalizeScopes(["nonsense"]), []);
  });

  it("관리 스코프는 아예 없다 · 결제는 읽기(billing:read)만", () => {
    // 있으면 언젠가 누가 붙인다. 고객사 키가 닿을 수 있는 최대치를 여기서 못박는다.
    // billing:read 는 잔액·사용내역 **조회** 전용으로 의도적으로 열었다 — 쓰기 스코프
    // (billing:write 류)가 생기는 순간 이 테스트가 잡아야 한다.
    for (const s of API_SCOPES) {
      if (s === "billing:read") continue;
      assert.doesNotMatch(s, /admin|billing|credit|superadmin|publish/, `위험한 스코프: ${s}`);
    }
  });
});

describe("키 수락 판정 — 모르면 막는다", () => {
  it("정상 키는 통과", () => {
    assert.equal(keyBlockReason(liveRow()), null);
  });

  it("없는 키·폐기된 키는 막는다", () => {
    assert.ok(keyBlockReason(null));
    assert.ok(keyBlockReason(undefined));
    assert.ok(keyBlockReason(liveRow({ revokedAt: new Date() })));
    assert.ok(keyBlockReason(liveRow({ revokedAt: "2026-08-01T00:00:00Z" })));
  });

  it("정지된 회사의 키는 죽는다", () => {
    // 0단계가 세션만 끊고 키를 살려 두면 정지된 회사가 API 로 계속 쓴다.
    for (const st of ["suspended", "closed", null, "", "unknown"]) {
      assert.ok(keyBlockReason(liveRow({ tenantStatus: st })), `통과하면 안 되는 상태: ${st}`);
    }
  });

  it("권한이 빈 키는 막는다", () => {
    assert.ok(keyBlockReason(liveRow({ scopes: [] })));
    assert.ok(keyBlockReason(liveRow({ scopes: undefined as never })));
  });
});

describe("라우트 화이트리스트 — 기본값은 닫힘", () => {
  const all = [...API_SCOPES];

  it("열어둔 라우트는 통과한다", () => {
    assert.equal(checkRoute("POST", "/api/media/upload-init", all).ok, true);
    assert.equal(checkRoute("POST", "/api/media/m_1/analyze", all).ok, true);
    assert.equal(checkRoute("GET", "/api/media/m_1/analysis", all).ok, true);
    assert.equal(checkRoute("GET", "/api/search", all).ok, true);
  });

  it("쿼리스트링이 붙어도 같은 라우트다", () => {
    assert.equal(checkRoute("GET", "/api/search?q=%EA%B9%80&limit=20", all).ok, true);
  });

  it("관리·결제·배포 라우트는 전부 막힌다", () => {
    const forbidden: [string, string][] = [
      ["GET", "/api/superadmin/tenants"],
      ["POST", "/api/superadmin/tenants"],
      ["POST", "/api/credits/topup"],
      ["POST", "/api/distributions/publish"],
      ["POST", "/api/auth/login"],
      ["GET", "/api/state"],
      ["POST", "/api/admin/reset"],
      ["GET", "/api/youtube/channels"],
    ];
    for (const [m, p] of forbidden) {
      assert.equal(checkRoute(m, p, all).ok, false, `열려 있으면 안 되는 경로: ${m} ${p}`);
    }
  });

  it("메서드가 다르면 다른 라우트다", () => {
    // GET 만 열어둔 경로에 POST 로 들어오는 걸 통과시키면 읽기 키가 쓰기를 한다.
    assert.equal(checkRoute("DELETE", "/api/media/m_1/analysis", all).ok, false);
    assert.equal(checkRoute("POST", "/api/media/m_1/analysis", all).ok, false);
    assert.equal(checkRoute("GET", "/api/media/upload-init", all).ok, false);
  });

  it("경로 앞뒤로 뭘 붙여도 못 뚫는다", () => {
    for (const p of [
      "/api/search/log",
      "/x/api/search",
      "/api/media/m_1/analysis/faces/a.jpg",
      "/api/media/m_1/analyze/../../superadmin/tenants",
    ]) {
      assert.equal(checkRoute("GET", p, all).ok, false, p);
      assert.equal(checkRoute("POST", p, all).ok, false, p);
    }
  });

  it("스코프가 없으면 열린 라우트도 못 부른다", () => {
    const r = checkRoute("POST", "/api/media/m_1/analyze", ["search:read"]);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /media:write/, "어떤 권한이 필요한지 말해줘야 한다");
  });

  it("'경로가 없음'과 '권한이 없음'을 구분한다", () => {
    const noRoute = checkRoute("POST", "/api/admin/reset", [...API_SCOPES]);
    const noScope = checkRoute("POST", "/api/media/m_1/analyze", []);
    assert.equal(noRoute.ok, false);
    assert.equal(noScope.ok, false);
    if (noRoute.ok || noScope.ok) return;
    // 뭉뚱그리면 고객사가 "키가 잘못됐나"와 "그 기능은 API 에 없나"를 구분 못 한다.
    assert.notEqual(noRoute.reason, noScope.reason);
  });

  it("화이트리스트에 관리 경로가 섞여 있지 않다", () => {
    for (const r of API_KEY_ROUTES) {
      // credits 는 **읽기(GET /api/credits)만** 의도적으로 열었다(billing:read) —
      // 충전·카드 등 쓰기는 여전히 세션 전용이어야 한다.
      if (r.path.source === "^\\/api\\/credits$") {
        assert.equal(r.method, "GET", "credits 는 GET 만 허용된다");
        continue;
      }
      assert.doesNotMatch(r.path.source, /superadmin|admin|auth|credits|distributions|youtube/,
        `화이트리스트에 들어가면 안 되는 경로: ${r.path}`);
    }
  });

  it("결제 쓰기(충전·카드)는 키로 못 부른다", () => {
    for (const p of ["/api/credits/topup", "/api/credits/topup/card", "/api/billing/card"]) {
      assert.equal(checkRoute("POST", p, all).ok, false, p);
    }
  });

  it("factory 라우트는 factory 스코프로 열린다", () => {
    assert.equal(checkRoute("POST", "/api/factory/ingest", ["factory:write"]).ok, true);
    assert.equal(checkRoute("GET", "/api/factory/jobs/f_1", ["factory:read"]).ok, true);
    assert.equal(checkRoute("GET", "/api/factory/jobs/f_1/performance", ["factory:read"]).ok, true);
    // 쓰기 스코프 없이 ingest 는 못 부른다
    assert.equal(checkRoute("POST", "/api/factory/ingest", ["factory:read"]).ok, false);
  });
});

describe("last_used_at 스로틀", () => {
  it("처음 쓰는 키는 바로 기록한다", () => {
    assert.equal(shouldTouchLastUsed(null, Date.now()), true);
    assert.equal(shouldTouchLastUsed("not-a-date", Date.now()), true);
  });

  it("1분 안에 다시 오면 쓰지 않는다", () => {
    const now = Date.now();
    assert.equal(shouldTouchLastUsed(new Date(now - 5_000), now), false);
    assert.equal(shouldTouchLastUsed(new Date(now - 120_000), now), true);
  });
});

describe("배선 — 키 경로가 같은 출구를 지나는가", () => {
  const fn = () => new RegExp("async function resolveTenant[\\s\\S]*?\\n}").exec(read("index.ts"))?.[0] ?? "";

  it("resolveTenant 가 키를 해석한다", () => {
    const f = fn();
    assert.notEqual(f, "", "resolveTenant 를 찾지 못했다");
    assert.match(f, /bearerKey\(/);
    assert.match(f, /lookupApiKey\(hashKey\(/, "평문으로 조회하면 안 된다 — 해시로 찾는다");
  });

  it("키 경로도 keyBlockReason 과 checkRoute 를 둘 다 탄다", () => {
    const f = fn();
    assert.match(f, /keyBlockReason\(/, "폐기·정지 검사가 없다");
    assert.match(f, /checkRoute\(/, "화이트리스트 없이 통과하면 라우트 118개가 다 열린다");
  });

  it("키 경로가 별도 스코프 우회를 만들지 않는다", () => {
    // 반환이 { scope: <그 회사> } 여야 기존 RLS 가 그대로 먹는다.
    // runAsSystem/ALL_TENANTS 로 빠지면 격리가 통째로 사라진다.
    const f = fn();
    assert.match(f, /scope:\s*row\.tenantId/, "키가 자기 회사 스코프로 안 들어간다");
    assert.doesNotMatch(f, /runAsSystem|ALL_TENANTS/, "키 경로가 시스템 스코프로 새면 안 된다");
  });

  it("발급 라우트가 평문을 저장하지 않는다", () => {
    const route = /app\.post\("\/api\/superadmin\/tenants\/:id\/api-keys"[\s\S]*?\n\}\);/.exec(read("index.ts"))?.[0] ?? "";
    assert.notEqual(route, "", "발급 라우트를 찾지 못했다");
    // INSERT 한 문장만 떼어 본다 — 라우트 전체를 보면 응답의 `key: raw`(평문을 한 번
    // 돌려주는 정상 동작)까지 걸려서 검사가 의미를 잃는다.
    // 닫는 괄호 개수는 호출 형태에 따라 다르다(`pool.query(...)` vs `asSystem((db) => db.query(...))`).
    const insert = /`INSERT INTO api_keys[\s\S]*?\n\s*\)+;/.exec(route)?.[0] ?? "";
    assert.notEqual(insert, "", "api_keys INSERT 를 찾지 못했다");
    assert.match(insert, /hashKey\(raw\)/, "해시가 아니라 평문을 넣고 있다");
    // 파라미터 배열에 맨 `raw` 가 섞이면 평문이 그대로 저장된다.
    assert.doesNotMatch(insert, /[,[]\s*raw\s*[,\]]/, "평문 raw 가 INSERT 파라미터로 들어간다");
  });

  it("폐기는 행을 지우지 않는다", () => {
    const route = /app\.post\("\/api\/superadmin\/api-keys\/:keyId\/revoke"[\s\S]*?\n\}\);/.exec(read("index.ts"))?.[0] ?? "";
    assert.notEqual(route, "", "폐기 라우트를 찾지 못했다");
    assert.match(route, /revoked_at = now\(\)/);
    assert.doesNotMatch(route, /DELETE FROM api_keys/, "누가 언제 발급·폐기했는지가 남아야 한다");
  });
});
