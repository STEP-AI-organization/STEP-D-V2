/**
 * 네이버 자동 로그인(아이디·비번) 불변식.
 *
 * 이 기능의 실패는 **계정 잠금**으로 끝난다 — 틀린 비번으로 워커가 발행마다 로그인을 시도하면
 * 네이버가 계정을 잠그고, 그건 세션 만료보다 훨씬 나쁜 상태다(사람이 네이버에서 직접 풀어야
 * 한다). 그래서 "실패하면 지운다" 를 코드로 고정한다.
 *
 * 비밀번호는 세션보다 위험한 자산이기도 하다 — 다른 서비스에서도 통하고, 본인이 바꾸기
 * 전에는 무효화되지 않는다. 저장·노출 경로도 함께 잠근다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, beforeEach, afterEach } from "node:test";

import { maskNaverId, sealCredential, openCredential, credStoreReady } from "../naver-cred-store.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string) => fs.readFileSync(path.resolve(SRC, f), "utf-8");

let saved: string | undefined;
beforeEach(() => { saved = process.env.NAVER_CRED_KEY; });
afterEach(() => {
  if (saved === undefined) delete process.env.NAVER_CRED_KEY;
  else process.env.NAVER_CRED_KEY = saved;
});
const KEY = Buffer.alloc(32, 7).toString("base64");

describe("자격증명 봉인", () => {
  it("키가 없으면 저장을 거부한다 — 평문 폴백 없음", () => {
    delete process.env.NAVER_CRED_KEY;
    assert.equal(credStoreReady(), false);
    assert.throws(() => sealCredential({ id: "a", pw: "b" }), /미설정/);
  });

  it("왕복한다", () => {
    process.env.NAVER_CRED_KEY = KEY;
    const blob = sealCredential({ id: " ha983885 ", pw: "p@ss" });
    assert.equal(blob.includes("ha983885"), false, "봉인값에 평문이 보인다");
    assert.deepEqual(openCredential(blob), { id: "ha983885", pw: "p@ss" });
  });

  it("빈 값은 저장하지 않는다", () => {
    process.env.NAVER_CRED_KEY = KEY;
    assert.throws(() => sealCredential({ id: "", pw: "x" }));
    assert.throws(() => sealCredential({ id: "x", pw: "" }));
  });

  it("못 풀면 null — 워커를 죽이지 않는다", () => {
    process.env.NAVER_CRED_KEY = KEY;
    assert.equal(openCredential("v1:쓰레기:값:들"), null);
    assert.equal(openCredential(null), null);
  });

  it("세션과 **다른 키**를 쓴다 — 하나가 새도 다른 쪽은 안 열린다", () => {
    const cred = read("naver-cred-store.ts");
    assert.match(cred, /NAVER_CRED_KEY/);
    assert.equal(/NAVER_SESSION_KEY/.test(cred), false, "세션 키를 재사용하면 분리가 무의미하다");
  });

  it("아이디를 가려서 보여준다", () => {
    assert.equal(maskNaverId("ha983885"), "ha9***85");
    assert.equal(maskNaverId("abc"), "a***");
    assert.equal(maskNaverId(""), "");
  });
});

describe("실패 처리 — 계정 잠금을 막는다", () => {
  const worker = read("worker.ts");
  const handler = /async function handleNaverLogin[\s\S]*?\n\}(?=\r?\n)/.exec(worker)?.[0] ?? "";

  it("로그인 핸들러가 있다", () => {
    assert.notEqual(handler, "", "handleNaverLogin 을 못 찾았다");
  });

  it("**비번이 틀리면 자격증명을 지운다** — 반복 시도가 계정을 잠근다", () => {
    assert.match(handler, /bad_credentials/, "실패 종류를 구분하지 않는다");
    assert.match(handler, /clear\s*=\s*res\.kind === "bad_credentials"/,
      "틀린 비번을 그대로 들고 있으면 발행마다 재시도해 계정이 잠긴다");
    assert.match(handler, /markNaverCredential\([\s\S]{0,120}\{ clear \}/,
      "삭제 플래그가 저장 경로까지 안 간다");
  });

  it("추가 인증(캡차·2차)은 자격증명을 남긴다 — 비번은 맞을 수 있다", () => {
    const tv = read("naver-tv.ts");
    assert.match(tv, /kind: "challenge"/, "추가 인증을 별도로 분류하지 않는다");
  });

  it("성공하면 세션을 **서버에도** 저장한다 — 다른 워커도 쓰게", () => {
    assert.match(handler, /setNaverSessionBlob/, "로컬에만 저장하면 그 PC 에서만 산다");
    assert.match(handler, /saveNaverSession/, "로컬 저장이 없으면 지금 발행에 못 쓴다");
  });

  it("잡 테넌트와 계정 테넌트를 대조한다", () => {
    assert.match(handler, /acct\.tenantId !== jobTenant/,
      "다른 회사 계정으로 로그인할 수 있다");
  });
});

describe("자동 복구 — 세션이 죽어도 사람을 안 부른다", () => {
  const worker = read("worker.ts");

  it("발행 중 세션 만료 시 자동 재로그인을 시도한다", () => {
    assert.match(worker, /tryAutoRelogin\(job, acct\)/,
      "세션이 없으면 곧장 실패시킨다 — 자격증명이 있어도 안 쓴다");
  });

  it("자격증명이 없으면 시도조차 안 한다", () => {
    const fn = /async function tryAutoRelogin[\s\S]*?\n\}(?=\r?\n)/.exec(worker)?.[0] ?? "";
    assert.notEqual(fn, "");
    assert.match(fn, /if \(!blob\) return false/, "자격증명 없이 로그인 시도를 하면 무의미한 실패만 쌓인다");
  });

  it("naver.login 이 도는 레인에 있다", () => {
    const lanes = /const JOB_LANES[^=]*=\s*\{([\s\S]*?)\n\};/.exec(worker)?.[1] ?? "";
    assert.match(lanes, /naver:\s*\["naver\.publish", "naver\.login"\]/,
      "레인에 없으면 잡이 영원히 pending 으로 쌓인다");
  });
});

describe("노출 경로 — 값이 새지 않는다", () => {
  it("자격증명 blob 이 계정 공용 SELECT 목록에 없다", () => {
    const db = read("db-pg.ts");
    const cols = /const NAVER_ACCOUNT_COLS = `([\s\S]*?)`/.exec(db)?.[1] ?? "";
    assert.notEqual(cols, "", "NAVER_ACCOUNT_COLS 를 못 찾았다");
    assert.equal(cols.includes("cred_blob"), false, "목록·응답·에러덤프 어디로든 샌다");
  });

  it("라우트가 값을 되돌려주지 않는다", () => {
    const index = read("index.ts");
    const route = /app\.put\("\/api\/naver\/accounts\/:id\/credentials"[\s\S]*?\n\}\);/.exec(index)?.[0] ?? "";
    assert.notEqual(route, "", "자격증명 저장 라우트를 못 찾았다");
    assert.match(route, /maskNaverId/, "아이디를 그대로 돌려준다");
    // 응답 **객체 리터럴 안**만 본다 — `c.json(` 뒤 200자 식으로 느슨하게 잡으면 바로 아래의
    // sealCredential({ id, pw }) 까지 걸려 오탐이 난다(실제로 그랬다).
    for (const m of route.matchAll(/c\.json\((\{[^}]*\})/g)) {
      assert.equal(/\bpw\b|naverPw/.test(m[1]), false, `응답에 비밀번호가 실린다: ${m[1].slice(0, 80)}`);
    }
    // 평문 비번이 흘러가는 곳은 봉인 함수 하나뿐이어야 한다.
    const pwUses = [...route.matchAll(/naverPw/g)].length;
    assert.ok(pwUses <= 3, `naverPw 사용처가 ${pwUses}곳 — 봉인·검증 외로 새는지 확인할 것`);
    assert.match(route, /sealCredential\(\{ id: naverId, pw: naverPw \}\)/,
      "비밀번호가 봉인을 거치지 않고 저장된다");
    assert.match(route, /requireManager\(c\)/, "관리자 확인이 없다");
  });

  it("화면이 입력값을 state 에 남기지 않는다", () => {
    const web = read("../../web/src/components/publish/naver-credentials.tsx");
    assert.match(web, /setId\(""\); setPw\(""\);/,
      "보낸 뒤 폼을 비우지 않으면 devtools·에러리포트로 비밀번호가 샌다");
    assert.match(web, /type="password"/);
  });
});
