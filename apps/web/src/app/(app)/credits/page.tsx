"use client";

/**
 * 크레딧 — 잔액·충전·사용 내역. **크레딧 1개 = 분석 1분.**
 *
 * 결제는 포트원 결제창(일반결제)이다. 여기서 제일 중요한 규칙:
 *
 *   **결제창이 "성공"을 돌려줘도 이 화면은 크레딧을 올리지 않는다.**
 *
 * 크레딧은 서버가 웹훅으로 확정한다(포트원에 직접 조회 → 금액 대조 → 원장 기록).
 * 브라우저 응답만 믿으면 조작 한 번에 공짜가 된다. 그래서 결제 후 화면이 하는 일은
 * **잔액을 다시 조회하는 것뿐**이고, 아직 안 올라왔으면 "확인 중"이라고 말한다.
 */
import { useCallback, useEffect, useState } from "react";

import { useToast } from "@/components/ui/toast";
import { useSession } from "@/lib/auth";
import { createTopupOrder, fetchCredits, type CreditState } from "@/lib/data/api";
import { cn } from "@/lib/utils";

/** 자주 쓰는 충전량. 시간 단위로 생각하는 게 자연스럽다(1크레딧=1분). */
const PRESETS = [
  { credits: 60, label: "1시간" },
  { credits: 300, label: "5시간" },
  { credits: 600, label: "10시간" },
  { credits: 1800, label: "30시간" },
];

const WON = (n: number) => `₩${n.toLocaleString("ko-KR")}`;

export default function CreditsPage() {
  const { toast } = useToast();
  const session = useSession();
  const actor = session.user.name;

  const [state, setState] = useState<CreditState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [credits, setCredits] = useState(600);
  // **PG 가 구매자 이메일을 필수로 요구한다**(이니시스 V2 일반결제). 세션에 있으면 채우고,
  // 없으면 사람이 입력한다 — 지금은 로그인이 강제되지 않아 세션 이메일이 빌 수 있다.
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [awaiting, setAwaiting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await fetchCredits());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (session.user.email) setEmail(session.user.email); }, [session.user.email]);

  const price = state?.priceKrw ?? null;
  const amount = price != null ? credits * price : null;

  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());

  async function topup() {
    if (busy || credits <= 0 || !emailOk) return;
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
        customer: { email: email.trim(), ...(actor ? { fullName: actor } : {}) },
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

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-[14px]">
      {/* 잔액 */}
      <div className="sd-card flex flex-wrap items-end gap-6 p-4">
        <div>
          <div className="sd-eb" style={{ color: "var(--sd-label)" }}>보유 크레딧</div>
          <div className="sd-mono text-[34px] leading-none" style={{ color: "var(--sd-fg)" }}>
            {state ? state.balance.toLocaleString("ko-KR") : "—"}
          </div>
        </div>
        <div className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
          {state?.unit ?? "크레딧 1개 = 분석 1분"}
          <br />
          {state ? `약 ${Math.floor(state.balance / 60)}시간 ${state.balance % 60}분 분석 가능` : ""}
        </div>
        {awaiting && (
          <span className="sd-tag sd-tag--warn ml-auto">결제 확인 중…</span>
        )}
      </div>

      {error && (
        <div
          className="rounded-[4px] px-3 py-2 text-[11.5px]"
          style={{ border: "1px solid var(--sd-danger-border)", background: "var(--sd-danger-bg)", color: "var(--sd-danger-strong)" }}
        >
          크레딧 정보를 불러오지 못했습니다 ({error}).
        </div>
      )}

      {/* 충전 */}
      <div className="sd-card flex flex-col gap-2.5 p-4">
        <div className="sd-eb" style={{ color: "var(--sd-label)" }}>충전</div>

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

            <div className="flex flex-wrap items-center gap-2">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="영수증 받을 이메일 (필수)"
                className="sd-input min-w-[220px] flex-1"
                aria-label="구매자 이메일"
              />
            </div>

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
                {amount != null ? WON(amount) : "—"}
              </span>
              <span className="text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                (크레딧당 {WON(price)} · 부가세 별도)
              </span>
              <button
                type="button"
                className="sd-btn sd-btn-primary ml-auto"
                disabled={busy || credits <= 0 || !emailOk}
                title={emailOk ? undefined : "구매자 이메일이 필요합니다 (PG 필수 항목)"}
                onClick={topup}
              >
                {busy ? "진행 중…" : "결제하기"}
              </button>
            </div>

            <p className="text-[11px] leading-relaxed" style={{ color: "var(--sd-mut)" }}>
              결제 승인 후 <b>서버가 확인을 마쳐야</b> 잔액에 반영됩니다 — 결제창이 닫힌 직후
              바로 보이지 않을 수 있습니다. 크레딧은 분석에 쓰인 분만큼 차감됩니다.
            </p>
          </>
        )}
      </div>

      {/* 내역 */}
      <section className="flex flex-col gap-2">
        <h3 className="sd-serif text-[16px] font-semibold" style={{ color: "var(--sd-fg)" }}>내역</h3>
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
              <div key={l.id} className="sd-card flex flex-wrap items-center gap-3 px-3 py-2">
                <span className="sd-mono text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                  {l.occurredAt?.slice(0, 16).replace("T", " ")}
                </span>
                <span className="min-w-[160px] flex-1 truncate text-[11.5px]" style={{ color: "var(--sd-fg)" }}>
                  {reasonLabel(l.reason)}
                  {l.note ? ` · ${l.note}` : ""}
                </span>
                {l.amountKrw != null && (
                  <span className="sd-mono text-[10.5px]" style={{ color: "var(--sd-mut)" }}>{WON(l.amountKrw)}</span>
                )}
                <span
                  className="sd-mono text-[12.5px]"
                  style={{ color: l.delta >= 0 ? "var(--sd-ok)" : "var(--sd-fg)" }}
                >
                  {l.delta >= 0 ? "+" : ""}{l.delta}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function reasonLabel(reason: string): string {
  return {
    topup: "충전", usage: "분석 사용", grant: "무상 지급",
    adjust: "정정", refund: "환불",
  }[reason] ?? reason;
}
