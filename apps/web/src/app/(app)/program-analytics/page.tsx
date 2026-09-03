"use client";

/**
 * 프로그램 분석 — **디자이너 산출물 이식 파일럿** (2026-09-03).
 *
 * 원본: `STEPD_SaaS_UI_V1/src/app/program-analytics/page.tsx` (173줄).
 * 이식 계획이 이 화면을 파일럿으로 고른 이유: 신규 API 0개 · 파괴적 동작 없음 ·
 * 권한 분기 없음 · 이 파일을 지목하는 서버 테스트 없음. 그런데 **신규 배관은 전부 지난다**
 * (셸 승격 · MIGRATED 분기 · Header prop · main 내부 스크롤 · 목→store · 하드코딩 링크 동적화).
 *
 * ## 마크업·클래스·문구는 원본 그대로
 * 바깥 두 겹 래퍼(`flex h-screen …` · `flex-1 flex flex-col …`)만 뺐다 — 그건 이제
 * `(app)/layout.tsx` 가 그린다. 원본과 **문자 단위로 같은** 래퍼라 기하는 그대로다.
 *
 * ## 목 → 실데이터
 * | 원본 | 이식본 |
 * |---|---|
 * | `MOCK_PROGRAM_LIST` 3개 | `useAppData().programs` |
 * | `detailUrl: '/programs/p_b98969f4'` | `` `/programs/${id}` `` |
 * | 지표 `4 · 11 · 11 · 17 · 0` | 회차·클립·숏폼·게시·실패 실제 집계 |
 * | `YouTube · 게시 16` / `TikTok · 게시 1` | 채널별 실제 배포 집계 |
 * | 스타일 분석 빈 상태 | `fetchThumbnailStyle()` — **학습된 상태는 원본에 없어서** 우리 표시를 남겼다 |
 *
 * ⚠️ 디자이너는 스타일 분석의 **빈 상태만** 그렸다. 학습이 끝난 프로그램에서는 보여줄 게
 * 있어야 하므로, 원본 카드 안에서 요약을 추가로 그린다. 빈 상태는 원본 그대로다.
 */
import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { Footer } from "@/components/layout/footer";
import { Header } from "@/components/layout/header";
import { useToast } from "@/components/ui/toast";
import {
  fetchThumbnailStyle,
  trainThumbnailStyle,
  thumbnailStyleImageUrl,
  type ThumbnailStyleProfile,
} from "@/lib/data/api";
import { channelLabel } from "@/lib/constants";
import { useAppData } from "@/lib/data/store";

export default function ProgramAnalysisPage() {
  const { programs, episodes, clips, loading } = useAppData();
  const [selectedProgramId, setSelectedProgramId] = useState<string | null>(null);

  // 첫 프로그램 자동 선택 — 빈 화면으로 시작하면 "뭘 눌러야 하지" 부터 막힌다.
  useEffect(() => {
    if (!selectedProgramId && programs.length > 0) setSelectedProgramId(programs[0].id);
  }, [selectedProgramId, programs]);

  const selectedProgram = programs.find((p) => p.id === selectedProgramId) ?? null;

  const stats = useMemo(() => {
    if (!selectedProgram) return null;
    const epIds = new Set(episodes.filter((e) => e.programId === selectedProgram.id).map((e) => e.id));
    const own = clips.filter((c) => c.programId === selectedProgram.id || epIds.has(c.episodeId));
    const dists = own.flatMap((c) => (c.distributions ?? []) as { channel: string; status: string }[]);
    const byChannel = new Map<string, number>();
    for (const d of dists) {
      if (d.status !== "published") continue;
      byChannel.set(d.channel, (byChannel.get(d.channel) ?? 0) + 1);
    }
    return {
      episodes: epIds.size,
      clips: own.length,
      shorts: own.filter((c) => c.aspectRatio?.startsWith("9:16")).length,
      published: dists.filter((d) => d.status === "published").length,
      failed: dists.filter((d) => d.status === "failed" || d.status === "error").length,
      byChannel: [...byChannel.entries()],
    };
  }, [selectedProgram, episodes, clips]);

  return (
    <>
      {/* Header */}
      <Header title="프로그램 분석" subtitle="프로그램 현황 · 썸네일 스타일 분석" />

      {/* Program Analysis Main Content */}
      <main className="flex-1 p-5 flex flex-col justify-between overflow-hidden">
        <div className="space-y-4 flex-1 flex flex-col min-h-0">
          {/* Top 2-Column Section */}
          <div className="grid grid-cols-12 gap-4 flex-1 min-h-0">
            {/* Left Column: Program Select List */}
            <div className="col-span-3 bg-[var(--color-bg-card)] border-none shadow-md shadow-slate-900/5 dark:shadow-none rounded-xl p-3 flex flex-col space-y-2">
              <h3 className="text-xs font-bold text-[var(--color-text-muted)] px-1">
                프로그램
              </h3>

              <div className="space-y-1 overflow-y-auto flex-1">
                {programs.length === 0 ? (
                  // 원본엔 없던 상태 — 목 데이터는 항상 3개였다. 빈 화면이 "데이터 없음" 인지
                  // "서버 미연결" 인지 구분되게 적는다.
                  <p className="p-2.5 text-[11px] text-[var(--color-text-muted)] leading-relaxed">
                    {loading ? "불러오는 중…" : "프로그램이 없습니다 — 프로그램 화면에서 먼저 만드세요."}
                  </p>
                ) : (
                  programs.map((prog) => {
                    const isSelected = selectedProgramId === prog.id;
                    return (
                      <div
                        key={prog.id}
                        onClick={() => setSelectedProgramId(prog.id)}
                        className={`p-2.5 rounded-lg transition-all cursor-pointer text-xs ${
                          isSelected
                            ? "bg-[#1C60FF]/10 text-[#1C60FF] font-bold"
                            : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-input)] hover:text-[var(--color-text-primary)] font-medium"
                        }`}
                      >
                        <h4 className={`text-xs mb-0.5 ${isSelected ? "font-bold text-[#1C60FF]" : "font-bold text-[var(--color-text-primary)]"}`}>
                          {prog.title}
                        </h4>
                        <p className="text-[10px] opacity-80">
                          {prog.section || "장르 미지정"}
                        </p>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Right Column: Program Details & Analysis */}
            <div className="col-span-9 space-y-4 flex flex-col min-h-0 overflow-y-auto">
              {selectedProgram && stats ? (
                <>
                  {/* Header Title */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <h2 className="text-base font-bold text-[var(--color-text-primary)]">
                        {selectedProgram.title}
                      </h2>
                      <span className="text-xs text-[var(--color-text-muted)]">
                        {selectedProgram.section || "장르 미지정"}
                      </span>
                    </div>

                    <Link
                      href={`/programs/${selectedProgram.id}/settings`}
                      className="text-xs text-[var(--color-text-accent)] hover:underline cursor-pointer font-medium"
                    >
                      프로그램 설정
                    </Link>
                  </div>

                  {/* 5 Metrics Row */}
                  <div className="grid grid-cols-5 gap-3">
                    <Metric label="회차" value={stats.episodes} />
                    <Metric label="클립" value={stats.clips} />
                    <Metric label="숏폼" value={stats.shorts} />
                    <Metric label="게시됨" value={stats.published} />
                    <Metric label="배포 실패" value={stats.failed} />
                  </div>

                  {/* Channel Deploy Status Row */}
                  <div className="bg-[var(--color-bg-card)] border-none shadow-md shadow-slate-900/5 dark:shadow-none p-3.5 rounded-xl space-y-2.5 text-xs">
                    <h4 className="font-bold text-[var(--color-text-primary)] text-sm">
                      채널별 배포
                    </h4>
                    <div className="flex items-center gap-2">
                      {stats.byChannel.length === 0 ? (
                        <span className="text-[11px] text-[var(--color-text-muted)]">아직 게시된 채널이 없습니다.</span>
                      ) : (
                        stats.byChannel.map(([channel, n]) => (
                          <span
                            key={channel}
                            className="px-3 py-1 rounded-full bg-[var(--color-bg-input)] border border-[var(--color-border-subtle)] text-xs text-[var(--color-text-primary)] font-medium"
                          >
                            {channelLabel(channel)} · 게시 <strong className="text-[var(--color-text-accent)]">{n}</strong>
                          </span>
                        ))
                      )}
                    </div>
                  </div>

                  {/* Style Analysis Section */}
                  <StyleAnalysisCard programId={selectedProgram.id} />
                </>
              ) : null}
            </div>
          </div>
        </div>

        {/* Footer */}
        <Footer />
      </main>
    </>
  );
}

/** 지표 타일 — 원본에 다섯 번 복붙돼 있던 것을 그대로 한 조각으로 뽑았다(클래스 동일). */
function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-[var(--color-bg-card)] border-none shadow-md shadow-slate-900/5 dark:shadow-none p-3.5 rounded-xl">
      <div className="text-xs font-medium text-[var(--color-text-muted)] mb-1">{label}</div>
      <div className="text-2xl font-bold text-[var(--color-text-primary)]">{value}</div>
    </div>
  );
}

/**
 * 스타일 분석 — 썸네일 대표 성격 학습.
 *
 * 원본은 **빈 상태만** 그렸다(목업이라 항상 미학습). 빈 상태 마크업·문구는 원본 그대로 두고,
 * 학습이 끝난 프로그램에서 보여줄 요약을 같은 카드 안에 덧붙였다 — 없으면 학습을 해도
 * 화면이 안 변해서 "된 건가?" 가 된다.
 */
function StyleAnalysisCard({ programId }: { programId: string }) {
  const { toast } = useToast();
  const [style, setStyle] = useState<ThumbnailStyleProfile | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [training, setTraining] = useState(false);

  useEffect(() => {
    let alive = true;
    setStyle(null);
    void fetchThumbnailStyle(programId)
      .catch(() => null)
      .then((s) => { if (alive) setStyle(s); });
    return () => { alive = false; };
  }, [programId]);

  async function onTrain() {
    const url = sourceUrl.trim();
    if (!url) { toast({ title: "재생목록 URL을 넣어주세요", tone: "error" }); return; }
    setTraining(true);
    try {
      await trainThumbnailStyle(programId, url);
      toast({ title: "스타일 학습을 시작했습니다", description: "수집·분석에 몇 분 걸립니다. 끝나면 이 화면에 나타납니다." });
    } catch (e) {
      toast({ title: "학습 요청 실패", description: e instanceof Error ? e.message : String(e), tone: "error" });
    } finally {
      setTraining(false);
    }
  }

  const refs = style?.refs ?? [];

  return (
    <div className="bg-[var(--color-bg-card)] border-none shadow-md shadow-slate-900/5 dark:shadow-none rounded-xl p-4 space-y-3 text-xs">
      <h4 className="font-bold text-[var(--color-text-primary)] text-sm">
        스타일 분석 — 썸네일 대표 성격 학습
      </h4>

      {refs.length > 0 ? (
        // 원본에 없는 상태(학습 완료). 같은 카드 안에서 대표 썸네일만 보여준다.
        <div className="flex flex-wrap gap-2">
          {refs.slice(0, 6).map((n) => (
            // eslint-disable-next-line @next/next/no-img-element -- 외부 썸네일, next/image 불필요
            <img
              key={n}
              src={thumbnailStyleImageUrl(programId, n)}
              alt=""
              className="h-16 rounded-lg border border-[var(--color-border-subtle)]"
            />
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
          아직 스타일을 학습하지 않았습니다 — 아래에 이 프로그램 채널의 재생목록 URL을 넣고 학습을 누르면, 썸네일을 수집·분석해 대표 썸네일과 스타일 프로필이 여기 나타납니다.
        </p>
      )}

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          placeholder="https://www.youtube.com/playlist?list=..."
          className="flex-1 bg-[var(--color-bg-input)] border border-[var(--color-border-subtle)] px-4 py-2 rounded-full text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-bg-active)]"
        />
        <button
          onClick={onTrain}
          disabled={training}
          style={{ boxShadow: "none" }}
          className="px-4 py-2 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-xs text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] font-medium cursor-pointer shadow-none disabled:cursor-not-allowed disabled:opacity-70"
        >
          {training ? "요청 중…" : "스타일 학습"}
        </button>
      </div>

      <p className="text-[10px] text-[var(--color-text-muted)]">
        재생목록 URL을 권장합니다 — 채널 전체로 학습하면 여러 프로그램 혼이 섞입니다.
      </p>
    </div>
  );
}
