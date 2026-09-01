/**
 * 회사 사업자정보 고정.
 *
 * 문서에 잘못된 사업자등록번호가 찍혀 나가면 상대가 회계 처리를 못 하고, 다시 만들어
 * 보내야 하는 일이 된다. 그래서 **저장 전에** 최대한 거른다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  checkProfile,
  formatBizNo,
  incompleteFields,
  isValidBizNo,
  normalizeBizNo,
} from "../billing/business.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = fs.readFileSync(path.resolve(SRC, "index.ts"), "utf-8");

describe("사업자등록번호 검증", () => {
  it("실존 번호를 통과시킨다", () => {
    // 공개된 실제 번호로 체크섬 구현이 맞는지 검산한다 — 알고리즘을 잘못 옮기면
    // 정상 번호가 전부 막히고, 그건 아무도 못 채우는 화면이 된다.
    assert.equal(isValidBizNo("1208147521"), true, "네이버");
    assert.equal(isValidBizNo("1018100068"), true, "삼성전자");
    assert.equal(isValidBizNo("120-81-47521"), true, "하이픈이 있어도 같은 값");
  });

  it("한 자리만 틀려도 잡는다", () => {
    assert.equal(isValidBizNo("2208147521"), false, "첫자리 변조");
    assert.equal(isValidBizNo("1208147522"), false, "끝자리 변조");
    assert.equal(isValidBizNo("1234567890"), false);
  });

  it("자리표시자를 막는다", () => {
    // ⚠️ `0000000000` 은 **체크섬을 통과한다**(합 0 → 검증자리 0).
    // 사람들이 제일 흔히 넣는 값이라 따로 막지 않으면 그대로 문서에 찍힌다.
    assert.equal(isValidBizNo("0000000000"), false);
    assert.equal(isValidBizNo("1111111111"), false);
  });

  it("길이가 다르면 막는다", () => {
    for (const bad of ["", "123", "12345678901", null, undefined]) {
      assert.equal(isValidBizNo(bad), false, String(bad));
    }
  });

  it("저장은 숫자만, 표시만 하이픈", () => {
    // 같은 번호가 두 모양으로 들어오면 대조도 중복 검사도 안 된다.
    assert.equal(normalizeBizNo("120-81-47521"), "1208147521");
    assert.equal(formatBizNo("1208147521"), "120-81-47521");
    assert.equal(formatBizNo("짧음"), "짧음", "10자리가 아니면 원본을 그대로 돌려준다");
  });
});

describe("입력 판정", () => {
  const ok = { bizName: "주식회사 한국방송", bizNo: "120-81-47521" };

  it("상호와 사업자번호만 필수다", () => {
    // 다 필수로 걸면 운영자가 아무것도 못 채우고 포기한다.
    const r = checkProfile(ok);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.profile.bizNo, "1208147521", "숫자만 저장한다");
    assert.equal(r.profile.ceoName, "");
  });

  it("상호가 없으면 막고, 어느 칸인지 알려준다", () => {
    const r = checkProfile({ bizNo: "1208147521" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.field, "bizName");
  });

  it("자릿수는 맞는데 검증에 걸리는 경우를 구분해 말한다", () => {
    const r = checkProfile({ ...ok, bizNo: "1208147522" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.field, "bizNo");
    assert.match(r.message, /검증에 실패/, "'형식이 틀렸다'로 말하면 사용자가 뭘 고쳐야 할지 모른다");
    assert.match(r.message, /120-81-47522/, "무엇을 받았는지 되돌려줘야 대조가 된다");
  });

  it("이메일 오타를 잡는다", () => {
    assert.equal(checkProfile({ ...ok, contactEmail: "a@b" }).ok, false);
    assert.equal(checkProfile({ ...ok, contactEmail: "" }).ok, true, "비우는 건 된다");
  });

  it("긴 값을 잘라 담는다", () => {
    const r = checkProfile({ ...ok, address: "가".repeat(500) });
    assert.equal(r.ok && r.profile.address.length, 300);
  });
});

describe("덜 채워진 항목", () => {
  it("막지 않고 알려만 준다", () => {
    const r = checkProfile({ bizName: "회사", bizNo: "1208147521" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    // 거래명세서는 나갈 수 있다. 다만 세금계산서를 붙일 때는 전부 필수가 된다.
    assert.deepEqual(incompleteFields(r.profile), ["대표자", "주소", "업태", "종목"]);
  });

  it("아예 없으면 전부 알려준다", () => {
    assert.equal(incompleteFields(null).length, 6);
  });
});

describe("배선", () => {
  const route = (m: string, p: string) =>
    new RegExp(`app\\.${m}\\("${p}"[\\s\\S]*?\\n\\}\\);`).exec(INDEX)?.[0] ?? "";

  it("저장이 검증을 거치고 사유를 요구한다", () => {
    const r = route("put", "/api/superadmin/tenants/:id/business");
    assert.notEqual(r, "", "저장 라우트를 찾지 못했다");
    assert.match(r, /checkProfile\(/, "검증 없이 저장하면 잘못된 번호가 문서에 찍힌다");
    assert.match(r, /requireReason\(/, "남의 회사 사업자정보를 사유 없이 바꿀 수 없다");
    assert.match(r, /asSystem\(/, "RLS 표라 rawPool 로는 0행이 나온다");
  });

  it("인보이스가 사업자정보를 싣는다", () => {
    const r = route("get", "/api/superadmin/tenants/:id/invoice");
    assert.match(r, /getBusinessProfile\(/, "공급받는 자 정보가 없으면 거래명세서가 안 된다");
    assert.match(r, /incompleteFields\(/, "덜 채워진 항목을 화면이 알아야 경고할 수 있다");
  });

  it("DB 도 숫자 10자리만 받는다", () => {
    // 애플리케이션을 우회하는 경로가 생겨도 하이픈 섞인 값이 저장되지 않게.
    const mig = fs.readFileSync(path.resolve(SRC, "..", "migrations", "0030_business-profile.cjs"), "utf-8");
    assert.match(mig, /CHECK \(biz_no ~ '\^\[0-9\]\{10\}\$'\)/);
  });
});
