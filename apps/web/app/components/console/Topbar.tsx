"use client";

import { Bell, LogOut, Plus, Search } from "lucide-react";
import { C } from "@/lib/console/theme";
import { useConsole, type NavKey } from "./ConsoleProvider";

const TITLES: Record<NavKey, string> = {
  dashboard: "수익 콘솔",
  channels: "채널별",
  studio: "스튜디오",
  schedule: "배포 스케줄",
  commerce: "커머스",
  report: "리포트",
  settings: "설정",
};

export function Topbar() {
  const { nav, me, login, logout, openUpload } = useConsole();
  return (
    <header
      style={{
        flex: "0 0 auto",
        height: 58,
        background: "#FFFFFFcc",
        backdropFilter: "saturate(1.1) blur(6px)",
        borderBottom: `1px solid ${C.line}`,
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "0 24px",
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-.3px" }}>{TITLES[nav]}</div>
      <div style={{ flex: 1 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 8, background: C.rowHover2, border: `1px solid ${C.line}`, borderRadius: 9, padding: "7px 11px", width: 210, color: C.muted, fontSize: 12.5 }}>
        <Search size={14} />
        <span>프로그램·클립 검색</span>
      </div>
      <button className="hv-soft" style={{ position: "relative", width: 36, height: 36, border: `1px solid ${C.line}`, background: "#fff", borderRadius: 9, cursor: "pointer", color: C.body, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Bell size={15} />
        <span style={{ position: "absolute", top: 8, right: 9, width: 6, height: 6, background: C.violet, borderRadius: "50%" }} />
      </button>
      {me ? (
        <button onClick={logout} className="hv-soft" title="로그아웃" style={{ width: 36, height: 36, border: `1px solid ${C.line}`, background: "#fff", borderRadius: 9, cursor: "pointer", color: C.body, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <LogOut size={15} />
        </button>
      ) : (
        <button onClick={login} className="hv-soft" style={{ height: 36, border: `1px solid ${C.line}`, background: "#fff", borderRadius: 9, padding: "0 13px", cursor: "pointer", color: C.body, fontSize: 13, fontWeight: 650 }}>
          Google 로그인
        </button>
      )}
      <button
        onClick={openUpload}
        className="hv-btn-primary"
        style={{ display: "flex", alignItems: "center", gap: 6, background: C.violet, color: "#fff", border: "none", borderRadius: 9, padding: "0 15px", height: 36, fontSize: 13, fontWeight: 650, cursor: "pointer", letterSpacing: "-.2px" }}
      >
        <Plus size={15} />새 콘텐츠
      </button>
    </header>
  );
}
