"use client";

import { C, estimateBadge } from "@/lib/console/theme";
import { fmtWon } from "@/lib/console/format";
import type { Program } from "@/lib/console/dummy";

/* Program → clip-level revenue drilldown with AI 귀인 (right slide panel). */
export function DrilldownPanel({ program, onClose }: { program: Program | null; onClose: () => void }) {
  const open = !!program;
  return (
    <>
      {open && <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(16,18,24,0.32)", animation: "scrimIn .18s ease", zIndex: 40 }} />}
      <div style={{ position: "fixed", top: 0, right: 0, height: "100vh", width: 448, maxWidth: "92vw", background: "#fff", borderLeft: `1px solid ${C.line}`, boxShadow: "-12px 0 40px rgba(16,18,24,0.10)", zIndex: 50, transform: `translateX(${open ? "0%" : "100%"})`, transition: "transform .26s cubic-bezier(.4,0,.2,1)", display: "flex", flexDirection: "column" }}>
        {program && (
          <>
            <div style={{ flex: "0 0 auto", padding: "20px 22px", borderBottom: `1px solid ${C.lineSoft}` }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 11, minWidth: 0 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: program.thumbBg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 700, color: program.thumbFg }}>{program.initial}</div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-.3px" }}>{program.name}</div>
                    <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>{program.sub} · 발행 클립 {program.clips}</div>
                  </div>
                </div>
                <button onClick={onClose} className="hv-soft" style={{ flex: "0 0 30px", width: 30, height: 30, border: `1px solid ${C.line}`, background: "#fff", borderRadius: 8, cursor: "pointer", fontSize: 15, color: C.muted }}>✕</button>
              </div>
              <div style={{ display: "flex", gap: 18, marginTop: 18 }}>
                <div>
                  <div style={{ fontSize: 10.5, color: C.muted, fontWeight: 600 }}>회차 수익 <span style={estimateBadge}>추정</span></div>
                  <div style={{ fontSize: 21, fontWeight: 750, letterSpacing: "-.6px", marginTop: 3 }}>{fmtWon(program.revenueN)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10.5, color: C.muted, fontWeight: 600 }}>총 조회수</div>
                  <div style={{ fontSize: 21, fontWeight: 750, letterSpacing: "-.6px", marginTop: 3 }}>{program.views}</div>
                </div>
              </div>
            </div>

            <div style={{ flex: "1 1 auto", overflowY: "auto", padding: "18px 22px 30px" }}>
              <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "-.2px", marginBottom: 14 }}>클립별 수익</div>
              {program.clipList.map((clip) => (
                <div key={clip.title} style={{ border: `1px solid ${C.lineSoft}`, borderRadius: 12, padding: "15px 16px", marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 650, letterSpacing: "-.2px" }}>&ldquo;{clip.title}&rdquo;</div>
                    <div style={{ fontSize: 13, fontWeight: 700, fontFeatureSettings: "'tnum' 1" }}>{clip.revenue}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 7 }}>
                    <span style={{ fontSize: 11.5, color: C.muted }}>조회 {clip.views}</span>
                    <span style={{ width: 3, height: 3, borderRadius: "50%", background: "#D5D9DF" }} />
                    <span style={{ fontSize: 11.5, color: C.muted }}>회차 수익의 {clip.pct}%</span>
                  </div>
                  <div style={{ height: 5, background: C.lineSoft, borderRadius: 3, marginTop: 9, overflow: "hidden" }}>
                    <div style={{ width: `${Math.min(100, clip.pct * 3.6)}%`, height: "100%", background: C.cyan }} />
                  </div>
                  <div style={{ background: "#F8F9FB", borderRadius: 9, padding: "11px 12px", marginTop: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                      <span style={{ width: 5, height: 5, borderRadius: "50%", background: C.violet }} />
                      <span style={{ fontSize: 10.5, color: C.violet, fontWeight: 700, letterSpacing: ".2px" }}>왜 이 구간? · AI 귀인</span>
                    </div>
                    <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.55 }}>{clip.ai}</div>
                    <div style={{ display: "flex", gap: 14, marginTop: 10 }}>
                      <Mini label="완주율" value={clip.completion} />
                      <Mini label="평균 시청" value={clip.avg} />
                      <Mini label="레퍼런스 대비" value={clip.lift} color={C.green} />
                    </div>
                  </div>
                </div>
              ))}
              <div style={{ background: C.violetSoft, border: "1px solid #E7E3FB", borderRadius: 11, padding: "14px 15px", marginTop: 4 }}>
                <div style={{ fontSize: 12, color: C.ink, lineHeight: 1.55 }}>
                  단순히 영상을 자른 게 아니라 <b>시청자가 무엇에 반응하는지 학습</b>한 결과입니다. 이 귀인 흐름이 다음 편집의 기준이 됩니다.
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function Mini({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: C.muted }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, marginTop: 1, color: color || C.ink }}>{value}</div>
    </div>
  );
}
