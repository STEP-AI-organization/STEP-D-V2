/**
 * 회사 온보딩 고정 (다회사 2단계).
 *
 * 두 가지를 잠근다:
 *  1. **한글 회사 이름** — 예전 id 유도가 한글을 전부 `t__` 로 만들어서, 두 번째 한글
 *     회사부터 duplicate_id 로 막혔다. 방송사 이름은 대개 한글이라 사실상 못 쓰는 상태.
 *  2. **반쪽 회사 금지** — owner 없이 회사만 만들어지면 아무도 못 들어간다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  MAX_INITIAL_CREDITS,
  TENANT_ID_RE,
  clampInitialCredits,
  deriveTenantId,
  grantDedupeKey,
  inviteLink,
  looksLikeEmail,
  normalizeKind,
  planOnboarding,
} from "./onboarding.ts";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => fs.readFileSync(path.resolve(SRC, f), "utf-8");

describe("테넌트 id 유도", () => {
  it("영문 이름은 읽히는 id 가 된다", () => {
    assert.equal(deriveTenantId("KBS Media", "abc"), "t_kbs_media");
    assert.equal(deriveTenantId("SBS", "abc"), "t_sbs");
  });

  it("한글 이름끼리 충돌하지 않는다", () => {
    // 예전엔 셋 다 `t__` 였다. 첫 회사만 만들어지고 나머지는 duplicate_id 409.
    const ids = ["한국방송", "문화방송", "스텝에이아이"].map((n, i) => deriveTenantId(n, `n${i}`));
    assert.equal(new Set(ids).size, 3, `한글 이름이 같은 id 로 뭉쳤다: ${ids.join(", ")}`);
    for (const id of ids) assert.match(id, TENANT_ID_RE, `형식을 벗어난 id: ${id}`);
    assert.ok(!ids.includes("t__"), "빈 슬러그가 그대로 id 가 됐다");
  });

  it("기호만 있는 이름도 형식을 지킨다", () => {
    for (const name of ["...", "   ", "!!!", "株式会社"]) {
      const id = deriveTenantId(name, "f00d");
      assert.match(id, TENANT_ID_RE, `${name} → ${id}`);
    }
  });

  it("밑줄이 앞뒤에 남지 않는다", () => {
    // "t_kbs_" 같은 지저분한 id 가 목록에 남으면 계속 눈에 밟힌다.
    assert.equal(deriveTenantId("  KBS  ", "x"), "t_kbs");
    assert.equal(deriveTenantId("(주)KBS", "x"), "t_kbs");
  });
});

describe("입력 판정", () => {
  it("owner 이메일이 없으면 회사를 안 만든다", () => {
    const r = planOnboarding({ name: "한국방송" }, "n1");
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error, "owner_email_required");
    assert.match(r.message, /아무도/, "왜 필수인지 말해줘야 한다");
  });

  it("이메일 오타를 잡는다", () => {
    for (const bad of ["hkj", "hkj@", "@stepai.kr", "hkj@stepai", "a b@c.kr"]) {
      const r = planOnboarding({ name: "회사", ownerEmail: bad }, "n1");
      assert.equal(r.ok, false, `통과하면 안 되는 이메일: ${bad}`);
    }
    assert.ok(looksLikeEmail("hkj@stepai.kr"));
  });

  it("정상 입력은 계획을 돌려준다", () => {
    const r = planOnboarding(
      { name: "한국방송", ownerEmail: "owner@kbs.co.kr", kind: "web", initialCredits: 60 },
      "n1",
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.plan.name, "한국방송");
    assert.equal(r.plan.kind, "web");
    assert.equal(r.plan.initialCredits, 60);
    assert.match(r.plan.id, TENANT_ID_RE);
  });

  it("id 를 직접 주면 그걸 쓰고, 형식이 틀리면 막는다", () => {
    const ok = planOnboarding({ name: "회사", ownerEmail: "a@b.kr", id: "t_kbs" }, "n1");
    assert.equal(ok.ok && ok.plan.id, "t_kbs");
    for (const bad of ["kbs", "T_KBS", "t_kbs-media", "t_", "t_한글"]) {
      const r = planOnboarding({ name: "회사", ownerEmail: "a@b.kr", id: bad }, "n1");
      assert.equal(r.ok, false, `통과하면 안 되는 id: ${bad}`);
    }
  });

  it("kind 는 모르면 api 로 떨어진다", () => {
    // internal 은 사내용이다 — 오타가 사내 등급으로 붙으면 안 된다.
    assert.equal(normalizeKind("internal"), "internal");
    assert.equal(normalizeKind("enterprise"), "api");
    assert.equal(normalizeKind(undefined), "api");
    assert.equal(normalizeKind("INTERNAL"), "api");
  });

  it("초기 크레딧은 0..상한 정수로 눌린다", () => {
    assert.equal(clampInitialCredits(60), 60);
    assert.equal(clampInitialCredits("60"), 60);
    assert.equal(clampInitialCredits(60.9), 60);
    assert.equal(clampInitialCredits(-5), 0);
    assert.equal(clampInitialCredits("abc"), 0);
    assert.equal(clampInitialCredits(undefined), 0);
    assert.equal(clampInitialCredits(999_999_999), MAX_INITIAL_CREDITS);
  });
});

describe("초대 링크", () => {
  it("PUBLIC_URL 이 있으면 바로 보낼 수 있는 링크를 만든다", () => {
    assert.equal(
      inviteLink("https://stepd.stepai.kr", "inv_abc"),
      "https://stepd.stepai.kr/invite?token=inv_abc",
    );
    assert.equal(inviteLink("https://stepd.stepai.kr/", "inv_abc"), "https://stepd.stepai.kr/invite?token=inv_abc");
  });

  it("PUBLIC_URL 이 없으면 가짜 링크를 만들지 않는다", () => {
    // 안 되는 링크를 주면 운영자가 그걸 보내고, 초대받은 쪽은 왜 안 되는지 모른다.
    assert.equal(inviteLink(undefined, "inv_abc"), null);
    assert.equal(inviteLink("", "inv_abc"), null);
    assert.equal(inviteLink("   ", "inv_abc"), null);
  });

  it("토큰을 URL 인코딩한다", () => {
    assert.match(inviteLink("https://x.kr", "a b&c")!, /token=a%20b%26c/);
  });
});

describe("배선 — 한 트랜잭션인가", () => {
  const route = () =>
    /app\.post\("\/api\/superadmin\/tenants"[\s\S]*?\n\}\);/.exec(read("index.ts"))?.[0] ?? "";

  it("회사 생성 라우트를 찾는다", () => {
    assert.notEqual(route(), "", "라우트를 찾지 못했다");
  });

  it("회사·초대·크레딧이 한 트랜잭션 안에 있다", () => {
    const r = route();
    assert.match(r, /withRawTransaction\(/, "트랜잭션이 없으면 반쪽 회사가 남는다");
    const tx = /withRawTransaction\(async \(db\) => \{[\s\S]*?\n {4}\}\);/.exec(r)?.[0] ?? "";
    assert.notEqual(tx, "", "트랜잭션 블록을 찾지 못했다");
    assert.match(tx, /INSERT INTO tenants/, "회사 INSERT 가 트랜잭션 밖에 있다");
    assert.match(tx, /createInvite\(/, "초대가 트랜잭션 밖에 있으면 실패해도 회사가 남는다");
    assert.match(tx, /credit_ledger/, "초기 크레딧이 트랜잭션 밖에 있다");
  });

  it("초대를 같은 연결(db)로 넘긴다", () => {
    // createInvite 에 db 를 안 넘기면 풀에서 별도 연결로 돌아 **롤백에 안 걸린다** —
    // 트랜잭션을 열어 놓고도 초대만 살아남는 최악의 모양이 된다.
    const tx = /withRawTransaction\(async \(db\) => \{[\s\S]*?\n {4}\}\);/.exec(route())?.[0] ?? "";
    assert.match(tx, /createInvite\([\s\S]*?\bdb\b[\s\S]*?\)/, "createInvite 가 트랜잭션 연결을 안 쓴다");
  });

  it("crypto.randomBytes 로 nonce 를 만든다 — 한글 이름 충돌 방지", () => {
    assert.match(route(), /planOnboarding\(body, crypto\.randomBytes/);
  });

  it("초기 크레딧은 grant 다 — topup 과 섞으면 매출이 부풀어 보인다", () => {
    assert.match(route(), /'grant'/, "무상 지급을 topup 으로 적으면 결제 매출로 잡힌다");
    assert.match(route(), /grantDedupeKey\(/, "dedupe 키가 없으면 개설 지급이 두 번 쌓일 수 있다");
    assert.equal(grantDedupeKey("t_kbs"), "grant:onboarding:t_kbs");
  });
});
