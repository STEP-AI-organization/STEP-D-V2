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
 * ## 자체 입력창으로 등록한다
 * 카드 정보는 서버의 발급 API에 한 번만 전달하며 저장하지 않는다.
 * 서버가 빌링키 발급과 저장을 마치면 표시정보만 다시 조회한다.
 *
 * ## owner/admin 만 만진다
 * 결제수단 등록·삭제·결제는 돈이 나가는 일이라 서버가 403 으로 막는다. 화면에서도 숨기되,
 * **숨기는 건 편의일 뿐 경계는 서버**다(member 가 직접 호출해도 막힌다).
 *
 * ## 삭제는 되돌릴 수 없다
 * 해지하면 서버가 빌링키 문자열을 비운다 — 다시 쓰려면 카드를 새로 등록해야 한다.
 * 그래서 확인을 받는다.
 */
import { useRef, useState } from "react";
import { CardRegistrationForm } from "./card-registration-form";

// ⚠️ **SDK 경로로 되돌리려면 여기 코드를 복원해야 한다.** 서버 쪽은 아직 살아 있지만
// (`POST /api/billing/card/prepare` · `api.ts prepareCardIssue`) **부르는 데가 없다** —
// 즉 "롤백용으로 남겨 뒀다" 는 절반만 맞다. 되돌리려면:
//   1. `@portone/browser-sdk/v2` 의 `requestIssueBillingKey` 호출을 이 파일에 복원
//   2. 그 결과 billingKey 를 `saveCard({ billingKey, buyer })` 로 저장
//   3. CardRegistrationForm 마운트를 걷어낸다
// 그 경로에서는 카드번호가 브라우저→포트원으로 직접 가서 우리 인프라를 안 거친다.

import { useToast } from "@/components/ui/toast";
import { PILL, PILL_DANGER, PILL_PRIMARY } from "@/components/ui/tokens";
import {
  deleteSavedCard,
  registerCard,
  type CardCredentialInput,
  type SavedCard,
} from "@/lib/data/api";

export function SavedCardManager({
  canManage,
  buyer,
  buyerReady,
  card,
  loadFailed,
  onReload,
}: {
  canManage: boolean;
  /** 구매자 정보 — 카드 등록(registerCard)에 필요하다. 부모가 같은 화면에서 입력받는다. */
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
  const [editing, setEditing] = useState(false);
  const registering = useRef(false);

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

  async function register(credential: CardCredentialInput) {
    if (registering.current || !canManage || buyerReady === false) return;
    registering.current = true;
    setBusy("register");
    try {
      await registerCard({ credential, buyer, autoChargeConsent: true });
      setEditing(false);
      toast({ title: "카드를 등록했습니다", description: "안내된 조건에 따라 자동결제됩니다.", tone: "done" });
      try { await onReload(); } catch {
        toast({ title: "카드는 등록됐습니다", description: "화면을 새로고침해 결제수단을 확인해 주세요.", tone: "warn" });
      }
    } catch (err) {
      toast({ title: "카드 등록 실패", description: msg(err), tone: "error" });
    } finally {
      registering.current = false;
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
    <div className="flex flex-col gap-3">
      {card.registered && (
        <>
          <CardVisual brand={card.brand} last4={card.last4} createdAt={card.createdAt} />
          {canManage && !editing && (
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={PILL} disabled={busy !== null} onClick={() => setEditing(true)}>
                카드 변경
              </button>
              <button type="button" className={PILL_DANGER} disabled={busy !== null} onClick={remove}>
                {busy === "delete" ? "삭제 중…" : "삭제"}
              </button>
            </div>
          )}
        </>
      )}
      {canManage && (!card.registered || editing) && (
        <CardRegistrationForm busy={busy !== null} buyerReady={buyerReady !== false}
          replacing={card.registered} onRegister={register} onCancel={() => setEditing(false)} />
      )}
      {!canManage && (
        <p className="text-xs text-[var(--color-text-muted)]">
          결제수단 등록·삭제는 워크스페이스 owner·admin만 할 수 있습니다.
        </p>
      )}
    </div>
  );
}

/**
 * 저장된 카드를 실제 카드 모양으로 보여준다 — **디자이너 원본(credits MODAL 1) 그대로.**
 *
 * 카드번호 원본은 저장하지 않는다. 앞 3그룹은 `• • • •` 로 두고
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
