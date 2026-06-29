"use client";

import { ShortcutEditor } from "../ShortcutEditor";
import { C, SHELL_BG } from "@/lib/console/theme";
import { useConsole } from "./ConsoleProvider";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { GlobalModals } from "./GlobalModals";
import { DashboardScreen } from "./screens/DashboardScreen";
import { ChannelsScreen } from "./screens/ChannelsScreen";
import { StudioScreen } from "./screens/StudioScreen";
import { ScheduleScreen } from "./screens/ScheduleScreen";
import { CommerceScreen } from "./screens/CommerceScreen";
import { ReportScreen } from "./screens/ReportScreen";
import { SettingsScreen } from "./screens/SettingsScreen";

export function ConsoleShell() {
  const { nav, toast, editorClip, setEditorClipId, saveShortcutEditor, applyBusy, defChannel } = useConsole();
  return (
    <div style={{ display: "flex", height: "100vh", width: "100%", overflow: "hidden", ...SHELL_BG }}>
      <Sidebar />
      <div style={{ flex: "1 1 auto", display: "flex", flexDirection: "column", minWidth: 0 }}>
        <Topbar />
        <div style={{ flex: "1 1 auto", overflowY: "auto", overflowX: "hidden" }}>
          {nav === "dashboard" && <DashboardScreen />}
          {nav === "channels" && <ChannelsScreen />}
          {nav === "studio" && <StudioScreen />}
          {nav === "schedule" && <ScheduleScreen />}
          {nav === "commerce" && <CommerceScreen />}
          {nav === "report" && <ReportScreen />}
          {nav === "settings" && <SettingsScreen />}
        </div>
      </div>

      <GlobalModals />

      {editorClip && (
        <ShortcutEditor
          key={editorClip.id}
          clip={{ ...editorClip, channelName: defChannel?.name || "공식 채널명" }}
          onClose={() => setEditorClipId(null)}
          onSave={saveShortcutEditor}
          saving={applyBusy}
        />
      )}

      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 26,
            left: "50%",
            transform: "translateX(-50%)",
            background: C.ink,
            color: "#fff",
            padding: "11px 18px",
            borderRadius: 12,
            fontSize: 13,
            fontWeight: 600,
            zIndex: 80,
            boxShadow: "0 14px 36px -12px rgba(0,0,0,.5)",
            animation: "scFade .2s ease both",
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
