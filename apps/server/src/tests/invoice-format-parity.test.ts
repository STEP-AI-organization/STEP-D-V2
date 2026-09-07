/**
 * 결제 영수증 — **메일과 PDF 가 같은 문서인가.**
 *
 * 2026-09-07 사용자: "크레딧에서 인보이스 다운받는거하고, 메일로 자동으로 날라온거하고
 * 형식이 다름. 메일로 날라오는거에 맞추삼."
 *
 * 실제로 딴 문서였다. 메일은 **결제 영수증**(영수증 번호·크레딧 수량·충전 후 잔액·
 * 적격증빙 안내)인데 PDF 는 **인보이스/Invoice**(공급자·구매자 2단 · 항목/수량/금액 표 ·
 * "합계 (부가세 포함)" · "세금계산서가 아닙니다")였다. 같은 결제를 두 문서로 받으면
 * 회계 담당자는 **어느 쪽이 진짜인지 묻는다** — 그게 곧 문의 한 통이다.
 *
 * 둘은 다른 언어로 다른 패키지에 있다(서버 HTML · 웹 jsPDF). 코드를 공유할 수 없으니
 * **문구를 여기서 붙잡는다.** 한쪽만 고치면 빨개진다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const SRC = path.join(import.meta.dirname, "..");
const REPO = path.resolve(SRC, "..", "..", "..");
const read = (p: string) => fs.readFileSync(p, "utf-8").replace(/\r\n/g, "\n");

/**
 * 주석을 뺀 실행 줄만 본다.
 *
 * 이 두 파일은 **왜 이렇게 바뀌었는지**를 주석에 길게 적어 두었고, 거기엔 옛 문구가
 * 그대로 인용돼 있다("합계 (부가세 포함)" 였다 …). 주석까지 훑으면 이력을 적었다는
 * 이유로 테스트가 빨개진다 — 그러면 사람이 주석을 지우게 되고, 그건 정반대 결과다.
 * (`ffmpeg-binary-injectable.test.ts` 가 같은 이유로 같은 방식을 쓴다.)
 */
function code(body: string): string {
  return body
    .split("\n")
    .filter((ln) => {
      const t = ln.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

const MAIL = code(read(path.join(SRC, "billing", "invoice-email.ts")));
const PDF = code(read(path.join(REPO, "apps", "web", "src", "lib", "billing", "invoice-pdf.ts")));

/**
 * 두 문서에 **똑같이** 나와야 하는 문구.
 *
 * 이 목록을 줄일 때는 "왜 PDF 에만/메일에만 있어도 되나" 를 여기 적을 것. 근거 없이
 * 빼면 다시 두 문서가 된다.
 */
const SHARED = [
  "결제 영수증",
  "인보이스 번호",
  "영수증 번호",
  "결제 방식",
  "자동 결제",
  "카드 결제",
  "공급가액",
  "부가세 (10%)",
  "결제 금액",
  "크레딧 잔액",
  "충전 후 잔액",
  "잔여 크레딧이 모두 소진되면 자동으로 충전됩니다.",
  "문의처",
  "사업자등록번호",
  // 법적 문구는 **한 글자도 달라선 안 된다** — 다르면 어느 쪽이 유효한지 묻게 된다.
  "본 문서는 결제 내역 확인용입니다. 신용카드 결제분은 카드 매출전표가 적격증빙이며 부가세 매입세액 공제가 가능합니다.",
  "카드 결제 건에는 세금계산서가 중복 발행되지 않습니다.",
];

/** PDF 에 **더는 있으면 안 되는** 옛 문구 — 이게 남아 있으면 갈라진 그 문서다. */
const RETIRED = [
  "합계 (부가세 포함)",
  "세금계산서가 아닙니다",
  "공급자 (FROM)",
  "구매자 (TO)",
  // ⚠️ 따옴표까지 포함해서 본다. 맨 단어로 찾으면 `InvoiceRow`·`downloadInvoicePdf` 같은
  //    **식별자**에 걸린다 — 그건 문서에 안 나가는 이름이라 지울 이유가 없다.
  '"Invoice"',
];

describe("메일 · PDF 문구 일치", () => {
  for (const phrase of SHARED) {
    it(`둘 다 "${phrase.slice(0, 28)}${phrase.length > 28 ? "…" : ""}" 를 쓴다`, () => {
      assert.ok(MAIL.includes(phrase), `메일에 없다: ${phrase}`);
      assert.ok(PDF.includes(phrase), `PDF 에 없다: ${phrase}`);
    });
  }

  it("PDF 에 옛 인보이스 문구가 남아 있지 않다", () => {
    const left = RETIRED.filter((p) => PDF.includes(p));
    assert.deepEqual(left, [],
      `PDF 가 아직 옛 "인보이스" 문서다: ${left.join(", ")}\n` +
      "→ 메일은 '결제 영수증' 인데 PDF 만 다른 문서면 어느 쪽이 진짜인지 묻게 된다.");
  });
});

describe("같은 숫자를 같은 방식으로 쓴다", () => {
  it("날짜를 `YYYY년 M월 D일` 로 쓴다 — 한쪽만 ISO 면 같은 결제가 달라 보인다", () => {
    for (const [name, src] of [["메일", MAIL], ["PDF", PDF]] as const) {
      assert.match(src, /function paidDateKo\(/, `${name} 에 paidDateKo 가 없다`);
      assert.ok(src.includes("년 ") && src.includes("월 ") && src.includes("일"),
        `${name} 의 날짜 표기가 한국어 형식이 아니다`);
    }
  });

  it("천 단위 구분을 ko-KR 로 한다", () => {
    for (const [name, src] of [["메일", MAIL], ["PDF", PDF]] as const) {
      assert.ok(src.includes('toLocaleString("ko-KR")'), `${name} 이 ko-KR 서식을 안 쓴다`);
    }
  });

  it("**품목은 '크레딧 N개'** — PDF 가 수량 표를 다시 만들지 않는다", () => {
    assert.match(MAIL, /크레딧 \$\{KRW\(invoice\.credits\)\}개/);
    assert.match(PDF, /크레딧 \$\{KRW\(invoice\.credits\)\}개/);
  });
});

describe("모르는 값은 줄을 뺀다 — 반쪽 문장을 안 만든다", () => {
  it("잔액을 모르면 블록째로 없다 (양쪽 다)", () => {
    // 메일: balance == null 이면 balanceBlock 이 빈 문자열.
    assert.match(MAIL, /balance == null \? "" :/);
    // PDF: null 이면 그 블록을 아예 안 그린다.
    assert.match(PDF, /invoice\.balanceAfter != null/);
  });

  /**
   * 카드 뒤 4자리는 **PDF 에 없다.** 우리가 아는 건 지금 등록된 카드뿐이라, 몇 달 전
   * 영수증에 그걸 적으면 그 결제에 없는 사실을 적는 셈이다. 메일은 적립 직후에 나가서
   * 그 시점 카드가 맞다. 문서가 갈린 게 아니라 **같은 규칙(모르면 뺀다)의 결과**다.
   */
  it("PDF 는 카드 번호를 지어내지 않는다", () => {
    assert.ok(!PDF.includes("cardLast4") && !PDF.includes("****"),
      "PDF 가 카드 정보를 싣는다 — 과거 결제의 카드를 우리는 모른다");
  });
});

describe("잔액은 그때 값이어야 한다", () => {
  /**
   * 이게 이 파일에서 제일 중요한 테스트다. "충전 후 잔액" 에 **지금 잔액**을 적으면
   * 숫자는 그럴듯하고 아무도 못 알아채지만, 그 영수증에 없는 사실이다.
   */
  it("PDF 용 잔액은 원장을 되짚어 구한다 — 지금 잔액이 아니다", () => {
    const db = read(path.join(SRC, "db-pg.ts"));
    const fn = db.slice(db.indexOf("export async function topupBalancesAfter("));
    assert.ok(fn.length > 0, "topupBalancesAfter 가 없다 — PDF 가 잔액을 말할 근거가 사라졌다");
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    assert.match(body, /l\.id <= a\.ledger_id/,
      "누계 기준이 그 충전 시점이 아니다 — 지금 잔액을 적으면 과거 영수증이 거짓이 된다");
    assert.match(body, /reason = 'topup'/, "충전 행이 아닌 것을 기준으로 삼는다");
  });
});
