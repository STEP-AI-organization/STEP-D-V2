"use client";

/**
 * 채널 배포 규칙 — 연결된 계정 하나에 붙는 "이 채널로 보낼 때의 조건" (FLOWS F4-2).
 *
 * **연결(OAuth)과 규칙은 다른 것이다.** 연결은 "우리가 이 채널에 올릴 수 있다"이고,
 * 규칙은 "무엇을, 어떤 모양으로 올릴 것인가"다. 규칙이 없으면 배포 모달에 그 채널이
 * 아예 안 뜬다 — 연결만 해두고 배포가 안 되는 이유가 이것이라, 연결 화면에서 바로
 * 붙일 수 있게 이 다이얼로그를 옛 화면과 새 화면이 함께 쓴다.
 */
import { useEffect, useState } from "react";

import { useToast } from "@/components/ui/toast";
import {
  fetchChannelRules,
  saveChannelRule,
  type ChannelRole,
  type ChannelRule,
} from "@/lib/data/api";
import { cn } from "@/lib/utils";

export const ROLE_LABEL: Record<ChannelRole, string> = {
  main: "본채널",
  sub: "서브채널",
  shorts_only: "숏폼 전용",
  affiliate: "계열 채널",
};

const ROLE_HINT: Record<ChannelRole, string> = {
  main: "길이·비율 제한 없음",
  sub: "본채널과 같은 조건에서 시작",
  shorts_only: "세로 60초 — 가로 클립은 못 보냄",
  affiliate: "제휴/계열사 채널",
};

export function ChannelRuleDialog({
  platform,
  accountId,
  accountLabel,
  onClose,
  onSaved,
}: {
  platform: string;
  accountId: string;
  accountLabel: string;
  onClose: () => void;
  onSaved?: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [r, setR] = useState<ChannelRule>({
    platform,
    accountId,
    label: accountLabel || accountId,
    role: "main",
    maxSec: null,
    aspect: "any",
    titlePrefix: "",
    hashtagTemplate: "",
    tonePreset: "기본",
    privacy: "public",
    scheduleWindow: "",
    enabled: true,
  });

  // 이미 규칙이 있으면 그 값으로 연다 — 새로 만드는 줄 알고 덮어쓰면 안 된다.
  useEffect(() => {
    let alive = true;
    void fetchChannelRules()
      .then((all) => {
        const found = all.find((x) => x.platform === platform && x.accountId === accountId);
        if (alive && found) setR(found);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [platform, accountId]);

  const set = (patch: Partial<ChannelRule>) => setR((prev) => ({ ...prev, ...patch }));

  /** 역할을 고르면 그 역할의 기본값이 들어온다. 단 사람이 손댄 뒤엔 덮지 않는다. */
  function pickRole(role: ChannelRole) {
    if (touched) { set({ role }); return; }
    if (role === "shorts_only") set({ role, aspect: "9:16", maxSec: platform === "youtube" ? 60 : 90 });
    else if (platform === "smr") set({ role, aspect: "16:9", maxSec: 180 });
    else set({ role, aspect: "any", maxSec: null });
  }

  async function save() {
    setBusy(true);
    try {
      await saveChannelRule({ ...r, label: r.label.trim() || accountId });
      toast({ title: "배포 규칙을 저장했습니다", description: `${r.label} — 이제 배포 모달에서 고를 수 있습니다.`, tone: "done" });
      await onSaved?.();
      onClose();
    } catch (err) {
      toast({ title: "저장 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/55" onClick={busy ? undefined : onClose} aria-hidden />
      <div
        className="sd-modal relative flex max-h-[88vh] w-full max-w-[520px] flex-col bg-white"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--sd-border)" }}>
          <h2 className="sd-serif text-[14px] font-semibold" style={{ color: "var(--sd-fg)" }}>
            배포 규칙 · {accountLabel}
          </h2>
          <p className="mt-0.5 text-[11px]" style={{ color: "var(--sd-mut)" }}>
            이 채널로 보낼 때 적용할 조건입니다. <b>규칙이 없으면 배포 모달에 이 채널이 뜨지 않습니다.</b>
          </p>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <div>
            <div className="mb-1 text-[11.5px] font-semibold" style={{ color: "var(--sd-fg)" }}>채널 역할</div>
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(ROLE_LABEL) as ChannelRole[]).map((role) => (
                <button
                  key={role}
                  type="button"
                  className={cn("sd-btn", r.role === role && "sd-btn--on")}
                  onClick={() => pickRole(role)}
                  title={ROLE_HINT[role]}
                >
                  {ROLE_LABEL[role]}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[10.5px]" style={{ color: "var(--sd-mut)" }}>{ROLE_HINT[r.role]}</p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Field label="길이 상한(초)" hint="비우면 제한 없음">
              <input
                value={r.maxSec ?? ""}
                onChange={(e) => {
                  setTouched(true);
                  const v = e.target.value.replace(/\D/g, "");
                  set({ maxSec: v === "" ? null : Number(v) });
                }}
                inputMode="numeric"
                className="sd-input w-full"
              />
            </Field>
            <Field label="비율">
              <select
                value={r.aspect}
                onChange={(e) => { setTouched(true); set({ aspect: e.target.value as ChannelRule["aspect"] }); }}
                className="sd-input w-full"
              >
                <option value="any">제한 없음</option>
                <option value="9:16">9:16 (세로)</option>
                <option value="16:9">16:9 (가로)</option>
              </select>
            </Field>
          </div>

          <Field label="제목 접두사">
            <input value={r.titlePrefix} onChange={(e) => set({ titlePrefix: e.target.value })} placeholder="예: [예능]" className="sd-input w-full" />
          </Field>
          <Field label="해시태그 템플릿" hint="{program} {episode} 치환">
            <input value={r.hashtagTemplate} onChange={(e) => set({ hashtagTemplate: e.target.value })} placeholder="#{program} #shorts" className="sd-input w-full" />
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label="말투 프리셋">
              <input value={r.tonePreset} onChange={(e) => set({ tonePreset: e.target.value })} className="sd-input w-full" />
            </Field>
            <Field label="공개 범위">
              <select value={r.privacy} onChange={(e) => set({ privacy: e.target.value as ChannelRule["privacy"] })} className="sd-input w-full">
                <option value="public">공개</option>
                <option value="unlisted">일부 공개</option>
                <option value="private">비공개</option>
              </select>
            </Field>
          </div>

          <Field label="예약 시간대" hint="자유 입력">
            <input value={r.scheduleWindow} onChange={(e) => set({ scheduleWindow: e.target.value })} placeholder="예: 방영 익일 10시" className="sd-input w-full" />
          </Field>

          <label className="flex items-center gap-2 text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
            <input type="checkbox" checked={r.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
            이 채널로 배포 허용 (끄면 배포 모달에서 사유와 함께 선택 불가)
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3" style={{ borderTop: "1px solid var(--sd-border)" }}>
          <button type="button" className="sd-btn" onClick={onClose} disabled={busy}>취소</button>
          <button type="button" className="sd-btn sd-btn-primary" onClick={save} disabled={busy}>
            {busy ? "저장 중…" : "저장"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline gap-1.5">
        <span className="text-[11.5px] font-semibold" style={{ color: "var(--sd-fg)" }}>{label}</span>
        {hint && <span className="text-[10.5px]" style={{ color: "var(--sd-mut)" }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}
