/**
 * 결제 영수증 PDF — **디자이너 원본(`인보이스_미리보기_20260903.html`)을 종이에 옮긴 것.**
 *
 * 서버가 PDF 를 만들지 않는 이유: 문서 저장소가 따로 생기면 원장(credit_topup)과 문서가
 * 어긋날 수 있는 상태가 생긴다. 여기서는 서버가 준 데이터를 그 자리에서 그리므로
 * 문서 = 원장이다. 한글은 리포의 GmarketSans TTF 를 임베드한다(표준 PDF 폰트에는 한글이 없다).
 *
 * ## 같은 문서여야 한다 — 메일과도, 디자이너 원본과도
 *
 * 메일(`apps/server/src/billing/invoice-email.ts`)은 그 디자이너 HTML 을 그대로 이식한 것이고,
 * 이 PDF 도 같은 원본을 본다. 2026-09-07 에 **문구**를 맞췄고, 2026-09-14 에 **모양**을 맞췄다 —
 * 그전까지 PDF 는 선만 있는 평면이라 "같은 결제인데 다른 회사 문서 같다" 는 상태였다.
 *
 * 그래서 아래 치수·색은 **원본 CSS 값을 그대로** 옮긴 것이다(`px()` 로 환산). 값을 바꿀 땐
 * 원본과 메일을 같이 봐야 한다 — `invoice-format-parity.test.ts` 가 문구는 잡지만 모양은
 * 사람이 봐야 안다.
 *
 * ⚠️ **모르는 값은 빈칸으로 두지 않고 블록째 뺀다** — 메일과 같은 규칙.
 *    카드 뒤 4자리는 여기 없다: 우리가 아는 건 **지금** 등록된 카드뿐이라, 몇 달 전
 *    영수증에 그걸 적으면 그 결제에 없는 사실을 적는 셈이다(메일은 적립 직후라 맞다).
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

/** 숫자 표기 — 메일과 같다. */
const KRW = (n: number) => n.toLocaleString("ko-KR");
const WON = (n: number) => `₩${KRW(n)}`;

/** `2026-08-26T…` → `2026년 8월 26일`. 메일의 `paidDateKo` 와 같은 규칙. */
function paidDateKo(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (!m) return String(iso ?? "").slice(0, 10);
  return `${m[1]}년 ${Number(m[2])}월 ${Number(m[3])}일`;
}

// ── 원본 치수 ────────────────────────────────────────────────────────────────
//
// 디자이너 원본은 **600px 폭**이다. A4(210mm)에 좌우 18mm 여백을 두면 내용 폭이 174mm 이고,
// 그 비율(174/600)로 모든 px 값을 환산한다. 이렇게 해야 원본 CSS 숫자를 그대로 옮겨 적을 수
// 있고, 나중에 원본이 바뀌어도 같은 자리를 같은 값으로 고칠 수 있다.
const M = 18;                       // 좌우 여백(mm)
const W = 210 - M * 2;              // 내용 폭 174mm = 원본 600px
const px = (v: number) => (v * W) / 600;
/** px → pt. 화면 px 와 인쇄 pt 의 관계는 위 환산과 같은 비율로 잡는다. */
const pt = (v: number) => px(v) * 2.6;

const INK = [31, 33, 36] as const;        // #1F2124
const MUTED = [92, 94, 99] as const;      // #5C5E63
const PAGE_BG = [240, 238, 235] as const; // #F0EEEB
const CARD_BG = [253, 252, 252] as const; // #FDFCFC
// 원본의 구분선은 `rgba(31,33,36,.08)` 이라 **바탕색에 따라 실제 색이 다르다.** PDF 에는
// 알파가 없으니 미리 섞어 둔다 — 카드용 하나로 퉁치면 페이지 바탕 위에서는 묻혀서 안 보인다.
const LINE = [235, 234, 234] as const;      // 카드(#FDFCFC) 위
const PAGE_LINE = [223, 222, 219] as const; // 페이지 바탕(#F0EEEB) 위

export interface InvoicePdfInput {
  invoice: InvoiceRow;
  supplier: InvoiceParty;
  buyer: InvoiceParty;
}

/** 결제 영수증 한 건을 PDF 로 그려 즉시 다운로드한다. 파일명 = 영수증 번호. */
export async function downloadInvoicePdf({ invoice, supplier }: InvoicePdfInput): Promise<void> {
  const [{ jsPDF }, fonts] = await Promise.all([import("jspdf"), loadFonts()]);

  const doc = new jsPDF({ unit: "mm", format: "a4" });
  for (const f of fonts) {
    doc.addFileToVFS(f.file, f.b64);
    doc.addFont(f.file, FONT, f.style);
  }

  // 페이지 배경 — 원본의 body background. 이게 없으면 흰 종이에 흰 카드라 구조가 안 보인다.
  doc.setFillColor(...PAGE_BG);
  doc.rect(0, 0, 210, 297, "F");

  const right = M + W;
  const issuer = supplier.name || "(주)스텝에이아이";
  let y = px(28);   // 원본 상단 패딩

  const text = (
    s: string, x: number, yy: number,
    o?: { size?: number; bold?: boolean; muted?: boolean; align?: "left" | "right" },
  ) => {
    doc.setFont(FONT, o?.bold ? "bold" : "normal");
    doc.setFontSize(o?.size ?? pt(14));
    const c = o?.muted ? MUTED : INK;
    doc.setTextColor(c[0], c[1], c[2]);
    doc.text(s, x, yy, { align: o?.align ?? "left" });
  };
  /** 카드 안의 구분선 — 원본의 `border-top: 1px solid rgba(31,33,36,.08)`. */
  const rule = (yy: number, x0: number, x1: number, onPage = false) => {
    const c = onPage ? PAGE_LINE : LINE;
    doc.setDrawColor(c[0], c[1], c[2]);
    doc.setLineWidth(0.2);
    doc.line(x0, yy, x1, yy);
  };
  /** 라벨(왼쪽 muted) + 값(오른쪽). 원본의 idRow·amtRow 를 합친 것. */
  const row = (label: string, value: string, yy: number, x0: number, x1: number, strong = false) => {
    text(label, x0, yy, { size: strong ? pt(15) : pt(14), bold: strong, muted: !strong });
    text(value, x1, yy, { size: strong ? pt(15) : pt(14), bold: strong, muted: !strong, align: "right" });
  };

  // ── 머리: STEP AI · 발행자 ──────────────────────────────────────────────────
  text("STEP AI", M + px(8), y, { size: pt(14), bold: true });
  text(issuer, M + px(8) + px(78), y, { size: pt(13), muted: true });
  y += px(18);

  /**
   * **카드 높이는 재서 그린다. 추정하지 않는다.**
   *
   * 처음엔 원본 CSS 의 여백을 더해 높이를 계산했는데, 줄높이·폰트 상승분이 그대로 안 맞아
   * 카드 아래가 휑하게 비었다(실측). jsPDF 는 배경을 **글자보다 먼저** 칠해야 하므로
   * "그리고 나서 높이를 안다" 가 안 된다 — 그래서 같은 내용을 두 번 흘린다:
   * 한 번은 **안 그리고 끝 y 만** 재고, 그 값으로 배경을 칠한 뒤 다시 흘려 그린다.
   * 내용이 바뀌어도(잔액 블록 유무 등) 여백이 따라온다.
   */
  const card = (top: number, body: (cy: number, draw: boolean) => number): number => {
    const padY = px(30);
    const endY = body(top + padY, false);          // 1차: 높이만 잰다
    const h = endY - top + padY;
    doc.setFillColor(...CARD_BG);
    doc.roundedRect(M, top, W, h, px(10), px(10), "F");
    body(top + padY, true);                        // 2차: 같은 자리에 그린다
    return top + h;
  };

  const cx0 = M + px(34), cx1 = M + W - px(34);
  /** 그릴 때만 그린다 — 1차(측정) 호출에서 글자가 찍히면 배경에 덮인다. */
  const put = (draw: boolean, fn: () => void) => { if (draw) fn(); };

  // ── 카드 1: 금액과 식별자 ───────────────────────────────────────────────────
  y = card(y, (cy, draw) => {
    cy += px(11);
    put(draw, () => text(`${issuer} 결제 영수증`, cx0, cy, { size: pt(14), muted: true }));
    cy += px(10 + 34);
    put(draw, () => text(WON(invoice.amountKrw), cx0, cy, { size: pt(38), bold: true }));
    cy += px(10 + 18);
    put(draw, () => text(`${paidDateKo(invoice.paidAt)} 결제 완료`, cx0, cy, { size: pt(14), muted: true }));
    cy += px(24);
    put(draw, () => rule(cy, cx0, cx1));
    cy += px(18);
    put(draw, () => row("인보이스 번호", invoice.number, cy, cx0, cx1));
    cy += px(21 + 10);
    put(draw, () => row("영수증 번호", invoice.receiptNumber, cy, cx0, cx1));
    cy += px(21 + 10);
    put(draw, () => row("결제 방식", invoice.origin === "auto" ? "자동 결제" : "카드 결제", cy, cx0, cx1));
    return cy;
  }) + px(16);

  // ── 카드 2: 품목·금액·잔액 ──────────────────────────────────────────────────
  const hasBalance = invoice.balanceAfter != null && Number.isFinite(Number(invoice.balanceAfter));
  y = card(y, (cy, draw) => {
    cy += px(13);
    put(draw, () => text(`영수증 ${invoice.receiptNumber}`, cx0, cy, { size: pt(16), bold: true }));
    cy += px(24 + 13);
    put(draw, () => {
      text(`크레딧 ${KRW(invoice.credits)}개`, cx0, cy, { size: pt(16), bold: true });
      text(WON(invoice.supplyKrw), cx1, cy, { size: pt(16), align: "right" });
    });
    cy += px(24);
    put(draw, () => rule(cy, cx0, cx1));
    cy += px(20);
    put(draw, () => row("공급가액", WON(invoice.supplyKrw), cy, cx0, cx1));
    cy += px(22 + 10);
    put(draw, () => row("부가세 (10%)", WON(invoice.vatKrw), cy, cx0, cx1));
    cy += px(22 + 14);
    put(draw, () => row("결제 금액", WON(invoice.amountKrw), cy, cx0, cx1, true));
    if (hasBalance) {
      cy += px(26);
      put(draw, () => rule(cy, cx0, cx1));
      cy += px(22);
      put(draw, () => text("크레딧 잔액", cx0, cy, { size: pt(13), muted: true }));
      cy += px(12 + 12);
      put(draw, () => row("충전 후 잔액", `${KRW(Number(invoice.balanceAfter))} 크레딧`, cy, cx0, cx1, true));
      cy += px(12 + 12);
      put(draw, () => text("잔여 크레딧이 모두 소진되면 자동으로 충전됩니다.", cx0, cy, { size: pt(12), muted: true }));
    }
    return cy;
  }) + px(26);

  // ── 꼬리: 발행자 · 문의처 · 법적 문구 ────────────────────────────────────────
  //
  // 원본과 같은 순서·같은 문구다. **법적 문구는 한 글자도 달라선 안 된다** — 메일과 다르면
  // 받는 사람이 어느 쪽이 유효한지 묻게 된다(파리티 테스트가 고정한다).
  const fx = M + px(8);
  if (supplier.name) { text(supplier.name, fx, y, { size: pt(12), bold: true }); y += px(20); }
  const bizLine = [
    supplier.bizNo ? `사업자등록번호 ${supplier.bizNo}` : "",
    supplier.ceoName ? `대표 ${supplier.ceoName}` : "",
  ].filter(Boolean).join("  |  ");
  if (bizLine) { text(bizLine, fx, y, { size: pt(12), muted: true }); y += px(20); }
  if (supplier.address) { text(supplier.address, fx, y, { size: pt(12), muted: true }); y += px(20); }
  y += px(14);
  rule(y, fx, right - px(8));
  y += px(22);
  if (supplier.email) { text(`문의처 ${supplier.email}`, fx, y, { size: pt(13), muted: true }); y += px(24); }
  /**
   * 문단은 **한 덩어리로 두고** jsPDF 가 줄을 나눈다.
   *
   * 손으로 쪼개면 폭이 바뀔 때마다 어긋나고, 무엇보다 **메일과 같은 문장인지 확인할 수
   * 없게 된다** — 파리티 테스트가 문장 전체를 찾는데 소스에 그 문자열이 안 남는다
   * (실제로 쪼갰다가 빨개졌다). 법적 문구라 한 글자도 달라선 안 되는 자리다.
   */
  const paragraph = (s: string) => {
    doc.setFont(FONT, "normal");
    doc.setFontSize(pt(12));
    doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
    for (const line of doc.splitTextToSize(s, W - px(16)) as string[]) {
      doc.text(line, fx, y);
      y += px(20);
    }
  };
  paragraph("본 문서는 결제 내역 확인용입니다. 신용카드 결제분은 카드 매출전표가 적격증빙이며 부가세 매입세액 공제가 가능합니다.");
  paragraph("카드 결제 건에는 세금계산서가 중복 발행되지 않습니다.");

  // 파일명도 영수증 기준 — 메일 제목이 영수증 번호를 쓰므로 대조가 쉬워야 한다.
  doc.save(`${invoice.receiptNumber}.pdf`);
}
