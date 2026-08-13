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

export function AutoTopupPanel({
  canManage,
  hasCard,
  onCharged,
}: {
  canManage: boolean;
  /** 저장된 카드가 있는가 — 없으면 자동 충전을 켤 수 없다(안내만). */
  hasCard: boolean;
  onCharged?: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const [p, setP] = useState<AutoTopupPolicy | null>(null);
  const [busy, setBusy] = useState<"save" | "run" | null>(null);

  const load = useCallback(async () => {
    try { setP(await fetchAutoTopup()); } catch { setP(null); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (!p) return null;

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
      toast({ title: "자동 충전 설정을 저장했습니다", tone: "done" });
    } catch (e) {
      toast({ title: "저장 실패", description: e instanceof Error ? e.message : String(e), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function runNow() {
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
    <div className="flex flex-col gap-3 rounded-[6px] p-3" style={{ border: "1px solid var(--sd-border)" }}>
      <div className="flex items-center gap-2">
        <div className="text-[11.5px] font-semibold" style={{ color: "var(--sd-fg)" }}>자동 충전</div>
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
            {/* 설정이 맞는지 지금 바로 판정 실행 — 조건 맞으면 실제로 1회 긁힌다. */}
            <button type="button" className="sd-btn" disabled={busy !== null || !p.enabled || !hasCard} onClick={runNow}
              title={!p.enabled ? "먼저 자동 충전을 켜고 저장하세요" : "지금 조건이 맞으면 실제로 1회 충전됩니다"}>
              {busy === "run" ? "실행 중…" : "지금 실행 (테스트)"}
            </button>
          </div>
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
