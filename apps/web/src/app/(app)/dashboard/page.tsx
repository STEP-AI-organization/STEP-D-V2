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

import { useToast } from "@/components/ui/toast";
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
import { GATE_LABEL } from "@/lib/gate-ui";
import { normalizeProgramStatus, rightsWindowOf } from "@/lib/programs";
import { blockedCopy, revenueDisplay, roleOf } from "@/lib/roles";
import type { Clip } from "@/lib/types";

const WON = (n: number) => `₩${Math.round(n).toLocaleString("ko-KR")}`;

export default function DashboardPage() {
  const { clips, episodes, programs, loading } = useAppData();
  const session = useSession();
  const role = session.user.role;
  const caps = roleOf(role);

  const [gates, setGates] = useState<Record<string, GateResult>>({});
  const [channels, setChannels] = useState<YouTubeChannelInfo[]>([]);
  const [revenue, setRevenue] = useState<Record<string, number>>({});
  const [revenueError, setRevenueError] = useState<string | null>(null);

  const clipIds = useMemo(() => clips.map((c) => c.id), [clips]);
  const idsKey = clipIds.join(",");

  // 게이트 요약 — 목록과 같은 배치 조회를 쓴다(판정은 서버가 한다).
  useEffect(() => {
    if (clipIds.length === 0) { setGates({}); return; }
    let alive = true;
    void fetchGateBatch("clip", clipIds)
      .then((r) => { if (alive) setGates(r.gates); })
      .catch(() => { if (alive) setGates({}); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  useEffect(() => {
    let alive = true;
    void fetchYouTubeChannels()
      .then((cs) => { if (alive) setChannels(cs); })
      .catch(() => { if (alive) setChannels([]); });
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
    for (const ch of monetary) {
      try {
        const a = await fetchChannelAnalytics(ch.channelId, { metrics: "estimatedRevenue" });
        const row = a.rows?.[0] ?? {};
        const key = a.columns?.find((c) => c.toLowerCase().includes("revenue")) ?? "estimatedRevenue";
        out[ch.channelId] = Number(row[key] ?? 0) || 0;
      } catch {
        failed += 1;
      }
    }
    setRevenue(out);
    setRevenueError(failed > 0 ? `채널 ${failed}곳의 수익을 불러오지 못했습니다` : null);
  }, [caps.revenue, monetary]);

  useEffect(() => { void loadRevenue(); }, [loadRevenue]);

  // ── 게이트 요약 ──────────────────────────────────────────────────────────
  const gateCount = (s: GateState) =>
    clips.filter((c) => (gates[c.id]?.state ?? "review_pending") === s).length;

  const today = new Date();
  const expiringPrograms = programs.filter((p) => {
    if (normalizeProgramStatus(p.status) === "upcoming") return false;
    return rightsWindowOf(p, today)?.expiring === true;
  });

  const totalRevenue = Object.values(revenue).reduce((a, b) => a + b, 0);
  const shown = revenueDisplay(role, totalRevenue, WON);

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
          <div className="sd-eb" style={{ color: "var(--sd-label)" }}>수익 (최근 28일)</div>
          <div
            className="sd-mono text-[34px] leading-none"
            style={{ color: shown.masked ? "var(--sd-mut)" : "var(--sd-fg)" }}
          >
            {shown.text}
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
          <div className="sd-eb" style={{ color: "var(--sd-label)" }}>채널별 수익</div>
          {ranked.length === 0 ? (
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

      {/* ── 최근 배포 ─────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <h3 className="sd-serif text-[16px] font-semibold" style={{ color: "var(--sd-fg)" }}>최근 배포</h3>
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

/** 최근 배포 — 클립의 distributions 를 평탄화해서 최신순으로. */
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
