"use client";

import { useCallback, useState } from "react";
import { Search, Loader2, Scissors, Clapperboard, Sparkles } from "lucide-react";

import {
  searchSegments,
  logSearchEvent,
  getStreamUrl,
  type SearchResponse,
  type SearchResultCard,
} from "@/lib/data/api";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";

const SCENE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "전체 장면" },
  { value: "interview", label: "인터뷰" },
  { value: "on_scene", label: "현장" },
];

const SCENE_LABEL: Record<string, string> = { interview: "인터뷰", on_scene: "현장" };

function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 권리 주석 배지 — ⚠️ 로 시작하면 경고 톤, 그 외(확인필요)는 muted. */
function rightsBadgeClass(text: string): string {
  return text.startsWith("⚠️")
    ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
    : "border-border bg-muted text-muted-foreground";
}

/**
 * 결과 카드. "구간 보기"는 재생과 동시에 **클릭 로그**를 남긴다 — 어떤 쿼리에서 몇 위를
 * 실제로 골랐는지가 랭킹 학습의 지도 신호다(core/search_log.py §8).
 */
function ResultCard({ r, rank, queryId }: { r: SearchResultCard; rank: number; queryId?: string }) {
  const rights = Object.entries(r.rightsStatus ?? {});
  const { toast: push } = useToast();

  const open = useCallback(async () => {
    logSearchEvent({
      event: "click",
      queryId,
      segmentId: r.segmentId,
      mediaId: r.mediaId,
      rank,
      start: r.start,
      end: r.end,
    });
    try {
      const url = await getStreamUrl(r.mediaId);
      // #t=start,end — 브라우저 미디어 프래그먼트. 구간만 재생된다.
      window.open(`${url}#t=${r.start.toFixed(2)},${r.end.toFixed(2)}`, "_blank", "noopener");
    } catch (e) {
      push({ tone: "error", title: "재생 실패", description: e instanceof Error ? e.message : String(e) });
    }
  }, [r, rank, queryId, push]);

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-semibold text-foreground">
            {mmss(r.start)}–{mmss(r.end)}
          </span>
          {r.duration != null && (
            <span className="text-xs text-muted-foreground">{Math.round(r.duration)}초</span>
          )}
          {r.isShort && (
            <Badge variant="accent" className="gap-1">
              <Scissors className="size-3" /> 쇼츠
            </Badge>
          )}
          {r.sceneType && <Badge variant="secondary">{SCENE_LABEL[r.sceneType] ?? r.sceneType}</Badge>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={open}>구간 보기</Button>
          <span className="font-mono text-[11px] text-muted-foreground" title={`bm25 ${r.lex.toFixed(2)} · cos ${r.vec.toFixed(3)}`}>
            {r.score.toFixed(4)}
          </span>
        </div>
      </div>

      {r.characters?.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {r.characters.map((c) => (
            <Badge key={c} variant="outline">{c}</Badge>
          ))}
        </div>
      )}

      {r.summary && <p className="mt-2 text-sm leading-relaxed text-foreground">{r.summary}</p>}
      {r.dialogue && (
        <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">“{r.dialogue}”</p>
      )}

      {rights.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border pt-3">
          {rights.map(([k, v]) => (
            <span key={k} className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium ${rightsBadgeClass(v)}`}>
              {v}
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}

export default function SearchPage() {
  const { toast: push } = useToast();
  const [q, setQ] = useState("");
  const [sceneType, setSceneType] = useState("");
  const [onlyShorts, setOnlyShorts] = useState(false);
  const [allowSpoiler, setAllowSpoiler] = useState(false);
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [searched, setSearched] = useState(false);

  const run = useCallback(async () => {
    const query = q.trim();
    if (!query) return;
    setLoading(true);
    setSearched(true);
    try {
      const r = await searchSegments({
        q: query,
        sceneType: sceneType || undefined,
        isShort: onlyShorts ? true : undefined,
        allowSpoiler,
        topK: 30,
      });
      setRes(r);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setRes(null);
      push({ tone: "error", title: "검색 실패", description: msg });
    } finally {
      setLoading(false);
    }
  }, [q, sceneType, onlyShorts, allowSpoiler, push]);

  const parsed = res?.parsed;

  return (
    <div>
      <PageHeader
        eyebrow="영상 검색"
        title="구간 검색"
        description="자연어로 원하는 순간을 찾는다 — 잘라서 바로 쓸 수 있는 구간(beat) 단위. 인물·장면유형·방영일 필터는 쿼리에서 자동으로 뽑고, 못 쓰는 구간(스포일러·권리)은 걸러진다."
      />

      {/* 검색 바 */}
      <Card className="mb-3 p-3">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") run(); }}
                placeholder="예: 23기 영철 인터뷰 · 작년쯤 나온 요리 대결 · A랑 B 싸우는 씬"
                className="h-10 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm outline-none focus:border-foreground/25"
              />
            </div>
            <Button onClick={run} disabled={loading || !q.trim()}>
              {loading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              검색
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <select
              value={sceneType}
              onChange={(e) => setSceneType(e.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 text-sm"
            >
              {SCENE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <input type="checkbox" checked={onlyShorts} onChange={(e) => setOnlyShorts(e.target.checked)} />
              쇼츠로 터진 구간만
            </label>
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <input type="checkbox" checked={allowSpoiler} onChange={(e) => setAllowSpoiler(e.target.checked)} />
              스포일러 포함
            </label>
          </div>
        </div>
      </Card>

      {/* 파싱 결과 (투명성) */}
      {parsed && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Sparkles className="size-3.5 text-brand" />
          <span>파싱:</span>
          {parsed.charactersUsed.length > 0 && (
            <span>인물 <b className="text-foreground">{parsed.charactersUsed.join(", ")}</b></span>
          )}
          {parsed.sceneType && <span>장면 <b className="text-foreground">{SCENE_LABEL[parsed.sceneType] ?? parsed.sceneType}</b></span>}
          {(parsed.airedFrom || parsed.airedTo) && (
            <span>방영 <b className="text-foreground">{parsed.airedFrom ?? "…"}~{parsed.airedTo ?? "…"}</b></span>
          )}
          {parsed.isShort && <span className="text-foreground">쇼츠</span>}
          {parsed.semantic && <span>의미 “<span className="text-foreground">{parsed.semantic}</span>”</span>}
          <span className="ml-auto">{res.embedded ? "의미검색 ON" : "키워드만"}</span>
        </div>
      )}

      {/* 결과 */}
      {!searched ? (
        <EmptyState
          icon={Search}
          title="찾을 순간을 입력하세요"
          description="방송사 실무자 쿼리는 대개 필터 — 프로그램·회차·방영일·출연자. 그 위에 상황·대사를 얹으면 의미검색이 순위를 매깁니다."
        />
      ) : loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> 검색 중…
        </div>
      ) : res && res.results.length > 0 ? (
        <>
          <div className="mb-2 text-xs text-muted-foreground">{res.count}개 구간</div>
          <div className="grid gap-2.5">
            {res.results.map((r, i) => (
              <ResultCard key={r.segmentId} r={r} rank={i + 1} queryId={res.queryId} />
            ))}
          </div>
        </>
      ) : (
        <EmptyState
          icon={Clapperboard}
          title="결과 없음"
          description="필터가 너무 좁거나 아직 인덱싱된 구간이 없을 수 있습니다. 스포일러 포함을 켜거나 장면유형을 넓혀보세요."
        />
      )}
    </div>
  );
}
