"use client";

/**
 * 저장 카드(결제수단) — 회사 실무자가 직접 등록·삭제한다. **등록이 곧 자동 결제 동의**다.
 *
 * ## 결제 버튼은 없앴다 (2026-09-04 · 자동 결제 단일 정책)
 * 예전엔 저장 카드로 직접 긁는 버튼(`SavedCardChargeButton`)이 크레딧 구매 다이얼로그에
 * 있었다. 수동 구매를 없애면서 그 다이얼로그가 사라졌고, 버튼도 부르는 곳이 없어져 함께
 * 지웠다 — 안 불리는 결제 코드를 남겨 두면 다음 사람이 그게 살아 있는 경로라고 믿는다.
 * 지금 여기 남은 것은 **등록·삭제뿐**이고, 긁는 일은 서버가 잔액 소진 시점에 한다.
 * 껍데기는 다이얼로그가 그린다(여기는 내용만) · 카드 조회는 부모(page)가 한다.
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
import { useState } from "react";

import { useToast } from "@/components/ui/toast";
import {
  ApiError,
  deleteSavedCard,
  prepareCardIssue,
  saveCard,
  topupWithCard,
  type SavedCard,
} from "@/lib/data/api";

// ── 충전 멱등키 — sessionStorage 로 새로고침을 버틴다 ─────────────────────────────
// React state 에만 두면 "결제 확인 중(409)" 뒤 **새로고침이 새 키를 만들어**, 이미 긁혔을 수
// 있는 주문과 별개의 실제 두 번째 결제가 된다. 키를 탭 세션에 보존해 새로고침해도 같은
// 주문으로 재시도되게 하고, **성공했을 때만** 버린다.
const IDEM_STORE_KEY = "stepd.cardTopupIdemKey";

function restoreOrCreateIdemKey(): string {
  try {
    const saved = window.sessionStorage.getItem(IDEM_STORE_KEY);
    // 서버 형식(영숫자·-·_ 8~40자, 'auto' 시작 금지)에 어긋난 잔존값은 어차피 400 이다 — 새로 만든다.
    if (saved && /^[A-Za-z0-9_-]{8,40}$/.test(saved) && !/^auto/i.test(saved)) return saved;
  } catch {
    // sessionStorage 접근 불가(시크릿 모드 등) — 메모리 키로만 동작한다(보존이 없던 예전과 동일).
  }
  const fresh = crypto.randomUUID();
  try { window.sessionStorage.setItem(IDEM_STORE_KEY, fresh); } catch { /* 위와 동일 — 메모리로만 */ }
  return fresh;
}

/** 저장 키를 버리고 새로 만든다 — 성공했거나, 그 키로는 영영 성공할 수 없을 때만 부른다. */
function rotateIdemKey(): string {
  try { window.sessionStorage.removeItem(IDEM_STORE_KEY); } catch { /* 접근 불가면 지울 것도 없다 */ }
  return restoreOrCreateIdemKey();
}

/**
 * 디자이너 모달 푸터의 알약 버튼(원본 MODAL 1). 이 화면 나머지가 전부 그 언어라,
 * 여기만 옛 `sd-btn` 을 쓰면 같은 다이얼로그 안에서 디자인이 갈린다.
 */
const PILL =
  "px-5 py-2.5 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-bg-input)]"
  + " hover:bg-[var(--color-bg-card-hover)] text-[var(--color-text-primary)] text-xs font-semibold"
  + " cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-not-allowed";
const PILL_PRIMARY =
  "px-5 py-2.5 rounded-full bg-[#1C60FF] hover:bg-[#0D1EB8] text-white text-xs font-bold"
  + " shadow-md shadow-[#1C60FF]/25 cursor-pointer transition-colors border-none"
  + " disabled:opacity-60 disabled:cursor-not-allowed";
const PILL_DANGER =
  "px-5 py-2.5 rounded-full bg-white dark:bg-slate-900 hover:bg-rose-500/10 text-rose-600"
  + " dark:text-rose-400 text-xs font-bold transition-colors cursor-pointer border border-rose-500/30"
  + " disabled:opacity-60 disabled:cursor-not-allowed";

export function SavedCardManager({
  canManage,
  buyer,
  buyerReady,
  card,
  loadFailed,
  onReload,
}: {
  canManage: boolean;
  /** 구매자 정보 — 카드 등록(prepareCardIssue)에 필요하다. 부모가 같은 화면에서 입력받는다. */
  buyer: { fullName: string; email: string; phoneNumber: string };
  /**
   * 구매자 3종이 유효한가 — **버튼을 미리 막는 근거**(2026-08-26).
   * 예전엔 이 가드가 없어 빈 전화번호로도 눌렸고, 사용자는 서버 400 토스트만 보고
   * "필요하다는데 넣을 칸이 없다" 는 상태에 갇혔다. 판정은 부모가 한다(같은 규칙 한 벌).
   */
  buyerReady?: boolean;
  /** 부모(page)가 조회한 저장 카드 — 충전 카드의 결제 버튼과 같은 스냅샷을 본다. */
  card: SavedCard | null;
  /** 조회 실패 — 패널을 통째로 숨기면 기능이 있는지조차 알 수 없으니 "다시 시도"를 그린다. */
  loadFailed: boolean;
  /** 등록/삭제 뒤 부모가 카드 상태를 다시 읽는다 — 충전 버튼·자동충전 게이트가 이걸 본다. */
  onReload: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<"register" | "delete" | null>(null);
  // KG이니시스 빌링키 창의 카드 종류 고정값(bypass.inicis_v2.carduse). 고객이 전부 법인이라
  // 화면 선택(개인/법인 토글)은 제거하고 법인(cocard)으로 고정했다 (2026-08-14 사용자 결정).
  // 개인카드가 필요해지면 이 상수를 다시 토글로 되살린다 — 안 넘기면 창 안에서 종류를
  // 바꾸는 순간 본인확인 흐름이 꼬여 "비번칸이 잠겼다"처럼 보이니 고정 자체는 유지할 것.
  const cardUse = "cocard" as const;

  // 서버에 빌링 채널키가 없으면 등록 자체가 안 된다. 버튼을 보여주고 눌렀을 때 실패하는
  // 것보다, 왜 안 되는지 적어 두는 편이 낫다.
  if (!card) {
    if (!loadFailed) {
      // 다이얼로그 안이라 빈 화면이 더 어색하다 — 조회 중임을 말한다.
      return <p className="text-[11px] text-[var(--color-text-muted)]">불러오는 중…</p>;
    }
    return (
      <p className="text-[11px] text-[var(--color-text-muted)]">
        결제수단 정보를 불러오지 못했습니다.{" "}
        <button type="button" className="underline" onClick={() => void onReload()}>
          다시 시도
        </button>
      </p>
    );
  }
  if (!card.available) {
    return (
      <p className="text-[11px] text-[var(--color-text-muted)]">
        카드 저장이 아직 준비되지 않았습니다. {card.unavailableReason ?? ""}
      </p>
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

      // buyer 를 함께 저장한다 — 빌링키 결제의 customer 필수 3종(이니시스)이라, 여기서
      // 안 남기면 저장 카드가 결제 못 하는 장식이 된다(2026-08-14 실측).
      await saveCard({ billingKey, buyer });
      toast({ title: "카드를 등록했습니다", description: "이제 버튼 한 번으로 충전할 수 있습니다.", tone: "done" });
      // 카드 상태는 부모가 갖고 있다 — 부모를 다시 읽혀야 충전 버튼·자동충전 게이트가 따라온다.
      await onReload();
    } catch (err) {
      toast({ title: "카드 등록 실패", description: msg(err), tone: "error" });
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
      // 카드가 사라졌는데 부모가 모른 채면 충전 버튼·자동충전 게이트가 "카드 있음"으로 남는다.
      await onReload();
    } catch (err) {
      toast({ title: "삭제 실패", description: msg(err), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      {card.registered ? (
        <div className="flex flex-col gap-3">
          <CardVisual brand={card.brand} last4={card.last4} createdAt={card.createdAt} />
          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
              {/* 결제 버튼은 없다 — 수동 구매를 없앴다(자동 결제 단일 정책 · 2026-09-04).
                  카드는 등록만 하고, 소진되면 서버가 알아서 긁는다. */}
              <button
                type="button"
                className={`${PILL} ml-auto`}
                disabled={busy !== null || buyerReady === false}
                title={buyerReady === false ? "위 구매자 정보를 먼저 채워 주세요" : undefined}
                onClick={register}
              >
                {busy === "register" ? "등록 중…" : "카드 변경"}
              </button>
              <button type="button" className={PILL_DANGER} disabled={busy !== null} onClick={remove}>
                {busy === "delete" ? "삭제 중…" : "삭제"}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <span className="text-[11px] text-[var(--color-text-muted)]">
            등록된 카드가 없습니다. 등록해 두면 결제창 없이 버튼 한 번으로 충전합니다.
            <br />
            {/* ⚠️ **문구를 고쳤다** (2026-09-07). 예전엔 "등록이 막혀도 일반결제는 가능합니다"
                라고 안내했는데, 수동 크레딧 구매를 없애면서(자동 결제 단일 정책) **그 대안이
                사라졌다.** 없는 기능을 퇴로로 안내하면 사용자는 그걸 찾아 헤맨다 —
                지금은 등록이 막히면 다른 카드를 쓰는 것 말고 방법이 없고, 그렇게 적는다. */}
            <span
              className="text-amber-600 dark:text-amber-400"
              title="무기명(공용) 법인카드는 카드사 정책상 정기결제(빌링키) 등록이 막힐 수 있습니다. 기명 카드나 다른 카드로 등록해 주세요."
            >
              ⚠ 무기명(공용) 법인카드는 등록이 막힐 수 있습니다 — 기명 카드로 등록해 주세요.
            </span>
          </span>
          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={`${PILL_PRIMARY} ml-auto`}
                disabled={busy !== null || buyerReady === false}
                title={buyerReady === false ? "위 구매자 정보를 먼저 채워 주세요" : undefined}
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
        <p className="text-[10.5px] text-[var(--color-text-muted)]">
          결제수단 등록·삭제와 결제는 워크스페이스 owner·admin 만 할 수 있습니다.
        </p>
      )}
    </div>
  );
}

/**
 * 저장된 카드를 실제 카드 모양으로 보여준다 — **디자이너 원본(credits MODAL 1) 그대로.**
 *
 * 카드번호 원본은 우리에게 없다(포트원이 직접 받는다). 그래서 앞 3그룹은 `• • • •` 로 두고
 * 끝 4자리만 보여준다. 브랜드·발급일은 포트원 조회값.
 *
 * ⚠️ 마크업을 손볼 땐 원본과 나란히 두고 볼 것 — 예전엔 인라인 gradient·`sd-mono`(옛 토큰)·
 * 고정 300px 로 그려서 같은 화면 안에서 이 카드만 다른 디자인이었다(2026-09-07 지적).
 */
function CardVisual({
  brand,
  last4,
  createdAt,
}: {
  brand?: string | null;
  last4?: string | null;
  createdAt?: string | null;
}) {
  return (
    <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-stone-900 text-white p-5 rounded-2xl border border-slate-700/60 space-y-4 shadow-lg relative overflow-hidden">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-slate-300">등록된 결제수단</span>
        <span className="text-xs font-extrabold font-mono tracking-wider text-amber-400">
          {brand || "카드"}
        </span>
      </div>

      {/* Gold Chip */}
      <div className="w-10 h-7 bg-amber-400/80 rounded-md border border-amber-300/50 shadow-xs flex items-center justify-center">
        <div className="w-6 h-4 border-t border-b border-amber-600/40" />
      </div>

      {/* Masked Card Number — 앞 3그룹은 마스킹, 끝 4자리만 실제 값 */}
      <div className="font-mono tracking-widest text-sm font-bold pt-1 flex items-center justify-between text-slate-200">
        <span>• • • •</span>
        <span>• • • •</span>
        <span>• • • •</span>
        <span>{last4 || "• • • •"}</span>
      </div>

      {/* Card Footer */}
      <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1 border-t border-slate-700/50">
        <span>STEP-D · 정기결제</span>
        {createdAt && <span>{new Date(createdAt).toLocaleDateString("ko-KR")} 등록</span>}
      </div>
    </div>
  );
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
