"use client";

/**
 * 채널 배포 규칙 — 연결된 계정 하나에 붙는 "이 채널로 보낼 때의 조건" (FLOWS F4-2).
 *
 * **연결(OAuth)과 규칙은 다른 것이다.** 연결은 "우리가 이 채널에 올릴 수 있다"이고,
 * 규칙은 "무엇을, 어떤 모양으로 올릴 것인가"다. 규칙이 없어도 서버가 기본 규칙을
 * 합성해 배포는 된다(index.ts eligibility) — 규칙은 조건을 다듬는 도구라서, 연결
 * 화면에서 바로 붙일 수 있게 이 다이얼로그를 옛 화면과 새 화면이 함께 쓴다.
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
  // 저장은 전체 upsert 다 — 기존 규칙을 못 읽은 채 저장하면 기본값으로 초기화된다.
  // 그래서 로드가 끝나기 전/실패했을 때는 저장을 막는다.
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
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
    // 공개 유예 기본 5분 — 서버 channel-rules.ts::DEFAULT_PUBLISH_DELAY_MIN 과 같은 값.
    publishDelayMin: 5,
    scheduleWindow: "",
    enabled: true,
  });

  // 이미 규칙이 있으면 그 값으로 연다 — 새로 만드는 줄 알고 덮어쓰면 안 된다.
  useEffect(() => {
    let alive = true;
    setLoadState("loading");
    void fetchChannelRules()
      .then((all) => {
        if (!alive) return;
        const found = all.find((x) => x.platform === platform && x.accountId === accountId);
        if (found) setR(found);
        setLoadErr(null);
        setLoadState("ready");
      })
      .catch((err) => {
        if (!alive) return;
        setLoadErr(err instanceof Error ? err.message : String(err));
        setLoadState("error");
      });
    return () => { alive = false; };
  }, [platform, accountId, reloadKey]);

  const set = (patch: Partial<ChannelRule>) => setR((prev) => ({ ...prev, ...patch }));

  /** 역할을 고르면 그 역할의 기본값이 들어온다. 단 사람이 손댄 뒤엔 덮지 않는다. */
  function pickRole(role: ChannelRole) {
    if (touched) { set({ role }); return; }
    if (role === "shorts_only") set({ role, aspect: "9:16", maxSec: platform === "youtube" ? 60 : 90 });
    else if (platform === "navertv") set({ role, aspect: "16:9", maxSec: 180 });
    else if (platform === "naverclip") set({ role, aspect: "9:16", maxSec: 90 });
    else set({ role, aspect: "any", maxSec: null });
  }

  async function save() {
    setBusy(true);
    try {
      await saveChannelRule({ ...r, label: r.label.trim() || accountId });
      toast({ title: "배포 규칙을 저장했습니다", description: `${r.label} — 이 채널 배포에 이 규칙이 적용됩니다.`, tone: "done" });
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
        className="sd-modal relative flex max-h-[88vh] w-full max-w-[520px] flex-col bg-[var(--sd-card)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--sd-border)" }}>
          <h2 className="sd-serif text-[14px] font-semibold" style={{ color: "var(--sd-fg)" }}>
            배포 규칙 · {accountLabel}
          </h2>
          <p className="mt-0.5 text-[11px]" style={{ color: "var(--sd-mut)" }}>
            이 채널로 보낼 때 적용할 조건입니다. 규칙이 없으면 기본 규칙으로 배포됩니다 — 필요할 때만 커스텀하세요.
          </p>
          {loadState === "error" && (
            <div
              className="mt-2 flex flex-wrap items-center gap-2 rounded-[4px] px-2.5 py-2 text-[11px]"
              style={{ border: "1px solid var(--sd-danger-border)", background: "var(--sd-danger-bg)", color: "var(--sd-danger-strong)" }}
            >
              <span>
                기존 규칙을 불러오지 못했습니다 ({loadErr}) — 기본값으로 덮어쓰는 것을 막기 위해 <b>저장을 막았습니다.</b>{" "}
                다시 불러오기를 눌러 주세요.
              </span>
              <button type="button" className="sd-btn ml-auto" onClick={() => setReloadKey((k) => k + 1)}>
                다시 불러오기
              </button>
            </div>
          )}
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

          {/* 공개 유예 — 유튜브 예약(publishAt)으로 구현. 공개 범위가 '공개'일 때만 걸린다
              (일부공개·비공개는 예약이 결국 공개로 끝나 의도가 바뀐다 — 서버가 막는다). */}
          {r.platform === "youtube" && (
            <Field
              label="공개 유예 (분)"
              hint={r.privacy === "public" ? "5분 단위 · 0 = 즉시 공개" : "공개 범위가 '공개'일 때만 적용됩니다"}
            >
              {/* 5분 단위만 — 유튜브 예약이 격자를 벗어난 시각을 거부·보정하는 사례가 있다.
                  서버도 올림으로 한 번 더 맞추지만(normalizePublishDelayMin), 고른 값과 실제
                  동작이 달라지지 않게 여기서부터 격자로 준다. */}
              <input
                type="number"
                min={0}
                max={360}
                step={5}
                value={r.publishDelayMin ?? 5}
                onChange={(e) => {
                  const n = Math.max(0, Math.min(360, Number(e.target.value) || 0));
                  set({ publishDelayMin: n === 0 ? 0 : Math.ceil(n / 5) * 5 });
                }}
                disabled={r.privacy !== "public"}
                className="sd-input w-full"
              />
              <p className="mt-1 text-[11px]" style={{ color: "var(--sd-mut)" }}>
                올린 뒤 이 시간만큼 비공개로 두었다가 유튜브가 스스로 공개합니다. 업로드 직후엔
                HD 변환이 안 끝나 있고 썸네일도 그 뒤에 붙어서, 바로 공개하면 첫 시청자가
                저화질·기본 썸네일로 봅니다.
              </p>
            </Field>
          )}

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
          <button
            type="button"
            className="sd-btn sd-btn-primary"
            onClick={save}
            disabled={busy || loadState !== "ready"}
            title={
              loadState === "error"
                ? "기존 규칙을 읽지 못해 저장을 막았습니다 — 다시 불러오기를 누르세요"
                : loadState === "loading"
                  ? "기존 규칙을 불러오는 중입니다"
                  : undefined
            }
          >
            {busy ? "저장 중…" : loadState === "loading" ? "불러오는 중…" : "저장"}
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
