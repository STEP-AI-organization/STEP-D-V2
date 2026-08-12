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
  // 개인/법인 카드 선택. KG이니시스 빌링키 창은 이 값(bypass.inicis_v2.carduse)으로 카드
  // 종류를 고정한다 — 안 넘기면 창 안 토글에서 법인 고르는 순간 본인확인 흐름이 꼬여
  // "비번칸이 잠겼다"처럼 보인다. 우리 화면에서 먼저 고르게 해 창을 해당 종류로 바로 연다.
  // 기본은 개인(percard) — 지금까지 되던 경우.
  const [cardUse, setCardUse] = useState<"percard" | "cocard">("percard");

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
        // KG이니시스 전용 — 카드 종류를 창에 고정한다(개인=percard·법인=cocard).
        // 법인 선택 시 사업자등록번호로 본인확인하는 정상 흐름으로 바로 연다.
        bypass: { inicis_v2: { carduse: cardUse } },
      });

      if (res?.code) {
        // 사용자가 닫았거나 카드사가 거절했다. 실패로 단정하지 말고 사유를 그대로 보여준다.
        //
        // ⚠️ **pgMessage 를 같이 보여준다.** 문서상 실패 응답은 `code`·`message` 외에
        // `pgCode`·`pgMessage` 를 주는데, 카드사가 왜 거절했는지(한도·해외카드·본인인증 등)는
        // 거기 담긴다. message 만 띄우면 "결제에 실패했습니다" 같은 빈 문구만 보고 헤맨다.
        const pg = res as { pgMessage?: string; pgCode?: string };
        const detail = [res.message ?? res.code, pg.pgMessage ?? pg.pgCode].filter(Boolean).join(" · ");
        toast({ title: "카드 등록이 완료되지 않았습니다", description: detail, tone: "warn" });
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
              {/* 카드 변경 시에도 개인/법인 선택이 창에 반영되게 토글을 함께 둔다. */}
              <CardUseToggle value={cardUse} onChange={setCardUse} disabled={busy !== null} />
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
        <div className="flex flex-col gap-2">
          <span className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
            등록된 카드가 없습니다. 등록해 두면 매번 카드를 넣지 않고 버튼으로 충전합니다.
            <br />
            {/* carduse bypass 로 카드 종류를 창에 고정하므로(2026-08-12) 이제 화면에서 먼저 고른다.
                무기명(공용) 법인카드는 카드사 정책상 정기결제 등록이 막힐 수 있는데, 그때도
                일반결제(위 '크레딧 충전')는 법인카드로 정상 결제된다. */}
            <span style={{ color: "var(--sd-warn)" }}>
              ⚠ 무기명(공용) 법인카드는 카드사 정책상 등록이 막힐 수 있습니다 — 그 경우 위
              &quot;크레딧 충전&quot;(일반결제)은 법인카드로 정상 결제됩니다.
            </span>
          </span>
          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
              <CardUseToggle value={cardUse} onChange={setCardUse} disabled={busy !== null} />
              <button
                type="button"
                className="sd-btn sd-btn-primary ml-auto"
                disabled={busy !== null}
                onClick={register}
              >
                {busy === "register" ? "등록 중…" : "카드 등록"}
              </button>
            </div>
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

/** 개인/법인 카드 선택 — KG이니시스 빌링키 창을 해당 카드 종류로 고정한다(carduse bypass). */
function CardUseToggle({
  value,
  onChange,
  disabled,
}: {
  value: "percard" | "cocard";
  onChange: (v: "percard" | "cocard") => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="inline-flex overflow-hidden rounded-[5px]"
      style={{ border: "1px solid var(--sd-border)" }}
      role="group"
      aria-label="카드 종류"
    >
      {([["percard", "개인카드"], ["cocard", "법인카드"]] as const).map(([k, label]) => (
        <button
          key={k}
          type="button"
          disabled={disabled}
          onClick={() => onChange(k)}
          className="px-2.5 py-1 text-[11.5px] font-medium disabled:opacity-50"
          style={
            value === k
              ? { background: "var(--sd-fg)", color: "#fff" }
              : { background: "transparent", color: "var(--sd-mut)" }
          }
        >
          {label}
        </button>
      ))}
    </div>
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
