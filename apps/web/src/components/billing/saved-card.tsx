"use client";

/**
 * 저장 카드(결제수단) — 회사 실무자가 직접 등록·삭제하고, 등록해 두면 버튼 한 번으로 충전한다.
 *
 * ## 카드 번호는 우리에게 오지 않는다
 * 브라우저 SDK(`requestIssueBillingKey`)가 카드 정보를 **포트원으로 직접** 보내고, 우리는
 * 그 결과인 빌링키만 받는다. 그래서 이 화면도 서버도 카드 번호를 본 적이 없고,
 * 표시할 수 있는 건 브랜드와 끝 4자리뿐이다.
 *
 * ## owner/admin 만 만진다
 * 결제수단 등록·삭제·결제는 돈이 나가는 일이라 서버가 403 으로 막는다. 화면에서도 숨기되,
 * **숨기는 건 편의일 뿐 경계는 서버**다(member 가 직접 호출해도 막힌다).
 *
 * ## 삭제는 되돌릴 수 없다
 * 해지하면 서버가 빌링키 문자열을 비운다 — 다시 쓰려면 카드를 새로 등록해야 한다.
 * 그래서 확인을 받는다.
 */
import { useCallback, useEffect, useState } from "react";

import { useToast } from "@/components/ui/toast";
import {
  deleteSavedCard,
  fetchSavedCard,
  prepareCardIssue,
  saveCard,
  topupWithCard,
  type SavedCard,
} from "@/lib/data/api";

export function SavedCardPanel({
  canManage,
  buyer,
  credits,
  onCharged,
}: {
  canManage: boolean;
  buyer: { fullName: string; email: string; phoneNumber: string };
  /** 충전할 크레딧 — 위 입력칸과 같은 값을 쓴다. 두 군데서 따로 받으면 헷갈린다. */
  credits: number;
  onCharged: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const [card, setCard] = useState<SavedCard | null>(null);
  const [busy, setBusy] = useState<"register" | "charge" | "delete" | null>(null);

  const load = useCallback(async () => {
    try {
      setCard(await fetchSavedCard());
    } catch {
      // 조회가 실패해도 일반결제는 쓸 수 있어야 한다 — 이 패널만 조용히 접는다.
      setCard(null);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // 서버에 빌링 채널키가 없으면 등록 자체가 안 된다. 버튼을 보여주고 눌렀을 때 실패하는
  // 것보다, 왜 안 되는지 적어 두는 편이 낫다.
  if (!card) return null;
  if (!card.available) {
    return (
      <Shell>
        <p className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
          카드 저장이 아직 준비되지 않았습니다. {card.unavailableReason ?? ""}
        </p>
      </Shell>
    );
  }

  async function register() {
    setBusy("register");
    try {
      // 1) 서버가 필수 고객정보를 먼저 검사한다 — 빠지면 결제창을 아예 안 띄운다.
      const prep = await prepareCardIssue(buyer);

      // 2) 카드 등록창. SDK 는 브라우저에서만 도므로 이 시점에 동적 로드한다.
      const PortOne = await import("@portone/browser-sdk/v2");
      const res = await PortOne.requestIssueBillingKey({
        storeId: prep.storeId,
        channelKey: prep.channelKey,
        billingKeyMethod: prep.billingKeyMethod,
        issueId: prep.issueId,
        issueName: prep.issueName,
        customer: prep.customer,
      });

      if (res?.code) {
        // 사용자가 닫았거나 카드사가 거절했다. 실패로 단정하지 말고 사유를 그대로 보여준다.
        toast({ title: "카드 등록이 완료되지 않았습니다", description: res.message ?? res.code, tone: "warn" });
        return;
      }
      const billingKey = (res as { billingKey?: string })?.billingKey;
      if (!billingKey) throw new Error("빌링키를 받지 못했습니다.");

      await saveCard({ billingKey });
      toast({ title: "카드를 등록했습니다", description: "이제 버튼 한 번으로 충전할 수 있습니다.", tone: "done" });
      await load();
    } catch (err) {
      toast({ title: "카드 등록 실패", description: msg(err), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function charge() {
    if (credits <= 0) return;
    setBusy("charge");
    try {
      // 저장 카드는 결제창이 없다 — 서버가 긁고 승인까지 확인한 뒤 응답한다.
      // 그래서 일반결제와 달리 웹훅을 기다리지 않고 바로 반영된 잔액이 온다.
      const r = await topupWithCard(credits);
      toast({
        title: `크레딧 ${r.credits.toLocaleString("ko-KR")}개 충전 완료`,
        description: `₩${r.amountKrw.toLocaleString("ko-KR")} 결제 · 잔액 ${r.balance.toLocaleString("ko-KR")}`,
        tone: "done",
      });
      await onCharged();
    } catch (err) {
      toast({ title: "결제 실패", description: msg(err), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!window.confirm("등록된 카드를 삭제합니다.\n\n다시 쓰려면 카드를 새로 등록해야 합니다. 진행할까요?")) return;
    setBusy("delete");
    try {
      await deleteSavedCard();
      toast({ title: "카드를 삭제했습니다", tone: "done" });
      await load();
    } catch (err) {
      toast({ title: "삭제 실패", description: msg(err), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Shell>
      {card.registered ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="sd-tag">등록됨</span>
          <span className="text-[13px]" style={{ color: "var(--sd-fg)" }}>{card.label}</span>
          {card.createdAt && (
            <span className="text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
              {new Date(card.createdAt).toLocaleDateString("ko-KR")} 등록
            </span>
          )}
          {canManage && (
            <>
              <button
                type="button"
                className="sd-btn sd-btn-primary ml-auto"
                disabled={busy !== null || credits <= 0}
                onClick={charge}
              >
                {busy === "charge" ? "결제 중…" : "저장 카드로 결제"}
              </button>
              <button type="button" className="sd-btn" disabled={busy !== null} onClick={register}>
                카드 변경
              </button>
              <button type="button" className="sd-btn" disabled={busy !== null} onClick={remove}>
                {busy === "delete" ? "삭제 중…" : "삭제"}
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
            등록된 카드가 없습니다. 등록해 두면 매번 카드를 넣지 않고 버튼으로 충전합니다.
          </span>
          {canManage && (
            <button
              type="button"
              className="sd-btn sd-btn-primary ml-auto"
              disabled={busy !== null}
              onClick={register}
            >
              {busy === "register" ? "등록 중…" : "카드 등록"}
            </button>
          )}
        </div>
      )}

      {!canManage && (
        // 왜 버튼이 없는지 말해 준다 — 없으면 "고장났나" 로 읽힌다.
        <p className="text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
          결제수단 등록·삭제와 결제는 워크스페이스 owner·admin 만 할 수 있습니다.
        </p>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-[6px] p-3" style={{ border: "1px solid var(--sd-border)" }}>
      <div className="text-[11.5px] font-semibold" style={{ color: "var(--sd-fg)" }}>결제수단</div>
      {children}
    </div>
  );
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
