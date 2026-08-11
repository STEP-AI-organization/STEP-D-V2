/**
 * 인보이스 고정.
 *
 * 청구 문서라 **합계가 실제 결제액과 어긋나면 안 된다.** 상대가 그걸로 회계 처리를 하고,
 * 어긋난 건 나중에 사람이 대조해서 찾아야 한다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  VAT_RATE,
  buildInvoice,
  invoiceNumber,
  issuerInfo,
  monthRange,
  parseMonth,
  splitVat,
  type PaymentRow,
} from "./invoice.ts";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const INDEX = fs.readFileSync(path.resolve(SRC, "index.ts"), "utf-8");

const pay = (o: Partial<PaymentRow> = {}): PaymentRow => ({
  paymentId: "p1", credits: 60, amountKrw: 1680, status: "paid",
  createdAt: "2026-08-11T00:00:00Z", settledAt: "2026-08-11T00:01:00Z", ...o,
});

describe("부가세 분해", () => {
  it("공급가액 + 세액이 **정확히** 총액이다", () => {
    // 둘 다 따로 반올림하면 1원이 어긋난다. 세액은 차액으로 잡아야 한다.
    for (const total of [1680, 1, 3, 7, 999, 28, 100_000, 123_457]) {
      const v = splitVat(total);
      assert.equal(v.supplyKrw + v.vatKrw, total, `${total} 에서 합이 어긋났다`);
      assert.equal(v.totalKrw, total);
    }
  });

  it("총액을 부가세 포함으로 본다", () => {
    // 단가가 실제로 카드에서 긁히는 금액이다. "단가가 공급가액"으로 잡으면
    // 인보이스 합계가 실제 결제액보다 커진다 — 그게 제일 나쁘다.
    const v = splitVat(1100);
    assert.equal(v.supplyKrw, 1000);
    assert.equal(v.vatKrw, 100);
    assert.equal(VAT_RATE, 0.1);
  });

  it("0·음수·쓰레기는 0 으로", () => {
    for (const bad of [0, -100, NaN, "abc" as unknown as number]) {
      assert.deepEqual(splitVat(bad), { supplyKrw: 0, vatKrw: 0, totalKrw: 0 });
    }
  });
});

describe("기간", () => {
  it("YYYY-MM 만 받는다", () => {
    assert.deepEqual(parseMonth("2026-08"), { year: 2026, month: 8, key: "2026-08" });
    for (const bad of ["2026-8", "2026/08", "2026-13", "2026-00", "", null, "'; DROP TABLE"]) {
      assert.equal(parseMonth(bad), null, `통과하면 안 되는 값: ${String(bad)}`);
    }
  });

  it("끝이 다음 달 1일이다 (경계 결제를 놓치지 않게)", () => {
    assert.deepEqual(monthRange(2026, 8), { from: "2026-08-01", to: "2026-09-01" });
    assert.deepEqual(monthRange(2026, 12), { from: "2026-12-01", to: "2027-01-01" });
  });

  it("번호는 회사·월이 같으면 항상 같다", () => {
    // 다시 뽑을 때 번호가 바뀌면 상대가 다른 청구서로 오해한다.
    assert.equal(invoiceNumber("1", "2026-08"), invoiceNumber("1", "2026-08"));
    assert.notEqual(invoiceNumber("1", "2026-08"), invoiceNumber("2", "2026-08"));
    assert.notEqual(invoiceNumber("1", "2026-08"), invoiceNumber("1", "2026-09"));
  });
});

describe("인보이스 구성", () => {
  it("결제된 것만 담는다", () => {
    // 실패·대기 건을 얹으면 받지도 않은 돈을 청구하는 게 된다.
    const inv = buildInvoice({
      tenantId: "1", monthKey: "2026-08",
      payments: [pay(), pay({ paymentId: "p2", status: "failed", amountKrw: 9999 }),
                 pay({ paymentId: "p3", status: "pending", amountKrw: 5000 })],
    });
    assert.equal(inv.lines.length, 1);
    assert.equal(inv.totalKrw, 1680);
  });

  it("합계가 줄 금액의 합과 같다", () => {
    const inv = buildInvoice({
      tenantId: "1", monthKey: "2026-08",
      payments: [pay({ paymentId: "a", amountKrw: 1680 }), pay({ paymentId: "b", amountKrw: 2800, credits: 100 })],
    });
    assert.equal(inv.totalKrw, 4480);
    assert.equal(inv.supplyKrw + inv.vatKrw, 4480);
    assert.equal(inv.credits, 160);
  });

  it("날짜순으로 정렬한다", () => {
    const inv = buildInvoice({
      tenantId: "1", monthKey: "2026-08",
      payments: [
        pay({ paymentId: "late", settledAt: "2026-08-20T00:00:00Z" }),
        pay({ paymentId: "early", settledAt: "2026-08-02T00:00:00Z" }),
      ],
    });
    assert.deepEqual(inv.lines.map((l) => l.paymentId), ["early", "late"]);
  });

  it("결제가 없으면 빈 인보이스지만 터지지 않는다", () => {
    const inv = buildInvoice({ tenantId: "1", monthKey: "2026-08", payments: [] });
    assert.equal(inv.lines.length, 0);
    assert.equal(inv.totalKrw, 0);
  });
});

describe("발행자 정보 — 지어내지 않는다", () => {
  it("사업자번호가 없으면 빠진 항목을 알려준다", () => {
    const r = issuerInfo({ INVOICE_ISSUER_NAME: "스텝에이아이" } as NodeJS.ProcessEnv);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.deepEqual(r.missing, ["INVOICE_ISSUER_BIZNO"]);
    // 빈 값을 그대로 준다 — 그럴듯한 숫자를 채우면 그건 위조다.
    assert.equal(r.issuer.bizNo, "");
  });

  it("다 있으면 통과", () => {
    const r = issuerInfo({
      INVOICE_ISSUER_NAME: "스텝에이아이", INVOICE_ISSUER_BIZNO: "000-00-00000",
    } as NodeJS.ProcessEnv);
    assert.equal(r.ok, true);
  });
});

describe("배선", () => {
  const route = (p: string) =>
    new RegExp(`app\\.get\\("${p}"[\\s\\S]*?\\n\\}\\);`).exec(INDEX)?.[0] ?? "";

  it("인보이스 라우트가 결제에서 만든다", () => {
    const r = route("/api/superadmin/tenants/:id/invoice");
    assert.notEqual(r, "", "인보이스 라우트를 찾지 못했다");
    assert.match(r, /FROM credit_topup/, "원장이 아니라 결제에서 만들어야 한다");
    assert.doesNotMatch(r, /FROM credit_ledger/, "원장에는 무상 지급·정정이 섞여 있다");
  });

  it("월 파라미터를 검사한 뒤에 쿼리한다", () => {
    const r = route("/api/superadmin/tenants/:id/invoice");
    const parseAt = r.indexOf("parseMonth(");
    const queryAt = r.indexOf("credit_topup");
    assert.ok(parseAt >= 0 && queryAt > parseAt, "검사 전에 쿼리하면 임의 문자열이 흘러간다");
    assert.match(r, /bad_month/);
  });

  it("세금계산서라고 말하지 않는다", () => {
    // 아닌 걸 그렇게 부르면 상대가 그걸로 회계 처리를 하려다 문제가 생긴다.
    const r = route("/api/superadmin/tenants/:id/invoice");
    assert.match(r, /세금계산서가 아닙니다/);
  });

  it("RLS 표라 시스템 스코프로 읽는다", () => {
    assert.match(route("/api/superadmin/tenants/:id/invoice"), /asSystem\(/);
    assert.match(route("/api/superadmin/tenants/:id/invoice-months"), /asSystem\(/);
  });

  it("결제가 있는 달만 고를 수 있다", () => {
    // 빈 달을 고르게 두면 빈 문서가 나오고, 운영자는 그게 오류인지 실제로 없는 건지 모른다.
    assert.match(route("/api/superadmin/tenants/:id/invoice-months"), /HAVING COUNT\(\*\) FILTER \(WHERE status = 'paid'\) > 0/);
  });
});
