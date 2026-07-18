"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Activity, RefreshCw, Pause, Play } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { StatTile } from "@/components/ui/stat-tile";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import type { StatusTone } from "@/lib/constants";
import {
  fetchOpsJobs,
  fetchOpsMediaAnalysis,
  type OpsJob,
  type OpsJobsResponse,
  type OpsMediaRow,
} from "@/lib/data/api";

const POLL_MS = 5000;

/** ms → short relative "12초 전" / "3분 전" / "2시간 전". */
function ago(ms?: number | null): string {
  if (!ms) return "—";
  const d = Date.now() - ms;
  if (d < 0) return "곧";
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}초 전`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}
function inFuture(ms?: number | null): string {
  if (!ms) return "—";
  const d = ms - Date.now();
  if (d <= 0) return "지금";
  const s = Math.ceil(d / 1000);
  if (s < 60) return `${s}초 후`;
  return `${Math.ceil(s / 60)}분 후`;
}
function secs(ms?: number): string {
  if (!ms || ms < 0) return "—";
  return `${(ms / 1000).toFixed(1)}s`;
}

const JOB_TONE: Record<OpsJob["status"], StatusTone> = {
  pending: "warn",
  running: "progress",
  done: "done",
  failed: "error",
};

export default function OpsPage() {
  const [jobs, setJobs] = useState<OpsJobsResponse | null>(null);
  const [media, setMedia] = useState<OpsMediaRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const autoRef = useRef(auto);
  autoRef.current = auto;

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [j, m] = await Promise.all([fetchOpsJobs(150), fetchOpsMediaAnalysis()]);
      setJobs(j);
      setMedia(m.media);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "불러오기 실패 — 서버 미연결일 수 있습니다.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await load();
      if (alive && autoRef.current) t = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // Re-arm the loop when auto flips back on.
  }, [load, auto]);

  const s = jobs?.stats;

  return (
    <>
      <PageHeader
        title="운영 · 진단"
        description="큐가 어떻게 도는지, 업로드 영상에서 뭐가 나오고 뭐가 깨지는지 — 로우레벨로 봅니다."
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setAuto((v) => !v)}
              className="flex h-9 items-center gap-1.5 rounded-md border border-border px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title={auto ? "자동 새로고침 끄기" : "자동 새로고침 켜기"}
            >
              {auto ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
              {auto ? "자동 5s" : "수동"}
            </button>
            <button
              type="button"
              onClick={load}
              disabled={refreshing}
              className="flex h-9 items-center gap-1.5 rounded-md border border-border px-2.5 text-sm transition-colors hover:bg-accent disabled:opacity-60"
            >
              <RefreshCw className={refreshing ? "size-3.5 animate-spin" : "size-3.5"} /> 새로고침
            </button>
          </div>
        }
      />

      {err && (
        <div className="mb-4 rounded-md border border-status-error/30 bg-status-error/10 px-4 py-2.5 text-sm text-foreground">
          {err}
        </div>
      )}

      {/* queue depth */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="대기 (pending)" value={s ? String(s.pending) : "—"} tone="warn" icon={Activity} />
        <StatTile label="실행 중 (running)" value={s ? String(s.running) : "—"} tone="progress" />
        <StatTile label="완료 (done)" value={s ? String(s.done) : "—"} tone="done" />
        <StatTile label="실패 (failed)" value={s ? String(s.failed) : "—"} tone="error" />
      </div>

      {/* jobs */}
      <h2 className="mb-2 text-sm font-semibold text-foreground">잡 큐 (최근 활동순)</h2>
      <Card className="mb-8 overflow-x-auto p-0">
        <Table>
          <THead>
            <tr>
              <TH>타입</TH>
              <TH>대상</TH>
              <TH>상태</TH>
              <TH numeric>시도</TH>
              <TH>다음 실행</TH>
              <TH>갱신</TH>
              <TH>에러</TH>
            </tr>
          </THead>
          <TBody>
            {(jobs?.jobs ?? []).map((j) => {
              const target = (j.payload?.mediaId ?? j.payload?.channelId ?? j.payload?.videoId ?? j.payload?.clipId ?? "") as string;
              return (
                <TR key={j.id}>
                  <TD className="font-mono text-xs">{j.type}</TD>
                  <TD className="max-w-[140px] truncate font-mono text-xs text-muted-foreground" title={target}>
                    {target || "—"}
                  </TD>
                  <TD>
                    <StatusBadge tone={JOB_TONE[j.status]}>{j.status}</StatusBadge>
                  </TD>
                  <TD numeric className="tabular-nums">
                    {j.attempts}/{j.maxAttempts}
                  </TD>
                  <TD className="text-xs text-muted-foreground">{j.status === "pending" ? inFuture(j.runAfter) : "—"}</TD>
                  <TD className="text-xs text-muted-foreground" title={new Date(j.updatedAt).toLocaleString("ko-KR")}>
                    {ago(j.updatedAt)}
                  </TD>
                  <TD className="max-w-[280px] truncate text-xs text-status-error" title={j.error ?? ""}>
                    {j.error ?? ""}
                  </TD>
                </TR>
              );
            })}
            {jobs && jobs.jobs.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  큐에 잡이 없습니다.
                </td>
              </tr>
            )}
            {!jobs && !err && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  불러오는 중…
                </td>
              </tr>
            )}
          </TBody>
        </Table>
      </Card>

      {/* per-media analysis */}
      <h2 className="mb-2 text-sm font-semibold text-foreground">업로드 영상 · 분석 결과</h2>
      <Card className="overflow-x-auto p-0">
        <Table>
          <THead>
            <tr>
              <TH>영상</TH>
              <TH>분석 상태</TH>
              <TH>파이프라인 단계</TH>
              <TH numeric>장면</TH>
              <TH numeric>쇼츠</TH>
              <TH numeric>출연자</TH>
              <TH>장르</TH>
              <TH numeric>소요</TH>
              <TH>에러</TH>
            </tr>
          </THead>
          <TBody>
            {(media ?? []).map((m) => {
              const a = m.analysis;
              const tone: StatusTone = !a ? "idle" : a.status === "done" ? "done" : a.status === "failed" ? "error" : "progress";
              const isOpen = expanded === m.mediaId;
              return (
                <Fragment key={m.mediaId}>
                  <TR interactive onClick={() => setExpanded(isOpen ? null : m.mediaId)} className="cursor-pointer">
                    <TD className="max-w-[220px]">
                      <div className="truncate font-medium">{m.title || "(제목 없음)"}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">{m.mediaId}</div>
                    </TD>
                    <TD>
                      <StatusBadge tone={tone}>{a ? a.status : "미분석"}</StatusBadge>
                    </TD>
                    <TD className="text-xs">
                      {m.pipeline?.stage ? (
                        <span className="text-muted-foreground">
                          {m.pipeline.stage}
                          {typeof m.pipeline.progress === "number" ? ` · ${m.pipeline.progress}%` : ""}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TD>
                    <TD numeric className="tabular-nums">{a?.scenes ?? "—"}</TD>
                    <TD numeric className="tabular-nums">{a?.shorts ?? "—"}</TD>
                    <TD numeric className="tabular-nums">{a?.cast ?? "—"}</TD>
                    <TD className="text-xs">{a?.genre ?? "—"}</TD>
                    <TD numeric className="text-xs text-muted-foreground">{a ? secs(a.tookMs) : "—"}</TD>
                    <TD className="max-w-[220px] truncate text-xs text-status-error" title={a?.error ?? ""}>
                      {a?.error ?? ""}
                    </TD>
                  </TR>
                  {isOpen && (
                    <tr>
                      <td colSpan={9} className="border-t border-border bg-muted/30 px-4 py-3 text-xs">
                        <div className="flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground">
                          <span>길이 <b className="text-foreground">{secs(m.durationSec * 1000)}</b></span>
                          <span>오디오 <b className="text-foreground">{m.hasAudio ? "있음" : "없음"}</b></span>
                          <span>업로드 <b className="text-foreground">{ago(m.createdAt)}</b></span>
                          {m.analysis?.stagesDone && (
                            <span>완료 단계 <b className="text-foreground">{m.analysis.stagesDone.join(" → ") || "—"}</b></span>
                          )}
                          {m.analysis && !m.analysis.hasData && <span className="text-status-warn">저장된 분석 데이터 없음</span>}
                          {m.pipeline?.blockedReason && <span className="text-status-error">⚠ {m.pipeline.blockedReason}</span>}
                        </div>
                        {m.episodeId && (
                          <Link
                            href={`/episodes/${m.episodeId}`}
                            className="mt-2 inline-block font-medium text-primary underline-offset-2 hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            회차 상세 · 분석 결과 열기 →
                          </Link>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {media && media.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  업로드된 영상이 없습니다.
                </td>
              </tr>
            )}
            {!media && !err && (
              <tr>
                <td colSpan={9} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  불러오는 중…
                </td>
              </tr>
            )}
          </TBody>
        </Table>
      </Card>
    </>
  );
}
