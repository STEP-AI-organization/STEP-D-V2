"use client";

/**
 * 채널 분석 — **영상 하나를 깊게 본다.**
 *
 * 왜 이 화면이 필요한가 (2026-09-02): 워커(`video.analyze` · `video.comments`)가 유입경로·
 * 시청자 연령/성별·시청 지속 곡선·상위 댓글까지 **계속 모으고 있었는데 보여 주는 화면이 하나도
 * 없었다.** 서버 라우트도(`/api/youtube/videos/:id/analytics`) 웹 API 함수도(`fetchVideoAnalytics`)
 * 멀쩡히 있었지만 부르는 곳이 0 이었다 — 프론트 개편 때 안 옮겨졌다.
 * 사용자: *"채널에 분석 같은 게 안 뜨고 요즘 조회수·시청시간 이런 가벼운 숫자밖에 안 뜨더라."*
 *
 * 성과(`/performance`)와 나눠 쓰는 기준:
 *   · **성과** = 채널 합계(조회수·시청시간·수익). 매번 YouTube Analytics 를 라이브로 읽는다.
 *   · **여기** = 영상 하나의 속. 워커가 **모아 둔 것**을 읽는다(라이브 조회가 아니다).
 * 그래서 여기에는 "언제 모은 것인지"가 반드시 보여야 한다 — 안 그러면 오래된 수치를 지금
 * 값으로 읽는다.
 *
 * 없는 값은 **0 이 아니라 "—"** 다(F9 ⊘). 수집 전과 실제 0 은 다르다.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  fetchChannelVideos,
  fetchVideoAnalytics,
  fetchYouTubeChannels,
  refreshVideoComments,
  type VideoAnalytics,
  type YouTubeChannelInfo,
} from "@/lib/data/api";
import type { YouTubeChannelVideo } from "@/lib/types";
import { cn } from "@/lib/utils";

const NUM = (n: number) => Math.round(n).toLocaleString("ko-KR");
const PCT = (n: number) => `${n.toFixed(1)}%`;

/** 초 → "3분 21초". 평균 시청 시간은 초로 오는데, 초만 적으면 감이 안 온다. */
function dur(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
}

/** 수집 시각 — 라이브가 아니라 **모아 둔 것**이라는 사실을 화면에 남긴다. */
function collectedAt(ms: number | null): string {
  if (!ms) return "아직 수집 전";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} `
    + `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} 수집`;
}

/** YouTube 의 유입경로 코드 → 사람 말. 모르는 코드는 그대로 둔다(지어내지 않는다). */
const TRAFFIC_LABEL: Record<string, string> = {
  YT_SEARCH: "YouTube 검색",
  SUGGESTED_VIDEO: "추천 영상",
  RELATED_VIDEO: "관련 영상",
  BROWSE: "탐색 기능",
  YT_CHANNEL: "채널 페이지",
  PLAYLIST: "재생목록",
  SHORTS: "Shorts 피드",
  EXT_URL: "외부 사이트",
  NOTIFICATION: "알림",
  SUBSCRIBER: "구독 피드",
  NO_LINK_OTHER: "기타",
  ADVERTISING: "광고",
};

const GENDER_LABEL: Record<string, string> = { male: "남성", female: "여성", user_specified: "기타" };

export default function ChannelAnalyticsPage() {
  const [channels, setChannels] = useState<YouTubeChannelInfo[]>([]);
  const [pickedChannel, setPickedChannel] = useState<string | null>(null);
  const [videos, setVideos] = useState<YouTubeChannelVideo[]>([]);
  const [pickedVideo, setPickedVideo] = useState<string | null>(null);
  const [data, setData] = useState<VideoAnalytics | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [queuing, setQueuing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // ① 채널 — 성과 화면과 같은 기준으로 **활성만** 쓴다. 끊긴 채널은 어차피 조회가 실패한다.
  useEffect(() => {
    let alive = true;
    void fetchYouTubeChannels()
      .then((cs) => {
        if (!alive) return;
        const active = cs.filter((c) => c.status === "active");
        setChannels(active);
        setPickedChannel((p) => p ?? active[0]?.channelId ?? null);
      })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  // ② 그 채널의 영상 목록
  useEffect(() => {
    if (!pickedChannel) return;
    let alive = true;
    setVideos([]);
    setPickedVideo(null);
    setData(null);
    void fetchChannelVideos(pickedChannel)
      .then((r) => {
        if (!alive) return;
        setVideos(r.videos ?? []);
        setPickedVideo((p) => p ?? r.videos?.[0]?.videoId ?? null);
      })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [pickedChannel]);

  // ③ 고른 영상의 상세
  const load = useCallback(async () => {
    if (!pickedVideo) { setData(null); return; }
    setBusy(true);
    setErr(null);
    try {
      setData(await fetchVideoAnalytics(pickedVideo));
    } catch (e) {
      setData(null);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [pickedVideo]);

  useEffect(() => { void load(); }, [load]);

  const video = videos.find((v) => v.videoId === pickedVideo) ?? null;
  const s = data?.summary;

  /** 유입경로는 **비중**으로 봐야 읽힌다 — 절대값만 있으면 채널마다 감이 다르다. */
  const traffic = useMemo(() => {
    const rows = data?.trafficSources ?? [];
    const total = rows.reduce((a, r) => a + (Number(r.views) || 0), 0);
    return rows
      .map((r) => ({ ...r, share: total > 0 ? (Number(r.views) || 0) / total : 0 }))
      .sort((a, b) => b.views - a.views);
  }, [data]);

  const demo = useMemo(
    () => (data?.demographics ?? []).slice().sort((a, b) => (b.percentage ?? 0) - (a.percentage ?? 0)),
    [data],
  );

  const onRefreshComments = async () => {
    if (!pickedVideo) return;
    setQueuing(true);
    setNotice(null);
    try {
      const r = await refreshVideoComments(pickedVideo);
      // 잡을 **큐에 넣기만** 한다 — 여기서 기다리면 화면이 몇 분 멎는다.
      setNotice(r.alreadyPending
        ? "이미 수집 대기 중입니다 — 잠시 뒤 다시 조회해 주세요."
        : "댓글 수집을 요청했습니다 — 끝나면 다시 조회에서 보입니다.");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setQueuing(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-[1240px] flex-col gap-[14px]">
      {/* 채널 고르기 */}
      <div className="flex flex-wrap items-center gap-[3px]">
        {channels.length === 0 ? (
          <span className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
            {err ? `채널을 불러오지 못했습니다 (${err})` : "연결된 채널이 없습니다"} —{" "}
            <Link href="/publish-channels" className="underline" style={{ color: "var(--sd-accent)" }}>
              배포채널 연동
            </Link>
          </span>
        ) : (
          channels.map((c) => (
            <button
              key={c.channelId}
              type="button"
              className={cn("sd-btn", pickedChannel === c.channelId && "sd-btn--on")}
              onClick={() => setPickedChannel(c.channelId)}
            >
              {c.channelName}
            </button>
          ))
        )}
      </div>

      {pickedChannel && videos.length === 0 && (
        <p className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
          이 채널에서 수집된 영상이 없습니다 —{" "}
          <Link href="/trends" className="underline" style={{ color: "var(--sd-accent)" }}>유튜브 트렌드</Link>
          에서 채널 동기화를 먼저 돌려 주세요.
        </p>
      )}

      {videos.length > 0 && (
        <div className="flex flex-col gap-[14px] lg:flex-row">
          {/* 영상 목록 */}
          <div className="sd-card flex max-h-[560px] w-full shrink-0 flex-col overflow-y-auto p-2 lg:w-[300px]">
            {videos.map((v) => (
              <button
                key={v.videoId}
                type="button"
                onClick={() => setPickedVideo(v.videoId)}
                className={cn(
                  "flex flex-col gap-0.5 rounded-[4px] px-2.5 py-2 text-left",
                  pickedVideo === v.videoId && "sd-btn--on",
                )}
              >
                <span className="line-clamp-2 text-[11.5px]" style={{ color: "var(--sd-fg)" }}>{v.title}</span>
                <span className="text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                  {v.publishedAt ? String(v.publishedAt).slice(0, 10) : "—"}
                </span>
              </button>
            ))}
          </div>

          {/* 고른 영상의 속 */}
          <div className="flex min-w-0 flex-1 flex-col gap-[14px]">
            {busy && <p className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>불러오는 중…</p>}

            {err && !busy && (
              <div
                className="flex flex-wrap items-center gap-2 rounded-[4px] px-3 py-2 text-[11.5px]"
                style={{ border: "1px solid var(--sd-danger-border)", background: "var(--sd-danger-bg)", color: "var(--sd-danger-strong)" }}
              >
                <span>상세를 불러오지 못했습니다 ({err}) — 0 이 아니라 <b>알 수 없음</b>입니다.</span>
                <button type="button" className="sd-btn" onClick={() => void load()}>다시 조회</button>
              </div>
            )}

            {data && !busy && (
              <>
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="sd-serif min-w-0 truncate text-[14px] font-semibold" style={{ color: "var(--sd-fg)" }}>
                    {video?.title ?? data.video?.title ?? "영상"}
                  </h2>
                  {/* ⚠️ 라이브가 아니다 — 언제 모은 값인지 항상 붙인다. */}
                  <span className="shrink-0 text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                    {collectedAt(data.fetchedAt)}
                  </span>
                </div>

                <div className="flex flex-wrap gap-[14px]">
                  <Stat label="조회수" value={s?.views != null ? NUM(s.views) : "—"} />
                  <Stat
                    label="평균 시청 시간"
                    value={s?.averageViewDuration != null ? dur(s.averageViewDuration) : "—"}
                  />
                  <Stat
                    label="평균 시청률"
                    value={s?.averageViewPercentage != null ? PCT(s.averageViewPercentage) : "—"}
                  />
                  <Stat
                    label="시청 시간(분)"
                    value={s?.estimatedMinutesWatched != null ? NUM(s.estimatedMinutesWatched) : "—"}
                  />
                </div>

                <Section title="유입 경로" empty={traffic.length === 0}>
                  {traffic.map((t) => (
                    <Bar
                      key={t.source}
                      label={TRAFFIC_LABEL[t.source] ?? t.source}
                      ratio={t.share}
                      right={`${NUM(t.views)}회 · ${PCT(t.share * 100)}`}
                    />
                  ))}
                </Section>

                <Section title="시청자" empty={demo.length === 0}>
                  {demo.map((d, i) => (
                    <Bar
                      key={`${d.ageGroup}-${d.gender}-${i}`}
                      label={`${String(d.ageGroup ?? "").replace("age", "")} · ${GENDER_LABEL[String(d.gender)] ?? d.gender ?? "—"}`}
                      ratio={(d.percentage ?? 0) / 100}
                      right={d.percentage != null ? PCT(d.percentage) : "—"}
                    />
                  ))}
                </Section>

                <Section title="시청 지속" empty={(data.retention ?? []).length === 0}>
                  {/* 곡선 하나에 라이브러리를 들이지 않는다 — 막대 100개면 충분히 읽힌다. */}
                  <div className="flex h-[90px] items-end gap-px">
                    {(data.retention ?? []).map((p, i) => (
                      <div
                        key={i}
                        title={`${PCT(p.ratio * 100)} 지점 · ${PCT(p.watchRatio * 100)} 시청`}
                        className="flex-1 rounded-t-[1px]"
                        style={{
                          height: `${Math.max(2, Math.min(100, p.watchRatio * 100))}%`,
                          background: "var(--sd-accent)",
                          opacity: 0.75,
                        }}
                      />
                    ))}
                  </div>
                  <div className="mt-1 flex justify-between text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                    <span>시작</span><span>영상 길이 기준 위치</span><span>끝</span>
                  </div>
                </Section>

                <Section
                  title="상위 댓글"
                  empty={(data.comments ?? []).length === 0}
                  emptyText="수집된 댓글이 없습니다 — 업로드 7일이 지난 영상은 자동 수집 대상이 아닙니다."
                  action={
                    <button type="button" className="sd-btn" onClick={() => void onRefreshComments()} disabled={queuing}>
                      {queuing ? "요청 중…" : "댓글 다시 수집"}
                    </button>
                  }
                >
                  <ul className="flex flex-col gap-2">
                    {(data.comments ?? []).map((c) => (
                      <li key={c.id} className="flex flex-col gap-0.5">
                        <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
                          {c.author} · 좋아요 {NUM(c.likeCount)}
                        </span>
                        <span className="text-[12px] leading-relaxed" style={{ color: "var(--sd-fg)" }}>{c.text}</span>
                      </li>
                    ))}
                  </ul>
                </Section>

                {notice && (
                  <p className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>{notice}</p>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <p className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
        채널 합계는{" "}
        <Link href="/performance" className="underline" style={{ color: "var(--sd-accent)" }}>성과</Link>
        에서 봅니다. 이 화면은 워커가 <b>모아 둔</b> 값이라 라이브 조회와 시점이 다를 수 있습니다.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="sd-card min-w-[150px] flex-1 p-4">
      <div className="sd-eb" style={{ color: "var(--sd-label)" }}>{label}</div>
      <div
        className="sd-mono mt-1 text-[22px] leading-none"
        style={{ color: value === "—" ? "var(--sd-mut)" : "var(--sd-fg)" }}
      >
        {value}
      </div>
    </div>
  );
}

/** 비어 있으면 **비어 있다고 적는다** — 빈 칸은 "서버 미연결"과 구분이 안 된다. */
function Section({
  title, children, empty, emptyText, action,
}: {
  title: string;
  children: React.ReactNode;
  empty: boolean;
  emptyText?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="sd-card p-4">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <div className="sd-eb" style={{ color: "var(--sd-label)" }}>{title}</div>
        {action}
      </div>
      {empty
        ? <p className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>{emptyText ?? "아직 수집된 값이 없습니다."}</p>
        : children}
    </div>
  );
}

function Bar({ label, ratio, right }: { label: string; ratio: number; right: string }) {
  return (
    <div className="mb-1.5 flex items-center gap-2.5">
      <span className="w-[110px] shrink-0 truncate text-[11.5px]" style={{ color: "var(--sd-fg)" }}>{label}</span>
      <span className="h-[6px] flex-1 overflow-hidden rounded-[3px]" style={{ background: "var(--sd-ph, #2a2a2a)" }}>
        <span
          className="block h-full rounded-[3px]"
          style={{ width: `${Math.max(1, Math.min(100, ratio * 100))}%`, background: "var(--sd-accent)" }}
        />
      </span>
      <span className="sd-mono w-[130px] shrink-0 text-right text-[11px]" style={{ color: "var(--sd-mut)" }}>{right}</span>
    </div>
  );
}
