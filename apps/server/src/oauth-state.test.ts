import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * OAuth 콜백은 **우리가 발급한 state 만** 받아야 한다.
 *
 * 검증이 없으면 공격자가 자기 code 를 담은 콜백 URL 을 만들어 로그인된 운영자에게 열게
 * 하는 것만으로 공격자 계정이 그 워크스페이스에 "연결됨" 으로 붙는다(세션 쿠키가
 * SameSite=Lax 라 최상위 GET 에 그대로 실린다). 배포 채널이 하나뿐이면 자동 선택까지 되므로
 * 방송사 클립이 남의 채널로 나갈 수 있는 경로였다 — 순수 함수로 증명이 안 되는 배선이라
 * 소스 스캔으로 고정한다.
 */
const SERVER = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf-8");

describe("OAuth state 검증 배선", () => {
  it("콜백 4종이 전부 oauthStateGuard 를 지난다", () => {
    for (const name of ["oauthCallback", "metaOauthCallback", "instagramOauthCallback", "tiktokOauthCallback"]) {
      const decl = new RegExp(`const ${name} = ([\\w]+)\\(`).exec(SERVER);
      assert.ok(decl, `${name} 선언을 못 찾았다`);
      assert.equal(decl![1], "oauthStateGuard",
        `${name} 이 state 검증을 안 지난다 — 남이 만든 콜백 URL 로 계정이 붙는다`);
    }
  });

  it("콜백이 state 를 직접 base64 로 까지 않는다", () => {
    // 예전 방식: JSON.parse(Buffer.from(state, "base64")) — 서명도 대조도 없는 '자칭' 값.
    const raw = SERVER.match(/Buffer\.from\(c\.req\.query\("state"\)/g) ?? [];
    assert.equal(raw.length, 0,
      "state 를 그대로 신뢰하는 코드가 남아 있다 — consumeOAuthState 로 바꿀 것");
  });

  it("동의 URL 은 서버 발급 state 를 쓴다 (base64 JSON 조립 금지)", () => {
    const forged = SERVER.match(/const state = Buffer\.from\(JSON\.stringify/g) ?? [];
    assert.equal(forged.length, 0,
      "브라우저가 고칠 수 있는 state 를 만들고 있다 — issueOAuthState 를 쓸 것");
    const issued = SERVER.match(/await issueOAuthState\(/g) ?? [];
    assert.ok(issued.length >= 5,
      `state 발급부가 ${issued.length}곳뿐 — YouTube·factory·Meta·Instagram·TikTok 5곳이어야 한다`);
  });

  it("계정 저장은 발급 시점 워크스페이스에서 돈다 (쿠키가 아니라)", () => {
    // 외부 채널 연결 링크는 **채널 주인**이 연다 — 쿠키로 판정하면 엉뚱한 곳에 붙는다.
    assert.match(SERVER, /st\.tenant \? runWithTenant\(\{ scope: st\.tenant, via: "web" \}, run\) : run\(\)/,
      "발급 워크스페이스로 컨텍스트를 고정하지 않으면 계정 귀속이 브라우저 쿠키에 좌우된다");
  });
});
