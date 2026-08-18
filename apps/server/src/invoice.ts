/**
 * 인보이스(거래명세서) — 회사에 "이 달에 얼마 썼는지"를 문서로 준다. 순수 모듈.
 *
 * ## 이건 세금계산서가 아니다
 * 전자세금계산서는 국세청에 신고되는 법정 증빙이라 별도 발행 서비스(팝빌·바로빌 등)가
 * 필요하다. 여기서 만드는 건 **우리 데이터로 만드는 거래명세서**다 — 방송사 상대 B2B 면
 * 결국 세금계산서를 요구받겠지만, 그건 별도 연동이고 그때 붙인다.
 * 그래서 문서에 "세금계산서"라고 쓰지 않는다. 아닌 걸 그렇게 부르면 상대가 그걸로
 * 회계 처리를 하려다 문제가 생긴다.
 *
 * ## 부가세는 총액에서 역산한다
 * 크레딧 단가(`CREDIT_PRICE_KRW`)는 **실제로 카드에서 긁히는 금액**이다. 국내 소비자가
 * 표기 관행상 이 값을 부가세 포함으로 본다. 그래서
 *
 *     공급가액 = round(총액 / 1.1) · 세액 = 총액 − 공급가액
 *
 * 로 나눈다. 반대로 "단가가 공급가액이고 부가세를 더 받는다"로 잡으면 **실제 결제액과
 * 인보이스 합계가 어긋난다** — 그게 제일 나쁘다. 합계는 언제나 실제 결제액과 같아야 한다.
 *
 * ## 금액은 원장이 아니라 결제에서 온다
 * 크레딧 원장에는 무상 지급(grant)·정정(adjust)도 섞여 있다. **돈이 오간 건 topup 뿐**이라
 * 인보이스는 결제(credit_topup)에서 만든다. 무상분을 청구서에 얹으면 안 된다.
 */

export const VAT_RATE = 0.1;

export interface VatSplit {
  supplyKrw: number;
  vatKrw: number;
  totalKrw: number;
}

/** 총액(부가세 포함) → 공급가액 + 세액. **합계는 반드시 원래 총액과 같다.** */
export function splitVat(totalKrw: number): VatSplit {
  const total = Math.max(0, Math.round(Number(totalKrw) || 0));
  const supply = Math.round(total / (1 + VAT_RATE));
  // 세액을 따로 반올림하지 않고 차액으로 잡는다 — 둘 다 반올림하면 합이 총액과 1원 어긋난다.
  return { supplyKrw: supply, vatKrw: total - supply, totalKrw: total };
}

/** `2026-08` 형식인가. 아니면 null — 임의 문자열이 SQL 로 흘러가지 않게 여기서 막는다. */
export function parseMonth(v: unknown): { year: number; month: number; key: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(String(v ?? "").trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12 || year < 2000 || year > 2999) return null;
  return { year, month, key: `${m[1]}-${m[2]}` };
}

/** 그 달의 [시작, 다음 달 시작). 끝을 "말일 23:59:59"로 잡으면 경계의 결제를 놓친다. */
export function monthRange(year: number, month: number): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const nextY = month === 12 ? year + 1 : year;
  const nextM = month === 12 ? 1 : month + 1;
  return { from: `${year}-${pad(month)}-01`, to: `${nextY}-${pad(nextM)}-01` };
}

/**
 * 인보이스 번호. 회사·월이 같으면 **항상 같은 번호**가 나온다 —
 * 다시 뽑을 때 번호가 바뀌면 상대가 다른 청구서로 오해한다.
 */
export function invoiceNumber(tenantId: string, monthKey: string): string {
  return `INV-${monthKey}-${tenantId}`;
}

export interface IssuerInfo {
  name: string;
  bizNo: string;
  address: string;
  contact: string;
}

export type IssuerCheck =
  | { ok: true; issuer: IssuerInfo }
  | { ok: false; issuer: IssuerInfo; missing: string[] };

/**
 * 발행자(우리) 정보. **없는 값을 지어내지 않는다** — 사업자번호가 비어 있는데 그럴듯한
 * 숫자를 넣으면 그건 위조다. 빠진 항목을 그대로 돌려주고 화면이 "설정하세요"라고 말한다.
 */
export function issuerInfo(env: NodeJS.ProcessEnv = process.env): IssuerCheck {
  const issuer: IssuerInfo = {
    name: String(env.INVOICE_ISSUER_NAME ?? "").trim(),
    bizNo: String(env.INVOICE_ISSUER_BIZNO ?? "").trim(),
    address: String(env.INVOICE_ISSUER_ADDRESS ?? "").trim(),
    contact: String(env.INVOICE_ISSUER_CONTACT ?? "").trim(),
  };
  const missing: string[] = [];
  if (!issuer.name) missing.push("INVOICE_ISSUER_NAME");
  if (!issuer.bizNo) missing.push("INVOICE_ISSUER_BIZNO");
  return missing.length ? { ok: false, issuer, missing } : { ok: true, issuer };
}

export interface PaymentRow {
  paymentId: string;
  credits: number;
  amountKrw: number;
  status: string;
  settledAt: string | null;
  createdAt: string;
}

export interface InvoiceLine {
  paymentId: string;
  date: string;
  desc: string;
  credits: number;
  amountKrw: number;
}

export interface Invoice {
  number: string;
  monthKey: string;
  lines: InvoiceLine[];
  credits: number;
  supplyKrw: number;
  vatKrw: number;
  totalKrw: number;
}

/**
 * 결제 목록 → 인보이스.
 *
 * **`paid` 만 담는다.** 실패·대기 건을 얹으면 받지도 않은 돈을 청구하는 게 된다
 * (그 건들은 결제 로그에서 따로 본다).
 */
export function buildInvoice(input: {
  tenantId: string;
  monthKey: string;
  payments: PaymentRow[];
}): Invoice {
  const lines: InvoiceLine[] = input.payments
    .filter((p) => p.status === "paid")
    .map((p) => ({
      paymentId: p.paymentId,
      date: String(p.settledAt ?? p.createdAt).slice(0, 10),
      desc: `크레딧 ${p.credits.toLocaleString("ko-KR")}개 (분석 ${p.credits.toLocaleString("ko-KR")}분)`,
      credits: p.credits,
      amountKrw: p.amountKrw,
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.paymentId.localeCompare(b.paymentId));

  const total = lines.reduce((s, l) => s + l.amountKrw, 0);
  const vat = splitVat(total);
  return {
    number: invoiceNumber(input.tenantId, input.monthKey),
    monthKey: input.monthKey,
    lines,
    credits: lines.reduce((s, l) => s + l.credits, 0),
    ...vat,
  };
}

// ── 결제 건별 인보이스 (2026-08-18) ─────────────────────────────────────────────
// 위 월별 거래명세서(어드민)와 별개로, **결제 한 건 = 인보이스 한 장**이 제품 화면
// (/credits 인보이스 다이얼로그)과 결제 완료 메일에 쓰인다. 부가세 역산은 같은 splitVat.
// PDF·메일 발송(부수효과)은 invoice-email.ts — 이 파일은 순수 모듈로 유지한다.

export interface PaymentInvoice {
  id: string;
  /** SD-YYYYMMDD-XXXXXX — 결제 데이터에서 결정적으로 만든다(별도 채번 없음). */
  number: string;
  paidAt: string;
  credits: number;
  /** 부가세 포함 총액. supply/vat 는 splitVat 역산 — 화면·PDF·메일이 같은 값을 쓴다. */
  amountKrw: number;
  supplyKrw: number;
  vatKrw: number;
  origin: "auto" | "manual";
  description: string;
}

export function invoiceFromTopup(r: {
  paymentId: string; credits: number; amountKrw: number; requestedBy: string;
  createdAt?: string; settledAt?: string | null;
}): PaymentInvoice {
  const paidAt = String(r.settledAt ?? r.createdAt ?? new Date().toISOString());
  const vat = splitVat(r.amountKrw);
  return {
    id: r.paymentId,
    number: `SD-${paidAt.slice(0, 10).replace(/-/g, "")}-${r.paymentId.slice(-6).toUpperCase()}`,
    paidAt,
    credits: r.credits,
    amountKrw: vat.totalKrw,
    supplyKrw: vat.supplyKrw,
    vatKrw: vat.vatKrw,
    origin: r.requestedBy.startsWith("auto") ? "auto" : "manual",
    description: `STEP-D 크레딧 ${r.credits.toLocaleString("ko-KR")}개 (분석 ${r.credits.toLocaleString("ko-KR")}분)`,
  };
}

export interface InvoiceParty {
  name: string;
  bizNo: string;
  ceoName: string;
  address: string;
  email: string;
}

/** 공급자(우리) — issuerInfo 와 같은 INVOICE_ISSUER_* env. 비면 문서에서 그 항목을 생략한다. */
export function supplierFromEnv(env: NodeJS.ProcessEnv = process.env): InvoiceParty {
  return {
    name: String(env.INVOICE_ISSUER_NAME ?? "").trim() || "STEP AI",
    bizNo: String(env.INVOICE_ISSUER_BIZNO ?? "").trim(),
    ceoName: String(env.INVOICE_ISSUER_CEO ?? "").trim(),
    address: String(env.INVOICE_ISSUER_ADDRESS ?? "").trim(),
    email: String(env.INVOICE_ISSUER_CONTACT ?? "").trim() || "contact@stepai.kr",
  };
}

/**
 * 메일 수신자 우선순위 — **결제창에 넣은 이메일이 1순위다** ("영수증 받을 이메일"로 받았다).
 * 없으면 사업자정보/워크스페이스 청구 이메일. 형식이 아니면 다음 후보로 넘어간다.
 */
export function resolveRecipient(candidates: {
  paymentEmail?: string | null;
  buyerEmail?: string | null;
}): string | null {
  for (const v of [candidates.paymentEmail, candidates.buyerEmail]) {
    const s = String(v ?? "").trim();
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return s;
  }
  return null;
}

export function smtpConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
}
