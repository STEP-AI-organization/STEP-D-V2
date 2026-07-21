"use client";

/** STEP D Review OS — React port, remaining screens (프로그램·클립·배포현황·성과·채널
 *  트렌드·배포채널·운영). Faithful to the prototype's demo data + palette. */
import { useState } from "react";

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
const PROGDATA = [
  { id: "p1", title: "솔로천국 시즌4", section: "예능", age: 15, cast: ["영숙", "광수", "영자"], eps: 8, shorts: 64, smrReady: true, missing: [] as string[] },
  { id: "p2", title: "환승로그", section: "예능", age: 15, cast: ["지훈", "수아"], eps: 5, shorts: 24, smrReady: false, missing: ["프로그램 코드", "편성 요일"] },
  { id: "p3", title: "심야 다큐", section: "교양", age: 12, cast: [], eps: 3, shorts: 9, smrReady: false, missing: ["출연자", "편성 요일"] },
  { id: "p4", title: "트롯 대잔치", section: "뮤직", age: 0, cast: ["현숙", "영탁"], eps: 12, shorts: 120, smrReady: true, missing: [] },
];
const ageLabel = (a: number) => (a === 0 ? "전체" : `${a}세`);
export function Programs({ flash, onOpenProgram }: { flash: (m: string) => void; onOpenProgram: (t: string) => void }) {
  return (
    <div className="max-w-[1080px] px-[30px] py-[26px]">
      <Eyebrow kicker="프로그램 → 회차" title="프로그램" desc="프로그램을 먼저 등록한 뒤 원본을 업로드하면 회차·추천이 생성돼요." action={<PrimaryBtn onClick={() => flash("새 프로그램 (데모)")}>{Plus}새 프로그램</PrimaryBtn>} />
      <div className="flex flex-col gap-3">
        {PROGDATA.map((p) => {
          const cast = p.cast.length ? `출연 ${p.cast.slice(0, 3).join(", ")}${p.cast.length > 3 ? " 외" : ""}` : "출연 미등록";
          return (
            <div key={p.id} className="flex flex-wrap items-center gap-4 rounded-[14px] border border-[#262626] bg-[#161616] px-[18px] py-4">
              <div className="flex h-[68px] w-[52px] flex-none items-center justify-center rounded-[10px] border border-[#262626] bg-[linear-gradient(160deg,rgba(139,147,255,.2),rgba(139,147,255,.05))] text-[26px]">{SECTION_EMOJI[p.section] || p.title.charAt(0)}</div>
              <div className="min-w-[180px] flex-1">
                <div className="flex flex-wrap items-center gap-2"><span className="text-[16px] font-bold tracking-[-.3px]">{p.title}</span><span className="rounded-[6px] border border-[#2b2b2b] bg-[#0e0e0e] px-2 py-0.5 text-[11px] font-semibold text-[#9a9a9a]">{p.section}</span><span className="rounded-[6px] border border-[#2b2b2b] bg-[#0e0e0e] px-2 py-0.5 text-[11px] font-semibold text-[#9a9a9a]">{ageLabel(p.age)}</span></div>
                <div className="mt-[5px] text-[12px] text-[#707070]">회차 {p.eps} · 쇼츠 {p.shorts} · {cast}</div>
                <div className="mt-[9px]"><span className="inline-flex items-center gap-[5px] rounded-full px-2.5 py-[3px] text-[11px] font-bold" style={p.smrReady ? { color: "#34d399", background: "rgba(52,211,153,.12)" } : { color: "#fbbf24", background: "rgba(251,191,36,.12)" }}>{p.smrReady ? "SMR 피드 준비 완료" : `SMR 피드 ${p.missing.length || 1}개 미충족`}</span></div>
              </div>
              <div className="flex flex-none gap-2">
                <button onClick={() => onOpenProgram(p.title)} className="rounded-[9px] border border-[#2b2b2b] bg-[#1e1e1e] px-[15px] py-[9px] text-[12.5px] font-semibold text-[#cfcfcf] hover:border-[#3a3a3a] hover:text-[#e5e5e5]">회차 보기</button>
                <PrimaryBtn onClick={() => flash(`${p.title} 업로드 (데모)`)}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}><path d="M12 3v12M8 11l4-4 4 4M4 19h16" /></svg>업로드</PrimaryBtn>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─────────── GLOBAL CLIPS ─────────── */
const CLIPS = [
  { title: '"오빠 없으면 안 돼" 영숙 폭탄 고백', prog: "솔로천국 S4·8화", range: "10:12–10:57", state: "published", th: 1, views: "182K" },
  { title: "트롯 고음 하이라이트 — 소름 3단 고음", prog: "트롯 대잔치·12화", range: "22:10–22:38", state: "published", th: 1, views: "240K" },
  { title: "환승 첫 재회 — 8초 정적", prog: "환승로그·5화", range: "12:03–12:41", state: "published", th: 2, views: "77K" },
  { title: "광수의 3초 정적 — 삼각관계 정면돌파", prog: "솔로천국 S4·8화", range: "30:40–31:18", state: "confirmed", th: 0, views: "" },
  { title: "심야 인터뷰 눈물 클로즈업", prog: "심야 다큐·2화", range: "18:20–18:52", state: "confirmed", th: 3, views: "" },
  { title: "오프닝 자기소개 빵터짐", prog: "솔로천국 S4·8화", range: "05:05–05:32", state: "draft", th: 0, views: "" },
  { title: "새 남자 등장 슬로우모션", prog: "솔로천국 S4·8화", range: "41:10–42:03", state: "draft", th: 0, views: "" },
  { title: "데이트권 쟁탈 반전 결과", prog: "솔로천국 S4·8화", range: "52:00–52:42", state: "draft", th: 0, views: "" },
];
const CLIPST: Record<string, { l: string; c: string; bg: string; ln: string }> = {
  published: { l: "게시됨", c: "#34d399", bg: "rgba(52,211,153,.13)", ln: "rgba(52,211,153,.3)" },
  confirmed: { l: "확정", c: "#8b93ff", bg: "rgba(139,147,255,.13)", ln: "rgba(139,147,255,.3)" },
  draft: { l: "초안", c: "#fbbf24", bg: "rgba(251,191,36,.12)", ln: "rgba(251,191,36,.3)" },
};
const CLIP_FILTERS = ["전체", "초안", "확정", "게시됨"];
const CF_MAP: Record<string, string> = { 초안: "draft", 확정: "confirmed", 게시됨: "published" };
export function GlobalClips({ flash }: { flash: (m: string) => void }) {
  const [f, setF] = useState("전체");
  const list = CLIPS.filter((c) => f === "전체" || c.state === CF_MAP[f]);
  return (
    <div className="max-w-[1320px] px-[30px] py-[26px]">
      <Eyebrow kicker="전체 프로그램" title="클립" desc="채택한 쇼츠 후보가 초안 → 확정(서버 1회 렌더) → 게시 상태로 흐릅니다." />
      <div className="mb-5 flex gap-[7px]">
        {CLIP_FILTERS.map((x) => (
          <button key={x} onClick={() => setF(x)} className="rounded-full px-[13px] py-1.5 text-[12.5px] font-semibold" style={f === x ? { background: "rgba(139,147,255,.12)", border: "1px solid rgba(139,147,255,.3)", color: "#c3c8ff" } : { background: "#161616", border: "1px solid #2b2b2b", color: "#9a9a9a" }}>{x}</button>
        ))}
      </div>
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(210px,1fr))]">
        {list.map((c, i) => {
          const t = CLIPST[c.state];
          return (
            <div key={i} className="flex flex-col overflow-hidden rounded-[14px] border border-[#262626] bg-[#161616]">
              <div className="relative max-h-[230px] [aspect-ratio:9/16]" style={{ background: THUMBS[c.th] }}>
                <span className="absolute left-[9px] top-[9px] rounded-full px-[9px] py-0.5 text-[10.5px] font-bold" style={{ color: t.c, background: t.bg, border: `1px solid ${t.ln}` }}>{t.l}</span>
                {c.views && <span className="mono absolute bottom-[9px] left-[9px] rounded-[5px] bg-black/55 px-[7px] py-0.5 text-[11px] font-semibold text-white">▶ {c.views}</span>}
              </div>
              <div className="flex flex-1 flex-col p-[13px]">
                <div className="text-[13px] font-bold leading-[1.35] tracking-[-.3px] [text-wrap:pretty]">{c.title}</div>
                <div className="mt-[5px] text-[11px] text-[#707070]">{c.prog} · <span className="mono">{c.range}</span></div>
                <div className="mt-3 flex gap-[7px]">
                  <button onClick={() => flash("편집기 v2 (데모 범위 밖)")} className="flex-1 rounded-[8px] border border-[#2b2b2b] bg-[#1e1e1e] py-2 text-[12px] font-semibold text-[#cfcfcf] hover:border-[#3a3a3a] hover:text-[#eceef2]">편집</button>
                  <button onClick={() => flash(`${c.title} 배포 (데모)`)} className="flex-1 rounded-[8px] bg-[#6b74f0] py-2 text-[12px] font-semibold text-white hover:bg-[#5a63e6]">배포</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─────────── DISTRIBUTION ─────────── */
const DSTAT: Record<string, { l: string; c: string; bg: string }> = {
  published: { l: "게시", c: "#34d399", bg: "rgba(52,211,153,.14)" },
  scheduled: { l: "예약", c: "#fbbf24", bg: "rgba(251,191,36,.14)" },
  failed: { l: "실패", c: "#ff6b78", bg: "rgba(248,113,113,.14)" },
  queued: { l: "대기", c: "#9a9a9a", bg: "rgba(138,146,160,.12)" },
};
const DIST_ROWS: { clip: string; prog: string; when: string; ch: [string, string][] }[] = [
  { clip: "영숙 폭탄 고백", prog: "솔로천국 S4·8화", when: "3일 전 게시", ch: [["SMR", "published"], ["YouTube", "published"], ["Meta", "published"]] },
  { clip: "트롯 고음 하이라이트", prog: "트롯 대잔치·12화", when: "3일 전 게시", ch: [["SMR", "published"], ["YouTube", "published"], ["Meta", "failed"]] },
  { clip: "환승 첫 재회", prog: "환승로그·5화", when: "오늘 20:00 예약", ch: [["SMR", "scheduled"], ["YouTube", "scheduled"], ["Meta", "queued"]] },
  { clip: "광수 3초 정적", prog: "솔로천국 S4·8화", when: "내일 12:00 예약", ch: [["SMR", "scheduled"], ["YouTube", "queued"], ["Meta", "queued"]] },
  { clip: "심야 인터뷰 눈물", prog: "심야 다큐·2화", when: "미예약", ch: [["SMR", "queued"], ["YouTube", "queued"], ["Meta", "queued"]] },
];
const DIST_SUMMARY = [{ l: "게시 완료", v: 6, c: "#34d399" }, { l: "예약", v: 5, c: "#fbbf24" }, { l: "실패", v: 1, c: "#ff6b78" }, { l: "대기", v: 7, c: "#9a9a9a" }];
export function Distribution({ flash }: { flash: (m: string) => void }) {
  return (
    <div className="max-w-[1160px] px-[30px] py-[26px]">
      <Eyebrow kicker="멀티채널 배포" title="배포현황" />
      <div className="mb-5 flex flex-wrap gap-3">
        {DIST_SUMMARY.map((s) => (
          <div key={s.l} className="flex items-center gap-2.5 rounded-[12px] border border-[#262626] bg-[#161616] px-5 py-3"><span className="size-[9px] rounded-full" style={{ background: s.c }} /><span className="grotesk text-[22px] font-bold" style={{ color: s.c }}>{s.v}</span><span className="text-[12px] text-[#9a9a9a]">{s.l}</span></div>
        ))}
      </div>
      <div className="flex flex-col gap-2.5">
        {DIST_ROWS.map((r) => (
          <div key={r.clip} className="flex flex-wrap items-center gap-3.5 rounded-[12px] border border-[#262626] bg-[#161616] px-4 py-[13px]">
            <div className="min-w-[180px] flex-1"><div className="text-[14px] font-bold tracking-[-.3px]">{r.clip}</div><div className="mt-0.5 text-[11.5px] text-[#707070]">{r.prog} · {r.when}</div></div>
            <div className="flex flex-wrap gap-2">
              {r.ch.map(([n, s]) => (
                <button key={n} onClick={() => flash(s === "failed" ? `${n} 재게시 시도 (데모)` : `${n} — ${DSTAT[s].l}`)} className="flex items-center gap-[5px] rounded-[7px] px-[9px] py-1 text-[11px] font-semibold" style={{ color: DSTAT[s].c, background: DSTAT[s].bg }}><span className="opacity-80">{n}</span><span className="font-bold">{DSTAT[s].l}</span></button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─────────── ANALYTICS ─────────── */
const A_DAYS = ["월", "화", "수", "목", "금", "토", "일"];
const A_VIEWS = [86, 120, 64, 150, 240, 182, 96];
const A_KPI = [
  { label: "총 조회수 (게시 클립)", value: "2.4M", delta: "▴ +18% WoW" },
  { label: "평균 시청 지속률", value: "71%", delta: "▴ +4pt" },
  { label: "평균 참여율", value: "9.2%", delta: "▴ +1.1pt" },
  { label: "구독 전환", value: "1.8K", delta: "▴ +260" },
];
const A_TOP = [
  { rank: 1, title: "트롯 고음 하이라이트", prog: "트롯 대잔치·12화", views: "240K", rate: "82%", eng: "11.4%" },
  { rank: 2, title: "영숙 폭탄 고백", prog: "솔로천국 S4·8화", views: "182K", rate: "78%", eng: "9.8%" },
  { rank: 3, title: "환승 첫 재회", prog: "환승로그·5화", views: "77K", rate: "69%", eng: "7.2%" },
  { rank: 4, title: "광수 3초 정적", prog: "솔로천국 S4·8화", views: "96K", rate: "74%", eng: "8.1%" },
  { rank: 5, title: "오프닝 빵터짐", prog: "솔로천국 S4·8화", views: "54K", rate: "63%", eng: "5.9%" },
];
export function Analytics() {
  const maxV = Math.max(...A_VIEWS);
  return (
    <div className="max-w-[1160px] px-[30px] py-[26px]">
      <Eyebrow kicker="게시 클립 성과" title="성과" />
      <div className="mb-[18px] grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
        {A_KPI.map((k) => (
          <div key={k.label} className="rounded-[14px] border border-[#262626] bg-[#161616] px-[18px] py-4"><div className="mb-[9px] text-[11.5px] font-semibold text-[#707070]">{k.label}</div><div className="grotesk text-[28px] font-bold tracking-[-.5px]">{k.value}</div><div className="mt-1.5 text-[11.5px] font-semibold text-[#34d399]">{k.delta}</div></div>
        ))}
      </div>
      <div className="grid items-start gap-[18px] [grid-template-columns:1fr_1fr]">
        <div className="rounded-[14px] border border-[#262626] bg-[#161616] px-5 py-[18px]">
          <div className="mb-4 text-[13px] font-bold">일별 조회수 · 최근 7일</div>
          <div className="flex h-[150px] items-end gap-2.5">
            {A_DAYS.map((d, i) => (
              <div key={d} className="flex h-full flex-1 flex-col items-center justify-end gap-[7px]"><span className="mono text-[10px] text-[#9a9a9a]">{A_VIEWS[i]}K</span><div className="w-full rounded-t-[5px]" style={{ height: `${(A_VIEWS[i] / maxV) * 100}%`, minHeight: 4, background: A_VIEWS[i] === maxV ? "#8b93ff" : "#3a4050" }} /><span className="text-[11px] text-[#707070]">{d}</span></div>
            ))}
          </div>
        </div>
        <div className="rounded-[14px] border border-[#262626] bg-[#161616] px-5 py-[18px]">
          <div className="mb-3 text-[13px] font-bold">상위 클립</div>
          <div className="flex flex-col">
            {A_TOP.map((t) => (
              <div key={t.rank} className="flex items-center gap-3 border-t border-[#232323] py-2.5"><span className="grotesk w-[18px] text-[14px] font-bold text-[#8b93ff]">{t.rank}</span><div className="min-w-0 flex-1"><div className="truncate text-[12.5px] font-semibold">{t.title}</div><div className="text-[10.5px] text-[#707070]">{t.prog}</div></div><div className="text-right"><div className="grotesk text-[14px] font-bold">{t.views}</div><div className="text-[10px] text-[#707070]">지속 {t.rate} · 참여 {t.eng}</div></div></div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────── CHANNEL TRENDS ─────────── */
type Ch = { views: string; growth: string; gTone: string; watch: string; subs: string; sTone: string; rev: string; rpm: string; dayAvg: string; monet: boolean; seed: number[]; vids: { t: string; v: string; l: string; c: string; d: string; short: boolean }[] };
const YTCH = [{ id: "c1", name: "솔로천국 공식", handle: "@soletv_shorts" }, { id: "c2", name: "트롯 대잔치", handle: "@trot_daejanchi" }, { id: "c3", name: "STEP D 클립", handle: "@stepd_clips" }];
const CHDATA: Record<string, Ch> = {
  c1: { views: "182만", growth: "+18%", gTone: "#34d399", watch: "2.4천시간", subs: "+1.8천", sTone: "#34d399", rev: "₩312만", rpm: "₩1,714", dayAvg: "₩34만", monet: true, seed: [42, 55, 48, 60, 72, 65, 80, 74, 88, 96, 90, 110, 120, 105, 132, 150, 140, 168, 182, 160, 175, 190, 205, 182, 196, 220, 210, 235, 240, 222], vids: [{ t: '"오빠 없으면 안 돼" 영숙 폭탄 고백', v: "182K", l: "14.2K", c: "1.1K", d: "3일 전", short: true }, { t: "광수의 3초 정적 — 삼각관계 정면돌파", v: "96K", l: "7.8K", c: "620", d: "3일 전", short: true }, { t: "8화 하이라이트 — 새 남자 등장", v: "54K", l: "4.1K", c: "310", d: "5일 전", short: false }, { t: "오프닝 자기소개 빵터짐", v: "48K", l: "3.6K", c: "280", d: "6일 전", short: true }, { t: "7화 풀 리캡", v: "32K", l: "2.1K", c: "190", d: "8일 전", short: false }, { t: "데이트권 쟁탈 반전", v: "71K", l: "5.9K", c: "440", d: "9일 전", short: true }] },
  c2: { views: "420만", growth: "+31%", gTone: "#34d399", watch: "5.1천시간", subs: "+3.2천", sTone: "#34d399", rev: "₩720만", rpm: "₩1,714", dayAvg: "₩80만", monet: true, seed: [120, 140, 135, 160, 180, 175, 210, 230, 220, 260, 300, 290, 340, 360, 350, 400, 420, 390, 440, 470, 455, 500, 540, 510, 560, 600, 580, 640, 660, 620], vids: [{ t: "트롯 고음 하이라이트 — 소름 3단 고음", v: "240K", l: "21K", c: "2.4K", d: "2일 전", short: true }, { t: "12화 무대 풀버전", v: "180K", l: "12K", c: "980", d: "4일 전", short: false }, { t: "심사위원 리액션 모음", v: "132K", l: "9.8K", c: "760", d: "5일 전", short: true }, { t: "앵콜 무대 클립", v: "98K", l: "7.1K", c: "520", d: "7일 전", short: true }] },
  c3: { views: "96만", growth: "신규", gTone: "#5e9bff", watch: "1.1천시간", subs: "+620", sTone: "#34d399", rev: "₩0", rpm: "—", dayAvg: "—", monet: false, seed: [4, 6, 8, 7, 12, 18, 15, 22, 30, 28, 40, 55, 48, 70, 96, 88, 120, 110, 140, 132, 160, 155, 180, 168, 190, 175, 205, 196, 220, 210], vids: [{ t: "환승 첫 재회 — 8초 정적", v: "77K", l: "6.2K", c: "510", d: "6일 전", short: true }, { t: "심야 인터뷰 눈물 클로즈업", v: "41K", l: "3.1K", c: "240", d: "9일 전", short: false }, { t: "클립 모음 vol.2", v: "22K", l: "1.4K", c: "110", d: "12일 전", short: true }] },
};
const numV = (s: string) => parseFloat(s) * (s.includes("K") ? 1000 : s.includes("만") ? 10000 : 1);
export function Trends() {
  const [chId, setChId] = useState("c1");
  const [kind, setKind] = useState("all");
  const [sort, setSort] = useState("recent");
  const [selVid, setSelVid] = useState<string | null>(null);
  const CH = CHDATA[chId];
  const kpi = [
    { label: "최근 90일 조회수", value: CH.views, sub: "YouTube 일별 합계", tone: "#5e9bff" },
    { label: "성장률", value: CH.growth, sub: "이전 90일 대비", tone: CH.gTone },
    { label: "시청 시간", value: CH.watch, sub: "최근 90일", tone: "#e5e5e5" },
    { label: "순 구독자", value: CH.subs, sub: "최근 90일", tone: CH.sTone },
  ];
  const sd = CH.seed, mx = Math.max(...sd), mn = Math.min(...sd);
  const pts = sd.map((y, i) => `${((i / (sd.length - 1)) * 300).toFixed(1)},${(90 - ((y - mn) / (mx - mn || 1)) * 78 - 6).toFixed(1)}`);
  const line = pts.join(" ");
  const kinds: [string, string][] = [["all", "전체"], ["regular", "일반영상"], ["shorts", "쇼츠"]];
  const kindCount: Record<string, number> = { all: CH.vids.length, shorts: CH.vids.filter((v) => v.short).length, regular: CH.vids.filter((v) => !v.short).length };
  let vlist = CH.vids.filter((v) => kind === "all" || (kind === "shorts" ? v.short : !v.short));
  if (sort === "views") vlist = [...vlist].sort((a, b) => numV(b.v) - numV(a.v));
  else if (sort === "comments") vlist = [...vlist].sort((a, b) => numV(b.c) - numV(a.c));
  const sel = CH.vids.find((v) => v.t === selVid);

  return (
    <div className="max-w-[1080px] px-[30px] py-[26px]">
      <Eyebrow kicker="YouTube 채널 분석" title="채널 트렌드" desc="채널별 조회수 추세·수익·영상 성과를 봅니다." />
      <div className="mb-[18px] flex flex-wrap items-center gap-[9px]">
        <span className="text-[12px] font-semibold text-[#707070]">채널</span>
        <select value={chId} onChange={(e) => { setChId(e.target.value); setSelVid(null); }} className="min-w-[240px] cursor-pointer rounded-[9px] border border-[#2b2b2b] bg-[#161616] px-3 py-2 text-[12.5px] font-semibold text-[#e5e5e5]">
          {YTCH.map((c) => (<option key={c.id} value={c.id}>{c.name} · {c.handle}</option>))}
        </select>
        <span className="flex-1" />
        <button className="flex items-center gap-1.5 rounded-[8px] bg-[#6b74f0] px-3.5 py-2 text-[12.5px] font-semibold text-white"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" /></svg>YouTube 동기화</button>
      </div>
      <div className="mb-4 grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
        {kpi.map((k) => (<div key={k.label} className="rounded-[13px] border border-[#262626] bg-[#161616] px-4 py-[15px]"><div className="mb-2 text-[11.5px] font-semibold text-[#707070]">{k.label}</div><div className="grotesk text-[24px] font-bold tracking-[-.3px]" style={{ color: k.tone }}>{k.value}</div><div className="mt-[5px] text-[11px] text-[#707070]">{k.sub}</div></div>))}
      </div>
      <div className="mb-4 rounded-[14px] border border-[rgba(52,211,153,.3)] bg-[rgba(52,211,153,.05)] px-[18px] py-4">
        <div className="mb-2.5 flex items-center gap-[7px] text-[13px] font-bold text-[#34d399]"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></svg>수익 대시보드 (예상)</div>
        {CH.monet ? (
          <>
            <div className="flex flex-wrap items-baseline gap-2"><span className="grotesk text-[26px] font-bold text-[#34d399]">{CH.rev}</span><span className="text-[11.5px] text-[#707070]">최근 90일 채널 예상 수익</span></div>
            <div className="mt-3 grid grid-cols-3 gap-2.5">
              <div className="rounded-[10px] border border-[#232323] bg-[#141414] px-[13px] py-[11px]"><div className="text-[10.5px] text-[#707070]">RPM (1천뷰당)</div><div className="grotesk mt-[3px] text-[16px] font-bold">{CH.rpm}</div></div>
              <div className="rounded-[10px] border border-[#232323] bg-[#141414] px-[13px] py-[11px]"><div className="text-[10.5px] text-[#707070]">일 평균 수익</div><div className="grotesk mt-[3px] text-[16px] font-bold">{CH.dayAvg}</div></div>
              <div className="rounded-[10px] border border-[#232323] bg-[#141414] px-[13px] py-[11px]"><div className="text-[10.5px] text-[#707070]">기간 조회수</div><div className="grotesk mt-[3px] text-[16px] font-bold">{CH.views}</div></div>
            </div>
          </>
        ) : (
          <div className="text-[12px] leading-[1.6] text-[#9a9a9a]">이 채널은 <b className="text-[#e5e5e5]">수익화(YPP) 전</b>이거나 수익을 <b className="text-[#e5e5e5]">콘텐츠 소유자(MCN·방송사)가 관리</b>해, 크리에이터 권한으로는 수익이 조회되지 않습니다.</div>
        )}
      </div>
      <div className="mb-4 rounded-[14px] border border-[#262626] bg-[#161616] px-[18px] py-4">
        <div className="mb-3.5 flex items-center gap-[7px] text-[13px] font-bold"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#5e9bff" strokeWidth={2}><path d="M3 3v18h18M7 14l4-4 3 3 5-6" /></svg>일별 조회수 추세 (90일)<span className="text-[11px] font-normal text-[#707070]">· YouTube 실제 일별 조회수</span></div>
        <div className="h-[180px]">
          <svg width="100%" height="100%" viewBox="0 0 300 100" preserveAspectRatio="none" className="block">
            <polygon points={`0,96 ${line} 300,96`} fill="rgba(94,155,255,.12)" />
            <polyline points={line} fill="none" stroke="#5e9bff" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </svg>
        </div>
      </div>
      <div className="overflow-hidden rounded-[14px] border border-[#262626] bg-[#161616]">
        <div className="flex flex-wrap items-center gap-2.5 border-b border-[#232323] px-4 py-3">
          <span className="text-[13px] font-bold">영상</span><span className="flex-1" />
          <div className="flex gap-0.5 rounded-[9px] border border-[#232323] bg-[#0e0e0e] p-[3px]">{kinds.map(([k, l]) => (<button key={k} onClick={() => setKind(k)} className="flex items-center gap-[5px] rounded-[7px] px-[11px] py-1.5 text-[12px] font-semibold" style={kind === k ? { background: "#232323", color: "#e5e5e5" } : { color: "#9a9a9a" }}>{l}<span className="mono text-[10px] opacity-70">{kindCount[k]}</span></button>))}</div>
          <div className="flex gap-0.5 rounded-[9px] border border-[#232323] bg-[#0e0e0e] p-[3px]">{([["recent", "최신순"], ["views", "조회수순"], ["comments", "댓글순"]] as [string, string][]).map(([k, l]) => (<button key={k} onClick={() => setSort(k)} className="rounded-[7px] px-[11px] py-1.5 text-[12px] font-semibold" style={sort === k ? { background: "#232323", color: "#e5e5e5" } : { color: "#9a9a9a" }}>{l}</button>))}</div>
        </div>
        <div className="grid gap-2 p-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
          {vlist.map((v, i) => {
            const on = selVid === v.t;
            return (
              <button key={v.t} onClick={() => setSelVid(v.t)} className="flex gap-2.5 rounded-[10px] p-[9px] text-left text-inherit transition-colors" style={{ border: `1px solid ${on ? "rgba(139,147,255,.5)" : "#232323"}`, background: on ? "rgba(139,147,255,.06)" : "#161616" }}>
                <div className="relative h-[50px] w-[88px] flex-none rounded-[6px]" style={{ background: THUMBS[i % THUMBS.length] }}>{v.short && <span className="absolute bottom-[3px] right-[3px] rounded-[3px] bg-black/70 px-1 py-px text-[8.5px] font-bold text-white">쇼츠</span>}</div>
                <div className="min-w-0 flex-1"><div className="line-clamp-2 text-[12px] font-semibold leading-[1.35] [text-wrap:pretty]">{v.t}</div><div className="mt-1 flex gap-[9px] text-[10.5px] text-[#707070]"><span>▶ {v.v}</span><span>♥ {v.l}</span><span>💬 {v.c}</span></div></div>
              </button>
            );
          })}
        </div>
      </div>
      {sel && (
        <div className="mt-4 rounded-[14px] border border-[#262626] bg-[#161616] px-[18px] py-4">
          <div className="mb-3.5 flex items-start gap-2.5"><div><div className="text-[14px] font-bold tracking-[-.2px]">{sel.t}</div><div className="mt-0.5 text-[11.5px] text-[#707070]">조회수 {sel.v} · 좋아요 {sel.l} · 댓글 {sel.c}</div></div><span className="flex-1" /><button onClick={() => setSelVid(null)} className="text-[12px] text-[#707070] hover:text-[#e5e5e5]">닫기</button></div>
          <div className="mb-4 grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(130px,1fr))]">
            {[{ label: "평균 시청 시간", value: sel.short ? "0:22" : "2:47", tone: "#e5e5e5" }, { label: "평균 시청률", value: sel.short ? "71%" : "48%", tone: sel.short ? "#34d399" : "#5e9bff" }, { label: "공유", value: sel.short ? "1.2K" : "340", tone: "#e5e5e5" }, { label: "구독 전환", value: `+${sel.short ? "820" : "190"}`, tone: "#34d399" }].map((e) => (<div key={e.label} className="rounded-[10px] border border-[#232323] bg-[#141414] px-[13px] py-[11px]"><div className="text-[10.5px] text-[#707070]">{e.label}</div><div className="grotesk mt-[3px] text-[17px] font-bold" style={{ color: e.tone }}>{e.value}</div></div>))}
          </div>
          <div className="mb-2.5 text-[11.5px] font-bold text-[#9a9a9a]">유입 경로</div>
          <div className="mb-4 flex flex-col gap-[7px]">
            {[{ s: "Shorts 피드", v: 82 }, { s: "YouTube 검색", v: 46 }, { s: "추천 영상", v: 38 }, { s: "구독 피드", v: 22 }, { s: "외부 링크", v: 9 }].map((t) => (<div key={t.s} className="flex items-center gap-2.5"><span className="w-[78px] flex-none text-[11px] text-[#9a9a9a]">{t.s}</span><div className="h-3 flex-1 overflow-hidden rounded-[4px] bg-[#0e0e0e]"><div className="h-full rounded-[4px] bg-[#5e9bff]" style={{ width: `${(t.v / 82) * 100}%` }} /></div><span className="mono w-[34px] text-right text-[11px] text-[#cfcfcf]">{t.v}K</span></div>))}
          </div>
          <div className="mb-2.5 text-[11.5px] font-bold text-[#9a9a9a]">댓글 · 좋아요순</div>
          <div className="flex flex-col gap-2">
            {[{ a: "시청자A", likes: "1.2K", text: "영숙 답장 언제 나옴? 다음화 기다리다 지침 ㅋㅋ" }, { a: "시청자B", likes: "640", text: "자막 진짜 깔끔하다 몰입도 미쳤음" }, { a: "시청자C", likes: "318", text: "풀버전 링크 어디서 봄?" }].map((cm) => (<div key={cm.a} className="rounded-[9px] border border-[#232323] bg-[#141414] px-3 py-2.5"><div className="mb-[3px] flex items-center gap-2 text-[11px] text-[#707070]"><span className="font-semibold text-[#e5e5e5]">{cm.a}</span><span>♥ {cm.likes}</span></div><div className="text-[12px] leading-[1.4] text-[#cfcfcf]">{cm.text}</div></div>))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────── PUBLISH CHANNELS ─────────── */
const PLATFORMS = [{ key: "smr", name: "네이버 SMR", c: "#34d399", metric: "배급 채널" }, { key: "youtube", name: "YouTube", c: "#ff6b78", metric: "구독" }, { key: "meta", name: "Meta Reels", c: "#5e9bff", metric: "팔로워" }];
const CHANNELS = [
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
export function Channels({ flash }: { flash: (m: string) => void }) {
  return (
    <div className="max-w-[1160px] px-[30px] py-[26px]">
      <Eyebrow kicker={`연동 채널 관리 · ${CHANNELS.length}개 연결`} title="배포채널" desc="플랫폼별로 여러 계정을 등록하고, 각 채널에 프로그램을 매핑해 배포처를 관리해요." action={<PrimaryBtn onClick={() => flash("채널 등록 (데모)")}>{Plus}채널 등록</PrimaryBtn>} />
      <div className="mb-[26px] flex flex-col gap-5">
        {PLATFORMS.map((p) => {
          const list = CHANNELS.filter((c) => c.plat === p.key);
          return (
            <div key={p.key}>
              <div className="mb-[11px] flex items-center gap-[9px]"><span className="size-[11px] rounded-[3px]" style={{ background: p.c }} /><span className="text-[15px] font-bold tracking-[-.3px]">{p.name}</span><span className="text-[11.5px] font-semibold text-[#707070]">{list.length}개 계정</span></div>
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
                {list.map((a) => (
                  <div key={a.handle} className="rounded-[13px] border border-[#262626] bg-[#161616] px-4 py-[15px]">
                    <div className="mb-2.5 flex items-center gap-2"><span className="text-[13.5px] font-bold tracking-[-.2px]">{a.handle}</span><span className="flex-1" /><span className="rounded-full px-[9px] py-[3px] text-[10.5px] font-bold" style={a.ok ? { color: "#34d399", background: "rgba(52,211,153,.12)" } : { color: "#fbbf24", background: "rgba(251,191,36,.12)" }}>{a.ok ? "연결됨" : "토큰 만료"}</span></div>
                    <div className="text-[11.5px] text-[#9a9a9a]"><span className="grotesk text-[14px] font-bold text-[#eceef2]">{a.count}</span> {p.metric}</div>
                    <div className="mt-[11px] border-t border-[#232323] pt-[11px] text-[11px] text-[#707070]">담당 프로그램</div>
                    <div className="mt-[3px] text-[12px] font-semibold text-[#cfcfcf]">{a.progs.join(", ")}</div>
                    <button onClick={() => flash(a.ok ? `${a.handle} 관리 (데모)` : `${a.handle} 재인증 (데모)`)} className="mt-3 w-full rounded-[8px] border border-[#2b2b2b] bg-[#1e1e1e] py-2 text-[12px] font-semibold text-[#cfcfcf] hover:border-[#3a3a3a] hover:text-[#eceef2]">{a.ok ? "관리" : "재인증"}</button>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mb-3 text-[14px] font-bold">익스포트 프리셋</div>
      <div className="overflow-hidden rounded-[12px] border border-[#262626]">
        {EXPORT_PRESETS.map((p) => (<div key={p.name} className="flex items-center gap-3 border-b border-[#1f1f1f] bg-[#161616] px-4 py-[13px]"><span className="size-2 rounded-full bg-[#8b93ff]" /><span className="flex-1 text-[13px] font-semibold">{p.name}</span><span className="mono text-[11.5px] text-[#9a9a9a]">{p.spec}</span></div>))}
      </div>
    </div>
  );
}

/* ─────────── OPS ─────────── */
const OPS_WORKERS = [
  { name: "분석 워커 #1", job: "심야 다큐·2화 분석", load: 62, state: "busy" },
  { name: "분석 워커 #2", job: "트롯 대잔치·13화 분할", load: 28, state: "busy" },
  { name: "분석 워커 #3", job: "유휴", load: 0, state: "idle" },
  { name: "인코딩 워커 #1", job: "환승로그·5화 렌더", load: 44, state: "busy" },
];
const OJST: Record<string, { l: string; c: string }> = { done: { l: "완료", c: "#34d399" }, run: { l: "실행중", c: "#8b93ff" }, fail: { l: "실패", c: "#ff6b78" }, queue: { l: "대기", c: "#9a9a9a" } };
const OPS_JOBS = [
  { job: "분석", target: "심야 다큐·2화", dur: "04:12", st: "run" },
  { job: "분할", target: "트롯 대잔치·13화", dur: "01:38", st: "run" },
  { job: "인코딩", target: "환승로그·5화 (9클립)", dur: "02:20", st: "run" },
  { job: "분석", target: "심야 다큐·3화", dur: "—", st: "fail" },
  { job: "병합", target: "솔로천국 S4·8화", dur: "00:52", st: "done" },
  { job: "분석", target: "솔로천국 S4·8화", dur: "06:04", st: "done" },
  { job: "인코딩", target: "솔로천국 S4·8화 (8클립)", dur: "03:11", st: "done" },
];
export function Ops() {
  return (
    <div className="max-w-[1000px] px-[30px] py-[26px]">
      <Eyebrow kicker="파이프라인 상태" title="운영·진단" />
      <div className="mb-4 grid gap-4 [grid-template-columns:1fr_1fr]">
        {OPS_WORKERS.map((w) => (
          <div key={w.name} className="rounded-[12px] border border-[#262626] bg-[#161616] px-4 py-3.5">
            <div className="mb-2.5 flex items-center gap-2"><span className="size-2 rounded-full" style={{ background: w.state === "busy" ? "#34d399" : "#5a5a5a" }} /><span className="text-[13px] font-bold">{w.name}</span><span className="flex-1" /><span className="mono text-[11px] text-[#9a9a9a]">{w.load}%</span></div>
            <div className="mb-[9px] text-[11.5px] text-[#9a9a9a]">{w.job}</div>
            <div className="h-1.5 overflow-hidden rounded-full bg-[#0e0e0e]"><div className="h-full rounded-full" style={{ width: `${w.load}%`, background: w.load > 70 ? "#ff6b78" : w.load > 0 ? "#8b93ff" : "#2b2b2b" }} /></div>
          </div>
        ))}
      </div>
      <div className="mb-3 text-[14px] font-bold">최근 작업</div>
      <div className="overflow-hidden rounded-[12px] border border-[#262626]">
        <div className="grid grid-cols-[100px_1fr_90px_80px] border-b border-[#262626] bg-[#161616] text-[11px] font-bold text-[#9a9a9a]"><div className="px-3.5 py-[11px]">작업</div><div className="px-2 py-[11px]">대상</div><div className="px-2 py-[11px] text-right">소요</div><div className="px-3.5 py-[11px] text-right">상태</div></div>
        {OPS_JOBS.map((j, i) => (
          <div key={i} className="grid grid-cols-[100px_1fr_90px_80px] items-center border-b border-[#1f1f1f] bg-[#161616]"><div className="px-3.5 py-[11px] text-[12.5px] font-semibold">{j.job}</div><div className="px-2 py-[11px] text-[12px] text-[#cfcfcf]">{j.target}</div><div className="mono px-2 py-[11px] text-right text-[11.5px] text-[#9a9a9a]">{j.dur}</div><div className="flex items-center justify-end gap-1.5 px-3.5 py-[11px]"><span className="size-[7px] flex-none rounded-full" style={{ background: OJST[j.st].c }} /><span className="text-[11px] font-bold" style={{ color: OJST[j.st].c }}>{OJST[j.st].l}</span></div></div>
        ))}
      </div>
    </div>
  );
}
