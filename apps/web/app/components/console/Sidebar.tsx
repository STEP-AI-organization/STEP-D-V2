"use client";

import { C } from "@/lib/console/theme";
import { useConsole, type NavKey } from "./ConsoleProvider";

const NAV: { key: NavKey; label: string }[] = [
  { key: "dashboard", label: "대시보드" },
  { key: "channels", label: "채널별" },
  { key: "studio", label: "스튜디오" },
  { key: "schedule", label: "배포 스케줄" },
  { key: "commerce", label: "커머스" },
  { key: "report", label: "리포트" },
  { key: "settings", label: "설정" },
];

export function Sidebar() {
  const { nav, setNav, me } = useConsole();
  return (
    <aside
      style={{
        width: 236,
        flex: "0 0 236px",
        background: C.panel,
        borderRight: `1px solid ${C.line}`,
        display: "flex",
        flexDirection: "column",
        padding: "16px 12px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 8px 16px 8px" }}>
        <div style={{ width: 24, height: 24, borderRadius: 7, background: C.ink, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 13, letterSpacing: "-.5px" }}>
          D
        </div>
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1 }}>
          <span style={{ fontWeight: 750, fontSize: 14, letterSpacing: "-.3px" }}>STEP D</span>
          <span style={{ fontSize: 10.5, color: C.muted, marginTop: 3, letterSpacing: "-.1px" }}>KT ENA 워크스페이스</span>
        </div>
      </div>

      <div style={{ height: 4 }} />
      {NAV.map((it) => {
        const active = nav === it.key;
        return (
          <div
            key={it.key}
            className={active ? undefined : "hv-nav"}
            onClick={() => setNav(it.key)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 9px",
              borderRadius: 8,
              cursor: "pointer",
              fontSize: 13.5,
              fontWeight: active ? 700 : 500,
              color: active ? C.ink : C.body,
              background: active ? C.violetSoft : "transparent",
              userSelect: "none",
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: active ? C.violet : "#D5D9DF", flex: "0 0 7px" }} />
            <span style={{ flex: 1, letterSpacing: "-.2px" }}>{it.label}</span>
          </div>
        );
      })}

      <div style={{ flex: 1 }} />

      <a
        href="https://ktaena.com"
        target="_blank"
        rel="noreferrer"
        className="hv-cyan"
        style={{ textDecoration: "none", display: "block", border: `1px solid ${C.line}`, borderRadius: 10, padding: "11px 12px", marginBottom: 8 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: C.cyanInk, fontWeight: 650 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.cyan, display: "inline-block" }} />
          Live · 스튜디오 시스템
        </div>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: C.ink, marginTop: 5, letterSpacing: "-.2px" }}>KT ENA 스튜디오 보기 →</div>
        <div style={{ fontSize: 10.5, color: C.muted, marginTop: 2 }}>ktaena.com · AENA</div>
      </a>

      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: 8, borderRadius: 8 }}>
        <div style={{ width: 26, height: 26, borderRadius: "50%", background: C.violetSoft2, color: C.violet, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700 }}>
          {(me?.name || "게").slice(0, 1)}
        </div>
        <div style={{ lineHeight: 1.2 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>{me?.name || "게스트"}</div>
          <div style={{ fontSize: 10.5, color: C.muted }}>콘텐츠 운영팀</div>
        </div>
      </div>
    </aside>
  );
}
