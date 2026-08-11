/**
 * 운영자 경로의 두 가지 경계 (다회사 · docs/plans/admin-multi-tenant-plan.md).
 *
 * 결정(2026-08-11): **운영자는 전부 볼 수 있어야 한다.** 그래서 읽기에서는 사유를 요구하지
 * 않는다 — 조회할 때마다 사유를 적어야 하면 지원이 안 굴러간다. 대신 두 가지를 지킨다:
 *
 *  1. **쓰기는 여전히 사유 강제.** 보는 것과 바꾸는 것은 되돌릴 수 있느냐가 다르다.
 *  2. **읽기도 감사에는 남는다.** 다 볼 수 있게 열어 준 만큼 견제를 기록으로 한다.
 *     "사유를 안 받는다"와 "기록을 안 남긴다"는 전혀 다른 얘기인데, 완화하다가 같이
 *     빠뜨리기 쉬운 자리다.
 *
 * 소스 스캔인 이유: 라우트마다 지켜야 하는 규칙이라 함수 하나를 검사해서는 알 수 없다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const INDEX = fs.readFileSync(path.resolve(SRC, "index.ts"), "utf-8");

/** `app.<method>("<path>", …)` 한 덩어리. */
function route(method: string, p: string): string {
  const re = new RegExp(
    `app\\.${method}\\("${p.replace(/[/:]/g, (m) => (m === ":" ? ":" : "\\/"))}"[\\s\\S]*?\\n\\}\\);`,
  );
  return re.exec(INDEX)?.[0] ?? "";
}

/** superadmin 라우트 전부 — 경로와 메서드를 소스에서 걷는다(손으로 적으면 새 라우트가 샌다). */
function superadminRoutes(): { method: string; path: string; body: string }[] {
  const out: { method: string; path: string; body: string }[] = [];
  for (const m of INDEX.matchAll(
    /app\.(get|post|patch|delete)\("(\/api\/superadmin\/[^"]*)"[\s\S]*?\n\}\);/g,
  )) {
    out.push({ method: m[1], path: m[2], body: m[0] });
  }
  return out;
}

describe("운영자 라우트 목록", () => {
  it("소스에서 걷어진다", () => {
    const rs = superadminRoutes();
    assert.ok(rs.length >= 9, `너무 적다 — 파싱이 깨졌다 (${rs.length}개)`);
  });

  it("전부 superadmin 세션을 요구한다", () => {
    // 하나라도 빠지면 로그인만 하면 남의 회사가 보인다.
    for (const r of superadminRoutes()) {
      assert.match(r.body, /requireSuperadmin\(c\)/, `가드 없음: ${r.method.toUpperCase()} ${r.path}`);
    }
  });
});

describe("쓰기는 사유를 요구한다", () => {
  /**
   * 사유가 면제되는 쓰기 — **하나뿐이고, 이유가 있어야 한다.**
   *
   * 회사 개설은 "남의 데이터를 건드리는 일"이 아니라 **빈 회사를 새로 만드는 일**이다.
   * 보호할 대상이 아직 없으므로 사유를 받아 봐야 기록에 의미가 없다. 반면 개설된 뒤의
   * 모든 변경(정지·초대·키 발급·키 폐기·계정 정지)은 남의 것을 건드리는 일이라 사유가 남는다.
   *
   * 여기 목록에 뭔가를 추가하려면 위와 같은 근거를 댈 수 있어야 한다.
   */
  const REASON_EXEMPT = new Set(["post /api/superadmin/tenants"]);

  it("기존 회사를 바꾸는 라우트에 requireReason 이 있다", () => {
    // 읽기(GET)는 결정에 따라 면제다. 바꾸는 것은 되돌리기 어려우므로 사유를 남긴다.
    const writes = superadminRoutes().filter((r) => r.method !== "get");
    assert.ok(writes.length >= 4, `쓰기 라우트를 못 찾았다 (${writes.length}개)`);
    for (const r of writes) {
      if (REASON_EXEMPT.has(`${r.method} ${r.path}`)) continue;
      assert.match(
        r.body,
        /requireReason\(/,
        `사유 없이 남의 회사를 바꿀 수 있다: ${r.method.toUpperCase()} ${r.path}`,
      );
    }
  });

  it("면제 목록이 조용히 늘지 않는다", () => {
    // 면제가 하나씩 늘면 어느 순간 사유 강제가 형식만 남는다. 개수를 못박아 둔다.
    assert.equal(REASON_EXEMPT.size, 1, "사유 면제를 늘렸다면 근거를 주석에 남길 것");
    // 면제된 경로가 실제로 존재하는지도 본다 — 라우트를 옮기면 면제만 남아 무의미해진다.
    for (const key of REASON_EXEMPT) {
      const [method, p] = key.split(" ");
      assert.ok(
        superadminRoutes().some((r) => r.method === method && r.path === p),
        `면제 목록에 없는 라우트가 있다: ${key}`,
      );
    }
  });
});

describe("읽기도 기록은 남긴다", () => {
  it("사유를 면제한 목록 라우트가 감사 기록을 부른다", () => {
    // 감사 로그 자체(/audit)는 예외 — 열람을 기록하면 무한 증식한다.
    for (const r of superadminRoutes()) {
      if (r.method !== "get" || r.path.endsWith("/audit")) continue;
      assert.match(r.body, /await audit\(/, `열람 기록이 없다: GET ${r.path}`);
    }
  });

  it("사용자 목록은 사유 없이도 열리지만 기록은 남는다", () => {
    const r = route("get", "/api/superadmin/users");
    assert.notEqual(r, "", "사용자 목록 라우트를 찾지 못했다");
    assert.doesNotMatch(r, /requireReason\(/, "읽기에 사유를 요구하면 지원이 안 굴러간다");
    assert.match(r, /audit\(actor, \{ action: "user\.list"/, "누가 봤는지 기록이 빠졌다");
    assert.match(r, /reason/, "사유를 받긴 받아야 한다(선택) — 기록에 같이 남는다");
  });
});

describe("회사 단위로 좁혀 볼 수 있다", () => {
  it("사용자·잡·감사 모두 tenant 필터를 받는다", () => {
    // 전역 목록만 있으면 "이 회사가 지금 어떤 상태인지" 를 한 곳에서 볼 수 없다(구멍 3).
    for (const p of ["/api/superadmin/users", "/api/superadmin/jobs", "/api/superadmin/audit"]) {
      const r = route("get", p);
      assert.notEqual(r, "", `${p} 를 찾지 못했다`);
      assert.match(r, /c\.req\.query\("tenant"\)/, `${p} 에 회사 필터가 없다`);
    }
  });

  it("감사 로그는 검색도 된다", () => {
    const r = route("get", "/api/superadmin/audit");
    assert.match(r, /c\.req\.query\("q"\)/, "300건 목록만으로는 되짚을 수 없다");
    // 사용자 입력을 SQL 에 이어 붙이면 안 된다 — 파라미터로만 넘긴다.
    assert.doesNotMatch(r, /ILIKE\s*'%\$\{/, "검색어를 문자열로 이어 붙였다");
    assert.match(r, /args\.push\(`%\$\{q\}%`\)/, "검색어가 바인딩 파라미터가 아니다");
  });
});
