"use client";

/**
 * 결제 — 잔액·구매·거래·결제 수단·설정. **크레딧 1개 = 분석 1분.**
 *
 * ## 화면 구조 (2026-08-14 · Google AI Studio 결제 화면 구조로 개편)
 * 페이지에는 조용한 카드 4장만 남기고, 행동은 전부 다이얼로그로 옮겼다:
 *   히어로(잔액)      → [크레딧 구매하기]  → 구매 다이얼로그 (프리셋·구매자 정보·결제 2종)
 *                     → "자동 충전 설정"   → 자동 충전 다이얼로그 (AutoTopupManager)
 *   거래              → [거래 보기]        → 전체 내역 다이얼로그
 *   결제 옵션         → [결제 수단 관리]   → 카드 등록/변경/삭제 다이얼로그 (SavedCardManager)
 *   설정              → [설정 관리]        → 구매자 정보(이름·이메일·휴대폰) 다이얼로그
 * 카드 하단의 "border-top + 중앙 정렬 + 액센트 텍스트"(CardAction)가 이 디자인의 시그니처다.
 *
 * ## 결제의 제1규칙 — 화면은 크레딧을 올리지 않는다
 * 결제창이 "성공"을 돌려줘도 크레딧은 서버가 웹훅으로 확정한다(포트원에 직접 조회 →
 * 금액 대조 → 원장 기록). 브라우저 응답만 믿으면 조작 한 번에 공짜가 된다. 그래서 결제 후
 * 화면이 하는 일은 **잔액을 다시 조회하는 것뿐**이고, 아직 안 올라왔으면 "확인 중"이라고 말한다.
 */
import { useCallback, useEffect, useState } from "react";
import { CreditCard, Zap } from "lucide-react";

import { useToast } from "@/components/ui/toast";
import { useSession } from "@/lib/auth";
import {
  createTopupOrder,
  fetchAutoTopup,
  fetchCredits,
  fetchInvoices,
  fetchSavedCard,
  saveBillingNotifyEmails,
  type AutoTopupPolicy,
  type CreditState,
  type InvoiceList,
  type SavedCard,
} from "@/lib/data/api";
import { downloadInvoicePdf } from "@/lib/billing/invoice-pdf";
import { SavedCardChargeButton, SavedCardManager } from "@/components/billing/saved-card";
import { AutoTopupManager } from "@/components/billing/auto-topup";
import { BillingCard, BillingDialog, CardAction } from "@/components/billing/billing-ui";
import { cn } from "@/lib/utils";

/** 자주 쓰는 충전량. 시간 단위로 생각하는 게 자연스럽다(1크레딧=1분). */
const PRESETS = [
  { credits: 60, label: "1시간" },
  { credits: 300, label: "5시간" },
  { credits: 600, label: "10시간" },
  { credits: 1800, label: "30시간" },
];

const WON = (n: number) => `₩${n.toLocaleString("ko-KR")}`;

/** 열려 있는 다이얼로그 — 한 번에 하나만. */
type DialogKind = "topup" | "ledger" | "card" | "autotopup" | "settings" | "invoices" | null;

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
  // 히어로의 "자동 충전: 켜짐/사용 중지" 표시용. 편집·저장은 자동충전 다이얼로그(Manager)가
  // 자기 스냅샷으로 하고, 저장 성공 시 onPolicySaved 로 여기에도 반영한다.
  const [policy, setPolicy] = useState<AutoTopupPolicy | null>(null);
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
      setCard(await fetchSavedCard());
      setCardLoadFailed(false);
    } catch {
      setCard(null);
      setCardLoadFailed(true);
    }
    // 자동충전 정책은 히어로 표시용 — 실패해도 조용히 "—" 로 둔다(편집 화면은 자체 재시도 UI).
    try {
      setPolicy(await fetchAutoTopup());
    } catch {
      setPolicy(null);
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
  const buyerSummary = [buyerName.trim(), email.trim(), phoneDigits].filter(Boolean).join(" · ");

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
    <div className="mx-auto flex max-w-[900px] flex-col gap-[14px]">
      <h2 className="sd-serif text-[16px] font-semibold" style={{ color: "var(--sd-fg)" }}>결제</h2>

      {/* ── 상태 배너 — 서비스가 멈춰 있거나 결제가 실패 중이면 맨 위에서 말한다 ── */}
      {state && state.balance <= 0 && (
        <div
          className="flex items-center gap-2.5 rounded-[6px] px-3.5 py-2.5"
          style={{ border: "1px solid var(--sd-danger-border)", background: "var(--sd-danger-bg)" }}
        >
          <span
            className="grid h-[20px] w-[20px] shrink-0 place-items-center rounded-full text-[12px] font-extrabold"
            style={{ background: "var(--sd-danger-strong)", color: "var(--sd-on-danger)" }}
          >!</span>
          <div className="text-[12px] font-semibold" style={{ color: "var(--sd-danger-strong)" }}>
            크레딧이 소진되어 새 분석이 시작되지 않습니다
            <span className="block text-[11px] font-normal" style={{ color: "var(--sd-danger-strong)", opacity: 0.85 }}>
              충전(또는 자동 재결제 복구) 후 다시 시작할 수 있습니다 — 이미 완료된 단계는 보존됩니다.
            </span>
          </div>
        </div>
      )}
      {alert && (
        <div
          className="flex items-center gap-2.5 rounded-[6px] px-3.5 py-2.5"
          style={{ border: "1px solid var(--sd-danger-border)", background: "var(--sd-danger-bg)" }}
        >
          <span
            className="grid h-[20px] w-[20px] shrink-0 place-items-center rounded-full text-[12px] font-extrabold"
            style={{ background: "var(--sd-danger-strong)", color: "var(--sd-on-danger)" }}
          >!</span>
          <div className="text-[12px] font-semibold" style={{ color: "var(--sd-danger-strong)" }}>
            자동 결제 실패 — {alert.message}
            {alert.hint && (
              <span className="block text-[11px] font-normal" style={{ color: "var(--sd-danger-strong)", opacity: 0.85 }}>
                {alert.hint}
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── 히어로 — 잔액 + 구매 진입점 ─────────────────────────────────────── */}
      <BillingCard
        action={<CardAction label="크레딧 구매하기" onClick={() => setDialog("topup")} />}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="sd-eb" style={{ color: "var(--sd-label)" }}>크레딧 잔액</div>
          {awaiting && <span className="sd-tag sd-tag--warn">결제 확인 중…</span>}
        </div>

        <div className="flex flex-wrap items-baseline gap-2.5">
          <span className="sd-mono text-[34px] leading-none" style={{ color: "var(--sd-fg)" }}>
            {state ? state.balance.toLocaleString("ko-KR") : "—"}
          </span>
          {state && (
            <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
              {price != null ? `≈ ${WON(state.balance * price)} · ` : ""}
              약 {Math.floor(state.balance / 60)}시간 {state.balance % 60}분 분석 가능
            </span>
          )}
        </div>

        {/* 이번달 사용 게이지 — 목업의 사용/한도 축. 분모 = 이번달 사용 + 현재 잔액. */}
        {state && monthUsage != null && gaugeTotal != null && gaugeTotal > 0 && (
          <div>
            <div className="h-[6px] overflow-hidden rounded-full" style={{ background: "var(--sd-card-sub)" }}>
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.min(100, Math.round((monthUsage / gaugeTotal) * 100))}%`,
                  background: state.balance <= 0 ? "var(--sd-danger-strong)" : "var(--sd-accent)",
                }}
              />
            </div>
            <div className="mt-1 flex justify-between text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
              <span>이번달 {monthUsage.toLocaleString("ko-KR")}개 사용</span>
              <span>잔액 {state.balance.toLocaleString("ko-KR")}개</span>
            </div>
          </div>
        )}

        {price != null && (
          <div
            className="flex items-center justify-between pt-2 text-[11.5px]"
            style={{ borderTop: "1px solid var(--sd-border)" }}
          >
            <span style={{ color: "var(--sd-mut)" }}>크레딧 단가</span>
            <span className="sd-mono" style={{ color: "var(--sd-fg)" }}>
              {WON(price)}<span className="ml-1 text-[10.5px]" style={{ color: "var(--sd-mut)" }}>/ 개 (부가세 포함)</span>
            </span>
          </div>
        )}

        <p className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
          서비스를 계속 이용하려면 크레딧을 구매하세요.
        </p>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]" style={{ color: "var(--sd-fg)" }}>
          <span className="inline-flex items-center gap-1.5">
            <CreditCard size={13} style={{ color: "var(--sd-mut)" }} aria-hidden /> 선불
          </span>
          <span style={{ color: "var(--sd-mut)" }}>·</span>
          <span className="inline-flex items-center gap-1.5">
            <Zap size={13} style={{ color: "var(--sd-mut)" }} aria-hidden />
            자동 충전: {policy ? (policy.enabled ? "켜짐" : "사용 중지") : "—"}
          </span>
          <button
            type="button"
            className="underline"
            style={{ color: "var(--sd-accent)" }}
            onClick={() => setDialog("autotopup")}
          >
            자동 충전 설정
          </button>
        </div>

        <p className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
          {state?.unit ?? "크레딧 1개 = 분석 1분"} · 선불 결제이며, 승인 후 서버 확인이 끝나야
          잔액에 반영됩니다. 크레딧은 분석에 쓰인 분만큼 차감됩니다.
        </p>
      </BillingCard>

      {error && (
        <div
          className="rounded-[4px] px-3 py-2 text-[11.5px]"
          style={{ border: "1px solid var(--sd-danger-border)", background: "var(--sd-danger-bg)", color: "var(--sd-danger-strong)" }}
        >
          크레딧 정보를 불러오지 못했습니다 ({error}).
        </div>
      )}

      {/* ── 자동 재결제 + 결제 알림 — 목업의 "자동 재결제" 카드. 편집은 다이얼로그가 한다. ── */}
      <BillingCard
        title="자동 재결제 · 결제 알림"
        action={<CardAction label="자동 재결제 설정" onClick={() => setDialog("autotopup")} />}
      >
        <p className="text-[11.5px]" style={{ color: "var(--sd-fg)" }}>
          {policy
            ? policy.enabled
              ? <>잔액이 <b>{policy.thresholdCredits.toLocaleString("ko-KR")}개</b> 아래로 내려가면 저장 카드로 <b>{policy.topupCredits.toLocaleString("ko-KR")}개
                  {price != null ? `(${WON(policy.topupCredits * price)})` : ""}</b>를 자동 결제합니다.</>
              : "꺼져 있습니다 — 잔액이 소진되면 새 분석이 멈춥니다. 켜 두면 저장 카드로 자동 결제합니다."
            : "설정을 불러오는 중…"}
        </p>
        <p className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
          언제든 끌 수 있습니다 · 일 횟수·월 금액 상한 안에서만 결제됩니다.
        </p>

        <div className="pt-2" style={{ borderTop: "1px solid var(--sd-border)" }}>
          <div className="mb-1 text-[11px] font-medium" style={{ color: "var(--sd-label)" }}>결제 알림 이메일</div>
          <p className="mb-1.5 text-[11px]" style={{ color: "var(--sd-mut)" }}>
            인보이스(결제 완료)와 자동 결제 실패 알림을 받을 담당자 — 쉼표로 여러 명(최대 5명).
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={notifyInput}
              onChange={(e) => setNotifyInput(e.target.value)}
              placeholder="media-ops@company.com, cp@company.com"
              className="sd-input min-w-[260px] flex-1"
              aria-label="결제 알림 이메일"
              disabled={!canManageBilling}
            />
            <button
              type="button"
              className="sd-btn"
              disabled={notifyBusy || !notifyDirty || !canManageBilling}
              onClick={() => void saveNotify()}
            >
              {notifyBusy ? "저장 중…" : notifyDirty ? "저장" : "저장됨"}
            </button>
          </div>
          {notifySaved.length > 0 && (
            <p className="mt-1.5 text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
              {notifySaved.length}명이 결제 알림 메일을 받고 있습니다.
            </p>
          )}
        </div>
      </BillingCard>

      {/* ── 2열 — 거래 · 결제 옵션 ─────────────────────────────────────────── */}
      <div className="grid items-stretch gap-[14px] md:grid-cols-2">
        <BillingCard
          title="거래"
          action={<CardAction label="거래 보기" onClick={() => setDialog("ledger")} disabled={!state} />}
        >
          {!state ? (
            <p className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>불러오는 중…</p>
          ) : recent.length === 0 ? (
            <p className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>아직 거래가 없습니다.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {recent.map((l) => (
                <div key={l.id} className="flex items-center gap-2.5">
                  <span className="sd-mono w-[76px] shrink-0 text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                    {l.occurredAt?.slice(5, 16).replace("T", " ")}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px]" style={{ color: "var(--sd-fg)" }}>
                    {reasonLabel(l.reason)}
                  </span>
                  <span
                    className="sd-mono w-[56px] shrink-0 text-right text-[11.5px]"
                    style={{ color: l.delta >= 0 ? "var(--sd-ok)" : "var(--sd-fg)" }}
                  >
                    {l.delta >= 0 ? "+" : ""}{l.delta.toLocaleString("ko-KR")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </BillingCard>

        <BillingCard
          title="결제 옵션"
          action={<CardAction label="결제 수단 관리" onClick={() => setDialog("card")} />}
        >
          {cardLoadFailed ? (
            <p className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
              결제수단 정보를 불러오지 못했습니다.{" "}
              <button type="button" className="underline" onClick={() => void load()}>다시 시도</button>
            </p>
          ) : !card ? (
            <p className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>불러오는 중…</p>
          ) : (
            <>
              <p className="text-[11.5px]" style={{ color: "var(--sd-fg)" }}>
                저장된 결제 수단이 {card.registered ? 1 : 0}개 있습니다.
              </p>
              {card.registered ? (
                <p className="sd-mono text-[12px] tracking-[0.08em]" style={{ color: "var(--sd-mut)" }}>
                  {card.brand || "카드"} •••• •••• •••• {card.last4 || "••••"}
                </p>
              ) : (
                <p className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
                  카드를 등록해 두면 결제창 없이 버튼 한 번으로 충전합니다.
                </p>
              )}
              {!card.available && (
                <p className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
                  카드 저장이 아직 준비되지 않았습니다. {card.unavailableReason ?? ""}
                </p>
              )}
            </>
          )}
        </BillingCard>
      </div>

      {/* ── 2열 — 인보이스 · 설정 ──────────────────────────────────────────── */}
      <div className="grid items-stretch gap-[14px] md:grid-cols-2">
      <BillingCard
        title="인보이스"
        action={
          <CardAction
            label="인보이스 보기"
            onClick={() => setDialog("invoices")}
            disabled={!invoiceList || invoiceList.invoices.length === 0}
          />
        }
      >
        {invoicesFailed ? (
          <p className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
            인보이스를 불러오지 못했습니다.{" "}
            <button type="button" className="underline" onClick={() => void load()}>다시 시도</button>
          </p>
        ) : !invoiceList ? (
          <p className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>불러오는 중…</p>
        ) : invoiceList.invoices.length === 0 ? (
          <p className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
            아직 결제된 내역이 없습니다 — 결제가 완료되면 건마다 인보이스가 쌓이고 PDF 로 받을 수 있습니다.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {recentInvoices.map((inv) => (
              <div key={inv.id} className="flex items-center gap-2.5">
                <span className="sd-mono w-[76px] shrink-0 text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                  {inv.paidAt.slice(0, 10)}
                </span>
                <span className="sd-mono min-w-0 flex-1 truncate text-[11px]" style={{ color: "var(--sd-fg)" }}>
                  {inv.number}
                </span>
                <span className="sd-mono shrink-0 text-right text-[11.5px]" style={{ color: "var(--sd-fg)" }}>
                  {WON(inv.amountKrw)}
                </span>
              </div>
            ))}
          </div>
        )}
      </BillingCard>

      <BillingCard
        title="설정"
        action={<CardAction label="설정 관리" onClick={() => setDialog("settings")} />}
      >
        <SettingRow
          label="워크스페이스"
          // 세션에 워크스페이스 이름이 없다(계정·역할만 온다) — 있는 것을 정직하게 보여준다.
          value={
            session.user.name
              ? `${session.user.name}${session.user.workspaceRole ? ` · ${ROLE_KO[session.user.workspaceRole] ?? session.user.workspaceRole}` : ""}`
              : "—"
          }
        />
        <SettingRow
          label="크레딧 단가"
          value={price != null ? `${WON(price)} · 부가세 포함` : "단가 미설정"}
        />
        <SettingRow label="구매자 정보" value={buyerSummary || "미입력"} />
      </BillingCard>
      </div>

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
                  {busy ? "진행 중…" : `결제창으로 ${WON(credits * price)} 결제`}
                </button>
                <SavedCardChargeButton
                  card={card}
                  canManage={canManageBilling}
                  credits={credits}
                  amountKrw={credits * price}
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
                <span className="sd-mono text-[15px]" style={{ color: "var(--sd-fg)" }}>
                  {WON(credits * price)}
                </span>
                <span
                  className="text-[10.5px]"
                  style={{ color: "var(--sd-mut)" }}
                  // 실제 청구액은 `크레딧 × 단가` 다 — 부가세를 따로 더하지 않는다.
                  // 인보이스도 이 총액에서 역산해 공급가액·세액을 나눈다. 상세는 title 로.
                  title="실제 청구액은 크레딧 × 단가 그대로입니다. 인보이스는 이 총액에서 공급가액·세액을 역산합니다."
                >
                  (크레딧당 {WON(price)} · 부가세 포함)
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
                      : "휴대폰번호를 확인하세요 (01012345678)."}
                </p>
              )}

              <p
                className="text-[11px]"
                style={{ color: "var(--sd-mut)" }}
                title="결제 승인 후 서버가 포트원 웹훅으로 확인을 마쳐야 잔액에 반영됩니다 — 결제창이 닫힌 직후에는 바로 보이지 않을 수 있습니다."
              >
                승인 후 서버 확인이 끝나야 잔액에 반영됩니다 · 크레딧은 분석에 쓰인 분만큼 차감됩니다.
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
          <SavedCardManager
            canManage={canManageBilling}
            buyer={{ fullName: buyerName.trim(), email: email.trim(), phoneNumber: phoneDigits }}
            card={card}
            loadFailed={cardLoadFailed}
            onReload={load}
          />
        </BillingDialog>
      )}

      {/* 자동 충전 — 저장/실행 분리·dirty 가드·실결제 고지 전부 Manager 안에 있다. */}
      {dialog === "autotopup" && (
        <BillingDialog
          title="자동 충전"
          subtitle="잔액이 임계 아래로 떨어지면 저장 카드로 자동 결제합니다."
          onClose={close}
        >
          <AutoTopupManager
            canManage={canManageBilling}
            hasCard={card?.registered ?? false}
            priceKrw={price}
            onCharged={load}
            onPolicySaved={setPolicy}
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
                  : "휴대폰번호를 확인하세요 (01012345678)."}
            </p>
          )}
          <p className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
            크레딧 단가: {price != null ? `${WON(price)} · 부가세 포함` : "미설정"} — 단가는 서버 설정
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
    </div>
  );
}

function SettingRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[11px]" style={{ color: "var(--sd-mut)" }}>{label}</span>
      <span className="min-w-0 truncate text-right text-[11.5px]" style={{ color: "var(--sd-fg)" }} title={value}>
        {value}
      </span>
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
