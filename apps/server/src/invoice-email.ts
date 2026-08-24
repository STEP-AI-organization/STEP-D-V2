/**
 * 인보이스 PDF·이메일 — 결제 완료 시 "영수증 받을 이메일"로 자동 발송하는 배선.
 *
 * 순수 계산(번호·역산·수신자 우선순위)은 invoice.ts, 여기는 부수효과만: 폰트 읽기,
 * PDF 렌더, DB 조회(구매자), 포트원 조회(결제창 이메일), SMTP 발송.
 *
 * **베스트 에포트다.** 발송 실패가 크레딧 적립을 되돌리거나 막으면 안 된다 — 호출부는
 * 전부 fire-and-forget(`void sendInvoiceEmail(...)`)으로 부르고, 여기는 절대 던지지 않는다.
 * 발송 트리거는 "원장에 실제로 적립된 순간"(addCreditEntry 가 true 를 돌려준 곳)뿐이라
 * 중복 웹훅·재시도에도 한 결제당 한 통만 나간다. invoice.test.ts 의 배선 스캔이 강제한다.
 *
 * SMTP env 가 없으면 조용히 건너뛴다(로그만). 인증은 둘 중 하나:
 *   평문   SMTP_HOST · SMTP_PORT(기본 587) · SMTP_USER · SMTP_PASS
 *   OAuth  SMTP_USER + SMTP_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN (Gmail XOAUTH2 ·
 *          호스트·포트 생략 시 smtp.gmail.com:465)
 * 보낸이는 INVOICE_MAIL_FROM(기본 SMTP_USER).
 *
 * PDF 는 jsPDF + GmarketSans TTF(assets/invoice-fonts). 표준 PDF 폰트에는 한글이 없고,
 * 서버 이미지의 Pretendard 는 OTF(CFF)라 jsPDF 가 임베드하지 못한다.
 * ⚠️ 웹의 클라이언트 PDF(apps/web/src/lib/billing/invoice-pdf.ts)와 레이아웃을 맞춘 미러다 —
 * 한쪽을 고치면 다른 쪽도 볼 것.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { asSystem, getBusinessProfile, getTopup } from "./db-pg.ts";
import {
  invoiceFromTopup,
  resolveRecipient,
  smtpConfigured,
  supplierFromEnv,
  type InvoiceParty,
  type PaymentInvoice,
} from "./invoice.ts";
import { sendMail } from "./mailer.ts";
import { getPayment } from "./portone.ts";

/** 구매자 — 사업자정보(business_profile)가 정본, 없으면 워크스페이스 이름만. */
export async function buyerFor(tenantId: string): Promise<InvoiceParty> {
  const [tenant, biz] = await Promise.all([
    asSystem(async (db) => {
      const { rows } = await db.query(
        `SELECT name, billing_email AS "billingEmail" FROM tenants WHERE id = $1`, [tenantId],
      );
      return (rows[0] ?? null) as { name: string; billingEmail: string | null } | null;
    }),
    asSystem((db) => getBusinessProfile(db, tenantId)),
  ]);
  return {
    name: biz?.bizName || tenant?.name || "",
    bizNo: biz?.bizNo ?? "",
    ceoName: biz?.ceoName ?? "",
    address: biz?.address ?? "",
    email: biz?.contactEmail || tenant?.billingEmail || "",
  };
}

// ── PDF ───────────────────────────────────────────────────────────────────────

const WON = (n: number) => `₩${n.toLocaleString("ko-KR")}`;

/** 리포 루트 assets/invoice-fonts — 서버·워커 Dockerfile 이 같은 상대 위치로 COPY 한다.
 *  cwd 가 아니라 이 파일 기준(src → apps/server → 루트)이라 실행 위치에 흔들리지 않는다. */
function fontDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "assets", "invoice-fonts");
}

let fontCache: { medium: string; bold: string } | null = null;
function loadFontsB64(): { medium: string; bold: string } {
  fontCache ??= {
    medium: fs.readFileSync(path.join(fontDir(), "GmarketSansTTFMedium.ttf")).toString("base64"),
    bold: fs.readFileSync(path.join(fontDir(), "GmarketSansTTFBold.ttf")).toString("base64"),
  };
  return fontCache;
}

export async function renderInvoicePdf(
  invoice: PaymentInvoice,
  supplier: InvoiceParty,
  buyer: InvoiceParty,
): Promise<Buffer> {
  const { jsPDF } = await import("jspdf");
  const fonts = loadFontsB64();

  const doc = new jsPDF({ unit: "mm", format: "a4" });
  doc.addFileToVFS("GmarketSansTTFMedium.ttf", fonts.medium);
  doc.addFont("GmarketSansTTFMedium.ttf", "GmarketSans", "normal");
  doc.addFileToVFS("GmarketSansTTFBold.ttf", fonts.bold);
  doc.addFont("GmarketSansTTFBold.ttf", "GmarketSans", "bold");

  const M = 18;
  const W = 210 - M * 2;
  const right = M + W;
  let y = 24;

  const text = (
    s: string, x: number, yy: number,
    opts?: { size?: number; bold?: boolean; color?: number; align?: "left" | "right" },
  ) => {
    doc.setFont("GmarketSans", opts?.bold ? "bold" : "normal");
    doc.setFontSize(opts?.size ?? 9.5);
    const c = opts?.color ?? 30;
    doc.setTextColor(c, c, c);
    doc.text(s, x, yy, { align: opts?.align ?? "left" });
  };

  text("인보이스", M, y, { size: 20, bold: true });
  text("Invoice", M + 32, y, { size: 11, color: 130 });
  text(invoice.number, right, y - 4, { size: 10.5, bold: true, align: "right" });
  text(`결제일 ${invoice.paidAt.slice(0, 10)}`, right, y + 1, { size: 9, color: 110, align: "right" });
  y += 6;
  doc.setDrawColor(60);
  doc.setLineWidth(0.6);
  doc.line(M, y, right, y);
  y += 10;

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

  const meta = [
    `결제 상태: 결제 완료 (${invoice.origin === "auto" ? "자동 충전" : "카드 결제"})`,
    `결제 ID: ${invoice.id}`,
    `결제 일시: ${invoice.paidAt.replace("T", " ").slice(0, 19)}`,
  ];
  for (const m of meta) {
    text(m, M, y, { size: 8.5, color: 90 });
    y += 4.8;
  }

  const fy = 278;
  doc.setDrawColor(210);
  doc.line(M, fy - 6, right, fy - 6);
  text("본 문서는 STEP-D 결제 내역 확인용 인보이스이며 세금계산서가 아닙니다.", M, fy, { size: 7.5, color: 130 });
  if (supplier.email) {
    text(`세금계산서 등 증빙 문의: ${supplier.email}`, M, fy + 4, { size: 7.5, color: 130 });
  }

  return Buffer.from(doc.output("arraybuffer"));
}

// ── 이메일 ────────────────────────────────────────────────────────────────────

function mailHtml(invoice: PaymentInvoice, supplier: InvoiceParty): string {
  const row = (k: string, v: string) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#666;">${k}</td><td style="padding:4px 0;color:#111;">${v}</td></tr>`;
  return `
  <div style="font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;max-width:520px;margin:0 auto;color:#111;">
    <h2 style="font-size:17px;border-bottom:2px solid #111;padding-bottom:8px;">STEP-D 결제 인보이스</h2>
    <p style="font-size:13px;line-height:1.6;">결제가 완료되어 인보이스를 보내드립니다. 상세 내역은 첨부된 PDF 를 확인하세요.</p>
    <table style="font-size:13px;border-collapse:collapse;">
      ${row("인보이스 번호", invoice.number)}
      ${row("결제일", invoice.paidAt.slice(0, 10))}
      ${row("항목", invoice.description)}
      ${row("공급가액", WON(invoice.supplyKrw))}
      ${row("부가세 (10%)", WON(invoice.vatKrw))}
      ${row("<b>합계 (부가세 포함)</b>", `<b>${WON(invoice.amountKrw)}</b>`)}
      ${row("결제 방식", invoice.origin === "auto" ? "자동 충전" : "카드 결제")}
    </table>
    <p style="font-size:11px;color:#888;line-height:1.6;margin-top:16px;">
      본 메일과 첨부 문서는 결제 내역 확인용 인보이스이며 세금계산서가 아닙니다.<br/>
      ${supplier.email ? `세금계산서 등 증빙 문의: ${supplier.email}<br/>` : ""}
      인보이스는 STEP-D 결제 화면(크레딧 → 인보이스)에서도 다시 받을 수 있습니다.
    </p>
  </div>`;
}

/**
 * 결제 완료 이메일 — **적립이 실제로 일어난 자리에서만** fire-and-forget 으로 부른다.
 * 어떤 실패도 던지지 않는다 — 크레딧 적립은 이미 끝난 사실이고 메일은 부속이다.
 */
export async function sendInvoiceEmail(paymentId: string, tenantId: string): Promise<void> {
  try {
    if (!smtpConfigured()) {
      console.log(`[invoice] SMTP 미설정 — 인보이스 메일 건너뜀 (${paymentId})`);
      return;
    }
    const order = await getTopup(paymentId);
    if (!order || order.status !== "paid") {
      console.warn(`[invoice] paid 상태가 아니라 메일 안 보냄 (${paymentId}: ${order?.status ?? "없음"})`);
      return;
    }

    // 결제창/빌링키 요청에 넣었던 "영수증 받을 이메일" — 포트원 단건 조회로 되찾는다.
    let paymentEmail: string | null = null;
    try {
      const p = await getPayment(paymentId) as
        { payment?: { customer?: { email?: string } }; customer?: { email?: string } };
      paymentEmail = p?.payment?.customer?.email ?? p?.customer?.email ?? null;
    } catch { /* 조회 실패 시 폴백 이메일로 */ }

    const buyer = await buyerFor(tenantId);
    const supplier = supplierFromEnv();
    const to = resolveRecipient({ paymentEmail, buyerEmail: buyer.email });
    if (!to) {
      console.warn(`[invoice] 수신자 이메일 없음 — 메일 안 보냄 (${paymentId})`);
      return;
    }

    const invoice = invoiceFromTopup(order);
    const pdf = await renderInvoicePdf(invoice, supplier, buyer);

    await sendMail({
      to,
      subject: `[STEP-D] 인보이스 ${invoice.number} — ${WON(invoice.amountKrw)} 결제 완료`,
      html: mailHtml(invoice, supplier),
      attachments: [{ filename: `${invoice.number}.pdf`, content: pdf, contentType: "application/pdf" }],
    });
    console.log(`[invoice] 인보이스 메일 발송 ${invoice.number} → ${to}`);
  } catch (e) {
    // 메일 실패는 결제·적립에 영향이 없어야 한다 — 로그로만 남긴다.
    console.error(`[invoice] 인보이스 메일 실패 (${paymentId}):`, e instanceof Error ? e.message : e);
  }
}
