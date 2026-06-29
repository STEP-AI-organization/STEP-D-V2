import { mediaUrl } from "@/lib/api";

/* ============================================================================
 * Pure, framework-free formatters extracted verbatim from the original
 * app/page.tsx so every console screen and hook can share them.
 * ========================================================================== */

export const resolveMedia = (path?: string | null) => (path ? mediaUrl(path) : undefined);

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "알 수 없는 오류가 발생했어요";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const formatDuration = (seconds?: number | null) => {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "";
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
};

export const fmtDur = (sec?: number | null): string => {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    ss = s % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return `${m}:${String(ss).padStart(2, "0")}`;
};

export const stageFromProgress = (progress: number) => {
  if (progress < 26) return 0;
  if (progress < 54) return 1;
  if (progress < 82) return 2;
  return 3;
};

// Extract the 11-char YouTube video id from watch / youtu.be / shorts / embed URLs.
export const youtubeId = (url?: string | null): string | null => {
  if (!url) return null;
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /\/shorts\/([a-zA-Z0-9_-]{11})/,
    /\/embed\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
};

export const fmtCount = (n: number): string => {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1e8) return (n / 1e8).toFixed(n % 1e8 === 0 ? 0 : 1) + "억";
  if (n >= 1e4) return (n / 1e4).toFixed(n % 1e4 === 0 ? 0 : 1) + "만";
  return n.toLocaleString("ko-KR");
};

/** Korean-readable won amount, e.g. 4820000 → "482만". */
export const fmtKor = (n: number): string => {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1e8) return (n / 1e8).toFixed(1) + "억";
  if (n >= 1e4) return Math.round(n / 1e4).toLocaleString("ko-KR") + "만";
  return n.toLocaleString("ko-KR");
};

export const fmtWon = (n: number): string => "₩" + Math.round(n).toLocaleString("ko-KR");

export const fmtDateDots = (iso?: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
};

export const relDays = (iso?: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (diff <= 0) return "오늘";
  if (diff === 1) return "어제";
  if (diff < 7) return `${diff}일 전`;
  if (diff < 30) return `${Math.floor(diff / 7)}주 전`;
  if (diff < 365) return `${Math.floor(diff / 30)}개월 전`;
  return `${Math.floor(diff / 365)}년 전`;
};

export const publishStateKo = (status?: string | null): string =>
  status === "published"
    ? "발행"
    : status === "scheduled"
    ? "예약"
    : status === "uploading" || status === "pending"
    ? "처리중"
    : status === "failed"
    ? "실패"
    : status === "cancelled"
    ? "취소"
    : "초안";

export const jobStatusKo = (status?: string | null): string =>
  status === "completed"
    ? "완료"
    : status === "processing"
    ? "처리중"
    : status === "failed"
    ? "실패"
    : "대기";

export const parseSchedDate = (raw?: string | null, fallbackIso?: string | null): Date | null => {
  if (raw && /^\d{14}$/.test(raw)) {
    return new Date(
      +raw.slice(0, 4),
      +raw.slice(4, 6) - 1,
      +raw.slice(6, 8),
      +raw.slice(8, 10),
      +raw.slice(10, 12),
      +raw.slice(12, 14)
    );
  }
  const src = raw || fallbackIso;
  if (!src) return null;
  const d = new Date(src);
  return Number.isNaN(d.getTime()) ? null : d;
};

export const fmtStamp = (raw?: string | null): string => {
  const d = parseSchedDate(raw);
  if (!d) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const parseTagInput = (raw: string): string[] =>
  raw
    .split(/[,\n]/)
    .map((t) => t.trim().replace(/^#/, ""))
    .filter(Boolean)
    .slice(0, 30);

export const toScheduleStamp = (local: string): string => {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}00` : "";
};

export const defaultScheduleLocal = (): string => {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const defaultDateLocal = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
