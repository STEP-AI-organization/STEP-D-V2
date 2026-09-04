/**
 * 결제 영수증 메일 — 결제 완료 시 "영수증 받을 이메일"로 자동 발송하는 배선.
 *
 * 순수 계산(번호·역산·수신자 우선순위)은 invoice.ts, 여기는 부수효과만:
 * DB 조회(구매자·카드·잔액), 포트원 조회(결제창 이메일), SMTP 발송.
 *
 * **첨부 없이 본문만 보낸다**(2026-08-27 사용자 확정). 영수증 본문이 그 자체로 완결이라
 * 첨부가 더 주는 정보가 없고, 첨부를 만들려고 폰트를 읽고 PDF 를 그리는 비용·실패 지점만
 * 남는다. PDF 가 필요한 사람은 결제 화면에서 직접 내려받는다(apps/web invoice-pdf.ts).
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
 */

import { asSystem, getBillingNotifyEmails, getBusinessProfile, getTopup } from "../db-pg.ts";
import {
  invoiceFromTopup,
  smtpConfigured,
  supplierFromEnv,
  type InvoiceParty,
  type PaymentInvoice,
} from "./invoice.ts";
import { sendMail } from "../mailer.ts";

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

  /**
   * 공급자(우리) 표기 — **사업자등록번호가 없으면 상대가 회계 처리에 쓸 수 없다.**
   * 예전엔 이 메일이 상호·문의처만 실어서, env 에 사업자정보를 채워도 정작 고객이 받는
   * 문서에는 안 나왔다(2026-09-03 렌더 실측: bizNo·대표자·주소 0회).
   *
   * 이 파일의 규칙대로 **값이 없으면 그 줄을 통째로 뺀다** — "사업자등록번호 " 같은
   * 반쪽 문장이 나가면 문서 자체를 못 믿게 된다. 전부 비면 블록도 안 나온다.
   */
  const bizLine = [
    supplier.bizNo ? `사업자등록번호 ${esc(supplier.bizNo)}` : "",
    supplier.ceoName ? `대표 ${esc(supplier.ceoName)}` : "",
  ].filter(Boolean).join(" &nbsp;|&nbsp; ");
  const supplierLines = [
    supplier.name ? `<div style="font-weight:600;color:#1F2124;">${esc(supplier.name)}</div>` : "",
    bizLine ? `<div>${bizLine}</div>` : "",
    supplier.address ? `<div>${esc(supplier.address)}</div>` : "",
  ].filter(Boolean).join("");
  const supplierBlock = !supplierLines ? "" : `
    <div class="kr" style="font-size:12px;color:#5C5E63;line-height:1.8;padding-bottom:14px;margin-bottom:14px;border-bottom:1px solid rgba(31,33,36,0.08);">${supplierLines}</div>`;

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

  <tr><td class="pad" style="padding:26px 8px 0 8px;">${supplierBlock}
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
 * 영수증 템플릿의 부가 정보 — **없으면 그 줄을 빼므로** 실패해도 메일은 그대로 나간다.
 * 카드 뒤 4자리: 저장 카드에서 읽는다(전체 번호는 우리 DB 에 애초에 없다).
 * 충전 후 잔액: 이 메일은 적립 직후에 나가므로 지금 잔액이 곧 "충전 후" 다.
 *
 * 실제 발송과 테스트 발송(`/api/billing/invoice/test-email`)이 **같은 조회를 쓴다** —
 * 테스트가 자기만의 값을 만들면 "테스트는 멀쩡한데 실제는 깨지는" 상태를 못 잡는다.
 */
export async function receiptExtrasFor(tenantId: string): Promise<ReceiptExtras> {
  return await asSystem(async (db) => {
    const [card, bal] = await Promise.all([
      db.query(`SELECT card_last4 AS "last4" FROM billing_card WHERE tenant_id = $1`, [tenantId]),
      db.query(`SELECT COALESCE(SUM(delta), 0)::int AS n FROM credit_ledger WHERE tenant_id = $1`, [tenantId]),
    ]);
    return {
      cardLast4: (card.rows[0]?.last4 as string | null) ?? null,
      balanceAfter: (bal.rows[0]?.n as number | null) ?? null,
    };
  }).catch(() => ({ cardLast4: null, balanceAfter: null }));
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

    const supplier = supplierFromEnv();

    // ── 수신자 = **결제 알림 이메일에 등록된 사람뿐** (2026-09-04 사용자 지정) ──────────
    //
    // 예전에는 여기에 결제창 이메일(포트원 customer.email)과 구매자 이메일(사업자·청구
    // 연락처)을 1순위로 얹었다. 그래서 **카드를 등록한 계정 주인에게도 영수증이 갔고**,
    // 담당자 목록을 따로 관리하는 뜻이 없어졌다. 이제 목록이 정본이다 —
    // 받을 사람은 결제 화면(`/credits` → 결제 알림 이메일)에서 등록한다.
    //
    // ⚠️ 목록이 비면 **아무에게도 안 간다.** "등록한 사람들만" 이라는 규칙의 당연한 귀결이라
    // 몰래 다른 주소로 폴백하지 않는다. 영수증 자체는 사라지지 않는다 — 인보이스는 서버에
    // 남고 `/credits` → 인보이스 보기에서 PDF 로 받을 수 있다.
    const recipients = await getBillingNotifyEmails().catch(() => [] as string[]);
    if (recipients.length === 0) {
      console.warn(`[invoice] 결제 알림 수신자가 등록돼 있지 않아 메일을 보내지 않습니다 (${paymentId})`);
      return;
    }
    const to = recipients.join(", ");

    const invoice = invoiceFromTopup(order);

    const extras = await receiptExtrasFor(tenantId);

    await sendMail({
      to,
      subject: `[STEP AI] 결제 영수증 ${invoice.receiptNumber} — ${WON(invoice.amountKrw)} 결제 완료`,
      html: mailHtml(invoice, supplier, extras),
    });
    console.log(`[invoice] 결제 영수증 메일 발송 ${invoice.receiptNumber} → ${to}`);
  } catch (e) {
    // 메일 실패는 결제·적립에 영향이 없어야 한다 — 로그로만 남긴다.
    console.error(`[invoice] 인보이스 메일 실패 (${paymentId}):`, e instanceof Error ? e.message : e);
  }
}
