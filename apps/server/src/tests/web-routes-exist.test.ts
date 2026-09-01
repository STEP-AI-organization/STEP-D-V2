import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **웹이 부르는 경로가 서버에 실제로 있는지** 확인한다.
 *
 * 왜 필요한가 (실측 2026-08-31): 권리 게이트 라우트 7개를 지우면서 같은 덩어리에 있던
 * `POST /api/automation/run` 이 **무관한데 함께 삭제됐다.** 서버는 컴파일되고 테스트도
 * 1290개 전부 초록인데, 화면의 [자동 배포 시작]·[지금 확인하기] 만 매번 404 를 받았다.
 * 더 나쁜 건 실패 모양이었다 — 계획은 저장돼 워커가 실제로 발행을 시작하는데 화면은
 * "시작 실패" 를 띄워서, 운영자는 안 켜졌다고 믿는 채 영상이 나갔다.
 *
 * 타입은 이 경계를 못 지킨다(웹→서버는 문자열 URL 이다). 그래서 문자열로 맞춰 본다.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_INDEX = path.resolve(HERE, "../index.ts");
const WEB_API = path.resolve(HERE, "../../../web/src/lib/data/api.ts");

/**
 * 주석을 지운다 — 주석 안의 예시 URL(`.../analysis/{path}`)까지 라우트로 세면 안 된다.
 *
 * ⚠️ 블록 주석은 **줄 맨 앞에서 시작하는 것만** 지운다. `/\*` 를 아무 데서나 열면 문자열이나
 * 정규식 리터럴 안의 `/\*` 에 걸려 그 뒤 수백 줄을 통째로 먹는다 — 실측으로 index.ts 의
 * 라우트 249개 중 2개(`/api/meta/accounts` 등)가 그렇게 사라져 "웹이 부르는데 서버에 없다" 는
 * 거짓 실패가 났다. 검사기가 검사 대상을 지우면 못 쓴다.
 */
function stripComments(source: string): string {
  return source.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** 경로 조각을 `:param` 으로 정규화한다. */
function normalize(raw: string): string {
  return raw
    .split("/")
    .map((seg) => (seg.includes(":p") ? ":p" : seg))
    .join("/")
    .replace(/\/+$/, "");
}

/** index.ts 의 `app.get("/api/…")` 류에서 경로만 뽑아 같은 방식으로 정규화한다. */
function serverRoutes(source: string): Set<string> {
  const out = new Set<string>();
  const re = /\bapp\.(get|post|put|patch|delete|all)\(\s*["'`](\/api\/[^"'`]*)["'`]/g;
  for (const m of source.matchAll(re)) {
    out.add(normalize(m[2].replace(/:[A-Za-z_][\w]*/g, ":p")));
  }
  return out;
}

/**
 * api.ts 의 `${API_BASE}/…` 에서 경로만 뽑는다.
 *
 * ⚠️ 정규식으로 `\$\{[^}]*\}` 를 지우면 **중첩 템플릿에서 깨진다** —
 * `/meta/auth${qs ? `?${qs}` : ""}` 는 첫 `}` 에서 잘려 `/meta/auth${qs ` 가 남는다.
 * 그래서 중괄호 깊이를 세며 직접 훑는다. 깊이 0 의 백틱이 문자열 끝, 깊이 0 의 `?` 가
 * 쿼리스트링 시작이다.
 *
 * 보간이 **경로 조각 하나를 통째로** 차지할 때만(`/${id}/`) 경로 파라미터로 본다.
 * `auth${qs…}` 처럼 조각 중간에 붙는 건 쿼리스트링 조립이므로 거기서 경로가 끝난다 —
 * 이걸 구분 안 하면 `/meta/auth` 가 `/meta/:p` 로 뭉개져 있지도 않은 라우트를 찾게 된다.
 */
function webPaths(source: string): Set<string> {
  const out = new Set<string>();
  const marker = "${API_BASE}";
  for (let i = source.indexOf(marker); i !== -1; i = source.indexOf(marker, i + 1)) {
    let depth = 0;
    let seg = "";
    for (let j = i + marker.length; j < source.length; j += 1) {
      const c = source[j];
      if (c === "$" && source[j + 1] === "{") {
        if (!seg.endsWith("/")) break;        // 조각 중간의 보간 = 쿼리스트링 조립 → 경로 끝
        depth += 1; j += 1; seg += ":p"; continue;
      }
      if (depth > 0) { if (c === "{") depth += 1; else if (c === "}") depth -= 1; continue; }
      if (c === "`" || c === "\n" || c === '"' || c === "'" || c === "?") break;
      seg += c;
    }
    const p = normalize(seg);
    if (p.startsWith("/")) out.add(`/api${p}`);
  }
  return out;
}

describe("웹이 부르는 서버 라우트가 전부 존재한다", () => {
  it("api.ts 의 모든 경로가 index.ts 에 있다", () => {
    const routes = serverRoutes(stripComments(fs.readFileSync(SERVER_INDEX, "utf-8")));
    const missing = [...webPaths(stripComments(fs.readFileSync(WEB_API, "utf-8")))].filter((p) => !routes.has(p));
    assert.deepEqual(missing, [],
      "웹이 부르는데 서버에 없는 경로다 — 라우트를 지웠다면 호출부도 같이 지웠어야 한다");
  });

  it("스캐너 자체가 살아 있다 — 양쪽에서 경로를 실제로 찾았다", () => {
    // ⚠️ 정규식이 안 맞으면 위 테스트는 "빈 목록 vs 빈 목록" 으로 **항상 통과**한다.
    // 검사 범위가 0 이 된 걸 초록으로 착각하지 않게 하한을 박아 둔다.
    assert.ok(serverRoutes(stripComments(fs.readFileSync(SERVER_INDEX, "utf-8"))).size > 150, "서버 라우트를 못 찾았다");
    assert.ok(webPaths(stripComments(fs.readFileSync(WEB_API, "utf-8"))).size > 80, "웹 호출 경로를 못 찾았다");
  });
});
