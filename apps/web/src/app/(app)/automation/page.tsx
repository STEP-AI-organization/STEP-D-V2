"use client";

/**
 * U12 · 자동 배포 — 디자인 기준 단일 세로 파이프라인 (Main.dc.html · 2026-08-24).
 *
 * 위에서 아래로 사람이 정하는 것 → 시스템이 하는 것 순서다:
 *   ① 프로그램 선택 → ② 할당 영상 → ③ 배포 설정 → 시작 → 스케줄·대기·완료.
 *
 * 지키는 것(재배치 전과 동일):
 *  - 계획 하나 = 프로그램 ↔ 채널 연결 하나. **계획이 없으면 아무것도 하지 않는다.**
 *  - 승인 대기 건은 **사람이 승인해야** 다음 확인 때 게시된다. 저절로 나가지 않는다.
 *  - 문구에서 내부어(순방·워커·게이트)를 쓰지 않는다 — 확인(10분마다 자동)·승인·실제 업로드
 *    잠금/권리 확인으로 말한다.
 *  - 서버 확장 필드(gates·publishedToday·distribution.origin)는 **옵셔널로 읽는다** —
 *    구버전 서버가 안 내려주면 해당 표시만 조용히 숨긴다(경고 오탐보다 미표시가 낫다).
 *  - 폴링을 새로 만들지 않는다 — 스토어의 /api/state 적응 폴링이 clips·episodes 배열을
 *    갈아끼울 때 이 화면의 자동화 상태도 함께 다시 읽는다(아래 useEffect).
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { UploadVideoButton } from "@/components/upload-video-dialog";
import type { AdoptReframe } from "@/components/adopt-dialog";
// 순방 판정과 **같은 함수**로 예상 건수를 낸다. 미러(aspect-presets 식 "바이트 동일" 주석)로
// 두지 않는 이유: 이 숫자는 곧 청구 예상으로 읽히는데, 미러가 한 번 어긋나면 화면이 조용히
// 거짓 약속을 하게 된다. automation.ts 는 import 0개짜리 순수 모듈이라 그대로 가져올 수 있다.
import {
  UPLOAD_PLATFORMS, formatWeekdays, isPublishDay, monthlyPublishEstimate, perDayCount, ruleSlots,
  slotLabel, type RuleSlot,
} from "@server-pure/pipeline/automation";
import {
  LayoutSliders,
  SUBTITLE_DEFAULTS,
  TemplatePreview,
  TemplatePreviewDialog,
  type LayoutState,
} from "@/components/automation/template-preview";
import { useToast } from "@/components/ui/toast";
import { useSession } from "@/lib/auth";
import {
  deleteAutomationRule,
  fetchAutomation,
  fetchInstagramAccounts,
  fetchMetaAccounts,
  getStreamUrl,
  fetchNaverAccounts,
  fetchShortsTemplates,
  fetchTikTokAccounts,
  fetchYouTubeChannels,
  type FrameTemplate,
  releaseAutomationHold,
  rejectAutomationHold,
  runAutomationNow,
  saveAutomationRule,
  setAutomationNotifyEmail,
  setAutomationPaused,
  type AutomationRule,
  type InstagramAccountInfo,
  type MetaAccountInfo,
  type RuleHold,
  type RuleMediaKind,
  type RuleRun,
  type TikTokAccountInfo,
} from "@/lib/data/api";
import { useAppData } from "@/lib/data/store";
import { channelLabel, PIPELINE_STAGES } from "@/lib/constants";
import type { Clip, Episode } from "@/lib/types";
import { clipThumbSrc, mediaThumbSrc, programImageUrl } from "@/lib/media-url";
import { cn } from "@/lib/utils";

/**
 * 승인 대기 카드의 렌더 결과 미리보기 — **나갈 파일 그대로** 를 그 자리에서 재생한다.
 *
 * 예전엔 "미리보기" 가 편집기로 보냈다. 편집기는 원본(마스터)에 오버레이를 얹어 **다시 그리는**
 * 화면이라, 승인 여부를 판단하려면 결국 결과물을 상상해야 했다(사용자 지적 2026-08-19:
 * "그래야 승인할지 안 할지 딱 보지"). 여기서 재생하는 건 clip.mediaId — 자막·오버레이가 이미
 * 구워진 렌더 산출물이다. 편집은 별도 버튼으로 분리했다.
 */
function HeldPreview({ clip }: { clip: Clip }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setUrl(null);
    setErr(null);
    if (!clip.mediaId) {
      setErr("아직 렌더된 파일이 없습니다");
      return;
    }
    getStreamUrl(clip.mediaId)
      .then((u) => { if (alive) setUrl(u); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [clip.mediaId]);

  if (err) {
    return (
      <div className="w-full rounded-[4px] px-3 py-2 text-[11px]" style={{ background: "var(--sd-card-sub)", color: "var(--sd-warn)" }}>
        {err}
      </div>
    );
  }
  if (!url) {
    return (
      <div className="w-full rounded-[4px] px-3 py-2 text-[11px]" style={{ background: "var(--sd-card-sub)", color: "var(--sd-mut)" }}>
        불러오는 중…
      </div>
    );
  }
  return (
    <video
      src={url}
      controls
      autoPlay
      playsInline
      // 세로 쇼츠가 카드를 삼키지 않게 높이로 묶는다 — 가로폭은 비율이 정한다.
      // 모서리는 각지게 — 결과물이 각진 사각형이라, 둥글리면 귀퉁이 내용이 깎여 보인다.
      className="max-h-[420px] bg-black"
      style={{ maxWidth: "100%" }}
    />
  );
}

const KIND_LABEL: Record<RuleMediaKind, string> = { short: "숏폼", clip: "클립", both: "숏폼+클립" };
// published 는 큐잉 시점 기록이라 "게시됨"이라 쓰면 거짓말이 된다 — 업로드는 이제 시작.
// 실제 완료/실패는 클립의 배포 상태(distributions)와 조인해 피드에서 덮어쓴다.
const RESULT_LABEL: Record<string, string> = {
  published: "업로드 시작", recorded: "기록됨", media_created: "미디어 생성",
  held: "승인 대기", failed: "실패", skipped: "안 보냄",
};
const RESULT_TAG: Record<string, string> = {
  published: "sd-tag sd-tag--upcoming", // 시작이지 완료가 아니다 — 완료(게시함)만 airing
  recorded: "sd-tag",
  media_created: "sd-tag sd-tag--upcoming",
  held: "sd-tag sd-tag--warn",
  failed: "sd-tag sd-tag--danger",
  skipped: "sd-tag",
};

/**
 * 실제 파일이 올라가는 플랫폼 — **서버 목록을 그대로 쓴다**(UPLOAD_PLATFORMS).
 *
 * ⚠️ 예전엔 여기서 `youtube || naver*` 로 좁혀 두고, TikTok·Instagram·Facebook 에는
 * "기록만 — 실제 게시는 담당자가 직접" 이라고 안내했다. 그런데 프로덕션은 그 셋의
 * 업로드 게이트가 **전부 켜져 있고**(cloudbuild TIKTOK/INSTAGRAM/FACEBOOK_UPLOAD_ENABLED=1),
 * 틱톡은 TIKTOK_DIRECT_POST=1 이라 받은함이 아니라 **채널에 바로 공개**된다.
 * 즉 "안 올라간다" 고 안내한 채널로 영상이 나갔다 — automation.ts:449 가 네이버 사례로
 * 경고한 **안전 문구 역전**의 재발이다. 사본을 두지 말고 정본 하나만 본다.
 *
 * 게이트가 꺼져 있으면 실제로는 기록만 되는데, 그건 상태가 아니라 켜고 끄는 축이라
 * 아래 gateOff() 배지가 따로 말한다(서버가 /api/automation 의 gates 로 내려준다).
 */
const isUploadPlatform = (p: string) => UPLOAD_PLATFORMS.has(p);

/** distribution.origin → 자동/수동 라벨. 없으면(구 기록) null — 표기 생략. */
function originLabelOf(origin: string | undefined): string | null {
  if (origin === "automation" || origin === "factory") return "자동";
  if (origin === "manual" || origin === "retry") return "수동";
  return null;
}

/**
 * 상대 시각 — "방금 / N분 전 / N시간 전 / N일 전", 미래면 "곧 / N분 후". 못 읽으면 null.
 * now 를 인자로 받아 렌더 때 계산한다(스토어 폴링 재렌더가 갱신 — 전용 타이머를 새로 만들지 않는다).
 */
function relTime(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const diff = t - now;
  const future = diff > 0;
  const suffix = future ? "후" : "전";
  const s = Math.abs(diff) / 1000;
  if (s < 45) return future ? "곧" : "방금";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}분 ${suffix}`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}시간 ${suffix}`;
  return `${Math.round(h / 24)}일 ${suffix}`;
}

/**
 * 서버 factory.ts TEMPLATE_SEEDS 의 UI 미러 — 미리보기·슬라이더 초기값용.
 * 서버 시드를 바꾸면 여기도 같이 바꿔야 미리보기가 실제 렌더와 일치한다.
 */
const TEMPLATE_SEED_UI: Record<string, { accent: string; titleY: number; iconY: number; boxY: number; iconSize: number }> = {
  // 강조색 #F3AF4F — 고객사 레퍼런스에서 픽셀 샘플링한 값(2026-08-28 · 서버 시드와 같은 값).
  "broadcast-standard": { accent: "#F3AF4F", titleY: 11, iconY: 76, boxY: 86.5, iconSize: 50 },
  "broadcast-drama": { accent: "#F3AF4F", titleY: 8, iconY: 77, boxY: 87.5, iconSize: 50 },
};

/** 계획의 채널 목록 — 배열이 정본, 없으면 단수 폴백(구 계획). */
const channelsOf = (r: AutomationRule) =>
  r.channels?.length ? r.channels : [{ platform: r.platform, accountId: r.accountId }];

/** 계획의 프로그램 목록 — 배열이 정본, 없으면 단수 폴백. */
const programsOf = (r: AutomationRule) => (r.programIds?.length ? r.programIds : [r.programId]);

const ANALYZE_IDX = PIPELINE_STAGES.indexOf("analyze");

/**
 * 회차의 분석 상태 요약 — "완료 → 생략"이 계획이므로 완료를 명시적으로 말한다.
 * pipeline.stage 가 analyze 를 지났으면 분석은 끝난 것이다(추천/편집/배포 단계).
 */
function episodeAnalysis(ep: Episode, hasMaster: boolean): {
  key: "done" | "running" | "waiting" | "failed" | "novideo";
  label: string;
  tag: string;
} {
  const idx = PIPELINE_STAGES.indexOf(ep.pipeline.stage);
  if (idx > ANALYZE_IDX || (idx === ANALYZE_IDX && ep.pipeline.stageStatus === "done")) {
    return { key: "done", label: "분석 완료 — 생략", tag: "sd-tag sd-tag--airing" };
  }
  if (ep.pipeline.stageStatus === "error") {
    return { key: "failed", label: `분석 실패${ep.pipeline.blockedReason ? ` — ${ep.pipeline.blockedReason}` : ""}`, tag: "sd-tag sd-tag--danger" };
  }
  if (idx === ANALYZE_IDX && ep.pipeline.stageStatus === "progress") {
    const pct = typeof ep.pipeline.progress === "number" ? ` ${Math.round(ep.pipeline.progress)}%` : "";
    return { key: "running", label: `분석 중${pct}`, tag: "sd-tag sd-tag--upcoming" };
  }
  if (idx === ANALYZE_IDX) {
    return { key: "waiting", label: "분석 대기", tag: "sd-tag" };
  }
  if (!hasMaster) return { key: "novideo", label: "영상 없음", tag: "sd-tag sd-tag--ended" };
  return { key: "waiting", label: "분석 전", tag: "sd-tag" };
}

export default function AutomationPage() {
  const { programs, episodes, clips, media, mediaForEpisode } = useAppData();
  const { toast } = useToast();
  const actor = useSession().user.name;

  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [runs, setRuns] = useState<RuleRun[]>([]);
  const [holds, setHolds] = useState<RuleHold[]>([]);
  const [paused, setPaused] = useState(false);
  const [idleReason, setIdleReason] = useState("");
  // 상태 헤더용 — 크레딧 잔액 · 마지막 순방 시각 · 순방 주기(ms). 모두 서버 확장분이라
  // 구버전 서버는 안 내려준다(null = 모름 → 해당 표시만 조용히 숨긴다).
  const [credit, setCredit] = useState<number | null>(null);
  const [lastCycleAt, setLastCycleAt] = useState<string | null>(null);
  const [cycleEveryMs, setCycleEveryMs] = useState<number | null>(null);
  // 채널별 실업로드 스위치 — 구버전 서버는 안 내려준다(null = 모름 → 경고 안 띄움).
  const [gates, setGates] = useState<Record<string, boolean> | null>(null);
  // 자동배포 완료 알림 담당자 이메일 — saved 는 서버 저장값(입력값과 갈라야 "저장됨" 표시가 정직하다).
  const [notifyEmail, setNotifyEmail] = useState("");
  const [notifyEmailSaved, setNotifyEmailSaved] = useState("");
  const [savingNotify, setSavingNotify] = useState(false);
  // loading 없이는 fetch 전에 "계획 없음"이 먼저 보인다 — 로딩/빈/에러 3종을 구분한다.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningNow, setRunningNow] = useState(false);
  const [releasing, setReleasing] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  // 승인 대기 카드에서 렌더 결과를 펼쳐 보고 있는 클립. 하나만 — 여러 개가 동시에 재생되면
  // 소리가 겹치고 스크롤이 길어져서 "딱 보고 판단" 이 안 된다.
  const [previewClipId, setPreviewClipId] = useState<string | null>(null);
  // 최근 처리·진행 접기 — 로그가 길어 기본은 접어 두고, 건수만 헤더에 보여준다.
  const [showActivity, setShowActivity] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetchAutomation();
      setRules(r.rules); setRuns(r.runs); setHolds(r.holds);
      setPaused(r.paused); setIdleReason(r.idleReason);
      setCredit(typeof r.credit === "number" ? r.credit : null);
      setLastCycleAt(r.lastCycleAt ?? null);
      setCycleEveryMs(typeof r.cycleEveryMs === "number" ? r.cycleEveryMs : null);
      setGates(r.gates ?? null);
      // 폴링 재로드가 입력 중인 값을 덮지 않게, 서버값 반영은 저장값과 입력값이 같을 때만.
      setNotifyEmailSaved((prev) => {
        const next = r.notifyEmail ?? "";
        setNotifyEmail((cur) => (cur === prev ? next : cur));
        return next;
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 스토어 폴링 편승 — /api/state 폴링(활성 8초/유휴 45초)이 clips·episodes 배열을 새로
  // 만들 때마다 자동화 상태도 다시 읽는다. 이 화면 전용 setInterval 을 만들지 않는다.
  const firstStoreSync = useRef(true);
  useEffect(() => {
    if (firstStoreSync.current) { firstStoreSync.current = false; return; } // 마운트 직후 중복 호출 방지
    void load();
  }, [clips, episodes, load]);

  // ── ①~④ 마법사 상태 ────────────────────────────────────────────────────────────
  const [selProgram, setSelProgram] = useState("");
  const [selChannels, setSelChannels] = useState<string[]>([]); // "platform:accountId"
  const [starting, setStarting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // 고급 설정 (구 계획 폼 필드 전부 — 격하했을 뿐 삭제하지 않는다)
  const [mediaKind, setMediaKind] = useState<RuleMediaKind>("short");
  const [approveFirst, setApproveFirst] = useState(true);
  const [win, setWin] = useState("방영 익일 10시");
  const [dailyQuota, setDailyQuota] = useState(3);
  const [activeStart, setActiveStart] = useState(9);
  const [activeEnd, setActiveEnd] = useState(22);
  // 발행 요일(ISO 1=월…7=일) · 발행 시간(KST "HH:MM").
  // 둘 다 **비우면 기존 동작**이다 — 요일 빈 값 = 매일, 시간 빈 값 = 할당량 방식.
  // 구 계획이 조용히 달라지지 않게 기본을 빈 배열로 둔다.
  const [weekdays, setWeekdays] = useState<number[]>([]);
  // 슬롯 = {time, count} — 시각당 개수(2026-08-25 · "시간대 하나 = 1개" 의존성 파괴).
  const [slots, setSlots] = useState<RuleSlot[]>([]);
  const [templateId, setTemplateId] = useState(""); // "" = 프로그램 장르 자동
  const [templates, setTemplates] = useState<FrameTemplate[]>([]);
  const [layout, setLayout] = useState<LayoutState | null>(null);
  // 자막 on/off — 계획 기본 ON(하위호환). 끄면 이 계획의 자동 클립을 자막 없이 렌더한다.
  // 저장 시 layout.subtitles 로 담긴다(automation_rule 에 자막 전용 컬럼 없이 라운드트립).
  const [subtitles, setSubtitles] = useState(true);
  // AI 리프레임 — 수동 채택(adopt-dialog)과 같은 값 체계("ai"|"none")·같은 라벨.
  // 기본 "none" = 중앙 고정 크롭(서버 factory 의 basicReframeState 기본과 동일).
  const [reframe, setReframe] = useState<AdoptReframe>("none");
  // 템플릿 대형 미리보기 — 소형 카드로는 실제 결과감이 안 온다는 피드백(클릭 시 확대).
  const [tplPreviewOpen, setTplPreviewOpen] = useState(false);

  useEffect(() => {
    void fetchShortsTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, []);

  // 템플릿 바꾸면 슬라이더를 그 템플릿의 시드 기본값으로 리셋 (계획 프리필 직후 1회는 건너뜀).
  const skipLayoutReset = useRef(false);
  const effectiveTemplate = templateId || "broadcast-standard";
  useEffect(() => {
    if (skipLayoutReset.current) { skipLayoutReset.current = false; return; }
    const s = TEMPLATE_SEED_UI[effectiveTemplate] ?? TEMPLATE_SEED_UI["broadcast-standard"];
    // 템플릿을 바꿔도 요소 표시 플래그(제목·로고·시간박스)는 유지한다 — 위치만 시드로 리셋.
    setLayout((prev) => ({
      titleY: s.titleY, channelIconY: s.iconY, channelBoxY: s.boxY, channelIconSize: s.iconSize,
      titleColor: s.accent,
      subtitleY: SUBTITLE_DEFAULTS.y, subtitleSize: SUBTITLE_DEFAULTS.size, subtitleColor: SUBTITLE_DEFAULTS.color,
      ...(prev ? { title: prev.title, logo: prev.logo ?? false, timebox: prev.timebox } : { logo: false }),
    }));
  }, [effectiveTemplate]);

  // ── ③ 채널 선택지 — 실제 연결 계정을 직접 읽는다. ───────────────────────────────
  // 사용자가 만지는 설정은 이 화면 한곳에만 둔다. 채널 화면은 OAuth·세션 연결만 담당한다.
  const [channelLoadFailed, setChannelLoadFailed] = useState(false);
  const [ytChannels, setYtChannels] = useState<{ channelId: string; channelName: string; status: string }[]>([]);
  const [naverAccts, setNaverAccts] = useState<{ id: string; label: string; target: string; hasSession: boolean }[]>([]);
  const [metaAccts, setMetaAccts] = useState<MetaAccountInfo[]>([]);
  const [igAccts, setIgAccts] = useState<InstagramAccountInfo[]>([]);
  const [tiktokAccts, setTiktokAccts] = useState<TikTokAccountInfo[]>([]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [youtube, naver, meta, instagram, tiktok] = await Promise.allSettled([
        fetchYouTubeChannels(),
        fetchNaverAccounts(),
        fetchMetaAccounts(),
        fetchInstagramAccounts(),
        fetchTikTokAccounts(),
      ]);
      if (!alive) return;

      setYtChannels(youtube.status === "fulfilled"
        ? youtube.value.filter((channel) => channel.status === "active")
        : []);
      setNaverAccts(naver.status === "fulfilled"
        ? naver.value.accounts.filter((account) =>
          account.status !== "disabled" && account.hasSession && account.target !== "tv")
        : []);
      setMetaAccts(meta.status === "fulfilled"
        ? meta.value.filter((account) => account.status === "active")
        : []);
      setIgAccts(instagram.status === "fulfilled"
        ? instagram.value.filter((account) =>
          account.status === "active"
          && !(account.expiresAt && Number(account.expiresAt) < Date.now()))
        : []);
      setTiktokAccts(tiktok.status === "fulfilled"
        ? tiktok.value.filter((account) => account.status === "active")
        : []);
      setChannelLoadFailed([youtube, naver, meta, instagram, tiktok]
        .some((result) => result.status === "rejected"));
    })();
    return () => { alive = false; };
  }, []);

  // 채널 선택지 = 연결된 계정 자체. 다른 화면에서 추가 설정을 만들 필요가 없다.
  const channelOptions: { platform: string; accountId: string; label: string }[] = useMemo(() => [
    ...ytChannels.map((c) => ({ platform: "youtube", accountId: c.channelId, label: `YouTube · ${c.channelName}` })),
    ...naverAccts.map((a) => ({ platform: "naverclip", accountId: a.id, label: `네이버 클립 · ${a.label}` })),
    ...metaAccts.map((a) => ({ platform: "facebook", accountId: a.pageId, label: `Facebook · ${a.pageName}` })),
    ...igAccts.map((a) => ({ platform: "instagram", accountId: a.igUserId, label: `Instagram · @${a.username}` })),
    ...tiktokAccts.map((a) => ({
      platform: "tiktok", accountId: a.openId,
      label: `TikTok · ${a.username ? `@${a.username}` : a.displayName}`,
    })),
  ], [ytChannels, naverAccts, metaAccts, igAccts, tiktokAccts]);

  /**
   * 게이트가 **명시적으로 꺼진** 채널인가. "platform:accountId" 키 우선, 플랫폼 키 폴백.
   * gates 미수신(구버전 서버)이나 키 없음은 "모름" — 꺼짐으로 단정하지 않는다.
   */
  const gateOff = (platform: string, accountId: string): boolean => {
    if (!gates) return false;
    const v = gates[`${platform}:${accountId}`] ?? gates[platform];
    return v === false;
  };

  // 선택 프로그램을 이미 커버하는 계획 — "자동 배포 시작"은 이 계획의 갱신이 된다(upsert).
  const ruleForProgram = useMemo(
    () => rules.find((r) => programsOf(r).includes(selProgram)),
    [rules, selProgram],
  );

  // 채널은 자동배포 하나만 소유한다. 현재 수정 중인 계획의 채널은 그대로 선택할 수 있고,
  // 다른 계획이 쓰는 채널만 잠근다. 서버도 같은 불변식을 409로 다시 검사한다.
  const channelOwners = useMemo(() => {
    const owners = new Map<string, { ruleId: string; programTitle: string }>();
    for (const rule of rules) {
      const programId = programsOf(rule)[0];
      const programTitle = programs.find((program) => program.id === programId)?.title ?? programId;
      for (const channel of channelsOf(rule)) {
        owners.set(`${channel.platform}:${channel.accountId}`, { ruleId: rule.id, programTitle });
      }
    }
    return owners;
  }, [rules, programs]);
  const channelOwnerOtherThanCurrent = useCallback((key: string) => {
    const owner = channelOwners.get(key);
    return owner && owner.ruleId !== ruleForProgram?.id ? owner : null;
  }, [channelOwners, ruleForProgram?.id]);

  // 프로그램을 고르면 기존 계획 값으로 ②~④를 프리필한다 — 프로그램당 1회만(폴링이
  // rules 를 갈아끼워도 사용자가 만지던 선택을 덮지 않는다).
  const prefilledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!selProgram || prefilledFor.current === selProgram) return;
    if (loading) return; // 계획을 아직 못 읽었다 — 읽힌 뒤에 프리필
    prefilledFor.current = selProgram;
    const r = rules.find((x) => programsOf(x).includes(selProgram));
    if (!r) { setSelChannels([]); return; }
    setSelChannels(channelsOf(r).map((c) => `${c.platform}:${c.accountId}`));
    setMediaKind(r.mediaKind);
    setApproveFirst(r.gatePolicy === "approve_first");
    setWin(r.window || "수시");
    setDailyQuota(r.dailyQuota ?? 3);
    setActiveStart(r.activeStart ?? 9); setActiveEnd(r.activeEnd ?? 22);
    // 구형(문자열)·신형({time,count}) 혼재를 서버와 같은 정규화로 접는다.
    setWeekdays(r.weekdays ?? []); setSlots(ruleSlots({ slots: r.slots ?? [] }));
    setTemplateId(r.templateId ?? "");
    setReframe(r.reframe ?? "none"); // 구 계획(필드 없음)은 기본과 같은 "none"
    setSubtitles(r.layout?.subtitles !== false); // 구 계획(필드 없음)은 기본 ON
    if (r.layout) {
      const seed = TEMPLATE_SEED_UI[r.templateId || "broadcast-standard"] ?? TEMPLATE_SEED_UI["broadcast-standard"];
      skipLayoutReset.current = true; // 템플릿 리셋 이펙트가 이 값을 덮지 않게
      setLayout({
        titleY: r.layout.titleY ?? seed.titleY,
        channelIconY: r.layout.channelIconY ?? seed.iconY,
        channelBoxY: r.layout.channelBoxY ?? seed.boxY,
        channelIconSize: r.layout.channelIconSize ?? seed.iconSize,
        titleColor: r.layout.titleColor ?? seed.accent,
        subtitleY: r.layout.subtitleY ?? SUBTITLE_DEFAULTS.y,
        subtitleSize: r.layout.subtitleSize ?? SUBTITLE_DEFAULTS.size,
        subtitleColor: r.layout.subtitleColor ?? SUBTITLE_DEFAULTS.color,
        // 요소 표시 플래그 — 미지정(구 계획)은 표시. 저장값 그대로 라운드트립.
        title: r.layout.title, logo: r.layout.logo ?? false, timebox: r.layout.timebox,
      });
    }
  }, [selProgram, rules, loading]);

  const toggle = (list: string[], v: string) => list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  // ── 상태바 파생값 ──────────────────────────────────────────────────────────────
  const hasEnabledRules = rules.some((r) => r.enabled);
  const running = !paused && hasEnabledRules;
  // 크레딧 소진 — 순방은 돌지만 채택·게시를 아무것도 하지 않는다(서버가 idleReason 도 세운다).
  // credit 미수신(구버전)이면 null → "모름" 으로 두고 소진 강조를 하지 않는다.
  const creditOut = typeof credit === "number" && credit <= 0;

  // 상태 3종 — 일시정지 > 꺼짐(활성 계획 없음) > 켜짐. 크레딧 소진은 "켜짐이지만 멈춤" 강조.
  const statusLabel = loading
    ? "불러오는 중…"
    : paused
      ? "일시정지됨 — 자동 확인을 멈췄습니다"
      : !hasEnabledRules
        ? "꺼짐 — 저장된 자동배포 설정이 없습니다"
        : creditOut
          ? "켜짐이지만 멈춤 — 크레딧 소진"
          : "자동 배포 켜짐";

  // 마지막/다음 순방 — 순방 심박(lastCycleAt)이 정본, 없으면 최근 기록(runs[0].at) 폴백.
  // 다음 예정 = 마지막 + 주기(ms). 주기가 없거나 0(주기 순방 꺼짐)이면 다음 예정은 숨긴다.
  const nowTs = Date.now();
  const lastCycleIso = lastCycleAt ?? runs[0]?.at ?? null;
  const lastRel = relTime(lastCycleIso, nowTs);
  const nextIso = lastCycleIso && cycleEveryMs && cycleEveryMs > 0
    ? new Date(new Date(lastCycleIso).getTime() + cycleEveryMs).toISOString()
    : null;
  const nextRel = relTime(nextIso, nowTs);

  // 지금 진행 중 — 프로그램 선택과 무관한 전체 집계. 렌더 대기 = 자동 생성됐지만 아직 렌더 전
  // 클립(automationRuleId 는 서버가 채택 시 저장 · 타입엔 없어 캐스트). 확정 대기 = 보류 건수.
  const inflightRender = clips.filter(
    (c) => (c as { automationRuleId?: string }).automationRuleId && !c.rendered,
  ).length;
  // ── 승인 대기는 **영상 단위**다 (사용자 확정 2026-08-19: "걍 그 영상 하나하나만 떠야지") ──
  //
  // 보류 행(rule_hold)은 계획×클립이라, 같은 영상이 계획 두 개에 걸리면 두 줄이 된다. 사람이
  // 보는 단위는 계획이 아니라 **영상**이다 — 여기서 클립 하나로 접고, 승인은 그 영상에 걸린
  // 보류를 전부 푼다. 기록 쪽 held 줄도 같은 기준으로 접어야 두 목록의 개수가 맞는다.
  const heldClips = useMemo(() => {
    const byClip = new Map<string, { clipId: string; holds: RuleHold[]; heldAt: string; reasons: string[] }>();
    for (const h of holds) {
      const cur = byClip.get(h.clipId);
      if (cur) {
        cur.holds.push(h);
        // 대기 시작은 **가장 이른** 시각 — 계획이 나중에 하나 더 걸렸다고 대기가 리셋되진 않는다.
        if (h.heldAt && (!cur.heldAt || h.heldAt < cur.heldAt)) cur.heldAt = h.heldAt;
        if (h.reason && !cur.reasons.includes(h.reason)) cur.reasons.push(h.reason);
      } else {
        byClip.set(h.clipId, {
          clipId: h.clipId, holds: [h], heldAt: h.heldAt, reasons: h.reason ? [h.reason] : [],
        });
      }
    }
    return [...byClip.values()].sort((a, b) => (b.heldAt ?? "").localeCompare(a.heldAt ?? ""));
  }, [holds]);
  const heldCount = heldClips.length;

  // 기록의 '승인 대기' 줄도 같은 기준으로 접는다. 서버는 (계획×클립×**채널**×사유)마다 한 줄을
  // 남기므로 채널이 셋인 계획이면 같은 영상이 여섯 줄까지 뜬다 — 그래서 위 승인 대기 개수와
  // 기록의 승인 대기 줄 수가 안 맞아 보였다(사용자 지적 2026-08-19). 클립당 **가장 최근 한 줄**만
  // 남긴다. 나머지 결과(게시·실패)는 그대로 둔다 — 그건 채널별로 봐야 하는 정보다.
  /**
   * 이 프로그램의 계획들 — 기록을 **선택한 프로그램으로 좁히는** 근거 (2026-08-28).
   *
   * 예전엔 기록이 워크스페이스 전체였다. 프로그램을 하나 골라 놔도 다른 프로그램의
   * 자동배포 로그가 같이 떠서, 화면이 지저분하고 "지금 이 프로그램이 어디까지 왔나" 를
   * 읽어내기 어려웠다(사용자 2026-08-28 · AENA 는 programRules/programEpisodes 로 좁힌다).
   */
  const programRuleIds = useMemo(
    () => new Set(rules.filter((r) => programsOf(r).includes(selProgram)).map((r) => r.id)),
    [rules, selProgram],
  );

  /**
   * 이 기록을 지금 화면에 보여줄 것인가 — **좁히되 실패는 숨기지 않는다.**
   *
   * ⚠️ AENA 가 같은 자리에서 못박아 둔 예외를 그대로 가져온다("실패를 프로그램 필터로
   * 숨기면 안 된다"). 다른 프로그램에서 배포가 깨졌는데 화면이 조용하면, 그게 이 리포의
   * 최빈 실패모드(조용한 정지)다. 계획에 안 매인 줄(ruleId=null · 크레딧 정지 등)도
   * 워크스페이스 전체 사실이라 항상 보여준다.
   */
  const inProgramScope = useCallback((run: RuleRun) => {
    if (!selProgram) return true;                 // 프로그램 미선택 = 전체 보기
    if (run.result === "failed") return true;     // 실패는 어느 프로그램이든 보여준다
    if (!run.ruleId) return true;                 // 워크스페이스 전체 사실(크레딧 등)
    return programRuleIds.has(run.ruleId);
  }, [selProgram, programRuleIds]);

  const visibleRuns = useMemo(() => {
    const seenHeld = new Set<string>();
    // 과거에 예약 순방과 "지금 확인"이 겹쳐 남은 동일 로그는 한 줄로 접는다. 서버는 이제
    // 테넌트 잠금으로 새 중복을 원천 차단하지만, 이미 쌓인 기록까지 화면에 두 줄로 보일
    // 이유는 없다. 같은 영상·채널·결과·문구가 30초 안에 반복된 경우만 중복으로 본다.
    const seenExact = new Map<string, number>();
    return runs.filter((run) => {
      if (!inProgramScope(run)) return false;
      const exactKey = `${run.clipId ?? ""}:${run.accountKey ?? ""}:${run.result}:${run.detail}`;
      const at = new Date(run.at).getTime();
      const previous = seenExact.get(exactKey);
      if (Number.isFinite(at) && previous != null && Math.abs(previous - at) <= 30_000) return false;
      if (Number.isFinite(at)) seenExact.set(exactKey, at);
      if (run.result !== "held") return true;
      // clipId 없는 held(계획 단위 로그)는 접을 근거가 없다 — id 로 각자 남긴다.
      const key = run.clipId ?? `run:${run.id}`;
      if (seenHeld.has(key)) return false;
      seenHeld.add(key);
      return true;
    });
  }, [runs, inProgramScope]);

  // "업로드 시작" 로그와 실제 완료를 섞지 않는다. published 로그 뒤에 해당 채널의
  // distribution.status=published 까지 확인된 것만 완료 영상으로 따로 보낸다.
  const completedRunIds = useMemo(() => {
    const ids = new Set<number>();
    for (const run of visibleRuns) {
      if (run.result !== "published" || !run.accountKey) continue;
      const clip = clips.find((item) => item.id === run.clipId);
      const split = run.accountKey.indexOf(":");
      const platform = split >= 0 ? run.accountKey.slice(0, split) : run.accountKey;
      const accountId = split >= 0 ? run.accountKey.slice(split + 1) : "";
      const distributions = (clip?.distributions ?? []).filter((distribution) => distribution.channel === platform);
      const exact = distributions.find((distribution) => {
        const record = distribution as unknown as Record<string, unknown>;
        const id = record.youtubeChannelId ?? record.naverAccountId ?? record.tiktokOpenId
          ?? record.igUserId ?? record.metaPageId;
        return id != null && String(id) === accountId;
      });
      if ((exact ?? distributions[0])?.status === "published") ids.add(run.id);
    }
    return ids;
  }, [visibleRuns, clips]);
  const completedRuns = visibleRuns.filter((run) => completedRunIds.has(run.id));
  // 할당량 소진류 "안 보냄" 안내는 화면에서 뺀다(사용자 2026-08-24) — 실패도 대기도 아니고
  // 자정(KST)에 저절로 풀리는 정상 정지라, 피드에 쌓이면 진짜 실패·대기를 가린다.
  // 서버 기록(rule_run)은 그대로 남는다 — 순방 dedupe·감사가 그걸 쓴다.
  const isQuotaNoise = (run: RuleRun) => run.result === "skipped" && /할당량/.test(run.detail ?? "");
  const recentProcessRuns = visibleRuns.filter((run) => !completedRunIds.has(run.id) && !isQuotaNoise(run));

  // 실업로드 채널이 계획에 있는데 게이트가 꺼져 있으면 — "실행 중"이 착시가 된다.
  const gateBlocked = rules.some(
    (r) => r.enabled && channelsOf(r).some((c) => isUploadPlatform(c.platform) && gateOff(c.platform, c.accountId)),
  );

  const latestRun = visibleRuns[0] ?? null;
  const latestRunClip = latestRun ? clips.find((clip) => clip.id === latestRun.clipId) : undefined;
  const latestRunRule = latestRun ? rules.find((rule) => rule.id === latestRun.ruleId) : undefined;
  const latestRunProgramId = latestRunRule ? programsOf(latestRunRule)[0] : null;
  const latestRunProgram = latestRunProgramId
    ? programs.find((program) => program.id === latestRunProgramId)?.title ?? latestRunProgramId
    : null;
  const cycleDelayed = Boolean(
    running && lastCycleIso && cycleEveryMs && cycleEveryMs > 0
    && nowTs - new Date(lastCycleIso).getTime() > Math.max(cycleEveryMs * 2.5, 30 * 60 * 1000),
  );
  const health = error
    ? { label: "상태 확인 실패", color: "var(--sd-danger-strong)", detail: "서버 상태를 다시 불러와 주세요" }
    : paused
      ? { label: "일시정지", color: "var(--sd-idle)", detail: "자동 확인을 멈춘 상태입니다" }
      : !hasEnabledRules
        ? { label: "설정 필요", color: "var(--sd-idle)", detail: "자동배포를 만들면 확인을 시작합니다" }
        : creditOut
          ? { label: "확인 필요", color: "var(--sd-warn)", detail: "크레딧이 없어 처리가 멈췄습니다" }
          : cycleDelayed
            ? { label: "확인 지연", color: "var(--sd-warn)", detail: "예정 시간보다 자동 확인이 늦습니다" }
            : gateBlocked
              ? { label: "기록만 진행", color: "var(--sd-warn)", detail: "실제 업로드가 꺼진 채널이 있습니다" }
              : { label: "정상 확인 중", color: "var(--sd-ok)", detail: "자동배포가 주기적으로 새 영상을 확인합니다" };
  const currentWork = inflightRender > 0
    ? `영상 ${inflightRender}건을 렌더하고 있습니다`
    : heldCount > 0
      ? `영상 ${heldCount}건이 승인을 기다립니다`
      : idleReason || "새 영상과 배포 시간을 기다리고 있습니다";

  // 오늘 게시 합산 — publishedToday 를 내려주는 서버에서만 계산한다(없으면 줄 숨김).
  const hasToday = rules.some((r) => r.publishedToday);
  const todayPublished = rules.reduce(
    (sum, r) => sum + Object.values(r.publishedToday ?? {}).reduce((a, b) => a + b, 0),
    0,
  );
  // 하루 몇 건인지는 **서버 판정과 같은 함수**로 낸다. 예전엔 여기서 dailyQuota 를 직접
  // 곱했는데, 발행 시간(슬롯)이 있으면 서버는 dailyQuota 를 무시하고 슬롯 개수를 쓰므로
  // 화면만 다른 수를 말하게 된다.
  // **오늘 발행 요일이 아닌 계획은 세지 않는다.** 순방은 발행 요일이 아니면 계획 전체를
  // 건너뛰므로(automation-cycle isPublishDay), 요일을 안 보면 월~금 계획이 토요일에도
  // "한도 40건" 이라고 떠서 "왜 안 나가지" 를 화면으로 판단할 수 없다.
  const todayQuota = rules
    .filter((r) => r.enabled && isPublishDay(r))
    .reduce((sum, r) => sum + monthlyPublishEstimate(r).perDay * channelsOf(r).length, 0);

  async function togglePause() {
    try {
      const r = await setAutomationPaused(!paused);
      toast({ title: paused ? "재시작했습니다" : "일시정지했습니다", description: r.notice, tone: "done" });
      await load();
    } catch (err) {
      toast({ title: "변경 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    }
  }

  /** 계획을 만들고 10분을 기다리지 않아도 결과를 본다. */
  async function runNow() {
    if (runningNow) return; // 더블클릭 = 확인 중복 실행
    setRunningNow(true);
    try {
      const r = await runAutomationNow();
      toast({
        title: "확인했습니다",
        description:
          r.idleReason ||
          `자동배포 ${r.rulesEvaluated}개 확인 · 미디어 ${r.adopted} · 게시 ${r.published} · 승인 대기 ${r.held}`,
        tone: r.held > 0 ? "warn" : "done",
      });
      await load();
    } catch (err) {
      toast({ title: "확인 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setRunningNow(false);
    }
  }

  /** ④ 자동 배포 시작 — 계획 upsert(기존 계획이 있으면 갱신) + 즉시 1회 확인. */
  async function startAutoDeploy() {
    if (starting || !selProgram || selChannels.length === 0) return;
    // 채널이 다른 계획에서 이미 쓰이고 있어도 **막지 않는다**(2026-08-28 "자유롭게 가자").
    // A 프로그램을 A 채널에 내보내는 중에 B 프로그램도 같은 채널로 보내고 싶은 건 정상적인
    // 요구인데, 예전엔 그때마다 돌던 계획을 지워야 했다. 같은 영상의 중복 게시는 계획이
    // 아니라 배포 행(publish-guard)이 막으므로 이 차단이 없어도 안전하다.
    setStarting(true);
    try {
      const chans = selChannels
        .map((k) => channelOptions.find((o) => `${o.platform}:${o.accountId}` === k))
        .filter(Boolean)
        .map((o) => ({ platform: o!.platform, accountId: o!.accountId }));
      // 선택 키가 채널 목록에서 사라졌을 수 있다(목록 재조회 등) — 빈 배열이면 chans[0] 크래시.
      if (chans.length === 0) {
        toast({ title: "시작 실패", description: "선택한 채널을 찾을 수 없습니다 — 채널을 다시 선택해 주세요.", tone: "error" });
        setStarting(false);
        return;
      }
      // 일부만 매칭 실패한 경우 — 조용히 축소 저장하면 사용자는 다 저장된 줄 안다.
      if (chans.length < selChannels.length) {
        toast({
          title: `채널 ${selChannels.length - chans.length}개를 찾을 수 없어 제외했습니다`,
          description: "연결이 끊겼거나 세션이 만료된 채널일 수 있습니다 — 배포채널 화면을 확인하세요.",
          tone: "warn",
        });
      }
      await saveAutomationRule({
        // 갱신은 id 가 정본 — 자연키(첫 채널)로 흘리면 첫 채널이 바뀔 때 새 계획이 생겨
        // 구 계획과 이중 커버된다(서버가 id 로 UPDATE).
        ...(ruleForProgram?.id ? { id: ruleForProgram.id } : {}),
        // 단수 필드 = 첫 항목 (서버 UNIQUE·구버전 호환). 배열이 정본.
        programId: selProgram, platform: chans[0].platform, accountId: chans[0].accountId,
        programIds: [selProgram], channels: chans,
        dailyQuota, activeStart, activeEnd,
        // 슬롯이 있으면 서버는 dailyQuota 를 무시하고 슬롯 개수를 쓴다(perDayCount).
        // 그래도 값은 보낸다 — 슬롯을 나중에 비웠을 때 되돌아갈 자리가 필요하다.
        weekdays, slots,
        mediaKind,
        gatePolicy: approveFirst ? "approve_first" : "hold_on_issue",
        window: win, enabled: true,
        // 리프레임은 9:16 숏폼에만 의미 있다 — 클립 전용 계획이면 "none" 으로 강제
        // (수동 채택 다이얼로그가 가로형에서 리프레임 단계를 생략하는 것과 같은 계획).
        // orientation 을 함께 보내야 한다 — 서버는 reframe=ai 를 portrait 에서만 허용하고
        // (400), 순방 소비 조건도 orientation==="portrait" && reframe==="ai" 다. 숏폼=세로,
        // 클립=가로, 둘 다(both)는 추천 kind 기반이라 미지정(+AI 비활성).
        ...(mediaKind === "short" ? { orientation: "portrait" as const }
          : mediaKind === "clip" ? { orientation: "landscape" as const } : {}),
        reframe: mediaKind === "short" ? reframe : "none",
        ...(templateId ? { templateId } : {}),
        // 자막 위치·크기·색(layout)과 자막 on/off(subtitles)를 layout JSONB 안에 함께 보낸다 —
        // automation_rule 에 자막 전용 컬럼을 두지 않고 라운드트립시킨다.
        layout: layout ? { ...layout, subtitles } : { subtitles },
      });
      const r = await runAutomationNow();
      toast({
        title: "자동 배포를 시작했습니다",
        description:
          r.idleReason ||
          `자동배포 ${r.rulesEvaluated}개 확인 · 미디어 ${r.adopted} · 게시 ${r.published} · 승인 대기 ${r.held} — 이후 10분마다 자동 확인합니다.`,
        tone: r.held > 0 ? "warn" : "done",
      });
      await load();
    } catch (err) {
      toast({ title: "시작 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setStarting(false);
    }
  }

  /** 참고 디자인의 "초기화" — 서버 계획은 지우지 않고 현재 작성 중인 폼만 기본값으로 되돌린다. */
  function resetWizard() {
    const seed = TEMPLATE_SEED_UI["broadcast-standard"];
    prefilledFor.current = null;
    setSelProgram("");
    setSelChannels([]);
    setMediaKind("short");
    setApproveFirst(true);
    setWin("방영 익일 10시");
    setDailyQuota(3);
    setActiveStart(9);
    setActiveEnd(22);
    setWeekdays([]);
    setSlots([]);
    setTemplateId("");
    setReframe("none");
    setSubtitles(true);
    setLayout({
      titleY: seed.titleY,
      channelIconY: seed.iconY,
      channelBoxY: seed.boxY,
      channelIconSize: seed.iconSize,
      titleColor: seed.accent,
      subtitleY: SUBTITLE_DEFAULTS.y,
      subtitleSize: SUBTITLE_DEFAULTS.size,
      subtitleColor: SUBTITLE_DEFAULTS.color,
      logo: false,
    });
    setShowAdvanced(false);
    toast({ title: "입력값을 초기화했습니다", description: "이미 저장된 자동배포 설정은 변경하지 않았습니다.", tone: "done" });
  }

  /** 영상 하나 승인 — 그 영상에 걸린 보류를 **전부** 푼다(계획이 둘이면 둘 다). 하나라도
   *  남으면 다음 순방에서 그 계획이 다시 잡아 승인이 안 먹은 것처럼 보인다. */
  async function release(entry: { clipId: string; holds: RuleHold[] }) {
    if (releasing) return; // 더블클릭 = 승인 중복 요청
    setReleasing(entry.clipId);
    try {
      const results = await Promise.allSettled(
        entry.holds.map((h) => releaseAutomationHold(h.ruleId, h.clipId, actor)),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed === results.length) throw (results[0] as PromiseRejectedResult).reason;
      const first = results.find((r) => r.status === "fulfilled") as
        | PromiseFulfilledResult<{ notice?: string }> | undefined;
      toast({
        title: failed ? `승인했습니다 — 연결 ${failed}개는 실패` : "승인했습니다",
        description: first?.value?.notice ?? "다음 확인 때 게시됩니다.",
        tone: failed ? "warn" : "done",
      });
      await load();
    } catch (err) {
      toast({ title: "승인 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setReleasing(null);
    }
  }

  /** 영상 하나 거부 — 그 영상에 걸린 보류를 **전부** 거부한다(승인과 대칭·반대). 거부하면 이
   *  계획으로는 재선정도 게시도 안 된다. 되돌리기 어려우니 확인을 받는다. */
  async function reject(entry: { clipId: string; holds: RuleHold[] }) {
    if (releasing || rejecting) return;
    if (!window.confirm("이 영상을 거부하면 이 자동배포에서는 다시 나가지 않습니다. 거부할까요?")) return;
    setRejecting(entry.clipId);
    try {
      const results = await Promise.allSettled(
        entry.holds.map((h) => rejectAutomationHold(h.ruleId, h.clipId, actor)),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed === results.length) throw (results[0] as PromiseRejectedResult).reason;
      toast({
        title: failed ? `거부했습니다 — 연결 ${failed}개는 실패` : "거부했습니다",
        description: "이 영상은 현재 자동배포에서 제외됩니다.",
        tone: failed ? "warn" : "done",
      });
      await load();
    } catch (err) {
      toast({ title: "거부 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setRejecting(null);
    }
  }

  /** 전체 승인 — 서버 API 가 (계획,클립) 건당이라 순차로 돈다. 실패 건은 남기고 계속 간다.
   *  세는 단위는 **영상**이다(버튼 문구와 같아야 한다) — 한 영상의 보류를 다 풀어야 1건. */
  async function releaseAll() {
    if (releasing || heldClips.length === 0) return;
    setReleasing("__all__");
    let ok = 0;
    let fail = 0;
    try {
      for (const entry of heldClips) {
        const results = await Promise.allSettled(
          entry.holds.map((h) => releaseAutomationHold(h.ruleId, h.clipId, actor)),
        );
        if (results.every((r) => r.status === "fulfilled")) ok += 1;
        else fail += 1;
      }
      toast({
        title: `전체 승인 — 영상 ${ok}개 완료${fail ? ` · ${fail}개 실패` : ""}`,
        description: "다음 확인 때 게시됩니다.",
        tone: fail ? "warn" : "done",
      });
      await load();
    } finally {
      setReleasing(null);
    }
  }

  // ── ② 회차 파생값 ─────────────────────────────────────────────────────────────
  const programEpisodes = useMemo(
    () =>
      episodes
        .filter((e) => e.programId === selProgram)
        .sort((a, b) => (b.episodeNumber ?? 0) - (a.episodeNumber ?? 0)),
    [episodes, selProgram],
  );

  // 미리보기 영상 배경 = 사용자의 최근 회차 원본 프레임(자동). 선택 프로그램 회차를 우선 쓰고,
  // 없으면 전체에서 가장 최근 원본을 쓴다. 하나도 없으면 undefined → 미리보기가 회색 그라디언트로 폴백.
  const sampleFrameSrc = useMemo(() => {
    const masters = media.filter((m) => m.role === "master");
    if (masters.length === 0) return undefined;
    const progEpIds = new Set(episodes.filter((e) => e.programId === selProgram).map((e) => e.id));
    const byRecent = (a: (typeof masters)[number], b: (typeof masters)[number]) => b.createdAt - a.createdAt;
    const preferred = masters.filter((m) => m.episodeId && progEpIds.has(m.episodeId)).sort(byRecent)[0];
    const pick = preferred ?? masters.slice().sort(byRecent)[0];
    return pick ? mediaThumbSrc(pick.id) : undefined;
  }, [media, episodes, selProgram]);

  // ── ④ 진행 패널 파생값 — 이 프로그램 계획의 확인 기록 → 클립 → 렌더 → 배포 조인 ──
  const progress = useMemo(() => {
    if (!selProgram) return null;
    const rule = ruleForProgram;
    const ruleRuns = rule ? runs.filter((x) => x.ruleId === rule.id) : [];
    // 기록(rule_run)은 최근 50행 창이라 순방이 몇 번 돌면 media_created 가 창 밖으로 밀려
    // "0건"으로 후퇴한다 — 클립의 automationRuleId(서버가 채택 시 저장)가 창 한계 없는 정본.
    // 창 안의 기록은 보조로 합친다(방금 생성돼 스토어 폴링 전인 클립 대비).
    const fromClips = rule
      ? clips.filter((c) => (c as { automationRuleId?: string }).automationRuleId === rule.id).map((c) => c.id)
      : [];
    const fromRuns = ruleRuns.filter((x) => x.result === "media_created" && x.clipId).map((x) => x.clipId!);
    const createdIds = [...new Set([...fromClips, ...fromRuns])];
    const createdClips = createdIds
      .map((id) => clips.find((c) => c.id === id))
      .filter((c): c is Clip => Boolean(c));
    const rendered = createdClips.filter((c) => c.rendered).length;
    let published = 0, pending = 0, failed = 0, recorded = 0;
    for (const c of createdClips) for (const d of c.distributions ?? []) {
      if (d.status === "published") published += 1;
      else if (d.status === "pending" || d.status === "scheduled") pending += 1;
      else if (d.status === "failed") failed += 1;
      else if (d.status === "recorded") recorded += 1;
    }
    const heldCount = rule ? holds.filter((h) => h.ruleId === rule.id).length : 0;
    // 분석 축 — 회차 pipeline 진행률 요약
    let aDone = 0, aRunning = 0, aWaiting = 0, aFailed = 0, aNoVideo = 0;
    for (const ep of programEpisodes) {
      const k = episodeAnalysis(ep, Boolean(mediaForEpisode(ep.id, "master"))).key;
      if (k === "done") aDone += 1;
      else if (k === "running") aRunning += 1;
      else if (k === "failed") aFailed += 1;
      else if (k === "novideo") aNoVideo += 1;
      else aWaiting += 1;
    }
    return {
      rule, createdCount: createdIds.length, rendered, published, pending, failed, recorded, heldCount,
      analysis: { done: aDone, running: aRunning, waiting: aWaiting, failed: aFailed, noVideo: aNoVideo, total: programEpisodes.length },
    };
  }, [selProgram, ruleForProgram, runs, clips, holds, programEpisodes, mediaForEpisode]);

  const stepDim = (on: boolean) => (on ? undefined : { opacity: 0.65, pointerEvents: "none" as const });

  return (
    <div className="mx-auto flex max-w-[980px] flex-col gap-5 pb-10">
      {/* 참고 디자인의 헤더 계층을 제품 토큰으로 옮긴다. 상태는 오른쪽에서 바로 확인한다. */}
      <header
        className="overflow-hidden rounded-[10px] px-5 py-5 text-white shadow-sm sm:px-6"
        style={{ background: "linear-gradient(135deg, #4f5fc7 0%, #5b2f8f 100%)" }}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-[22px] font-semibold tracking-[-0.02em]">자동배포</h1>
            <p className="mt-1 max-w-[620px] text-[13px] leading-relaxed text-white/90">
              프로그램 영상을 자동 분석 → 쇼츠 생성 → 메타데이터 생성 → 배포합니다.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded-full bg-white/15 px-2.5 py-1 font-medium">{statusLabel}</span>
            {lastRel && <span className="rounded-full bg-black/15 px-2.5 py-1">마지막 확인 {lastRel}</span>}
          </div>
        </div>
      </header>

      {/* ── 게이트 착시 방지 — 실업로드가 꺼져 있으면 최상단에서 먼저 말한다 ── */}
      {gateBlocked && (
        <div
          className="rounded-[4px] px-3 py-2.5 text-[12px] font-medium leading-relaxed"
          style={{ border: "1px solid var(--sd-warn-border)", background: "var(--sd-warn-bg)", color: "var(--sd-warn)" }}
        >
          ⚠ 지금은 실제 업로드가 꺼져 있습니다 — 자동배포가 실행돼도 기록만 남고 채널에는
          올라가지 않습니다. (권리 확인의 승인 대기와는 별개인 운영 설정입니다.)
        </div>
      )}

      {/* Main.dc.html 처럼 상태·최근 처리·다음 확인을 가벼운 칸으로 분리한다. 긴 기록까지
          내려가지 않아도 지금 정상인지, 방금 무엇을 했는지, 현재 무엇을 기다리는지 보인다. */}
      <section className="sd-card overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
          <span
            className="size-[10px] shrink-0 rounded-full"
            style={{ background: health.color }}
            aria-hidden
          />
          <span className="text-[14px] font-semibold" style={{ color: "var(--sd-fg)" }}>
            {health.label}
          </span>
          <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
            {health.detail}
          </span>
          {hasToday && (
            <span className="text-[11px] font-medium" style={{ color: "var(--sd-fg)" }}>
              {/* 한도 0 은 고장이 아니라 "오늘은 발행 요일이 아님" 이다 — 그렇게 말한다.
                  숫자만 0 으로 두면 사용자는 계획이 멈춘 줄 안다. */}
              {todayQuota === 0
                ? "오늘은 발행 요일이 아닙니다"
                : `오늘 게시 ${todayPublished}건 / 한도 ${todayQuota}건`}
            </span>
          )}
          <button type="button" className="sd-btn sd-btn-primary ml-auto" disabled={runningNow} onClick={runNow}>
            {runningNow ? "확인 중…" : "지금 확인하기"}
          </button>
          <button type="button" className="sd-btn" onClick={togglePause}>
            {paused ? "재시작" : "일시정지"}
          </button>
        </div>

        <div className="grid border-t sm:grid-cols-3" style={{ borderColor: "var(--sd-border)" }}>
          <div className="p-3.5 sm:border-r" style={{ borderColor: "var(--sd-border)", background: "var(--sd-card-sub)" }}>
            <div className="text-[10.5px] font-semibold" style={{ color: "var(--sd-label)" }}>지금 하는 일</div>
            <div className="mt-1 text-[12px] font-medium leading-relaxed" style={{ color: "var(--sd-fg)" }}>
              {currentWork}
            </div>
          </div>
          <div className="border-t p-3.5 sm:border-r sm:border-t-0" style={{ borderColor: "var(--sd-border)" }}>
            <div className="flex items-center justify-between gap-2 text-[10.5px] font-semibold" style={{ color: "var(--sd-label)" }}>
              <span>최근 처리</span>
              <a href="#activity" className="font-normal underline-offset-2 hover:underline">전체 보기</a>
            </div>
            {latestRun ? (
              <>
                <div className="mt-1 truncate text-[12px] font-medium" style={{ color: "var(--sd-fg)" }}>
                  {latestRunClip?.title || latestRunProgram || "자동배포 확인"}
                </div>
                <div className="mt-0.5 line-clamp-2 text-[10.5px] leading-relaxed" style={{ color: "var(--sd-mut)" }}>
                  {RESULT_LABEL[latestRun.result] ?? latestRun.result}
                  {latestRun.detail ? ` · ${latestRun.detail}` : ""}
                  {relTime(latestRun.at, nowTs) ? ` · ${relTime(latestRun.at, nowTs)}` : ""}
                </div>
              </>
            ) : (
              <div className="mt-1 text-[11px]" style={{ color: "var(--sd-mut)" }}>아직 처리 기록이 없습니다</div>
            )}
          </div>
          <div className="border-t p-3.5 sm:border-t-0" style={{ borderColor: "var(--sd-border)", background: "var(--sd-card-sub)" }}>
            <div className="text-[10.5px] font-semibold" style={{ color: "var(--sd-label)" }}>자동 확인</div>
            <div className="mt-1 text-[12px] font-medium" style={{ color: "var(--sd-fg)" }}>
              {lastRel ? `마지막 ${lastRel}` : "아직 확인 기록 없음"}
            </div>
            <div className="mt-0.5 text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
              {running && nextRel ? `다음 확인 ${nextRel}` : paused ? "재시작하면 다시 확인합니다" : "자동 확인 대기 중"}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t px-4 py-2.5 text-[11px]" style={{ borderColor: "var(--sd-border)", color: "var(--sd-mut)" }}>
          <Link href="/clips" className="underline-offset-2 hover:underline">
            렌더 중 <b style={{ color: inflightRender ? "var(--sd-fg)" : "var(--sd-mut)" }}>{inflightRender}</b>건
          </Link>
          <a href="#holds" className="underline-offset-2 hover:underline">
            승인 대기 <b style={{ color: heldCount ? "var(--sd-warn)" : "var(--sd-mut)" }}>{heldCount}</b>건
          </a>
          {!loading && idleReason && <span>현재 판단 · {idleReason}</span>}
        </div>
      </section>

      {error && (
        <div
          className="rounded-[4px] px-3 py-2 text-[11.5px]"
          style={{ border: "1px solid var(--sd-danger-border)", background: "var(--sd-danger-bg)", color: "var(--sd-danger-strong)" }}
        >
          자동 배포 상태를 불러오지 못했습니다 ({error}).
        </div>
      )}

      {/* ── ① 프로그램 선택 ─────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <FlowStepHeader step="1" title="프로그램 선택" description="자동배포할 프로그램을 먼저 선택하세요" />
        {programs.length === 0 ? (
          <div className="sd-ph grid min-h-[56px] place-items-center rounded-[6px] px-6 text-center text-[11.5px]"
            style={{ border: "1px dashed var(--sd-border)" }}>
            프로그램이 없습니다 — <Link href="/programs" className="underline">콘텐츠</Link>에서 먼저 만들어 주세요.
          </div>
        ) : (
          <div>
            <label htmlFor="automation-program" className="mb-1.5 block text-[12px] font-medium" style={{ color: "var(--sd-label)" }}>
              배포할 프로그램
            </label>
            <select
              id="automation-program"
              value={selProgram}
              onChange={(e) => setSelProgram(e.target.value)}
              className="sd-input h-10 w-full text-[13px]"
            >
              <option value="">프로그램을 선택하세요</option>
              {programs.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
            {ruleForProgram && (
              <p className="mt-1.5 text-[11px]" style={{ color: "var(--sd-mut)" }}>
                저장된 자동배포 설정이 있습니다. 아래에서 수정한 뒤 시작하면 기존 설정이 갱신됩니다.
              </p>
            )}
          </div>
        )}
      </section>

      {/* ── ② 회차 · 영상 — 분석 완료는 생략, 없으면 등록 ───────────────────── */}
      <section className="flex flex-col gap-3" style={stepDim(Boolean(selProgram))}>
        <div className="flex flex-wrap items-center gap-2">
          <FlowStepHeader step="2" title="프로그램 할당 영상" description="등록된 영상은 자동 분석 대기열에 연결됩니다" />
          {/* 기존 업로드 모달 재사용 — 새 업로드 로직을 발명하지 않는다(F1 과 같은 문). */}
          <span className="ml-auto">
            <UploadVideoButton programId={selProgram || undefined} className="sd-btn" label="＋ 영상 등록" />
          </span>
        </div>
        {!selProgram ? (
          <div className="sd-ph grid min-h-[56px] place-items-center rounded-[6px] px-6 text-center text-[11.5px]"
            style={{ border: "1px dashed var(--sd-border)" }}>
            먼저 프로그램을 선택하세요
          </div>
        ) : programEpisodes.length === 0 ? (
          <div className="sd-ph grid min-h-[56px] place-items-center rounded-[6px] px-6 text-center text-[11.5px]"
            style={{ border: "1px dashed var(--sd-border)" }}>
            등록된 회차가 없습니다 — 위의 ＋ 영상 등록으로 시작하세요
          </div>
        ) : (
          <div className="flex max-h-[240px] flex-col gap-1 overflow-y-auto">
            {programEpisodes.map((ep) => {
              const a = episodeAnalysis(ep, Boolean(mediaForEpisode(ep.id, "master")));
              return (
                <div key={ep.id} className="flex flex-wrap items-center gap-2 rounded-[6px] px-3 py-2.5"
                  style={{ border: "1px solid var(--sd-accent-border)", background: "var(--sd-accent-bg)" }}>
                  <span className="grid size-8 shrink-0 place-items-center rounded-[5px] text-[14px]" style={{ background: "var(--sd-card)" }} aria-hidden>▶</span>
                  <Link href={`/episodes/${ep.id}`} className="text-[12px] font-medium underline-offset-2 hover:underline"
                    style={{ color: "var(--sd-fg)" }}>
                    {ep.episodeNumber}화
                  </Link>
                  <span className="sd-mono text-[10.5px]" style={{ color: "var(--sd-mut)" }}>{ep.broadDate}</span>
                  <span className={cn("ml-auto", a.tag)}>{a.label}</span>
                  {/* 분석 중 진행률 바 — episode.pipeline 진행률(스토어 폴링이 갱신) */}
                  {a.key === "running" && typeof ep.pipeline.progress === "number" && (
                    <span className="h-[5px] w-[110px] overflow-hidden rounded-full" style={{ background: "var(--sd-card-sub)" }}>
                      <span className="block h-full rounded-full"
                        style={{ width: `${Math.max(2, Math.min(100, ep.pipeline.progress))}%`, background: "var(--sd-accent, #2b6cb0)" }} />
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── ③ 자동배포 설정 — 참고 디자인처럼 채널·일정·템플릿·방식을 한 단계로 묶는다. ── */}
      <section className="flex flex-col gap-4" style={stepDim(Boolean(selProgram))}>
        <FlowStepHeader step="3" title="자동배포 설정" description="채널, 일정, 배포 방식과 영상 템플릿을 설정하세요" />

        <div className="flex flex-col gap-2 rounded-[6px] p-3" style={{ background: "var(--sd-card-sub)", border: "1px solid var(--sd-border)" }}>
        <div className="flex flex-wrap items-baseline gap-2">
          <h4 className="text-[12.5px] font-semibold" style={{ color: "var(--sd-fg)" }}>배포 채널</h4>
          <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
            {selChannels.length}개 선택 · 채널당 하루 {perDayCount({ slots, dailyQuota })}개
          </span>
        </div>
        <div className="grid max-h-40 grid-cols-1 gap-1 overflow-y-auto rounded-[4px] p-1.5"
          style={{ border: "1px solid var(--sd-border)" }}>
          {channelOptions.length === 0 && (
            <span className="text-[11px]" style={{ color: "var(--sd-warn)" }}>
              연결된 채널이 없습니다 — <Link href="/publish-channels" className="underline">배포 채널</Link>에서 먼저 연결하세요.
            </span>
          )}
          {channelOptions.map((o) => {
            const key = `${o.platform}:${o.accountId}`;
            const occupied = channelOwnerOtherThanCurrent(key);
            return (
              <label key={key} className="flex flex-wrap items-center gap-1.5 text-[11.5px]"
                style={{ color: occupied ? "var(--sd-mut)" : "var(--sd-fg)", opacity: occupied ? 0.72 : 1 }}>
                <input type="checkbox" checked={selChannels.includes(key)} disabled={Boolean(occupied)}
                  onChange={() => setSelChannels(toggle(selChannels, key))} />
                <span className="truncate">{o.label}</span>
                {occupied && <span className="sd-tag sd-tag--ended">{occupied.programTitle} 자동배포에서 사용 중</span>}
                {/* 게이트 OFF = 실업로드 잠금(운영 설정). 명시적 false 일 때만 — 모름은 침묵. */}
                {isUploadPlatform(o.platform) && gateOff(o.platform, o.accountId) && (
                  <span className="sd-tag sd-tag--warn">실제 업로드 꺼짐 — 기록만 됨</span>
                )}
                {!isUploadPlatform(o.platform) && <span className="sd-tag">기록만 — 실제 게시는 담당자가 직접</span>}
              </label>
            );
          })}
        </div>
        {channelLoadFailed && (
          <p className="text-[10.5px]" style={{ color: "var(--sd-warn)" }}>
            일부 연결 계정을 불러오지 못했습니다 — 배포 채널 화면에서 연결 상태를 확인해 주세요.
          </p>
        )}
        {/* ⚑ 채널별 안내 — 만들 때 성격을 말한다 (F6). 연결 가능한 채널은 전부 실업로드
            대상이고, 꺼져 있는지는 위 배지(gateOff)가 채널별로 말한다. */}
        <p
          className="rounded-[4px] px-2.5 py-2 text-[11px] leading-relaxed"
          style={{ border: "1px solid var(--sd-border)", background: "var(--sd-card)", color: "var(--sd-mut)" }}
        >
          연결한 채널에는 <b>실제 파일이 업로드됩니다</b> — TikTok 은 채널에 바로 공개됩니다.
          운영 설정으로 꺼져 있는 채널은 위에 &ldquo;실제 업로드 꺼짐&rdquo; 배지가 붙고, 그때만 기록으로 남습니다.
        </p>
        </div>

        <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-[12.5px] font-semibold" style={{ color: "var(--sd-fg)" }}>배포 계획</h4>
          {ruleForProgram && (
            <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
              이 프로그램의 자동배포 설정이 이미 있습니다 — 시작하면 <b>갱신</b>됩니다
            </span>
          )}
        </div>

        {/* 배포 방식 — **자동배포의 두 갈래.** 고급 설정에 묻혀 있던 승인 방식을 1급 선택지로
            꺼냈다(사용자 2026-08-24: "자동배포를 두 가지로 나눠줘"). 어떤 계획인지가 곧 이
            선택이라, 접힘 속에 있으면 사용자는 기본값(승인 배포)이 전부인 줄 안다. */}
        <div>
          <div className="mb-1 text-[10.5px]" style={{ color: "var(--sd-label)" }}>배포 방식</div>
          <div className="grid gap-2 sm:grid-cols-2">
            <GateCard
              on={approveFirst} onClick={() => setApproveFirst(true)}
              title="승인 배포"
              desc="클립이 만들어지면 승인 대기에 쌓이고, 사람이 확정해야 채널로 나갑니다."
            />
            <GateCard
              on={!approveFirst} onClick={() => setApproveFirst(false)}
              title="승인 없이 배포"
              desc="조건을 통과하면 바로 나갑니다. 권리 문제가 감지된 건만 승인 대기로 빠집니다."
            />
          </div>
        </div>

        {/* 미디어 종류 — 숏폼만/클립만/둘 다. 배선은 원래 있었지만(rule.mediaKind →
            순방 matchesMediaKind 필터) 고급 설정 select 에 묻혀 있었다(사용자 2026-08-25:
            "진짜로 배선" — 보이게 꺼내는 게 배선의 완성이다). */}
        <div>
          <div className="mb-1 text-[10.5px]" style={{ color: "var(--sd-label)" }}>어떤 영상을 내보낼까</div>
          <div className="grid gap-2 sm:grid-cols-3">
            <GateCard
              on={mediaKind === "short"} onClick={() => setMediaKind("short")}
              title="숏폼만"
              desc="40~90초 세로 쇼츠만 자동 채택·게시합니다."
            />
            <GateCard
              on={mediaKind === "clip"} onClick={() => setMediaKind("clip")}
              title="클립만"
              desc="3~15분 가로 클립만 자동 채택·게시합니다."
            />
            <GateCard
              on={mediaKind === "both"} onClick={() => setMediaKind("both")}
              title="둘 다"
              desc="숏폼과 클립을 모두 자동 채택·게시합니다."
            />
          </div>
        </div>

        {/* 발행 계획(요일·시간) — 반자동 운영의 핵심 조작이라 고급 설정에서 승격(지시 2026-08-24).
            판정은 서버 순방과 같은 순수 함수(isPublishDay·slotsElapsed)가 하고, 여기는 값만 편집한다. */}
        <div className="grid gap-2.5 sm:grid-cols-2">
          {/* 발행 요일 — 비우면 매일(구 계획 동작 그대로). */}
          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-[10.5px]" style={{ color: "var(--sd-label)" }}>발행 요일</span>
              <span className="text-[10.5px]" style={{ color: "var(--sd-fg-dim)" }}>{formatWeekdays(weekdays)}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {[1, 2, 3, 4, 5, 6, 7].map((d) => {
                const on = weekdays.includes(d);
                return (
                  <button
                    key={d} type="button"
                    onClick={() => setWeekdays(on ? weekdays.filter((x) => x !== d) : [...weekdays, d].sort((a, b) => a - b))}
                    className="h-7 w-8 rounded-[5px] text-[11.5px]"
                    style={on
                      ? { background: "var(--sd-fg)", color: "var(--sd-bg)" }
                      : { border: "1px solid var(--sd-border)", color: "var(--sd-fg-dim)" }}
                  >
                    {["", "월", "화", "수", "목", "금", "토", "일"][d]}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 발행 시간 — 하나라도 넣으면 **하루 발행 수 = 시간 개수**가 되고 할당량은 안 쓴다. */}
          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-[10.5px]" style={{ color: "var(--sd-label)" }}>발행 시간 (KST)</span>
              <span className="text-[10.5px]" style={{ color: "var(--sd-fg-dim)" }}>
                {slots.length
                  ? `하루 ${perDayCount({ slots, dailyQuota })}개 — 할당량 대신 이 시간에 맞춰 나갑니다`
                  : "비우면 하루 할당량 방식 (고급 설정)"}
              </span>
            </div>
            <SlotPicker slots={slots} onChange={setSlots} />
          </div>
        </div>

        {/* 월 예상 — 순방 판정과 같은 함수로 계산한다(파일 상단 import 주석). 화면에서 직접 곱하지 않는다. */}
        <PublishEstimate weekdays={weekdays} slots={slots} dailyQuota={dailyQuota} channels={chansOf(selChannels)} />

        {/* 참고 디자인처럼 템플릿 선택과 미리보기를 한 줄에 둔다. 세부 위치 조절은 미리보기에서 한다. */}
        <div>
          <label htmlFor="automation-template" className="mb-1.5 block text-[11px] font-medium" style={{ color: "var(--sd-label)" }}>
            영상 템플릿
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <select
              id="automation-template"
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              className="sd-input h-10 min-w-0 flex-1"
            >
              <option value="">자동 선택 (드라마=확대 크롭 · 그 외=표준)</option>
              {templates.map((t) => <option key={t.name} value={t.name}>{t.title || t.name}</option>)}
            </select>
            <button
              type="button"
              className="sd-btn min-h-10 shrink-0 px-4"
              disabled={!layout}
              onClick={() => setTplPreviewOpen(true)}
            >
              미리보기 · 세부 조정
            </button>
          </div>
        </div>

        <div
          className="rounded-[6px] px-3 py-2.5 text-[11.5px] leading-relaxed"
          style={{ background: "color-mix(in srgb, var(--sd-ok) 9%, var(--sd-card))", borderLeft: "3px solid var(--sd-ok)", color: "var(--sd-fg)" }}
        >
          <b>메타데이터 자동생성 · 필수</b>
          <span style={{ color: "var(--sd-mut)" }}> — 영상을 분석해 채널에 맞는 제목·설명·태그를 자동으로 만듭니다.</span>
        </div>

        {/* 담당자 알림 — 자동배포가 실제로 나가면 이 주소로 영상 제목·URL 메일이 간다.
            계획이 아니라 워크스페이스 설정이다(어느 계획이 내보내든 같은 담당자가 받는다). */}
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-[11px]" style={{ color: "var(--sd-label)" }}>
            담당자 이메일 (배포 완료 알림)
          </label>
          <input
            type="email"
            className="sd-input w-[220px]"
            placeholder="비우면 알림 없음"
            value={notifyEmail}
            onChange={(e) => setNotifyEmail(e.target.value)}
          />
          <button
            type="button"
            className="sd-btn"
            disabled={savingNotify || notifyEmail.trim() === notifyEmailSaved}
            onClick={() => {
              void (async () => {
                setSavingNotify(true);
                try {
                  const r = await setAutomationNotifyEmail(notifyEmail.trim());
                  setNotifyEmailSaved(r.notifyEmail);
                  setNotifyEmail(r.notifyEmail);
                  toast({
                    title: r.notifyEmail ? "알림 이메일 저장됨" : "알림 껐습니다",
                    description: r.notifyEmail
                      ? `자동배포가 완료되면 ${r.notifyEmail} 로 제목·링크를 보냅니다.`
                      : "배포 완료 알림 메일을 보내지 않습니다.",
                    tone: "done",
                  });
                } catch (err) {
                  toast({ title: "저장 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
                } finally {
                  setSavingNotify(false);
                }
              })();
            }}
          >
            {savingNotify ? "저장 중…" : notifyEmail.trim() === notifyEmailSaved ? "저장됨" : "저장"}
          </button>
        </div>

        {/* 고급 설정 — 구 계획 폼(점수 기준·한도·시간창·정책·템플릿) 접기로 격하 · 삭제 금지 */}
        <button
          type="button"
          className="self-start text-[11px] underline-offset-2 hover:underline"
          style={{ color: "var(--sd-mut)" }}
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? "▾ 고급 설정 접기" : "▸ 고급 설정 (한도 · AI 리프레임)"}
        </button>
        {showAdvanced && (
          <div className="flex flex-col gap-2.5 rounded-[5px] p-3"
            style={{ background: "var(--sd-card-sub)", border: "1px solid var(--sd-border)" }}>
            {/* 채택 기준(점수 하한) 선택은 2026-08-26 삭제 — 점수 순 상위 하나로 고정됐다.
                하한은 쇼츠 점수 분포상 계획 전량을 막아 세우는 함정이었고(서버 주석 참조),
                화면의 "점수 80 이상" 배지는 그 사실을 사용자에게 설명해 주지도 못했다. */}

            {/* AI 리프레임 — 수동 채택 다이얼로그(adopt-dialog)와 같은 선택지·라벨.
                숏폼(세로) 전용 옵션이다: 클립(가로)은 크롭이 없고, "둘 다"는 방향이 추천마다
                달라 orientation 을 못 정한다(서버가 portrait 에서만 AI 허용) — 흐리게 + none 강제. */}
            <div style={mediaKind !== "short" ? { opacity: 0.65, pointerEvents: "none" } : undefined}>
              <div className="text-[10.5px]" style={{ color: "var(--sd-label)" }}>
                AI 리프레임 (숏폼 9:16)
              </div>
              <div className="mt-1 grid grid-cols-2 gap-2">
                {([
                  ["ai", "AI 리프레임 ON", "beat별 얼굴 추적 자동 크롭"],
                  ["none", "OFF", "중앙 고정 크롭"],
                ] as const).map(([value, title, sub]) => {
                  const active = reframe === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setReframe(value)}
                      className="rounded-[5px] px-3 py-2 text-left transition"
                      style={{
                        border: `1px solid ${active ? "var(--sd-accent-border)" : "var(--sd-border)"}`,
                        background: active ? "var(--sd-accent-bg)" : "var(--sd-card)",
                      }}
                    >
                      <div className="text-[12px] font-medium" style={{ color: active ? "var(--sd-accent)" : "var(--sd-fg)" }}>{title}</div>
                      <div className="text-[10.5px]" style={{ color: "var(--sd-mut)" }}>{sub}</div>
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 text-[10.5px]" style={{ color: "var(--sd-fg-dim)" }}>
                AI 리프레임 — 인물 위치를 따라 9:16 구도를 자동으로 잡습니다 (렌더 시간이 늘어납니다)
              </p>
            </div>

            {/* 발행 요일·발행 시간은 본문(배포 방식 아래)으로 승격 — 지시 2026-08-24.
                여기 남는 것은 할당량·활동 시간창(한도)뿐이다. */}

            {/* 하루 할당량 · 활동 시간창 — 할당량이 찰 때까지 시간창 안에서 확인 때마다 계속 배포 */}
            <div className="grid grid-cols-3 items-end gap-2" style={slots.length ? { opacity: 0.65 } : undefined}>
              <label className="text-[10.5px]" style={{ color: "var(--sd-label)" }}>
                채널당 하루 할당량
                <input type="number" min={1} max={50} value={dailyQuota} disabled={slots.length > 0}
                  onChange={(e) => setDailyQuota(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
                  className="sd-input mt-1 w-full" />
              </label>
              <label className="text-[10.5px]" style={{ color: "var(--sd-label)" }}>
                시작 (시 · KST)
                <input type="number" min={0} max={23} value={activeStart}
                  onChange={(e) => setActiveStart(Math.max(0, Math.min(23, Number(e.target.value) || 0)))}
                  className="sd-input mt-1 w-full" />
              </label>
              <label className="text-[10.5px]" style={{ color: "var(--sd-label)" }}>
                종료 (시 · KST)
                <input type="number" min={1} max={24} value={activeEnd}
                  onChange={(e) => setActiveEnd(Math.max(1, Math.min(24, Number(e.target.value) || 24)))}
                  className="sd-input mt-1 w-full" />
              </label>
            </div>
            <p className="text-[10.5px]" style={{ color: "var(--sd-fg-dim)" }}>
              {slots.length
                ? `${formatWeekdays(weekdays)} · ${slots.map(slotLabel).join(" ")} 에 맞춰 채널마다 하루 ${perDayCount({ slots, dailyQuota })}개를 내보냅니다.`
                : `${activeStart}시~${activeEnd}시(KST) 사이에만 배포하고, 채널마다 하루 ${dailyQuota}개를 채우면 다음 날까지 쉽니다.`}
            </p>

            <input value={win} onChange={(e) => setWin(e.target.value)} placeholder="시간대" className="sd-input w-full" />

            {/* 미리보기 + 위치 조절 — 저장되는 렌더 기하와 같은 % 좌표를 그대로 그린다.
                소형 카드 클릭 = 대형 다이얼로그(같은 TemplatePreview, width 만 다름). */}
            {layout && (
              <div className="flex gap-3">
                <div className="flex shrink-0 flex-col gap-1">
                  <button
                    type="button"
                    className="cursor-zoom-in"
                    onClick={() => setTplPreviewOpen(true)}
                    aria-label="템플릿 미리보기 크게 보기"
                    title="클릭하면 크게 봅니다"
                  >
                    <TemplatePreview
                      template={templates.find((t) => t.name === effectiveTemplate) ?? null}
                      accent={(TEMPLATE_SEED_UI[effectiveTemplate] ?? TEMPLATE_SEED_UI["broadcast-standard"]).accent}
                      layout={layout}
                      frameSrc={sampleFrameSrc}
                      subtitlesOn={subtitles}
                      timeboxText={programs.find((p) => p.id === selProgram)?.schedule}
                      iconSrc={programs.find((p) => p.id === selProgram)?.hasBrandIcon ? programImageUrl(selProgram, "icon") : undefined}
                    />
                  </button>
                  <span className="text-center text-[10px]" style={{ color: "var(--sd-mut)" }}>
                    클릭해 크게 보기
                  </span>
                </div>
                <LayoutSliders layout={layout} onChange={setLayout} className="flex-1 space-y-2 text-[10.5px]"
                  subtitlesOn={subtitles} onSubtitlesChange={setSubtitles} />
              </div>
            )}

            {/* 자막 켜기 — 계획 기본 ON. 끄면 이 계획의 자동 클립을 자막(STT 번인) 없이 렌더한다
                (드라마 등 원본에 자막이 이미 있는 회차용). 위 미리보기의 자막도 함께 사라진다. */}
            <label className="flex items-center gap-2 text-[11.5px]" style={{ color: "var(--sd-fg)" }}>
              <input type="checkbox" checked={subtitles} onChange={(e) => setSubtitles(e.target.checked)} />
              자막 켜기 (끄면 이 계획의 자동 클립에 자막을 넣지 않습니다 — 원본에 자막이 이미 있는 회차용)
            </label>

          </div>
        )}

        {/* 진행 패널 — 단계별 사실만(개수·상태). 스토어 폴링 + 편승 재조회가 갱신한다. */}
        {selProgram && progress && (
          <div className="flex flex-col gap-2 rounded-[6px] p-3" style={{ background: "var(--sd-card-sub)", border: "1px solid var(--sd-border)" }}>
            <div className="flex items-baseline justify-between gap-2">
              <h4 className="text-[12.5px] font-semibold" style={{ color: "var(--sd-fg)" }}>배포 대기 목록</h4>
              <span className="text-[10.5px]" style={{ color: "var(--sd-mut)" }}>분석 → 클립 선정 → 렌더 → 배포</span>
            </div>
            <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
            {/* 1) 분석 */}
            <div className="rounded-[5px] p-2.5" style={{ border: "1px solid var(--sd-border)" }}>
              <div className="text-[11px] font-semibold" style={{ color: "var(--sd-label)" }}>1 · 분석</div>
              <div className="mt-1 text-[11.5px] leading-relaxed" style={{ color: "var(--sd-fg)" }}>
                {progress.analysis.total === 0
                  ? "회차 없음"
                  : `완료 ${progress.analysis.done} · 진행 ${progress.analysis.running} · 대기 ${progress.analysis.waiting}` +
                    (progress.analysis.failed ? ` · 실패 ${progress.analysis.failed}` : "") +
                    (progress.analysis.noVideo ? ` · 영상 없음 ${progress.analysis.noVideo}` : "")}
              </div>
            </div>
            {/* 2) 클립 자동 선정 — rule_run media_created */}
            <div className="rounded-[5px] p-2.5" style={{ border: "1px solid var(--sd-border)" }}>
              <div className="text-[11px] font-semibold" style={{ color: "var(--sd-label)" }}>2 · 클립 자동 선정</div>
              <div className="mt-1 text-[11.5px] leading-relaxed" style={{ color: "var(--sd-fg)" }}>
                {progress.rule
                  ? `자동 생성 클립 ${progress.createdCount}건`
                  : "설정 없음 — 자동배포 시작을 누르면 만들어집니다"}
              </div>
            </div>
            {/* 3) 렌더 — 클립 rendered */}
            <div className="rounded-[5px] p-2.5" style={{ border: "1px solid var(--sd-border)" }}>
              <div className="text-[11px] font-semibold" style={{ color: "var(--sd-label)" }}>3 · 렌더</div>
              <div className="mt-1 text-[11.5px] leading-relaxed" style={{ color: "var(--sd-fg)" }}>
                {progress.createdCount === 0 ? "대상 없음" : `렌더 완료 ${progress.rendered} / ${progress.createdCount}건`}
              </div>
            </div>
            {/* 4) 배포 — clip.distributions 상태 */}
            <div className="rounded-[5px] p-2.5" style={{ border: "1px solid var(--sd-border)" }}>
              <div className="text-[11px] font-semibold" style={{ color: "var(--sd-label)" }}>4 · 배포</div>
              <div className="mt-1 text-[11.5px] leading-relaxed" style={{ color: "var(--sd-fg)" }}>
                {progress.createdCount === 0 && progress.heldCount === 0
                  ? "대상 없음"
                  : `게시 ${progress.published} · 진행 ${progress.pending} · 기록 ${progress.recorded}` +
                    (progress.failed ? ` · 실패 ${progress.failed}` : "") +
                    (progress.heldCount ? ` · 승인 대기 ${progress.heldCount}` : "")}
              </div>
            </div>
            </div>
          </div>
        )}

        </div>

        {/* 참고 디자인의 명확한 액션 바. 시작/초기화/중단은 설정이 끝난 뒤 한곳에 모은다. */}
        <div className="flex flex-wrap gap-2 border-t pt-4" style={{ borderColor: "var(--sd-border)" }}>
          <button
            type="button"
            className="sd-btn sd-btn-primary min-h-10 px-5 text-[12.5px] font-semibold"
            disabled={starting || !selProgram || selChannels.length === 0}
            onClick={() => void startAutoDeploy()}
          >
            {starting ? "시작 중…" : "▶ 자동배포 시작"}
          </button>
          <button type="button" className="sd-btn min-h-10 px-5 text-[12.5px] font-semibold" onClick={resetWizard}>
            ↺ 입력 초기화
          </button>
          {(hasEnabledRules || paused) && (
            <button
              type="button"
              className="sd-btn min-h-10 px-5 text-[12.5px] font-semibold"
              style={{ borderColor: "var(--sd-danger-border)", color: "var(--sd-danger-strong)" }}
              onClick={togglePause}
            >
              {paused ? "▶ 자동배포 재시작" : "■ 자동배포 중단"}
            </button>
          )}
        </div>
      </section>

      {/* 저장 전에도 선택한 일정이 어떻게 해석되는지 바로 보여 준다. */}
      <section className="sd-card flex flex-col gap-3 p-4 sm:p-5">
        <div className="flex items-baseline gap-2">
          <h3 className="text-[15px] font-semibold" style={{ color: "var(--sd-fg)" }}>배포 스케줄</h3>
          <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>선택한 요일·시간·채널 기준</span>
        </div>
        <ScheduleSummary
          ready={Boolean(selProgram && selChannels.length)}
          weekdays={weekdays}
          slots={slots}
          dailyQuota={dailyQuota}
          activeStart={activeStart}
          activeEnd={activeEnd}
          channelCount={selChannels.length}
        />
      </section>

      {/* ── 승인 대기 — 사람이 확정하는 지점(F6 Invariant) · ④ 아래 유지 ────── */}
      {/* id="holds" — 상태 헤더의 "확정 대기(보류)" 딥링크 대상. scroll-mt 로 상단 여백. */}
      <section id="holds" className="flex scroll-mt-4 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="sd-serif text-[16px] font-semibold" style={{ color: "var(--sd-fg)" }}>승인 대기</h3>
          <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
            사람 확인이 필요한 건입니다 — <b>승인해야 다음 확인 때 게시됩니다.</b> 저절로 나가지 않습니다.
          </span>
          {heldClips.length > 0 && (
            <button
              type="button"
              className="sd-btn ml-auto"
              disabled={releasing !== null}
              onClick={() => void releaseAll()}
            >
              {releasing === "__all__" ? "전체 승인 중…" : `전체 승인 (영상 ${heldClips.length}개)`}
            </button>
          )}
        </div>
        {heldClips.length === 0 ? (
          <div
            className="sd-ph grid min-h-[80px] place-items-center rounded-[6px] px-6 text-center"
            style={{ border: "1px dashed var(--sd-border)" }}
          >
            {loading ? "불러오는 중…" : error ? "상태를 불러오지 못했습니다" : "승인 대기 중인 건이 없습니다"}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {heldClips.map((entry) => {
              // 원시 clipId 만으론 판단이 안 된다 — 스토어의 클립·계획과 조인해 얼굴을 붙인다.
              const clip = clips.find((c) => c.id === entry.clipId);
              // 계획은 부가정보다(사람이 보는 단위는 영상) — 여럿이면 첫 계획의 프로그램만 쓴다.
              const rule = rules.find((r) => r.id === entry.holds[0]?.ruleId);
              const ruleProgram = rule
                ? programs.find((p) => p.id === (rule.programIds?.[0] ?? rule.programId))
                : undefined;
              const thumb = clip ? clipThumbSrc(clip) : undefined;
              const key = entry.clipId;
              return (
                <div key={key} className="sd-card flex flex-wrap items-center gap-3 px-3 py-2.5">
                  {thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element -- 서버 동적 프레임(최적화 대상 아님)
                    <img src={thumb} alt="" className="h-12 w-[68px] shrink-0 rounded-[3px] object-cover" />
                  ) : (
                    <div
                      className="grid h-12 w-[68px] shrink-0 place-items-center rounded-[3px] text-[9px]"
                      style={{ background: "var(--sd-card-sub)", color: "var(--sd-mut)" }}
                    >
                      no img
                    </div>
                  )}
                  <div className="min-w-[220px] flex-1">
                    <div className="truncate text-[12.5px] font-medium" style={{ color: "var(--sd-fg)" }}>
                      {clip?.title || entry.clipId}
                    </div>
                    <div className="sd-mono text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                      {clip ? `${Math.round(clip.durationSec)}초 · ` : ""}
                      {ruleProgram?.title ? `자동배포 ${ruleProgram.title} · ` : ""}
                      {/* 계획이 둘 이상 걸린 영상은 그 사실만 짧게 — 승인은 어차피 한 번에 다 푼다. */}
                      {entry.holds.length > 1 ? `채널 연결 ${entry.holds.length}개 · ` : ""}
                      대기 시작 {entry.heldAt?.slice(0, 16).replace("T", " ") || "—"}
                    </div>
                    {/* 사유는 잘리면 판단을 못 한다 — 둘째 줄 전체 폭. 사유가 여럿이면 다 적는다. */}
                    <div className="text-[11px] leading-relaxed" style={{ color: "var(--sd-warn)" }}>
                      {entry.reasons.join(" · ")}
                    </div>
                  </div>
                  {/* 미리보기 = 나갈 파일 그대로. 승인 버튼이 같은 카드에 남아 있어야
                      보면서 바로 승인한다 — 그래서 새 화면이 아니라 카드 안에서 편다. */}
                  <button
                    type="button"
                    className="sd-btn shrink-0"
                    aria-expanded={previewClipId === entry.clipId}
                    onClick={() => setPreviewClipId(previewClipId === entry.clipId ? null : entry.clipId)}
                  >
                    {previewClipId === entry.clipId ? "미리보기 닫기" : "미리보기"}
                  </button>
                  <Link href={`/editor/${entry.clipId}`} className="sd-btn shrink-0">편집</Link>
                  <button
                    type="button"
                    className="sd-btn shrink-0"
                    disabled={releasing !== null || rejecting !== null}
                    onClick={() => void reject(entry)}
                    title="이 영상을 현재 자동배포에서 제외합니다"
                  >
                    {rejecting === key ? "거부 중…" : "거부"}
                  </button>
                  <button
                    type="button"
                    className="sd-btn sd-btn-primary shrink-0"
                    disabled={releasing !== null || rejecting !== null}
                    onClick={() => void release(entry)}
                  >
                    {releasing === key ? "승인 중…" : "승인 — 다음 확인 때 게시"}
                  </button>
                  {previewClipId === entry.clipId && (
                    <div className="flex w-full justify-center pt-1">
                      {clip
                        ? <HeldPreview clip={clip} />
                        : (
                          <div className="w-full rounded-[4px] px-3 py-2 text-[11px]" style={{ background: "var(--sd-card-sub)", color: "var(--sd-warn)" }}>
                            클립 정보를 찾지 못했습니다 — 목록을 새로고침해 주세요
                          </div>
                        )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── 저장 설정 / 최근 처리 / 완료 영상을 Main.dc.html처럼 각각 가볍게 분리한다. ── */}
      <section className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <h3 className="text-[15px] font-semibold" style={{ color: "var(--sd-fg)" }}>저장된 자동배포</h3>
          <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>자동배포는 여러 개 만들 수 있고, 채널 하나는 한 곳에만 연결됩니다</span>
        </div>

        {/* 계획 목록 — 무엇이 돌고 있는지의 정본 */}
        {rules.length === 0 ? (
          <div
            className="sd-ph grid min-h-[70px] place-items-center rounded-[6px] px-6 text-center"
            style={{ border: "1px dashed var(--sd-border)" }}
          >
            {loading ? "불러오는 중…" : error ? "상태를 불러오지 못했습니다" : "저장된 자동배포가 없습니다 — 위에서 프로그램과 채널을 선택해 시작하세요"}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {rules.map((r) => {
              const pids = programsOf(r);
              const chans = channelsOf(r);
              const firstProgram = programs.find((p) => p.id === pids[0]);
              const uploadChans = chans.filter((c) => isUploadPlatform(c.platform));
              // 실업로드 채널이 있어도 게이트가 전부 꺼져 있으면 "실행 중"은 착시다 — 기록만.
              const uploadLive = uploadChans.some((c) => !gateOff(c.platform, c.accountId));
              return (
                <div key={r.id} className="sd-card flex flex-wrap items-center gap-2 px-3 py-2.5">
                  <span className="text-[12.5px] font-medium" style={{ color: "var(--sd-fg)" }}>
                    {firstProgram?.title ?? pids[0]}{pids.length > 1 ? ` 외 ${pids.length - 1}개` : ""} → 채널 {chans.length}곳
                  </span>
                  <span className={cn("sd-tag", !r.enabled ? "sd-tag--ended" : uploadChans.length > 0 && uploadLive ? "sd-tag--airing" : "")}>
                    {!r.enabled ? "멈춤" : uploadChans.length > 0 && uploadLive ? "실행 중" : "기록만"}
                  </span>
                  <span className="sd-tag">{KIND_LABEL[r.mediaKind]}</span>
                  <span className="sd-tag sd-tag--warn">
                    {r.gatePolicy === "approve_first" ? "승인 배포 — 사람이 확정해야 게시" : "승인 없이 배포 (권리 문제만 승인 대기로)"}
                  </span>
                  <span className="sd-tag">하루 {monthlyPublishEstimate(r).perDay}개/채널</span>
                  <span className="sd-tag">{formatWeekdays(r.weekdays)}</span>
                  <span className="basis-full text-[11px]" style={{ color: "var(--sd-fg-dim)" }}>
                    발행 계획: <strong style={{ color: "var(--sd-fg)" }}>{formatWeekdays(r.weekdays)}</strong>
                    {" · "}
                    <strong style={{ color: "var(--sd-fg)" }}>
                      {r.slots?.length ? ruleSlots(r).map(slotLabel).join(" · ") : `${r.activeStart ?? 9}:00~${r.activeEnd ?? 22}:00`}
                    </strong>
                    {" · "}
                    하루 {monthlyPublishEstimate(r).perDay}개
                  </span>
                  <span className="sd-tag">
                    {r.slots?.length ? ruleSlots(r).map(slotLabel).join(" ") : `${r.activeStart ?? 9}~${r.activeEnd ?? 22}시`}
                  </span>
                  <span className="sd-tag">월 예상 {monthlyPublishEstimate(r).perMonth}건</span>
                  <span className="sd-tag">{r.templateId ? `템플릿 ${r.templateId}` : "템플릿 자동"}</span>
                  {/* 오늘 게시 수 — 서버가 publishedToday 를 내려줄 때만(구버전은 숨김). */}
                  {r.publishedToday &&
                    chans.map((c) => {
                      const n = r.publishedToday?.[`${c.platform}:${c.accountId}`];
                      if (typeof n !== "number") return null;
                      return (
                        <span key={`${c.platform}:${c.accountId}`} className="sd-tag">
                          {/* 분모는 **서버 판정과 같은 함수**로 낸다(perDayCount). 예전엔 r.dailyQuota
                              를 직접 읽어, 발행 시간(슬롯)을 쓰는 계획에서 늘 틀린 수가 떴다 —
                              15:00×20 계획인데 "0/3" (2026-08-27 사용자 신고). 슬롯이 있으면
                              서버는 dailyQuota 를 아예 무시하고 슬롯 개수 합을 쓴다. */}
                          오늘: {channelLabel(c.platform)} {n}/{perDayCount(r)}
                        </span>
                      );
                    })}

                  <div className="ml-auto flex gap-2">
                    <button
                      type="button"
                      className="sd-btn"
                      onClick={() => {
                        prefilledFor.current = null;
                        const nextProgram = pids[0] ?? "";
                        // Re-selecting the same program must still reload the
                        // saved rule values into the editor.
                        setSelProgram("");
                        window.setTimeout(() => setSelProgram(nextProgram), 0);
                        document.getElementById("automation-program")?.scrollIntoView({ behavior: "smooth", block: "start" });
                      }}
                    >
                      편집
                    </button>
                    <button
                      type="button"
                      className="sd-btn"
                      onClick={async () => {
                        try {
                          await saveAutomationRule({ ...r, enabled: !r.enabled });
                          toast({
                            title: r.enabled ? "자동배포를 멈췄습니다" : "자동배포를 재개했습니다",
                            description: firstProgram?.title ?? r.programId,
                            tone: "done",
                          });
                        } catch (err) {
                          toast({ title: "변경 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
                        } finally {
                          await load();
                        }
                      }}
                    >
                      {r.enabled ? "멈춤" : "재개"}
                    </button>
                    <button
                      type="button"
                      className="sd-btn"
                      onClick={async () => {
                        if (!window.confirm("이 프로그램의 자동배포 설정을 지웁니다. 이미 게시된 영상은 내려가지 않습니다. 계속할까요?")) return;
                        try {
                          const res = await deleteAutomationRule(r.id);
                          toast({ title: "자동배포 설정을 지웠습니다", description: res.notice, tone: "done" });
                        } catch (err) {
                          toast({ title: "삭제 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
                        } finally {
                          await load();
                        }
                      }}
                    >
                      삭제
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 진행·대기·실패 기록. 실제 게시 완료는 아래 완료 영상에 따로 둔다.
            로그가 길어 접이식(사용자 2026-08-24) — 기본 접힘, 헤더에 건수를 보여 열 이유를 준다. */}
        <div id="activity" className="mt-4 flex scroll-mt-4 items-baseline gap-2 border-t pt-4" style={{ borderColor: "var(--sd-border)" }}>
          <button
            type="button"
            className="flex items-baseline gap-2"
            onClick={() => setShowActivity((v) => !v)}
            aria-expanded={showActivity}
          >
            <h4 className="text-[14px] font-semibold" style={{ color: "var(--sd-fg)" }}>
              {showActivity ? "▾" : "▸"} ⏳ 배포 대기
              <span className="ml-1.5 text-[11px] font-normal" style={{ color: "var(--sd-mut)" }}>
                {recentProcessRuns.length}건
              </span>
            </h4>
          </button>
          <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
            분석·렌더·업로드 시작·대기·실패를 시간순으로 봅니다
          </span>
        </div>
        {!showActivity ? null : recentProcessRuns.length === 0 ? (
          <div
            className="sd-ph grid min-h-[80px] place-items-center rounded-[6px] px-6 text-center text-[11.5px]"
            style={{ border: "1px dashed var(--sd-border)", color: "var(--sd-mut)" }}
          >
            {loading ? "불러오는 중…" : error ? "상태를 불러오지 못했습니다" : "현재 진행 중이거나 확인이 필요한 처리 기록이 없습니다"}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {recentProcessRuns.map((run) => {
              const clip = clips.find((c) => c.id === run.clipId);
              // accountKey("platform:accountId") — 구 응답엔 없을 수 있다(없으면 채널
              // 배지·배포 상태 조인만 생략, 나머지는 그대로).
              const platform = run.accountKey ? run.accountKey.split(":")[0] : "";
              const accountId = run.accountKey ? run.accountKey.slice(platform.length + 1) : "";
              // 채널 단독 매칭이면 같은 플랫폼의 **다른 계정** 행(수동 배포 등)의 origin·링크를
              // 집을 수 있다 — 계정까지 맞는 행을 우선, 없으면 채널 단독 폴백(구 기록 호환).
              const distRows = platform ? (clip?.distributions ?? []).filter((d) => d.channel === platform) : [];
              const matchesAccount = (d: (typeof distRows)[number]) => {
                const acct = d as unknown as Record<string, unknown>;
                const id = acct.youtubeChannelId ?? acct.naverAccountId ?? acct.tiktokOpenId
                  ?? acct.igUserId ?? acct.metaPageId;
                return id != null && String(id) === accountId;
              };
              const dist = distRows.find(matchesAccount) ?? distRows[0];
              const ytId = platform === "youtube" ? dist?.externalId : undefined;
              // 자동/수동 배지 — 배포 기록의 origin 이 있을 때만(구 기록은 표기 생략).
              const originLabel = originLabelOf(dist?.origin);
              // 큐잉 시점의 published 는 "업로드 시작"일 뿐이다 — 실제 완료/실패는
              // 클립의 배포 상태에서 온다(있으면 덮어쓴다).
              let label = RESULT_LABEL[run.result] ?? run.result;
              let tag = RESULT_TAG[run.result] ?? "sd-tag";
              let reason = run.detail;
              if (run.result === "published") {
                if (dist?.status === "published") {
                  label = "게시함"; tag = "sd-tag sd-tag--airing";
                } else if (dist?.status === "failed") {
                  label = "실패"; tag = "sd-tag sd-tag--danger";
                  reason = dist.error || run.detail;
                }
              }
              return (
                <div key={run.id} className="sd-card flex flex-wrap items-center gap-3 px-3 py-2">
                  <span className="sd-mono shrink-0 text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                    {run.at?.slice(0, 16).replace("T", " ")}
                  </span>
                  <span className="min-w-[160px] flex-1 truncate text-[12px] font-medium" style={{ color: "var(--sd-fg)" }}>
                    {clip?.title || run.clipId || "—"}
                  </span>
                  {platform && <span className="sd-tag shrink-0">{channelLabel(platform)}</span>}
                  <span className={cn("shrink-0", tag)}>{label}</span>
                  {originLabel && <span className="sd-tag shrink-0">{originLabel}</span>}
                  {ytId && (
                    <a
                      href={`https://www.youtube.com/watch?v=${ytId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="sd-btn shrink-0"
                    >
                      열기
                    </a>
                  )}
                  {/* 사유("안 보냄" 등)는 잘리면 읽을 수 없다 — 둘째 줄 전체 폭. */}
                  {reason && (
                    <span className="basis-full text-[10.5px] leading-relaxed" style={{ color: "var(--sd-mut)" }}>
                      {reason}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-4 flex items-baseline gap-2 border-t pt-4" style={{ borderColor: "var(--sd-border)" }}>
          <h4 className="text-[14px] font-semibold" style={{ color: "var(--sd-fg)" }}>✅ 배포 완료 영상</h4>
          <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>실제 채널 게시까지 확인된 영상만 표시합니다</span>
        </div>
        {completedRuns.length === 0 ? (
          <div className="sd-ph grid min-h-[80px] place-items-center rounded-[6px] px-6 text-center text-[11.5px]"
            style={{ border: "1px dashed var(--sd-border)", color: "var(--sd-mut)" }}>
            {loading ? "불러오는 중…" : error ? "상태를 불러오지 못했습니다" : "아직 배포 완료된 영상이 없습니다"}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {completedRuns.map((run) => {
              const clip = clips.find((item) => item.id === run.clipId);
              const platform = run.accountKey?.split(":")[0] ?? "";
              const dist = (clip?.distributions ?? []).find((distribution) => distribution.channel === platform);
              const externalUrl = platform === "youtube" && dist?.externalId
                ? `https://www.youtube.com/watch?v=${dist.externalId}`
                : null;
              return (
                <div key={run.id} className="flex flex-wrap items-center gap-3 rounded-[4px] px-3 py-3"
                  style={{ background: "var(--sd-card-sub)", borderLeft: "3px solid var(--sd-ok)" }}>
                  <div className="grid size-10 shrink-0 place-items-center rounded-[4px] text-[16px]"
                    style={{ background: "var(--sd-card)" }} aria-hidden>▶</div>
                  <div className="min-w-[180px] flex-1">
                    <div className="truncate text-[12.5px] font-semibold" style={{ color: "var(--sd-fg)" }}>
                      {clip?.title || run.clipId || "자동배포 영상"}
                    </div>
                    <div className="mt-0.5 text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                      {run.at?.slice(0, 16).replace("T", " ")}{platform ? ` · ${channelLabel(platform)}` : ""}
                    </div>
                  </div>
                  <span className="sd-tag sd-tag--airing">배포됨</span>
                  {externalUrl && <a href={externalUrl} target="_blank" rel="noreferrer" className="sd-btn">열기</a>}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 하단 안내 — 승인 대기 동작. "실제 업로드 잠금"(운영 설정)과 구분해 말한다. */}
      <div
        className="rounded-[4px] px-3 py-2.5 text-[11.5px] leading-relaxed"
        style={{ border: "1px solid var(--sd-warn-border)", background: "var(--sd-warn-bg)", color: "var(--sd-warn)" }}
      >
        <b>승인 대기 미디어는 저절로 나가지 않습니다.</b> 권리 확인 등으로 승인 대기에 들어온
        건은 사람이 승인해야 다음 확인 때 게시됩니다. 실제 업로드 잠금(운영 설정)은 이것과
        별개입니다 — 잠겨 있으면 승인해도 기록만 남습니다.
      </div>

      {/* 템플릿 대형 미리보기 — 부모 layout 상태를 공유해 슬라이더가 즉시 반영된다. */}
      {tplPreviewOpen && layout && (
        <TemplatePreviewDialog
          template={templates.find((t) => t.name === effectiveTemplate) ?? null}
          accent={(TEMPLATE_SEED_UI[effectiveTemplate] ?? TEMPLATE_SEED_UI["broadcast-standard"]).accent}
          layout={layout}
          frameSrc={sampleFrameSrc}
          subtitlesOn={subtitles}
          onSubtitlesChange={setSubtitles}
          // 시간박스 문구 주석은 컴포넌트 prop 정의에 있다 — 선택 프로그램의 편성 문구, 없으면 예시.
          timeboxText={programs.find((p) => p.id === selProgram)?.schedule}
          iconSrc={programs.find((p) => p.id === selProgram)?.hasBrandIcon ? programImageUrl(selProgram, "icon") : undefined}
          onLayoutChange={setLayout}
          onClose={() => setTplPreviewOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * 단계 머리말 — **작은 라벨 + 제목 한 줄**(AENA 자동배포 화면과 같은 형태 · 2026-08-28).
 *
 * 예전엔 액센트색 동그라미 배지를 앞에 뒀는데, 단계가 셋이라 화면 위쪽에 색 원이 셋
 * 쌓여 시선이 분산됐다. AENA 쪽이 더 깔끔하다는 사용자 판단에 맞춰 배지를 걷어내고
 * "1단계" 를 옅은 라벨로 낮춘다 — 위계는 제목이 지고, 번호는 순서만 알려주면 된다.
 * (색은 STEP D 토큰 그대로다 — AENA 의 zinc 클래스를 옮기면 다크 테마가 깨진다.)
 */
function FlowStepHeader({ step, title, description }: { step: string; title: string; description: string }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="text-[11px] font-semibold tracking-wide" style={{ color: "var(--sd-mut)" }}>
        {step}단계
        <span className="ml-1.5 text-[15px] font-semibold tracking-normal" style={{ color: "var(--sd-fg)" }}>
          {title}
        </span>
      </p>
      <p className="mt-1 text-[11px] leading-relaxed" style={{ color: "var(--sd-mut)" }}>{description}</p>
    </div>
  );
}

function ScheduleSummary({ ready, weekdays, slots, dailyQuota, activeStart, activeEnd, channelCount }: {
  ready: boolean;
  weekdays: number[];
  slots: RuleSlot[];
  dailyQuota: number;
  activeStart: number;
  activeEnd: number;
  channelCount: number;
}) {
  if (!ready) {
    return (
      <div className="sd-ph grid min-h-[88px] place-items-center rounded-[6px] px-6 text-center text-[11.5px]"
        style={{ border: "1px dashed var(--sd-border)" }}>
        프로그램과 배포 채널을 선택하면 스케줄이 표시됩니다
      </div>
    );
  }

  // 서버 판정과 **같은 함수**로 낸다 — 슬롯이 있으면 dailyQuota 는 무시된다(perDayCount).
  const perDay = perDayCount({ slots, dailyQuota });
  const timeLabel = slots.length ? slots.map(slotLabel).join(" · ") : `${activeStart}:00~${activeEnd}:00 사이 자동 확인`;
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <div className="rounded-[6px] p-3" style={{ background: "var(--sd-card-sub)", borderLeft: "3px solid var(--sd-ok)" }}>
        <div className="text-[10.5px] font-medium" style={{ color: "var(--sd-label)" }}>배포 요일</div>
        <div className="mt-1 text-[13px] font-semibold" style={{ color: "var(--sd-fg)" }}>{formatWeekdays(weekdays)}</div>
      </div>
      <div className="rounded-[6px] p-3" style={{ background: "var(--sd-card-sub)", borderLeft: "3px solid var(--sd-accent)" }}>
        <div className="text-[10.5px] font-medium" style={{ color: "var(--sd-label)" }}>배포 시간</div>
        <div className="mt-1 text-[13px] font-semibold" style={{ color: "var(--sd-fg)" }}>{timeLabel}</div>
      </div>
      <div className="rounded-[6px] p-3" style={{ background: "var(--sd-card-sub)", borderLeft: "3px solid var(--sd-warn)" }}>
        <div className="text-[10.5px] font-medium" style={{ color: "var(--sd-label)" }}>예정 수량</div>
        <div className="mt-1 text-[13px] font-semibold" style={{ color: "var(--sd-fg)" }}>
          하루 {perDay}개 × 채널 {channelCount}곳
        </div>
      </div>
    </div>
  );
}

/**
 * "platform:accountId" 키 → 채널 객체. **예상 건수 계산용**이라 개수만 맞으면 된다
 * (저장 경로는 channelOptions 에서 실물을 찾아 쓴다 — 그쪽은 정확한 값이 필요하다).
 */
function chansOf(keys: string[]): { platform: string; accountId: string }[] {
  return keys.map((k) => {
    const i = k.indexOf(":");
    return { platform: k.slice(0, i), accountId: k.slice(i + 1) };
  });
}

/**
 * 발행 시간 목록 — 중복은 막고 항상 정렬해 보여 준다(뒤섞이면 사람이 못 읽는다).
 *
 * 시각마다 **개수**를 따로 둔다(2026-08-25 · 7시 2개·9시 3개). 하루 발행 수 = 개수 합이고,
 * 그 합은 화면이 직접 곱하지 않고 서버와 같은 함수(perDayCount·monthlyPublishEstimate)가 낸다.
 */
function SlotPicker({ slots, onChange }: { slots: RuleSlot[]; onChange: (v: RuleSlot[]) => void }) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("18:00");

  const setCount = (time: string, count: number) =>
    onChange(slots.map((s) => (s.time === time ? { ...s, count: Math.max(1, Math.min(20, count)) } : s)));

  function add() {
    if (!/^\d{2}:\d{2}$/.test(value)) return;
    if (!slots.some((s) => s.time === value)) {
      onChange([...slots, { time: value, count: 1 }].sort((a, b) => a.time.localeCompare(b.time)));
    }
    setAdding(false);
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {slots.map((s) => (
        <span
          key={s.time}
          className="inline-flex h-7 items-center gap-1 rounded-[5px] px-2 text-[11.5px]"
          style={{ border: "1px solid var(--sd-border)", color: "var(--sd-fg)" }}
        >
          {s.time}
          <button type="button" aria-label={`${s.time} 개수 줄이기`} disabled={s.count <= 1}
            onClick={() => setCount(s.time, s.count - 1)}
            className="px-0.5" style={{ color: "var(--sd-fg-dim)", opacity: s.count <= 1 ? 0.35 : 1 }}>−</button>
          <span className="sd-mono">{s.count}개</span>
          <button type="button" aria-label={`${s.time} 개수 늘리기`}
            onClick={() => setCount(s.time, s.count + 1)}
            className="px-0.5" style={{ color: "var(--sd-fg-dim)" }}>＋</button>
          <button type="button" aria-label={`${s.time} 삭제`}
            onClick={() => onChange(slots.filter((x) => x.time !== s.time))}
            className="ml-0.5" style={{ color: "var(--sd-fg-dim)" }}>×</button>
        </span>
      ))}
      {adding ? (
        <span className="inline-flex items-center gap-1">
          <input
            type="time" value={value} autoFocus
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); if (e.key === "Escape") setAdding(false); }}
            className="sd-input h-7 w-[92px]"
          />
          <button type="button" onClick={add} className="sd-btn h-7 px-2 text-[11px]">추가</button>
        </span>
      ) : (
        <button type="button" onClick={() => setAdding(true)}
          className="h-7 text-[11.5px]" style={{ color: "var(--sd-fg-dim)" }}>+ 시간 추가</button>
      )}
    </div>
  );
}

/**
 * 월 예상 발행 — **순방 판정과 같은 함수**(`monthlyPublishEstimate`)로 낸다.
 *
 * 화면이 따로 곱하면 "월 66건" 이라 적어 놓고 실제로는 다른 수가 나가는 상태가 되고,
 * 그게 곧 청구 예상과 어긋난다. 금액은 여기서 말하지 않는다 — 청구는 크레딧 기준이라
 * 건수에 단가를 곱한 값이 곧 청구액이 아니다.
 */
function PublishEstimate({ weekdays, slots, dailyQuota, channels }: {
  weekdays: number[]; slots: RuleSlot[]; dailyQuota: number;
  channels: { platform: string; accountId: string }[];
}) {
  // 채널 수 곱하기도 **서버 함수 안에서** 끝낸다 — 밖에서 한 번 더 곱하면 그 순간
  // 두 벌 계산이 되고, 계획이 바뀔 때 조용히 어긋난다.
  // platform·accountId 는 타입상 필요할 뿐 계산엔 안 쓰인다(channels 가 있으면 그쪽이 정본).
  const est = monthlyPublishEstimate({
    weekdays, slots, dailyQuota, channels,
    platform: channels[0]?.platform ?? "", accountId: channels[0]?.accountId ?? "",
  });
  const perWeek = est.perWeek;
  const perMonth = est.perMonth;

  // 채널이 0개면 숫자를 만들지 않는다 — 서버는 최소 1채널로 치므로 그대로 두면
  // 고르지도 않은 채널의 예상 건수를 보여 주게 된다.
  if (channels.length === 0) {
    return (
      <div className="rounded-[5px] p-2.5 text-[10.5px]"
        style={{ border: "1px solid var(--sd-border)", color: "var(--sd-fg-dim)" }}>
        채널을 선택하면 월 예상 발행 건수가 표시됩니다.
      </div>
    );
  }

  return (
    <div className="rounded-[5px] p-2.5" style={{ border: "1px solid var(--sd-border)" }}>
      <div className="flex items-baseline justify-between">
        <span className="text-[10.5px]" style={{ color: "var(--sd-label)" }}>월 예상 발행</span>
        <span className="text-[15px] font-semibold" style={{ color: "var(--sd-fg)" }}>{perMonth}건</span>
      </div>
      <div className="mt-1 text-[10.5px]" style={{ color: "var(--sd-fg-dim)" }}>
        {formatWeekdays(weekdays)} · 하루 {est.perDay}건 · 채널 {est.channels}개 → 주당 {perWeek}건
      </div>
    </div>
  );
}

/** 승인 방식 2택 — 무엇을 고르는 건지 나란히 보이게. */
function GateCard({ on, onClick, title, desc }: {
  on: boolean; onClick: () => void; title: string; desc: string;
}) {
  return (
    <button
      type="button" onClick={onClick}
      className="rounded-[5px] p-2.5 text-left"
      style={on
        ? { border: "1px solid var(--sd-fg)", background: "var(--sd-hover)" }
        : { border: "1px solid var(--sd-border)" }}
    >
      <div className="text-[11.5px] font-semibold" style={{ color: "var(--sd-fg)" }}>{title}</div>
      <div className="mt-0.5 text-[10.5px] leading-relaxed" style={{ color: "var(--sd-fg-dim)" }}>{desc}</div>
    </button>
  );
}
