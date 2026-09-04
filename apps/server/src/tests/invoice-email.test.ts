/**
 * 결제 건별 인보이스 + 메일 배선 고정.
 *
 * (월별 거래명세서 쪽 고정은 invoice.test.ts — 여기는 2026-08-18 추가된 건별 축이다.)
 *
 * 배선 스캔인 이유: "적립 4지점(웹훅·카드·자동충전·미정산 정산) 전부가 발송을 부른다"는
 * 순수 함수로 증명이 안 되는 불변식이다. 새 적립 경로를 만들면서 발송을 빼먹으면
 * 사용자는 어떤 결제는 메일을 받고 어떤 결제는 못 받는다 — 그게 제일 찾기 어려운 형태다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { invoiceFromTopup, smtpConfigured, supplierFromEnv } from "../billing/invoice.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string) => fs.readFileSync(path.join(SRC, f), "utf-8");

describe("결제 건별 인보이스 — 결정적이고 원장과 일치한다", () => {
  const row = {
    paymentId: "topup-t1-abc123def456",
    credits: 600,
    amountKrw: 66000,
    requestedBy: "hkj@stepai.kr",
    createdAt: "2026-08-18T10:00:00",
    settledAt: "2026-08-18T10:00:05",
  };

  it("번호는 랜덤해 보이되 결제마다 고정이다 (2026-08-27)", () => {
    // 저장하지 않고 네 자리(메일 제목·PDF 파일명·목록·문서 상단)가 각자 다시 만든다 —
    // 호출마다 달라지면 같은 결제인데 메일과 PDF 의 번호가 달라 다른 청구서로 오해한다.
    const n = invoiceFromTopup(row).number;
    assert.equal(invoiceFromTopup(row).number, n, "같은 결제인데 번호가 바뀐다");
    assert.match(n, /^[0-9A-HJKMNP-TV-Z]{12}$/, "혼동 글자(I·L·O·U) 없는 12자 토큰이어야 한다");
    // 내부 식별자·날짜를 드러내지 않는다(옛 형식 SD-YYYYMMDD-<결제ID 꼬리>의 재발 금지).
    assert.doesNotMatch(n, /^SD-/);
    assert.ok(!n.includes(row.paymentId.slice(-6).toUpperCase()), "결제 ID 꼬리가 그대로 노출된다");
    assert.ok(!n.includes("20260818"), "결제일이 번호에 드러난다");
    // 다른 결제는 다른 번호.
    assert.notEqual(invoiceFromTopup({ ...row, paymentId: "cr_1_other" }).number, n);
  });

  it("공급가액+부가세 = 총액 — splitVat 역산이라 1원도 새지 않는다", () => {
    for (const amount of [66000, 1100, 33333, 99999, 10]) {
      const inv = invoiceFromTopup({ ...row, amountKrw: amount });
      assert.equal(inv.supplyKrw + inv.vatKrw, amount);
      assert.equal(inv.amountKrw, amount);
    }
  });

  it("auto 접두 actor 는 자동 충전으로 분류된다", () => {
    assert.equal(invoiceFromTopup({ ...row, requestedBy: "auto-topup" }).origin, "auto");
    assert.equal(invoiceFromTopup(row).origin, "manual");
  });

  it("settledAt 이 없으면 createdAt 으로 폴백한다", () => {
    assert.equal(invoiceFromTopup({ ...row, settledAt: null }).paidAt, row.createdAt);
  });
});

/**
 * 수신자 규칙 — **결제 알림에 등록된 사람들만** (2026-09-04 사용자 지정).
 *
 * 예전엔 결제창 이메일(포트원 customer.email)과 구매자 이메일을 1순위로 얹어서,
 * **카드를 등록한 계정 주인에게도 영수증이 갔다.** 그러면 담당자 목록을 따로 두는 뜻이
 * 없어진다. 순수 함수로 증명할 수 없는 규칙이라(발송 경로 전체가 I/O) 원문을 스캔한다.
 */
describe("수신자 — 등록된 담당자뿐", () => {
  const SRC = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "billing", "invoice-email.ts"),
    "utf-8",
  );
  const FN = "export async function sendInvoiceEmail";
  const sendBlock = SRC.slice(SRC.indexOf(FN), SRC.indexOf(FN) + 2600);

  it("발송 경로를 읽을 수 있다 — 못 읽으면 아래 검사가 무의미하다", () => {
    assert.ok(sendBlock.length > 200, "sendInvoiceEmail 본문을 못 찾았다 — 정규식이 깨졌다");
  });

  it("수신자는 결제 알림 목록에서만 나온다", () => {
    assert.match(sendBlock, /getBillingNotifyEmails\(\)/,
      "등록된 담당자 목록을 안 읽는다");
    assert.doesNotMatch(sendBlock, /paymentEmail/,
      "결제창 이메일이 수신자로 되살아났다 — 카드 등록한 계정에도 영수증이 간다");
    assert.doesNotMatch(sendBlock, /buyerEmail|buyerFor\(/,
      "구매자 이메일이 수신자로 되살아났다");
  });

  it("목록이 비면 다른 주소로 폴백하지 않고 안 보낸다", () => {
    assert.match(sendBlock, /recipients\.length === 0[\s\S]{0,300}?return;/,
      "빈 목록에서 조용히 다른 주소로 나갈 수 있다");
  });
});

describe("환경 게이트", () => {
  it("SMTP 3종이 다 있어야 발송 경로가 열린다", () => {
    assert.equal(smtpConfigured({} as NodeJS.ProcessEnv), false);
    assert.equal(smtpConfigured({ SMTP_HOST: "h", SMTP_USER: "u" } as NodeJS.ProcessEnv), false);
    assert.equal(
      smtpConfigured({ SMTP_HOST: "h", SMTP_USER: "u", SMTP_PASS: "p" } as NodeJS.ProcessEnv),
      true,
    );
  });

  it("공급자 표기는 issuerInfo 와 같은 INVOICE_ISSUER_* 를 읽고, 비면 비워 둔다", () => {
    const s = supplierFromEnv({} as NodeJS.ProcessEnv);
    assert.equal(s.bizNo, "");
    assert.equal(s.address, "");
    assert.equal(
      supplierFromEnv({ INVOICE_ISSUER_BIZNO: "000-00-00000" } as NodeJS.ProcessEnv).bizNo,
      "000-00-00000",
    );
  });
});

describe("적립 지점마다 인보이스 메일이 배선돼 있다 (소스 스캔)", () => {
  it("index.ts — 웹훅·저장카드 충전이 발송을 부른다", () => {
    const src = read("index.ts");
    const hooks = [...src.matchAll(/reason: "topup"[\s\S]{0,800}?sendInvoiceEmail\(/g)];
    assert.ok(
      hooks.length >= 2,
      `index.ts 의 topup 적립 뒤 sendInvoiceEmail 호출이 ${hooks.length}곳뿐이다 — 웹훅·카드 두 경로 다 있어야 한다`,
    );
  });

  it("auto-topup.ts — 자동 충전·미정산 정산이 발송을 부른다", () => {
    const calls = [...read("billing/auto-topup.ts").matchAll(/sendInvoiceEmail\(/g)];
    assert.ok(
      calls.length >= 2,
      `auto-topup.ts 의 sendInvoiceEmail 호출이 ${calls.length}곳뿐이다 — 신규 결제·미정산 정산 두 경로 다 있어야 한다`,
    );
  });

  it("발송은 전부 fire-and-forget 이다 — await 로 적립 경로를 막지 않는다", () => {
    for (const f of ["index.ts", "billing/auto-topup.ts"]) {
      assert.doesNotMatch(
        read(f),
        /await sendInvoiceEmail\(/,
        `${f} 가 sendInvoiceEmail 을 await 한다 — 메일 실패·지연이 결제 응답을 막으면 안 된다`,
      );
    }
  });
});
