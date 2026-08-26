/**
 * 인보이스 PDF — 브라우저에서 그린다 (구글 AI 스튜디오식 "결제 건마다 PDF 다운로드").
 *
 * 서버가 PDF 를 만들지 않는 이유: 문서 저장소가 따로 생기면 원장(credit_topup)과 문서가
 * 어긋날 수 있는 상태가 생긴다. 여기서는 서버가 준 데이터를 그 자리에서 그리므로
 * 문서 = 원장이다. 한글은 리포의 GmarketSans TTF 를 임베드한다(표준 PDF 폰트에는 한글이 없다).
 *
 * ⚠️ 이 문서는 결제 내역 확인용 인보이스다 — 세금계산서가 아니며, 그렇게 말하지도 않는다.
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

const WON = (n: number) => `₩${n.toLocaleString("ko-KR")}`;

export interface InvoicePdfInput {
  invoice: InvoiceRow;
  supplier: InvoiceParty;
  buyer: InvoiceParty;
}

/** 인보이스 한 건을 PDF 로 그려 즉시 다운로드한다. 파일명 = 인보이스 번호. */
export async function downloadInvoicePdf({ invoice, supplier, buyer }: InvoicePdfInput): Promise<void> {
  const [{ jsPDF }, fonts] = await Promise.all([import("jspdf"), loadFonts()]);

  const doc = new jsPDF({ unit: "mm", format: "a4" });
  for (const f of fonts) {
    doc.addFileToVFS(f.file, f.b64);
    doc.addFont(f.file, FONT, f.style);
  }

  const M = 18; // 좌우 여백(mm)
  const W = 210 - M * 2;
  const right = M + W;
  let y = 24;

  const text = (s: string, x: number, yy: number, opts?: { size?: number; bold?: boolean; color?: number; align?: "left" | "right" }) => {
    doc.setFont(FONT, opts?.bold ? "bold" : "normal");
    doc.setFontSize(opts?.size ?? 9.5);
    const c = opts?.color ?? 30;
    doc.setTextColor(c, c, c);
    doc.text(s, x, yy, { align: opts?.align ?? "left" });
  };

  // ── 헤더 ──────────────────────────────────────────────────────────────────
  text("인보이스", M, y, { size: 20, bold: true });
  text("Invoice", M + 32, y, { size: 11, color: 130 });
  text(invoice.number, right, y - 4, { size: 10.5, bold: true, align: "right" });
  text(`결제일 ${String(invoice.paidAt).slice(0, 10)}`, right, y + 1, { size: 9, color: 110, align: "right" });
  y += 6;
  doc.setDrawColor(60);
  doc.setLineWidth(0.6);
  doc.line(M, y, right, y);
  y += 10;

  // ── 공급자 / 구매자 ────────────────────────────────────────────────────────
  const party = (label: string, p: InvoiceParty, x: number) => {
    let yy = y;
    text(label, x, yy, { size: 8, color: 130, bold: true });
    yy += 5;
    text(p.name || "—", x, yy, { size: 11, bold: true });
    yy += 5.5;
    // 비어 있는 항목은 그리지 않는다 — 자리 채우려고 지어내지 않는다.
    const rows = [
      p.bizNo && `사업자등록번호 ${p.bizNo}`,
      p.ceoName && `대표 ${p.ceoName}`,
      p.address,
      p.email,
    ].filter(Boolean) as string[];
    for (const r of rows) {
      text(r, x, yy, { size: 8.5, color: 90 });
      yy += 4.5;
    }
    return yy;
  };
  const yl = party("공급자 (FROM)", supplier, M);
  const yr = party("구매자 (TO)", buyer, M + W / 2 + 6);
  y = Math.max(yl, yr) + 8;

  // ── 항목 표 ────────────────────────────────────────────────────────────────
  const col = { item: M + 2, qty: right - 64, amount: right - 2 };
  doc.setFillColor(243, 243, 241);
  doc.rect(M, y - 4.5, W, 7, "F");
  text("항목", col.item, y, { size: 8.5, bold: true, color: 90 });
  text("수량", col.qty, y, { size: 8.5, bold: true, color: 90, align: "right" });
  text("금액", col.amount, y, { size: 8.5, bold: true, color: 90, align: "right" });
  y += 8;
  text(invoice.description, col.item, y, { size: 10 });
  text("1", col.qty, y, { size: 10, align: "right" });
  text(WON(invoice.amountKrw), col.amount, y, { size: 10, align: "right" });
  y += 4;
  doc.setDrawColor(210);
  doc.setLineWidth(0.25);
  doc.line(M, y, right, y);
  y += 8;

  // ── 합계 — 총액은 부가세 포함이고, 공급가액·세액은 서버가 역산한 값 그대로. ──
  const sums: [string, string, boolean][] = [
    ["공급가액", WON(invoice.supplyKrw), false],
    ["부가세 (10%)", WON(invoice.vatKrw), false],
    ["합계 (부가세 포함)", WON(invoice.amountKrw), true],
  ];
  for (const [label, val, bold] of sums) {
    text(label, right - 60, y, { size: bold ? 10.5 : 9, bold, color: bold ? 20 : 100 });
    text(val, col.amount, y, { size: bold ? 11.5 : 9.5, bold, align: "right", color: bold ? 20 : 80 });
    y += bold ? 7 : 5.5;
  }
  y += 4;

  // ── 결제 정보 ─────────────────────────────────────────────────────────────
  const meta: string[] = [
    `결제 상태: 결제 완료 (${invoice.origin === "auto" ? "자동 충전" : "카드 결제"})`,
    `결제 ID: ${invoice.id}`,
    `결제 일시: ${String(invoice.paidAt).replace("T", " ").slice(0, 19)}`,
  ];
  for (const m of meta) {
    text(m, M, y, { size: 8.5, color: 90 });
    y += 4.8;
  }

  // ── 푸터 ──────────────────────────────────────────────────────────────────
  const fy = 278;
  doc.setDrawColor(210);
  doc.line(M, fy - 6, right, fy - 6);
  text("본 문서는 STEP AI 결제 내역 확인용 인보이스이며 세금계산서가 아닙니다.", M, fy, { size: 7.5, color: 130 });
  if (supplier.email) {
    text(`세금계산서 등 증빙 문의: ${supplier.email}`, M, fy + 4, { size: 7.5, color: 130 });
  }

  doc.save(`${invoice.number}.pdf`);
}
