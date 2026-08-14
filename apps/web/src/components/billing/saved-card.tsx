"use client";

/**
 * 저장 카드(결제수단) — 회사 실무자가 직접 등록·삭제하고, 등록해 두면 버튼 한 번으로 충전한다.
 *
 * ## 결제 버튼과 관리 화면을 갈랐다 (2026-08-14)
 * 저장카드 결제 버튼이 금액 입력과 다른 자리에 있어 "이 버튼이 무슨 금액을 긁는지"가 안
 * 보였다. 그래서 결제 버튼(SavedCardChargeButton)은 크레딧 구매 다이얼로그의 금액 바로
 * 옆으로, 등록·삭제(SavedCardManager)는 "결제 수단 관리" 다이얼로그 본문으로 분리했다
 * (껍데기는 다이얼로그가 그린다 — 여기는 내용만). 카드 조회는 부모(page)가 한 번 해서
 * 둘에 같은 스냅샷을 나눠 준다.
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
 * 저장 카드 결제 버튼 — 크레딧 구매 다이얼로그의 **금액 입력 옆**에 놓는다. 무슨 금액을
 * 긁는지 그 자리에서 보이게 하기 위한 분리다. 등록 카드가 없거나 권한이 없으면 아무것도
 * 그리지 않는다(등록 유도는 "결제 수단 관리" 다이얼로그 몫).
 */
export function SavedCardChargeButton({
  card,
  canManage,
  credits,
  amountKrw,
  onCharged,
  onBusyChange,
}: {
  /** 부모(page)가 조회한 저장 카드 — 결제수단 패널과 같은 스냅샷을 본다. */
  card: SavedCard | null;
  canManage: boolean;
  /** 충전할 크레딧 — 충전 카드의 입력값 그대로. */
  credits: number;
  /** 청구될 원화 총액 — 저장 카드는 결제창이 없어서 버튼 라벨이 금액 확인의 첫 관문이다. */
  amountKrw: number;
  onCharged: () => void | Promise<void>;
  /** 결제 요청 in-flight 를 부모에 알린다 — 다이얼로그가 진행 중 닫힘(ESC·오버레이)을 막는 데 쓴다. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const { toast } = useToast();
  const [busy, setBusyState] = useState(false);
  const setBusy = (b: boolean) => { setBusyState(b); onBusyChange?.(b); };
  const [idemKey, setIdemKey] = useState<string>(() =>
    // SSR 프리렌더에는 sessionStorage 가 없다 — DOM 에 안 그려지는 값이라 서버/클라 불일치는 무해.
    typeof window === "undefined" ? crypto.randomUUID() : restoreOrCreateIdemKey(),
  );

  if (!card?.registered || !card.available || !canManage) return null;

  async function charge() {
    if (busy || credits <= 0) return;
    // 저장 카드는 결제창이 없어서 이 confirm 이 유일한 금액 확인 관문이다 — 클릭 즉시 과금 방지.
    if (
      !window.confirm(
        `₩${amountKrw.toLocaleString("ko-KR")} 이 저장 카드로 즉시 결제됩니다.\n\n크레딧 ${credits.toLocaleString("ko-KR")}개 충전을 진행할까요?`,
      )
    )
      return;
    setBusy(true);
    try {
      // 저장 카드는 결제창이 없다 — 서버가 긁고 승인까지 확인한 뒤 응답한다.
      // 그래서 일반결제와 달리 웹훅을 기다리지 않고 바로 반영된 잔액이 온다.
      const r = await topupWithCard(credits, idemKey);
      // 성공 — 이 키의 일은 끝났다. 지금 갈아야 다음 충전이 "중복"으로 무시되지 않는다.
      setIdemKey(rotateIdemKey());
      toast({
        title: `크레딧 ${r.credits.toLocaleString("ko-KR")}개 충전 완료`,
        description: `₩${r.amountKrw.toLocaleString("ko-KR")} 결제 · 잔액 ${r.balance.toLocaleString("ko-KR")}`,
        tone: "done",
      });
      await onCharged();
      // 사이드바 잔액도 즉시 따라오게 한다 — 일반결제 웹훅 반영과 같은 신호.
      window.dispatchEvent(new Event("stepd:credits-changed"));
    } catch (err) {
      // 전부 "결제 실패"로 뭉개면 안 된다 — "확인 중"(돈이 나갔을 수 있음)에서 실패로 읽은
      // 사용자가 재결제해 이중 청구가 된다. topupWithCard 는 자체 fetch 라 ApiError 가 아닐 수
      // 있으므로(status 유실) 상태코드가 있으면 함께 보고, 없으면 서버 메시지 문구로 가른다.
      const m = msg(err);
      const status = err instanceof ApiError ? err.status : undefined;
      if ((status === 409 || status === undefined) && /확인 중|정산/.test(m)) {
        // 승인됐을 수 있다 — 키를 유지한 채(새로고침에도 sessionStorage 가 지킨다) 웹훅 정산을 기다린다.
        toast({
          title: "결제 확인 중",
          description: `${m} 재결제하지 마세요 — 같은 요청으로 다시 시도해도 두 번 긁히지 않습니다.`,
          tone: "warn",
        });
      } else if (/idempotency|요청 키|이미 사용됐/.test(m)) {
        // 같은 키가 다른 금액의 주문에 이미 묶였다(실패 후 금액 바꿔 재클릭). 서버가 **긁기 전에**
        // 거절하는 경로라 새 키가 안전하고, 키가 새로고침을 살아남는 지금은 여기서 갈아 줘야
        // 막다른 길에서 빠져나올 수 있다.
        setIdemKey(rotateIdemKey());
        toast({ title: "요청이 겹쳤습니다 — 새로고침 후 재시도", description: m, tone: "warn" });
      } else {
        toast({ title: "결제 실패", description: m, tone: "error" });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className="sd-btn"
      disabled={busy || credits <= 0}
      title={`등록된 카드(끝 ${card.last4 ?? "····"})로 결제창 없이 즉시 결제합니다`}
      onClick={charge}
    >
      {/* 청구액을 버튼에 그대로 박는다 — 얼마가 나가는지 모르고 누르는 일이 없게. */}
      {busy ? "결제 중…" : `저장 카드로 ₩${amountKrw.toLocaleString("ko-KR")} 결제`}
    </button>
  );
}

export function SavedCardManager({
  canManage,
  buyer,
  card,
  loadFailed,
  onReload,
}: {
  canManage: boolean;
  /** 구매자 정보 — 충전 카드의 입력값 그대로. 카드 등록(prepareCardIssue)에 필요하다. */
  buyer: { fullName: string; email: string; phoneNumber: string };
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
      return <p className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>불러오는 중…</p>;
    }
    return (
      <p className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
        결제수단 정보를 불러오지 못했습니다.{" "}
        <button type="button" className="underline" onClick={() => void onReload()}>
          다시 시도
        </button>
      </p>
    );
  }
  if (!card.available) {
    return (
      <p className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
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

      await saveCard({ billingKey });
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
              {/* 결제 버튼은 여기 없다 — 크레딧 구매 다이얼로그(금액 옆)의 SavedCardChargeButton 이 긁는다. */}
              <button type="button" className="sd-btn ml-auto" disabled={busy !== null} onClick={register}>
                {busy === "register" ? "등록 중…" : "카드 변경"}
              </button>
              <button type="button" className="sd-btn" disabled={busy !== null} onClick={remove}>
                {busy === "delete" ? "삭제 중…" : "삭제"}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <span className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
            등록된 카드가 없습니다. 등록해 두면 결제창 없이 버튼 한 번으로 충전합니다.
            <br />
            {/* carduse bypass 로 카드 종류를 창에 고정하므로(2026-08-12) 이제 화면에서 먼저 고른다.
                무기명(공용) 법인카드는 카드사 정책상 정기결제 등록이 막힐 수 있는데, 그때도
                일반결제(충전 카드의 결제창 버튼)는 법인카드로 정상 결제된다 — 상세는 title 로. */}
            <span
              style={{ color: "var(--sd-warn)" }}
              title="무기명(공용) 법인카드는 카드사 정책상 정기결제(빌링키) 등록이 막힐 수 있습니다. 그 경우에도 충전 카드의 일반결제(결제창)는 법인카드로 정상 결제됩니다."
            >
              ⚠ 무기명(공용) 법인카드는 등록이 막힐 수 있습니다 — 일반결제는 가능합니다.
            </span>
          </span>
          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
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
    </div>
  );
}

/**
 * 저장된 카드를 실제 카드 모양으로 보여준다. 카드번호 원본은 우리에게 없으므로
 * **마스킹**해서 끝 4자리만 — 나머지는 •로 채운다. 브랜드/발급사는 포트원 조회값.
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
    <div
      className="relative w-full max-w-[300px] overflow-hidden rounded-[12px] p-4 text-white shadow-md"
      style={{ background: "linear-gradient(135deg, #33344a 0%, #1c1d2b 100%)", aspectRatio: "1.586 / 1" }}
    >
      <div className="flex items-start justify-between">
        <span className="text-[10.5px] tracking-wide opacity-70">등록된 결제수단</span>
        <span className="text-[11.5px] font-semibold">{brand || "카드"}</span>
      </div>

      {/* 칩 */}
      <div
        className="mt-3 h-6 w-9 rounded-[4px]"
        style={{ background: "linear-gradient(135deg, #f0d68a 0%, #b8952f 100%)" }}
        aria-hidden
      />

      {/* 마스킹된 카드번호 — 끝 4자리만 보인다 */}
      <div className="sd-mono mt-3 text-[16px] tracking-[0.18em]">
        •••• •••• •••• {last4 || "••••"}
      </div>

      <div className="mt-2 flex items-end justify-between">
        <span className="text-[9.5px] uppercase tracking-wide opacity-60">STEP-D · 정기결제</span>
        {createdAt && (
          <span className="text-[9.5px] opacity-70">
            {new Date(createdAt).toLocaleDateString("ko-KR")} 등록
          </span>
        )}
      </div>
    </div>
  );
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
