"use client";

/**
 * U14 · 성과 (README §8 · FLOWS F9).
 *
 * 채널을 고르면 그 채널 지표. 못 보는 채널은 카드 대신 **사유 화면**이 뜨는데,
 * 문구가 유형별로 달라야 한다:
 *
 *  - 권한 없음      → "이 채널의 지표 접근 권한이 없습니다"
 *  - 업로드 전용    → "구조적으로 데이터가 존재하지 않습니다"
 *
 * 이 둘을 같은 문장으로 뭉개면 사용자는 권한을 요청해야 할지, 애초에 없는 걸 기다리는
 * 중인지 모른다. **0 으로 렌더하는 건 더 나쁘다** — 없는 것과 0 은 다르다(F9 ⊘).
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useSession } from "@/lib/auth";
import {
  fetchChannelAnalytics,
  fetchYouTubeChannels,
  type ChannelAnalytics,
  type YouTubeChannelInfo,
} from "@/lib/data/api";
import { blockedCopy, revenueDisplay, roleOf } from "@/lib/roles";
import { cn } from "@/lib/utils";

const WON = (n: number) => `₩${Math.round(n).toLocaleString("ko-KR")}`;
const NUM = (n: number) => Math.round(n).toLocaleString("ko-KR");

export default function PerformancePage() {
  const session = useSession();
  const role = session.user.role;
  const caps = roleOf(role);

  const [channels, setChannels] = useState<YouTubeChannelInfo[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [data, setData] = useState<ChannelAnalytics | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetchYouTubeChannels()
      .then((cs) => {
        if (!alive) return;
        setChannels(cs);
        setPicked((p) => p ?? cs[0]?.channelId ?? null);
      })
      .catch((err) => { if (alive) setLoadErr(err instanceof Error ? err.message : String(err)); });
    return () => { alive = false; };
  }, []);

  const channel = channels.find((c) => c.channelId === picked) ?? null;

  /** 이 채널을 왜 못 보는가. null 이면 볼 수 있다. */
  const blocked: "no_permission" | "upload_only" | null = useMemo(() => {
    if (!channel) return null;
    // 업로드 전용(수익 범위 미동의)은 **데이터가 존재하지 않는 것**이지 권한 문제가 아니다.
    if (!channel.hasMonetaryScope) return "upload_only";
    if (!caps.revenue) return "no_permission";
    return null;
  }, [channel, caps.revenue]);

  const load = useCallback(async () => {
    if (!channel || blocked) { setData(null); return; }
    setBusy(true);
    try {
      setData(await fetchChannelAnalytics(channel.channelId, {
        metrics: "views,estimatedMinutesWatched,estimatedRevenue",
      }));
      setLoadErr(null);
    } catch (err) {
      setData(null);
      setLoadErr(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [channel, blocked]);

  useEffect(() => { void load(); }, [load]);

  const row = data?.rows?.[0] ?? {};
  const pick = (needle: string) => {
    const key = data?.columns?.find((c) => c.toLowerCase().includes(needle));
    return key ? Number(row[key] ?? 0) || 0 : 0;
  };
  const revenue = revenueDisplay(role, pick("revenue"), WON);

  return (
    <div className="mx-auto flex max-w-[1240px] flex-col gap-[14px]">
      {/* 채널 선택 */}
      <div className="flex flex-wrap items-center gap-[3px]">
        {channels.length === 0 ? (
          <span className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
            {loadErr ? `채널을 불러오지 못했습니다 (${loadErr})` : "연결된 채널이 없습니다"} —{" "}
            <Link href="/publish-channels" className="underline" style={{ color: "var(--sd-accent)" }}>
              배포채널 연동
            </Link>
          </span>
        ) : (
          channels.map((c) => (
            <button
              key={c.channelId}
              type="button"
              className={cn("sd-btn", picked === c.channelId && "sd-btn--on")}
              onClick={() => setPicked(c.channelId)}
            >
              {c.channelName}
              {!c.hasMonetaryScope && (
                <span className="ml-1.5 text-[10px]" style={{ opacity: 0.7 }}>업로드 전용</span>
              )}
            </button>
          ))
        )}
      </div>

      {channel && blocked ? (
        /* ── 차단 화면 — 유형별로 문구가 다르다 (F9) ─────────────────── */
        <div className="sd-card flex flex-col items-center gap-2.5 p-10 text-center">
          <div className="sd-ph size-[44px] rounded-full" />
          <h2 className="sd-serif text-[15px] font-semibold" style={{ color: "var(--sd-fg)" }}>
            {blockedCopy(blocked).title}
          </h2>
          <p className="max-w-[440px] text-[12px] leading-relaxed" style={{ color: "var(--sd-mut)" }}>
            {blockedCopy(blocked).body}
          </p>
          {blocked === "upload_only" ? (
            <Link href="/publish-channels" className="sd-btn">채널 연결 다시 보기</Link>
          ) : (
            <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
              현재 역할: {roleOf(role).label}
            </span>
          )}
        </div>
      ) : channel ? (
        <>
          <div className="flex flex-wrap gap-[14px]">
            <Stat label="조회수" value={NUM(pick("views"))} />
            <Stat label="시청 시간(분)" value={NUM(pick("minuteswatched"))} />
            <Stat label="수익" value={revenue.text} muted={revenue.masked} />
          </div>

          {busy && (
            <p className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>불러오는 중…</p>
          )}
          {loadErr && (
            <div
              className="rounded-[4px] px-3 py-2 text-[11.5px]"
              style={{ border: "1px solid var(--sd-danger-border)", background: "var(--sd-danger-bg)", color: "var(--sd-danger-strong)" }}
            >
              지표를 불러오지 못했습니다 ({loadErr}) — 0 이 아니라 <b>알 수 없음</b>입니다.
            </div>
          )}
          {!busy && !loadErr && !data && (
            <p className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
              아직 수집된 지표가 없습니다. 채널 동기화 후 다시 확인하세요.
            </p>
          )}

          <p className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
            프로그램 단위·채널 단위 상세는{" "}
            <Link href="/program-analytics" className="underline" style={{ color: "var(--sd-accent)" }}>프로그램 분석</Link>
            {" · "}
            <Link href="/channel-analytics" className="underline" style={{ color: "var(--sd-accent)" }}>채널 분석</Link>
            에서 봅니다.
          </p>
        </>
      ) : null}
    </div>
  );
}

function Stat({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="sd-card min-w-[180px] flex-1 p-4">
      <div className="sd-eb" style={{ color: "var(--sd-label)" }}>{label}</div>
      <div className="sd-mono mt-1 text-[26px] leading-none" style={{ color: muted ? "var(--sd-mut)" : "var(--sd-fg)" }}>
        {value}
      </div>
    </div>
  );
}
