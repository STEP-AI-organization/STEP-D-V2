"use client";

/**
 * STEP D Review OS — React port of the Claude Design prototype.
 *
 * The prototype shipped as a self-contained DCLogic HTML doc; this reproduces it
 * with real React (our stack is Next/React already), faithful to the exact
 * palette/spacing via Tailwind arbitrary values + inline styles for dynamic bits.
 * Standalone full-screen route (no AppShell) at /os while the port is completed.
 *
 * Ported so far: shell · 콘텐츠(라이브러리) · 대시보드 · 검수 워크스페이스
 * (타임라인 레인 + 인스펙터 · 클립 · PPL · 성과). Remaining screens/modals/editor
 * render a "포팅 중" placeholder.
 */
import { useState, useRef, useCallback } from "react";
import { Programs, GlobalClips, Distribution, Analytics, Trends, Channels, Ops } from "./screens";

/* ─────────────────────────── data ─────────────────────────── */
type Screen =
  | "dashboard" | "programs" | "library" | "review" | "clips"
  | "dist" | "analytics" | "trends" | "channels" | "ops";

const TOTAL = 4350;
const THUMBS = [
  "linear-gradient(160deg,#2b2620,#17140f)",
  "linear-gradient(160deg,#26253a,#15141d)",
  "linear-gradient(160deg,#1f2b28,#131917)",
  "linear-gradient(160deg,#2b2226,#171215)",
  "linear-gradient(160deg,#222b34,#13181e)",
];

type Video = {
  id: string; prog: string; ep: string; dur: string; uploaded: string; thumb: number;
  ok: boolean; shorts?: number; ppl?: number; issues?: number; analyzing?: boolean;
  pct?: number; failed?: boolean; status: { l: string; c: string; bg: string };
};
const VIDEOS: Video[] = [
  { id: "v1", prog: "솔로천국 시즌4", ep: "8화", dur: "72:30", uploaded: "2시간 전", thumb: 1, ok: true, shorts: 8, ppl: 4, issues: 4, status: { l: "추천 검토 대기", c: "#8b93ff", bg: "rgba(139,147,255,.15)" } },
  { id: "v4", prog: "환승로그", ep: "5화", dur: "54:08", uploaded: "5시간 전", thumb: 3, ok: true, shorts: 9, ppl: 3, issues: 2, status: { l: "확정 대기", c: "#fbbf24", bg: "rgba(251,191,36,.14)" } },
  { id: "v7", prog: "심야 다큐", ep: "2화", dur: "48:15", uploaded: "20분 전", thumb: 4, ok: false, analyzing: true, pct: 62, status: { l: "분석 중 62%", c: "#fbbf24", bg: "rgba(251,191,36,.14)" } },
  { id: "v6", prog: "심야 다큐", ep: "3화", dur: "—", uploaded: "12분 전", thumb: 4, ok: false, failed: true, status: { l: "분석 실패", c: "#ff6b78", bg: "rgba(248,113,113,.14)" } },
  { id: "v2", prog: "솔로천국 시즌4", ep: "7화", dur: "70:12", uploaded: "어제", thumb: 1, ok: true, shorts: 8, ppl: 5, issues: 3, status: { l: "배포 완료", c: "#34d399", bg: "rgba(52,211,153,.13)" } },
  { id: "v8", prog: "트롯 대잔치", ep: "12화", dur: "88:50", uploaded: "1일 전", thumb: 2, ok: true, shorts: 11, ppl: 6, issues: 5, status: { l: "배포 완료", c: "#34d399", bg: "rgba(52,211,153,.13)" } },
  { id: "v3", prog: "솔로천국 시즌4", ep: "6화", dur: "68:40", uploaded: "3일 전", thumb: 1, ok: true, shorts: 7, ppl: 4, issues: 3, status: { l: "배포 완료", c: "#34d399", bg: "rgba(52,211,153,.13)" } },
  { id: "v9", prog: "트롯 대잔치", ep: "11화", dur: "85:30", uploaded: "6일 전", thumb: 2, ok: true, shorts: 10, ppl: 5, issues: 4, status: { l: "배포 완료", c: "#34d399", bg: "rgba(52,211,153,.13)" } },
];
const PROGRAMS = ["전체", "솔로천국 시즌4", "환승로그", "심야 다큐", "트롯 대잔치"];

type Lane = { key: string; label: string; color: string };
const LANES: Lane[] = [
  { key: "shorts", label: "쇼츠 후보", color: "#8b7cf6" },
  { key: "ppl", label: "PPL·브랜드", color: "#f5a524" },
  { key: "silence", label: "무음 구간", color: "#7f8a9c" },
  { key: "issue", label: "개인정보·QC", color: "#ff6b78" },
  { key: "audio", label: "음량 피크", color: "#ff9f4c" },
];
type Item = {
  id: string; lane: string; t0: number; t1: number; title: string;
  rank?: number; score?: number; hook?: string; signal?: string; exp?: number;
  brand?: string; save?: number; level?: string; kind?: string;
};
const ITEMS: Item[] = [
  { id: "s1", lane: "shorts", t0: 305, t1: 332, title: "오프닝 자기소개 중 빵 터진 순간", rank: 4, score: 84, hook: '"제 이름은요, 사실 어제 급하게…"' },
  { id: "s2", lane: "shorts", t0: 612, t1: 657, title: '"나 진짜 오빠 없으면 안 될 것 같아" — 영숙 폭탄 고백', rank: 1, score: 94, hook: "회차 최고 화제 구간" },
  { id: "s3", lane: "shorts", t0: 1840, t1: 1878, title: "삼각관계 정면돌파 — 광수의 3초 정적", rank: 2, score: 91, hook: "정적 임팩트" },
  { id: "s4", lane: "shorts", t0: 2470, t1: 2523, title: "새 남자 등장에 술렁 — 첫 등장 슬로우", rank: 3, score: 88, hook: "등장 이벤트" },
  { id: "s5", lane: "shorts", t0: 3120, t1: 3162, title: "데이트권 쟁탈 — 반전 결과 발표", rank: 5, score: 82, hook: "긴장 고조" },
  { id: "s6", lane: "shorts", t0: 4010, t1: 4052, title: "밤샘 대화, 눈물 클로즈업", rank: 6, score: 79, hook: "감정 피크" },
  { id: "p1", lane: "ppl", t0: 300, t1: 345, title: "의류 브랜드 로고", signal: "로고", exp: 45, brand: "브랜드 A (의류)" },
  { id: "p2", lane: "ppl", t0: 1450, t1: 1485, title: "카페 브랜드 음성 언급", signal: "음성", exp: 35, brand: "브랜드 B (카페)" },
  { id: "p3", lane: "ppl", t0: 3092, t1: 3128, title: "스마트폰 제품 클로즈업", signal: "로고+음성", exp: 36, brand: "브랜드 C (전자)" },
  { id: "p4", lane: "ppl", t0: 3820, t1: 3842, title: "음료 브랜드 음성 언급", signal: "음성", exp: 22, brand: "브랜드 D (음료)" },
  { id: "sl1", lane: "silence", t0: 432, t1: 439, title: "무음 구간 7초", save: 7, level: "긴" },
  { id: "sl2", lane: "silence", t0: 2120, t1: 2125, title: "무음 구간 5초", save: 5, level: "중" },
  { id: "sl3", lane: "silence", t0: 3483, t1: 3492, title: "무음 구간 9초", save: 9, level: "긴" },
  { id: "i1", lane: "issue", t0: 344, t1: 356, title: "개인정보 노출 의심 — 전화번호 자막", kind: "개인정보" },
  { id: "i2", lane: "issue", t0: 2415, t1: 2427, title: "경쟁사 로고 노출", kind: "경쟁사" },
  { id: "i3", lane: "issue", t0: 1210, t1: 1222, title: "얼굴 미동의 출연자 노출 가능성", kind: "초상권" },
  { id: "i4", lane: "issue", t0: 3650, t1: 3662, title: "상표권 텍스트 노출", kind: "상표" },
  { id: "a1", lane: "audio", t0: 662, t1: 674, title: "음량 피크 경고 (클리핑)" },
  { id: "a2", lane: "audio", t0: 1850, t1: 1862, title: "급격한 음량 변화" },
];

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const hex2rgba = (h: string, a: number) => {
  const n = parseInt(h.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
const laneOf = (k: string) => LANES.find((l) => l.key === k)!;

type NavDef = { key: Screen; label: string; icon: React.ReactNode; badge?: string };
const IC = (d: React.ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>{d}</svg>
);
const NAV: NavDef[] = [
  { key: "dashboard", label: "대시보드", icon: IC(<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>) },
  { key: "programs", label: "프로그램", icon: IC(<path d="M2 7l4-4h5l3 3h8v13a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z" />) },
  { key: "library", label: "콘텐츠", icon: IC(<><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M10 9l5 3-5 3z" /></>), badge: "8" },
  { key: "clips", label: "클립", icon: IC(<><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M7 3v18M17 3v18" /></>) },
  { key: "dist", label: "배포현황", icon: IC(<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" />) },
  { key: "analytics", label: "성과", icon: IC(<path d="M3 3v18h18M7 14l4-4 3 3 5-6" />) },
  { key: "trends", label: "채널 트렌드", icon: IC(<path d="M3 17l6-6 4 4 8-8" />) },
  { key: "channels", label: "배포채널", icon: IC(<><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1l2-1.6-2-3.4-2.4 1a7 7 0 0 0-1.7-1L14.5 2h-5l-.4 2.6a7 7 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 1.7 1l.4 2.6h5l.4-2.6a7 7 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6a7 7 0 0 0 .1-1z" /></>) },
  { key: "ops", label: "운영·진단", icon: IC(<path d="M22 12h-4l-3 9L9 3l-3 9H2" />) },
];
const CRUMB_ROOT: Record<Screen, string> = {
  dashboard: "대시보드", programs: "프로그램", library: "콘텐츠", review: "콘텐츠",
  clips: "클립", dist: "배포현황", analytics: "성과", trends: "채널 트렌드",
  channels: "배포채널", ops: "운영·진단",
};

const PSTAGES: [string, string, "done" | "current" | "idle"][] = [
  ["source", "소스", "done"], ["merge", "병합", "done"], ["split", "분할", "done"],
  ["analyze", "분석", "done"], ["recommend", "추천", "current"], ["edit", "편집", "idle"],
  ["encode", "인코딩", "idle"], ["publish", "배포", "idle"],
];
const TABS: { key: string; label: string }[] = [
  { key: "timeline", label: "타임라인" }, { key: "clips", label: "클립" },
  { key: "ppl", label: "PPL 리포트" }, { key: "perf", label: "성과" },
];

/* ─────────────────────────── component ─────────────────────────── */
type Flags = Record<string, boolean>;

export default function ReviewOsPage() {
  const [screen, setScreen] = useState<Screen>("library");
  const [lib, setLib] = useState("전체");
  const [video, setVideo] = useState<Video | null>(null);
  const [tab, setTab] = useState("timeline");
  const [sel, setSel] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(612);
  const [lanesOff, setLanesOff] = useState<Flags>({});
  const [adopted, setAdopted] = useState<Flags>({});
  const [cut, setCut] = useState<Flags>({});
  const [resolved, setResolved] = useState<Flags>({});
  const [pplOut, setPplOut] = useState<Flags>({});
  const [clipRender, setClipRender] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);
  const tRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((m: string) => {
    setToast(m);
    if (tRef.current) clearTimeout(tRef.current);
    tRef.current = setTimeout(() => setToast(null), 2200);
  }, []);

  function pickVideo(v: Video) {
    if (!v.ok) { flash(v.failed ? "분석 실패 — 재업로드 필요" : "분석 진행 중… 완료 후 열려요"); return; }
    setVideo(v); setScreen("review"); setTab("timeline"); setSel(null); setPlayhead(612);
  }

  const v = video ?? VIDEOS[0];
  const playPct = `${(playhead / TOTAL) * 100}%`;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0a0a0a] text-[14px] text-[#eceef2]">
      {/* ===== SIDEBAR ===== */}
      <aside className="flex w-[230px] flex-none flex-col border-r border-[#232323] bg-[#131313] p-4 px-3">
        <div className="flex items-center gap-2.5 px-2 pb-[18px] pt-1.5">
          <div className="grotesk flex size-[30px] items-center justify-center rounded-[9px] bg-[linear-gradient(135deg,#8b93ff,#5a63e6)] text-[15px] font-bold text-white">D</div>
          <div>
            <div className="grotesk text-[15px] font-bold tracking-[-.3px]">STEP D</div>
            <div className="mt-px text-[10.5px] text-[#707070]">Media Production OS</div>
          </div>
        </div>
        <nav className="flex flex-col gap-0.5">
          {NAV.map((n) => {
            const active = screen === n.key || (n.key === "library" && screen === "review");
            return (
              <button key={n.key} onClick={() => { setScreen(n.key); setSel(null); }}
                className={`flex items-center gap-[11px] rounded-[9px] px-2.5 py-2 text-[13.5px] transition-colors ${active ? "bg-[rgba(139,147,255,.1)] font-semibold text-[#eceef2]" : "font-medium text-[#a6a6a6] hover:bg-[#1e1e1e] hover:text-[#eceef2]"}`}>
                <span className="flex w-4" style={{ color: active ? "#8b93ff" : "#707070" }}>{n.icon}</span>
                <span className="flex-1 text-left">{n.label}</span>
                {active && n.badge && <span className="rounded-md bg-[#6b74f0] px-[7px] py-px text-[11px] font-bold text-white">{n.badge}</span>}
              </button>
            );
          })}
        </nav>
        <div className="mt-auto rounded-[11px] border border-[#232323] p-3">
          <div className="mb-2 text-[11px] font-semibold text-[#707070]">이번 주 처리량</div>
          <div className="flex items-baseline gap-1.5"><span className="grotesk text-[22px] font-bold text-[#eceef2]">18min</span><span className="text-[11px] text-[#707070]">/ 원본당 검수</span></div>
          <div className="mt-[3px] text-[11px] font-semibold text-[#34d399]">▾ 2시간 → 20분 이하</div>
        </div>
        <div className="mt-2.5 flex items-center gap-2.5 border-t border-[#232323] px-1.5 pb-0.5 pt-2.5">
          <div className="flex size-7 items-center justify-center rounded-full bg-[#232323] text-[12px] font-semibold text-[#a6a6a6]">운</div>
          <div className="flex-1"><div className="text-[12.5px] font-semibold">김운영</div><div className="text-[10.5px] text-[#707070]">STEP D · admin</div></div>
        </div>
      </aside>

      {/* ===== MAIN ===== */}
      <main className="flex min-w-0 flex-1 flex-col bg-[#0a0a0a]">
        <header className="flex h-[54px] flex-none items-center gap-3.5 border-b border-[#232323] px-[22px]">
          <div className="flex items-center gap-2 text-[13px] text-[#9a9a9a]">
            <span>{CRUMB_ROOT[screen]}</span>
            {screen === "review" && (<><span className="text-[#3a3a3a]">/</span><span className="font-semibold text-[#eceef2]">{v.prog} · {v.ep}</span></>)}
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-2 rounded-full border border-[#232323] bg-[#161616] px-3 py-1.5 text-[12px] text-[#9a9a9a]"><span className="size-[7px] rounded-full bg-[#34d399]" />분석 워커 4대 · 큐 2</div>
          <button onClick={() => flash("원본 업로드 (데모)")} className="flex items-center gap-[7px] rounded-[9px] bg-[#6b74f0] px-[15px] py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[#5a63e6]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}><path d="M12 5v14M5 12h14" /></svg>원본 업로드
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto">
          {screen === "library" && <Library lib={lib} setLib={setLib} onOpen={pickVideo} />}
          {screen === "dashboard" && <Dashboard onOpen={(id) => { const vid = VIDEOS.find((x) => x.id === id); if (vid) pickVideo(vid); }} goLibrary={() => setScreen("library")} />}
          {screen === "review" && (
            <Review
              v={v} tab={tab} setTab={(t) => { setTab(t); setSel(null); }} sel={sel} setSel={setSel}
              playhead={playhead} setPlayhead={setPlayhead} playPct={playPct}
              lanesOff={lanesOff} toggleLane={(k) => setLanesOff((s) => ({ ...s, [k]: !s[k] }))}
              adopted={adopted} setAdopted={setAdopted} cut={cut} setCut={setCut}
              resolved={resolved} setResolved={setResolved} pplOut={pplOut} setPplOut={setPplOut}
              clipRender={clipRender} setClipRender={setClipRender} flash={flash} back={() => setScreen("library")}
            />
          )}
          {screen === "programs" && <Programs flash={flash} onOpenProgram={(t) => { setLib(t); setScreen("library"); }} />}
          {screen === "clips" && <GlobalClips flash={flash} />}
          {screen === "dist" && <Distribution flash={flash} />}
          {screen === "analytics" && <Analytics />}
          {screen === "trends" && <Trends />}
          {screen === "channels" && <Channels flash={flash} />}
          {screen === "ops" && <Ops />}
        </div>
      </main>

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-[9px] rounded-[10px] border border-[#333333] bg-[#1a1e26] px-[18px] py-[11px] text-[13px] font-semibold text-[#eceef2] shadow-[0_12px_30px_rgba(0,0,0,.35)]">
          <span className="size-2 rounded-full bg-[#8b93ff]" />{toast}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────── LIBRARY ─────────────────────────── */
function Library({ lib, setLib, onOpen }: { lib: string; setLib: (s: string) => void; onOpen: (v: Video) => void }) {
  const videos = VIDEOS.filter((v) => lib === "전체" || v.prog === lib);
  return (
    <div className="max-w-[1320px] px-[30px] py-[26px]">
      <div className="mb-[7px] text-[13.5px] font-semibold text-[#8b93ff]">소스 영상 라이브러리</div>
      <h1 className="grotesk mb-2 text-[25px] font-bold tracking-[-.5px]">콘텐츠</h1>
      <p className="mb-[22px] text-[13px] text-[#9a9a9a]">원본을 올리면 AI가 <b className="text-[#eceef2]">영상의 모든 정보를 시간축 데이터로 구조화</b>합니다. 영상을 누르면 검수 워크스페이스가 열려요.</p>
      <div className="mb-[22px] flex items-center gap-[9px]">
        <span className="text-[12px] font-semibold text-[#707070]">프로그램</span>
        <select value={lib} onChange={(e) => setLib(e.target.value)} className="min-w-[200px] cursor-pointer rounded-[9px] border border-[#2b2b2b] bg-[#161616] px-3 py-2 text-[12.5px] font-semibold text-[#e5e5e5]">
          {PROGRAMS.map((p) => (<option key={p} value={p}>{p === "전체" ? "전체 프로그램" : p}</option>))}
        </select>
      </div>
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
        {videos.map((v) => (
          <button key={v.id} onClick={() => onOpen(v)} style={{ opacity: v.ok ? 1 : 0.62 }}
            className="cursor-pointer overflow-hidden rounded-[14px] border border-[#262626] bg-[#161616] text-left text-inherit transition-[transform,border-color] duration-100 hover:-translate-y-0.5 hover:border-[#3a3a3a]">
            <div className="relative aspect-video w-full" style={{ background: THUMBS[v.thumb] }}>
              <span className="absolute left-[9px] top-[9px] rounded-full bg-black/45 px-[9px] py-[3px] text-[10.5px] font-semibold text-white backdrop-blur-[4px]">{v.prog}</span>
              <span className="absolute right-[9px] top-[9px] rounded-full px-[9px] py-[3px] text-[10.5px] font-bold backdrop-blur-[4px]" style={{ color: v.status.c, background: v.status.bg }}>{v.status.l}</span>
              <span className="mono absolute bottom-[9px] right-[9px] rounded-[5px] bg-black/60 px-[7px] py-0.5 text-[11px] font-semibold text-white">{v.dur}</span>
              <div className="absolute left-1/2 top-1/2 flex size-[46px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/[.28] bg-[rgba(10,11,15,.5)] backdrop-blur-[3px]">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff" style={{ marginLeft: 2 }}><path d="M8 5v14l11-7z" /></svg>
              </div>
            </div>
            <div className="px-[15px] pb-[15px] pt-[13px]">
              <div className="text-[15px] font-bold tracking-[-.3px]">{v.ep} <span className="text-[12.5px] font-medium text-[#707070]">· {v.prog}</span></div>
              <div className="mt-[3px] text-[11.5px] text-[#707070]">업로드 {v.uploaded}</div>
              {v.ok && (
                <div className="mt-[13px] flex gap-3 border-t border-[#232323] pt-3">
                  <Stat n={v.shorts!} label="쇼츠 후보" /><Stat n={v.ppl!} label="PPL 노출" /><Stat n={v.issues!} label="QC 이슈" />
                  <div className="ml-auto flex items-center gap-[3px] self-center text-[12px] font-semibold text-[#8b93ff]">검수<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}><path d="M5 12h14M13 6l6 6-6 6" /></svg></div>
                </div>
              )}
              {v.analyzing && <div className="mt-[13px] border-t border-[#232323] pt-3 text-[11.5px] font-semibold text-[#fbbf24]">AI 분석 진행 중 {v.pct}% · 완료 후 데이터가 채워져요</div>}
              {v.failed && <div className="mt-[13px] border-t border-[#232323] pt-3 text-[11.5px] font-semibold text-[#ff6b78]">분석 실패 · 오디오 트랙 없음 — 재업로드 필요</div>}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
function Stat({ n, label }: { n: number; label: string }) {
  return (<div><div className="grotesk text-[17px] font-bold text-[#eceef2]">{n}</div><div className="mt-px text-[10px] text-[#707070]">{label}</div></div>);
}

/* ─────────────────────────── DASHBOARD ─────────────────────────── */
const DASH_KPI = [
  { label: "이번 주 원본 처리", value: "23", unit: "건", delta: "▴ 지난주 +6", color: "#eceef2" },
  { label: "원본당 평균 검수", value: "18", unit: "분", delta: "▾ 2시간 → 20분↓", color: "#8b93ff" },
  { label: "이번 주 배포 클립", value: "147", unit: "개", delta: "▴ +31", color: "#eceef2" },
  { label: "배포 클립 총 조회", value: "2.4", unit: "M", delta: "▴ +18%", color: "#eceef2" },
];
const DASH_QUEUE = [
  { label: "심야 다큐 · 2화", stage: "분석", pct: 62, color: "#fbbf24" },
  { label: "트롯 대잔치 · 13화", stage: "분할", pct: 28, color: "#8b93ff" },
];
const DASH_ALERTS = [
  { t: "개인정보 노출 의심 4건", s: "솔로천국 S4·8화 검수 대기", c: "#ff6b78", go: "v1" },
  { t: "분석 실패 1건", s: "심야 다큐·3화 — 오디오 트랙 없음", c: "#ff6b78", go: "" },
  { t: "확정 대기 클립 9개", s: "환승로그·5화 익스포트 전", c: "#fbbf24", go: "v4" },
];
function Dashboard({ onOpen, goLibrary }: { onOpen: (id: string) => void; goLibrary: () => void }) {
  const review = VIDEOS.filter((x) => x.ok && (x.status.l.includes("검토") || x.status.l.includes("확정")));
  return (
    <div className="max-w-[1320px] px-[30px] py-[26px]">
      <div className="mb-[7px] text-[13.5px] font-semibold text-[#8b93ff]">이번 주 미디어 운영</div>
      <h1 className="grotesk mb-5 text-[25px] font-bold tracking-[-.5px]">대시보드</h1>
      <div className="mb-5 grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(210px,1fr))]">
        {DASH_KPI.map((k) => (
          <div key={k.label} className="rounded-[14px] border border-[#262626] bg-[#161616] px-[18px] py-4">
            <div className="mb-[9px] text-[11.5px] font-semibold text-[#707070]">{k.label}</div>
            <div className="flex items-baseline gap-1"><span className="grotesk text-[30px] font-bold tracking-[-.5px]" style={{ color: k.color }}>{k.value}</span><span className="text-[14px] font-semibold text-[#9a9a9a]">{k.unit}</span></div>
            <div className="mt-[7px] text-[11.5px] font-semibold text-[#34d399]">{k.delta}</div>
          </div>
        ))}
      </div>
      <div className="grid items-start gap-[18px] [grid-template-columns:1fr_340px]">
        <div className="rounded-[14px] border border-[#262626] bg-[#161616] px-5 py-[18px]">
          <div className="mb-3.5 flex items-center"><span className="text-[14px] font-bold">검수 대기</span><span className="flex-1" /><button onClick={goLibrary} className="text-[12.5px] font-semibold text-[#8b93ff] hover:text-[#a7adff]">전체 콘텐츠 →</button></div>
          <div className="flex flex-col gap-2.5">
            {review.map((r) => (
              <button key={r.id} onClick={() => onOpen(r.id)} className="flex items-center gap-[13px] rounded-[11px] border border-[#232323] bg-[#121212] px-3 py-[11px] text-left text-inherit transition-colors hover:border-[#3a3a3a]">
                <div className="h-11 w-[78px] flex-none rounded-[7px]" style={{ background: THUMBS[r.thumb] }} />
                <div className="min-w-0 flex-1"><div className="text-[13.5px] font-bold tracking-[-.3px]">{r.prog} · {r.ep}</div><div className="mt-0.5 text-[11.5px] text-[#707070]">원본 {r.dur} · 쇼츠 {r.shorts} · QC {r.issues} · {r.uploaded}</div></div>
                <span className="flex-none rounded-full px-[9px] py-[3px] text-[10.5px] font-bold" style={{ color: r.status.c, background: r.status.bg }}>{r.status.l}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-4">
          <div className="rounded-[14px] border border-[#262626] bg-[#161616] px-[18px] py-4">
            <div className="mb-[13px] text-[13px] font-bold">처리 큐</div>
            {DASH_QUEUE.map((q) => (
              <div key={q.label} className="mb-3">
                <div className="mb-[5px] flex justify-between text-[12px]"><span className="font-semibold text-[#cfcfcf]">{q.label}</span><span className="mono text-[#9a9a9a]">{q.stage} {q.pct}%</span></div>
                <div className="h-1.5 overflow-hidden rounded-full bg-[#0e0e0e]"><div className="h-full rounded-full" style={{ width: `${q.pct}%`, background: q.color }} /></div>
              </div>
            ))}
            <div className="mt-0.5 text-[11.5px] text-[#707070]">분석 워커 4대 가동 · 유휴 1대</div>
          </div>
          <div className="rounded-[14px] border border-[#262626] bg-[#161616] px-[18px] py-4">
            <div className="mb-[11px] text-[13px] font-bold">확인 필요</div>
            <div className="flex flex-col gap-0.5">
              {DASH_ALERTS.map((a) => (
                <button key={a.t} onClick={() => (a.go ? onOpen(a.go) : goLibrary())} className="flex items-start gap-2.5 rounded-[9px] px-2 py-[9px] text-left text-inherit hover:bg-[#1e1e1e]">
                  <span className="mt-1 size-2 flex-none rounded-full" style={{ background: a.c }} />
                  <span><span className="block text-[12.5px] font-semibold">{a.t}</span><span className="text-[11px] text-[#707070]">{a.s}</span></span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── REVIEW ─────────────────────────── */
type ReviewProps = {
  v: Video; tab: string; setTab: (t: string) => void; sel: string | null; setSel: (s: string | null) => void;
  playhead: number; setPlayhead: (n: number) => void; playPct: string;
  lanesOff: Flags; toggleLane: (k: string) => void;
  adopted: Flags; setAdopted: React.Dispatch<React.SetStateAction<Flags>>;
  cut: Flags; setCut: React.Dispatch<React.SetStateAction<Flags>>;
  resolved: Flags; setResolved: React.Dispatch<React.SetStateAction<Flags>>;
  pplOut: Flags; setPplOut: React.Dispatch<React.SetStateAction<Flags>>;
  clipRender: Record<string, string>; setClipRender: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  flash: (m: string) => void; back: () => void;
};
function Review(p: ReviewProps) {
  const { v, tab, sel, setSel, playhead, setPlayhead, playPct, lanesOff } = p;
  const adoptedN = ITEMS.filter((x) => x.lane === "shorts" && p.adopted[x.id]).length;
  const ticks = [0, 900, 1800, 2700, 3600, 4350];

  return (
    <div className="px-6 pb-[26px] pt-[18px]">
      <button onClick={p.back} className="mb-2.5 inline-flex items-center gap-1 text-[12px] text-[#707070] hover:text-[#eceef2]">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}><path d="M15 6l-6 6 6 6" /></svg>콘텐츠
      </button>
      <div className="mb-4 flex items-end gap-3.5">
        <div><h1 className="grotesk text-[22px] font-bold tracking-[-.4px]">{v.prog} · {v.ep}</h1><div className="mt-[3px] text-[12px] text-[#707070]">원본 {v.dur} · 업로드 {v.uploaded}</div></div>
        <span className="flex-1" />
        <span className="rounded-full border border-[rgba(139,147,255,.28)] bg-[rgba(139,147,255,.12)] px-3 py-[5px] text-[12px] font-semibold text-[#8b93ff]">추천 검토 단계</span>
      </div>

      {/* pipeline strip */}
      <div className="mb-5 flex items-center gap-0 overflow-x-auto rounded-[12px] border border-[#232323] bg-[#161616] px-[18px] py-3.5">
        {PSTAGES.map(([, label, st], i) => (
          <div key={label} className="flex flex-none items-center">
            <div className="flex min-w-[52px] flex-col items-center gap-1.5">
              <div className="flex size-[26px] items-center justify-center rounded-full" style={st === "done" ? { background: "rgba(52,211,153,.15)", border: "1px solid rgba(52,211,153,.4)", color: "#34d399" } : st === "current" ? { background: "#6b74f0", color: "#fff" } : { background: "#161616", border: "1px solid #2b2b2b", color: "#5a5a5a" }}>
                {st === "done" ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}><path d="M20 6L9 17l-5-5" /></svg> : <span className="text-[11px] font-bold">{i + 1}</span>}
              </div>
              <span className="text-[11px] font-semibold" style={{ color: st === "idle" ? "#5a5a5a" : st === "current" ? "#c3c8ff" : "#a6a6a6" }}>{label}</span>
            </div>
            {i < PSTAGES.length - 1 && <div className="mb-5 h-0.5 w-[26px]" style={{ background: st === "done" ? "rgba(52,211,153,.4)" : "#2b2b2b" }} />}
          </div>
        ))}
      </div>

      {/* tabs */}
      <div className="mb-[18px] flex gap-0.5 border-b border-[#232323]">
        {TABS.map((t) => {
          const a = tab === t.key;
          const count = t.key === "clips" && adoptedN ? adoptedN : null;
          return (
            <button key={t.key} onClick={() => p.setTab(t.key)} className="cursor-pointer border-b-2 px-3.5 pb-[11px] pt-3 text-[13.5px]"
              style={{ background: "none", borderColor: a ? "#8b93ff" : "transparent", color: a ? "#eceef2" : "#9a9a9a", fontWeight: a ? 700 : 500 }}>
              {t.label}{count != null && <span className="ml-1.5 rounded-md px-[7px] py-px text-[11px] font-bold" style={a ? { background: "#6b74f0", color: "#fff" } : { background: "#232323", color: "#9a9a9a" }}>{count}</span>}
            </button>
          );
        })}
      </div>

      {tab === "timeline" && (
        <div className="grid items-start gap-[18px] [grid-template-columns:1fr_340px]">
          {/* LEFT: player + timeline */}
          <div className="min-w-0">
            <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-[12px] border border-[#232323] bg-black">
              <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_30%_20%,#191d26,#050609)]" />
              <div className="absolute left-3.5 top-3 rounded-[6px] bg-black/40 px-2 py-[3px] text-[11px] font-semibold text-[#cfcfcf] backdrop-blur-[4px]">원본 프록시 스트림</div>
              <div className="relative flex size-14 items-center justify-center rounded-full border border-[rgba(139,147,255,.4)] bg-[rgba(139,147,255,.18)] backdrop-blur-[6px]"><svg width="20" height="20" viewBox="0 0 24 24" fill="#c3c8ff" style={{ marginLeft: 3 }}><path d="M8 5v14l11-7z" /></svg></div>
              <div className="mono absolute inset-x-3.5 bottom-3 flex justify-between text-[13px] text-[#e5e5e5]"><span>{fmt(playhead)}</span><span className="text-[#9a9a9a]">{fmt(TOTAL)}</span></div>
            </div>

            {/* lane chips */}
            <div className="my-2.5 mt-4 flex flex-wrap items-center gap-[9px]">
              <span className="text-[12px] text-[#9a9a9a]">AI가 이 원본을 <b className="text-[#eceef2]">시간축 데이터</b>로 구조화했어요 —</span>
              <div className="flex flex-wrap gap-1.5">
                {LANES.map((l) => {
                  const off = lanesOff[l.key]; const cnt = ITEMS.filter((x) => x.lane === l.key).length;
                  return (
                    <button key={l.key} onClick={() => p.toggleLane(l.key)} className="flex items-center gap-1.5 rounded-full px-[11px] py-[5px] text-[11.5px] font-semibold"
                      style={off ? { background: "#121212", border: "1px solid #232323", color: "#5a5a5a" } : { background: "#161616", border: "1px solid #2b2b2b", color: "#cfcfcf" }}>
                      <span className="inline-block size-2 rounded-[2px]" style={{ background: l.color, opacity: off ? 0.3 : 1 }} />{l.label} {cnt}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* timeline */}
            <div className="rounded-[12px] border border-[#232323] bg-[#161616] px-4 pb-4 pt-3.5">
              <div className="mb-2 grid grid-cols-[96px_1fr] gap-2.5"><div /><div className="mono relative h-3.5 text-[10px] text-[#6b6b6b]">{ticks.map((t) => <span key={t} className="absolute -translate-x-1/2" style={{ left: `${(t / TOTAL) * 100}%` }}>{fmt(t)}</span>)}</div></div>
              <div className="flex flex-col gap-[7px]">
                {LANES.filter((l) => !lanesOff[l.key]).map((l) => (
                  <div key={l.key} className="grid grid-cols-[96px_1fr] items-center gap-2.5">
                    <div className="flex min-w-0 items-center gap-1.5"><span className="size-2 flex-none rounded-[2px]" style={{ background: l.color }} /><span className="truncate text-[11px] font-semibold text-[#a6a6a6]">{l.label}</span></div>
                    <div className="relative h-[26px] rounded-[6px] border border-[#222222] bg-[#0e0e0e]">
                      <div className="absolute -bottom-0.5 -top-0.5 z-[3] w-0.5 bg-[#eceef2]" style={{ left: playPct }} />
                      {ITEMS.filter((x) => x.lane === l.key).map((x) => {
                        const left = (x.t0 / TOTAL) * 100; const w = Math.max(((x.t1 - x.t0) / TOTAL) * 100, 1.4);
                        const done = (l.key === "shorts" && p.adopted[x.id]) || (l.key === "silence" && p.cut[x.id]) || ((l.key === "issue" || l.key === "audio") && p.resolved[x.id]);
                        const point = l.key === "issue" || l.key === "audio"; const isSel = sel === x.id;
                        return (
                          <button key={x.id} title={x.title} onClick={() => { setSel(x.id); setPlayhead(x.t0); }}
                            className="absolute bottom-[3px] top-[3px] flex items-center justify-center rounded-[4px] text-[9.5px] font-extrabold text-[#0a0a0a]"
                            style={{ left: `${left}%`, width: point ? "9px" : `${w}%`, minWidth: point ? "9px" : l.key === "shorts" ? "20px" : "16px", background: done ? "#333333" : l.color, border: isSel ? "2px solid #fff" : "1px solid rgba(0,0,0,.35)", zIndex: isSel ? 4 : 2, opacity: done ? 0.5 : 1, boxShadow: isSel ? "0 0 0 2px rgba(255,255,255,.25)" : undefined }}>
                            {l.key === "shorts" ? String(x.rank) : done ? "✓" : ""}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* RIGHT: inspector */}
          <div className="sticky top-0">
            {sel ? <Inspector id={sel} {...p} /> : <Summary />}
          </div>
        </div>
      )}

      {tab === "clips" && <ClipsTab adopted={p.adopted} clipRender={p.clipRender} setClipRender={p.setClipRender} flash={p.flash} gotoTimeline={() => p.setTab("timeline")} />}
      {tab === "ppl" && <PplTab pplOut={p.pplOut} setPplOut={p.setPplOut} flash={p.flash} />}
      {tab === "perf" && <PerfTab />}
    </div>
  );
}

function Summary() {
  return (
    <div className="rounded-[14px] border border-[#262626] bg-[#161616] p-4">
      <div className="mb-1 text-[13px] font-bold">구조화된 데이터 요약</div>
      <div className="mb-3.5 text-[12px] leading-[1.5] text-[#707070]">타임라인의 블록을 누르면 상세와 처리 액션이 여기에 나와요.</div>
      {LANES.map((l) => (
        <div key={l.key} className="flex items-center gap-2.5 border-t border-[#232323] py-2.5">
          <span className="size-[9px] flex-none rounded-[3px]" style={{ background: l.color }} />
          <span className="flex-1 text-[12.5px] text-[#cfcfcf]">{l.label}</span>
          <span className="grotesk text-[15px] font-bold text-[#eceef2]">{ITEMS.filter((x) => x.lane === l.key).length}</span>
        </div>
      ))}
      <div className="mt-3.5 rounded-[10px] border border-[#232323] bg-[#121212] p-3">
        <div className="mb-1 text-[11px] text-[#707070]">검수 절감 (누적)</div>
        <div className="flex items-baseline gap-1.5"><span className="grotesk text-[20px] font-bold text-[#34d399]">1h 42m</span><span className="text-[11px] text-[#707070]">→ 이 원본 검수 18분</span></div>
      </div>
    </div>
  );
}

function Inspector({ id, ...p }: { id: string } & ReviewProps) {
  const item = ITEMS.find((x) => x.id === id)!;
  const col = laneOf(item.lane).color;
  const range = `${fmt(item.t0)} – ${fmt(item.t1)} · ${item.t1 - item.t0}초`;
  const done = (item.lane === "shorts" && p.adopted[id]) || (item.lane === "silence" && p.cut[id]) || ((item.lane === "issue" || item.lane === "audio") && p.resolved[id]);

  let desc = ""; let facts: { k: string; v: string | number }[] = [];
  let primaryLabel = ""; let primaryAct = () => {};
  let secondaryLabel = "구간 재생"; let secondaryAct = () => p.setPlayhead(item.t0);

  if (item.lane === "shorts") {
    desc = item.hook!; facts = [{ k: "AI 스코어", v: item.score! }, { k: "추천 순위", v: `#${item.rank}` }, { k: "경계", v: "종결어미 스냅 ✓" }];
    primaryLabel = done ? "채택됨 ✓" : "쇼츠로 채택";
    primaryAct = () => { if (done) return; p.setAdopted((s) => ({ ...s, [id]: true })); p.setClipRender((s) => ({ ...s, [id]: "draft" })); p.flash("채택 · 클립 초안 생성 (무렌더)"); };
  } else if (item.lane === "ppl") {
    const out = p.pplOut[id];
    desc = `${item.brand} — 비전·음성 이중 신호로 감지된 노출 구간이에요.`; facts = [{ k: "브랜드", v: item.brand! }, { k: "노출 시간", v: `${item.exp}초` }, { k: "신호", v: item.signal! }];
    primaryLabel = out ? "리포트에 포함하기" : "리포트에서 제외";
    primaryAct = () => { p.setPplOut((s) => ({ ...s, [id]: !s[id] })); p.flash(out ? "PPL 리포트에 포함" : "PPL 리포트에서 제외"); };
    secondaryLabel = "어필리에이트 링크"; secondaryAct = () => p.flash("어필리에이트 링크 입력 (데모)");
  } else if (item.lane === "silence") {
    desc = "발화가 없는 구간이에요. 컷을 적용하면 최종 길이가 줄어들어요."; facts = [{ k: "무음 길이", v: `${item.save}초` }, { k: "분류", v: item.level! }, { k: "컷 시 절약", v: `${item.save}초` }];
    primaryLabel = done ? "컷 적용됨 ✓" : "무음 컷 적용";
    primaryAct = () => { if (done) return; p.setCut((s) => ({ ...s, [id]: true })); p.flash(`${item.save}초 무음 컷 적용`); };
  } else if (item.lane === "issue") {
    desc = ({ 개인정보: "개인정보가 노출됐을 수 있어요. 블러를 제안합니다.", 경쟁사: "경쟁사 로고가 감지됐어요. 마스킹을 제안합니다.", 초상권: "미동의 출연자 얼굴일 수 있어요. 블러를 검토하세요.", 상표: "상표권 텍스트가 노출됐어요. 마스킹을 검토하세요." } as Record<string, string>)[item.kind!];
    facts = [{ k: "유형", v: item.kind! }, { k: "위치", v: fmt(item.t0) }, { k: "권장", v: item.kind === "경쟁사" || item.kind === "상표" ? "마스킹" : "블러" }];
    primaryLabel = done ? "처리됨 ✓" : item.kind === "경쟁사" || item.kind === "상표" ? "마스킹 제안 적용" : "블러 제안 적용";
    primaryAct = () => { if (done) return; p.setResolved((s) => ({ ...s, [id]: true })); p.flash("편집 제안으로 등록"); };
    secondaryLabel = "무시"; secondaryAct = () => { p.setResolved((s) => ({ ...s, [id]: true })); p.flash("무시 처리"); };
  } else {
    desc = "오디오 이상 구간이에요. 노멀라이즈를 제안합니다."; facts = [{ k: "유형", v: "음량 피크" }, { k: "위치", v: fmt(item.t0) }];
    primaryLabel = done ? "처리됨 ✓" : "노멀라이즈 제안";
    primaryAct = () => { if (done) return; p.setResolved((s) => ({ ...s, [id]: true })); p.flash("오디오 노멀라이즈 제안 등록"); };
    secondaryLabel = "무시"; secondaryAct = () => { p.setResolved((s) => ({ ...s, [id]: true })); p.flash("무시 처리"); };
  }

  return (
    <div className="overflow-hidden rounded-[14px] border border-[#262626] bg-[#161616]">
      <div className="h-1" style={{ background: col }} />
      <div className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <span className="rounded-[6px] px-[9px] py-[3px] text-[11px] font-bold" style={{ color: col, background: hex2rgba(col, 0.13), border: `1px solid ${hex2rgba(col, 0.32)}` }}>{laneOf(item.lane).label}</span>
          <span className="mono text-[11.5px] text-[#9a9a9a]">{range}</span>
          <span className="flex-1" />
          <button onClick={() => p.setSel(null)} className="text-[16px] leading-none text-[#707070] hover:text-[#eceef2]">✕</button>
        </div>
        <div className="mb-1.5 text-[16px] font-bold leading-[1.4] tracking-[-.3px]">{item.title}</div>
        <div className="mb-3.5 text-[12.5px] leading-[1.55] text-[#9a9a9a]">{desc}</div>
        {facts.map((f) => (<div key={f.k} className="flex justify-between gap-2.5 border-t border-[#232323] py-2 text-[12.5px]"><span className="text-[#707070]">{f.k}</span><span className="font-semibold text-[#e5e5e5]">{f.v}</span></div>))}
        <div className="mt-4 flex gap-2">
          <button onClick={primaryAct} className="flex-1 rounded-[9px] px-3.5 py-[9px] text-[12.5px] font-bold" style={done ? { background: "#1a1e26", color: "#9a9a9a" } : { background: col, color: "#0a0a0a" }}>{primaryLabel}</button>
          <button onClick={secondaryAct} className="whitespace-nowrap rounded-[9px] border border-[#333333] bg-transparent px-3.5 py-[9px] text-[12.5px] font-semibold text-[#9a9a9a] hover:border-[#3a3a3a] hover:text-[#cfcfcf]">{secondaryLabel}</button>
        </div>
      </div>
    </div>
  );
}

function ClipsTab({ adopted, clipRender, setClipRender, flash, gotoTimeline }: { adopted: Flags; clipRender: Record<string, string>; setClipRender: React.Dispatch<React.SetStateAction<Record<string, string>>>; flash: (m: string) => void; gotoTimeline: () => void }) {
  const list = ITEMS.filter((x) => x.lane === "shorts" && adopted[x.id]);
  return (
    <div className="max-w-[860px]">
      <div className="mb-3.5 flex items-center gap-2.5 rounded-[10px] border border-[rgba(139,147,255,.25)] bg-[rgba(139,147,255,.08)] px-3 py-2.5">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a7adff" strokeWidth={2}><circle cx="12" cy="12" r="10" /><path d="M12 8v5M12 16h.01" /></svg>
        <span className="text-[12.5px] text-[#c3c8ff]">프리뷰는 근사치예요. <b>확정·익스포트</b> 시 목적지 프리셋(9:16 / 자막 번인)으로 서버가 1회 렌더합니다.</span>
      </div>
      {list.length === 0 ? (
        <div className="p-[50px] text-center text-[#707070]"><div className="mb-1.5 text-[14px]">아직 채택한 클립이 없어요</div><button onClick={gotoTimeline} className="text-[13px] font-semibold text-[#8b93ff] hover:text-[#a7adff]">타임라인에서 쇼츠 후보 채택하기 →</button></div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {list.map((x) => {
            const r = clipRender[x.id] === "rendered";
            return (
              <div key={x.id} className="flex items-center gap-3.5 rounded-[12px] border border-[#262626] bg-[#161616] px-[15px] py-[13px]">
                <div className="relative h-[103px] w-[58px] flex-none rounded-[7px]" style={{ background: THUMBS[1] }}><div className="mono absolute inset-x-0 bottom-[5px] text-center text-[9px] text-[#e6e9ef]">9:16</div></div>
                <div className="min-w-0 flex-1">
                  <div className="mb-[5px] flex items-center gap-2"><span className="rounded-[5px] px-2 py-0.5 text-[11px] font-bold" style={r ? { color: "#0a0a0a", background: "#34d399" } : { color: "#c3c8ff", background: "rgba(139,147,255,.14)", border: "1px solid rgba(139,147,255,.3)" }}>{r ? "확정 · 렌더됨" : "초안"}</span><span className="mono text-[11px] text-[#707070]">{fmt(x.t0)}–{fmt(x.t1)}</span></div>
                  <div className="mb-1 text-[14px] font-bold tracking-[-.3px]">{x.title}</div>
                  <div className="text-[12px] text-[#9a9a9a]">{r ? "YouTube Shorts 프리셋 · 자막 번인 완료" : "세로 크롭·자막 근사 프리뷰"}</div>
                </div>
                <div className="flex flex-none flex-col gap-[7px]">
                  <button onClick={() => flash("편집기 v2 (데모 범위 밖)")} className="rounded-[8px] border border-[#2b2b2b] bg-[#1e1e1e] px-[15px] py-[7px] text-[12.5px] font-semibold text-[#cfcfcf] hover:border-[#3a3a3a] hover:text-[#eceef2]">편집기</button>
                  <button onClick={() => { if (r) return; setClipRender((s) => ({ ...s, [x.id]: "rendered" })); flash("서버 렌더 1회 실행 → 확정 클립"); }} className="rounded-[8px] px-[15px] py-[7px] text-[12.5px] font-bold" style={r ? { background: "#1e1e1e", border: "1px solid #2b2b2b", color: "#707070", cursor: "default" } : { background: "#6b74f0", color: "#fff" }}>{r ? "완료" : "확정·익스포트"}</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PplTab({ pplOut, setPplOut, flash }: { pplOut: Flags; setPplOut: React.Dispatch<React.SetStateAction<Flags>>; flash: (m: string) => void }) {
  const rows = ITEMS.filter((x) => x.lane === "ppl");
  const total = rows.filter((x) => !pplOut[x.id]).reduce((a, x) => a + (x.exp ?? 0), 0);
  const count = rows.filter((x) => !pplOut[x.id]).length;
  return (
    <div className="max-w-[900px]">
      <div className="mb-4 flex flex-wrap items-center gap-3.5">
        <div className="rounded-[12px] border border-[#262626] bg-[#161616] px-[18px] py-3"><div className="mb-[3px] text-[11px] text-[#707070]">총 노출 시간</div><div className="grotesk text-[22px] font-bold text-[#f5a524]">{total}초</div></div>
        <div className="rounded-[12px] border border-[#262626] bg-[#161616] px-[18px] py-3"><div className="mb-[3px] text-[11px] text-[#707070]">감지 브랜드</div><div className="grotesk text-[22px] font-bold">{count}</div></div>
        <span className="flex-1" />
        <button onClick={() => flash("PPL 리포트 CSV 내보내기 (UTF-8 BOM)")} className="flex items-center gap-[7px] rounded-[9px] border border-[#2b2b2b] bg-[#1e1e1e] px-[15px] py-[9px] text-[12.5px] font-semibold text-[#cfcfcf] hover:border-[#3a3a3a] hover:text-[#eceef2]"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>CSV 내보내기</button>
      </div>
      <div className="overflow-x-auto rounded-[12px] border border-[#262626]">
        <div className="grid min-w-min grid-cols-[minmax(140px,1.4fr)_88px_96px_minmax(110px,1fr)_88px] border-b border-[#262626] bg-[#161616] text-[11px] font-bold text-[#9a9a9a]">
          <div className="px-3.5 py-[11px]">브랜드 / 제품</div><div className="border-l border-[#232323] px-2 py-[11px] text-center">노출(초)</div><div className="border-l border-[#232323] px-2 py-[11px] text-center">신호</div><div className="border-l border-[#232323] px-2 py-[11px]">구간</div><div className="border-l border-[#232323] px-2 py-[11px] text-center">리포트</div>
        </div>
        {rows.map((x) => {
          const out = pplOut[x.id];
          return (
            <div key={x.id} className="grid min-w-min grid-cols-[minmax(140px,1.4fr)_88px_96px_minmax(110px,1fr)_88px] items-center border-b border-[#1f1f1f]" style={{ opacity: out ? 0.45 : 1 }}>
              <div className="px-3.5 py-[11px] text-[13px] font-semibold">{x.brand}</div>
              <div className="grotesk border-l border-[#1f1f1f] px-2 py-[11px] text-center text-[15px] font-bold text-[#f5a524]">{x.exp}</div>
              <div className="border-l border-[#1f1f1f] px-2 py-[11px] text-center text-[11px] text-[#cfcfcf]">{x.signal}</div>
              <div className="mono border-l border-[#1f1f1f] px-2 py-[11px] text-[11px] text-[#9a9a9a]">{fmt(x.t0)}–{fmt(x.t1)}</div>
              <div className="border-l border-[#1f1f1f] px-2 py-[11px] text-center">
                <button onClick={() => { setPplOut((s) => ({ ...s, [x.id]: !s[x.id] })); flash(out ? "PPL 리포트에 포함" : "PPL 리포트에서 제외"); }} className="rounded-[6px] px-2.5 py-1 text-[11px] font-bold" style={out ? { background: "#161616", border: "1px solid #2b2b2b", color: "#707070" } : { background: "rgba(245,165,36,.12)", border: "1px solid rgba(245,165,36,.3)", color: "#f5a524" }}>{out ? "제외됨" : "포함"}</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const PERF_CLIPS = [
  { title: "영숙 폭탄 고백", views: "182K", likes: "14.2K", comments: "1.1K", channel: "쇼츠 채널", ago: "3일 전" },
  { title: "광수 3초 정적", views: "96K", likes: "7.8K", comments: "620", channel: "쇼츠 채널", ago: "3일 전" },
  { title: "오프닝 빵터짐", views: "54K", likes: "4.1K", comments: "310", channel: "클립 채널", ago: "2일 전" },
];
function PerfTab() {
  return (
    <div className="flex max-w-[900px] flex-col gap-4">
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
        {PERF_CLIPS.map((pc) => (
          <div key={pc.title} className="rounded-[12px] border border-[#262626] bg-[#161616] px-[15px] py-3.5">
            <div className="mb-2.5 flex items-center gap-2"><span className="size-[7px] rounded-full bg-[#f87171]" /><span className="truncate text-[12.5px] font-semibold">{pc.title}</span></div>
            <div className="flex gap-3.5">
              <div><div className="grotesk text-[19px] font-bold">{pc.views}</div><div className="mt-px text-[10px] text-[#707070]">조회수</div></div>
              <div><div className="grotesk text-[19px] font-bold">{pc.likes}</div><div className="mt-px text-[10px] text-[#707070]">좋아요</div></div>
              <div><div className="grotesk text-[19px] font-bold">{pc.comments}</div><div className="mt-px text-[10px] text-[#707070]">댓글</div></div>
            </div>
            <div className="mt-[11px] text-[11px] text-[#707070]">{pc.channel} · {pc.ago}</div>
          </div>
        ))}
      </div>
      <div className="rounded-[12px] border border-[#262626] bg-[#161616] px-[18px] py-4">
        <div className="mb-3 flex items-center gap-2"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8b93ff" strokeWidth={2}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg><span className="text-[13px] font-bold">댓글 AI 요약</span><span className="text-[11px] text-[#707070]">· 게시 클립 322개 댓글</span></div>
        <div className="mb-3 flex flex-wrap gap-2">
          <span className="rounded-full border border-[rgba(52,211,153,.28)] bg-[rgba(52,211,153,.1)] px-2.5 py-[3px] text-[11px] font-semibold text-[#34d399]">긍정 78%</span>
          <span className="rounded-full border border-[rgba(251,191,36,.28)] bg-[rgba(251,191,36,.1)] px-2.5 py-[3px] text-[11px] font-semibold text-[#fbbf24]">중립 15%</span>
          <span className="rounded-full border border-[rgba(248,113,113,.28)] bg-[rgba(248,113,113,.1)] px-2.5 py-[3px] text-[11px] font-semibold text-[#f87171]">부정 7%</span>
        </div>
        <div className="text-[12.5px] leading-[1.65] text-[#cfcfcf]">시청자들은 <b className="text-[#eceef2]">영숙의 고백 장면</b>에 압도적으로 반응했고, "영숙 답장 언제 나옴?"처럼 <b className="text-[#eceef2]">다음 전개를 기대하는 댓글</b>이 많아요. 자막 가독성 호평이 반복되며, 일부는 <b className="text-[#eceef2]">풀버전 링크</b>를 요청합니다.</div>
      </div>
    </div>
  );
}
