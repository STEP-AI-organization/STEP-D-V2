"use client";

/**
 * 프로그램 분석 — 프로그램을 고르면 그 프로그램의 현황과 **스타일 분석**이 보인다.
 *
 * 두 축을 한 화면에 둔다:
 *  1. 현황 — 회차·클립·배포가 얼마나 쌓였는지 (스토어 데이터 집계 · 지어내지 않는다).
 *  2. 스타일 분석 — 썸네일 생성 정책의 근거. 학습이 "채널의 전형"으로 뽑은 대표 썸네일과
 *     수집 썸네일, 분석 문장을 보여주고, 여기서 바로 학습/재학습을 건다.
 *
 * 조회수·수익 같은 채널 지표는 여기 없다 — 그건 성과/채널 분석 축이고, 프로그램 단위로
 * 합산할 데이터가 아직 없다. 없는 숫자를 그리지 않는다.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { useToast } from "@/components/ui/toast";
import {
  fetchThumbnailStyle,
  trainThumbnailStyle,
  thumbnailStyleImageUrl,
  type ThumbnailStyleProfile,
} from "@/lib/data/api";
import { useAppData } from "@/lib/data/store";
import { channelLabel } from "@/lib/constants";
import { cn } from "@/lib/utils";

export default function ProgramAnalyticsPage() {
  const { programs, episodes, clips, loading } = useAppData();
  const [programId, setProgramId] = useState<string | null>(null);

  // 첫 프로그램 자동 선택 — 빈 화면으로 시작하면 "뭘 눌러야 하지"부터 막힌다.
  useEffect(() => {
    if (!programId && programs.length > 0) setProgramId(programs[0].id);
  }, [programId, programs]);

  const program = programs.find((p) => p.id === programId) ?? null;

  const stats = useMemo(() => {
    if (!program) return null;
    const epIds = new Set(episodes.filter((e) => e.programId === program.id).map((e) => e.id));
    const own = clips.filter((c) => c.programId === program.id || epIds.has(c.episodeId));
    const dists = own.flatMap((c) => (c.distributions ?? []) as { channel: string; status: string }[]);
    const byChannel = new Map<string, { published: number; failed: number; etc: number }>();
    for (const d of dists) {
      const row = byChannel.get(d.channel) ?? { published: 0, failed: 0, etc: 0 };
      if (d.status === "published") row.published += 1;
      else if (d.status === "failed" || d.status === "error") row.failed += 1;
      else row.etc += 1;
      byChannel.set(d.channel, row);
    }
    return {
      episodes: epIds.size,
      clips: own.length,
      shorts: own.filter((c) => c.aspectRatio?.startsWith("9:16")).length,
      published: dists.filter((d) => d.status === "published").length,
      failed: dists.filter((d) => d.status === "failed" || d.status === "error").length,
      byChannel: [...byChannel.entries()],
    };
  }, [program, episodes, clips]);

  return (
    <div className="flex gap-4">
      {/* ── 좌: 프로그램 목록 ─────────────────────────────────────────────── */}
      <aside className="flex w-[240px] shrink-0 flex-col gap-1.5">
        <div className="sd-eb mb-1" style={{ color: "var(--sd-label)" }}>프로그램</div>
        {programs.length === 0 ? (
          <div className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
            {loading ? "불러오는 중…" : "프로그램이 없습니다 — 프로그램 화면에서 먼저 만드세요."}
          </div>
        ) : (
          programs.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setProgramId(p.id)}
              className={cn("sd-card px-3 py-2 text-left", programId === p.id && "sd-btn--on")}
              style={programId === p.id ? { outline: "2px solid var(--sd-accent)", outlineOffset: -1 } : undefined}
            >
              <div className="truncate text-[12.5px] font-medium" style={{ color: "var(--sd-fg)" }}>
                {p.title}
              </div>
              <div className="sd-mono text-[10px]" style={{ color: "var(--sd-mut)" }}>
                {p.section}{p.cast?.length ? ` · 출연 ${p.cast.length}명` : ""}
              </div>
            </button>
          ))
        )}
      </aside>

      {/* ── 우: 선택한 프로그램 ───────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {!program ? (
          <div
            className="sd-ph grid min-h-[200px] place-items-center rounded-[6px] px-6 text-center text-[12.5px]"
            style={{ border: "1px dashed var(--sd-border)", color: "var(--sd-mut)" }}
          >
            왼쪽에서 프로그램을 고르세요.
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-2">
              <h3 className="sd-serif text-[16px] font-semibold" style={{ color: "var(--sd-fg)" }}>
                {program.title}
              </h3>
              <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>{program.section}</span>
              <Link
                href={`/programs/${program.id}/settings`}
                className="ml-auto text-[11px] underline underline-offset-2"
                style={{ color: "var(--sd-accent)" }}
              >
                프로그램 설정
              </Link>
            </div>

            {/* 현황 — 스토어 집계. 채널 조회수·수익은 여기 없다(지어내지 않는다). */}
            {stats && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                {[
                  ["회차", stats.episodes],
                  ["클립", stats.clips],
                  ["숏폼", stats.shorts],
                  ["게시됨", stats.published],
                  ["배포 실패", stats.failed],
                ].map(([label, n]) => (
                  <div key={label} className="sd-card px-3 py-2.5">
                    <div className="sd-mono text-[17px] font-semibold" style={{ color: "var(--sd-fg)" }}>{n}</div>
                    <div className="text-[10.5px]" style={{ color: "var(--sd-mut)" }}>{label}</div>
                  </div>
                ))}
              </div>
            )}

            {stats && stats.byChannel.length > 0 && (
              <div className="sd-card flex flex-col gap-2 p-3">
                <div className="sd-eb" style={{ color: "var(--sd-label)" }}>채널별 배포</div>
                <div className="flex flex-wrap gap-2">
                  {stats.byChannel.map(([ch, row]) => (
                    <span key={ch} className="sd-tag sd-mono text-[10.5px]">
                      {channelLabel(ch)} · 게시 {row.published}
                      {row.failed > 0 ? ` · 실패 ${row.failed}` : ""}
                      {row.etc > 0 ? ` · 진행/기록 ${row.etc}` : ""}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <StyleAnalysisCard programId={program.id} />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 스타일 분석 — 썸네일 생성 정책의 근거를 보여주는 카드.
 * 학습돼 있으면 대표 썸네일(전형 2장)·수집 썸네일·분석 문장, 아니면 학습 폼.
 */
function StyleAnalysisCard({ programId }: { programId: string }) {
  const { toast } = useToast();
  const [style, setStyle] = useState<ThumbnailStyleProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [sourceUrl, setSourceUrl] = useState("");
  const [training, setTraining] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setStyle(null);
    void fetchThumbnailStyle(programId)
      .catch(() => null)
      .then((s) => {
        if (!alive) return;
        setStyle(s);
        setLoading(false);
      });
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

  const agg = (style?.aggregate ?? {}) as Record<string, unknown>;
  const first = (k: string) => {
    const v = agg[k];
    return Array.isArray(v) && Array.isArray(v[0]) ? String(v[0][0]) : "";
  };
  const refNames = style?.refs ?? [];
  const refSet = new Set(refNames);
  const restThumbs = (style?.thumbs ?? []).filter((n) => !refSet.has(n));

  return (
    <div className="sd-card flex flex-col gap-3 p-3">
      <div className="flex items-center gap-2">
        <span className="sd-eb" style={{ color: "var(--sd-label)" }}>스타일 분석 — 썸네일 생성 정책의 근거</span>
        {style && (
          <span className="sd-mono ml-auto text-[10px]" style={{ color: "var(--sd-mut)" }}>
            {String((agg as Record<string, unknown>).sampleSize ?? "?")}장 분석
          </span>
        )}
      </div>

      {loading ? (
        <div className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>불러오는 중…</div>
      ) : style ? (
        <>
          {refNames.length > 0 && (
            <div>
              <div className="mb-1 text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                대표 썸네일 — 이 채널의 전형으로 뽑힌 {refNames.length}장
              </div>
              <div className="flex flex-wrap gap-2">
                {refNames.map((n) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={n}
                    src={thumbnailStyleImageUrl(programId, n)}
                    alt={n}
                    className="aspect-video w-52 rounded-[4px] object-cover"
                    style={{ border: "1px solid var(--sd-border)" }}
                  />
                ))}
              </div>
            </div>
          )}

          <p className="text-[11.5px] leading-relaxed" style={{ color: "var(--sd-fg)" }}>
            {style.prompt || "분석 문장이 없습니다."}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {first("captionPosition") && <span className="sd-tag">자막 {first("captionPosition")}</span>}
            {first("captionLines") && <span className="sd-tag">{first("captionLines")}줄</span>}
            {first("logoPosition") && <span className="sd-tag">로고 {first("logoPosition")}</span>}
            {first("tone") && <span className="sd-tag">{first("tone")}</span>}
            {first("borderDesc") && <span className="sd-tag">{first("borderDesc")}</span>}
          </div>

          {restThumbs.length > 0 && (
            <div>
              <div className="mb-1 text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                학습에 쓴 수집 썸네일 {(style.thumbs ?? []).length}장
                {restThumbs.length > 18 ? " · 18장만 표시" : ""}
              </div>
              <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
                {restThumbs.slice(0, 18).map((n) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={n}
                    src={thumbnailStyleImageUrl(programId, n)}
                    alt={n}
                    className="aspect-video w-full rounded-[3px] object-cover"
                    style={{ border: "1px solid var(--sd-border)" }}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <p className="text-[11.5px] leading-relaxed" style={{ color: "var(--sd-mut)" }}>
          아직 스타일을 학습하지 않았습니다 — 아래에 이 프로그램 채널의 <b>재생목록 URL</b>을
          넣고 학습을 걸면, 썸네일을 수집·분석해 대표 썸네일과 스타일 프로파일이 여기 나타납니다.
        </p>
      )}

      {/* 학습/재학습 — 프로그램당 1회성. 톤이 바뀌면 다시 건다. */}
      <div className="flex gap-2">
        <input
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          placeholder="https://www.youtube.com/playlist?list=…"
          className="sd-input flex-1"
        />
        <button type="button" className="sd-btn" onClick={onTrain} disabled={training}>
          {training ? "요청 중…" : style ? "다시 학습" : "스타일 학습"}
        </button>
      </div>
      <p className="text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
        재생목록 URL을 권합니다 — 채널 전체로 학습하면 여러 프로그램 톤이 섞입니다.
      </p>
    </div>
  );
}
