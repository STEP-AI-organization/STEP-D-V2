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
  fetchSavedCard,
  type AutoTopupPolicy,
  type CreditState,
  type SavedCard,
} from "@/lib/data/api";
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
type DialogKind = "topup" | "ledger" | "card" | "autotopup" | "settings" | null;

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

  const load = useCallback(async () => {
    try {
      setState(await fetchCredits());
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
  const buyerSummary = [buyerName.trim(), email.trim(), phoneDigits].filter(Boolean).join(" · ");

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-[14px]">
      <h2 className="sd-serif text-[16px] font-semibold" style={{ color: "var(--sd-fg)" }}>결제</h2>

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

      {/* ── 설정 (좁은 폭) ─────────────────────────────────────────────────── */}
      <BillingCard
        title="설정"
        className="md:max-w-[420px]"
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
