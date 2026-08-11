"use client";

/**
 * U13 · 대시보드 (README §1 · FLOWS F3 윈도우 경고 · F9 마스킹).
 *
 * 오늘 무엇이 막혀 있고 무엇이 나갔는지를 한 화면에.
 *
 * 지키는 것:
 *  - **수익은 권한이 없으면 0이 아니라 "비공개"** 다(F9 ⊘ 숫자를 0으로 렌더 금지).
 *    막대 길이도 0이어야 한다 — 길이로 금액이 유추되면 마스킹이 아니다.
 *  - 지표가 없는 이유를 유형별로 나눈다: **권한 없음** vs **구조적으로 데이터가 없음**
 *    (업로드 전용 채널은 애초에 수익 데이터가 존재하지 않는다).
 *  - 권리 윈도우 만료 임박은 상단에 경고 톤으로 노출한다(F3).
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useSession } from "@/lib/auth";
import {
  fetchChannelAnalytics,
  fetchGateBatch,
  fetchYouTubeChannels,
  type GateResult,
  type GateState,
  type YouTubeChannelInfo,
} from "@/lib/data/api";
import { useAppData } from "@/lib/data/store";
import { useGateSummary } from "@/lib/gate-summary";
import { GATE_LABEL } from "@/lib/gate-ui";
import { normalizeProgramStatus, rightsWindowOf } from "@/lib/programs";
import { blockedCopy, revenueDisplay, roleOf } from "@/lib/roles";
import type { Clip } from "@/lib/types";

const WON = (n: number) => `₩${Math.round(n).toLocaleString("ko-KR")}`;

/** 수익 집계 창. 카드 라벨과 **같은 숫자**여야 한다 — 라벨만 28일이고 조회는 90일이면 거짓말이다. */
const REVENUE_WINDOW_DAYS = 28;

/** 로컬 날짜 기준 YYYY-MM-DD. toISOString 은 UTC 라 KST 새벽에 하루가 밀린다. */
const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function windowOf(days: number): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  return { start: isoDate(start), end: isoDate(end) };
}

export default function DashboardPage() {
  const { clips, episodes, programs, loading } = useAppData();
  const session = useSession();
  const role = session.user.role;
  const caps = roleOf(role);

  // 게이트는 사이드바 배지와 **같은 값**을 쓴다 — 화면마다 따로 세면 숫자가 갈리고,
  // 그러면 사용자는 어느 쪽을 믿어야 할지 모른다.
  const gateSummary = useGateSummary();

  const [channels, setChannels] = useState<YouTubeChannelInfo[]>([]);
  const [revenue, setRevenue] = useState<Record<string, number>>({});
  const [revenueError, setRevenueError] = useState<string | null>(null);
  // 아직 못 읽은 상태를 ₩0 으로 렌더하지 않기 위한 플래그 — 0 원과 "모름"은 다르다.
  // 채널 목록 왕복도 포함해야 한다: 채널이 오기 전에는 monetary 가 비어 있어서
  // 이 플래그만으로는 첫 프레임이 그대로 ₩0 이 된다.
  const [channelsReady, setChannelsReady] = useState(false);
  const [revenueReady, setRevenueReady] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetchYouTubeChannels()
      .then((cs) => { if (alive) { setChannels(cs); setChannelsReady(true); } })
      .catch(() => { if (alive) { setChannels([]); setChannelsReady(true); } });
    return () => { alive = false; };
  }, []);

  // 수익은 **수익 범위에 동의한 채널만** 조회한다. 나머지는 요청도 하지 않는다 —
  // 데이터가 구조적으로 없는 것을 "실패"로 보여주면 안 된다.
  const monetary = useMemo(() => channels.filter((c) => c.hasMonetaryScope), [channels]);
  const uploadOnly = channels.length - monetary.length;

  const loadRevenue = useCallback(async () => {
    if (!caps.revenue || monetary.length === 0) return;
    const out: Record<string, number> = {};
    let failed = 0;
    const win = windowOf(REVENUE_WINDOW_DAYS);
    for (const ch of monetary) {
      try {
        // 서버는 start/end 를 안 주면 90일, dimensions 를 안 주면 day 로 채운다 —
        // 그래서 rows 는 하루 1행이다. rows[0] 만 읽으면 "28일 합계"가 아니라
        // **구간 첫날 하루치**가 된다. 창을 명시하고 전 행을 합산한다.
        const a = await fetchChannelAnalytics(ch.channelId, {
          start: win.start,
          end: win.end,
          metrics: "estimatedRevenue",
        });
        const key = a.columns?.find((c) => c.toLowerCase().includes("revenue")) ?? "estimatedRevenue";
        out[ch.channelId] = (a.rows ?? []).reduce((sum, r) => sum + (Number(r[key]) || 0), 0);
      } catch {
        failed += 1;
      }
    }
    setRevenue(out);
    setRevenueError(failed > 0 ? `채널 ${failed}곳의 수익을 불러오지 못했습니다` : null);
    setRevenueReady(true);
  }, [caps.revenue, monetary]);

  useEffect(() => { void loadRevenue(); }, [loadRevenue]);

  // ── 게이트 요약 ──────────────────────────────────────────────────────────
  const gateCount = (s: GateState) => gateSummary.counts[s] ?? 0;

  const today = new Date();
  const expiringPrograms = programs.filter((p) => {
    if (normalizeProgramStatus(p.status) === "upcoming") return false;
    return rightsWindowOf(p, today)?.expiring === true;
  });

  const totalRevenue = Object.values(revenue).reduce((a, b) => a + b, 0);
  const shown = revenueDisplay(role, totalRevenue, WON);
  // 조회 전/조회 중에는 ₩0 이 아니라 "—" 다. 마스킹("비공개")은 그대로 우선한다.
  const pending =
    caps.revenue && (!channelsReady || (monetary.length > 0 && !revenueReady));
  const totalText = shown.masked ? shown.text : pending ? "—" : shown.text;

  const ranked = useMemo(
    () =>
      monetary
        .map((c) => ({ ch: c, amount: revenue[c.channelId] ?? 0 }))
        .sort((a, b) => b.amount - a.amount),
    [monetary, revenue],
  );

  const recent = useMemo(() => recentDistributions(clips, 8), [clips]);

  return (
    <div className="mx-auto flex max-w-[1240px] flex-col gap-[14px]">
      {/* ── 게이트 요약 줄 ─────────────────────────────────────────────── */}
      <div className="sd-card flex flex-wrap items-center gap-4 px-3 py-2.5">
        <GateStat label={GATE_LABEL.rights_hold} n={gateCount("rights_hold")} danger />
        <GateStat label={GATE_LABEL.conditional} n={gateCount("conditional")} warn />
        <GateStat label={GATE_LABEL.review_pending} n={gateCount("review_pending")} />
        <GateStat label="권리 만료 임박 프로그램" n={expiringPrograms.length} danger />
        <Link href="/media?gate=rights_hold" className="sd-btn ml-auto">미디어에서 처리</Link>
      </div>

      {expiringPrograms.length > 0 && (
        <div
          className="rounded-[4px] px-3 py-2 text-[11.5px] leading-relaxed"
          style={{ border: "1px solid var(--sd-danger-border)", background: "var(--sd-danger-bg)", color: "var(--sd-danger-strong)" }}
        >
          권리 만료 임박:{" "}
          {expiringPrograms.slice(0, 5).map((p) => p.title).join(" · ")}
          {expiringPrograms.length > 5 ? ` 외 ${expiringPrograms.length - 5}개` : ""}
          {" — "}만료돼도 배포가 자동으로 막히지는 않습니다. 사람이 이슈를 등록해야 게이트가 걸립니다.
        </div>
      )}

      <div className="flex flex-wrap gap-[14px]">
        {/* ── 수익 카드 ─────────────────────────────────────────────────── */}
        <div className="sd-card flex min-w-[300px] flex-1 flex-col gap-2 p-4">
          <div className="sd-eb" style={{ color: "var(--sd-label)" }}>
            수익 (최근 {REVENUE_WINDOW_DAYS}일)
          </div>
          <div
            className="sd-mono text-[34px] leading-none"
            style={{ color: shown.masked || pending ? "var(--sd-mut)" : "var(--sd-fg)" }}
          >
            {totalText}
          </div>

          <dl className="mt-1 flex flex-col gap-1 text-[11.5px]">
            <SubLine k="수익 집계 가능 채널" v={`${monetary.length}곳`} />
            <SubLine
              k="권한 없음"
              v={caps.revenue ? "없음" : blockedCopy("no_permission").title}
              muted={!caps.revenue}
            />
            <SubLine
              k="업로드 전용"
              v={uploadOnly > 0 ? `${uploadOnly}곳 · 구조적으로 데이터 없음` : "없음"}
              muted
            />
          </dl>

          {revenueError && (
            <p className="text-[11px]" style={{ color: "var(--sd-danger-strong)" }}>{revenueError}</p>
          )}
          {caps.revenue && monetary.length === 0 && channels.length > 0 && (
            <p className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
              {blockedCopy("upload_only").body}
            </p>
          )}
        </div>

        {/* ── 채널별 수익 순위 ──────────────────────────────────────────── */}
        <div className="sd-card flex min-w-[420px] flex-[2] flex-col gap-2 p-4">
          <div className="sd-eb" style={{ color: "var(--sd-label)" }}>
            채널별 수익 (최근 {REVENUE_WINDOW_DAYS}일)
          </div>
          {pending ? (
            /* 조회 전에 0 원 순위를 그리면 "수익이 없다"로 읽힌다. */
            <p className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>불러오는 중…</p>
          ) : ranked.length === 0 ? (
            <p className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
              {channels.length === 0
                ? "연결된 채널이 없습니다 — 배포채널 연동에서 연결하세요"
                : "수익 범위에 동의한 채널이 없습니다 (업로드 전용 채널은 수익 데이터가 존재하지 않습니다)"}
            </p>
          ) : (
            <ol className="flex flex-col gap-2">
              {ranked.map((r, i) => {
                const row = revenueDisplay(role, r.amount, WON);
                const share = totalRevenue > 0 ? (r.amount / totalRevenue) * 100 : 0;
                return (
                  <li key={r.ch.channelId} className="flex items-center gap-2.5">
                    <span className="sd-mono w-[14px] shrink-0 text-[11px]" style={{ color: "var(--sd-mut)" }}>
                      {i + 1}
                    </span>
                    <span
                      className="grid size-[26px] shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white"
                      style={{ background: "var(--sd-accent)" }}
                      aria-hidden
                    >
                      {r.ch.channelName?.[0] ?? "?"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px]" style={{ color: "var(--sd-fg)" }}>
                        {r.ch.channelName}
                      </div>
                      <div className="sd-progress mt-1">
                        {/* 막대 길이도 마스킹된다 — 길이로 금액이 유추되면 마스킹이 아니다. */}
                        <span style={{ width: `${row.barRatio * share}%`, background: "var(--sd-chart)" }} />
                      </div>
                    </div>
                    <span className="sd-mono shrink-0 text-[11.5px]" style={{ color: row.masked ? "var(--sd-mut)" : "var(--sd-fg)" }}>
                      {row.text}
                    </span>
                    {!row.masked && (
                      <span className="sd-tag sd-mono shrink-0">{share.toFixed(0)}%</span>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>

      {/* ── 배포 기록 ─────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          {/* "최근"이라고 적지 않는다 — 게시 시각 필드가 없어 최신순 정렬이 불가능하다. */}
          <h3 className="sd-serif text-[16px] font-semibold" style={{ color: "var(--sd-fg)" }}>배포 기록</h3>
          <Link href="/distribution" className="text-[11px] underline" style={{ color: "var(--sd-accent)" }}>
            전체 보기
          </Link>
        </div>
        {recent.length === 0 ? (
          <div
            className="sd-ph grid min-h-[90px] place-items-center rounded-[6px] px-6 text-center"
            style={{ border: "1px dashed var(--sd-border)" }}
          >
            {loading ? "불러오는 중…" : "배포 기록이 없습니다"}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {recent.map((r, i) => {
              const ep = episodes.find((e) => e.id === r.clip.episodeId);
              const pg = programs.find((p) => p.id === ep?.programId);
              return (
                <div key={`${r.clip.id}-${r.channel}-${i}`} className="sd-card flex flex-wrap items-center gap-3 px-3 py-2">
                  <span className="min-w-[220px] flex-1 truncate text-[12px]" style={{ color: "var(--sd-fg)" }}>
                    {r.clip.title}
                  </span>
                  <span className="sd-mono truncate text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                    {pg?.title ?? ""}{ep ? ` · 회차 ${ep.episodeNumber}` : ""}
                  </span>
                  <span className="sd-tag">{r.channel}</span>
                  <span className={r.status === "published" ? "sd-tag sd-tag--airing" : r.status === "failed" ? "sd-tag sd-tag--danger" : "sd-tag"}>
                    {{ published: "게시됨", recorded: "기록됨", scheduled: "예약됨", pending: "업로드 중", failed: "실패" }[r.status] ?? r.status}
                  </span>
                  {/* 예약 발행 건에만 값이 있다 — 즉시 발행 건은 "—" 로 남는다. */}
                  <span
                    className="sd-mono shrink-0 text-[10.5px]"
                    style={{ color: "var(--sd-mut)" }}
                    title="예약일 기준입니다 — 실제 게시 시각이 아닙니다"
                  >
                    {fmtReserve(r.at)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function GateStat({ label, n, danger, warn }: { label: string; n: number; danger?: boolean; warn?: boolean }) {
  const color = n === 0 ? "var(--sd-mut)" : danger ? "var(--sd-danger-strong)" : warn ? "var(--sd-warn)" : "var(--sd-fg)";
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="sd-mono text-[20px]" style={{ color }}>{n}</span>
      <span className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>{label}</span>
    </div>
  );
}

function SubLine({ k, v, muted }: { k: string; v: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="shrink-0" style={{ color: "var(--sd-mut)" }}>{k}</dt>
      <dd className="truncate" style={{ color: muted ? "var(--sd-mut)" : "var(--sd-fg)" }}>{v}</dd>
    </div>
  );
}

/**
 * 배포 기록 — 클립의 distributions 를 평탄화한 목록.
 *
 * **"최신순"으로 정렬할 수 없다.** DistributionState 에는 게시 시각 필드가 없고
 * `reserveDate` 는 **예약 발행일 때만** 채워진다(즉시 발행 건은 빈 값). 그 키로 정렬하면
 * 가장 흔한 즉시 발행 건이 통째로 목록 밖으로 밀리고, 남는 것도 '최근'이 아니라
 * '가장 먼 미래' 순이 된다. 그래서 여기서는 서버가 준 순서를 유지하고,
 * 각 행에는 있을 때만 예약일을 함께 적는다. 진짜 '최근'이 필요하면
 * 서버 쪽 publishedAt(게시 기록 시각) 추가가 선행 조건이다.
 */
function recentDistributions(clips: Clip[], limit: number) {
  const rows: { clip: Clip; channel: string; status: string; at: string }[] = [];
  for (const clip of clips) {
    for (const d of clip.distributions ?? []) {
      if (d.status === "none") continue;
      rows.push({ clip, channel: d.channel, status: d.status, at: d.reserveDate ?? "" });
    }
  }
  return rows.slice(0, limit);
}

/**
 * 예약일 → "MM-DD HH:mm". 저장 형식이 한 가지가 아니다:
 *
 *  - 실제 경로는 `<input type="datetime-local">` 값을 **그대로** 저장한다
 *    (publish-dialog → publish-dispatch → worker 모두 무가공) → "2026-08-11T10:00".
 *  - 로컬 더미데이터(lib/data/mock.ts)만 14자리 "YYYYMMDDHHmmss" 다.
 *
 * 둘 다 받고, 어느 쪽도 아니면 **추측하지 말고** "—".
 */
function fmtReserve(at: string): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(at);
  if (iso) return `${iso[2]}-${iso[3]} ${iso[4]}:${iso[5]}`;
  if (/^\d{12,14}$/.test(at)) {
    return `${at.slice(4, 6)}-${at.slice(6, 8)} ${at.slice(8, 10)}:${at.slice(10, 12)}`;
  }
  return "—";
}
