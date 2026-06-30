"use client";

import { useState } from "react";
import { C, card, ghostBtn } from "@/lib/console/theme";
import { useConsole } from "../ConsoleProvider";

const COMMERCE_ACCOUNTS = [
  { k: "coupang", name: "쿠팡 파트너스", color: "#346AFF" },
  { k: "oliveyoung", name: "올리브영 쇼핑 파트너", color: "#3CB05A" },
  { k: "musinsa", name: "무신사 파트너", color: "#16181D" },
  { k: "st11", name: "11번가 파트너스", color: "#FF5A4D" },
];

const NOTIF_DEFS = [
  { k: "revenue", label: "수익 발생 알림", desc: "제휴 수익이 정산될 때" },
  { k: "deploy", label: "배포 완료 알림", desc: "커머스 콘텐츠 배포가 끝나면" },
  { k: "weekly", label: "주간 리포트", desc: "매주 월요일 요약" },
];

export function SettingsScreen() {
  const c = useConsole();
  const [acct, setAcct] = useState<Record<string, boolean>>({ coupang: true, oliveyoung: true, musinsa: true, st11: false });
  const [notif, setNotif] = useState<Record<string, boolean>>({ revenue: true, deploy: true, weekly: false });

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "26px 28px 60px" }}>
      <div style={{ fontSize: 19, fontWeight: 750, letterSpacing: "-.4px", marginBottom: 18 }}>설정</div>

      {/* workspace */}
      <div style={card({ padding: "20px 22px", marginBottom: 14 })}>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "-.2px", marginBottom: 14 }}>워크스페이스</div>
        <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
          <div style={{ width: 44, height: 44, borderRadius: 11, background: C.ink, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 17, letterSpacing: "-.5px" }}>D</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: "-.2px" }}>STEP D · KT ENA 워크스페이스</div>
            <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>담당 · {c.me?.name || "게스트"}{c.me?.email ? ` (${c.me.email})` : ""}</div>
          </div>
          {c.me ? (
            <button onClick={c.logout} style={{ ...ghostBtn, padding: "7px 13px", fontSize: 11.5 }}>로그아웃</button>
          ) : (
            <button onClick={c.login} className="hv-btn-primary" style={{ border: "none", background: C.violet, color: "#fff", borderRadius: 8, padding: "7px 13px", fontSize: 11.5, fontWeight: 650, cursor: "pointer" }}>Google 로그인</button>
          )}
        </div>
      </div>

      {/* connected sources (dummy) */}
      <div style={card({ padding: "20px 22px", marginBottom: 14 })}>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "-.2px", marginBottom: 6 }}>연동 소스</div>
        {[
          { name: "방송국 CMS", sub: "ENA Media Center", on: true },
          { name: "회사 드라이브", sub: "STEP D Drive", on: true },
        ].map((s) => (
          <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 11, padding: "12px 0", borderBottom: `1px solid ${C.lineSoft}` }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: s.on ? C.green : "#D5D9DF", flex: "0 0 8px" }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: "-.2px" }}>{s.name}</div>
              <div style={{ fontSize: 11, color: C.dim, marginTop: 1 }}>{s.sub}</div>
            </div>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: s.on ? C.green : C.muted }}>{s.on ? "연결됨" : "연결 안 됨"}</span>
          </div>
        ))}
      </div>

      {/* youtube channels (real) */}
      <div style={card({ padding: "20px 22px", marginBottom: 14 })}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "-.2px" }}>YouTube 채널</div>
          <button onClick={c.connectYouTube} className="hv-btn-primary" style={{ border: "none", background: C.violet, color: "#fff", borderRadius: 8, padding: "6px 12px", fontSize: 11.5, fontWeight: 650, cursor: "pointer" }}>채널 연결</button>
        </div>
        {c.channels.length === 0 ? (
          <div style={{ fontSize: 12.5, color: C.muted, padding: "10px 0" }}>연결된 채널이 없어요. Google 로그인 후 YouTube 채널을 연결하세요.</div>
        ) : (
          c.channels.map((ch) => (
            <div key={ch.id} style={{ display: "flex", alignItems: "center", gap: 11, padding: "12px 0", borderBottom: `1px solid ${C.lineSoft}` }}>
              <div style={{ width: 26, height: 26, borderRadius: "50%", background: ch.color, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, flex: "0 0 26px" }}>{ch.name.slice(0, 1)}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: "-.2px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ch.name}{ch.isDefault && <span style={{ fontSize: 10, color: C.violet, marginLeft: 6 }}>기본</span>}</div>
                <div style={{ fontSize: 11, color: C.dim, marginTop: 1 }}>{ch.handle}</div>
              </div>
              {!ch.isDefault && <button onClick={() => c.makeDefaultChannel(ch.id)} disabled={c.channelBusy === ch.id} style={{ ...ghostBtn, padding: "5px 11px", fontSize: 11 }}>기본 설정</button>}
              <button onClick={() => c.removeChannel(ch.id, ch.name)} disabled={c.channelBusy === ch.id} style={{ ...ghostBtn, padding: "5px 11px", fontSize: 11, color: C.danger, borderColor: "#F5C9C2" }}>해제</button>
            </div>
          ))
        )}
      </div>

      {/* commerce affiliate accounts (local) */}
      <div style={card({ padding: "20px 22px", marginBottom: 14 })}>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "-.2px", marginBottom: 6 }}>커머스 제휴 계정</div>
        {COMMERCE_ACCOUNTS.map((a) => {
          const on = !!acct[a.k];
          return (
            <div key={a.k} style={{ display: "flex", alignItems: "center", gap: 11, padding: "12px 0", borderBottom: `1px solid ${C.lineSoft}` }}>
              <span style={{ width: 26, height: 26, borderRadius: 7, background: a.color, flex: "0 0 26px" }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: "-.2px" }}>{a.name}</div>
              </div>
              <button onClick={() => setAcct((s) => ({ ...s, [a.k]: !s[a.k] }))} style={{ ...ghostBtn, padding: "6px 13px", fontSize: 11.5, fontWeight: 650, background: on ? C.greenSoft : "#fff", color: on ? C.green : C.violet, border: on ? "1px solid #C8EEDC" : `1px solid ${C.violet}` }}>{on ? "연결됨" : "연결"}</button>
            </div>
          );
        })}
      </div>

      {/* settlement (dummy) */}
      <div style={card({ padding: "20px 22px", marginBottom: 14 })}>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "-.2px", marginBottom: 14 }}>정산</div>
        <div style={{ display: "flex", alignItems: "center", gap: 11, paddingBottom: 12, borderBottom: `1px solid ${C.lineSoft}` }}>
          <div style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>정산 계좌</div>
          <span style={{ fontSize: 12.5, color: C.body, fontFeatureSettings: "'tnum' 1" }}>국민 ····2847 · KT ENA(주)</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 11, paddingTop: 12 }}>
          <div style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>정산 주기</div>
          <span style={{ fontSize: 12.5, color: C.body }}>월 1회 · 익월 15일</span>
        </div>
      </div>

      {/* notifications (local) */}
      <div style={card({ padding: "20px 22px" })}>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "-.2px", marginBottom: 6 }}>알림</div>
        {NOTIF_DEFS.map((n) => {
          const on = !!notif[n.k];
          return (
            <div key={n.k} style={{ display: "flex", alignItems: "center", gap: 11, padding: "12px 0", borderBottom: `1px solid ${C.lineSoft}` }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: "-.2px" }}>{n.label}</div>
                <div style={{ fontSize: 11, color: C.dim, marginTop: 1 }}>{n.desc}</div>
              </div>
              <div onClick={() => setNotif((s) => ({ ...s, [n.k]: !s[n.k] }))} style={{ width: 40, height: 23, borderRadius: 12, background: on ? C.violet : "#D5D9DF", position: "relative", cursor: "pointer", transition: "background .15s", flex: "0 0 40px" }}>
                <div style={{ position: "absolute", top: 2, left: on ? 19 : 2, width: 19, height: 19, borderRadius: "50%", background: "#fff", transition: "left .15s", boxShadow: "0 1px 3px rgba(0,0,0,.2)" }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
