"use client";

/**
 * U12 · 자동 배포 — "반자동 파이프라인 한 장" (README §12 · FLOWS F6 · 2026-08-14 재배치).
 *
 * 위에서 아래로 사람이 정하는 것 → 시스템이 하는 것 순서다:
 *   ① 프로그램 선택 → ② 회차·영상(분석 상태 + 영상 등록) → ③ 배포 채널 → ④ 실행(+ 진행)
 *   → 승인 대기 → ⑤ 기록(규칙 + 자동 배포 기록).
 *
 * 지키는 것(재배치 전과 동일):
 *  - 규칙 하나 = 프로그램 ↔ 채널 연결 하나. **규칙이 없으면 아무것도 하지 않는다.**
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
import { useToast } from "@/components/ui/toast";
import { useSession } from "@/lib/auth";
import {
  deleteAutomationRule,
  fetchAutomation,
  fetchChannelRules,
  fetchNaverAccounts,
  fetchShortsTemplates,
  fetchYouTubeChannels,
  type FrameTemplate,
  releaseAutomationHold,
  runAutomationNow,
  saveAutomationRule,
  setAutomationPaused,
  type AutomationRule,
  type ChannelRule,
  type RuleCriterion,
  type RuleHold,
  type RuleMediaKind,
  type RuleRun,
} from "@/lib/data/api";
import { useAppData } from "@/lib/data/store";
import { channelLabel, PIPELINE_STAGES } from "@/lib/constants";
import type { Clip, Episode } from "@/lib/types";
import { clipThumbSrc } from "@/lib/media-url";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<RuleMediaKind, string> = { short: "숏폼", clip: "클립", both: "숏폼+클립" };
const CRIT_LABEL: Record<RuleCriterion, string> = { score80: "점수 80 이상", score85: "점수 85 이상", top3: "상위 3건" };
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

/** 실제 파일이 올라가는 플랫폼 — 나머지(Meta·TikTok)는 원래 기록만 남는다. */
const isUploadPlatform = (p: string) => p === "youtube" || p.startsWith("naver");

/** distribution.origin → 자동/수동 라벨. 없으면(구 기록) null — 표기 생략. */
function originLabelOf(origin: string | undefined): string | null {
  if (origin === "automation" || origin === "factory") return "자동";
  if (origin === "manual" || origin === "retry") return "수동";
  return null;
}

/**
 * 서버 factory.ts TEMPLATE_SEEDS 의 UI 미러 — 미리보기·슬라이더 초기값용.
 * 서버 시드를 바꾸면 여기도 같이 바꿔야 미리보기가 실제 렌더와 일치한다.
 */
const TEMPLATE_SEED_UI: Record<string, { accent: string; titleY: number; iconY: number; boxY: number; iconSize: number }> = {
  "broadcast-standard": { accent: "#40E0E0", titleY: 11, iconY: 68, boxY: 79.5, iconSize: 50 },
  "broadcast-drama": { accent: "#40E0E0", titleY: 8, iconY: 77, boxY: 87.5, iconSize: 50 },
  "broadcast-clean": { accent: "#FF4040", titleY: 11, iconY: 80, boxY: 92, iconSize: 40 },
};

type LayoutState = { titleY: number; channelIconY: number; channelBoxY: number; channelIconSize: number };

/** 9:16 미니 캔버스에 템플릿 기하(띠·영상 영역)와 제목·로고·시간박스 위치를 그린다. */
function TemplatePreview({ template, accent, layout }: {
  template: FrameTemplate | null;
  accent: string;
  layout: LayoutState;
}) {
  const video = template?.video ?? { x: 0, y: 34.2, w: 100, h: 31.7 };
  const iconPct = (layout.channelIconSize * 3 / 1920) * 100; // px(에디터) → 출력높이 → %
  return (
    <div className="relative w-[120px] shrink-0 overflow-hidden rounded-md border"
      style={{ aspectRatio: "9/16", background: "#000", borderColor: "var(--sd-border)" }}>
      {/* 영상 영역 */}
      <div className="absolute" style={{
        left: `${video.x}%`, top: `${video.y}%`, width: `${video.w}%`, height: `${video.h}%`,
        background: "linear-gradient(135deg,#2a3f4d,#1a2630)",
      }} />
      {/* 제목 2줄 */}
      <div className="absolute inset-x-1 text-center font-bold leading-tight"
        style={{ top: `${layout.titleY}%`, fontSize: 7, color: "#fff" }}>
        훅 첫 줄 텍스트
        <div style={{ color: accent }}>둘째 줄 강조</div>
      </div>
      {/* 로고 */}
      <div className="absolute left-1/2 -translate-x-1/2 rounded-sm"
        style={{ top: `${layout.channelIconY}%`, width: `${iconPct * 1.4}%`, height: `${iconPct}%`, background: "#666" }} />
      {/* 시간 박스 */}
      <div className="absolute left-1/2 -translate-x-1/2 rounded-[2px] px-1 text-center font-bold"
        style={{ top: `${layout.channelBoxY}%`, fontSize: 5.5, color: "#fff", background: "#3D7BD9" }}>
        (수) 밤 10시 30분
      </div>
    </div>
  );
}

const STEPS = [
  { n: "01", title: "회차 수신", desc: "새 회차 원본 감지 · 없으면 스킵" },
  { n: "02", title: "분석", desc: "분석 큐 투입 · 완료까지 다음 확인 때 다시 봄" },
  { n: "03", title: "미디어 생성", desc: "규칙 조건 통과분만 생성 · 미달은 생성 안 함" },
  { n: "04", title: "업로드 준비", desc: "권리 문제가 있으면 승인 대기로 — 사람이 승인해야 함", amber: true },
  { n: "05", title: "게시", desc: "채널 규칙 적용 · 실패는 자동 재시도 없음", blue: true },
];

/** 규칙의 채널 목록 — 배열이 정본, 없으면 단수 폴백(구 규칙). */
const channelsOf = (r: AutomationRule) =>
  r.channels?.length ? r.channels : [{ platform: r.platform, accountId: r.accountId }];

/** 규칙의 프로그램 목록 — 배열이 정본, 없으면 단수 폴백. */
const programsOf = (r: AutomationRule) => (r.programIds?.length ? r.programIds : [r.programId]);

const ANALYZE_IDX = PIPELINE_STAGES.indexOf("analyze");

/**
 * 회차의 분석 상태 요약 — "완료 → 생략"이 규칙이므로 완료를 명시적으로 말한다.
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
  const { programs, episodes, clips, mediaForEpisode } = useAppData();
  const { toast } = useToast();
  const actor = useSession().user.name;

  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [runs, setRuns] = useState<RuleRun[]>([]);
  const [holds, setHolds] = useState<RuleHold[]>([]);
  const [paused, setPaused] = useState(false);
  const [idleReason, setIdleReason] = useState("");
  // 채널별 실업로드 스위치 — 구버전 서버는 안 내려준다(null = 모름 → 경고 안 띄움).
  const [gates, setGates] = useState<Record<string, boolean> | null>(null);
  // loading 없이는 fetch 전에 "규칙 없음"이 먼저 보인다 — 로딩/빈/에러 3종을 구분한다.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningNow, setRunningNow] = useState(false);
  const [releasing, setReleasing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetchAutomation();
      setRules(r.rules); setRuns(r.runs); setHolds(r.holds);
      setPaused(r.paused); setIdleReason(r.idleReason);
      setGates(r.gates ?? null);
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
  // 고급 설정 (구 규칙 폼 필드 전부 — 격하했을 뿐 삭제하지 않는다)
  const [mediaKind, setMediaKind] = useState<RuleMediaKind>("short");
  const [criterion, setCriterion] = useState<RuleCriterion>("score80");
  const [approveFirst, setApproveFirst] = useState(true);
  const [win, setWin] = useState("방영 익일 10시");
  const [dailyQuota, setDailyQuota] = useState(3);
  const [activeStart, setActiveStart] = useState(9);
  const [activeEnd, setActiveEnd] = useState(22);
  const [templateId, setTemplateId] = useState(""); // "" = 프로그램 장르 자동
  const [templates, setTemplates] = useState<FrameTemplate[]>([]);
  const [layout, setLayout] = useState<LayoutState | null>(null);

  useEffect(() => {
    void fetchShortsTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, []);

  // 템플릿 바꾸면 슬라이더를 그 템플릿의 시드 기본값으로 리셋 (규칙 프리필 직후 1회는 건너뜀).
  const skipLayoutReset = useRef(false);
  const effectiveTemplate = templateId || "broadcast-standard";
  useEffect(() => {
    if (skipLayoutReset.current) { skipLayoutReset.current = false; return; }
    const s = TEMPLATE_SEED_UI[effectiveTemplate] ?? TEMPLATE_SEED_UI["broadcast-standard"];
    setLayout({ titleY: s.titleY, channelIconY: s.iconY, channelBoxY: s.boxY, channelIconSize: s.iconSize });
  }, [effectiveTemplate]);

  // ── ③ 채널 선택지 — 구 규칙 폼의 channelOptions 로직 그대로 ───────────────────────
  // 계정 ID 를 자유 입력으로 두면 오타 하나로 규칙이 영원히 아무것도 안 한다(확인이
  // 채널 규칙을 못 찾으면 skipped 로만 남는다). 실재하는 연결/규칙에서만 고르게 한다.
  const [channelRules, setChannelRules] = useState<ChannelRule[] | null>(null);
  const [rulesErr, setRulesErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchChannelRules()
      .then((rs) => { if (alive) { setChannelRules(rs); setRulesErr(null); } })
      .catch((err) => {
        if (!alive) return;
        setChannelRules([]);
        setRulesErr(err instanceof Error ? err.message : String(err));
      });
    return () => { alive = false; };
  }, []);

  // 배포 규칙이 없어도 배포는 가능해야 한다 — YouTube 는 연결된 게시 가능 채널을 직접 불러온다.
  const [ytChannels, setYtChannels] = useState<{ channelId: string; channelName: string; status: string }[]>([]);
  useEffect(() => {
    void fetchYouTubeChannels()
      .then((cs) => setYtChannels(cs.filter((c) => c.status === "active")))
      .catch(() => setYtChannels([]));
  }, []);

  const [naverAccts, setNaverAccts] = useState<{ id: string; label: string; target: string; hasSession: boolean }[]>([]);
  useEffect(() => {
    void fetchNaverAccounts()
      .then((r) => setNaverAccts(r.accounts.filter((a) => a.status !== "disabled" && a.hasSession && a.target !== "tv")))
      .catch(() => setNaverAccts([]));
  }, []);

  // 채널 선택지 = YouTube 연결 채널 + 세션 등록된 네이버 계정(클립만) + (기타 플랫폼) 채널 규칙.
  const channelOptions: { platform: string; accountId: string; label: string }[] = useMemo(() => [
    ...ytChannels.map((c) => ({ platform: "youtube", accountId: c.channelId, label: `YouTube · ${c.channelName}` })),
    ...naverAccts.map((a) => ({ platform: "naverclip", accountId: a.id, label: `네이버 클립 · ${a.label}` })),
    ...(channelRules ?? []).filter((r) => r.platform !== "youtube" && !r.platform.startsWith("naver"))
      .map((r) => ({ platform: r.platform, accountId: r.accountId, label: `${r.platform} · ${r.label}` })),
  ], [ytChannels, naverAccts, channelRules]);

  /**
   * 게이트가 **명시적으로 꺼진** 채널인가. "platform:accountId" 키 우선, 플랫폼 키 폴백.
   * gates 미수신(구버전 서버)이나 키 없음은 "모름" — 꺼짐으로 단정하지 않는다.
   */
  const gateOff = (platform: string, accountId: string): boolean => {
    if (!gates) return false;
    const v = gates[`${platform}:${accountId}`] ?? gates[platform];
    return v === false;
  };

  // 선택 프로그램을 이미 커버하는 규칙 — "자동 배포 시작"은 이 규칙의 갱신이 된다(upsert).
  const ruleForProgram = useMemo(
    () => rules.find((r) => programsOf(r).includes(selProgram)),
    [rules, selProgram],
  );

  // 프로그램을 고르면 기존 규칙 값으로 ②~④를 프리필한다 — 프로그램당 1회만(폴링이
  // rules 를 갈아끼워도 사용자가 만지던 선택을 덮지 않는다).
  const prefilledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!selProgram || prefilledFor.current === selProgram) return;
    if (loading) return; // 규칙을 아직 못 읽었다 — 읽힌 뒤에 프리필
    prefilledFor.current = selProgram;
    const r = rules.find((x) => programsOf(x).includes(selProgram));
    if (!r) { setSelChannels([]); return; }
    setSelChannels(channelsOf(r).map((c) => `${c.platform}:${c.accountId}`));
    setMediaKind(r.mediaKind); setCriterion(r.criterion);
    setApproveFirst(r.gatePolicy === "approve_first");
    setWin(r.window || "수시");
    setDailyQuota(r.dailyQuota ?? 3);
    setActiveStart(r.activeStart ?? 9); setActiveEnd(r.activeEnd ?? 22);
    setTemplateId(r.templateId ?? "");
    if (r.layout) {
      const seed = TEMPLATE_SEED_UI[r.templateId || "broadcast-standard"] ?? TEMPLATE_SEED_UI["broadcast-standard"];
      skipLayoutReset.current = true; // 템플릿 리셋 이펙트가 이 값을 덮지 않게
      setLayout({
        titleY: r.layout.titleY ?? seed.titleY,
        channelIconY: r.layout.channelIconY ?? seed.iconY,
        channelBoxY: r.layout.channelBoxY ?? seed.boxY,
        channelIconSize: r.layout.channelIconSize ?? seed.iconSize,
      });
    }
  }, [selProgram, rules, loading]);

  const toggle = (list: string[], v: string) => list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  // ── 상태바 파생값 ──────────────────────────────────────────────────────────────
  const running = !paused && rules.some((r) => r.enabled);

  // 실업로드 채널이 규칙에 있는데 게이트가 꺼져 있으면 — "실행 중"이 착시가 된다.
  const gateBlocked = rules.some(
    (r) => r.enabled && channelsOf(r).some((c) => isUploadPlatform(c.platform) && gateOff(c.platform, c.accountId)),
  );

  // 오늘 게시 합산 — publishedToday 를 내려주는 서버에서만 계산한다(없으면 줄 숨김).
  const hasToday = rules.some((r) => r.publishedToday);
  const todayPublished = rules.reduce(
    (sum, r) => sum + Object.values(r.publishedToday ?? {}).reduce((a, b) => a + b, 0),
    0,
  );
  const todayQuota = rules
    .filter((r) => r.enabled)
    .reduce((sum, r) => sum + (r.dailyQuota ?? 3) * channelsOf(r).length, 0);

  async function togglePause() {
    try {
      const r = await setAutomationPaused(!paused);
      toast({ title: paused ? "재시작했습니다" : "일시정지했습니다", description: r.notice, tone: "done" });
      await load();
    } catch (err) {
      toast({ title: "변경 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    }
  }

  /** 규칙을 만들고 10분을 기다리지 않아도 결과를 본다. */
  async function runNow() {
    if (runningNow) return; // 더블클릭 = 확인 중복 실행
    setRunningNow(true);
    try {
      const r = await runAutomationNow();
      toast({
        title: "확인했습니다",
        description:
          r.idleReason ||
          `규칙 ${r.rulesEvaluated}개 · 미디어 ${r.adopted} · 게시 ${r.published} · 승인 대기 ${r.held}`,
        tone: r.held > 0 ? "warn" : "done",
      });
      await load();
    } catch (err) {
      toast({ title: "확인 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setRunningNow(false);
    }
  }

  /** ④ 자동 배포 시작 — 규칙 upsert(기존 규칙이 있으면 갱신) + 즉시 1회 확인. */
  async function startAutoDeploy() {
    if (starting || !selProgram || selChannels.length === 0) return;
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
        // 갱신은 id 가 정본 — 자연키(첫 채널)로 흘리면 첫 채널이 바뀔 때 새 규칙이 생겨
        // 구 규칙과 이중 커버된다(서버가 id 로 UPDATE).
        ...(ruleForProgram?.id ? { id: ruleForProgram.id } : {}),
        // 단수 필드 = 첫 항목 (서버 UNIQUE·구버전 호환). 배열이 정본.
        programId: selProgram, platform: chans[0].platform, accountId: chans[0].accountId,
        programIds: [selProgram], channels: chans,
        dailyQuota, activeStart, activeEnd,
        mediaKind, criterion,
        gatePolicy: approveFirst ? "approve_first" : "hold_on_issue",
        window: win, enabled: true,
        ...(templateId ? { templateId } : {}),
        ...(layout ? { layout } : {}),
      });
      const r = await runAutomationNow();
      toast({
        title: "자동 배포를 시작했습니다",
        description:
          r.idleReason ||
          `규칙 ${r.rulesEvaluated}개 확인 · 미디어 ${r.adopted} · 게시 ${r.published} · 승인 대기 ${r.held} — 이후 10분마다 자동 확인합니다.`,
        tone: r.held > 0 ? "warn" : "done",
      });
      await load();
    } catch (err) {
      toast({ title: "시작 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setStarting(false);
    }
  }

  async function release(h: RuleHold) {
    const key = `${h.ruleId}:${h.clipId}`;
    if (releasing) return; // 더블클릭 = 승인 중복 요청
    setReleasing(key);
    try {
      const r = await releaseAutomationHold(h.ruleId, h.clipId, actor);
      toast({ title: "승인했습니다", description: r.notice, tone: "done" });
      await load();
    } catch (err) {
      toast({ title: "승인 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setReleasing(null);
    }
  }

  /** 전체 승인 — 서버 API 가 건당이라 순차로 돈다. 실패 건은 남기고 계속 간다. */
  async function releaseAll() {
    if (releasing || holds.length === 0) return;
    setReleasing("__all__");
    let ok = 0;
    let fail = 0;
    try {
      for (const h of holds) {
        try {
          await releaseAutomationHold(h.ruleId, h.clipId, actor);
          ok += 1;
        } catch {
          fail += 1;
        }
      }
      toast({
        title: `전체 승인 — ${ok}건 완료${fail ? ` · ${fail}건 실패` : ""}`,
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

  // ── ④ 진행 패널 파생값 — 이 프로그램 규칙의 확인 기록 → 클립 → 렌더 → 배포 조인 ──
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

  const stepDim = (on: boolean) => (on ? undefined : { opacity: 0.45, pointerEvents: "none" as const });

  return (
    <div className="mx-auto flex max-w-[1240px] flex-col gap-[14px]">
      {/* ── 게이트 착시 방지 — 실업로드가 꺼져 있으면 최상단에서 먼저 말한다 ── */}
      {gateBlocked && (
        <div
          className="rounded-[4px] px-3 py-2.5 text-[12px] font-medium leading-relaxed"
          style={{ border: "1px solid var(--sd-warn-border)", background: "var(--sd-warn-bg)", color: "var(--sd-warn)" }}
        >
          ⚠ 지금은 실제 업로드가 꺼져 있습니다 — 규칙이 돌아도 기록만 남고 채널에는
          올라가지 않습니다. (권리 확인의 승인 대기와는 별개인 운영 설정입니다.)
        </div>
      )}

      {/* ── 상태 바 — "어떻게 돌아가는지" 를 분명히 ─────────────────────────── */}
      <div className="sd-card flex flex-col gap-2 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className="size-[9px] shrink-0 rounded-full"
            style={{ background: running ? "var(--sd-ok)" : "var(--sd-idle)" }}
            aria-hidden
          />
          <span className="text-[13px] font-semibold" style={{ color: "var(--sd-fg)" }}>
            {loading ? "불러오는 중…" : paused ? "일시정지됨" : running ? "자동 확인 켜짐" : "규칙 없음 — 아래 ①~④로 시작"}
          </span>
          <span className="sd-mono text-[11px]" style={{ color: "var(--sd-mut)" }}>
            {runs[0]?.at ? `마지막 확인 ${runs[0].at.slice(0, 16).replace("T", " ")}` : "아직 확인 기록 없음"}
          </span>
          {/* 오늘 합산 — publishedToday 를 내려주는 서버에서만 보인다(구버전은 숨김). */}
          {hasToday && (
            <span className="text-[11px] font-medium" style={{ color: "var(--sd-fg)" }}>
              오늘 게시 {todayPublished}건 / 한도 {todayQuota}건 · 승인 대기 {holds.length}건
            </span>
          )}
          <button type="button" className="sd-btn sd-btn-primary ml-auto" disabled={runningNow} onClick={runNow}>
            {runningNow ? "확인 중…" : "지금 확인하기"}
          </button>
          <button type="button" className="sd-btn" onClick={togglePause}>
            {paused ? "재시작" : "일시정지"}
          </button>
        </div>
        {/* 실행 모델을 한 줄로 못박는다 — "어떻게 돌리는지" 가 가장 자주 막히는 지점이다. */}
        <p className="text-[11px] leading-relaxed" style={{ color: "var(--sd-mut)" }}>
          프로그램을 고르고 채널을 연결해 <b style={{ color: "var(--sd-fg)" }}>자동 배포 시작</b>을 누르면,
          <b style={{ color: "var(--sd-fg)" }}> 10분마다 자동 확인</b>해 분석 → 클립 자동 선정 → 렌더 → 배포까지
          이어집니다. 이미 분석이 끝난 회차는 분석을 생략합니다. 결과는 아래{" "}
          <b style={{ color: "var(--sd-fg)" }}>기록</b>에 쌓입니다.
          {/* idleReason = 서버가 말하는 "왜 안 도는가"(일시정지·크레딧 부족 등) — 눈에 띄게. */}
          {idleReason ? <b style={{ color: "var(--sd-warn)" }}> · {idleReason}</b> : null}
        </p>
      </div>

      {error && (
        <div
          className="rounded-[4px] px-3 py-2 text-[11.5px]"
          style={{ border: "1px solid var(--sd-danger-border)", background: "var(--sd-danger-bg)", color: "var(--sd-danger-strong)" }}
        >
          자동 배포 상태를 불러오지 못했습니다 ({error}).
        </div>
      )}

      {/* ── 5단계 안내 — 규칙이 하나라도 있으면 자리만 차지한다. 첫 진입에만. ── */}
      {!loading && rules.length === 0 && (
        <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
          {STEPS.map((s) => (
            <div
              key={s.n}
              className="sd-card flex flex-col gap-1 p-3"
              style={
                s.amber
                  ? { borderColor: "var(--sd-warn-border)", background: "var(--sd-warn-bg)" }
                  : s.blue
                    ? { borderColor: "var(--sd-accent-border)", background: "var(--sd-accent-bg)" }
                    : undefined
              }
            >
              <span className="sd-eb" style={{ color: "var(--sd-label)" }}>{s.n}</span>
              <span className="text-[12.5px] font-semibold" style={{ color: "var(--sd-fg)" }}>{s.title}</span>
              <span className="text-[10.5px] leading-relaxed" style={{ color: "var(--sd-mut)" }}>{s.desc}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── ① 프로그램 선택 ─────────────────────────────────────────────────── */}
      <section className="sd-card flex flex-col gap-2 p-3">
        <div className="flex items-baseline gap-2">
          <span className="sd-eb" style={{ color: "var(--sd-label)" }}>①</span>
          <h3 className="sd-serif text-[15px] font-semibold" style={{ color: "var(--sd-fg)" }}>프로그램 선택</h3>
          <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>고르면 아래 단계가 열립니다</span>
        </div>
        {programs.length === 0 ? (
          <div className="sd-ph grid min-h-[56px] place-items-center rounded-[6px] px-6 text-center text-[11.5px]"
            style={{ border: "1px dashed var(--sd-border)" }}>
            프로그램이 없습니다 — <Link href="/programs" className="underline">콘텐츠</Link>에서 먼저 만들어 주세요.
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {programs.map((p) => (
              <button
                key={p.id}
                type="button"
                className={cn("sd-btn", selProgram === p.id && "sd-btn--on")}
                onClick={() => setSelProgram(p.id === selProgram ? "" : p.id)}
              >
                {p.title}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* ── ② 회차 · 영상 — 분석 완료는 생략, 없으면 등록 ───────────────────── */}
      <section className="sd-card flex flex-col gap-2 p-3" style={stepDim(Boolean(selProgram))}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="sd-eb" style={{ color: "var(--sd-label)" }}>②</span>
          <h3 className="sd-serif text-[15px] font-semibold" style={{ color: "var(--sd-fg)" }}>회차 · 영상</h3>
          <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
            분석이 끝난 회차는 <b>생략</b>하고, 새 영상만 분석에 들어갑니다
          </span>
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
                <div key={ep.id} className="flex flex-wrap items-center gap-2 rounded-[4px] px-2.5 py-1.5"
                  style={{ border: "1px solid var(--sd-border)" }}>
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

      {/* ── ③ 배포 채널 ─────────────────────────────────────────────────────── */}
      <section className="sd-card flex flex-col gap-2 p-3" style={stepDim(Boolean(selProgram))}>
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="sd-eb" style={{ color: "var(--sd-label)" }}>③</span>
          <h3 className="sd-serif text-[15px] font-semibold" style={{ color: "var(--sd-fg)" }}>배포 채널</h3>
          <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
            {selChannels.length}개 선택 · 채널당 하루 {dailyQuota}개
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
            return (
              <label key={key} className="flex flex-wrap items-center gap-1.5 text-[11.5px]" style={{ color: "var(--sd-fg)" }}>
                <input type="checkbox" checked={selChannels.includes(key)}
                  onChange={() => setSelChannels(toggle(selChannels, key))} />
                <span className="truncate">{o.label}</span>
                {/* 게이트 OFF = 실업로드 잠금(운영 설정). 명시적 false 일 때만 — 모름은 침묵. */}
                {isUploadPlatform(o.platform) && gateOff(o.platform, o.accountId) && (
                  <span className="sd-tag sd-tag--warn">실제 업로드 꺼짐 — 기록만 됨</span>
                )}
                {!isUploadPlatform(o.platform) && <span className="sd-tag">기록만 — 실제 게시는 담당자가 직접</span>}
              </label>
            );
          })}
        </div>
        {rulesErr && (
          <p className="text-[10.5px]" style={{ color: "var(--sd-warn)" }}>채널 규칙 목록을 못 읽었습니다 ({rulesErr}) — 연결 채널만 표시.</p>
        )}
        {/* ⚑ 채널별 안내 — 만들 때 성격을 말한다 (F6). 실업로드 = YouTube·네이버. */}
        <p
          className="rounded-[4px] px-2.5 py-2 text-[11px] leading-relaxed"
          style={{ border: "1px solid var(--sd-border)", background: "var(--sd-card)", color: "var(--sd-mut)" }}
        >
          YouTube·네이버는 실제 파일이 업로드됩니다. Instagram/Facebook/TikTok 은 배포 기록만
          남고 실제 게시는 담당자가 해당 앱에서 직접 해야 합니다.
        </p>
      </section>

      {/* ── ④ 실행 — 규칙 upsert + 즉시 확인 · 진행 패널 ─────────────────────── */}
      <section className="sd-card flex flex-col gap-2.5 p-3" style={stepDim(Boolean(selProgram))}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="sd-eb" style={{ color: "var(--sd-label)" }}>④</span>
          <h3 className="sd-serif text-[15px] font-semibold" style={{ color: "var(--sd-fg)" }}>실행</h3>
          {ruleForProgram && (
            <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
              이 프로그램의 규칙이 이미 있습니다 — 시작하면 <b>갱신</b>됩니다
            </span>
          )}
          <button
            type="button"
            className="sd-btn sd-btn-primary ml-auto"
            disabled={starting || !selProgram || selChannels.length === 0}
            onClick={() => void startAutoDeploy()}
          >
            {starting ? "시작 중…" : "자동 배포 시작"}
          </button>
        </div>

        {/* 고급 설정 — 구 규칙 폼(점수 기준·한도·시간창·정책·템플릿) 접기로 격하 · 삭제 금지 */}
        <button
          type="button"
          className="self-start text-[11px] underline-offset-2 hover:underline"
          style={{ color: "var(--sd-mut)" }}
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? "▾ 고급 설정 접기" : "▸ 고급 설정 (점수 기준 · 한도 · 시간창 · 정책 · 템플릿)"}
        </button>
        {showAdvanced && (
          <div className="flex flex-col gap-2.5 rounded-[5px] p-3"
            style={{ background: "var(--sd-card-sub)", border: "1px solid var(--sd-border)" }}>
            <div className="grid grid-cols-2 gap-2">
              <select value={mediaKind} onChange={(e) => setMediaKind(e.target.value as RuleMediaKind)} className="sd-input">
                {(Object.keys(KIND_LABEL) as RuleMediaKind[]).map((k) => (
                  <option key={k} value={k}>{KIND_LABEL[k]}</option>
                ))}
              </select>
              <select value={criterion} onChange={(e) => setCriterion(e.target.value as RuleCriterion)} className="sd-input">
                {(Object.keys(CRIT_LABEL) as RuleCriterion[]).map((k) => (
                  <option key={k} value={k}>{CRIT_LABEL[k]}</option>
                ))}
              </select>
            </div>

            {/* 하루 할당량 · 활동 시간창 — 할당량이 찰 때까지 시간창 안에서 확인 때마다 계속 배포 */}
            <div className="grid grid-cols-3 items-end gap-2">
              <label className="text-[10.5px]" style={{ color: "var(--sd-label)" }}>
                채널당 하루 할당량
                <input type="number" min={1} max={50} value={dailyQuota}
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
              {activeStart}시~{activeEnd}시(KST) 사이에만 배포하고, 채널마다 하루 {dailyQuota}개를 채우면 다음 날까지 쉽니다.
            </p>

            <input value={win} onChange={(e) => setWin(e.target.value)} placeholder="시간대" className="sd-input w-full" />

            {/* 렌더 템플릿 — 자동 생성 클립의 기본 모양. 비우면 프로그램 장르로 자동 선택. */}
            <div>
              <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className="sd-input w-full">
                <option value="">템플릿: 자동 (드라마=확대 크롭 · 그 외=표준)</option>
                {templates.map((t) => (
                  <option key={t.name} value={t.name}>템플릿: {t.title || t.name}</option>
                ))}
              </select>
              <p className="mt-1 text-[10.5px]" style={{ color: "var(--sd-fg-dim)" }}>
                로고·방영시간은 프로그램 설정(쇼츠 아이콘·편성 시간)에서 채워집니다.
              </p>
            </div>

            {/* 미리보기 + 위치 조절 — 저장되는 렌더 기하와 같은 % 좌표를 그대로 그린다 */}
            {layout && (
              <div className="flex gap-3">
                <TemplatePreview
                  template={templates.find((t) => t.name === effectiveTemplate) ?? null}
                  accent={(TEMPLATE_SEED_UI[effectiveTemplate] ?? TEMPLATE_SEED_UI["broadcast-standard"]).accent}
                  layout={layout}
                />
                <div className="flex-1 space-y-2 text-[10.5px]" style={{ color: "var(--sd-fg-dim)" }}>
                  {([
                    ["제목 위치", "titleY", 3, 30],
                    ["로고 위치", "channelIconY", 60, 92],
                    ["시간박스 위치", "channelBoxY", 62, 94],
                    ["로고 크기", "channelIconSize", 20, 90],
                  ] as const).map(([label, key, min, max]) => (
                    <label key={key} className="block">
                      {label} <span className="opacity-70">{Math.round(layout[key])}{key === "channelIconSize" ? "px" : "%"}</span>
                      <input
                        type="range" min={min} max={max} step={0.5} value={layout[key]}
                        onChange={(e) => setLayout({ ...layout, [key]: Number(e.target.value) })}
                        className="w-full"
                      />
                    </label>
                  ))}
                </div>
              </div>
            )}

            <label className="flex items-center gap-2 text-[11.5px]" style={{ color: "var(--sd-fg)" }}>
              <input type="checkbox" checked={approveFirst} onChange={(e) => setApproveFirst(e.target.checked)} />
              게시 전 사람 승인 (끄면 문제 없는 건은 바로 나가고, 권리 문제만 승인 대기로 빠집니다)
            </label>
          </div>
        )}

        {/* 진행 패널 — 단계별 사실만(개수·상태). 스토어 폴링 + 편승 재조회가 갱신한다. */}
        {selProgram && progress && (
          <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
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
                  : "규칙 없음 — 자동 배포 시작을 누르면 만들어집니다"}
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
        )}
      </section>

      {/* ── 승인 대기 — 사람이 확정하는 지점(F6 Invariant) · ④ 아래 유지 ────── */}
      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="sd-serif text-[16px] font-semibold" style={{ color: "var(--sd-fg)" }}>승인 대기</h3>
          <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
            사람 확인이 필요한 건입니다 — <b>승인해야 다음 확인 때 게시됩니다.</b> 저절로 나가지 않습니다.
          </span>
          {holds.length > 0 && (
            <button
              type="button"
              className="sd-btn ml-auto"
              disabled={releasing !== null}
              onClick={() => void releaseAll()}
            >
              {releasing === "__all__" ? "전체 승인 중…" : `전체 승인 (${holds.length}건)`}
            </button>
          )}
        </div>
        {holds.length === 0 ? (
          <div
            className="sd-ph grid min-h-[80px] place-items-center rounded-[6px] px-6 text-center"
            style={{ border: "1px dashed var(--sd-border)" }}
          >
            {loading ? "불러오는 중…" : error ? "상태를 불러오지 못했습니다" : "승인 대기 중인 건이 없습니다"}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {holds.map((h) => {
              // 원시 clipId 만으론 판단이 안 된다 — 스토어의 클립·규칙과 조인해 얼굴을 붙인다.
              const clip = clips.find((c) => c.id === h.clipId);
              const rule = rules.find((r) => r.id === h.ruleId);
              const ruleProgram = rule
                ? programs.find((p) => p.id === (rule.programIds?.[0] ?? rule.programId))
                : undefined;
              const thumb = clip ? clipThumbSrc(clip) : undefined;
              const key = `${h.ruleId}:${h.clipId}`;
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
                      {clip?.title || h.clipId}
                    </div>
                    <div className="sd-mono text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                      {clip ? `${Math.round(clip.durationSec)}초 · ` : ""}
                      {ruleProgram?.title ? `규칙 ${ruleProgram.title} · ` : ""}
                      대기 시작 {h.heldAt?.slice(0, 16).replace("T", " ") || "—"}
                    </div>
                    {/* 사유는 잘리면 판단을 못 한다 — 둘째 줄 전체 폭. */}
                    <div className="text-[11px] leading-relaxed" style={{ color: "var(--sd-warn)" }}>{h.reason}</div>
                  </div>
                  <Link href={`/editor/${h.clipId}`} className="sd-btn shrink-0">미리보기</Link>
                  <button
                    type="button"
                    className="sd-btn sd-btn-primary shrink-0"
                    disabled={releasing !== null}
                    onClick={() => void release(h)}
                  >
                    {releasing === key ? "승인 중…" : "승인 — 다음 확인 때 게시"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── ⑤ 기록 — 규칙 목록 + 자동 배포 기록 ─────────────────────────────── */}
      <section className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <span className="sd-eb" style={{ color: "var(--sd-label)" }}>⑤</span>
          <h3 className="sd-serif text-[16px] font-semibold" style={{ color: "var(--sd-fg)" }}>기록</h3>
        </div>

        {/* 규칙 목록 — 무엇이 돌고 있는지의 정본 */}
        {rules.length === 0 ? (
          <div
            className="sd-ph grid min-h-[70px] place-items-center rounded-[6px] px-6 text-center"
            style={{ border: "1px dashed var(--sd-border)" }}
          >
            {loading ? "불러오는 중…" : error ? "상태를 불러오지 못했습니다" : "규칙이 없습니다 — 자동 배포는 규칙이 있어야만 동작합니다 (기본 동작 없음)"}
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
                  <span className="sd-tag">{CRIT_LABEL[r.criterion]}</span>
                  <span className="sd-tag sd-tag--warn">
                    {r.gatePolicy === "approve_first" ? "게시 전 사람 승인" : "문제 없으면 바로 게시 (권리 문제는 승인 대기로)"}
                  </span>
                  <span className="sd-tag">하루 {r.dailyQuota ?? 3}개/채널</span>
                  <span className="sd-tag">{r.activeStart ?? 9}~{r.activeEnd ?? 22}시</span>
                  <span className="sd-tag">{r.templateId ? `템플릿 ${r.templateId}` : "템플릿 자동"}</span>
                  {/* 오늘 게시 수 — 서버가 publishedToday 를 내려줄 때만(구버전은 숨김). */}
                  {r.publishedToday &&
                    chans.map((c) => {
                      const n = r.publishedToday?.[`${c.platform}:${c.accountId}`];
                      if (typeof n !== "number") return null;
                      return (
                        <span key={`${c.platform}:${c.accountId}`} className="sd-tag">
                          오늘: {channelLabel(c.platform)} {n}/{r.dailyQuota ?? 3}
                        </span>
                      );
                    })}

                  <div className="ml-auto flex gap-2">
                    <button
                      type="button"
                      className="sd-btn"
                      onClick={async () => {
                        try {
                          await saveAutomationRule({ ...r, enabled: !r.enabled });
                          toast({
                            title: r.enabled ? "규칙을 멈췄습니다" : "규칙을 재개했습니다",
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
                        if (!window.confirm("이 규칙을 지웁니다. 이미 게시된 영상은 내려가지 않습니다. 계속할까요?")) return;
                        try {
                          const res = await deleteAutomationRule(r.id);
                          toast({ title: "규칙을 지웠습니다", description: res.notice, tone: "done" });
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

        {/* 자동 배포 기록 — 규칙이 자동으로 배포한 것. 사람이 누른 배포는 배포 화면에서. */}
        <div className="mt-1 flex items-baseline gap-2">
          <h4 className="text-[13px] font-semibold" style={{ color: "var(--sd-fg)" }}>자동 배포 기록</h4>
          <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
            규칙이 <b>자동으로</b> 배포한 것만 — 사람이 누른 배포는 배포 화면에서 봅니다
          </span>
        </div>
        {runs.length === 0 ? (
          <div
            className="sd-ph grid min-h-[80px] place-items-center rounded-[6px] px-6 text-center text-[11.5px]"
            style={{ border: "1px dashed var(--sd-border)", color: "var(--sd-mut)" }}
          >
            {loading ? "불러오는 중…" : error ? "상태를 불러오지 못했습니다" : "아직 자동 배포된 것이 없습니다 — 자동 배포를 시작하면 여기 쌓입니다"}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {runs.map((run) => {
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
    </div>
  );
}
