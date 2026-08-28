/**
 * 웹→서버 프록시가 **홉바이홉 헤더를 지우는지** 고정한다 (2026-08-28).
 *
 * 사건: 화면에서 삭제를 눌렀더니 "삭제 실패 · fetch failed (UND_ERR_INVALID_ARG)".
 * 원인은 삭제와 아무 상관이 없었다 — `/api/proxy` 가 들어온 요청 헤더를 통째로 복사해
 * `transfer-encoding: chunked` 를 그대로 업스트림 fetch 에 실었고, undici 는 그 헤더를 보면
 * 요청을 만들지도 못하고 InvalidArgumentError 로 던진다.
 *
 * 프로덕션 실측(2026-08-28): 같은 URL 에
 *   content-length 로 보내면 → 401 (업스트림 도달)
 *   transfer-encoding: chunked 로 보내면 → 502 fetch failed (UND_ERR_INVALID_ARG)
 *
 * 본문이 청크로 오는 요청만 걸려서 "저장·삭제가 됐다 안 됐다" 로 보였다. 이런 간헐 실패는
 * 사람이 원인을 못 찾고 재시도만 반복하게 만든다 — 소스 스캔으로 못을 박는다.
 *
 * ⚠️ 이 테스트는 **apps/web** 소스를 읽는다. 웹에는 테스트 러너가 없고(`pnpm check` 는 서버
 *    테스트 + next build), 이 리포는 이미 automation.test.ts 등이 같은 방식으로 웹을 스캔한다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "src");
const read = (p: string) => fs.readFileSync(path.join(WEB, p), "utf-8");

/** undici 가 InvalidArgumentError(UND_ERR_INVALID_ARG)·NotSupportedError 로 던지는 헤더들. */
const FATAL = ["transfer-encoding", "keep-alive", "upgrade", "expect"];

describe("프록시는 홉바이홉 헤더를 지운다 — UND_ERR_INVALID_ARG 재발 방지", () => {
  const shared = read("lib/proxy-headers.ts");

  it("undici 가 거부하는 헤더가 목록에 전부 있다", () => {
    for (const h of FATAL) {
      assert.match(shared, new RegExp(`"${h}"`),
        `${h} 를 안 지우면 그 헤더가 실린 요청이 전부 502 로 죽는다`);
    }
  });

  it("connection·content-length 는 목록에 없다 — 프록시가 따로 다룬다", () => {
    // connection 은 바로 뒤에서 close 로 덮어써야 하고(죽은 소켓 재사용 차단),
    // content-length 는 본문을 버퍼로 다시 실으므로 undici 가 새로 계산한다.
    // 목록에 넣어 지우는 것 자체는 무해하지만, 두 헤더의 의도가 목록에 섞이면
    // 나중에 누가 목록만 보고 "connection 도 안 나가는구나" 로 오독한다.
    assert.doesNotMatch(shared, /"connection"/, "connection 은 덮어쓰는 헤더다 — 목록에 두지 말 것");
    assert.doesNotMatch(shared, /"content-length"/, "content-length 는 프록시가 따로 지운다");
  });

  for (const route of ["app/api/proxy/[[...path]]/route.ts", "app/api/render-proxy/[[...path]]/route.ts"]) {
    it(`${route} 가 목록을 실제로 적용한다`, () => {
      const src = read(route);
      assert.match(src, /import \{ HOP_BY_HOP \} from "@\/lib\/proxy-headers"/,
        "공용 목록을 안 쓴다 — 한쪽만 고쳐지는 사고가 난다");
      assert.match(src, /for \(const h of HOP_BY_HOP\) headers\.delete\(h\)/,
        "목록을 가져오기만 하고 안 지운다");
      // 순서가 중요하다: 지운 **뒤에** connection 을 세워야 close 가 살아남는다.
      const stripAt = src.indexOf("for (const h of HOP_BY_HOP)");
      const connAt = src.indexOf('headers.set("connection", "close")');
      assert.ok(stripAt > 0 && connAt > 0, "앵커를 못 찾았다");
      assert.ok(stripAt < connAt, "connection 을 세운 뒤에 지우면 close 가 사라진다");
    });
  }
});
