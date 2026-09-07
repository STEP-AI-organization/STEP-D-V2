/**
 * 인보이스 PDF — 브라우저에서 그린다.
 *
 * 서버가 PDF 를 만들지 않는 이유: 문서 저장소가 따로 생기면 원장(credit_topup)과 문서가
 * 어긋날 수 있는 상태가 생긴다. 여기서는 서버가 준 데이터를 그 자리에서 그리므로
 * 문서 = 원장이다. 한글은 리포의 GmarketSans TTF 를 임베드한다(표준 PDF 폰트에는 한글이 없다).
 *
 * ## 메일과 **같은 문서**여야 한다 (2026-09-07)
 *
 * 예전엔 둘이 딴 문서였다. 메일은 "결제 영수증"(영수증 번호·크레딧 수량·충전 후 잔액·
 * 적격증빙 안내)인데, PDF 는 "인보이스 / Invoice"(공급자·구매자 2단 · 항목/수량/금액 표 ·
 * "합계")였다. 같은 결제를 두 가지 문서로 받으면 **어느 쪽이 진짜인지 묻게 된다** —
 * 회계 담당자에게는 그게 곧 문의 한 통이다.
 *
 * 그래서 이 파일은 `apps/server/src/billing/invoice-email.ts` 의 `mailHtml` 을 **그대로
 * 종이에 옮긴 것**이다. 블록 순서·문구·숫자 구성이 같다. 고칠 때는 둘을 같이 고칠 것 —
 * `invoice-format-parity.test.ts` 가 문구가 갈리면 빨개진다.
 *
 * ⚠️ **모르는 값은 빈칸으로 두지 않고 그 줄을 통째로 뺀다** — 메일 템플릿의 규칙을 그대로
 *    가져왔다. "잔액  크레딧" 같은 반쪽 문장이 나가면 문서 자체를 못 믿게 된다.
 *    카드 뒤 4자리는 여기 없다: 우리가 아는 건 **지금** 등록된 카드뿐이라, 몇 달 전
 *    영수증에 그걸 적으면 그 결제에 없는 사실을 적는 셈이다.
 */
import type { InvoiceParty, InvoiceRow } from "@/lib/data/api";

const FONT = "GmarketSans";
const FONT_FILES: { url: string; style: "normal" | "bold" }[] = [
  { url: "/fonts/GmarketSansTTFMedium.ttf", style: "normal" },
  { url: "/fonts/GmarketSansTTFBold.ttf", style: "bold" },
];

/** 폰트 파일은 한 번만 받는다 (탭 수명 동안 캐시). */
let fontCache: Promise<{ file: string; style: "normal" | "bold"; b64: string }[]> | null = null;

function loadFonts() {
  fontCache ??= Promise.all(
    FONT_FILES.map(async ({ url, style }) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`폰트를 불러오지 못했습니다 (${url}: ${res.status})`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      // 큰 파일에서 spread 는 스택을 넘친다 — 32KB 청크로 나눠 인코딩.
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return { file: url.split("/").pop() ?? `${style}.ttf`, style, b64: btoa(bin) };
    }),
  );
  return fontCache;
}

/** 숫자 표기 — 메일과 같다(₩ 기호 + 천 단위 구분). */
const KRW = (n: number) => n.toLocaleString("ko-KR");
const WON = (n: number) => `₩${KRW(n)}`;

/** `2026-08-26T…` → `2026년 8월 26일`. 메일의 `paidDateKo` 와 같은 규칙. */
function paidDateKo(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (!m) return String(iso ?? "").slice(0, 10);
  return `${m[1]}년 ${Number(m[2])}월 ${Number(m[3])}일`;
}

export interface InvoicePdfInput {
  invoice: InvoiceRow;
  supplier: InvoiceParty;
  buyer: InvoiceParty;
}

/** 결제 영수증 한 건을 PDF 로 그려 즉시 다운로드한다. 파일명 = 영수증 번호. */
export async function downloadInvoicePdf({ invoice, supplier, buyer }: InvoicePdfInput): Promise<void> {
  const [{ jsPDF }, fonts] = await Promise.all([import("jspdf"), loadFonts()]);

  const doc = new jsPDF({ unit: "mm", format: "a4" });
  for (const f of fonts) {
    doc.addFileToVFS(f.file, f.b64);
    doc.addFont(f.file, FONT, f.style);
  }

  const M = 18;                 // 좌우 여백(mm)
  const W = 210 - M * 2;
  const right = M + W;
  let y = 22;

  // 메일과 같은 색. 종이라 배경(#F0EEEB)은 안 깔고 카드 경계로만 나눈다.
  const INK = 31, MUTED = 92, LINE = 222;

  const text = (
    s: string, x: number, yy: number,
    opts?: { size?: number; bold?: boolean; color?: number; align?: "left" | "right" },
  ) => {
    doc.setFont(FONT, opts?.bold ? "bold" : "normal");
    doc.setFontSize(opts?.size ?? 9.5);
    const c = opts?.color ?? INK;
    doc.setTextColor(c, c, c);
    doc.text(s, x, yy, { align: opts?.align ?? "left" });
  };
  const rule = (yy: number) => {
    doc.setDrawColor(LINE);
    doc.setLineWidth(0.25);
    doc.line(M, yy, right, yy);
  };
  /** 라벨/값 한 줄. 메일의 idRow·amtRow 를 합친 것. */
  const row = (label: string, value: string, yy: number, strong = false) => {
    text(label, M, yy, { size: strong ? 10.5 : 9.5, bold: strong, color: strong ? INK : MUTED });
    text(value, right, yy, { size: strong ? 11.5 : 9.5, bold: strong, color: INK, align: "right" });
  };

  const issuer = supplier.name || "(주)스텝에이아이";

  // ── 머리 — "STEP AI · 발행자" (메일 상단과 같다) ──────────────────────────────
  text("STEP AI", M, y, { size: 10, bold: true });
  text(issuer, M + 24, y, { size: 9, color: MUTED });
  y += 10;

  // ── 금액 카드 ─────────────────────────────────────────────────────────────
  text(`${issuer} 결제 영수증`, M, y, { size: 9.5, color: MUTED });
  y += 11;
  text(WON(invoice.amountKrw), M, y, { size: 26, bold: true });
  y += 7;
  text(`${paidDateKo(invoice.paidAt)} 결제 완료`, M, y, { size: 9.5, color: MUTED });
  y += 7;
  rule(y);
  y += 7;

  // 메일과 같은 순서: 인보이스 번호 → 영수증 번호 → 결제 방식.
  row("인보이스 번호", invoice.number, y); y += 6;
  row("영수증 번호", invoice.receiptNumber, y); y += 6;
  row("결제 방식", invoice.origin === "auto" ? "자동 결제" : "카드 결제", y); y += 12;

  // ── 영수증 상세 ────────────────────────────────────────────────────────────
  text(`영수증 ${invoice.receiptNumber}`, M, y, { size: 12, bold: true });
  y += 9;
  // 품목 한 줄 — 메일과 같은 형태("크레딧 N개"와 공급가액).
  text(`크레딧 ${KRW(invoice.credits)}개`, M, y, { size: 11, bold: true });
  text(WON(invoice.supplyKrw), right, y, { size: 11, align: "right" });
  y += 6;
  rule(y);
  y += 7;

  row("공급가액", WON(invoice.supplyKrw), y); y += 6;
  row("부가세 (10%)", WON(invoice.vatKrw), y); y += 7;
  row("결제 금액", WON(invoice.amountKrw), y, true); y += 12;

  // ── 크레딧 잔액 — 모르면 블록째로 없다(메일과 같은 규칙) ──────────────────────
  if (invoice.balanceAfter != null && Number.isFinite(Number(invoice.balanceAfter))) {
    rule(y - 4);
    text("크레딧 잔액", M, y + 2, { size: 9.5, color: MUTED });
    y += 9;
    row("충전 후 잔액", `${KRW(Number(invoice.balanceAfter))} 크레딧`, y, true);
    y += 7;
    text("잔여 크레딧이 모두 소진되면 자동으로 충전됩니다.", M, y, { size: 8.5, color: MUTED });
    y += 10;
  }

  // ── 공급자 / 구매자 ────────────────────────────────────────────────────────
  //
  // 메일은 공급자만 싣는다(받는 사람이 곧 구매자라 자기 정보를 되읽을 이유가 없다).
  // 종이는 다르다 — 파일로 돌아다니고 회계에 첨부되므로 **누가 누구에게** 가 남아야 한다.
  // 그래서 이 한 블록만 메일보다 많다. 규칙은 같다: 비면 그 줄을 뺀다.
  rule(y - 4);
  y += 4;
  const party = (label: string, p: InvoiceParty, x: number) => {
    let yy = y;
    text(label, x, yy, { size: 8, bold: true, color: MUTED });
    yy += 5;
    if (p.name) { text(p.name, x, yy, { size: 10, bold: true }); yy += 5; }
    const lines = [
      p.bizNo && `사업자등록번호 ${p.bizNo}`,
      p.ceoName && `대표 ${p.ceoName}`,
      p.address,
      p.email,
    ].filter(Boolean) as string[];
    for (const r of lines) { text(r, x, yy, { size: 8.5, color: MUTED }); yy += 4.4; }
    return yy;
  };
  y = Math.max(party("공급자", supplier, M), party("구매자", buyer, M + W / 2 + 6));

  // ── 푸터 — 문구는 메일과 **한 글자도 다르지 않아야 한다** ────────────────────
  const fy = 276;
  doc.setDrawColor(LINE);
  doc.setLineWidth(0.25);
  doc.line(M, fy - 8, right, fy - 8);
  if (supplier.email) {
    text(`문의처 ${supplier.email}`, M, fy - 3, { size: 8.5, color: MUTED });
  }
  text("본 문서는 결제 내역 확인용입니다. 신용카드 결제분은 카드 매출전표가 적격증빙이며 부가세 매입세액 공제가 가능합니다.",
       M, fy + 2, { size: 7.5, color: 130 });
  text("카드 결제 건에는 세금계산서가 중복 발행되지 않습니다.", M, fy + 6, { size: 7.5, color: 130 });

  // 파일명도 영수증 기준으로 — 메일 제목이 영수증 번호를 쓰므로 대조가 쉬워야 한다.
  doc.save(`${invoice.receiptNumber}.pdf`);
}
