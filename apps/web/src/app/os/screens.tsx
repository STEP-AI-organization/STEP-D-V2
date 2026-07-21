"use client";

/** STEP D Review OS — React port, remaining screens (프로그램·클립·배포현황·성과·채널
 *  트렌드·배포채널·운영). Faithful to the prototype's demo data + palette. */
import { useEffect, useState } from "react";
import type { Program, Episode, Clip } from "@/lib/types";
import { DISTRIBUTION_CHANNELS, type DistributionChannel } from "@/lib/constants";
import { formatDuration } from "@/lib/utils";
import { useAppData } from "@/lib/data/store";
import {
  fetchYouTubeChannels, type YouTubeChannelInfo,
  fetchOpsJobs, type OpsJob,
  fetchChannelTrends, fetchChannelVideos, syncChannelVideos,
} from "@/lib/data/api";
import type { YouTubeChannelVideo, ChannelTrendSummary, DailyTrend } from "@/lib/types";

const THUMBS = [
  "linear-gradient(160deg,#2b2620,#17140f)",
  "linear-gradient(160deg,#26253a,#15141d)",
  "linear-gradient(160deg,#1f2b28,#131917)",
  "linear-gradient(160deg,#2b2226,#171215)",
  "linear-gradient(160deg,#222b34,#13181e)",
];
const rgba = (h: string, a: number) => {
  const n = parseInt(h.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
function Eyebrow({ kicker, title, desc, action }: { kicker: string; title: string; desc?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end gap-3.5">
      <div>
        <div className="mb-[7px] text-[13.5px] font-semibold text-[#8b93ff]">{kicker}</div>
        <h1 className="grotesk text-[25px] font-bold tracking-[-.5px]">{title}</h1>
        {desc && <p className="mt-1.5 text-[13px] text-[#9a9a9a]">{desc}</p>}
      </div>
      {action && <><span className="flex-1" />{action}</>}
    </div>
  );
}
function PrimaryBtn({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return <button onClick={onClick} className="flex items-center gap-[7px] rounded-[9px] bg-[#6b74f0] px-4 py-[9px] text-[13px] font-semibold text-white transition-colors hover:bg-[#5a63e6]">{children}</button>;
}
const Plus = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}><path d="M12 5v14M5 12h14" /></svg>;

/* ─────────── PROGRAMS ─────────── */
const SECTION_EMOJI: Record<string, string> = { 예능: "🎬", "드라마/영화": "🎭", 뮤직: "🎵", 시사: "📰", 교양: "📚", 라이프: "🌿", 스포츠: "⚽", 게임: "🎮", 어린이: "🧸", 뉴스: "📡", 애니: "✨" };
const ageLabel = (a: number) => (a === 0 ? "전체" : `${a}세`);
export function Programs({ programs, episodes, loading, onOpenProgram, onNewProgram, onUpload }: {
  programs: Program[]; episodes: Episode[]; loading: boolean;
  onOpenProgram: (t: string) => void; onNewProgram: () => void; onUpload: (id: string) => void;
}) {
  return (
    <div className="max-w-[1080px] px-[30px] py-[26px]">
      <Eyebrow kicker="프로그램 → 회차" title="프로그램" desc="프로그램을 먼저 등록한 뒤 원본을 업로드하면 회차·추천이 생성돼요." action={<PrimaryBtn onClick={onNewProgram}>{Plus}새 프로그램</PrimaryBtn>} />
      {loading && programs.length === 0 ? (
        <div className="py-16 text-center text-[13px] text-[#707070]">불러오는 중…</div>
      ) : programs.length === 0 ? (
        <div className="rounded-[14px] border border-dashed border-[#2b2b2b] py-16 text-center">
          <div className="text-[14px] font-semibold text-[#cfcfcf]">아직 프로그램이 없어요</div>
          <div className="mt-1.5 text-[12.5px] text-[#707070]">먼저 <b className="text-[#8b93ff]">새 프로그램</b>을 만든 뒤 원본을 업로드하세요.</div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {programs.map((p) => {
            const eps = p.episodeCount || episodes.filter((e) => e.programId === p.id).length;
            const cast = p.cast?.length ? `출연 ${p.cast.slice(0, 3).join(", ")}${p.cast.length > 3 ? " 외" : ""}` : "출연 미등록";
            const smrReady = !!(p.smr?.programCode && p.smr?.weekdays?.length);
            return (
              <div key={p.id} className="flex flex-wrap items-center gap-4 rounded-[14px] border border-[#262626] bg-[#161616] px-[18px] py-4">
                <div className="flex h-[68px] w-[52px] flex-none items-center justify-center rounded-[10px] border border-[#262626] bg-[linear-gradient(160deg,rgba(139,147,255,.2),rgba(139,147,255,.05))] text-[26px]">{SECTION_EMOJI[p.section] || p.title.charAt(0)}</div>
                <div className="min-w-[180px] flex-1">
                  <div className="flex flex-wrap items-center gap-2"><span className="text-[16px] font-bold tracking-[-.3px]">{p.title}</span><span className="rounded-[6px] border border-[#2b2b2b] bg-[#0e0e0e] px-2 py-0.5 text-[11px] font-semibold text-[#9a9a9a]">{p.section}</span><span className="rounded-[6px] border border-[#2b2b2b] bg-[#0e0e0e] px-2 py-0.5 text-[11px] font-semibold text-[#9a9a9a]">{ageLabel(p.targetAge)}</span></div>
                  <div className="mt-[5px] text-[12px] text-[#707070]">회차 {eps} · {cast}</div>
                  <div className="mt-[9px]"><span className="inline-flex items-center gap-[5px] rounded-full px-2.5 py-[3px] text-[11px] font-bold" style={smrReady ? { color: "#34d399", background: "rgba(52,211,153,.12)" } : { color: "#fbbf24", background: "rgba(251,191,36,.12)" }}>{smrReady ? "SMR 피드 준비 완료" : "SMR 피드 미충족"}</span></div>
                </div>
                <div className="flex flex-none gap-2">
                  <button onClick={() => onOpenProgram(p.title)} className="rounded-[9px] border border-[#2b2b2b] bg-[#1e1e1e] px-[15px] py-[9px] text-[12.5px] font-semibold text-[#cfcfcf] hover:border-[#3a3a3a] hover:text-[#e5e5e5]">회차 보기</button>
                  <PrimaryBtn onClick={() => onUpload(p.id)}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}><path d="M12 3v12M8 11l4-4 4 4M4 19h16" /></svg>업로드</PrimaryBtn>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─────────── GLOBAL CLIPS (real) ─────────── */
const CLIP_STATE: Record<Clip["status"], { l: string; c: string; bg: string; ln: string }> = {
  editing: { l: "초안", c: "#fbbf24", bg: "rgba(251,191,36,.12)", ln: "rgba(251,191,36,.3)" },
  encoding: { l: "인코딩", c: "#fbbf24", bg: "rgba(251,191,36,.12)", ln: "rgba(251,191,36,.3)" },
  ready: { l: "확정", c: "#8b93ff", bg: "rgba(139,147,255,.13)", ln: "rgba(139,147,255,.3)" },
  published: { l: "게시됨", c: "#34d399", bg: "rgba(52,211,153,.13)", ln: "rgba(52,211,153,.3)" },
};
const CLIP_FILTERS: [string, (c: Clip) => boolean][] = [
  ["전체", () => true],
  ["초안", (c) => c.status === "editing" || c.status === "encoding"],
  ["확정", (c) => c.status === "ready"],
  ["게시됨", (c) => c.status === "published"],
];
export function GlobalClips({ clips, loading, onEdit, onDistribute }: {
  clips: Clip[]; loading: boolean; onEdit: (id: string) => void; onDistribute: (id: string) => void;
}) {
  const [f, setF] = useState(0);
  const list = clips.filter(CLIP_FILTERS[f][1]);
  return (
    <div className="max-w-[1320px] px-[30px] py-[26px]">
      <Eyebrow kicker="전체 프로그램" title="클립" desc="채택한 쇼츠 후보가 초안 → 확정(서버 1회 렌더) → 게시 상태로 흐릅니다." />
      <div className="mb-5 flex gap-[7px]">
        {CLIP_FILTERS.map(([label], i) => (
          <button key={label} onClick={() => setF(i)} className="rounded-full px-[13px] py-1.5 text-[12.5px] font-semibold" style={f === i ? { background: "rgba(139,147,255,.12)", border: "1px solid rgba(139,147,255,.3)", color: "#c3c8ff" } : { background: "#161616", border: "1px solid #2b2b2b", color: "#9a9a9a" }}>{label}</button>
        ))}
      </div>
      {loading && clips.length === 0 ? (
        <div className="py-16 text-center text-[13px] text-[#707070]">불러오는 중…</div>
      ) : list.length === 0 ? (
        <div className="rounded-[14px] border border-dashed border-[#2b2b2b] py-16 text-center text-[13px] text-[#707070]">채택한 클립이 없어요 — 검수에서 쇼츠 후보를 채택하면 여기에 쌓여요.</div>
      ) : (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(210px,1fr))]">
          {list.map((c, i) => {
            const t = CLIP_STATE[c.status];
            const range = c.startTime != null && c.endTime != null ? `${formatDuration(c.startTime)}–${formatDuration(c.endTime)}` : formatDuration(c.durationSec);
            return (
              <div key={c.id} className="flex flex-col overflow-hidden rounded-[14px] border border-[#262626] bg-[#161616]">
                <div className="relative max-h-[230px] [aspect-ratio:9/16] bg-cover bg-center" style={c.thumbnailUrl ? { backgroundImage: `url(${c.thumbnailUrl})` } : { background: THUMBS[i % THUMBS.length] }}>
                  <span className="absolute left-[9px] top-[9px] rounded-full px-[9px] py-0.5 text-[10.5px] font-bold" style={{ color: t.c, background: t.bg, border: `1px solid ${t.ln}` }}>{t.l}</span>
                </div>
                <div className="flex flex-1 flex-col p-[13px]">
                  <div className="text-[13px] font-bold leading-[1.35] tracking-[-.3px] [text-wrap:pretty]">{c.title}</div>
                  <div className="mt-[5px] text-[11px] text-[#707070]">{c.programTitle} · <span className="mono">{range}</span></div>
                  <div className="mt-3 flex gap-[7px]">
                    <button onClick={() => onEdit(c.id)} className="flex-1 rounded-[8px] border border-[#2b2b2b] bg-[#1e1e1e] py-2 text-[12px] font-semibold text-[#cfcfcf] hover:border-[#3a3a3a] hover:text-[#eceef2]">편집</button>
                    <button onClick={() => onDistribute(c.id)} className="flex-1 rounded-[8px] bg-[#6b74f0] py-2 text-[12px] font-semibold text-white hover:bg-[#5a63e6]">배포</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─────────── DISTRIBUTION (real) ─────────── */
const DSTAT: Record<string, { l: string; c: string; bg: string }> = {
  published: { l: "게시", c: "#34d399", bg: "rgba(52,211,153,.14)" },
  scheduled: { l: "예약", c: "#fbbf24", bg: "rgba(251,191,36,.14)" },
  failed: { l: "실패", c: "#ff6b78", bg: "rgba(248,113,113,.14)" },
  pending: { l: "대기", c: "#9a9a9a", bg: "rgba(138,146,160,.12)" },
  none: { l: "미배포", c: "#707070", bg: "rgba(138,146,160,.1)" },
};
export function Distribution({ clips, loading, onRetry }: {
  clips: Clip[]; loading: boolean; onRetry: (clipId: string, channel: DistributionChannel) => void;
}) {
  const rows = clips.filter((c) => c.distributions.length > 0);
  const all = clips.flatMap((c) => c.distributions);
  const summary = [
    { l: "게시 완료", v: all.filter((d) => d.status === "published").length, c: "#34d399" },
    { l: "예약", v: all.filter((d) => d.status === "scheduled").length, c: "#fbbf24" },
    { l: "실패", v: all.filter((d) => d.status === "failed").length, c: "#ff6b78" },
    { l: "대기", v: all.filter((d) => d.status === "pending").length, c: "#9a9a9a" },
  ];
  return (
    <div className="max-w-[1160px] px-[30px] py-[26px]">
      <Eyebrow kicker="멀티채널 배포" title="배포현황" />
      <div className="mb-5 flex flex-wrap gap-3">
        {summary.map((s) => (
          <div key={s.l} className="flex items-center gap-2.5 rounded-[12px] border border-[#262626] bg-[#161616] px-5 py-3"><span className="size-[9px] rounded-full" style={{ background: s.c }} /><span className="grotesk text-[22px] font-bold" style={{ color: s.c }}>{s.v}</span><span className="text-[12px] text-[#9a9a9a]">{s.l}</span></div>
        ))}
      </div>
      {loading && clips.length === 0 ? (
        <div className="py-16 text-center text-[13px] text-[#707070]">불러오는 중…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-[14px] border border-dashed border-[#2b2b2b] py-16 text-center text-[13px] text-[#707070]">예약·배포된 클립이 없어요.</div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {rows.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-3.5 rounded-[12px] border border-[#262626] bg-[#161616] px-4 py-[13px]">
              <div className="min-w-[180px] flex-1"><div className="text-[14px] font-bold tracking-[-.3px]">{c.title}</div><div className="mt-0.5 text-[11.5px] text-[#707070]">{c.programTitle}</div></div>
              <div className="flex flex-wrap gap-2">
                {c.distributions.map((d) => {
                  const t = DSTAT[d.status] ?? DSTAT.none;
                  return (
                    <button key={d.channel} onClick={() => d.status === "failed" && onRetry(c.id, d.channel)} disabled={d.status !== "failed"} title={d.error ?? undefined} className="flex items-center gap-[5px] rounded-[7px] px-[9px] py-1 text-[11px] font-semibold" style={{ color: t.c, background: t.bg, cursor: d.status === "failed" ? "pointer" : "default" }}>
                      <span className="opacity-80">{DISTRIBUTION_CHANNELS[d.channel] ?? d.channel}</span><span className="font-bold">{d.status === "failed" ? "재시도" : t.l}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─────────── ANALYTICS (real, store-derived) ─────────── */
export function Analytics() {
  const { clips, recommendations, programs } = useAppData();
  const adopted = recommendations.filter((r) => r.status === "adopted").length;
  const published = clips.filter((c) => c.status === "published").length;
  const rate = recommendations.length ? `${Math.round((adopted / recommendations.length) * 100)}%` : "—";
  const kpi = [
    { label: "총 추천", value: String(recommendations.length) },
    { label: "채택 클립", value: String(clips.length) },
    { label: "게시 클립", value: String(published) },
    { label: "추천 채택률", value: rate },
  ];
  const funnel = [
    { label: "추천", v: recommendations.length, c: "#8b93ff" },
    { label: "채택", v: adopted, c: "#6b74f0" },
    { label: "클립", v: clips.length, c: "#5e9bff" },
    { label: "게시", v: published, c: "#34d399" },
  ];
  const fmax = Math.max(1, ...funnel.map((f) => f.v));
  const recent = clips.slice(0, 8);
  return (
    <div className="max-w-[1160px] px-[30px] py-[26px]">
      <Eyebrow kicker={`게시 클립 성과 · 프로그램 ${programs.length}`} title="성과" desc="추천 → 채택 → 클립 → 게시 계보. 조회수·시청 성과는 채널 트렌드에서 채널별로 봅니다." />
      <div className="mb-[18px] grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
        {kpi.map((k) => (
          <div key={k.label} className="rounded-[14px] border border-[#262626] bg-[#161616] px-[18px] py-4"><div className="mb-[9px] text-[11.5px] font-semibold text-[#707070]">{k.label}</div><div className="grotesk text-[28px] font-bold tracking-[-.5px]">{k.value}</div></div>
        ))}
      </div>
      <div className="grid items-start gap-[18px] [grid-template-columns:1fr_1fr]">
        <div className="rounded-[14px] border border-[#262626] bg-[#161616] px-5 py-[18px]">
          <div className="mb-4 text-[13px] font-bold">추천 → 게시 계보</div>
          <div className="flex flex-col gap-3">
            {funnel.map((f) => (
              <div key={f.label} className="flex items-center gap-3">
                <span className="w-10 flex-none text-[12px] font-semibold text-[#9a9a9a]">{f.label}</span>
                <div className="h-6 flex-1 overflow-hidden rounded-[6px] bg-[#0e0e0e]"><div className="h-full rounded-[6px]" style={{ width: `${(f.v / fmax) * 100}%`, background: f.c, minWidth: f.v > 0 ? 24 : 0 }} /></div>
                <span className="grotesk w-9 flex-none text-right text-[15px] font-bold">{f.v}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-[14px] border border-[#262626] bg-[#161616] px-5 py-[18px]">
          <div className="mb-3 text-[13px] font-bold">최근 클립</div>
          {recent.length === 0 ? (
            <div className="py-6 text-center text-[12.5px] text-[#707070]">아직 클립이 없어요.</div>
          ) : (
            <div className="flex flex-col">
              {recent.map((c) => {
                const t = CLIP_STATE[c.status];
                return (
                  <div key={c.id} className="flex items-center gap-3 border-t border-[#232323] py-2.5">
                    <div className="min-w-0 flex-1"><div className="truncate text-[12.5px] font-semibold">{c.title}</div><div className="text-[10.5px] text-[#707070]">{c.programTitle}</div></div>
                    <span className="flex-none rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ color: t.c, background: t.bg }}>{t.l}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─────────── CHANNEL TRENDS (real) ─────────── */
const fmtN = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}만` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
export function Trends() {
  const [channels, setChannels] = useState<YouTubeChannelInfo[]>([]);
  const [chId, setChId] = useState("");
  const [summary, setSummary] = useState<ChannelTrendSummary | null>(null);
  const [trend, setTrend] = useState<DailyTrend[]>([]);
  const [videos, setVideos] = useState<YouTubeChannelVideo[]>([]);
  const [kind, setKind] = useState("all");
  const [sort, setSort] = useState("recent");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let a = true;
    fetchYouTubeChannels().then((c) => { if (a) { setChannels(c); setChId(c[0]?.channelId ?? ""); setLoading(false); } }).catch(() => { if (a) setLoading(false); });
    return () => { a = false; };
  }, []);
  useEffect(() => {
    if (!chId) return;
    let a = true;
    fetchChannelTrends(chId, 90).then((d) => { if (a) { setSummary(d.summary); setTrend(d.trend); } }).catch(() => {});
    fetchChannelVideos(chId).then((d) => { if (a) setVideos(d.videos); }).catch(() => { if (a) setVideos([]); });
    return () => { a = false; };
  }, [chId]);

  async function sync() {
    if (!chId || syncing) return;
    setSyncing(true);
    try { await syncChannelVideos(chId); const d = await fetchChannelVideos(chId); setVideos(d.videos); } catch { /* ignore */ }
    setSyncing(false);
  }

  const sd = trend.map((t) => t.totalViews);
  const mx = Math.max(1, ...sd), mn = Math.min(0, ...sd);
  const line = sd.length > 1 ? sd.map((y, i) => `${((i / (sd.length - 1)) * 300).toFixed(1)},${(90 - ((y - mn) / (mx - mn || 1)) * 78 - 6).toFixed(1)}`).join(" ") : "";
  const kinds: [string, string][] = [["all", "전체"], ["regular", "일반영상"], ["shorts", "쇼츠"]];
  const kindCount: Record<string, number> = { all: videos.length, shorts: videos.filter((v) => v.isShort).length, regular: videos.filter((v) => !v.isShort).length };
  let vlist = videos.filter((v) => kind === "all" || (kind === "shorts" ? v.isShort : !v.isShort));
  if (sort === "views") vlist = [...vlist].sort((a, b) => b.viewCount - a.viewCount);
  else if (sort === "comments") vlist = [...vlist].sort((a, b) => b.commentCount - a.commentCount);
  else vlist = [...vlist].sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  const rev = summary?.channelRevenue;
  const kpi = summary ? [
    { label: "최근 90일 조회수", value: fmtN(summary.recentPeriodViews), sub: "YouTube 일별 합계", tone: "#5e9bff" },
    { label: "성장률", value: `${summary.growthPercent >= 0 ? "+" : ""}${summary.growthPercent}%`, sub: "이전 90일 대비", tone: summary.growthPercent >= 0 ? "#34d399" : "#ff6b78" },
    { label: "시청 시간", value: summary.watchMinutes != null ? `${fmtN(Math.round(summary.watchMinutes / 60))}시간` : "—", sub: "최근 90일", tone: "#e5e5e5" },
    { label: "순 구독자", value: summary.netSubscribers != null ? `${summary.netSubscribers >= 0 ? "+" : ""}${fmtN(summary.netSubscribers)}` : "—", sub: "최근 90일", tone: "#34d399" },
  ] : [];

  return (
    <div className="max-w-[1080px] px-[30px] py-[26px]">
      <Eyebrow kicker="YouTube 채널 분석" title="채널 트렌드" desc="채널별 조회수 추세·수익·영상 성과를 봅니다." />
      <div className="mb-[18px] flex flex-wrap items-center gap-[9px]">
        <span className="text-[12px] font-semibold text-[#707070]">채널</span>
        <select value={chId} onChange={(e) => setChId(e.target.value)} className="min-w-[240px] cursor-pointer rounded-[9px] border border-[#2b2b2b] bg-[#161616] px-3 py-2 text-[12.5px] font-semibold text-[#e5e5e5]">
          {channels.length === 0 && <option>연동된 채널 없음</option>}
          {channels.map((c) => (<option key={c.channelId} value={c.channelId}>{c.channelName}</option>))}
        </select>
        <span className="flex-1" />
        <button onClick={sync} disabled={!chId || syncing} className="flex items-center gap-1.5 rounded-[8px] bg-[#6b74f0] px-3.5 py-2 text-[12.5px] font-semibold text-white disabled:opacity-50"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" /></svg>{syncing ? "동기화 중…" : "YouTube 동기화"}</button>
      </div>
      {loading ? (
        <div className="py-16 text-center text-[13px] text-[#707070]">불러오는 중…</div>
      ) : channels.length === 0 ? (
        <div className="rounded-[14px] border border-dashed border-[#2b2b2b] py-16 text-center text-[13px] text-[#707070]">연동된 채널이 없어요 — 배포채널에서 YouTube 채널을 연결하세요.</div>
      ) : (
        <>
          <div className="mb-4 grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
            {kpi.map((k) => (<div key={k.label} className="rounded-[13px] border border-[#262626] bg-[#161616] px-4 py-[15px]"><div className="mb-2 text-[11.5px] font-semibold text-[#707070]">{k.label}</div><div className="grotesk text-[24px] font-bold tracking-[-.3px]" style={{ color: k.tone }}>{k.value}</div><div className="mt-[5px] text-[11px] text-[#707070]">{k.sub}</div></div>))}
          </div>
          <div className="mb-4 rounded-[14px] border border-[rgba(52,211,153,.3)] bg-[rgba(52,211,153,.05)] px-[18px] py-4">
            <div className="mb-2.5 flex items-center gap-[7px] text-[13px] font-bold text-[#34d399]"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></svg>수익 (최근 90일)</div>
            {rev != null && rev > 0 ? (
              <div className="flex flex-wrap items-baseline gap-2"><span className="grotesk text-[26px] font-bold text-[#34d399]">${Math.round(rev).toLocaleString()}</span><span className="text-[11.5px] text-[#707070]">채널 예상 수익 (USD)</span></div>
            ) : (
              <div className="text-[12px] leading-[1.6] text-[#9a9a9a]">이 채널은 <b className="text-[#e5e5e5]">수익화(YPP) 전</b>이거나 수익을 <b className="text-[#e5e5e5]">콘텐츠 소유자(MCN·방송사)가 관리</b>해, 크리에이터 권한으로는 수익이 조회되지 않습니다.</div>
            )}
          </div>
          <div className="mb-4 rounded-[14px] border border-[#262626] bg-[#161616] px-[18px] py-4">
            <div className="mb-3.5 flex items-center gap-[7px] text-[13px] font-bold"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#5e9bff" strokeWidth={2}><path d="M3 3v18h18M7 14l4-4 3 3 5-6" /></svg>일별 조회수 추세 (90일)<span className="text-[11px] font-normal text-[#707070]">· YouTube 실제 일별 조회수</span></div>
            <div className="h-[180px]">
              {line ? (
                <svg width="100%" height="100%" viewBox="0 0 300 100" preserveAspectRatio="none" className="block">
                  <polygon points={`0,96 ${line} 300,96`} fill="rgba(94,155,255,.12)" />
                  <polyline points={line} fill="none" stroke="#5e9bff" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
                </svg>
              ) : <div className="flex h-full items-center justify-center text-[12px] text-[#707070]">일별 데이터가 아직 없어요</div>}
            </div>
          </div>
          <div className="overflow-hidden rounded-[14px] border border-[#262626] bg-[#161616]">
            <div className="flex flex-wrap items-center gap-2.5 border-b border-[#232323] px-4 py-3">
              <span className="text-[13px] font-bold">영상</span><span className="flex-1" />
              <div className="flex gap-0.5 rounded-[9px] border border-[#232323] bg-[#0e0e0e] p-[3px]">{kinds.map(([k, l]) => (<button key={k} onClick={() => setKind(k)} className="flex items-center gap-[5px] rounded-[7px] px-[11px] py-1.5 text-[12px] font-semibold" style={kind === k ? { background: "#232323", color: "#e5e5e5" } : { color: "#9a9a9a" }}>{l}<span className="mono text-[10px] opacity-70">{kindCount[k]}</span></button>))}</div>
              <div className="flex gap-0.5 rounded-[9px] border border-[#232323] bg-[#0e0e0e] p-[3px]">{([["recent", "최신순"], ["views", "조회수순"], ["comments", "댓글순"]] as [string, string][]).map(([k, l]) => (<button key={k} onClick={() => setSort(k)} className="rounded-[7px] px-[11px] py-1.5 text-[12px] font-semibold" style={sort === k ? { background: "#232323", color: "#e5e5e5" } : { color: "#9a9a9a" }}>{l}</button>))}</div>
            </div>
            {vlist.length === 0 ? (
              <div className="py-12 text-center text-[12.5px] text-[#707070]">영상이 없어요 — <b className="text-[#8b93ff]">YouTube 동기화</b>를 눌러 가져오세요.</div>
            ) : (
              <div className="grid gap-2 p-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
                {vlist.map((v, i) => (
                  <div key={v.id} className="flex gap-2.5 rounded-[10px] border border-[#232323] bg-[#161616] p-[9px]">
                    <div className="relative h-[50px] w-[88px] flex-none rounded-[6px] bg-cover bg-center" style={v.thumbnail ? { backgroundImage: `url(${v.thumbnail})` } : { background: THUMBS[i % THUMBS.length] }}>{v.isShort && <span className="absolute bottom-[3px] right-[3px] rounded-[3px] bg-black/70 px-1 py-px text-[8.5px] font-bold text-white">쇼츠</span>}</div>
                    <div className="min-w-0 flex-1"><div className="line-clamp-2 text-[12px] font-semibold leading-[1.35] [text-wrap:pretty]">{v.title}</div><div className="mt-1 flex gap-[9px] text-[10.5px] text-[#707070]"><span>▶ {fmtN(v.viewCount)}</span><span>♥ {fmtN(v.likeCount)}</span><span>💬 {fmtN(v.commentCount)}</span></div></div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ─────────── PUBLISH CHANNELS ─────────── */
export const PLATFORMS = [{ key: "smr", name: "네이버 SMR", c: "#34d399", metric: "배급 채널", desc: "제휴 배급 (드라마·예능)" }, { key: "youtube", name: "YouTube", c: "#ff6b78", metric: "구독", desc: "쇼츠·롱폼 채널" }, { key: "meta", name: "Meta Reels", c: "#5e9bff", metric: "팔로워", desc: "인스타·페이스북 릴스" }];
export const CHANNELS = [
  { plat: "smr", handle: "솔로천국 시즌4", count: "제휴", progs: ["솔로천국 시즌4"], ok: true },
  { plat: "smr", handle: "트롯 대잔치", count: "제휴", progs: ["트롯 대잔치"], ok: true },
  { plat: "smr", handle: "환승로그", count: "제휴", progs: ["환승로그"], ok: true },
  { plat: "youtube", handle: "@soletv_shorts", count: "128K", progs: ["솔로천국 시즌4"], ok: true },
  { plat: "youtube", handle: "@trot_daejanchi", count: "312K", progs: ["트롯 대잔치"], ok: true },
  { plat: "youtube", handle: "@stepd_clips", count: "54K", progs: ["솔로천국 시즌4", "환승로그"], ok: true },
  { plat: "youtube", handle: "@simya_docu", count: "22K", progs: ["심야 다큐"], ok: false },
  { plat: "meta", handle: "@sole.tv", count: "54K", progs: ["솔로천국 시즌4"], ok: true },
  { plat: "meta", handle: "@stepd.reels", count: "38K", progs: ["환승로그", "심야 다큐"], ok: false },
];
const EXPORT_PRESETS = [
  { name: "YouTube Shorts 기본", spec: "9:16 크롭 · H.264 · 자막 번인 · 1080p" },
  { name: "Meta Reels", spec: "9:16 레터박스 · H.264 · 자막 번인 · 1080p" },
  { name: "네이버 SMR 납품", spec: "16:9 · H.264 · 무자막 · 1080p" },
];
export function Channels({ onRegister }: { onRegister: () => void }) {
  const [channels, setChannels] = useState<YouTubeChannelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    fetchYouTubeChannels().then((c) => { if (alive) { setChannels(c); setLoading(false); } }).catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);
  return (
    <div className="max-w-[1160px] px-[30px] py-[26px]">
      <Eyebrow kicker={`연동 채널 관리 · ${channels.length}개 연결`} title="배포채널" desc="YouTube 채널을 연동해 분석·배포처로 관리해요." action={<PrimaryBtn onClick={onRegister}>{Plus}채널 등록</PrimaryBtn>} />
      {loading ? (
        <div className="mb-[26px] py-16 text-center text-[13px] text-[#707070]">불러오는 중…</div>
      ) : channels.length === 0 ? (
        <div className="mb-[26px] rounded-[14px] border border-dashed border-[#2b2b2b] py-16 text-center"><div className="text-[14px] font-semibold text-[#cfcfcf]">연동된 채널이 없어요</div><div className="mt-1.5 text-[12.5px] text-[#707070]"><b className="text-[#8b93ff]">채널 등록</b>으로 YouTube 채널을 연결하세요.</div></div>
      ) : (
        <div className="mb-[26px] flex flex-col gap-5">
          <div>
            <div className="mb-[11px] flex items-center gap-[9px]"><span className="size-[11px] rounded-[3px] bg-[#ff6b78]" /><span className="text-[15px] font-bold tracking-[-.3px]">YouTube</span><span className="text-[11.5px] font-semibold text-[#707070]">{channels.length}개 채널</span></div>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
              {channels.map((ch) => {
                const ok = !ch.lastError;
                return (
                  <div key={ch.channelId} className="rounded-[13px] border border-[#262626] bg-[#161616] px-4 py-[15px]">
                    <div className="mb-2.5 flex items-center gap-2">
                      {ch.thumbnail && <img src={ch.thumbnail} alt="" className="size-6 rounded-full" />}
                      <span className="truncate text-[13.5px] font-bold tracking-[-.2px]">{ch.channelName}</span><span className="flex-1" />
                      <span className="rounded-full px-[9px] py-[3px] text-[10.5px] font-bold" style={ok ? { color: "#34d399", background: "rgba(52,211,153,.12)" } : { color: "#fbbf24", background: "rgba(251,191,36,.12)" }}>{ok ? "연결됨" : "재인증 필요"}</span>
                    </div>
                    <div className="text-[11.5px] text-[#9a9a9a]"><span className="grotesk text-[14px] font-bold text-[#eceef2]">{ch.subscribers ?? "—"}</span> 구독</div>
                    <div className="mt-[11px] flex flex-wrap gap-1.5 border-t border-[#232323] pt-[11px]">
                      {ch.hasMonetaryScope && <span className="rounded-[6px] bg-[rgba(52,211,153,.1)] px-2 py-0.5 text-[10px] font-semibold text-[#34d399]">수익 연동</span>}
                      {ch.email && <span className="truncate rounded-[6px] bg-[#0e0e0e] px-2 py-0.5 text-[10px] text-[#707070]">{ch.email}</span>}
                    </div>
                    {ch.lastError && <div className="mt-2 text-[11px] text-[#ff6b78]">{ch.lastError}</div>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
      <div className="mb-3 text-[14px] font-bold">익스포트 프리셋</div>
      <div className="overflow-hidden rounded-[12px] border border-[#262626]">
        {EXPORT_PRESETS.map((p) => (<div key={p.name} className="flex items-center gap-3 border-b border-[#1f1f1f] bg-[#161616] px-4 py-[13px]"><span className="size-2 rounded-full bg-[#8b93ff]" /><span className="flex-1 text-[13px] font-semibold">{p.name}</span><span className="mono text-[11.5px] text-[#9a9a9a]">{p.spec}</span></div>))}
      </div>
    </div>
  );
}

/* ─────────── OPS (real) ─────────── */
const OJST: Record<string, { l: string; c: string }> = { done: { l: "완료", c: "#34d399" }, running: { l: "실행중", c: "#8b93ff" }, failed: { l: "실패", c: "#ff6b78" }, pending: { l: "대기", c: "#9a9a9a" } };
export function Ops() {
  const [jobs, setJobs] = useState<OpsJob[]>([]);
  const [stats, setStats] = useState<{ pending: number; running: number; done: number; failed: number } | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    fetchOpsJobs(80).then((d) => { if (alive) { setJobs(d.jobs); setStats(d.stats); setLoading(false); } }).catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);
  const tiles: [string, number, string][] = stats ? [["실행중", stats.running, "#8b93ff"], ["대기", stats.pending, "#9a9a9a"], ["실패", stats.failed, "#ff6b78"], ["완료", stats.done, "#34d399"]] : [];
  return (
    <div className="max-w-[1000px] px-[30px] py-[26px]">
      <Eyebrow kicker="파이프라인 상태" title="운영·진단" />
      {loading ? (
        <div className="py-16 text-center text-[13px] text-[#707070]">불러오는 중…</div>
      ) : (
        <>
          <div className="mb-4 grid gap-3.5 [grid-template-columns:repeat(4,1fr)]">
            {tiles.map(([l, v, c]) => (
              <div key={l} className="rounded-[12px] border border-[#262626] bg-[#161616] px-4 py-3.5"><div className="mb-1.5 text-[11.5px] font-semibold text-[#707070]">{l}</div><div className="grotesk text-[24px] font-bold" style={{ color: c }}>{v}</div></div>
            ))}
          </div>
          <div className="mb-3 text-[14px] font-bold">잡 큐 (최근)</div>
          <div className="overflow-hidden rounded-[12px] border border-[#262626]">
            <div className="grid grid-cols-[110px_1fr_70px_80px] border-b border-[#262626] bg-[#161616] text-[11px] font-bold text-[#9a9a9a]"><div className="px-3.5 py-[11px]">작업</div><div className="px-2 py-[11px]">대상</div><div className="px-2 py-[11px] text-right">시도</div><div className="px-3.5 py-[11px] text-right">상태</div></div>
            {jobs.length === 0 ? (
              <div className="bg-[#161616] py-10 text-center text-[12.5px] text-[#707070]">큐에 잡이 없어요.</div>
            ) : jobs.map((j) => {
              const t = OJST[j.status] ?? OJST.pending;
              const target = String(j.payload?.mediaId ?? j.payload?.episodeId ?? j.payload?.channelId ?? j.payload?.videoId ?? "—");
              return (
                <div key={j.id} className="grid grid-cols-[110px_1fr_70px_80px] items-center border-b border-[#1f1f1f] bg-[#161616]" title={j.error ?? undefined}>
                  <div className="px-3.5 py-[11px] text-[12.5px] font-semibold">{j.type}</div>
                  <div className="mono truncate px-2 py-[11px] text-[11.5px] text-[#cfcfcf]">{target}</div>
                  <div className="mono px-2 py-[11px] text-right text-[11.5px] text-[#9a9a9a]">{j.attempts}/{j.maxAttempts}</div>
                  <div className="flex items-center justify-end gap-1.5 px-3.5 py-[11px]"><span className="size-[7px] flex-none rounded-full" style={{ background: t.c }} /><span className="text-[11px] font-bold" style={{ color: t.c }}>{t.l}</span></div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
