"use client";

/**
 * 배포 모달 (FLOWS F4-1~3 · README §7).
 *
 * 여기서 두 가지가 동시에 걸린다:
 *  1. **게이트** — 권리·심의를 통과하지 않은 미디어는 어느 채널로도 못 나간다(F3).
 *  2. **채널 판정** — 서버 기본값으로 길이·비율·숏폼 여부를 안전하게 확인한다.
 *
 * 둘 다 **사유를 보여 준다.** 채널을 그냥 회색으로 두면 사용자는 왜 안 되는지 몰라
 * 다른 데를 찾아 헤맨다.
 *
 * **다중 선택** — 채널을 플랫폼별로 묶어 보여 주고, 여러 채널을 체크해 **한 번에** 배포한다
 * (하나만 골라도 된다). 서버 계약은 채널당 1콜이라 submit 이 선택 수만큼 publishClips 를 부르고
 * 결과를 합쳐 한 번의 notice 로 보고한다. 예약 시각은 **선택한 모든 채널에 공통** 적용된다.
 *
 * 판정은 서버가 한다. 이 모달은 서버가 준 결과를 그리고, 최종 결과 문구도 서버가 준
 * notice 를 그대로 쓴다 — 화면이 통과로 본 것이 서버 재판정에서 빠질 수 있기 때문이다.
 */
import { useEffect, useMemo, useState } from "react";

import { useToast } from "@/components/ui/toast";
import { useAppData } from "@/lib/data/store";
import {
  fetchChannelEligibility,
  fetchNaverAccounts,
  fetchNaverCategories,
  fetchInstagramAccounts,
  fetchMetaAccounts,
  publishClips,
  type ChannelEligibility,
  type ChannelPublishTarget,
  type NaverAccount,
  type NaverCategory,
  type InstagramAccountInfo,
  type MetaAccountInfo,
  type PublishOutcome,
} from "@/lib/data/api";
import type { DistributionChannel } from "@/lib/constants";
import { humanReserveVerbose, isFutureReserve, isLateNightReserve, nowDatetimeLocal, untilReserve } from "@/lib/reserve-date";
import { cn } from "@/lib/utils";

const PLATFORM_LABEL: Record<string, string> = {
  youtube: "YouTube",
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
  naverclip: "네이버 클립",
};

/** 플랫폼 그룹 렌더 순서 (연결된 것만 그려진다). */
const GROUP_ORDER = ["youtube", "instagram", "facebook", "tiktok", "naverclip"] as const;

/**
 * 채널이 실제로 어떻게 나가는가 —
 *  upload  : 파일이 무조건 올라간다 (YouTube · 네이버).
 *  gate    : 업로드 게이트 ON + 계정 지정일 때만 실제 게시, 아니면 기록만 (IG · FB · TikTok).
 *  record  : 파일이 안 올라가고 상태만 남는다 (알 수 없는 채널 폴백).
 */
type PublishMode = "upload" | "gate" | "record";
function modeFor(platform: string): PublishMode {
  if (platform === "youtube" || platform === "naverclip") return "upload";
  if (platform === "instagram" || platform === "facebook" || platform === "tiktok") return "gate";
  return "record";
}
const MODE_TAG: Record<PublishMode, string | null> = { upload: null, gate: "게이트 시 업로드", record: "기록만" };

type NaverForm = { description: string; primary: string; secondary: string };
const NAVER_FORM_DEFAULT: NaverForm = { description: "", primary: "엔터", secondary: "엔터" };

/** 서버 판정 대상·네이버·IG·FB 를 한 줄짜리 대상으로 정규화한다. */
type Target = {
  key: string;
  platform: string;
  channel: DistributionChannel;
  label: string;
  meta: string[]; // ≤60초 · 9:16 같은 서버 기본 조건
  badges: string[]; // 기본 설정 · 로그인됨
  mode: PublishMode;
  blocked?: string; // 게이트·길이·화면비 부적격 사유
  serverTarget?: ChannelPublishTarget;
  naver?: NaverAccount;
  ig?: InstagramAccountInfo;
  fb?: MetaAccountInfo;
};

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
  const { clips, episodes, programs } = useAppData();
  const [serverTargets, setServerTargets] = useState<ChannelPublishTarget[]>([]);
  const [elig, setElig] = useState<Record<string, ChannelEligibility>>({});
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scheduled, setScheduled] = useState(false);
  const [reserveDate, setReserveDate] = useState("");
  const [busy, setBusy] = useState(false);
  // 네이버·IG·FB — 연결된 세션/계정을 직접 고른다. 서버가 대상 계정을 추측하지 않게 한다.
  const [naverAccounts, setNaverAccounts] = useState<NaverAccount[]>([]);
  const [igAccounts, setIgAccounts] = useState<InstagramAccountInfo[]>([]);
  const [metaPages, setMetaPages] = useState<MetaAccountInfo[]>([]);
  // 네이버 클립은 계정마다 설명(10자+)·카테고리를 따로 받는다 — 대상 key 로 폼을 보관한다.
  // 값은 **부분**이다 — 사람이 건드린 필드만 들어간다(naverForm() 이 기본값과 합쳐 읽는다).
  const [naverForms, setNaverForms] = useState<Record<string, Partial<NaverForm>>>({});
  // 클립 카테고리 분류표. 실패 사유를 들고 있어야 셀렉트가 "사유 없이 비어 있는" 상태가 안 된다.
  const [categories, setCategories] = useState<NaverCategory[]>([]);
  const [catErr, setCatErr] = useState<string | null>(null);
  const subsOf = (primary: string) =>
    categories.find((c) => c.name === primary)?.subs ?? [];

  // 프로그램에 정해 둔 카테고리로 미리 채운다. 이게 없으면 모달이 늘 "엔터/엔터" 를 실어
  // 보내서, 프로그램 설정이 **있어도 절대 안 쓰인다**(페이로드가 항상 이기기 때문).
  // 여러 프로그램의 클립을 한 번에 보내면 추측하지 않는다 — 사람이 고른다.
  const programDefault = useMemo(() => {
    const ids = new Set<string>();
    for (const id of clipIds) {
      const clip = clips.find((c) => c.id === id);
      if (!clip) continue;
      const pid = clip.programId ?? episodes.find((e) => e.id === clip.episodeId)?.programId;
      if (pid) ids.add(pid);
    }
    if (ids.size !== 1) return null;
    return programs.find((p) => p.id === [...ids][0])?.naverCategory ?? null;
  }, [clipIds, clips, episodes, programs]);

  useEffect(() => {
    void fetchNaverCategories()
      .then((c) => { setCategories(c); setCatErr(null); })
      .catch((e) => setCatErr(e instanceof Error ? e.message : String(e)));
    void fetchNaverAccounts()
      .then((r) => setNaverAccounts(r.accounts.filter((a) => a.status !== "disabled" && a.hasSession)))
      .catch(() => setNaverAccounts([]));
    void fetchInstagramAccounts()
      .then((a) => setIgAccounts(a.filter((x) => x.status !== "disconnected")))
      .catch(() => setIgAccounts([]));
    void fetchMetaAccounts()
      .then((a) => setMetaPages(a.filter((x) => x.status !== "disconnected" && x.pageId)))
      .catch(() => setMetaPages([]));
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetchChannelEligibility(clipIds);
        if (!alive) return;
        // 네이버 TV 는 제품에서 제외(2026-08-13). Instagram·Facebook 은 아래에서 계정 단위로
        // 직접 고르므로 서버의 일반 대상 목록에서는 뺀다. 그렇지 않으면 같은 계정이 중복된다.
        setServerTargets(r.rules.filter((x) => !["navertv", "instagram", "facebook"].includes(x.platform)));
        setElig(r.eligibility);
        setLoadErr(null);
      } catch (err) {
        if (alive) setLoadErr(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [clipIds]);

  // 서버 판정 대상 + 연결 계정 → 하나의 대상 리스트. (네이버 TV 는 제외)
  const targets = useMemo<Target[]>(() => {
    const out: Target[] = [];
    for (const target of serverTargets) {
      const key = `${target.platform}:${target.accountId}`;
      const e = elig[key];
      const meta: string[] = [];
      if (target.maxSec != null) meta.push(`≤${target.maxSec}초`);
      if (target.aspect !== "any") meta.push(target.aspect);
      const badges: string[] = [];
      if (target.isDefault) badges.push("기본 설정");
      out.push({
        key,
        platform: target.platform,
        channel: target.platform as DistributionChannel,
        label: target.label,
        meta,
        badges,
        mode: modeFor(target.platform),
        blocked: e && !e.ok ? e.reason || "이 채널로는 보낼 수 없습니다." : undefined,
        serverTarget: target,
      });
    }
    for (const a of naverAccounts.filter((a) => a.target !== "tv")) {
      out.push({
        key: `naver:${a.id}:naverclip`,
        platform: "naverclip",
        channel: "naverclip" as DistributionChannel,
        label: a.label,
        meta: [],
        badges: ["로그인됨"],
        mode: "upload",
        naver: a,
      });
    }
    for (const a of igAccounts) {
      out.push({
        key: `ig:${a.igUserId}`,
        platform: "instagram",
        channel: "instagram" as DistributionChannel,
        label: `@${a.username}`,
        meta: [],
        badges: [],
        mode: "gate",
        ig: a,
      });
    }
    for (const a of metaPages) {
      out.push({
        key: `fb:${a.pageId}`,
        platform: "facebook",
        channel: "facebook" as DistributionChannel,
        label: a.pageName,
        meta: [],
        badges: [],
        mode: "gate",
        fb: a,
      });
    }
    return out;
  }, [serverTargets, elig, naverAccounts, igAccounts, metaPages]);

  // 플랫폼별 그룹 — 고정 순서 먼저, 모르는 플랫폼은 뒤에 그대로.
  const groups = useMemo(() => {
    const out: { platform: string; items: Target[] }[] = [];
    for (const p of GROUP_ORDER) {
      const items = targets.filter((t) => t.platform === p);
      if (items.length) out.push({ platform: p, items });
    }
    for (const t of targets) {
      if ((GROUP_ORDER as readonly string[]).includes(t.platform)) continue;
      let g = out.find((x) => x.platform === t.platform);
      if (!g) out.push((g = { platform: t.platform, items: [] }));
      g.items.push(t);
    }
    return out;
  }, [targets]);

  const selectable = useMemo(() => targets.filter((t) => !t.blocked), [targets]);
  const chosen = useMemo(() => selectable.filter((t) => selected.has(t.key)), [selectable, selected]);
  const allOn = selectable.length > 0 && chosen.length === selectable.length;

  // ⚠️ 저장하는 건 **사람이 실제로 바꾼 필드뿐**이고, 기본값은 읽을 때 합친다.
  // 완성본을 통째로 저장하면 첫 입력 때 나머지 필드가 그 시점의 기본값으로 굳는다 —
  // 설명을 한 글자 치는 순간 프로그램 카테고리가 엔터/엔터로 되돌아갔다(설명은 필수라
  // 매 발행마다 일어난다). 이렇게 두면 프로그램 목록이 늦게 도착해도 안 건드린 필드는 따라온다.
  const naverForm = (key: string): NaverForm => ({
    ...NAVER_FORM_DEFAULT,
    ...(programDefault ?? {}),
    ...(naverForms[key] ?? {}),
  });
  // 선택된 네이버 클립 중 설명이 10자 미만인 게 하나라도 있으면 막는다.
  const naverShort = chosen.some((t) => t.naver && naverForm(t.key).description.trim().length < 10);
  const canSubmit = chosen.length > 0 && !naverShort && !busy;
  const gateChosen = chosen.filter((t) => t.mode !== "upload");

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function toggleAll() {
    setSelected(allOn ? new Set() : new Set(selectable.map((t) => t.key)));
  }
  function patchNaver(key: string, patch: Partial<NaverForm>) {
    // 기본값을 섞지 않는다 — 여기 들어간 값은 "사람이 정한 것" 이라는 뜻이고,
    // 나머지는 naverForm() 이 읽을 때 채운다.
    setNaverForms((prev) => ({ ...prev, [key]: { ...(prev[key] ?? {}), ...patch } }));
  }

  function buildOpts(t: Target): Parameters<typeof publishClips>[2] {
    const base: Parameters<typeof publishClips>[2] = {
      scheduled,
      ...(scheduled && reserveDate ? { reserveDate } : {}),
    };
    // 고른 행이 곧 대상 채널·계정이다 — 서버가 추측하지 않게 명시한다(다계정 오배포 방지).
    if (t.serverTarget?.platform === "youtube") return { ...base, youtubeChannelId: t.serverTarget.accountId };
    if (t.serverTarget?.platform === "tiktok") {
      return { ...base, ...(t.serverTarget.accountId ? { tiktokOpenId: t.serverTarget.accountId } : {}) };
    }
    if (t.naver) {
      const f = naverForm(t.key);
      return { ...base, naverAccountId: t.naver.id, description: f.description.trim(), naverCategory: { primary: f.primary, secondary: f.secondary } };
    }
    if (t.ig) return { ...base, igUserId: t.ig.igUserId };
    if (t.fb) return { ...base, metaPageId: t.fb.pageId };
    return base;
  }

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      // 채널당 1콜. 하나 실패가 나머지를 막지 않게 allSettled 로 모아 한 번에 보고한다.
      const settled = await Promise.allSettled(chosen.map((t) => publishClips(clipIds, t.channel, buildOpts(t))));
      const okResults = settled
        .filter((s): s is PromiseFulfilledResult<PublishOutcome> => s.status === "fulfilled")
        .map((s) => s.value);
      const failCount = settled.length - okResults.length;

      if (okResults.length === 0) {
        const firstErr = settled.find((s) => s.status === "rejected") as PromiseRejectedResult | undefined;
        const reason = firstErr?.reason;
        toast({
          title: "배포 실패",
          description: reason instanceof Error ? reason.message : reason ? String(reason) : "모든 채널 배포에 실패했습니다.",
          tone: "error",
        });
        setBusy(false);
        return;
      }

      const notices = okResults.map((r) => r.notice).filter(Boolean);
      const anySkipped = okResults.some((r) => r.skipped.length > 0);
      toast({
        title:
          failCount > 0
            ? `${okResults.length}개 채널 배포 · ${failCount}개 실패`
            : `${okResults.length}개 채널로 ${scheduled ? "예약" : "배포"}했습니다`,
        description:
          notices.join(" · ") ||
          (scheduled ? "예약 시각에 발행됩니다." : "배포 화면에서 진행 상황을 볼 수 있습니다."),
        tone: failCount > 0 ? "error" : anySkipped ? "warn" : "done",
      });
      await onDone?.();
      onClose();
    } catch (err) {
      toast({ title: "배포 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
      setBusy(false);
    }
  }

  const empty = groups.length === 0 && !loadErr;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/55" onClick={busy ? undefined : onClose} aria-hidden />
      <div
        className="sd-modal relative flex max-h-[88vh] w-full max-w-[560px] flex-col bg-[var(--sd-card)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3" style={{ borderBottom: "1px solid var(--sd-border)" }}>
          <div>
            <h2 className="sd-serif text-[14px] font-semibold" style={{ color: "var(--sd-fg)" }}>
              배포 · 클립 {clipIds.length}건
            </h2>
            <p className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
              채널을 골라 한 번에 배포 — 하나만 골라도, 여러 개 골라도 됩니다.
            </p>
          </div>
          {selectable.length > 0 && (
            <button type="button" className="sd-btn text-[11.5px]" onClick={toggleAll} disabled={busy}>
              {allOn ? "모두 해제" : "모두 선택"}
            </button>
          )}
        </div>

        <div className="flex-1 space-y-3.5 overflow-y-auto p-4">
          {loadErr && (
            <p className="text-[11.5px]" style={{ color: "var(--sd-danger-strong)" }}>
              채널 정보를 불러오지 못했습니다 ({loadErr}).
            </p>
          )}

          {/* 서버가 연결된 채널을 안전 기본값과 함께 돌려주므로, 비어 있으면 연결 자체가 없는 것이다. */}
          {empty && (
            <p className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
              보낼 수 있는 채널이 없습니다 — 배포 채널 화면에서 채널을 먼저 연결하세요.
              연결된 채널은 안전한 기본 설정으로 배포됩니다.
            </p>
          )}

          {groups.map((g) => (
            <div key={g.platform} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="sd-eb" style={{ color: "var(--sd-label)" }}>
                  {PLATFORM_LABEL[g.platform] ?? g.platform}
                </span>
                <span className="text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                  {g.items.length}개
                </span>
              </div>
              {g.items.map((t) => {
                const on = selected.has(t.key);
                const blocked = Boolean(t.blocked);
                const modeTag = MODE_TAG[t.mode];
                return (
                  <div key={t.key} className="flex flex-col gap-1.5">
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      disabled={blocked}
                      onClick={() => toggle(t.key)}
                      className={cn("flex items-start gap-2.5 rounded-[5px] px-3 py-2 text-left", on && "sd-btn--on")}
                      style={{
                        border: `1px solid ${on ? "var(--sd-accent-border)" : "var(--sd-border)"}`,
                        opacity: blocked ? 0.6 : 1,
                        cursor: blocked ? "not-allowed" : "pointer",
                      }}
                    >
                      <span
                        aria-hidden
                        className="mt-[2px] flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[3px] text-[10px] font-bold"
                        style={{
                          border: `1.5px solid ${on ? "var(--sd-accent-border)" : "var(--sd-border-strong, var(--sd-border))"}`,
                          background: on ? "var(--sd-accent-border)" : "transparent",
                          color: on ? "var(--sd-on-accent)" : "transparent",
                        }}
                      >
                        ✓
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[12.5px] font-medium" style={{ color: "var(--sd-fg)" }}>
                            {t.label}
                          </span>
                          {modeTag && <span className="sd-tag">{modeTag}</span>}
                          {t.badges.map((b) => (
                            <span key={b} className="sd-tag" title={b === "기본 설정" ? "채널의 안전한 기본 설정으로 나갑니다" : undefined}>
                              {b}
                            </span>
                          ))}
                          {t.meta.map((m) => (
                            <span key={m} className="sd-tag sd-mono">
                              {m}
                            </span>
                          ))}
                        </span>
                        {/* 못 고르는 이유를 반드시 적는다 (F4-2). */}
                        {blocked && (
                          <span className="text-[11px]" style={{ color: "var(--sd-danger-strong)" }}>
                            {t.blocked}
                          </span>
                        )}
                      </span>
                    </button>

                    {/* 네이버 클립 — 선택 시 설명·카테고리를 인라인으로 받는다 (계정마다 따로). */}
                    {t.naver && on && (
                      <div
                        className="ml-[26px] flex flex-col gap-2 rounded-[5px] p-3"
                        style={{ background: "var(--sd-card-sub)", border: "1px solid var(--sd-border)" }}
                      >
                        <label className="text-[11.5px]" style={{ color: "var(--sd-fg)" }}>
                          설명 <span style={{ color: "var(--sd-mut)" }}>(10자 이상 필수)</span>
                          <textarea
                            value={naverForm(t.key).description}
                            onChange={(e) => patchNaver(t.key, { description: e.target.value })}
                            rows={2}
                            placeholder="영상 설명을 입력하세요"
                            className="sd-input mt-1 w-full"
                          />
                        </label>
                        {naverForm(t.key).description.trim().length < 10 && (
                          <p className="text-[10.5px]" style={{ color: "var(--sd-danger-strong)" }}>
                            네이버 클립은 설명이 10자 이상이어야 등록됩니다 (현재 {naverForm(t.key).description.trim().length}자).
                          </p>
                        )}
                        {/* 1차를 고르면 2차 목록이 그 1차의 것으로 바뀐다. 자유입력이던 시절엔
                            목록에 없는 값이 그대로 넘어가 엉뚱한 분류로 발행됐다. */}
                        <div className="grid grid-cols-2 gap-2">
                          <label className="text-[11.5px]" style={{ color: "var(--sd-fg)" }}>
                            카테고리 1차
                            <select
                              value={naverForm(t.key).primary}
                              onChange={(e) => patchNaver(t.key, {
                                primary: e.target.value,
                                // 1차가 바뀌면 2차는 반드시 다시 고른다 — 남겨두면 "엔터/맛집"
                                // 같은 조합이 되고, 그건 발행 직전에야 거부된다.
                                secondary: subsOf(e.target.value)[0]?.name ?? "",
                              })}
                              className="sd-input mt-1 w-full"
                              disabled={!categories.length}
                            >
                              {categories.map((c) => (
                                <option key={c.no} value={c.name}>{c.name}</option>
                              ))}
                            </select>
                          </label>
                          <label className="text-[11.5px]" style={{ color: "var(--sd-fg)" }}>
                            카테고리 2차
                            <select
                              value={naverForm(t.key).secondary}
                              onChange={(e) => patchNaver(t.key, { secondary: e.target.value })}
                              className="sd-input mt-1 w-full"
                              disabled={!categories.length}
                            >
                              {subsOf(naverForm(t.key).primary).map((s) => (
                                <option key={s.no} value={s.name}>{s.name}</option>
                              ))}
                            </select>
                          </label>
                        </div>
                        {/* 목록을 못 받아오면 셀렉트가 사유 없이 비어 보인다 — 이유를 적는다. */}
                        {catErr && (
                          <p className="text-[10.5px]" style={{ color: "var(--sd-danger-strong)" }}>
                            카테고리 목록을 불러오지 못했습니다 ({catErr}) — 발행을 진행하면
                            기본값(엔터/엔터)으로 올라갑니다.
                          </p>
                        )}
                        <p className="text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                          사무실 워커 PC 가 이 계정의 로그인 세션으로 실제 업로드합니다.
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}

          {/* 공통 예약 — 선택한 모든 채널에 같은 시각을 적용한다. */}
          {chosen.length > 0 && (
            <div
              className="flex flex-col gap-2 rounded-[5px] p-3"
              style={{ background: "var(--sd-card-sub)", border: "1px solid var(--sd-border)" }}
            >
              <label className="flex items-center gap-2 text-[11.5px]" style={{ color: "var(--sd-fg)" }}>
                <input
                  type="checkbox"
                  checked={scheduled}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setScheduled(on);
                    if (on && !reserveDate) setReserveDate(nowDatetimeLocal());
                  }}
                />
                예약 발행 <span style={{ color: "var(--sd-mut)" }}>(선택한 {chosen.length}개 채널 공통)</span>
              </label>
              {scheduled && (
                <>
                  <input
                    type="datetime-local"
                    min={nowDatetimeLocal()}
                    value={reserveDate}
                    onChange={(e) => setReserveDate(e.target.value)}
                    className="sd-input w-full"
                  />
                  {/* 서버와 같은 판정(isFutureReserve)으로 예약/즉시를 미리 보여 준다 — 화면이 결과와 어긋나지 않게. */}
                  {isFutureReserve(reserveDate) ? (
                    <>
                      {/* 오전/오후를 말로 못 박고 "몇 시간 뒤"를 같이 준다 — 오전 12시(자정)를
                          정오로 착각하는 12시간 오차가 여기서 바로 드러난다. */}
                      <p className="text-[11px]" style={{ color: "var(--sd-fg)" }}>
                        예약: <b>{humanReserveVerbose(reserveDate)}</b>{" "}
                        <span style={{ color: "var(--sd-mut)" }}>· {untilReserve(reserveDate)}</span>
                      </p>
                      {isLateNightReserve(reserveDate) && (
                        <p
                          role="alert"
                          className="rounded-md px-2 py-1.5 text-[10.5px] leading-relaxed"
                          style={{ color: "var(--sd-warn)", background: "var(--sd-warn-bg)", border: "1px solid var(--sd-warn-border)" }}
                        >
                          <b>새벽 시간대입니다.</b> 낮 12시를 원하셨다면 시각 선택에서 <b>오후</b>를 골라야 합니다 —
                          <b>오전 12시는 자정(00:00)</b>입니다.
                        </p>
                      )}
                      <p className="text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                        YouTube·네이버·Facebook 은 플랫폼이 그 시각에 공개(네이티브 예약),
                        Instagram·TikTok 은 그 시각까지 대기했다가 자동 게시합니다.
                      </p>
                    </>
                  ) : (
                    <p className="text-[10.5px]" style={{ color: "var(--sd-warn)" }}>
                      시각이 비었거나 과거예요 — 이대로 배포하면 <b>즉시 발행</b>됩니다.
                    </p>
                  )}
                </>
              )}
              {/* F4-3 ⚑ — 게이트/기록만 채널이 섞였으면 명확히 알린다. */}
              {gateChosen.length > 0 && (
                <p
                  className="rounded-[4px] px-2.5 py-2 text-[11px] leading-relaxed"
                  style={{ border: "1px solid var(--sd-warn-border)", background: "var(--sd-warn-bg)", color: "var(--sd-warn)" }}
                >
                  <b>{gateChosen.map((t) => PLATFORM_LABEL[t.platform] ?? t.platform).filter((v, i, a) => a.indexOf(v) === i).join(" · ")}</b>{" "}
                  는 업로드 게이트가 켜져 있을 때만 실제 게시됩니다. 꺼져 있으면 <b>기록됨</b> 상태만 남습니다
                  (실제 결과는 완료 메시지에 표시).
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-4 py-3" style={{ borderTop: "1px solid var(--sd-border)" }}>
          <span className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
            {chosen.length > 0 ? `${chosen.length}개 채널 선택됨` : "채널을 선택하세요"}
          </span>
          <div className="flex items-center gap-2">
            <button type="button" className="sd-btn" onClick={onClose} disabled={busy}>
              취소
            </button>
            <button type="button" className="sd-btn sd-btn-primary" disabled={!canSubmit} onClick={submit}>
              {busy ? "보내는 중…" : chosen.length === 0 ? "배포" : scheduled ? `${chosen.length}곳 예약 배포` : `${chosen.length}곳에 배포`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
