"use client";

import { useMemo, useState } from "react";
import { C, card, estimateBadge, segBtn, segWrap } from "@/lib/console/theme";
import { fmtKor } from "@/lib/console/format";
import { DUMMY_CHANNELS, type DummyChannel } from "@/lib/console/dummy";
import { GrowthLine } from "../charts";
import { useConsole } from "../ConsoleProvider";

const gradeStyle = (g: string) => {
  const ch = g.charAt(0);
  if (ch === "A") return { fg: C.green, bg: C.greenSoft };
  if (ch === "B") return { fg: C.cyanInk, bg: C.cyanSoft };
  return { fg: C.gold, bg: C.goldSoft };
};

type ChView = DummyChannel & { real: boolean; realId?: string; isDefault?: boolean };

export function ChannelsScreen() {
  const c = useConsole();
  const [period, setPeriod] = useState<"일" | "월" | "연">("월");

  // Merge real connected channels with social-blade estimates (plan decision #4).
  const views: ChView[] = useMemo(() => {
    if (c.channels.length) {
      return c.channels.map((ch, i) => {
        const d = DUMMY_CHANNELS[i % DUMMY_CHANNELS.length];
        return {
          ...d,
          real: true,
          realId: ch.id,
          isDefault: ch.isDefault,
          name: ch.name,
          handle: ch.handle,
          subs: ch.subs !== "—" ? ch.subs : d.subs,
          views: ch.views !== "—" ? ch.views : d.views,
        };
      });
    }
    return DUMMY_CHANNELS.map((d) => ({ ...d, real: false }));
  }, [c.channels]);

  const selected = c.openChannel ? views.find((v) => v.realId === c.openChannel) : null;

  /* ---------------- DETAIL ---------------- */
  if (selected) {
    const real = c.channels.find((ch) => ch.id === selected.realId);
    const gs = gradeStyle(selected.grade);

    // 12-month subscriber growth (estimate, derived from d30 rate)
    const growth = (() => {
      const g: number[] = [];
      let v = selected.subsN;
      for (let i = 0; i < 12; i++) {
        g.unshift(Math.round(v));
        v = v / (1 + (selected.d30subsPct / 100) * (0.85 + 0.12 * Math.cos(i)));
      }
      const months: string[] = [];
      const now = new Date(2026, 5, 1);
      for (let i = 0; i < 12; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - (11 - i), 1);
        months.push(`${d.getMonth() + 1}월`);
      }
      return { g, months };
    })();

    // daily table (10 days, estimate)
    const daily = Array.from({ length: 10 }, (_, i) => {
      const d = new Date(2026, 5, 29 - i);
      const wob = 1 + 0.28 * Math.sin(i * 1.25 + 1);
      return {
        date: `${d.getMonth() + 1}/${d.getDate()}`,
        subs: "+" + Math.round((selected.d30subsN / 30) * wob).toLocaleString("ko-KR"),
        views: "+" + fmtKor(Math.round((selected.d30viewsN / 30) * wob)),
        earn: "₩" + Math.round((selected.estLowN / 30) * wob).toLocaleString("ko-KR"),
      };
    });

    // content rank — real videos if loaded, else dummy uploads + extras
    const realVideos = real?.videos || [];
    const rankItems = (realVideos.length
      ? realVideos.slice(0, 6).map((v) => ({ t: v.title, views: v.views + "회", id: v.id }))
      : selected.uploads.concat([{ t: "레전드 명장면 TOP10", when: "", v: "" }, { t: "비하인드 비공개 컷", when: "", v: "" }, { t: "하이라이트 몰아보기", when: "", v: "" }, { t: "역대급 반전 모음", when: "", v: "" }])
          .slice(0, 6)
          .map((u, i) => ({ t: u.t, views: fmtKor(Math.max(1200, Math.round((selected.d30viewsN * (period === "일" ? 0.045 : period === "연" ? 11.5 : 1) * (0.92 - i * 0.11))))) + "회", id: String(i) }))) as { t: string; views: string; id: string }[];

    const periodTabs: ("일" | "월" | "연")[] = ["일", "월", "연"];
    const curVideo = real?.videos.find((v) => v.id === c.openVideo) || null;
    const summary = curVideo && c.openChannel ? c.commentSummary[`${c.openChannel}|${curVideo.id}`] : null;

    return (
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "26px 28px 60px" }}>
        <div onClick={c.closeChannel} className="hv-darklink" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: C.body, fontWeight: 600, cursor: "pointer", marginBottom: 16 }}>← 채널 목록</div>

        {/* header */}
        <section style={card({ padding: "24px 26px", marginBottom: 14, display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" })}>
          <div style={{ position: "relative", flex: "0 0 60px" }}>
            <div style={{ width: 60, height: 60, borderRadius: "50%", background: selected.avBg, color: selected.avFg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, fontWeight: 800 }}>{selected.initial}</div>
            <span style={{ position: "absolute", bottom: 0, right: 0, width: 20, height: 20, borderRadius: "50%", background: selected.platColor, border: "3px solid #fff" }} />
          </div>
          <div style={{ flex: "1 1 240px", minWidth: 200 }}>
            <div style={{ fontSize: 20, fontWeight: 750, letterSpacing: "-.5px" }}>{selected.name}</div>
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 4 }}>{selected.handle} · {selected.platform} · {selected.country} · {selected.type}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 32, fontWeight: 800, color: gs.fg, background: gs.bg, width: 64, height: 64, borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", letterSpacing: "-1px" }}>{selected.grade}</div>
            <div style={{ fontSize: 10, color: C.muted, marginTop: 6, fontWeight: 600 }}>성장 등급 <span style={estimateBadge}>추정</span></div>
          </div>
        </section>

        {/* stat tiles */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14, marginBottom: 14 }}>
          <Tile label="구독자" value={selected.subs} sub={`▲ ${selected.d30subsPct}% · 30일`} subColor={C.green} />
          <Tile label="총 조회수" value={selected.views} sub={`▲ ${selected.d30viewsPct}% · 30일`} subColor={C.green} />
          <Tile label="영상 수" value={selected.videos} sub="누적 업로드" subColor={C.muted} />
          <Tile label="개설일" value={selected.created} sub="채널 개설" subColor={C.muted} />
        </div>

        {/* 30d + earnings */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1.2fr", gap: 14, marginBottom: 14 }}>
          <div style={card({ padding: "18px 20px" })}>
            <div style={{ fontSize: 11.5, color: C.body, fontWeight: 600 }}>최근 30일 구독자</div>
            <div style={{ fontSize: 22, fontWeight: 750, color: C.green, marginTop: 9, letterSpacing: "-.5px" }}>+{selected.d30subsN.toLocaleString("ko-KR")}</div>
          </div>
          <div style={card({ padding: "18px 20px" })}>
            <div style={{ fontSize: 11.5, color: C.body, fontWeight: 600 }}>최근 30일 조회수</div>
            <div style={{ fontSize: 22, fontWeight: 750, color: C.green, marginTop: 9, letterSpacing: "-.5px" }}>+{fmtKor(selected.d30viewsN)}</div>
          </div>
          <div style={card({ padding: "18px 20px", background: "#F4F2FE", border: "1px solid #E4DEFB" })}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ fontSize: 11.5, color: "#7C6FD6", fontWeight: 600 }}>예상 수익</span>
              <span style={estimateBadge}>추정</span>
            </div>
            <div style={{ fontSize: 18, fontWeight: 750, marginTop: 9, letterSpacing: "-.4px", color: C.ink }}>{selected.estMonthly}<span style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}> /월</span></div>
            <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>연 {selected.estYearly}</div>
          </div>
        </div>

        {/* growth + rank */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 14, marginBottom: 14 }}>
          <div style={card({ padding: "20px 22px" })}>
            <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "-.2px" }}>구독자 추이 <span style={estimateBadge}>추정</span></div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 3, marginBottom: 12 }}>최근 12개월</div>
            <GrowthLine values={growth.g} months={growth.months} />
          </div>
          <div style={card({ padding: "20px 22px" })}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "-.2px" }}>조회수 순위</div>
              <div style={segWrap}>
                {periodTabs.map((t) => (
                  <button key={t} onClick={() => setPeriod(t)} style={segBtn(period === t)}>{t}간</button>
                ))}
              </div>
            </div>
            {rankItems.map((r, i) => (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: `1px solid ${C.lineSoft}` }}>
                <span style={{ flex: "0 0 22px", width: 22, height: 22, borderRadius: 6, background: i === 0 ? C.violetSoft2 : i < 3 ? C.lineSoft : "transparent", color: i === 0 ? C.violet : i < 3 ? C.ink : C.muted, fontSize: 11.5, fontWeight: 750, display: "flex", alignItems: "center", justifyContent: "center", fontFeatureSettings: "'tnum' 1" }}>{i + 1}</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: C.sub, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.t}</span>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: C.ink, fontFeatureSettings: "'tnum' 1" }}>{r.views}</span>
              </div>
            ))}
            {!realVideos.length && <div style={{ fontSize: 10.5, color: C.faint, marginTop: 12 }}>실제 채널 연결 시 실데이터로 대체됩니다.</div>}
          </div>
        </div>

        {/* daily table */}
        <div style={card({ overflow: "hidden", marginBottom: 14 })}>
          <div style={{ padding: "17px 20px 13px", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>일별 통계</span>
            <span style={estimateBadge}>추정</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", padding: "0 20px 9px", fontSize: 11, color: C.muted, fontWeight: 600, borderBottom: `1px solid ${C.lineSoft}` }}>
            <span>날짜</span><span style={{ textAlign: "right" }}>구독자</span><span style={{ textAlign: "right" }}>조회수</span><span style={{ textAlign: "right" }}>예상 수익</span>
          </div>
          {daily.map((d) => (
            <div key={d.date} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", alignItems: "center", padding: "11px 20px", borderBottom: `1px solid ${C.lineSoft}` }}>
              <span style={{ fontSize: 12.5, color: C.body, fontFeatureSettings: "'tnum' 1" }}>{d.date}</span>
              <span style={{ textAlign: "right", fontSize: 12.5, fontWeight: 650, color: C.green, fontFeatureSettings: "'tnum' 1" }}>{d.subs}</span>
              <span style={{ textAlign: "right", fontSize: 12.5, fontWeight: 650, color: C.green, fontFeatureSettings: "'tnum' 1" }}>{d.views}</span>
              <span style={{ textAlign: "right", fontSize: 12.5, fontWeight: 700, color: C.ink, fontFeatureSettings: "'tnum' 1" }}>{d.earn}</span>
            </div>
          ))}
        </div>

        {/* recent uploads (real videos clickable → comment summary) */}
        <div style={card({ padding: "20px 22px" })}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>최근 업로드</div>
          {(realVideos.length
            ? realVideos.slice(0, 4).map((v) => ({ id: v.id, title: v.title, date: v.date, views: v.views, thumbnailUrl: v.thumbnailUrl ?? null }))
            : selected.uploads.map((u, i) => ({ id: String(i), title: u.t, date: u.when, views: u.v, thumbnailUrl: null as string | null }))
          ).map((u) => (
            <div key={u.id} onClick={() => real && c.setOpenVideo(u.id)} className={real ? "hv-row" : undefined} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 8px", borderBottom: `1px solid ${C.lineSoft}`, cursor: real ? "pointer" : "default", borderRadius: 7 }}>
              <div style={{ width: 54, height: 34, borderRadius: 7, background: C.lineSoft, flex: "0 0 54px", overflow: "hidden" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {u.thumbnailUrl ? <img src={u.thumbnailUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: "-.2px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{u.title}</div>
                <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{u.date}</div>
              </div>
              <span style={{ fontSize: 12.5, fontWeight: 650, color: C.sub, fontFeatureSettings: "'tnum' 1" }}>{u.views}</span>
            </div>
          ))}

          {curVideo && (
            <div style={{ marginTop: 14, background: C.violetSoft, borderRadius: 11, padding: "14px 15px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: C.violet }}>AI 댓글 요약</span>
                {!summary && <button onClick={() => c.openChannel && c.loadCommentSummary(c.openChannel, curVideo.id)} style={{ marginLeft: "auto", border: "none", background: C.violet, color: "#fff", fontSize: 11, fontWeight: 650, padding: "4px 10px", borderRadius: 6, cursor: "pointer" }}>요약하기</button>}
              </div>
              {summary?.busy ? (
                <div style={{ fontSize: 12.5, color: C.muted }}>요약 중…</div>
              ) : summary?.summary ? (
                <>
                  <div style={{ fontSize: 12.5, color: C.sub, lineHeight: 1.6 }}>{summary.summary}</div>
                  {summary.themes?.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                      {summary.themes.map((t) => <span key={t} style={{ fontSize: 11, color: C.violet, background: "#fff", padding: "2px 8px", borderRadius: 5 }}>{t}</span>)}
                    </div>
                  )}
                </>
              ) : (
                <div style={{ fontSize: 12, color: C.muted }}>이 영상의 댓글을 AI로 요약합니다.</div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ---------------- LIST ---------------- */
  return (
    <div style={{ maxWidth: 1180, margin: "0 auto", padding: "26px 28px 60px" }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 18 }}>
        <div>
          <div style={{ fontSize: 19, fontWeight: 750, letterSpacing: "-.4px" }}>등록 채널</div>
          <div style={{ fontSize: 12.5, color: C.muted, marginTop: 4 }}>운영 중인 채널 {views.length}개 · 카드를 누르면 채널 상세 분석 →</div>
        </div>
        {c.channels.length ? (
          <span style={{ fontSize: 10, fontWeight: 700, color: C.cyanInk, background: C.cyanSoft, border: `1px solid ${C.cyanLine}`, padding: "3px 8px", borderRadius: 5 }}>채널 API 연동 · 실시간</span>
        ) : (
          <button onClick={c.connectYouTube} className="hv-btn-primary" style={{ border: "none", background: C.violet, color: "#fff", fontSize: 12, fontWeight: 650, padding: "8px 14px", borderRadius: 8, cursor: "pointer" }}>YouTube 채널 연결</button>
        )}
      </div>

      {!c.channels.length && (
        <div style={{ ...card({ padding: "12px 16px", marginBottom: 16, background: C.violetSoft, border: "1px solid #E4DEFB" }), fontSize: 12.5, color: "#5B4BD6" }}>
          데모 데이터를 보고 있어요. 실제 채널을 연결하면 구독자·조회수·영상이 실시간으로 채워집니다.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14 }}>
        {views.map((v) => {
          const gs = gradeStyle(v.grade);
          return (
            <div key={v.realId || v.id} onClick={() => v.real && v.realId && c.openChannelDetail(v.realId)} className="hv-card" style={card({ padding: 18, cursor: v.real ? "pointer" : "default" })}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ position: "relative", flex: "0 0 46px" }}>
                  <div style={{ width: 46, height: 46, borderRadius: "50%", background: v.avBg, color: v.avFg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 800, letterSpacing: "-.5px" }}>{v.initial}</div>
                  <span style={{ position: "absolute", bottom: -1, right: -1, width: 16, height: 16, borderRadius: "50%", background: v.platColor, border: "2.5px solid #fff" }} />
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: "-.2px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v.name}</div>
                  <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v.handle}</div>
                </div>
                <span style={{ flex: "0 0 auto", fontSize: 12, fontWeight: 800, color: gs.fg, background: gs.bg, padding: "4px 9px", borderRadius: 7 }}>{v.grade}</span>
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 16, borderTop: `1px solid ${C.lineSoft}`, paddingTop: 14 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10.5, color: C.muted, fontWeight: 600 }}>구독자</div>
                  <div style={{ fontSize: 17, fontWeight: 750, marginTop: 3, letterSpacing: "-.5px" }}>{v.subs}</div>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10.5, color: C.muted, fontWeight: 600 }}>총 조회수</div>
                  <div style={{ fontSize: 17, fontWeight: 750, marginTop: 3, letterSpacing: "-.5px" }}>{v.views}</div>
                </div>
                <div style={{ flex: "0 0 auto", display: "flex", alignItems: "flex-end" }}>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: C.green, background: C.greenSoft, padding: "3px 9px", borderRadius: 6 }}>▲ {v.d30subsPct}%</span>
                </div>
              </div>
              <div style={{ fontSize: 10.5, color: C.faint, marginTop: 10 }}>30일 구독자 +{v.d30subsN.toLocaleString("ko-KR")} · {v.platform} {!v.real && "· 추정"}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Tile({ label, value, sub, subColor }: { label: string; value: string; sub: string; subColor: string }) {
  return (
    <div style={card({ padding: "17px 18px" })}>
      <div style={{ fontSize: 11.5, color: C.body, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 750, letterSpacing: "-.8px", marginTop: 8 }}>{value}</div>
      <div style={{ fontSize: 11, color: subColor, fontWeight: 700, marginTop: 7 }}>{sub}</div>
    </div>
  );
}
