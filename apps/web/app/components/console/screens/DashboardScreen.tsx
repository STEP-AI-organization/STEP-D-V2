"use client";

import { useMemo, useState } from "react";
import { C, card, estimateBadge, segBtn, segWrap } from "@/lib/console/theme";
import { fmtKor, fmtWon } from "@/lib/console/format";
import {
  CONTENT_REV_MONTH,
  CUMULATIVE_REV,
  PLATFORM_META,
  PLAT_RATE,
  PRODUCTS,
  PROGRAMS,
  TREND_6,
  TREND_PREV,
  type Program,
} from "@/lib/console/dummy";
import { Sparkline } from "../charts";
import { DrilldownPanel } from "../DrilldownPanel";
import { useConsole } from "../ConsoleProvider";

type Source = "채널" | "커머스" | "전체";
type Range = "month" | 6 | 12;

const statusColor = (s: string) => (s === "배포완료" ? C.green : s === "배포중" ? C.violet : C.faint);

export function DashboardScreen() {
  const c = useConsole();
  const [source, setSource] = useState<Source>("전체");
  const [range, setRange] = useState<Range>("month");
  const [selProgram, setSelProgram] = useState<Program | null>(null);

  const commerceMonth = PRODUCTS.reduce((a, p) => a + p.revN, 0);
  const heroAmount = fmtWon(CONTENT_REV_MONTH + commerceMonth);
  const pickV = (ch: number, cm: number) => (source === "채널" ? ch : source === "커머스" ? cm : ch + cm);

  const trendBars = useMemo(() => {
    if (range === "month") {
      const cur = pickV(CONTENT_REV_MONTH, TREND_6[TREND_6.length - 1].cm);
      return [0.19, 0.24, 0.27, 0.3].map((f, i) => ({ label: `${i + 1}주차`, value: Math.round(cur * f) }));
    }
    const src = range === 12 ? [...TREND_PREV, ...TREND_6] : TREND_6;
    return src.map((p) => ({ label: p.label, value: pickV(p.ch, p.cm) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, source]);
  const tmax = Math.max(...trendBars.map((b) => b.value)) * 1.18;

  const platBreakdown = useMemo(() => {
    const total = PRODUCTS.reduce((a, p) => a + p.revN, 0);
    return Object.keys(PLATFORM_META).map((name) => {
      const items = PRODUCTS.filter((p) => p.plat === name);
      const rev = items.reduce((a, p) => a + p.revN, 0);
      return { name, color: PLATFORM_META[name], count: items.length, rev, rate: PLAT_RATE[name] + "%", barW: total ? (rev / total) * 100 : 0 };
    });
  }, []);

  const kpis = [
    { label: "누적 수익", value: fmtWon(CUMULATIVE_REV), caption: "올해 콘텐츠가 번 돈", est: true },
    { label: "발행 클립", value: (c.pickerClips.length || 1863).toLocaleString("ko-KR"), caption: "운영 중", est: false },
    { label: "총 조회수", value: "1,240만", caption: "도달한 시청자", est: true },
    { label: "활성 프로그램", value: String(c.projects.length || 14), caption: "운영 중", est: false },
  ];

  const sparkValues = TREND_6.map((m) => m.ch + m.cm);

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto", padding: "26px 28px 60px" }}>
      {/* greeting */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 23, fontWeight: 750, letterSpacing: "-.6px" }}>{c.me?.name || "양승훈"}님, 반갑습니다</div>
        <div style={{ fontSize: 13.5, color: C.body, marginTop: 7, lineHeight: 1.55, maxWidth: 680 }}>
          이번 달 ENA 콘텐츠 성과를 한눈에 정리했어요. 본방송이 끝난 다음날에도 ENA 클립이 채널 곳곳에서 조회수를 모으고 있어요.
        </div>
      </div>

      {/* hero */}
      <section style={card({ padding: "28px 30px", marginBottom: 18, display: "flex", alignItems: "center", gap: 28, flexWrap: "wrap" })}>
        <div style={{ flex: "2 1 320px", minWidth: 280 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12.5, color: C.body, fontWeight: 600 }}>이번 달 총 수익</span>
            <span style={estimateBadge}>추정</span>
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 14, marginTop: 10, flexWrap: "wrap" }}>
            <div style={{ fontSize: 46, fontWeight: 800, letterSpacing: "-1.5px", lineHeight: 1, fontFeatureSettings: "'tnum' 1", whiteSpace: "nowrap" }}>{heroAmount}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 4, color: C.green, fontWeight: 700, fontSize: 14, marginBottom: 7 }}>▲ 32%</div>
          </div>
          <div style={{ fontSize: 11.5, color: C.dim, marginTop: 7 }}>지난달 대비 ▲32% · 조회수 기반 추정 · 가정값 조정 가능</div>
        </div>
        <div style={{ flex: "1 1 240px", minWidth: 220, maxWidth: 340, height: 130, overflow: "hidden" }}>
          <Sparkline values={sparkValues} />
          <div style={{ fontSize: 10.5, color: C.dim, textAlign: "right", marginTop: 2 }}>최근 6개월 추세</div>
        </div>
      </section>

      {/* KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14, marginBottom: 18 }}>
        {kpis.map((k) => (
          <div key={k.label} style={card({ padding: "17px 18px" })}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 13 }}>
              <span style={{ fontSize: 12, color: C.body, fontWeight: 600, letterSpacing: "-.2px" }}>{k.label}</span>
              {k.est ? <span style={estimateBadge}>추정</span> : <span style={{ fontSize: 9.5, fontWeight: 700, color: C.cyanInk, background: C.cyanSoft, border: `1px solid ${C.cyanLine}`, padding: "2px 6px", borderRadius: 5 }}>Live</span>}
            </div>
            <div style={{ fontSize: 26, fontWeight: 750, letterSpacing: "-1px", lineHeight: 1 }}>{k.value}</div>
            <div style={{ fontSize: 11.5, color: C.dim, marginTop: 9 }}>{k.caption}</div>
          </div>
        ))}
      </div>

      {/* revenue trend */}
      <div style={card({ padding: "20px 22px", marginBottom: 18 })}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 2 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "-.2px" }}>수익 추세</span>
            <span style={estimateBadge}>추정</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={segWrap}>
              {(["채널", "커머스", "전체"] as Source[]).map((s) => (
                <button key={s} onClick={() => setSource(s)} style={segBtn(source === s)}>{s} 매출</button>
              ))}
            </div>
            <div style={segWrap}>
              {([["month", "이번 달"], [6, "6개월"], [12, "12개월"]] as [Range, string][]).map(([r, l]) => (
                <button key={String(r)} onClick={() => setRange(r)} style={segBtn(range === r)}>{l}</button>
              ))}
            </div>
          </div>
        </div>
        <div style={{ marginTop: 16 }}>
          <div style={{ height: 240, display: "flex", alignItems: "flex-end", gap: 14, padding: "0 6px" }}>
            {trendBars.map((b) => (
              <div key={b.label} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: "100%" }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: C.ink, marginBottom: 7, fontFeatureSettings: "'tnum' 1", whiteSpace: "nowrap" }}>₩{fmtKor(b.value)}</div>
                <div style={{ width: "100%", maxWidth: 56, height: `${(b.value / tmax) * 100}%`, background: C.cyan, borderRadius: "7px 7px 0 0" }} />
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 14, padding: "10px 6px 0", marginTop: 9, borderTop: `1px solid ${C.lineSoft}` }}>
            {trendBars.map((b) => (
              <div key={b.label} style={{ flex: 1, textAlign: "center", fontSize: 11.5, color: C.muted }}>{b.label}</div>
            ))}
          </div>
        </div>
      </div>

      {/* commerce breakdown */}
      <div style={card({ padding: "20px 22px", marginBottom: 18 })}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: "-.2px" }}>커머스 연결 · 제휴 수익</span>
            <span style={{ fontSize: 11, color: C.cyanInk, background: C.cyanSoft, border: `1px solid ${C.cyanLine}`, padding: "2px 8px", borderRadius: 6, fontWeight: 600 }}>자동 매칭</span>
          </div>
          <span onClick={() => c.setNav("commerce")} style={{ fontSize: 11.5, color: C.violet, fontWeight: 600, cursor: "pointer" }}>커머스 전체 보기 →</span>
        </div>
        <div style={{ height: 16 }} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
          {platBreakdown.map((p) => (
            <div key={p.name} style={{ border: `1px solid ${C.line}`, borderRadius: 11, padding: "13px 14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span style={{ width: 9, height: 9, borderRadius: "50%", background: p.color, flex: "0 0 9px" }} />
                <span style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: "-.2px" }}>{p.name}</span>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 10.5, color: C.muted, fontWeight: 600 }}>수수료 {p.rate}</span>
              </div>
              <div style={{ fontSize: 17, fontWeight: 750, letterSpacing: "-.5px", marginTop: 10, fontFeatureSettings: "'tnum' 1" }}>₩{fmtKor(p.rev)}</div>
              <div style={{ fontSize: 10.5, color: C.dim, marginTop: 2 }}>상품 {p.count}</div>
              <div style={{ height: 5, background: C.lineSoft, borderRadius: 3, marginTop: 10, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${p.barW}%`, background: p.color, borderRadius: 3 }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* program table */}
      <div style={card({ overflow: "hidden" })}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "17px 20px 13px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: "-.2px" }}>프로그램</span>
            <span style={{ fontSize: 11, color: C.muted, background: C.rowHover2, padding: "2px 8px", borderRadius: 6, fontWeight: 600 }}>{PROGRAMS.length}개 운영</span>
          </div>
          <span style={{ fontSize: 11.5, color: C.dim }}>행 클릭 → 수익이 어느 장면에서 나왔는지 →</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 96px 110px 120px 110px", padding: "0 20px 9px", fontSize: 11, color: C.dim, fontWeight: 600, borderBottom: `1px solid ${C.lineSoft}`, letterSpacing: ".2px" }}>
          <span>프로그램 · 회차</span><span style={{ textAlign: "right" }}>발행 클립</span><span style={{ textAlign: "right" }}>조회수</span><span style={{ textAlign: "right" }}>수익</span><span style={{ textAlign: "right" }}>상태</span>
        </div>
        {PROGRAMS.map((p) => (
          <div key={p.id} onClick={() => setSelProgram(p)} className="hv-row" style={{ display: "grid", gridTemplateColumns: "1fr 96px 110px 120px 110px", alignItems: "center", padding: "13px 20px", borderBottom: `1px solid ${C.lineSoft}`, cursor: "pointer" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 11, minWidth: 0 }}>
              <div style={{ width: 34, height: 34, borderRadius: 8, background: p.thumbBg, flex: "0 0 34px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: p.thumbFg }}>{p.initial}</div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: "-.2px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                <div style={{ fontSize: 11, color: C.dim, marginTop: 1 }}>{p.sub}</div>
              </div>
            </div>
            <span style={{ textAlign: "right", fontSize: 13, color: C.sub, fontFeatureSettings: "'tnum' 1" }}>{p.clips}</span>
            <span style={{ textAlign: "right", fontSize: 13, color: C.sub, fontFeatureSettings: "'tnum' 1" }}>{p.views}</span>
            <span style={{ textAlign: "right", fontSize: 13, fontWeight: 700, color: C.ink, fontFeatureSettings: "'tnum' 1" }}>₩{Math.round(p.revenueN / 1000)}K</span>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: statusColor(p.status) }} />
              <span style={{ fontSize: 12, color: C.body }}>{p.status}</span>
            </div>
          </div>
        ))}
        <div style={{ padding: "11px 20px", fontSize: 11, color: C.faint }}>수익 금액은 조회수 × 채널 RPM × 배분율로 추정한 가정값입니다.</div>
      </div>

      <DrilldownPanel program={selProgram} onClose={() => setSelProgram(null)} />
    </div>
  );
}
