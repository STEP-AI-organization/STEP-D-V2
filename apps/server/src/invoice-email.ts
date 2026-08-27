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

import { asSystem, getBillingNotifyEmails, getBusinessProfile, getTopup } from "./db-pg.ts";
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
  text("본 문서는 STEP AI 결제 내역 확인용 인보이스이며 세금계산서가 아닙니다.", M, fy, { size: 7.5, color: 130 });
  if (supplier.email) {
    text(`세금계산서 등 증빙 문의: ${supplier.email}`, M, fy + 4, { size: 7.5, color: 130 });
  }

  return Buffer.from(doc.output("arraybuffer"));
}

// ── 이메일 ────────────────────────────────────────────────────────────────────

/** 결제 영수증 메일에 실리는, 인보이스 밖의 값들. 모르면 그 줄을 통째로 뺀다(빈칸 금지). */
export interface ReceiptExtras {
  /** 카드 뒤 4자리. **전체 번호는 어디에도 넣지 않는다.** 모르면 null → 카드 표기 생략. */
  cardLast4?: string | null;
  /** 충전 후 잔액(크레딧). 모르면 null → 잔액 블록 생략. */
  balanceAfter?: number | null;
}

const KRW = (n: number) => n.toLocaleString("ko-KR");

/** `2026-08-26T…` → `2026년 8월 26일`. 파싱 실패면 날짜 부분을 그대로 쓴다(빈칸보다 낫다). */
function paidDateKo(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (!m) return String(iso ?? "").slice(0, 10);
  return `${m[1]}년 ${Number(m[2])}월 ${Number(m[3])}일`;
}

/**
 * 결제 영수증 메일 (2026-08-27 사용자 제공 템플릿 이식).
 *
 * 템플릿이 못박은 규칙 두 가지를 코드로 지킨다:
 *  1. **카드 전체 번호는 어디에도 넣지 않는다** — 뒤 4자리만, 그것도 모르면 생략한다.
 *  2. **내부 제품명을 넣지 않는다** — 문서에 나가는 이름은 "STEP AI"·발행자명뿐이다.
 *
 * 값이 없으면 빈칸을 남기지 않고 **그 줄을 통째로 뺀다.** 영수증에 "**** " 나
 * "잔액  크레딧" 같은 반쪽 문장이 나가면 문서 자체를 못 믿게 된다.
 */
export function mailHtml(
  invoice: PaymentInvoice, supplier: InvoiceParty, extras: ReceiptExtras = {},
): string {
  const esc = (v: string) => String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const MONO = "'SFMono-Regular',Consolas,Menlo,monospace";
  const issuer = supplier.name || "(주)스텝에이아이";
  const contact = supplier.email || "contact@stepai.kr";
  const payMethod = invoice.origin === "auto" ? "자동 결제" : "카드 결제";
  const last4 = String(extras.cardLast4 ?? "").replace(/\D/g, "").slice(-4);
  const balance = extras.balanceAfter != null && Number.isFinite(Number(extras.balanceAfter))
    ? Number(extras.balanceAfter) : null;

  const idRow = (label: string, value: string, top: string) => `
          <tr>
            <td style="padding:${top} 0 0 0;font-size:14px;color:#5C5E63;line-height:1.6;">${label}</td>
            <td align="right" style="padding:${top} 0 0 0;font-family:${MONO};font-size:13px;color:#1F2124;line-height:1.6;">${value}</td>
          </tr>`;
  const amtRow = (label: string, value: string, top: string, strong: boolean) => `
          <tr>
            <td style="padding:${top} 0 0 0;font-size:${strong ? "15px;font-weight:600" : "14px"};color:${strong ? "#1F2124" : "#5C5E63"};line-height:1.6;">${label}</td>
            <td align="right" style="padding:${top} 0 0 0;font-family:${MONO};font-size:${strong ? "15px;font-weight:600" : "14px"};color:${strong ? "#1F2124" : "#5C5E63"};line-height:1.6;">&#8361;${value}</td>
          </tr>`;

  const balanceBlock = balance == null ? "" : `
        <div style="border-top:1px solid rgba(31,33,36,0.08);margin-top:26px;padding-top:22px;">
          <div style="font-size:13px;color:#5C5E63;line-height:1.5;">크레딧 잔액</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;">
            <tr>
              <td style="font-size:15px;font-weight:600;color:#1F2124;line-height:1.6;">충전 후 잔액</td>
              <td align="right" style="font-family:${MONO};font-size:15px;font-weight:600;color:#1F2124;line-height:1.6;">${KRW(balance)} 크레딧</td>
            </tr>
          </table>
          <div class="kr" style="font-size:12px;color:#5C5E63;line-height:1.7;padding-top:12px;">잔여 크레딧이 모두 소진되면 자동으로 충전됩니다.</div>
        </div>`;

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>결제 영수증</title>
<style>
  body { margin:0; padding:0; background:#F0EEEB; }
  table { border-collapse:collapse; }
  img { border:0; outline:none; text-decoration:none; }
  a { color:#1F2124; }
  .kr { word-break:keep-all; }
  @media only screen and (max-width:620px) {
    .wrap  { width:100% !important; }
    .pad   { padding-left:22px !important; padding-right:22px !important; }
    .amt   { font-size:30px !important; }
  }
</style>
</head>
<body>
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${esc(paidDateKo(invoice.paidAt))} 결제가 완료되었습니다. 금액 &#8361;${KRW(invoice.amountKrw)}.</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F0EEEB;">
<tr><td align="center" style="padding:28px 12px 36px 12px;">

<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic','Pretendard Variable',Pretendard,sans-serif;">

  <tr><td class="pad" style="padding:0 8px 18px 8px;">
    <span style="font-size:14px;font-weight:600;letter-spacing:0.28em;color:#1F2124;">STEP AI</span>
    <span style="font-size:13px;color:#5C5E63;padding-left:10px;">${esc(issuer)}</span>
  </td></tr>

  <tr><td style="padding:0 0 16px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FDFCFC;border-radius:10px;">
      <tr><td class="pad" style="padding:30px 34px 30px 34px;">

        <div style="font-size:14px;color:#5C5E63;line-height:1.5;">${esc(issuer)} 결제 영수증</div>
        <div class="amt" style="font-family:${MONO};font-size:38px;font-weight:600;color:#1F2124;line-height:1.2;padding-top:10px;">&#8361;${KRW(invoice.amountKrw)}</div>
        <div style="font-size:14px;color:#5C5E63;line-height:1.6;padding-top:10px;">${esc(paidDateKo(invoice.paidAt))} 결제 완료</div>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid rgba(31,33,36,0.08);margin-top:24px;">${idRow("인보이스 번호", esc(invoice.number), "18px")}${idRow("영수증 번호", esc(invoice.receiptNumber), "10px")}
          <tr>
            <td style="padding:10px 0 0 0;font-size:14px;color:#5C5E63;line-height:1.6;">결제 방식</td>
            <td align="right" style="padding:10px 0 0 0;font-size:14px;color:#1F2124;line-height:1.6;">${esc(payMethod)}${last4 ? ` <span style="font-family:${MONO};font-size:13px;">**** ${esc(last4)}</span>` : ""}</td>
          </tr>
        </table>

      </td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FDFCFC;border-radius:10px;">
      <tr><td class="pad" style="padding:30px 34px 32px 34px;">

        <div style="font-size:16px;font-weight:600;color:#1F2124;line-height:1.5;">영수증 ${esc(invoice.receiptNumber)}</div>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;">
          <tr>
            <td valign="top" style="font-size:16px;font-weight:600;color:#1F2124;line-height:1.5;">크레딧 ${KRW(invoice.credits)}개</td>
            <td align="right" valign="top" style="font-family:${MONO};font-size:16px;color:#1F2124;line-height:1.5;">&#8361;${KRW(invoice.supplyKrw)}</td>
          </tr>
        </table>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid rgba(31,33,36,0.08);margin-top:24px;">${amtRow("공급가액", KRW(invoice.supplyKrw), "20px", false)}${amtRow("부가세 (10%)", KRW(invoice.vatKrw), "10px", false)}${amtRow("결제 금액", KRW(invoice.amountKrw), "14px", true)}
        </table>${balanceBlock}

      </td></tr>
    </table>
  </td></tr>

  <tr><td class="pad" style="padding:26px 8px 0 8px;">
    <div style="font-size:13px;color:#5C5E63;line-height:1.7;">문의처 <a href="mailto:${esc(contact)}" style="color:#1F2124;">${esc(contact)}</a></div>
    <div class="kr" style="font-size:12px;color:#5C5E63;line-height:1.8;padding-top:10px;">
      본 문서는 결제 내역 확인용입니다. 신용카드 결제분은 카드 매출전표가 적격증빙이며 부가세 매입세액 공제가 가능합니다.<br>
      카드 결제 건에는 세금계산서가 중복 발행되지 않습니다.
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
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
    // 수신자 = 결제창 이메일(1순위) + 결제 알림 수신자 목록(B2B 담당자 여러 명 · 결제 화면에서 등록).
    const primary = resolveRecipient({ paymentEmail, buyerEmail: buyer.email });
    const extra = await getBillingNotifyEmails().catch(() => [] as string[]);
    const recipients = [...new Set([primary, ...extra].filter(Boolean))] as string[];
    if (recipients.length === 0) {
      console.warn(`[invoice] 수신자 이메일 없음 — 메일 안 보냄 (${paymentId})`);
      return;
    }
    const to = recipients.join(", ");

    const invoice = invoiceFromTopup(order);
    const pdf = await renderInvoicePdf(invoice, supplier, buyer);

    // 영수증 템플릿의 부가 정보 — **없으면 그 줄을 빼므로** 실패해도 메일은 그대로 나간다.
    // 카드 뒤 4자리: 저장 카드에서 읽는다(전체 번호는 우리 DB 에 애초에 없다).
    // 충전 후 잔액: 이 메일은 적립 직후에 나가므로 지금 잔액이 곧 "충전 후" 다.
    const extras = await asSystem(async (db) => {
      const [card, bal] = await Promise.all([
        db.query(`SELECT card_last4 AS "last4" FROM billing_card WHERE tenant_id = $1`, [tenantId]),
        db.query(`SELECT COALESCE(SUM(delta), 0)::int AS n FROM credit_ledger WHERE tenant_id = $1`, [tenantId]),
      ]);
      return {
        cardLast4: (card.rows[0]?.last4 as string | null) ?? null,
        balanceAfter: (bal.rows[0]?.n as number | null) ?? null,
      };
    }).catch(() => ({ cardLast4: null, balanceAfter: null }));

    await sendMail({
      to,
      subject: `[STEP AI] 결제 영수증 ${invoice.receiptNumber} — ${WON(invoice.amountKrw)} 결제 완료`,
      html: mailHtml(invoice, supplier, extras),
      attachments: [{ filename: `${invoice.number}.pdf`, content: pdf, contentType: "application/pdf" }],
    });
    console.log(`[invoice] 인보이스 메일 발송 ${invoice.number} → ${to}`);
  } catch (e) {
    // 메일 실패는 결제·적립에 영향이 없어야 한다 — 로그로만 남긴다.
    console.error(`[invoice] 인보이스 메일 실패 (${paymentId}):`, e instanceof Error ? e.message : e);
  }
}
