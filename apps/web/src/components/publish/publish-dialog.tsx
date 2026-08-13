"use client";

/**
 * 배포 모달 (FLOWS F4-1~3 · README §7).
 *
 * 여기서 두 가지가 동시에 걸린다:
 *  1. **게이트** — 권리·심의를 통과하지 않은 미디어는 어느 채널로도 못 나간다(F3).
 *  2. **채널 규칙** — 길이 상한·비율·숏폼 전용은 채널마다 다르다(F4-2).
 *
 * 둘 다 **사유를 보여 준다.** 채널을 그냥 회색으로 두면 사용자는 왜 안 되는지 몰라
 * 다른 데를 찾아 헤맨다.
 *
 * 판정은 서버가 한다. 이 모달은 서버가 준 결과를 그리고, 최종 결과 문구도 서버가 준
 * notice 를 그대로 쓴다 — 화면이 통과로 본 것이 서버 재판정에서 빠질 수 있기 때문이다.
 */
import { useEffect, useMemo, useState } from "react";

import { useToast } from "@/components/ui/toast";
import {
  fetchChannelEligibility,
  fetchNaverAccounts,
  publishClips,
  type ChannelEligibility,
  type ChannelRule,
  type NaverAccount,
} from "@/lib/data/api";
import type { DistributionChannel } from "@/lib/constants";
import { cn } from "@/lib/utils";

const PLATFORM_LABEL: Record<string, string> = {
  youtube: "YouTube",
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
  naverclip: "네이버 클립",
};

/** 실제 파일이 올라가는 곳 (F4-3). 네이버는 브라우저 자동화지만 파일이 실제로 올라간다. */
const UPLOAD_PLATFORMS = new Set(["youtube", "naverclip"]);

export function PublishDialog({
  clipIds,
  onClose,
  onDone,
}: {
  clipIds: string[];
  onClose: () => void;
  onDone?: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const [rules, setRules] = useState<ChannelRule[]>([]);
  const [elig, setElig] = useState<Record<string, ChannelEligibility>>({});
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState(false);
  const [reserveDate, setReserveDate] = useState("");
  const [busy, setBusy] = useState(false);
  // 네이버 — 세션이 등록된 계정으로 바로 올린다 (채널 규칙이 없어도 배포 가능해야 한다).
  const [naverAccounts, setNaverAccounts] = useState<NaverAccount[]>([]);
  const [naverDesc, setNaverDesc] = useState("");
  const [naverCat, setNaverCat] = useState<{ primary: string; secondary: string }>({ primary: "엔터", secondary: "엔터" });

  useEffect(() => {
    void fetchNaverAccounts()
      .then((r) => setNaverAccounts(r.accounts.filter((a) => a.status !== "disabled" && a.hasSession)))
      .catch(() => setNaverAccounts([]));
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetchChannelEligibility(clipIds);
        if (!alive) return;
        // 네이버 TV 는 제품에서 제외됐다 (2026-08-13) — 옛 규칙이 남아 있어도 새 배포 대상으로 안 내놓는다.
        setRules(r.rules.filter((x) => x.platform !== "navertv"));
        setElig(r.eligibility);
        setLoadErr(null);
      } catch (err) {
        if (alive) setLoadErr(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { alive = false; };
  }, [clipIds]);

  const rule = useMemo(() => rules.find((r) => `${r.platform}:${r.accountId}` === picked), [rules, picked]);
  // 네이버 계정 직접 선택 행 — key = "naver:<계정id>:naverclip" (TV 는 제품에서 제외)
  const naverPick = useMemo(() => {
    if (!picked?.startsWith("naver:")) return null;
    const [, id] = picked.split(":");
    const acct = naverAccounts.find((a) => a.id === id);
    return acct ? { acct, channel: "naverclip" as const } : null;
  }, [picked, naverAccounts]);
  const ok = naverPick ? true : picked ? elig[picked]?.ok : false;
  const isUpload = naverPick ? true : rule ? UPLOAD_PLATFORMS.has(rule.platform) : false;
  const naverDescShort = naverPick?.channel === "naverclip" && naverDesc.trim().length < 10;

  // 채널을 고르면 그 채널의 규칙이 즉시 폼에 반영된다 (F4-2).
  useEffect(() => {
    if (!rule) return;
    setScheduled(Boolean(rule.scheduleWindow));
  }, [rule]);

  async function submit() {
    if ((!rule && !naverPick) || !ok) return;
    if (naverDescShort) return;
    setBusy(true);
    try {
      const channel = (naverPick ? naverPick.channel : rule!.platform) as DistributionChannel;
      const res = await publishClips(clipIds, channel, {
        scheduled,
        ...(scheduled && reserveDate ? { reserveDate } : {}),
        // 고른 행이 곧 대상 채널이다 — 게시 가능 채널이 여럿일 때 서버가 추측하지 않게 명시한다.
        ...(rule?.platform === "youtube" ? { youtubeChannelId: rule.accountId } : {}),
        ...(naverPick ? {
          naverAccountId: naverPick.acct.id,
          description: naverDesc.trim(),
          ...(naverPick.channel === "naverclip" ? { naverCategory: naverCat } : {}),
        } : {}),
      });
      toast({
        title: isUpload ? "업로드를 시작했습니다" : "배포 기록을 남겼습니다",
        description:
          res.notice ||
          (isUpload ? "배포 화면에서 진행 상황을 볼 수 있습니다." : "실제 게시는 담당자가 해당 앱에서 직접 해야 합니다."),
        tone: res.skipped.length > 0 ? "warn" : "done",
      });
      await onDone?.();
      onClose();
    } catch (err) {
      toast({ title: "배포 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/55" onClick={busy ? undefined : onClose} aria-hidden />
      <div
        className="sd-modal relative flex max-h-[88vh] w-full max-w-[560px] flex-col bg-white"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--sd-border)" }}>
          <h2 className="sd-serif text-[14px] font-semibold" style={{ color: "var(--sd-fg)" }}>
            배포 · {clipIds.length}건
          </h2>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {loadErr && (
            <p className="text-[11.5px]" style={{ color: "var(--sd-danger-strong)" }}>
              채널 규칙을 불러오지 못했습니다 ({loadErr}).
            </p>
          )}

          {/* 서버가 연결된 채널을 기본 규칙으로 합성해 주므로, 여기가 비면 연결 자체가 없는 것이다. */}
          {rules.length === 0 && naverAccounts.length === 0 && !loadErr && (
            <p className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
              보낼 수 있는 채널이 없습니다 — 배포 채널 화면에서 채널을 먼저 연결하세요.
              (규칙은 없어도 됩니다 — 연결만 되면 기본 설정으로 나갑니다.)
            </p>
          )}

          <div className="flex flex-col gap-1.5">
            {rules.map((r) => {
              const key = `${r.platform}:${r.accountId}`;
              const e = elig[key];
              const blocked = !e?.ok;
              return (
                <button
                  key={key}
                  type="button"
                  disabled={blocked}
                  onClick={() => setPicked(key)}
                  className={cn(
                    "flex flex-col gap-1 rounded-[5px] px-3 py-2 text-left",
                    picked === key && "sd-btn--on",
                  )}
                  style={{
                    border: `1px solid ${picked === key ? "var(--sd-accent-border)" : "var(--sd-border)"}`,
                    opacity: blocked ? 0.6 : 1,
                    cursor: blocked ? "not-allowed" : "pointer",
                  }}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12.5px] font-medium" style={{ color: "var(--sd-fg)" }}>
                      {r.label}
                    </span>
                    <span className="sd-tag">{PLATFORM_LABEL[r.platform] ?? r.platform}</span>
                    {!UPLOAD_PLATFORMS.has(r.platform) && <span className="sd-tag">기록만</span>}
                    {r.isDefault && <span className="sd-tag" title="저장된 규칙이 없어 기본 설정으로 나갑니다">기본 규칙</span>}
                    {r.maxSec != null && <span className="sd-tag sd-mono">≤{r.maxSec}초</span>}
                    {r.aspect !== "any" && <span className="sd-tag sd-mono">{r.aspect}</span>}
                  </div>
                  {/* 못 고르는 이유를 반드시 적는다 (F4-2). */}
                  {blocked && (
                    <span className="text-[11px]" style={{ color: "var(--sd-danger-strong)" }}>
                      {e?.reason ?? "이 채널로는 보낼 수 없습니다."}
                    </span>
                  )}
                </button>
              );
            })}
            {/* 네이버 클립 — 세션 등록된 계정으로 직접 업로드 (채널 규칙 불필요 · TV 는 제품에서 제외) */}
            {naverAccounts.filter((a) => a.target !== "tv").map((a) => {
              const key = `naver:${a.id}:naverclip`;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setPicked(key)}
                  className={cn(
                    "flex flex-col gap-1 rounded-[5px] px-3 py-2 text-left",
                    picked === key && "sd-btn--on",
                  )}
                  style={{
                    border: `1px solid ${picked === key ? "var(--sd-accent-border)" : "var(--sd-border)"}`,
                    cursor: "pointer",
                  }}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12.5px] font-medium" style={{ color: "var(--sd-fg)" }}>{a.label}</span>
                    <span className="sd-tag">{PLATFORM_LABEL.naverclip}</span>
                    <span className="sd-tag">로그인됨</span>
                  </div>
                </button>
              );
            })}
          </div>

          {naverPick && (
            <div
              className="flex flex-col gap-2 rounded-[5px] p-3"
              style={{ background: "var(--sd-card-sub)", border: "1px solid var(--sd-border)" }}
            >
              <div className="sd-eb" style={{ color: "var(--sd-label)" }}>
                {PLATFORM_LABEL[naverPick.channel]} · {naverPick.acct.label}
              </div>
              <label className="text-[11.5px]" style={{ color: "var(--sd-fg)" }}>
                설명 {naverPick.channel === "naverclip" && <span style={{ color: "var(--sd-mut)" }}>(10자 이상 필수)</span>}
                <textarea
                  value={naverDesc}
                  onChange={(e) => setNaverDesc(e.target.value)}
                  rows={2}
                  placeholder="영상 설명을 입력하세요"
                  className="sd-input mt-1 w-full"
                />
              </label>
              {naverDescShort && (
                <p className="text-[10.5px]" style={{ color: "var(--sd-danger-strong)" }}>
                  네이버 클립은 설명이 10자 이상이어야 등록됩니다 (현재 {naverDesc.trim().length}자).
                </p>
              )}
              {naverPick.channel === "naverclip" && (
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-[11.5px]" style={{ color: "var(--sd-fg)" }}>
                    카테고리 1차
                    <input value={naverCat.primary}
                      onChange={(e) => setNaverCat({ ...naverCat, primary: e.target.value })}
                      className="sd-input mt-1 w-full" />
                  </label>
                  <label className="text-[11.5px]" style={{ color: "var(--sd-fg)" }}>
                    카테고리 2차
                    <input value={naverCat.secondary}
                      onChange={(e) => setNaverCat({ ...naverCat, secondary: e.target.value })}
                      className="sd-input mt-1 w-full" />
                  </label>
                </div>
              )}
              <p className="text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                사무실 워커 PC 가 이 계정의 로그인 세션으로 실제 업로드합니다.
              </p>
            </div>
          )}

          {rule && ok && (
            <div
              className="flex flex-col gap-2 rounded-[5px] p-3"
              style={{ background: "var(--sd-card-sub)", border: "1px solid var(--sd-border)" }}
            >
              <div className="sd-eb" style={{ color: "var(--sd-label)" }}>적용될 규칙</div>
              <dl className="grid grid-cols-[80px_1fr] gap-x-2 gap-y-1 text-[11.5px]">
                <dt style={{ color: "var(--sd-mut)" }}>제목 접두</dt>
                <dd style={{ color: "var(--sd-fg)" }}>{rule.titlePrefix || "—"}</dd>
                <dt style={{ color: "var(--sd-mut)" }}>해시태그</dt>
                <dd style={{ color: "var(--sd-fg)" }}>{rule.hashtagTemplate || "—"}</dd>
                <dt style={{ color: "var(--sd-mut)" }}>말투</dt>
                <dd style={{ color: "var(--sd-fg)" }}>{rule.tonePreset || "—"}</dd>
                <dt style={{ color: "var(--sd-mut)" }}>공개 범위</dt>
                <dd style={{ color: "var(--sd-fg)" }}>
                  {{ public: "공개", unlisted: "일부 공개", private: "비공개" }[rule.privacy]}
                </dd>
              </dl>

              <label className="flex items-center gap-2 text-[11.5px]" style={{ color: "var(--sd-fg)" }}>
                <input type="checkbox" checked={scheduled} onChange={(e) => setScheduled(e.target.checked)} />
                예약 발행{rule.scheduleWindow ? ` (채널 기본 ${rule.scheduleWindow})` : ""}
              </label>
              {scheduled && (
                <>
                  <input
                    type="datetime-local"
                    value={reserveDate}
                    onChange={(e) => setReserveDate(e.target.value)}
                    className="sd-input w-full"
                  />
                  <p className="text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                    미래 시각으로 읽힐 때만 예약이 걸립니다. 과거·빈값이면 즉시 발행됩니다.
                  </p>
                </>
              )}

              {/* F4-3 ⚑ — 기록만 하는 채널은 반드시 이 문장을 보여 준다. */}
              {!isUpload && (
                <p
                  className="rounded-[4px] px-2.5 py-2 text-[11.5px] leading-relaxed"
                  style={{ border: "1px solid var(--sd-warn-border)", background: "var(--sd-warn-bg)", color: "var(--sd-warn)" }}
                >
                  이 채널은 <b>파일이 올라가지 않습니다.</b> 우리 쪽에 `기록됨` 상태만 남고,
                  <b> 실제 게시는 담당자가 {PLATFORM_LABEL[rule.platform] ?? rule.platform} 앱에서 직접</b> 해야 합니다.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3" style={{ borderTop: "1px solid var(--sd-border)" }}>
          <button type="button" className="sd-btn" onClick={onClose} disabled={busy}>취소</button>
          <button
            type="button"
            className="sd-btn sd-btn-primary"
            disabled={busy || (!rule && !naverPick) || !ok || naverDescShort}
            onClick={submit}
          >
            {busy ? "보내는 중…" : isUpload ? "업로드 시작" : "배포 기록"}
          </button>
        </div>
      </div>
    </div>
  );
}
