/**
 * 결제 영수증 PDF **미리보기** — 브라우저 없이 한 번에 그려 본다.
 *
 * ## 왜 있나
 *
 * `invoice-format-parity.test.ts` 는 메일과 PDF 의 **문구**를 고정하지만 **모양은 못 본다.**
 * 실제로 문구는 전부 일치하는데 PDF 만 "선 몇 개 있는 평면" 이었던 적이 있다
 * (2026-09-14 · 사용자: "디자인이 달라"). 그때 이 스크립트가 없어서 매번 손으로 브라우저를
 * 열어 눌러 봐야 했다 — 그러면 아무도 안 본다.
 *
 * ```bash
 * pnpm --filter @stepd/web preview:receipt          # ./receipt-preview.pdf
 * pnpm --filter @stepd/web preview:receipt out.pdf
 * ```
 *
 * 비교 대상(정본): `docs/ops/billing-emails.md` 가 가리키는 디자이너 원본 HTML 과
 * 서버의 `invoice-email.ts` 렌더 결과. 셋이 같은 문서로 보여야 한다.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

// 브라우저 전역 흉내 — 이 모듈은 원래 브라우저에서 도는 코드다.
// 폰트는 실제와 같은 파일(public/fonts)에서 읽는다: 폰트가 다르면 줄바꿈·폭이 달라진다.
globalThis.fetch = async (url) => {
  const p = path.join(ROOT, "public", String(url));
  const buf = fs.readFileSync(p);
  return {
    ok: true,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
};
globalThis.btoa = (s) => Buffer.from(s, "binary").toString("base64");

const { jsPDF } = await import("jspdf");
// `doc.save()` 는 브라우저 다운로드다 — 파일로 받도록 바꿔 끼운다.
const saved = [];
jsPDF.API.save = function (name) { saved.push({ name, blob: this.output("arraybuffer") }); return this; };

const { downloadInvoicePdf } = await import("../src/lib/billing/invoice-pdf.ts");

/** 디자이너 원본(인보이스_미리보기_20260903.html)과 같은 표본 — 나란히 놓고 보라고. */
await downloadInvoicePdf({
  invoice: {
    id: "pay_sample", number: "8F3K2QD7XA91", receiptNumber: "RC-20260903-A1B2C3",
    paidAt: "2026-09-03T05:20:00.000Z", credits: 5000,
    amountKrw: 330000, supplyKrw: 300000, vatKrw: 30000,
    origin: "auto", description: "크레딧 5,000개", balanceAfter: 5850,
  },
  supplier: {
    name: "주식회사 스텝에이아이", bizNo: "441-86-03653", ceoName: "이원미, 박현우",
    address: "서울특별시 강남구 역삼로19길 7, 2층(역삼동)", email: "contact@stepai.kr",
  },
  buyer: { name: "", bizNo: "", ceoName: "", address: "", email: "" },
});

const out = process.argv[2] ?? "receipt-preview.pdf";
fs.writeFileSync(out, Buffer.from(saved[0].blob));
console.log(`그렸다 → ${out} (${(fs.statSync(out).size / 1024).toFixed(0)}KB)`);
console.log("디자이너 원본과 나란히 놓고 볼 것 — 문구는 테스트가 보지만 모양은 사람이 본다.");
