/**
 * 쿠팡 로그인 도우미 배선 고정 — 웹 버튼 → 라우트 → 도우미가 한 줄로 이어져야 한다.
 *
 * 이 셋은 서로 다른 파일에 있어서 **한 군데만 바뀌어도 조용히 끊긴다.** 끊기면 증상이
 * "다운로드가 404" 또는 "받아서 실행했는데 아무 데도 등록이 안 됨" 이라 원인이 안 보인다.
 * 네이버 쪽(`naver-login-tool.test.ts`)이 같은 이유로 존재한다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => fs.readFileSync(path.resolve(SRC, p), "utf-8");
const INDEX = read("index.ts");
const TOOL = read("../scripts/coupang-login-tool.mts");
const WEB = read("../../web/src/components/publish/coupang-account.tsx");

/** 웹 버튼 · 라우트 · GCS 객체 경로가 같은 이름을 가리켜야 한다. */
const OBJECT = "tools/stepd-coupang-login.exe";

describe("웹에서 로그인을 시작할 수 있다", () => {
  it("배포채널 카드에 도우미 다운로드 버튼이 있다", () => {
    assert.match(WEB, /commerce\/login-tool/,
      "웹에 다운로드 링크가 없다 — 사용자가 로그인을 시작할 방법이 없어진다");
    assert.match(WEB, /로그인 도우미 다운로드/);
  });

  it("서버가 그 경로를 서빙한다", () => {
    assert.match(INDEX, /app\.get\("\/api\/commerce\/login-tool"/,
      "웹이 부르는 라우트가 서버에 없다 (404)");
  });

  it("라우트와 GCS 객체 경로가 같다", () => {
    const route = /app\.get\("\/api\/commerce\/login-tool"[\s\S]*?\n\}\);/.exec(INDEX)?.[0] ?? "";
    assert.notEqual(route, "", "라우트를 못 찾았다");
    assert.ok(route.includes(OBJECT), `라우트가 ${OBJECT} 를 가리키지 않는다`);
    assert.ok(TOOL.includes(OBJECT), "도우미 소스 주석의 배포 경로가 라우트와 다르다");
  });
});

describe("도우미가 올리는 곳 = 서버가 받는 곳", () => {
  it("도우미는 커머스 세션 라우트로 PUT 한다", () => {
    assert.match(TOOL, /\/api\/commerce\/account\/session/,
      "도우미가 세션을 어디에도 안 올린다");
    assert.match(INDEX, /app\.put\("\/api\/commerce\/account\/session"/,
      "서버에 그 라우트가 없다 — 도우미가 404 를 받는다");
  });

  it("계정이 없으면 도우미가 만든다 — 웹에서 미리 안 만들어도 끝난다", () => {
    assert.match(TOOL, /method: "PUT", body: JSON\.stringify\(\{ label/,
      "계정 생성 경로가 없으면 '먼저 웹에서 계정을 만드세요' 로 막힌다");
  });
});

describe("세션 취급 — 남의 쿠키를 섞지 않는다", () => {
  it("쿠팡 도메인 쿠키만 올린다", () => {
    assert.match(TOOL, /filter\(\(k\) => String\(k\.domain\)\.includes\("coupang\.com"\)\)/,
      "전체 쿠키를 올리면 STEP D 세션 쿠키까지 섞여 들어간다");
  });

  it("STEP D 세션 쿠키 이름이 쿠팡 필터에 걸리지 않는다", () => {
    // stepd_session 은 coupang.com 도메인이 아니므로 위 필터로 걸러진다 — 이름이 바뀌어도
    // 필터는 도메인 기준이라 안전하다. 그 전제를 문서화해 둔다.
    assert.match(TOOL, /SESSION_COOKIE = "stepd_session"/);
  });

  it("세션 쿠키를 expires -1 로 정규화한다 (playwright 규약)", () => {
    assert.match(TOOL, /expires: typeof k\.expires === "number" && k\.expires > 0 \? k\.expires : -1/,
      "CDP 의 세션 쿠키를 그대로 넘기면 playwright 가 못 읽는다");
  });
});

describe("쿠팡 특유의 제약이 도우미에도 반영돼 있다", () => {
  it("headless 로 띄우지 않는다 — 세션이 유효해도 차단된다", () => {
    assert.equal(/--headless/.test(TOOL), false,
      "headless 플래그가 있다 — 쿠팡은 창 없는 브라우저를 막는다(실측)");
  });

  it("자동화 흔적을 숨긴다", () => {
    assert.match(TOOL, /--disable-blink-features=AutomationControlled/);
  });

  it("어느 계정으로 정산되는지 사람에게 말한다", () => {
    assert.match(TOOL, /커미션이 정산됩니다/,
      "잘못된 계정으로 로그인하면 남의 회사 수익이 된다 — 도우미가 경고해야 한다");
  });
});
