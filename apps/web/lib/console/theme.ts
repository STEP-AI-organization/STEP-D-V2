import type { CSSProperties } from "react";

/* ============================================================================
 * Console design tokens — ported 1:1 from the "수익 콘솔" Claude-Design HTML.
 * The HTML is inline-styled; these constants are the single source of truth so
 * every screen renders identically to the mockup.
 * ========================================================================== */

export const C = {
  // surfaces
  bg: "#F6F7F9",
  panel: "#FFFFFF",
  line: "#ECEEF2",
  lineSoft: "#F1F2F4",
  rowHover: "#FAFAFB",
  rowHover2: "#F4F5F7",
  // text
  ink: "#16181D",
  sub: "#3A4049",
  body: "#5B6470",
  muted: "#9AA1AC",
  dim: "#AEB4BE",
  faint: "#C2C7CF",
  // accent
  violet: "#6C5CE7",
  violetDark: "#5B4BD6",
  violetSoft: "#F2F0FE",
  violetSoft2: "#EDE9FE",
  cyan: "#22C3E0",
  cyanInk: "#0A8FA6",
  cyanSoft: "#ECFAFD",
  cyanLine: "#BDEAF2",
  green: "#0FA968",
  greenSoft: "#E7F7F0",
  gold: "#B07A1E",
  goldSoft: "#FDF4E3",
  danger: "#E5484D",
} as const;

export const FONT =
  "'Pretendard Variable',Pretendard,system-ui,-apple-system,'Segoe UI',sans-serif";

/** Root surface — applied by ConsoleShell to fill the viewport. */
export const SHELL_BG: CSSProperties = {
  fontFamily: FONT,
  color: C.ink,
  background: C.bg,
  fontFeatureSettings: "'tnum' 1",
  WebkitFontSmoothing: "antialiased",
};

/** White rounded card used across every screen. */
export const card = (extra?: CSSProperties): CSSProperties => ({
  background: C.panel,
  border: `1px solid ${C.line}`,
  borderRadius: 14,
  ...extra,
});

/** Small status / "추정" style pill. */
export const pill = (fg: string, bg: string, bd?: string): CSSProperties => ({
  fontSize: 10,
  fontWeight: 700,
  color: fg,
  background: bg,
  border: bd ? `1px solid ${bd}` : "none",
  padding: "2px 7px",
  borderRadius: 5,
  letterSpacing: ".2px",
  display: "inline-block",
});

/** Estimate badge — used wherever a number is dummy/derived, per plan decision #4/#5. */
export const estimateBadge: CSSProperties = pill(C.cyanInk, C.cyanSoft, C.cyanLine);

export const input: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  border: `1px solid ${C.line}`,
  borderRadius: 10,
  background: "#fff",
  fontSize: 13.5,
  color: C.ink,
  fontFamily: "inherit",
  outline: "none",
};

export const label: CSSProperties = {
  display: "block",
  fontSize: 11,
  fontWeight: 700,
  color: C.muted,
  marginBottom: 7,
};

export const primaryBtn: CSSProperties = {
  border: "none",
  borderRadius: 10,
  background: C.violet,
  color: "#fff",
  fontSize: 13,
  fontWeight: 700,
  fontFamily: "inherit",
  cursor: "pointer",
  letterSpacing: "-.2px",
};

export const ghostBtn: CSSProperties = {
  border: `1px solid ${C.line}`,
  borderRadius: 10,
  background: "#fff",
  color: C.body,
  fontSize: 13,
  fontWeight: 650,
  fontFamily: "inherit",
  cursor: "pointer",
};

/* Segmented tab look (트렌드/범위/기간 토글). */
export const segWrap: CSSProperties = {
  display: "flex",
  gap: 3,
  background: C.lineSoft,
  padding: 3,
  borderRadius: 8,
};
export const segBtn = (active: boolean): CSSProperties => ({
  border: "none",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 11.5,
  fontWeight: 600,
  padding: "4px 11px",
  borderRadius: 6,
  color: active ? C.ink : "#8A929E",
  background: active ? "#FFFFFF" : "transparent",
  boxShadow: active ? "0 1px 2px rgba(16,18,24,.08)" : "none",
});

/* Poster gradients for clip thumbnails (kept from the original app so clip
 * cards keep their colourful look when no real thumbnail exists). */
export const POSTERS = [
  { g: "linear-gradient(160deg,#FF8A4C 0%,#3A1D10 80%)", glow: "rgba(255,138,76,.55)" },
  { g: "linear-gradient(160deg,#6C5CE7 0%,#15102A 80%)", glow: "rgba(108,92,231,.55)" },
  { g: "linear-gradient(160deg,#15A088 0%,#0B1C19 80%)", glow: "rgba(21,160,136,.5)" },
  { g: "linear-gradient(160deg,#E84A5F 0%,#1E0C11 80%)", glow: "rgba(232,74,95,.5)" },
  { g: "linear-gradient(160deg,#3C77C2 0%,#0C1521 80%)", glow: "rgba(60,119,194,.5)" },
  { g: "linear-gradient(160deg,#D69E2E 0%,#1B140A 80%)", glow: "rgba(214,158,46,.5)" },
  { g: "linear-gradient(160deg,#B24FA0 0%,#180D1A 80%)", glow: "rgba(178,79,160,.5)" },
  { g: "linear-gradient(160deg,#E0673B 0%,#1A0D07 80%)", glow: "rgba(224,103,59,.5)" },
];

export const CHANNEL_COLORS = ["#6C5CE7", "#22C3E0", "#0FA968", "#E0A21F", "#3C77C2", "#B24FA0", "#E0673B", "#15A088"];
