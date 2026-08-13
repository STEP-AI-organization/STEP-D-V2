"use client";

/**
 * U14 · 성과 (README §8 · FLOWS F9).
 *
 * 채널을 고르면 그 채널 지표.
 *
 *  - 업로드 전용 채널 → 카드 대신 **사유 화면**("구조적으로 데이터가 존재하지 않습니다").
 *  - 수익 권한 없음   → 화면은 그대로 열리고 **수익 값만 "비공개"** 다. 화면을 통째로 막으면
 *    조회수·시청시간까지 못 보게 되고, "메뉴가 아니라 값이 가려진다"는 roles.ts 원칙과 어긋난다.
 *    단, 가리는 건 **요청 단계**에서 한다 — estimatedRevenue 를 metrics 에서 빼서 애초에
 *    브라우저로 내려오지 않게 한다. 서버(/api/youtube/analytics/:channelId)에는 역할 검사가
 *    없으므로, UI 에서만 가리면 네트워크 응답에 실수치가 그대로 남는다.
 *
 * **0 으로 렌더하는 건 더 나쁘다** — 없는 것과 0 은 다르다(F9 ⊘). 그래서 지표가 없으면 "—".
 * 지표 창은 서버 기본값(90일)이 아니라 화면 라벨과 같은 창을 명시해서 조회한다.
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

/** 지표 집계 창. 카드 라벨과 **같은 숫자**여야 한다 — 라벨만 28일이고 조회는 90일이면 거짓말이다. */
const WINDOW_DAYS = 28;

/** 로컬 날짜 기준 YYYY-MM-DD. toISOString 은 UTC 라 KST 새벽에 하루가 밀린다. */
const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function windowOf(days: number): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  return { start: isoDate(start), end: isoDate(end) };
}

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
        // 연동이 끊긴(disconnected·revoked) 채널은 지표 조회가 어차피 실패한다 —
        // 여기 보이면 "채널은 있는데 숫자가 안 나오는" 화면이 된다. 성과에는 활성만.
        const active = cs.filter((c) => c.status === "active");
        setChannels(active);
        setPicked((p) => p ?? active[0]?.channelId ?? null);
      })
      .catch((err) => { if (alive) setLoadErr(err instanceof Error ? err.message : String(err)); });
    return () => { alive = false; };
  }, []);

  const channel = channels.find((c) => c.channelId === picked) ?? null;

  /**
   * 이 채널을 왜 못 보는가. null 이면 볼 수 있다.
   *
   * 수익 권한이 없다고 **화면 전체를 막지 않는다** — 조회수·시청시간은 그대로 보이고
   * 수익만 "비공개"다(대시보드와 같은 표기). 그 대신 load() 가 estimatedRevenue 를
   * 아예 요청하지 않아서, 가리는 일이 화면이 아니라 요청에서 끝난다.
   * 업로드 전용(수익 범위 미동의)은 **데이터가 존재하지 않는 것**이라 성격이 다르다.
   */
  const blocked: "upload_only" | null = useMemo(() => {
    if (!channel) return null;
    return channel.hasMonetaryScope ? null : "upload_only";
  }, [channel]);

  const load = useCallback(async () => {
    if (!channel || blocked) { setData(null); return; }
    setBusy(true);
    try {
      // 서버는 start/end 를 안 주면 90일, dimensions 를 안 주면 day 로 채운다 —
      // rows 가 하루 1행이라 rows[0] 만 읽으면 구간 첫날 하루치가 된다. 창을 명시하고 합산한다.
      const win = windowOf(WINDOW_DAYS);
      // 수익 열람 권한이 없으면 estimatedRevenue 를 **요청하지 않는다** — 서버는 역할을
      // 보지 않으므로, 요청하면 응답에 실수치가 담겨 브라우저까지 내려온다.
      const metrics = caps.revenue
        ? "views,estimatedMinutesWatched,estimatedRevenue"
        : "views,estimatedMinutesWatched";
      setData(await fetchChannelAnalytics(channel.channelId, {
        start: win.start,
        end: win.end,
        metrics,
      }));
      setLoadErr(null);
    } catch (err) {
      setData(null);
      setLoadErr(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [channel, blocked, caps.revenue]);

  useEffect(() => { void load(); }, [load]);

  /**
   * 구간 합계. **데이터가 없으면 0 이 아니라 null(= 알 수 없음)** 이다 (F9 ⊘).
   *
   * columnHeaders 는 결과가 없어도 그대로 오고 rows 만 `[]` 다 — 그때 `reduce(…, 0)` 를
   * 태우면 "0" 이 실측치처럼 찍힌다. rows 가 비면 null 로 떨어뜨린다.
   */
  const pick = (needle: string): number | null => {
    if (!data) return null;
    const key = data.columns?.find((c) => c.toLowerCase().includes(needle));
    if (!key) return null;
    const rows = data.rows ?? [];
    if (rows.length === 0) return null;
    return rows.reduce((sum, r) => sum + (Number(r[key]) || 0), 0);
  };
  const fmt = (n: number | null) => (n === null ? "—" : NUM(n));
  const viewsAmount = pick("views");
  const watchAmount = pick("minuteswatched");
  const revenueAmount = pick("revenue");
  // 마스킹이 "모름"보다 우선한다 — 권한 없는 사람에게는 데이터 유무조차 알릴 필요가 없다.
  const revenue = revenueDisplay(role, revenueAmount ?? 0, WON);
  const revenueText = revenue.masked ? revenue.text : revenueAmount === null ? "—" : revenue.text;

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
          <Link href="/publish-channels" className="sd-btn">채널 연결 다시 보기</Link>
        </div>
      ) : channel ? (
        <>
          <div className="flex flex-wrap gap-[14px]">
            <Stat label={`조회수 (최근 ${WINDOW_DAYS}일)`} value={fmt(viewsAmount)} muted={viewsAmount === null} />
            <Stat label={`시청 시간(분) (최근 ${WINDOW_DAYS}일)`} value={fmt(watchAmount)} muted={watchAmount === null} />
            <Stat
              label={`수익 (최근 ${WINDOW_DAYS}일)`}
              value={revenueText}
              muted={revenue.masked || revenueAmount === null}
            />
          </div>

          {busy && (
            <p className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>불러오는 중…</p>
          )}
          {loadErr && (
            <div
              className="flex flex-wrap items-center gap-2 rounded-[4px] px-3 py-2 text-[11.5px]"
              style={{ border: "1px solid var(--sd-danger-border)", background: "var(--sd-danger-bg)", color: "var(--sd-danger-strong)" }}
            >
              <span>지표를 불러오지 못했습니다 ({loadErr}) — 0 이 아니라 <b>알 수 없음</b>입니다.</span>
              {/* 이 화면 지표는 YouTube Analytics 를 매번 라이브로 읽는다(저장·수집 단계가 없다).
                  그래서 실패했을 때 할 수 있는 건 '동기화'가 아니라 **다시 조회** 뿐이다. */}
              <button type="button" className="sd-btn" onClick={() => void load()} disabled={busy}>
                {busy ? "조회 중…" : "다시 조회"}
              </button>
            </div>
          )}
          {!busy && !loadErr && data && viewsAmount === null && (
            /* 조회는 성공했는데 구간에 행이 없는 경우 — "0" 이 아니라 "없음"이라고 적는다. */
            <p className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
              최근 {WINDOW_DAYS}일 구간에 집계된 행이 없습니다 (조회 자체는 성공했습니다).
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
