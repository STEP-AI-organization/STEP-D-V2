import { API } from "./api";

/** seconds → m:ss (the Lab's canonical time format). */
export const fmt = (s: number): string =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** seconds → h:mm:ss for longform positions past an hour, else m:ss. */
export const fmtLong = (s: number): string => {
  const h = Math.floor(s / 3600);
  if (h < 1) return fmt(s);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

/** "1:23" | "83" → 83 seconds. Returns null when unparseable. */
export const parseTime = (raw: string): number | null => {
  const t = raw.trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const parts = t.split(":").map((p) => p.trim());
  if (!parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
};

export const nfmt = (n: number): string => n.toLocaleString("ko-KR");

/** 구간 '길이' 표기: 1분 미만은 "48초", 넘으면 "1분 12초". */
export const fmtDur = (sec: number): string => {
  const s = Math.round(Math.abs(sec));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}분 ${r}초` : `${m}분`;
};

/** Scene frame images are served by basename from the latest analysis dir. */
export const frameUrl = (f: string): string => `${API}/api/lab/frames/${f.split("/").pop()}`;

export const portraitUrl = (name: string): string =>
  `${API}/api/lab/portraits/${encodeURIComponent(name)}`;
