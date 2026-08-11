/**
 * 회사 온보딩 고정 (다회사 2단계).
 *
 * 두 가지를 잠근다:
 *  1. **id 는 순번이다.** 이름에서 만들지 않는다 — 한글 이름은 슬러그가 비어서 예전엔
 *     전부 `t__` 로 충돌했고, 난수로 때우면(`t_a3f9c2b1e0`) 사람이 못 읽는 값이 영구히 박힌다.
 *     id 가 로그에 보이는 게 문제였다면 **로그가 이름을 보여주면 될 일**이다.
 *  2. **반쪽 회사 금지** — owner 없이 회사만 만들어지면 아무도 못 들어간다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  MAX_INITIAL_CREDITS,
  RESERVED_TENANT_IDS,
  TENANT_ID_RE,
  clampInitialCredits,
  grantDedupeKey,
  inviteLink,
  looksLikeEmail,
  nextTenantId,
  normalizeKind,
  planOnboarding,
} from "./onboarding.ts";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => fs.readFileSync(path.resolve(SRC, f), "utf-8");

describe("회사 id — 순번", () => {
  it("빈 목록이면 1 부터", () => {
    assert.equal(nextTenantId([]), "1");
  });

  it("가장 큰 번호 다음을 준다", () => {
    assert.equal(nextTenantId(["1", "2", "3"]), "4");
    assert.equal(nextTenantId(["3", "1", "2"]), "4", "순서와 무관해야 한다");
    // 중간이 지워져도 재사용하지 않는다 — 지워진 회사의 id 를 다른 회사가 물려받으면
    // 옛 로그·원장이 엉뚱한 회사 것으로 읽힌다.
    assert.equal(nextTenantId(["1", "3"]), "4");
  });

  it("숫자가 아닌 기존 id 는 무시한다", () => {
    // t_default 같은 옛 id 와 섞여 있어도 상관없다.
    assert.equal(nextTenantId(["t_default"]), "1");
    assert.equal(nextTenantId(["t_default", "1", "2"]), "3");
  });

  it("만든 id 는 형식 검사를 통과한다", () => {
    for (const ids of [[], ["1"], ["t_default", "9"]]) {
      assert.match(nextTenantId(ids), TENANT_ID_RE);
    }
  });

  it("이름은 id 에 영향을 주지 않는다", () => {
    // 한글이든 영문이든 기호든 같은 목록이면 같은 번호가 나온다.
    assert.equal(nextTenantId(["1"]), "2");
  });
});

describe("입력 판정", () => {
  it("owner 이메일이 없으면 회사를 안 만든다", () => {
    const r = planOnboarding({ name: "한국방송" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error, "owner_email_required");
    assert.match(r.message, /아무도/, "왜 필수인지 말해줘야 한다");
  });

  it("이메일 오타를 잡는다", () => {
    for (const bad of ["hkj", "hkj@", "@stepai.kr", "hkj@stepai", "a b@c.kr"]) {
      const r = planOnboarding({ name: "회사", ownerEmail: bad });
      assert.equal(r.ok, false, `통과하면 안 되는 이메일: ${bad}`);
    }
    assert.ok(looksLikeEmail("hkj@stepai.kr"));
  });

  it("정상 입력은 계획을 돌려준다", () => {
    const r = planOnboarding({
      name: "한국방송", ownerEmail: "owner@kbs.co.kr", kind: "web", initialCredits: 60,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.plan.name, "한국방송");
    assert.equal(r.plan.kind, "web");
    assert.equal(r.plan.initialCredits, 60);
    // id 는 여기서 안 정한다 — 라우트가 트랜잭션 안에서 순번을 매긴다.
    assert.equal(r.plan.id, null);
  });

  it("id 를 손으로 주는 경로는 남아 있다 (마이그레이션·픽스처용)", () => {
    // 화면에는 입력란이 없다. API 로 줄 때만 형식을 본다.
    const ok = planOnboarding({ name: "회사", ownerEmail: "a@b.kr", id: "t_default" });
    assert.equal(ok.ok && ok.plan.id, "t_default");
    for (const bad of ["T_KBS", "한글", "-kbs", "kbs kbs", "a".repeat(41)]) {
      const r = planOnboarding({ name: "회사", ownerEmail: "a@b.kr", id: bad });
      assert.equal(r.ok, false, `통과하면 안 되는 id: ${bad}`);
    }
  });

  it("예약어는 회사 id 로 못 쓴다", () => {
    // `all`·`system` 같은 값이 회사 id 가 되면 로그에서 "특별한 뜻"과 구분이 안 된다.
    for (const bad of RESERVED_TENANT_IDS) {
      const r = planOnboarding({ name: "회사", ownerEmail: "a@b.kr", id: bad });
      assert.equal(r.ok, false, `예약어가 통과했다: ${bad}`);
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

  it("id 를 트랜잭션 안에서 매긴다", () => {
    // 밖에서 읽고 안에서 쓰면, 두 개가 동시에 만들어질 때 같은 번호가 둘 생긴다.
    const tx = /withRawTransaction\(async \(db\) => \{[\s\S]*?\n {4}\}\);/.exec(route())?.[0] ?? "";
    assert.match(tx, /nextTenantId\(/, "id 계산이 트랜잭션 밖에 있다");
    assert.match(tx, /SELECT id FROM tenants/, "현재 목록을 트랜잭션 안에서 읽어야 한다");
  });

  it("감사 기록에 만들어진 id 가 남는다", () => {
    // id 가 트랜잭션 안에서 정해지므로, 감사를 앞에 두면 대상이 null 로 남는다.
    assert.match(route(), /targetTenant: made\.id/, "감사 대상이 실제 id 가 아니다");
  });

  it("초기 크레딧은 grant 다 — topup 과 섞으면 매출이 부풀어 보인다", () => {
    assert.match(route(), /'grant'/, "무상 지급을 topup 으로 적으면 결제 매출로 잡힌다");
    assert.match(route(), /grantDedupeKey\(/, "dedupe 키가 없으면 개설 지급이 두 번 쌓일 수 있다");
    assert.equal(grantDedupeKey("t_kbs"), "grant:onboarding:t_kbs");
  });
});
