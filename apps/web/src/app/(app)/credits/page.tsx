"use client";

/**
 * 결제 — 잔액·구매·거래·결제 수단·설정. **크레딧 1개 = 분석 1분.**
 *
 * ## 화면 구조 (2026-08-14 · Google AI Studio 결제 화면 구조로 개편)
 * 페이지에는 조용한 카드 4장만 남기고, 행동은 전부 다이얼로그로 옮겼다:
 *   히어로(잔액)      → [크레딧 구매하기]  → 구매 다이얼로그 (프리셋·구매자 정보·결제 2종)
 *   자동 재결제       → (설정 없음 · 상태만) 고정 정책이라 바꿀 것이 없다 — 아래 참조
 *   거래              → [거래 보기]        → 전체 내역 다이얼로그
 *   결제 옵션         → [결제 수단 관리]   → 카드 등록/변경/삭제 + **구매자 정보 입력**
 *   설정              → [설정 관리]        → 구매자 정보(이름·이메일·휴대폰) 다이얼로그
 * 카드 하단의 꽉 찬 알약 버튼(거래 보기·결제 수단 관리·인보이스 보기·설정 관리)이 시그니처다.
 *
 * ## 화면 본문은 디자이너 산출물 이식본이다 (원본 `STEPD_SaaS_UI_V1/src/app/credits/page.tsx` 745줄)
 * 마크업·클래스·문구는 원본 그대로. **다이얼로그 5종은 우리 것을 그대로 쓴다** — 결제
 * 로직(멱등키 보존·409 "확인 중" 분기·저장카드 confirm·닫기 차단)이 거기 들어 있어
 * 마크업만 갈아끼우면 이중 청구가 난다. 모달 이식은 그 로직을 헤드리스로 뽑은 뒤 별건으로.
 *
 * 원본에서 되살린 것 — **이 화면은 목업에서 결제가 통째로 없었다**:
 *  - `크레딧 구매하기` 에 onClick 이 없다. 그대로면 이 제품은 돈을 못 받는다
 *  - `handleSaveEmail` 은 `setIsSaved(true)` 뿐 — 저장했다고 화면만 거짓말한다
 *  - `5,000개`·`₩300,000/₩30,000/₩330,000` 이 화면 상수다 → 서버 정책값으로 만든다
 *  - `자동 재결제: 켜짐` 이 고정이다 → 카드가 없으면 안 도는데 초록으로 보인다
 *  - 구매자 정보 요약이 세 값을 무조건 이어 붙인다 → 휴대폰이 비어도 "채워짐"으로 보였다
 *  - 잔액 0·자동결제 실패·조회 실패·카드 미등록 같은 상태가 하나도 없다
 *
 * ## 자동 재결제는 **고정 정책**이다 (2026-08-26)
 * "잔액이 소진되면 5,000크레딧(₩300,000)을 등록 카드로 자동 결제." 임계·금액·on/off 를
 * 고르는 화면이 없고, 켜짐 여부는 **카드가 등록돼 있는가**에서 파생된다(등록이 곧 동의).
 * 중단하는 유일한 방법은 카드 삭제다. 금액은 서버(credits.ts FIXED_AUTO_TOPUP)가 정본이라
 * 화면은 받아서 보여주기만 한다 — 화면이 자기 숫자를 들면 서버와 다른 금액을 말하게 되고,
 * 돈이 나가는 안내에서 그 불일치는 그대로 결제 분쟁이 된다.
 *
 * ## 구매자 정보(이름·이메일·휴대폰)는 **카드 등록 화면 안에** 있어야 한다
 * 휴대폰번호는 셋 중 유일하게 자동으로 채워지는 경로가 없다(세션에 없다). 예전엔 입력칸이
 * '구매'·'설정' 다이얼로그에만 있고 정작 카드를 등록하는 '결제 수단' 에는 없어서, 400 을
 * 받은 사용자가 **그 화면 안에서 고칠 수 없었다**(2026-08-26 ENA 카드 등록 불가의 실제 원인).
 * 다이얼로그는 한 번에 하나만 열린다 — 필요한 입력은 필요한 자리에 둘 것.
 *
 * ## 결제의 제1규칙 — 화면은 크레딧을 올리지 않는다
 * 결제창이 "성공"을 돌려줘도 크레딧은 서버가 웹훅으로 확정한다(포트원에 직접 조회 →
 * 금액 대조 → 원장 기록). 브라우저 응답만 믿으면 조작 한 번에 공짜가 된다. 그래서 결제 후
 * 화면이 하는 일은 **잔액을 다시 조회하는 것뿐**이고, 아직 안 올라왔으면 "확인 중"이라고 말한다.
 */
import { useCallback, useEffect, useState } from "react";
import { CreditCard, RefreshCw } from "lucide-react";

import { Footer } from "@/components/layout/footer";
import { Header } from "@/components/layout/header";

import { useToast } from "@/components/ui/toast";
import { useSession } from "@/lib/auth";
import {
  createTopupOrder,
  fetchAutoTopup,
  fetchCredits,
  fetchInvoices,
  fetchSavedCard,
  saveBillingNotifyEmails,
  type AutoTopupState,
  type CreditState,
  type InvoiceList,
  type SavedCard,
} from "@/lib/data/api";
import { downloadInvoicePdf } from "@/lib/billing/invoice-pdf";
import { SavedCardChargeButton, SavedCardManager } from "@/components/billing/saved-card";
import { BillingDialog } from "@/components/billing/billing-ui";
import { cn } from "@/lib/utils";

/** 자주 쓰는 충전량. 시간 단위로 생각하는 게 자연스럽다(1크레딧=1분). */
const PRESETS = [
  { credits: 60, label: "1시간" },
  { credits: 300, label: "5시간" },
  { credits: 600, label: "10시간" },
  { credits: 1800, label: "30시간" },
];

const WON = (n: number) => `₩${n.toLocaleString("ko-KR")}`;

/**
 * 자동 결제 정책 문구 — **한 곳에서만 만든다.**
 *
 * 카드 등록 버튼 옆(동의 시점)·히어로·정책 다이얼로그 세 자리에 같은 문장이 떠야 한다.
 * 자리마다 따로 쓰면 한 곳만 고쳐져 "5,000개"와 "₩300,000"이 서로 다른 값을 말하게 되고,
 * 돈이 나가는 안내에서 그 불일치는 그대로 결제 분쟁이 된다.
 * 숫자는 **서버가 준 정책값**으로 만든다(화면 상수 금지 — 서버가 정본).
 */
function autoChargeSentence(policy: { topupCredits: number } | null): string {
  if (!policy?.topupCredits) return "잔액이 소진되면 등록된 카드로 자동 결제됩니다.";
  return `잔액이 소진되면 ${policy.topupCredits.toLocaleString("ko-KR")}개를 자동 결제합니다.`;
}

/**
 * 금액 내역 — **단가는 부가세 별도다**(2026-08-27 확정). 총액 하나만 보여주면 사용자는
 * 그게 공급가액인지 청구액인지 알 수 없고, 카드 명세서 금액과 달라 문의가 된다.
 * 계산식은 서버(credits.ts creditAmounts)와 같아야 한다 — 다르게 반올림하면 안내와 청구가 어긋난다.
 */
function chargeAmounts(credits: number, priceKrw: number | null): { supply: number; vat: number; total: number } | null {
  if (!(credits > 0) || priceKrw == null) return null;
  const supply = credits * priceKrw;
  const vat = Math.round(supply * 0.1);
  return { supply, vat, total: supply + vat };
}

function autoChargeAmounts(
  policy: { topupCredits: number } | null, priceKrw: number | null,
): { supply: number; vat: number; total: number } | null {
  return chargeAmounts(policy?.topupCredits ?? 0, priceKrw);
}

/** 열려 있는 다이얼로그 — 한 번에 하나만. */
type DialogKind = "topup" | "ledger" | "card" | "settings" | "invoices" | null;

const ROLE_KO: Record<string, string> = {
  owner: "소유자", admin: "관리자", member: "구성원", superadmin: "슈퍼관리자",
};

export default function CreditsPage() {
  const { toast } = useToast();
  const session = useSession();
  const actor = session.user.name;
  // 결제수단·결제는 owner/admin 만. 화면에서 숨기는 건 편의고 경계는 서버다(403).
  const canManageBilling =
    session.user.workspaceRole === "owner" ||
    session.user.workspaceRole === "admin" ||
    session.user.workspaceRole === "superadmin";

  const [state, setState] = useState<CreditState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [credits, setCredits] = useState(600);
  // 카드 상태는 셋이 같이 본다 — 구매 다이얼로그의 저장카드 결제 버튼 · 결제수단 다이얼로그
  // (등록·삭제) · 자동충전 게이트. 한 번만 조회해 같은 스냅샷을 나눠 준다(따로 조회하면 어긋난다).
  const [card, setCard] = useState<SavedCard | null>(null);
  const [cardLoadFailed, setCardLoadFailed] = useState(false);
  // 자동 재결제 상태 — **표시 전용**이다(2026-08-26 고정 정책). 켜짐 여부는 카드 등록에서
  // 파생되므로 화면이 바꿀 수 있는 값이 아니고, 금액도 서버가 정본이다.
  const [auto, setAuto] = useState<AutoTopupState | null>(null);
  // **PG 가 구매자 이메일을 필수로 요구한다**(이니시스 V2 일반결제). 세션에 있으면 채우고,
  // 없으면 사람이 입력한다 — 지금은 로그인이 강제되지 않아 세션 이메일이 빌 수 있다.
  const [email, setEmail] = useState("");
  // 이니시스는 휴대폰번호도 필수다. 하이픈은 넣어도 되지만 우리가 지워서 보낸다.
  const [phone, setPhone] = useState("");
  // **이름도 필수다** (PC·모바일 공통). 세션에 있으면 채우되, 없으면 사람이 넣는다 —
  // 세션 이름에만 기대면 로그인 없는 지금 빈 값으로 나가 결제창이 안 뜬다.
  const [buyerName, setBuyerName] = useState("");
  const [busy, setBusy] = useState(false);
  // 저장카드 결제 in-flight — 구매 다이얼로그의 닫기 차단이 일반결제(busy)만 보면
  // 이 경로에서 진행 중 unmount 가 가능해진다 (멱등키가 이중결제는 막지만 피드백이 유실).
  const [cardCharging, setCardCharging] = useState(false);
  const [awaiting, setAwaiting] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogKind>(null);
  // 인보이스 — 결제 완료 건마다 하나. PDF 는 브라우저가 그린다(폰트 로드 때문에 건별 busy).
  const [invoiceList, setInvoiceList] = useState<InvoiceList | null>(null);
  const [invoicesFailed, setInvoicesFailed] = useState(false);
  const [pdfBusy, setPdfBusy] = useState<string | null>(null);
  // 결제 알림 수신자 — saved 는 서버 저장값(입력 중 폴링이 덮지 않게 입력값과 가른다).
  const [notifyInput, setNotifyInput] = useState("");
  const [notifySaved, setNotifySaved] = useState<string[]>([]);
  const [notifyBusy, setNotifyBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await fetchCredits();
      setState(next);
      setNotifySaved((prevSaved) => {
        const list = next.notifyEmails ?? [];
        setNotifyInput((cur) => (cur === prevSaved.join(", ") ? list.join(", ") : cur));
        return list;
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    // 카드 조회 실패가 크레딧 화면을 무너뜨리면 안 된다 — 따로 잡고, 실패 사실만 남긴다.
    try {
      const nextCard = await fetchSavedCard();
      setCard(nextCard);
      setCardLoadFailed(false);
      // **저장된 구매자 정보를 되읽어 채운다** (2026-08-26). 휴대폰번호는 세션에도 없고
      // 어디에도 저장되지 않아 새로고침마다 사라졌다 — 카드가 이미 있는데도 '카드 변경'이
      // 빈 칸에서 시작해 400 으로 막히던 원인. 서버가 정본이고 화면은 되읽기만 한다.
      // **입력 중인 값은 덮지 않는다** — 폴링/재조회가 사용자가 방금 친 글자를 지우면 안 된다.
      const b = nextCard.buyer;
      if (b) {
        if (b.fullName) setBuyerName((cur) => cur.trim() ? cur : b.fullName);
        if (b.email) setEmail((cur) => cur.trim() ? cur : b.email);
        if (b.phoneNumber) setPhone((cur) => cur.trim() ? cur : b.phoneNumber);
      }
    } catch {
      setCard(null);
      setCardLoadFailed(true);
    }
    // 자동충전 정책은 히어로 표시용 — 실패해도 조용히 "—" 로 둔다(편집 화면은 자체 재시도 UI).
    try {
      setAuto(await fetchAutoTopup());
    } catch {
      setAuto(null);
    }
    // 인보이스 실패가 잔액 화면을 무너뜨리면 안 된다 — 실패 사실만 남긴다.
    try {
      setInvoiceList(await fetchInvoices());
      setInvoicesFailed(false);
    } catch {
      setInvoiceList(null);
      setInvoicesFailed(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (session.user.email) setEmail(session.user.email); }, [session.user.email]);
  useEffect(() => { if (session.user.name) setBuyerName(session.user.name); }, [session.user.name]);

  const price = state?.priceKrw ?? null;

  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  const phoneDigits = phone.replace(/\D/g, "");
  // ⚠️ **휴대폰만 허용한다**(유선·대표번호 불가). 서버 검증(billing-card.ts)은 10~11자리만
  // 보므로 02·070 도 통과하지만, 화면은 일부러 더 좁게 잡는다: 빌링키 **결제** 때 이니시스가
  // customer.phoneNumber 를 REQUIRED 로 검사하며 거절한 실측이 있고(2026-08-14 · migration 0037),
  // 유선번호로도 통과하는지는 확인된 바가 없다. 여기서 느슨하게 받으면 "등록은 됐는데
  // 자동 결제만 실패하는 카드" 가 되고 그건 곧 자동배포 정지다 — 등록 단계에서 막는 편이 낫다.
  // 그래서 입력칸·오류 문구도 "휴대폰번호" 라고 분명히 말한다(설명 없는 거절 금지).
  const phoneOk = /^01\d{8,9}$/.test(phoneDigits);
  const nameOk = buyerName.trim().length >= 2;
  // KG이니시스 PC 일반결제 필수 3종: fullName · email · phoneNumber (공식 문서 확인, 2026-08-11).
  // 모바일은 email·phone 이 선택이지만, 어느 기기로 열든 되게 셋 다 받는다.
  const canPay = emailOk && phoneOk && nameOk;

  async function topup() {
    if (busy || credits <= 0 || !canPay) return;
    setBusy(true);
    try {
      // 1) 서버가 주문을 만든다 — paymentId 와 금액이 여기서 확정된다.
      const order = await createTopupOrder(credits, actor);

      // 2) 결제창. SDK 는 브라우저에서만 동작하므로 이 시점에 동적 로드한다.
      const PortOne = await import("@portone/browser-sdk/v2");
      const res = await PortOne.requestPayment({
        storeId: order.storeId,
        channelKey: order.channelKey,
        paymentId: order.paymentId,
        orderName: order.orderName,
        totalAmount: order.amountKrw,
        currency: "CURRENCY_KRW",
        payMethod: "CARD",
        // 이니시스 V2 일반결제는 구매자 이메일이 **필수**다. 빠지면 결제창 호출 자체가 실패한다.
        customer: {
          fullName: buyerName.trim(),
          email: email.trim(),
          phoneNumber: phoneDigits,
        },
      });

      if (res?.code) {
        // 사용자가 닫았거나 PG 가 거절했다. 서버 주문은 pending 으로 남고, 웹훅이 오면
        // 그때 확정된다 — 여기서 실패로 단정하지 않는다.
        toast({ title: "결제가 완료되지 않았습니다", description: res.message ?? res.code, tone: "warn" });
        return;
      }

      // 3) **여기서 크레딧을 올리지 않는다.** 웹훅이 확정한다.
      setAwaiting(order.paymentId);
      toast({
        title: "결제 확인 중",
        description: "결제 승인을 서버가 확인하면 잔액에 반영됩니다. 잠시 걸릴 수 있습니다.",
        tone: "progress",
      });
      // 결제창은 끝났다 — 남은 건 웹훅 확인뿐이라 다이얼로그를 닫는다. 안 닫으면 사용자가
      // 폴링(최대 ~20초) 동안 갇히고, 히어로의 "결제 확인 중…" 태그도 가려져 죽은 UI 가 된다.
      // 폴링은 화면 상태로 계속 돌고, 완료/미반영 토스트가 결과를 알린다.
      setDialog(null);
      await pollUntilCredited(order.paymentId);
    } catch (err) {
      toast({ title: "충전 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  /** 웹훅이 반영될 때까지 잔액을 다시 본다. 못 봐도 실패로 단정하지 않는다. */
  async function pollUntilCredited(paymentId: string) {
    for (let i = 0; i < 10; i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const next = await fetchCredits();
        setState(next);
        if (next.ledger.some((l) => l.paymentId === paymentId)) {
          setAwaiting(null);
          // 사이드바 잔액도 즉시 따라오게 한다.
          window.dispatchEvent(new Event("stepd:credits-changed"));
          toast({ title: "충전 완료", description: `${credits} 크레딧이 들어왔습니다.`, tone: "done" });
          return;
        }
      } catch { /* 다음 회차에 다시 본다 */ }
    }
    // 웹훅이 늦을 수 있다. "실패"라고 말하지 않는다 — 결제는 됐을 수 있다.
    setAwaiting(null);
    toast({
      title: "아직 반영되지 않았습니다",
      description: "결제는 승인됐을 수 있습니다. 잠시 후 새로고침해 보고, 계속 안 보이면 결제 내역과 함께 문의하세요.",
      tone: "warn",
    });
  }

  const close = () => setDialog(null);
  const recent = state?.ledger.slice(0, 5) ?? [];
  const recentInvoices = invoiceList?.invoices.slice(0, 3) ?? [];

  /** 인보이스 한 건 → PDF 다운로드. 첫 호출은 한글 폰트 다운로드가 있어 잠깐 걸린다. */
  async function savePdf(invoiceId: string) {
    if (!invoiceList || pdfBusy) return;
    const invoice = invoiceList.invoices.find((i) => i.id === invoiceId);
    if (!invoice) return;
    setPdfBusy(invoiceId);
    try {
      await downloadInvoicePdf({ invoice, supplier: invoiceList.supplier, buyer: invoiceList.buyer });
    } catch (err) {
      toast({ title: "PDF 생성 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setPdfBusy(null);
    }
  }
  // ⚠️ **완비되지 않은 구매자 정보를 "채워짐" 으로 보여주면 안 된다.** 세션이 이름·이메일을
  // 자동으로 채우므로, 예전 요약은 휴대폰번호가 비어 있어도 "홍길동 · a@b.com" 이라고 떴다 —
  // 사용자는 준비가 끝난 줄 알고 카드 등록을 눌렀다가 400 을 봤다(2026-08-26).
  // 셋이 다 유효할 때만 요약을 보여주고, 아니면 무엇이 빠졌는지 말한다.
  const buyerSummary = canPay
    ? [buyerName.trim(), email.trim(), phoneDigits].join(" · ")
    : `미입력 (${[!nameOk && "이름", !emailOk && "이메일", !phoneOk && "휴대폰번호"].filter(Boolean).join(" · ")} 필요)`;

  /** 결제 알림 수신자 저장 — 쉼표·공백 구분 입력을 목록으로. 빈 입력 = 알림 없음. */
  async function saveNotify() {
    if (notifyBusy) return;
    setNotifyBusy(true);
    try {
      const emails = notifyInput.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
      const r = await saveBillingNotifyEmails(emails);
      setNotifySaved(r.notifyEmails);
      setNotifyInput(r.notifyEmails.join(", "));
      toast({
        title: r.notifyEmails.length ? "알림 수신자 저장됨" : "추가 수신자를 껐습니다",
        description: r.notifyEmails.length
          ? `인보이스·결제 실패 메일을 ${r.notifyEmails.length}명이 받습니다.`
          : "결제창에 입력한 이메일로만 인보이스가 갑니다.",
        tone: "done",
      });
    } catch (err) {
      toast({ title: "저장 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setNotifyBusy(false);
    }
  }

  const notifyDirty = notifyInput.trim() !== notifySaved.join(", ");
  const monthUsage = state?.monthUsage ?? null;
  // 게이지 분모 = 이번달 사용 + 잔액. "이번달 시작 시점 보유분" 근사치 — 목업의 사용/한도 축.
  const gaugeTotal = state && monthUsage != null ? monthUsage + state.balance : null;
  const alert = state?.autoTopupAlert ?? null;

  return (
    <>
      <Header title="크레딧" subtitle="잔액 · 충전 · 사용 내역" />

      {/* Credits Content Main */}
      <main className="flex-1 p-6 flex flex-col justify-between overflow-y-auto space-y-5">
        <div className="space-y-5 max-w-6xl w-full mx-auto">
          {/* Title Label */}
          <h2 className="font-bold text-lg text-[var(--color-text-primary)]">결제</h2>

          {/* ── 상태 배너 — 서비스가 멈춰 있거나 결제가 실패 중이면 맨 위에서 말한다.
              원본에는 없다(항상 정상 상태). rose 는 원본이 이미 쓰는 색이다. ── */}
          {state && state.balance <= 0 && (
            <Banner
              title="크레딧이 소진되어 새 분석이 시작되지 않습니다"
              hint="충전(또는 자동 재결제 복구) 후 다시 시작할 수 있습니다 — 이미 완료된 단계는 보존됩니다."
            />
          )}
          {alert && (
            <Banner title={`자동 결제 실패 — ${alert.message}`} hint={alert.hint} />
          )}
          {error && <Banner title={`크레딧 정보를 불러오지 못했습니다 (${error}).`} />}

          {/* Block 1: 크레딧 잔액 Section Card */}
          <div className="bg-[var(--color-bg-card)] border-none rounded-xl p-5 shadow-md shadow-slate-900/5 dark:shadow-none space-y-4">
            <div className="space-y-1">
              <div className="text-xs text-[var(--color-text-muted)] font-semibold flex items-center gap-2">
                <span>크레딧 잔액</span>
                {/* 결제 승인은 났는데 서버 반영을 기다리는 중 — 원본엔 없는 상태다. */}
                {awaiting && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] bg-amber-500/15 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400 font-bold">
                    결제 확인 중…
                  </span>
                )}
              </div>
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-4xl font-extrabold text-[var(--color-text-primary)]">
                  {state ? state.balance.toLocaleString("ko-KR") : "—"}
                </span>
                {state && (
                  <span className="text-xs text-[var(--color-text-muted)] font-normal">
                    {/* 단가가 미설정이면 환산 금액을 통째로 뺀다 — 지어내지 않는다. */}
                    {price != null ? `≈ ${WON(state.balance * price)} · ` : ""}
                    약 {Math.floor(state.balance / 60)}시간 {state.balance % 60}분 분석 가능
                  </span>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between text-xs py-2.5 border-t border-b border-[var(--color-border-subtle)]/40 font-medium">
              <span className="text-[var(--color-text-muted)]">
                {monthUsage != null ? `이번달 ${monthUsage.toLocaleString("ko-KR")}개 사용` : "이번달 사용량 집계 중"}
              </span>
              <span className="text-[var(--color-text-primary)] font-bold">
                잔액 {state ? state.balance.toLocaleString("ko-KR") : "—"}개
              </span>
            </div>

            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-[var(--color-text-muted)] font-semibold">크레딧 단가</span>
                <span className="text-[var(--color-text-primary)] font-bold">
                  {price != null ? `${WON(price)} / 개 (부가세 별도)` : "단가 미설정"}
                </span>
              </div>

              <div className="flex items-center justify-between pt-1">
                <div className="flex items-center gap-2 text-[var(--color-text-primary)] font-medium">
                  <span className="flex items-center gap-1.5">
                    <CreditCard className="w-4 h-4 text-[var(--color-text-muted)]" />
                    <span>선불</span>
                  </span>
                  <span>·</span>
                  {/* 원본은 초록 '켜짐' 고정이다. 카드가 없으면 자동충전이 안 도는데
                      초록으로 그리면 사용자는 켜져 있다고 믿는다 → 꺼짐은 회색으로. */}
                  <span
                    className={`flex items-center gap-1 font-bold ${
                      auto?.policy.enabled
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-[var(--color-text-muted)]"
                    }`}
                  >
                    <RefreshCw className="w-3.5 h-3.5 stroke-[2.5]" />
                    <span>자동 재결제: {auto ? (auto.policy.enabled ? "켜짐" : "꺼짐") : "—"}</span>
                  </span>
                </div>
                {/* 설정 링크를 두지 않는다 — 고정 정책이라 열어 봐야 바꿀 것이 없다.
                    끄는 유일한 방법(카드 삭제)은 결제 수단 화면에 있으므로 그리로 보낸다. */}
                <button
                  type="button"
                  onClick={() => setDialog("card")}
                  className="text-xs font-bold text-[#1C60FF] hover:underline cursor-pointer"
                >
                  결제 수단 관리
                </button>
              </div>

              <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed pt-2">
                {state?.unit ?? "크레딧 1개 = 분석 1분"} · 선불 결제이며, 승인 후 서버 확인이 끝나야 잔액에 반영됩니다. 크레딧은 분석에 쓰인 분과 배포한 영상×채널만큼 차감됩니다 (배포 실패 시 되돌려 드립니다).
              </p>
            </div>

            <div className="pt-2">
              {/* ⚠️ 원본 버튼에는 onClick 이 **없다** — 그대로 옮기면 이 제품은 돈을 못 받는다. */}
              <button
                type="button"
                onClick={() => setDialog("topup")}
                className="w-full h-10 rounded-full bg-[var(--color-bg-active)] hover:bg-[#0D1EB8] text-white text-xs font-bold transition-colors cursor-pointer shadow-md shadow-slate-900/5 dark:shadow-none flex items-center justify-center gap-1.5"
              >
                <CreditCard className="w-4 h-4" />
                <span>크레딧 구매하기</span>
              </button>
            </div>
          </div>

          {/* Block 2: 자동 재결제 Section Card ─────────────────────────────────
              자동 결제는 **고정 정책**이다(2026-08-26) — 켜고 끄는 토글도, 금액·임계 설정도
              없다. "카드가 등록돼 있으면 소진 시 자동 결제, 없으면 안 함" 이 전부라, 이 카드는
              설정 장치가 아니라 지금 상태를 사실대로 말하는 자리다. */}
          <div className="bg-[var(--color-bg-card)] border-none rounded-xl p-5 shadow-md shadow-slate-900/5 dark:shadow-none space-y-4">
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-base text-[var(--color-text-primary)]">자동 재결제</h3>
              <span
                className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold ${
                  auto?.policy.enabled
                    ? "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400"
                    : "bg-slate-200/80 text-slate-600 dark:bg-[#282B35] dark:text-slate-300"
                }`}
              >
                {auto ? (auto.policy.enabled ? "켜짐" : "꺼짐") : "…"}
              </span>
            </div>

            <div className="space-y-1 text-xs">
              {/* 숫자는 **서버 정책값**으로 만든다 — 화면 상수(5,000개·₩330,000)를 박으면
                  서버가 바뀔 때 틀린 금액으로 동의를 받는다. */}
              <div className="font-bold text-[var(--color-text-primary)]">
                {auto ? autoChargeSentence(auto.policy) : "정책을 불러오는 중…"}
              </div>
              {(() => {
                const a = autoChargeAmounts(auto?.policy ?? null, price);
                return a ? (
                  <div>
                    <span className="text-[var(--color-text-muted)] font-medium">
                      공급가액 {WON(a.supply)} · 부가세 {WON(a.vat)} ·{" "}
                    </span>
                    <span className="text-[var(--color-text-primary)] font-bold">결제 금액 {WON(a.total)}</span>
                  </div>
                ) : null;
              })()}
              {/* 꺼져 있으면 **왜** 꺼져 있는지 + 무엇을 하면 켜지는지. 조용한 "꺼짐" 은 정보가 아니다. */}
              {auto && !auto.policy.enabled && (
                <div className="text-amber-600 dark:text-amber-400 font-medium">
                  {auto.disabledReason ?? "등록된 카드가 없습니다."} 카드를 등록하면 자동으로 켜집니다 — 잔액이 0이 되어도 분석·자동배포가 멈추지 않습니다.
                </div>
              )}
              <div className="text-[var(--color-text-muted)] pt-0.5">
                결제 시점은 잔액이 소진되는 순간입니다. 중단하려면 결제 수단(카드)을 삭제하면 됩니다.
              </div>
            </div>

            <div className="pt-2 space-y-2">
              <div>
                <label className="text-sm font-bold text-[var(--color-text-primary)] block mb-1">
                  결제 알림 이메일
                </label>
                <div className="text-xs text-[var(--color-text-muted)] mb-2">
                  인보이스(결제 완료)와 자동 결제 실패 알림을 받을 담당자 — 쉼표로 여러 명(최대 5명).
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={notifyInput}
                    placeholder="media-ops@company.com, cp@company.com"
                    onChange={(e) => setNotifyInput(e.target.value)}
                    aria-label="결제 알림 이메일"
                    disabled={!canManageBilling}
                    className="flex-1 h-10 px-4 rounded-full bg-[var(--color-bg-input)] border border-[var(--color-border-subtle)] focus:border-[#1C60FF] text-xs font-normal text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none transition-colors shadow-none disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                  {/* ⚠️ 원본 handleSaveEmail 은 setIsSaved(true) 뿐이다 — 저장했다고 화면만
                      거짓말한다. 실제 저장은 서버가 형식·최대 5명을 검사한다. */}
                  <button
                    type="button"
                    onClick={() => void saveNotify()}
                    disabled={notifyBusy || !notifyDirty || !canManageBilling}
                    className={`h-10 px-5 rounded-full text-xs font-bold transition-colors cursor-pointer border shrink-0 disabled:cursor-not-allowed ${
                      !notifyDirty
                        ? "bg-[var(--color-bg-input)] border-[var(--color-border-subtle)] text-[var(--color-text-primary)]"
                        : "bg-[var(--color-bg-active)] hover:bg-[#0D1EB8] text-white border-transparent"
                    }`}
                  >
                    {notifyBusy ? "저장 중…" : notifyDirty ? "저장" : "저장됨"}
                  </button>
                </div>
                {notifySaved.length > 0 && (
                  <div className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
                    {notifySaved.length}명이 결제 알림 메일을 받고 있습니다.
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Block 3: Lower 2x2 Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Card 3: 거래 */}
            <div className="bg-[var(--color-bg-card)] border-none rounded-xl p-5 shadow-md shadow-slate-900/5 dark:shadow-none flex flex-col justify-between space-y-4">
              <div className="space-y-3">
                <h3 className="font-bold text-base text-[var(--color-text-primary)]">거래</h3>
                {!state ? (
                  <p className="text-xs text-[var(--color-text-muted)]">불러오는 중…</p>
                ) : recent.length === 0 ? (
                  <p className="text-xs text-[var(--color-text-muted)]">아직 거래가 없습니다.</p>
                ) : (
                  <div className="divide-y divide-[var(--color-border-subtle)]/40 text-xs font-mono">
                    {recent.map((l) => (
                      <div key={l.id} className="py-2.5 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 text-[var(--color-text-muted)] min-w-0">
                          <span className="shrink-0">{l.occurredAt?.slice(5, 16).replace("T", " ")}</span>
                          <span className="font-sans font-medium text-[var(--color-text-primary)] truncate">
                            {reasonLabel(l.reason)}
                          </span>
                        </div>
                        <span
                          className={`font-bold shrink-0 ${
                            l.delta >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-500"
                          }`}
                        >
                          {l.delta >= 0 ? "+" : ""}{l.delta.toLocaleString("ko-KR")}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() => setDialog("ledger")}
                disabled={!state}
                className="w-full h-9 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-[#1C60FF] text-xs font-bold transition-colors cursor-pointer border border-[var(--color-border-subtle)] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                거래 보기
              </button>
            </div>

            {/* Card 4: 결제 옵션 */}
            <div className="bg-[var(--color-bg-card)] border-none rounded-xl p-5 shadow-md shadow-slate-900/5 dark:shadow-none flex flex-col justify-between space-y-4">
              <div className="space-y-3">
                <h3 className="font-bold text-base text-[var(--color-text-primary)]">결제 옵션</h3>
                <div className="space-y-3 text-xs">
                  {cardLoadFailed ? (
                    <div className="text-[var(--color-text-muted)]">
                      결제수단 정보를 불러오지 못했습니다.{" "}
                      <button type="button" className="underline cursor-pointer" onClick={() => void load()}>
                        다시 시도
                      </button>
                    </div>
                  ) : !card ? (
                    <div className="text-[var(--color-text-muted)]">불러오는 중…</div>
                  ) : (
                    <>
                      <div className="font-semibold text-[var(--color-text-primary)]">
                        저장된 결제 수단이 {card.registered ? 1 : 0}개 있습니다.
                      </div>
                      {card.registered ? (
                        <div className="p-3.5 rounded-xl bg-[var(--color-bg-input)]/70 border border-[var(--color-border-subtle)] font-mono text-[var(--color-text-muted)] font-bold flex items-center justify-between">
                          <span className="text-[var(--color-text-primary)]">{card.brand || "카드"}</span>
                          <span>····  ····  ····  {card.last4 || "····"}</span>
                        </div>
                      ) : (
                        <div className="text-[var(--color-text-muted)]">
                          카드를 등록해 두면 결제창 없이 버튼 한 번으로 충전합니다.
                        </div>
                      )}
                      {!card.available && (
                        <div className="text-[var(--color-text-muted)]">
                          카드 저장이 아직 준비되지 않았습니다. {card.unavailableReason ?? ""}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>

              <button
                type="button"
                onClick={() => setDialog("card")}
                className="w-full h-9 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-[#1C60FF] text-xs font-bold transition-colors cursor-pointer border border-[var(--color-border-subtle)]"
              >
                결제 수단 관리
              </button>
            </div>

            {/* Card 5: 인보이스 */}
            <div className="bg-[var(--color-bg-card)] border-none rounded-xl p-5 shadow-md shadow-slate-900/5 dark:shadow-none flex flex-col justify-between space-y-4">
              <div className="space-y-3">
                <h3 className="font-bold text-base text-[var(--color-text-primary)]">인보이스</h3>
                {invoicesFailed ? (
                  <p className="text-xs text-[var(--color-text-muted)]">
                    인보이스를 불러오지 못했습니다.{" "}
                    <button type="button" className="underline cursor-pointer" onClick={() => void load()}>
                      다시 시도
                    </button>
                  </p>
                ) : !invoiceList ? (
                  <p className="text-xs text-[var(--color-text-muted)]">불러오는 중…</p>
                ) : invoiceList.invoices.length === 0 ? (
                  <p className="text-xs text-[var(--color-text-muted)]">
                    아직 결제된 내역이 없습니다 — 결제가 완료되면 건마다 인보이스가 쌓이고 PDF 로 받을 수 있습니다.
                  </p>
                ) : (
                  <div className="divide-y divide-[var(--color-border-subtle)]/40 text-xs font-mono">
                    {recentInvoices.map((inv) => (
                      <div key={inv.id} className="py-2.5 flex items-center justify-between gap-2">
                        <span className="text-[var(--color-text-muted)] shrink-0">{inv.paidAt.slice(0, 10)}</span>
                        <span className="text-[var(--color-text-primary)] font-bold truncate">{inv.number}</span>
                        <span className="font-bold text-[var(--color-text-primary)] shrink-0">
                          {WON(inv.amountKrw)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() => setDialog("invoices")}
                disabled={!invoiceList || invoiceList.invoices.length === 0}
                className="w-full h-9 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-[#1C60FF] text-xs font-bold transition-colors cursor-pointer border border-[var(--color-border-subtle)] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                인보이스 보기
              </button>
            </div>

            {/* Card 6: 설정 */}
            <div className="bg-[var(--color-bg-card)] border-none rounded-xl p-5 shadow-md shadow-slate-900/5 dark:shadow-none flex flex-col justify-between space-y-4">
              <div className="space-y-3">
                <h3 className="font-bold text-base text-[var(--color-text-primary)]">설정</h3>
                <div className="space-y-2.5 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-[var(--color-text-muted)] font-medium">워크스페이스</span>
                    {/* 세션에 워크스페이스 이름이 없다(계정·역할만 온다) — 있는 것을 정직하게. */}
                    <span className="font-bold text-[var(--color-text-primary)]">
                      {session.user.name
                        ? `${session.user.name}${session.user.workspaceRole ? ` · ${ROLE_KO[session.user.workspaceRole] ?? session.user.workspaceRole}` : ""}`
                        : "—"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[var(--color-text-muted)] font-medium">크레딧 단가</span>
                    <span className="font-bold text-[var(--color-text-primary)]">
                      {price != null ? `${WON(price)} · 부가세 별도` : "단가 미설정"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-[var(--color-text-muted)] font-medium shrink-0">구매자 정보</span>
                    {/* ⚠️ 원본은 세 값을 무조건 이어 붙인다. 세션이 이름·이메일을 자동으로 채워
                        휴대폰번호가 비어도 "채워짐"으로 보였고, 사용자는 준비된 줄 알고 등록을
                        눌렀다가 400 을 받았다(2026-08-26 ENA). buyerSummary 는 무엇이 빠졌는지 말한다. */}
                    <span className="font-bold text-[var(--color-text-primary)] text-right">{buyerSummary}</span>
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setDialog("settings")}
                className="w-full h-9 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-[#1C60FF] text-xs font-bold transition-colors cursor-pointer border border-[var(--color-border-subtle)]"
              >
                설정 관리
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <Footer />
      </main>

      {/* ══ 다이얼로그들 ══════════════════════════════════════════════════════ */}

      {/* 크레딧 구매 — 프리셋·수량·구매자 3필드·결제 2종. 결제 진행 중엔 닫기를 막는다. */}
      {dialog === "topup" && (
        <BillingDialog
          title="크레딧 구매"
          subtitle="크레딧 1개 = 분석 1분 · 선불 · 승인 후 서버 확인이 끝나야 잔액에 반영됩니다."
          onClose={close}
          // 저장카드 결제도 in-flight 동안 닫히면 안 된다 — 진행 피드백이 사라진다.
          closeDisabled={busy || cardCharging}
          footer={
            price != null ? (
              <>
                <button
                  type="button"
                  className="sd-btn sd-btn-primary"
                  disabled={busy || credits <= 0 || !canPay}
                  title={canPay ? undefined : "KG이니시스는 이름·이메일·휴대폰번호가 모두 필요합니다"}
                  onClick={topup}
                >
                  {busy ? "진행 중…" : `결제창으로 ${WON(chargeAmounts(credits, price)?.total ?? credits * price)} 결제`}
                </button>
                <SavedCardChargeButton
                  card={card}
                  canManage={canManageBilling}
                  credits={credits}
                  // **실제 청구액**을 넘긴다 — 저장카드는 결제창이 없어서 이 버튼 라벨과
                  // confirm 이 유일한 금액 확인 관문이다. 공급가액을 넘기면 사용자가 본
                  // 금액과 카드에 긁히는 금액이 다르다(부가세 별도 · 2026-08-27).
                  amountKrw={chargeAmounts(credits, price)?.total ?? 0}
                  onCharged={load}
                  onBusyChange={setCardCharging}
                  // 구 카드(구매자 정보 미저장) 폴백 — 화면의 구매자 입력값으로 결제하고
                  // 서버가 성공 시 카드에 백필한다.
                  buyer={{ fullName: buyerName.trim(), email: email.trim(), phoneNumber: phoneDigits }}
                />
              </>
            ) : undefined
          }
        >
          {price == null ? (
            <p className="text-[11.5px]" style={{ color: "var(--sd-warn)" }}>
              크레딧 단가가 설정되지 않아 결제를 시작할 수 없습니다 (서버 <code>CREDIT_PRICE_KRW</code>).
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-[3px]">
                {PRESETS.map((p) => (
                  <button
                    key={p.credits}
                    type="button"
                    className={cn("sd-btn", credits === p.credits && "sd-btn--on")}
                    onClick={() => setCredits(p.credits)}
                  >
                    {p.label}
                    <span className="sd-mono ml-1.5 text-[10.5px]" style={{ opacity: 0.7 }}>
                      {p.credits}
                    </span>
                  </button>
                ))}
              </div>

              {/* 수량 + 금액 — 아래 결제 버튼 두 개가 모두 이 금액을 긁는다. */}
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={credits}
                  onChange={(e) => setCredits(Number(e.target.value.replace(/\D/g, "")) || 0)}
                  inputMode="numeric"
                  className="sd-input w-[120px]"
                  aria-label="충전할 크레딧"
                />
                <span className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>크레딧</span>
                {/* 큰 숫자는 **실제로 긁히는 금액**이어야 한다 — 단가가 부가세 별도라
                    `크레딧 × 단가` 는 공급가액일 뿐이다(2026-08-27). 그 숫자를 버튼에
                    띄우면 카드 명세서와 달라 문의가 된다. 내역은 바로 옆에 적는다. */}
                <span className="sd-mono text-[15px]" style={{ color: "var(--sd-fg)" }}>
                  {WON(chargeAmounts(credits, price)?.total ?? 0)}
                </span>
                <span className="text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                  (크레딧당 {WON(price)} · 부가세 별도 — 공급가액{" "}
                  {WON(chargeAmounts(credits, price)?.supply ?? 0)} + 부가세{" "}
                  {WON(chargeAmounts(credits, price)?.vat ?? 0)})
                </span>
              </div>

              {/* 구매자 정보 — PG(KG이니시스) 필수 3종. 설정 다이얼로그와 같은 값을 편집한다. */}
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={buyerName}
                  onChange={(e) => setBuyerName(e.target.value)}
                  placeholder="구매자 이름 (필수)"
                  className="sd-input w-[140px]"
                  aria-label="구매자 이름"
                />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="영수증 받을 이메일 (필수)"
                  className="sd-input min-w-[200px] flex-1"
                  aria-label="구매자 이메일"
                />
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="휴대폰번호 (필수)"
                  className="sd-input w-[160px]"
                  aria-label="구매자 휴대폰번호"
                />
              </div>
              {/* PG 가 요구하는 항목이라 여기서 막는다 — 결제창까지 가서 알게 하지 않는다. */}
              {(buyerName || email || phone) && !canPay && (
                <p className="text-[10.5px]" style={{ color: "var(--sd-danger-strong)" }}>
                  {!nameOk
                    ? "구매자 이름을 입력하세요."
                    : !emailOk
                      ? "이메일 형식을 확인하세요."
                      : "휴대폰번호를 확인하세요 — 010으로 시작하는 휴대폰만 등록됩니다 (예: 01012345678)."}
                </p>
              )}

              <p
                className="text-[11px]"
                style={{ color: "var(--sd-mut)" }}
                title="결제 승인 후 서버가 포트원 웹훅으로 확인을 마쳐야 잔액에 반영됩니다 — 결제창이 닫힌 직후에는 바로 보이지 않을 수 있습니다."
              >
                승인 후 서버 확인이 끝나야 잔액에 반영됩니다 · 크레딧은 분석에 쓰인 분과 배포한 영상×채널만큼 차감됩니다.
              </p>
            </>
          )}
        </BillingDialog>
      )}

      {/* 거래 전체 내역 — 서버가 주는 최근 50건 그대로. */}
      {dialog === "ledger" && (
        <BillingDialog title="크레딧 내역" subtitle="최근 거래 목록입니다." onClose={close} maxWidth={640}>
          {!state || state.ledger.length === 0 ? (
            <div
              className="sd-ph grid min-h-[100px] place-items-center rounded-[6px] px-6 text-center"
              style={{ border: "1px dashed var(--sd-border)" }}
            >
              {state ? "아직 내역이 없습니다" : "불러오는 중…"}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {state.ledger.map((l) => (
                <div
                  key={l.id}
                  className="flex flex-wrap items-center gap-3 rounded-[4px] px-2 py-1.5"
                  style={{ border: "1px solid var(--sd-border)" }}
                >
                  <span className="sd-mono w-[108px] shrink-0 text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                    {l.occurredAt?.slice(0, 16).replace("T", " ")}
                  </span>
                  <span className="min-w-[160px] flex-1 truncate text-[11.5px]" style={{ color: "var(--sd-fg)" }}>
                    {reasonLabel(l.reason)}
                    {l.note ? ` · ${l.note}` : ""}
                  </span>
                  {/* 금액·크레딧은 항상 같은 폭의 칸에 우측 정렬 — 조건부로 빼면 줄마다 컬럼이 어긋난다. */}
                  <span className="sd-mono w-[88px] shrink-0 text-right text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                    {l.amountKrw != null ? WON(l.amountKrw) : ""}
                  </span>
                  <span
                    className="sd-mono w-[56px] shrink-0 text-right text-[12.5px]"
                    style={{ color: l.delta >= 0 ? "var(--sd-ok)" : "var(--sd-fg)" }}
                  >
                    {l.delta >= 0 ? "+" : ""}{l.delta.toLocaleString("ko-KR")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </BillingDialog>
      )}

      {/* 결제 수단 관리 — 카드 등록/변경/삭제 (SavedCardManager 재사용). */}
      {dialog === "card" && (
        <BillingDialog
          title="결제 수단"
          subtitle="카드 번호는 포트원으로 직접 전달되며 우리 서버에는 저장되지 않습니다."
          onClose={close}
        >
          {/* ⚠️ **구매자 정보는 이 화면 안에 있어야 한다.**
              예전엔 이 입력칸이 '구매'·'설정' 다이얼로그에만 있고 여기엔 없었다. 다이얼로그는
              한 번에 하나만 열리므로, 카드 등록을 누른 사람은 "휴대폰번호가 필요합니다" 라는
              400 만 보고 **그 화면 안에서 고칠 방법이 없었다**(2026-08-26 ENA 실측 · 카드
              등록 불가의 실제 원인). 카드사가 요구하는 값이라 등록 직전에 확인시키는 게 맞다. */}
          {canManageBilling && (
            <div className="mb-3 flex flex-col gap-2">
              <div>
                <div className="text-[11.5px] font-medium" style={{ color: "var(--sd-label)" }}>
                  구매자 정보
                </div>
                <p className="mt-0.5 text-[11px]" style={{ color: "var(--sd-mut)" }}>
                  카드사(KG이니시스)가 결제할 때마다 요구하는 값입니다 — 카드와 함께 저장되어
                  다음부터는 다시 입력하지 않습니다.
                </p>
              </div>
              <input
                value={buyerName}
                onChange={(e) => setBuyerName(e.target.value)}
                placeholder="구매자 이름 (필수)"
                className="sd-input w-full"
                aria-label="구매자 이름"
              />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="영수증 받을 이메일 (필수)"
                className="sd-input w-full"
                aria-label="구매자 이메일"
              />
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="휴대폰번호 (필수 · 01012345678)"
                className="sd-input w-full"
                aria-label="구매자 휴대폰번호"
              />
              {/* 어느 칸이 왜 막는지 **누르기 전에** 말한다 — 400 토스트로 알게 하지 않는다. */}
              {!canPay && (
                <p className="text-[10.5px]" style={{ color: "var(--sd-danger-strong)" }}>
                  {!nameOk
                    ? "구매자 이름을 입력하세요."
                    : !emailOk
                      ? "이메일 형식을 확인하세요."
                      : "휴대폰번호를 확인하세요 — 010으로 시작하는 휴대폰만 등록됩니다 (예: 01012345678)."}
                </p>
              )}
              {/* ⚠️ **동의 시점의 고지.** 자동 재결제는 고정 정책이라 등록하는 순간 켜진다 —
                  그 사실을 등록 버튼 바로 위에서 말하지 않으면 "언제 300,000원이 나갔지" 가 된다. */}
              <p
                className="rounded-[4px] px-2.5 py-2 text-[11px]"
                style={{ border: "1px solid var(--sd-border)", background: "var(--sd-subtle, rgba(127,127,127,.06))", color: "var(--sd-fg)" }}
              >
                {/* **동의 시점의 고지** — 금액을 총액 하나로만 말하면 안 된다. 단가가
                    부가세 별도라, 공급가액만 보여주면 카드 명세서 금액과 달라진다. */}
                카드를 등록하면 <b>{autoChargeSentence(auto?.policy ?? null)}</b>
                {(() => {
                  const a = autoChargeAmounts(auto?.policy ?? null, price);
                  return a ? (
                    <><br />공급가액 {WON(a.supply)} · 부가세 {WON(a.vat)} · <b>결제 금액 {WON(a.total)}</b></>
                  ) : null;
                })()}
                <br />중단하려면 이 화면에서 카드를 삭제하면 됩니다.
              </p>
            </div>
          )}
          <SavedCardManager
            canManage={canManageBilling}
            buyer={{ fullName: buyerName.trim(), email: email.trim(), phoneNumber: phoneDigits }}
            buyerReady={canPay}
            card={card}
            loadFailed={cardLoadFailed}
            onReload={load}
          />
        </BillingDialog>
      )}

      {/* 설정 — 구매자 정보(PG 필수 3종) 편집. 구매 다이얼로그와 같은 상태를 본다. */}
      {dialog === "settings" && (
        <BillingDialog
          title="설정"
          subtitle="구매자 정보는 결제창(KG이니시스)이 필수로 요구하는 항목입니다."
          onClose={close}
          maxWidth={440}
          footer={
            <button type="button" className="sd-btn sd-btn-primary ml-auto" onClick={close}>
              완료
            </button>
          }
        >
          <SettingField label="구매자 이름">
            <input
              value={buyerName}
              onChange={(e) => setBuyerName(e.target.value)}
              placeholder="구매자 이름 (필수)"
              className="sd-input w-full"
              aria-label="구매자 이름"
            />
          </SettingField>
          <SettingField label="영수증 받을 이메일">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="영수증 받을 이메일 (필수)"
              className="sd-input w-full"
              aria-label="구매자 이메일"
            />
          </SettingField>
          <SettingField label="휴대폰번호">
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="휴대폰번호 (필수)"
              className="sd-input w-full"
              aria-label="구매자 휴대폰번호"
            />
          </SettingField>
          {(buyerName || email || phone) && !canPay && (
            <p className="text-[10.5px]" style={{ color: "var(--sd-danger-strong)" }}>
              {!nameOk
                ? "구매자 이름을 입력하세요."
                : !emailOk
                  ? "이메일 형식을 확인하세요."
                  : "휴대폰번호를 확인하세요 — 010으로 시작하는 휴대폰만 등록됩니다 (예: 01012345678)."}
            </p>
          )}
          <p className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
            크레딧 단가: {price != null ? `${WON(price)} · 부가세 별도` : "미설정"} — 단가는 서버 설정
            (<code>CREDIT_PRICE_KRW</code>)이라 여기서 바꿀 수 없습니다.
          </p>
        </BillingDialog>
      )}

      {/* 인보이스 — 결제 완료 건 전체. 건마다 PDF 다운로드(한글 폰트 임베드라 첫 건은 잠깐 걸린다). */}
      {dialog === "invoices" && (
        <BillingDialog
          title="인보이스"
          subtitle="결제 완료된 충전 건마다 발급됩니다 · 세금계산서가 아닌 결제 내역 확인용 문서입니다."
          onClose={close}
          maxWidth={640}
        >
          {!invoiceList || invoiceList.invoices.length === 0 ? (
            <div
              className="sd-ph grid min-h-[100px] place-items-center rounded-[6px] px-6 text-center"
              style={{ border: "1px dashed var(--sd-border)" }}
            >
              아직 결제된 내역이 없습니다
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {invoiceList.invoices.map((inv) => (
                <div
                  key={inv.id}
                  className="flex flex-wrap items-center gap-3 rounded-[4px] px-2 py-1.5"
                  style={{ border: "1px solid var(--sd-border)" }}
                >
                  <span className="sd-mono w-[76px] shrink-0 text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                    {inv.paidAt.slice(0, 10)}
                  </span>
                  <span className="sd-mono w-[150px] shrink-0 truncate text-[11px]" style={{ color: "var(--sd-fg)" }} title={inv.number}>
                    {inv.number}
                  </span>
                  <span className="min-w-[120px] flex-1 truncate text-[11.5px]" style={{ color: "var(--sd-fg)" }}>
                    {inv.description}
                    {inv.origin === "auto" ? " · 자동 충전" : ""}
                  </span>
                  <span className="sd-mono w-[80px] shrink-0 text-right text-[11.5px]" style={{ color: "var(--sd-fg)" }}>
                    {WON(inv.amountKrw)}
                  </span>
                  <button
                    type="button"
                    className="sd-btn shrink-0"
                    disabled={pdfBusy !== null}
                    onClick={() => void savePdf(inv.id)}
                  >
                    {pdfBusy === inv.id ? "생성 중…" : "PDF"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </BillingDialog>
      )}
    </>
  );
}

/**
 * 상태 배너 — 원본에는 없는 자리다(항상 정상 상태를 그린다).
 * rose 는 원본이 모달의 필수 표시(`text-rose-500`)에서 이미 쓰는 색이라 새 색이 아니다.
 */
function Banner({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs">
      <div className="font-bold text-rose-600 dark:text-rose-400">{title}</div>
      {hint && <div className="mt-0.5 text-rose-600/80 dark:text-rose-400/80 font-medium">{hint}</div>}
    </div>
  );
}


function SettingField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10.5px] font-medium" style={{ color: "var(--sd-mut)" }}>{label}</div>
      {children}
    </div>
  );
}

function reasonLabel(reason: string): string {
  return {
    topup: "충전", usage: "분석 사용", grant: "무상 지급",
    adjust: "정정", refund: "환불",
  }[reason] ?? reason;
}
