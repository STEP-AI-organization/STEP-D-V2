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
 * ## 부가세 — 만들 때 creditAmounts, 쪼갤 때 splitVat
 * 크레딧 단가(`CREDIT_PRICE_KRW`)는 **공급가액**이다(2026-08-27 사용자 확정 · 부가세 별도).
 * 즉 `크레딧 × 단가` 는 청구액이 아니라 공급가액이고, 카드에 긁히는 금액은 거기에 10% 를
 * 더한 값이다:
 *
 *     주문을 만들 때  청구액 = 공급가액 + round(공급가액 × 0.1)   → credits.ts creditAmounts
 *     문서로 쪼갤 때  공급가액 = round(청구액 / 1.1) · 세액 = 차액  → splitVat (아래)
 *
 * **둘은 왕복이 맞아야 한다**(splitVat(청구액).supplyKrw === 원래 공급가액) — 어긋나면
 * 세금계산서의 공급가액이 실제 판매가와 달라진다. 그리고 어느 쪽이든 지켜야 하는 불변식은
 * 하나다: **문서의 합계는 언제나 실제 결제액과 같아야 한다.**
 *
 * ⚠️ 2026-08-27 이전 주문은 단가가 부가세 **포함**이라 `크레딧 × 단가` 가 곧 청구액이었다.
 * 옛 행도 저장된 청구액을 splitVat 로 되쪼개므로 그때 나간 문서와 같은 숫자가 나온다 —
 * 과거 인보이스를 다시 뽑아도 값이 변하지 않는다.
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

/**
 * 총액(부가세 포함) → 공급가액 + 세액. **합계는 반드시 원래 총액과 같다.**
 *
 * 이미 청구된 금액을 문서로 쪼갤 때 쓴다(인보이스·명세서). 새 주문의 금액을 **만들** 때는
 * credits.ts 의 creditAmounts 를 쓴다 — 단가(CREDIT_PRICE_KRW)는 2026-08-27 부터
 * **공급가액 기준**이라 청구액은 거기에 10% 를 더한 값이다.
 */
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

/**
 * 인보이스 번호 — **랜덤해 보이되 결제마다 고정**이다 (2026-08-27 사용자 요청).
 *
 * 왜 진짜 난수가 아닌가: 이 번호는 **저장하지 않고 매번 결제 데이터에서 다시 만든다**
 * (메일 제목·PDF 파일명·목록·문서 상단 네 곳이 각자 만든다). 호출마다 달라지면 같은
 * 결제인데 메일과 PDF 의 번호가 다르고, 상대는 다른 청구서로 오해한다. 그래서
 * **결제 ID 해시**로 만든다 — 같은 결제는 영원히 같은 번호, 다른 결제는 다른 번호.
 *
 * 예전 형식(`SD-20260818-DEF456`)은 내부 결제 ID 뒤 6자리를 그대로 노출했고 접두사도
 * 내부 코드명처럼 읽혔다. 지금은 날짜도 내부 ID 도 드러내지 않는다(결제일은 문서 안에
 * 따로 적힌다). 혼동하기 쉬운 글자(I·L·O·U)를 뺀 32진수라 사람이 받아 적기도 쉽다.
 */
const INVOICE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32 (I·L·O·U 제외)

function invoiceHash(seed: string, chars: number): string {
  const fnv = (offset: number): number => {
    let h = offset >>> 0;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  let n = (BigInt(fnv(0x811c9dc5)) << 32n) | BigInt(fnv(0x9e3779b9));
  let out = "";
  for (let i = 0; i < chars; i++) {
    out = INVOICE_ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

export function paymentInvoiceNumber(paymentId: string): string {
  // 32비트 FNV-1a 두 벌(서로 다른 오프셋)로 64비트를 만든다 — 순수 모듈이라 crypto 를
  // 끌어오지 않는다. 충돌은 결제 건수 규모(연 수천)에서 무시할 수준이다.
  return invoiceHash(String(paymentId ?? ""), 12);
}

/**
 * 영수증 번호 — `RC-YYYYMMDD-XXXXXX` (템플릿 규격). 인보이스 번호와 **다른 값**이어야
 * 두 줄이 각자 의미를 갖는다(같은 결제의 서로 다른 문서 축). 시드에 소금을 섞어 가른다.
 * 번호 자체는 인보이스 번호와 같은 이유로 **결제마다 고정**이다(저장하지 않는다).
 */
export function paymentReceiptNumber(paymentId: string, paidAt: string): string {
  const day = String(paidAt ?? "").slice(0, 10).replace(/-/g, "") || "00000000";
  return `RC-${day}-${invoiceHash(`receipt:${paymentId ?? ""}`, 6)}`;
}

export interface PaymentInvoice {
  id: string;
  /** 12자 랜덤형 토큰 — 결제마다 고정(paymentInvoiceNumber). 날짜·내부 ID 를 노출하지 않는다. */
  number: string;
  /** 영수증 번호 `RC-YYYYMMDD-XXXXXX` — 결제 영수증 메일이 인보이스 번호와 나란히 보여준다. */
  receiptNumber: string;
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
    number: paymentInvoiceNumber(r.paymentId),
    receiptNumber: paymentReceiptNumber(r.paymentId, paidAt),
    paidAt,
    credits: r.credits,
    amountKrw: vat.totalKrw,
    supplyKrw: vat.supplyKrw,
    vatKrw: vat.vatKrw,
    origin: r.requestedBy.startsWith("auto") ? "auto" : "manual",
    description: `STEP AI 크레딧 ${r.credits.toLocaleString("ko-KR")}개 (분석 ${r.credits.toLocaleString("ko-KR")}분)`,
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

/*
 * `resolveRecipient` 는 2026-09-04 에 지웠다 — 인보이스 수신자를 **결제 알림에 등록된
 * 사람들만**으로 정하면서(사용자 지정) 결제창 이메일·구매자 이메일을 수신자로 쓰지
 * 않게 됐다. 쓰는 곳 없이 테스트만 남으면 그 테스트는 영영 초록인 채 아무것도 안 지킨다.
 * 지금 규칙을 지키는 테스트는 invoice-email.test.ts 의 "수신자는 등록된 담당자뿐" 이다.
 */

/**
 * Gmail XOAUTH2 — 비밀번호(SMTP_PASS) 대신 OAuth 3종으로 인증한다.
 * ⚠️ refresh token 의 스코프가 `https://mail.google.com/` 여야 SMTP 가 열린다 —
 * `gmail.send` 만으로는 REST API 는 되지만 SMTP XOAUTH2 는 거절된다.
 */
export function smtpOAuthConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.SMTP_USER && env.SMTP_OAUTH_CLIENT_ID
    && env.SMTP_OAUTH_CLIENT_SECRET && env.SMTP_OAUTH_REFRESH_TOKEN,
  );
}

export function smtpConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) || smtpOAuthConfigured(env);
}
