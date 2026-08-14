"use client";

/**
 * 자동 충전 설정 — 잔액이 임계 이하로 떨어지면 저장 카드로 자동 결제한다.
 *
 * ## 기본 꺼짐 + 상한이 안전벨트
 * 돈이 자동으로 나가는 기능이라, 사람이 켜고 상한(하루 횟수·월 금액)을 정하기 전엔
 * 아무것도 자동으로 긁지 않는다. 상한을 넘으면 서버가 멈추고 로그에 남긴다.
 *
 * ## owner/admin 만 만진다 (서버가 403 으로도 막는다)
 * ## 카드가 있어야 성립 — 없으면 켜기 자체를 막는다(서버 409).
 */
import { useCallback, useEffect, useState } from "react";

import { useToast } from "@/components/ui/toast";
import { fetchAutoTopup, runAutoTopup, saveAutoTopup, type AutoTopupPolicy } from "@/lib/data/api";

export function AutoTopupManager({
  canManage,
  hasCard,
  priceKrw,
  onCharged,
  onPolicySaved,
}: {
  canManage: boolean;
  /** 저장된 카드가 있는가 — 없으면 자동 충전을 켤 수 없다(안내만). */
  hasCard: boolean;
  /** 크레딧 단가(원) — 즉시 실행 시 청구될 ₩금액을 본문과 confirm 에 보여주는 데 쓴다. */
  priceKrw?: number | null;
  onCharged?: () => void | Promise<void>;
  /** 저장 성공 시 부모에 알린다 — 히어로 카드의 "자동 충전: 켜짐/사용 중지" 표시가 이걸 본다. */
  onPolicySaved?: (p: AutoTopupPolicy) => void;
}) {
  const { toast } = useToast();
  const [p, setP] = useState<AutoTopupPolicy | null>(null);
  // 서버에 저장된 정책 스냅샷 — 실행은 이걸로 결제되므로, 화면 편집분과 어긋나면 실행을 막는다.
  const [savedP, setSavedP] = useState<AutoTopupPolicy | null>(null);
  const [busy, setBusy] = useState<"save" | "run" | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const fetched = await fetchAutoTopup();
      setP(fetched);
      setSavedP(fetched);
      setLoadFailed(false);
    } catch {
      // 패널을 통째로 숨기면 기능이 있는지조차 알 수 없다 — 실패했다는 한 줄은 남긴다.
      setP(null);
      setLoadFailed(true);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (!p) {
    if (!loadFailed) {
      // 다이얼로그 안이라 빈 화면이 더 어색하다 — 조회 중임을 말한다.
      return <p className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>불러오는 중…</p>;
    }
    return (
      <p className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
        자동 충전 설정을 불러오지 못했습니다.{" "}
        <button type="button" className="underline" onClick={() => void load()}>
          다시 시도
        </button>
      </p>
    );
  }

  const set = <K extends keyof AutoTopupPolicy>(k: K, v: AutoTopupPolicy[K]) =>
    setP((prev) => (prev ? { ...prev, [k]: v } : prev));
  const num = (v: string, min = 0) => Math.max(min, Math.floor(Number(v.replace(/\D/g, "")) || 0));

  async function save() {
    if (!p) return;
    setBusy("save");
    try {
      const saved = await saveAutoTopup({
        enabled: p.enabled,
        thresholdCredits: p.thresholdCredits,
        topupCredits: p.topupCredits,
        maxPerDay: p.maxPerDay,
        maxKrwPerMonth: p.maxKrwPerMonth,
      });
      setP(saved);
      setSavedP(saved);
      // 히어로 카드의 켜짐/사용 중지 표시가 이 스냅샷을 따라온다.
      onPolicySaved?.(saved);
      toast({ title: "자동 충전 설정을 저장했습니다", tone: "done" });
    } catch (e) {
      toast({ title: "저장 실패", description: e instanceof Error ? e.message : String(e), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  // 실행(runAutoTopup)은 **서버에 저장된 정책**으로 결제한다 — 화면의 미저장 값으로 confirm 을
  // 띄우면 동의한 금액과 청구액이 달라질 수 있다. 어긋나 있으면 실행을 막는다.
  const dirty =
    !!p && !!savedP &&
    (p.enabled !== savedP.enabled ||
      p.thresholdCredits !== savedP.thresholdCredits ||
      p.topupCredits !== savedP.topupCredits ||
      p.maxPerDay !== savedP.maxPerDay ||
      p.maxKrwPerMonth !== savedP.maxKrwPerMonth);

  async function runNow() {
    if (!p || !savedP || dirty) return;
    // "테스트"가 아니다 — 조건이 맞으면 진짜 긁힌다. 저장된 정책의 금액으로 확인을 받는다.
    const won = priceKrw != null ? ` (₩${(savedP.topupCredits * priceKrw).toLocaleString("ko-KR")})` : "";
    if (
      !window.confirm(
        `지금 잔액이 임계(${savedP.thresholdCredits.toLocaleString("ko-KR")}크레딧) 아래면 저장 카드로 ` +
          `${savedP.topupCredits.toLocaleString("ko-KR")}크레딧${won}이 즉시 결제됩니다.\n\n실행할까요?`,
      )
    )
      return;
    setBusy("run");
    try {
      const r = await runAutoTopup();
      if (r.charged) {
        toast({
          title: `자동 충전 실행됨 · +${r.credits?.toLocaleString("ko-KR")} 크레딧`,
          description: `잔액 ${r.balance?.toLocaleString("ko-KR")}`,
          tone: "done",
        });
        await onCharged?.();
        // 사이드바 잔액도 즉시 따라오게 한다 — 일반결제 웹훅 반영과 같은 신호.
        window.dispatchEvent(new Event("stepd:credits-changed"));
      } else {
        toast({ title: "지금은 충전 조건이 아닙니다", description: r.reason, tone: "warn" });
      }
    } catch (e) {
      toast({ title: "실행 실패", description: e instanceof Error ? e.message : String(e), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  return (
    // 껍데기는 다이얼로그(BillingDialog)가 그린다 — 여기는 내용만.
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-[11.5px] font-semibold" style={{ color: "var(--sd-fg)" }}>상태</span>
        <span
          className="rounded-[3px] px-1.5 py-0.5 text-[10px] font-medium"
          style={
            p.enabled
              ? { background: "var(--sd-ok-bg, #eef7ee)", color: "var(--sd-ok-strong, #2f7d32)" }
              : { background: "var(--sd-card-sub)", color: "var(--sd-mut)" }
          }
        >
          {p.enabled ? "켜짐" : "꺼짐"}
        </span>
      </div>
      <p className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
        잔액이 <b style={{ color: "var(--sd-fg)" }}>{p.thresholdCredits.toLocaleString("ko-KR")}</b>크레딧 아래로
        떨어지면 저장한 카드로 <b style={{ color: "var(--sd-fg)" }}>{p.topupCredits.toLocaleString("ko-KR")}</b>크레딧을
        자동으로 충전합니다. 하루 최대 {p.maxPerDay}회 · 월 최대 ₩{p.maxKrwPerMonth.toLocaleString("ko-KR")}까지.
      </p>

      {!hasCard && (
        <div
          className="rounded-[4px] px-3 py-2 text-[11.5px]"
          style={{ border: "1px solid var(--sd-warn-border)", background: "var(--sd-warn-bg)", color: "var(--sd-warn)" }}
        >
          ⚠ 자동 충전을 켜려면 <b>먼저 카드를 등록</b>하세요. 저장된 카드로만 자동 결제됩니다.
        </div>
      )}

      {canManage ? (
        <>
          <label className="flex items-center gap-2 text-[12px]" style={{ color: "var(--sd-fg)" }}>
            <input
              type="checkbox"
              checked={p.enabled}
              disabled={busy !== null || (!hasCard && !p.enabled)}
              onChange={(e) => set("enabled", e.target.checked)}
            />
            자동 충전 켜기
          </label>

          <div className="grid grid-cols-2 gap-2">
            <Field label="충전 시작 임계 (크레딧)">
              <input className="sd-input w-full" inputMode="numeric" value={String(p.thresholdCredits)}
                disabled={busy !== null} onChange={(e) => set("thresholdCredits", num(e.target.value))} />
            </Field>
            <Field label="한 번에 충전 (크레딧)">
              <input className="sd-input w-full" inputMode="numeric" value={String(p.topupCredits)}
                disabled={busy !== null} onChange={(e) => set("topupCredits", num(e.target.value, 1))} />
            </Field>
            <Field label="하루 최대 횟수">
              <input className="sd-input w-full" inputMode="numeric" value={String(p.maxPerDay)}
                disabled={busy !== null} onChange={(e) => set("maxPerDay", num(e.target.value, 1))} />
            </Field>
            <Field label="월 최대 금액 (원)">
              <input className="sd-input w-full" inputMode="numeric" value={String(p.maxKrwPerMonth)}
                disabled={busy !== null} onChange={(e) => set("maxKrwPerMonth", num(e.target.value, 1))} />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="sd-btn sd-btn-primary" disabled={busy !== null} onClick={save}>
              {busy === "save" ? "저장 중…" : "설정 저장"}
            </button>
            <button type="button" className="sd-btn" disabled={busy !== null || !p.enabled || !hasCard || dirty} onClick={runNow}
              title={dirty ? "저장하지 않은 변경이 있습니다 — 먼저 저장하세요 (실행은 저장된 설정으로 결제됩니다)"
                : !p.enabled ? "먼저 자동 충전을 켜고 저장하세요"
                : "실제 결제입니다 — 잔액이 임계 아래면 저장 카드로 즉시 결제됩니다"}>
              {busy === "run" ? "실행 중…" : "지금 1회 충전 실행"}
            </button>
            {dirty && (
              <span className="text-[10.5px]" style={{ color: "var(--sd-warn)" }}>
                저장 안 된 변경 있음 — 저장 후 실행
              </span>
            )}
          </div>
          {/* "테스트" 같은 완곡어로 실결제를 숨기지 않는다 — 금액은 본문 한 줄에, 상세는 title 로. */}
          <p
            className="text-[11px]"
            style={{ color: "var(--sd-mut)" }}
            title={`지금 잔액이 임계(${p.thresholdCredits.toLocaleString("ko-KR")}크레딧) 아래면 저장 카드로 즉시 결제됩니다. 조건이 아니면 결제 없이 사유만 알려줍니다.`}
          >
            실행 버튼은 <b style={{ color: "var(--sd-fg)" }}>실제 결제</b>입니다 — 조건 충족 시{" "}
            {p.topupCredits.toLocaleString("ko-KR")}크레딧
            {priceKrw != null ? ` (₩${(p.topupCredits * priceKrw).toLocaleString("ko-KR")})` : ""}이
            즉시 결제됩니다.
          </p>
        </>
      ) : (
        <p className="text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
          자동 충전 설정은 워크스페이스 owner·admin 만 바꿀 수 있습니다.
        </p>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10.5px] font-medium" style={{ color: "var(--sd-mut)" }}>{label}</div>
      {children}
    </div>
  );
}
