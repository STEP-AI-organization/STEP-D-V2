"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Youtube, Check, Loader2, Users, Film, Eye, BarChart3, ShieldCheck, Sparkles } from "lucide-react";
import {
  getYouTubeAuthUrl,
  fetchChannelVideos,
  fetchChannelTrends,
  fetchChannelDaily,
  fetchYouTubeChannels,
} from "@/lib/data/api";
import type { ChannelTrendSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

type Phase = "idle" | "analyzing" | "done" | "error";

// useSearchParams() opts the subtree into client rendering, so it must sit under a
// Suspense boundary or the /register prerender fails at build time.
export default function RegisterPage() {
  return (
    <Suspense>
      <RegisterFlow />
    </Suspense>
  );
}

/**
 * Single-page onboarding for external creators. The whole journey — Google login,
 * live analysis, results — happens here; we never send the visitor to another screen.
 */
function RegisterFlow() {
  const searchParams = useSearchParams();
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorText, setErrorText] = useState("");

  const [channelId, setChannelId] = useState("");
  const [channelName, setChannelName] = useState("");
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [subscribers, setSubscribers] = useState(0);
  const [videoCount, setVideoCount] = useState(0);
  const [analyticsDays, setAnalyticsDays] = useState(0);
  const [summary, setSummary] = useState<ChannelTrendSummary | null>(null);

  // Read the OAuth callback result once (the server redirects back here).
  useEffect(() => {
    // Design preview — no OAuth/polling needed. `?preview=analyzing` or `?preview=done`.
    const preview = searchParams.get("preview");
    if (preview === "analyzing" || preview === "done") {
      setChannelName("샘플 크리에이터");
      setSubscribers(1_234_000);
      setVideoCount(342);
      if (preview === "done") {
        setSummary({ totalViews: 89_000_000, videoCount: 342, recentPeriodViews: 0, earlierPeriodViews: 0, growthPercent: 0 });
        setAnalyticsDays(365);
        setPhase("done");
      } else {
        setAnalyticsDays(0); // leaves the "시청 데이터 분석 중" step active
        setPhase("analyzing");
      }
      return;
    }

    const success = searchParams.get("success");
    const cid = searchParams.get("channelId");
    const cname = searchParams.get("channelName");
    const error = searchParams.get("error");
    if (success && cid) {
      setChannelId(cid);
      setChannelName(cname ? decodeURIComponent(cname) : "내 채널");
      setPhase("analyzing");
    } else if (error) {
      setErrorText(decodeURIComponent(error));
      setPhase("error");
    }
  }, [searchParams]);

  // While analyzing, poll our DB and reveal each number as the worker fills it in.
  // Every endpoint just reads whatever's collected so far, so counts climb live.
  useEffect(() => {
    if (phase !== "analyzing" || !channelId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const startedAt = performance.now();
    const MAX_ATTEMPTS = 45; // ~90s ceiling so we never spin forever
    const INTERVAL = 2000;
    const MIN_MS = 2600; // let the scan animation breathe before flipping to done

    async function tick() {
      attempts += 1;
      const [vids, trends, daily, channels] = await Promise.allSettled([
        fetchChannelVideos(channelId),
        fetchChannelTrends(channelId, 30),
        fetchChannelDaily(channelId, 365),
        fetchYouTubeChannels(),
      ]);
      if (cancelled) return;

      let vc = 0;
      let days = 0;
      if (vids.status === "fulfilled") { vc = vids.value.videoCount; setVideoCount(vc); }
      if (trends.status === "fulfilled") setSummary(trends.value.summary);
      if (daily.status === "fulfilled") { days = daily.value.length; setAnalyticsDays(days); }
      let synced = false;
      let analyzed = false;
      if (channels.status === "fulfilled") {
        const me = channels.value.find((c) => c.channelId === channelId);
        if (me) {
          setThumbnail(me.thumbnail);
          if (me.subscribers) setSubscribers(Number(me.subscribers) || 0);
          if (me.channelName) setChannelName(me.channelName);
          synced = me.lastSyncedAt != null;
          analyzed = me.lastAnalyzedAt != null;
        }
      }

      // Finish when the analyze job settled, or content+backfill is visible, or the
      // sync ran and the channel simply has no uploads — so an empty channel doesn't
      // spin the full 90s ceiling. (attempts guard avoids concluding "empty" mid-sync.)
      const hasContent = vc > 0 && days > 0;
      const emptyChannel = synced && vc === 0 && attempts >= 3;
      const ready = analyzed || hasContent || emptyChannel;
      const elapsed = performance.now() - startedAt;
      if ((ready && elapsed > MIN_MS) || attempts >= MAX_ATTEMPTS) {
        setPhase("done");
        return;
      }
      timer = setTimeout(tick, INTERVAL);
    }
    tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [phase, channelId]);

  return (
    <div className="relative min-h-screen overflow-hidden bg-zinc-950 text-white flex items-center justify-center px-4 py-12">
      {/* ambient brand glows */}
      <div className="pointer-events-none absolute -top-44 -left-44 w-[34rem] h-[34rem] rounded-full bg-indigo-600/20 blur-[130px]" />
      <div className="pointer-events-none absolute -bottom-44 -right-44 w-[34rem] h-[34rem] rounded-full bg-fuchsia-600/10 blur-[130px]" />

      <div className="relative w-full max-w-md">
        {phase === "idle" && <IdleCard />}
        {phase === "analyzing" && (
          <AnalyzingCard
            channelName={channelName}
            thumbnail={thumbnail}
            subscribers={subscribers}
            videoCount={videoCount}
            analyticsDays={analyticsDays}
          />
        )}
        {phase === "done" && (
          <DoneCard
            channelName={channelName}
            thumbnail={thumbnail}
            subscribers={subscribers}
            videoCount={videoCount}
            summary={summary}
          />
        )}
        {phase === "error" && <ErrorCard text={errorText} />}
      </div>
    </div>
  );
}

// ── idle: Google-only sign-in ────────────────────────────────────────────────────

function IdleCard() {
  return (
    <div className="rounded-3xl border border-white/10 bg-white/[0.03] backdrop-blur-xl p-8 shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex justify-center mb-6">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-zinc-300">
          <Sparkles className="w-3.5 h-3.5 text-indigo-400" /> STEP D 크리에이터 채널 분석
        </span>
      </div>

      <h1 className="text-center text-[1.7rem] leading-tight font-bold tracking-tight">
        내 유튜브 채널,<br />지금 바로 분석해요
      </h1>
      <p className="mt-3 text-center text-sm text-zinc-400 leading-relaxed">
        구글 로그인 한 번이면 끝.<br />STEP D가 채널 성과를 자동으로 분석해 드립니다.
      </p>

      <button
        onClick={() => { window.location.href = getYouTubeAuthUrl(); }}
        className="mt-8 w-full rounded-2xl bg-white hover:bg-zinc-100 text-zinc-900 font-semibold px-6 py-3.5 flex items-center justify-center gap-3 transition shadow-lg active:scale-[0.99]"
      >
        <GoogleIcon /> Google 계정으로 시작하기
      </button>

      <div className="mt-6 flex items-center justify-center gap-2 text-xs text-zinc-500">
        <ShieldCheck className="w-4 h-4 text-emerald-400/80" />
        <span><span className="text-zinc-300">읽기 권한만</span> 요청 · 영상을 수정·삭제하지 않아요</span>
      </div>

      <p className="mt-4 text-center text-[11px] text-zinc-600 leading-relaxed">
        계속하면{" "}
        <a href="/terms" className="underline hover:text-zinc-400">이용약관</a>{" "}및{" "}
        <a href="/privacy" className="underline hover:text-zinc-400">개인정보처리방침</a>에 동의하게 됩니다.
      </p>
    </div>
  );
}

// ── analyzing: scanning avatar + live progress ───────────────────────────────────

function AnalyzingCard(p: {
  channelName: string;
  thumbnail: string | null;
  subscribers: number;
  videoCount: number;
  analyticsDays: number;
}) {
  const steps = [
    { label: "채널 연결 완료", done: true, detail: "" },
    { label: "업로드 영상 불러오는 중", done: p.videoCount > 0, detail: p.videoCount > 0 ? `${p.videoCount.toLocaleString("ko-KR")}개` : "" },
    { label: "최근 1년 시청 데이터 분석 중", done: p.analyticsDays > 0, detail: p.analyticsDays > 0 ? `${p.analyticsDays}일` : "" },
    { label: "채널 인사이트 계산 중", done: false, detail: "" },
  ];
  const activeIndex = steps.findIndex((s) => !s.done);

  return (
    <div className="rounded-3xl border border-white/10 bg-white/[0.03] backdrop-blur-xl p-8 shadow-2xl animate-in fade-in duration-500">
      <ScanAvatar thumbnail={p.thumbnail} />

      <h1 className="mt-6 text-center text-xl font-bold">채널을 분석하고 있어요</h1>
      <p className="mt-1.5 text-center text-sm text-zinc-400 truncate">{p.channelName}</p>

      <div className="mt-6 grid grid-cols-2 gap-3">
        <LiveStat icon={Users} label="구독자" value={p.subscribers} ready={p.subscribers > 0} />
        <LiveStat icon={Film} label="영상" value={p.videoCount} ready={p.videoCount > 0} />
      </div>

      <div className="mt-6 space-y-3">
        {steps.map((s, i) => (
          <StepRow
            key={i}
            label={s.label}
            detail={s.detail}
            state={s.done ? "done" : i === activeIndex ? "active" : "pending"}
          />
        ))}
      </div>

      <p className="mt-7 text-center text-xs text-zinc-500">잠시만 기다려 주세요 · 보통 1분 이내에 끝나요</p>
    </div>
  );
}

function ScanAvatar({ thumbnail }: { thumbnail: string | null }) {
  return (
    <div className="relative mx-auto w-28 h-28">
      <div className="absolute inset-0 rounded-full bg-indigo-500/25 blur-2xl animate-pulse" />
      <div className="absolute inset-0 rounded-full bg-linear-to-tr from-indigo-500 via-fuchsia-500 to-emerald-400 animate-[spin_3s_linear_infinite]" />
      <div className="absolute inset-[4px] rounded-full bg-zinc-950 grid place-items-center overflow-hidden">
        {thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumbnail} alt="" className="w-full h-full object-cover" />
        ) : (
          <Youtube className="w-10 h-10 text-white" />
        )}
      </div>
    </div>
  );
}

function StepRow({ label, detail, state }: { label: string; detail: string; state: "done" | "active" | "pending" }) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={cn(
          "grid place-items-center w-6 h-6 rounded-full shrink-0",
          state === "done" && "bg-emerald-500/15 text-emerald-400",
          state === "active" && "bg-indigo-500/15 text-indigo-400",
          state === "pending" && "bg-white/5 text-zinc-600",
        )}
      >
        {state === "done" ? (
          <Check className="w-3.5 h-3.5" strokeWidth={3} />
        ) : state === "active" ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <span className="w-1.5 h-1.5 rounded-full bg-current" />
        )}
      </span>
      <span className={cn("text-sm", state === "pending" ? "text-zinc-600" : "text-zinc-200")}>{label}</span>
      {detail && <span className="ml-auto text-xs text-zinc-500 tabular-nums">{detail}</span>}
    </div>
  );
}

function LiveStat({ icon: Icon, label, value, ready }: { icon: typeof Users; label: string; value: number; ready: boolean }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3">
      <div className="flex items-center gap-1.5 text-xs text-zinc-500">
        <Icon className="w-3.5 h-3.5" /> {label}
      </div>
      <div className="mt-1 text-lg font-bold tabular-nums">
        {ready ? <AnimatedNumber value={value} format={formatKor} /> : <span className="text-zinc-600">···</span>}
      </div>
    </div>
  );
}

// ── done: results reveal (stays on /register) ────────────────────────────────────

function DoneCard(p: {
  channelName: string;
  thumbnail: string | null;
  subscribers: number;
  videoCount: number;
  summary: ChannelTrendSummary | null;
}) {
  const totalViews = p.summary?.totalViews ?? 0;
  const avgViews = p.videoCount > 0 ? Math.round(totalViews / p.videoCount) : 0;

  return (
    <div className="rounded-3xl border border-white/10 bg-white/[0.03] backdrop-blur-xl p-8 shadow-2xl animate-in fade-in zoom-in-95 duration-500">
      <div className="relative mx-auto w-24 h-24">
        <div className="absolute inset-0 rounded-full bg-emerald-500/25 blur-2xl" />
        <div className="absolute inset-0 rounded-full overflow-hidden border border-white/10 bg-zinc-900 grid place-items-center">
          {p.thumbnail ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.thumbnail} alt="" className="w-full h-full object-cover" />
          ) : (
            <Youtube className="w-9 h-9 text-white" />
          )}
        </div>
        <span className="absolute -bottom-1 -right-1 grid place-items-center w-8 h-8 rounded-full bg-emerald-500 border-4 border-zinc-950 animate-in zoom-in duration-500 delay-200">
          <Check className="w-4 h-4 text-white" strokeWidth={3} />
        </span>
      </div>

      <h1 className="mt-6 text-center text-xl font-bold">분석이 완료됐어요 🎉</h1>
      <p className="mt-1.5 text-center text-sm text-zinc-400 truncate">{p.channelName}</p>

      <div className="mt-6 grid grid-cols-2 gap-3">
        <BigStat icon={Users} label="구독자" value={p.subscribers} format={formatKor} />
        <BigStat icon={Film} label="영상" value={p.videoCount} format={(n) => n.toLocaleString("ko-KR")} />
        <BigStat icon={Eye} label="총 조회수" value={totalViews} format={formatKor} accent />
        <BigStat icon={BarChart3} label="평균 조회수" value={avgViews} format={formatKor} />
      </div>

      <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-4 text-center">
        <p className="text-sm text-zinc-300">STEP D 팀이 결과를 확인하고 곧 연락드릴게요.</p>
        <p className="mt-1 text-xs text-zinc-500">이 창은 닫으셔도 됩니다.</p>
      </div>
    </div>
  );
}

function BigStat({ icon: Icon, label, value, format, accent }: {
  icon: typeof Users;
  label: string;
  value: number;
  format: (n: number) => string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3.5">
      <div className="flex items-center gap-1.5 text-xs text-zinc-500">
        <Icon className="w-3.5 h-3.5" /> {label}
      </div>
      <div className={cn("mt-1 text-2xl font-bold tabular-nums", accent ? "text-indigo-300" : "text-white")}>
        <AnimatedNumber value={value} format={format} />
      </div>
    </div>
  );
}

// ── error ────────────────────────────────────────────────────────────────────────

function ErrorCard({ text }: { text: string }) {
  const friendly = text === "access_denied" ? "로그인이 취소됐어요." : text || "잠시 후 다시 시도해 주세요.";
  return (
    <div className="rounded-3xl border border-white/10 bg-white/[0.03] backdrop-blur-xl p-8 shadow-2xl text-center animate-in fade-in duration-500">
      <div className="mx-auto w-16 h-16 rounded-2xl bg-rose-500/15 grid place-items-center">
        <Youtube className="w-8 h-8 text-rose-400" />
      </div>
      <h1 className="mt-5 text-xl font-bold">연결에 실패했어요</h1>
      <p className="mt-2 text-sm text-zinc-400">{friendly}</p>
      <button
        onClick={() => { window.location.href = getYouTubeAuthUrl(); }}
        className="mt-6 w-full rounded-2xl bg-white hover:bg-zinc-100 text-zinc-900 font-semibold px-6 py-3 flex items-center justify-center gap-3 transition"
      >
        <GoogleIcon /> 다시 시도하기
      </button>
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────────

/** Count up to `value`, resuming from the last shown number so re-polls don't jolt. */
function AnimatedNumber({ value, format }: { value: number; format: (n: number) => string }) {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    if (from === to) { setDisplay(to); return; }
    let raf: number;
    const start = performance.now();
    const duration = 900;
    const step = (t: number) => {
      const progress = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(from + (to - from) * eased);
      if (progress < 1) raf = requestAnimationFrame(step);
      else fromRef.current = to;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return <>{format(Math.round(display))}</>;
}

/** Korean-friendly big-number formatting: 12,300,000 → "1230만". */
function formatKor(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 100_000_000) return `${trim(n / 100_000_000)}억`;
  if (n >= 10_000) return `${trim(n / 10_000)}만`;
  return n.toLocaleString("ko-KR");
}

function trim(n: number): string {
  return n.toFixed(1).replace(/\.0$/, "");
}

function GoogleIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}
