"use client";

import { useMemo, useState } from "react";
import { Footer } from "@/components/layout/footer";
import { Header } from "@/components/layout/header";
import {
  ChevronDown,
  ChevronUp,
  Clapperboard,
  Film,
  ListPlus,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppData } from "@/lib/data/store";
import { formatDuration } from "@/lib/utils";
import type { Clip } from "@/lib/types";

/**
 * 하이라이트 편성 UI 선구축.
 * 저장·렌더 잡은 아직 만들지 않고, 확정 클립을 선택해 순서와 전체 길이를 검토하는 화면까지만 제공한다.
 */
export function HighlightsView({ programId }: { programId: string }) {
  const { clips, programs, episodes, loading } = useAppData();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");

  const program = programs.find((item) => item.id === programId);
  const programEpisodeIds = useMemo(
    () => new Set(episodes.filter((episode) => episode.programId === programId).map((episode) => episode.id)),
    [episodes, programId],
  );
  const programClips = useMemo(
    () => clips.filter((clip) => programEpisodeIds.has(clip.episodeId)),
    [clips, programEpisodeIds],
  );

  const selected = useMemo(
    () => selectedIds.map((id) => programClips.find((clip) => clip.id === id)).filter((clip): clip is Clip => !!clip),
    [programClips, selectedIds],
  );
  const candidates = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return programClips.filter((clip) => !normalized || clip.title.toLowerCase().includes(normalized));
  }, [programClips, query]);
  const totalDuration = selected.reduce((sum, clip) => sum + clip.durationSec, 0);

  function add(clipId: string) {
    setSelectedIds((current) => (current.includes(clipId) ? current : [...current, clipId]));
  }

  function remove(clipId: string) {
    setSelectedIds((current) => current.filter((id) => id !== clipId));
  }

  function move(clipId: string, direction: -1 | 1) {
    setSelectedIds((current) => {
      const index = current.indexOf(clipId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  }

  return (
    <>
      <Header title="하이라이트 편성" subtitle="확정 클립을 골라 순서와 전체 길이를 검토합니다" />

      <main className="flex-1 p-6 flex flex-col justify-between overflow-y-auto space-y-6">
      <div className="mx-auto max-w-[1240px]">
        {/* 프로그램 상세 하위 화면이라 상단바(SCREEN_META)가 제목을 모른다 — 회차 상세와
            같은 방식으로 여기서 직접 단다. 목록형 화면들은 반대로 상단바에 맡긴다. */}
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-eyebrow mb-1.5">
              {program ? `${program.title} · 클립 조합` : "콘텐츠 · 클립 조합"}
            </div>
            <h1 className="text-page-title">하이라이트</h1>
            <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-[var(--color-text-muted)]">
              확정 클립을 골라 흐름을 구성하는 편성 화면입니다. 저장·렌더·배포는 다음 단계에서 연결합니다.
            </p>
          </div>
          <Badge variant="accent" className="shrink-0 gap-1.5 px-2.5 py-1">
            <Sparkles className="size-3.5" /> UI 선구축
          </Badge>
        </div>

        <Card className="mb-4 border-brand/20 bg-brand/[0.035]">
          <CardContent className="flex gap-3 p-3.5 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
            <Clapperboard className="mt-0.5 size-4 shrink-0 text-[var(--color-bg-active)]" />
            <p>
              <strong className="font-semibold text-[var(--color-text-primary)]">하이라이트는 클립의 조합입니다.</strong>{" "}
              이 화면에서는 원본이나 beat를 직접 자르지 않고, 채택된 클립만 순서대로 편성합니다.
            </p>
          </CardContent>
        </Card>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.8fr)]">
          <Card className="min-w-0">
            <CardHeader className="border-b border-[var(--color-border-subtle)] pb-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardTitle>클립 라이브러리</CardTitle>
                  <CardDescription className="mt-1 text-xs">이 프로그램에서 확정된 클립만 고릅니다.</CardDescription>
                </div>
                <Badge variant="muted">{candidates.length}개</Badge>
              </div>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="클립 제목 검색…"
                className="mt-2 h-8 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-input)] px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </CardHeader>
            <CardContent className="p-0">
              {candidates.length > 0 ? (
                <div className="divide-y divide-[var(--color-border-subtle)]">
                  {candidates.map((clip) => {
                    const added = selectedIds.includes(clip.id);
                    return (
                      <div key={clip.id} className="flex items-center gap-3 px-4 py-3">
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-[var(--color-bg-input)] text-[var(--color-text-muted)]">
                          <Film className="size-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-semibold">{clip.title}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
                            <span>{clip.programTitle}</span>
                            <span>·</span>
                            <span>{formatDuration(clip.durationSec)}</span>
                            <Badge variant="muted" className="text-[10px]">{clip.aspectRatio}</Badge>
                          </div>
                        </div>
                        <Button
                          size="xs"
                          variant={added ? "secondary" : "outline"}
                          disabled={added}
                          onClick={() => add(clip.id)}
                        >
                          {added ? "추가됨" : <><Plus className="size-3.5" /> 추가</>}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
                  <Clapperboard className="mb-3 size-7 text-[var(--color-text-muted)]" />
                  <div className="text-sm font-semibold">{loading ? "클립을 불러오는 중…" : "선택할 클립이 없습니다."}</div>
                  <p className="mt-1 max-w-sm text-xs leading-relaxed text-[var(--color-text-muted)]">
                    회차의 클립 후보를 채택하면 이 라이브러리에서 하이라이트 재료로 선택할 수 있습니다.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="min-w-0">
            <CardHeader className="border-b border-[var(--color-border-subtle)] pb-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardTitle>하이라이트 구성</CardTitle>
                  <CardDescription className="mt-1 text-xs">위에서 아래 순서로 연결됩니다.</CardDescription>
                </div>
                <Badge variant={selected.length ? "accent" : "muted"}>{selected.length}개 클립</Badge>
              </div>
              {/* 저장 잡이 없어서 구성은 브라우저 메모리에만 있다 — 미리 말해 두지 않으면
                  새로고침 한 번에 날아간 걸 고장으로 읽는다. */}
              <CardDescription className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
                이 구성은 저장되지 않습니다 — 새로고침하면 초기화됩니다.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {selected.length > 0 ? (
                <>
                  <ol className="divide-y divide-[var(--color-border-subtle)]">
                    {selected.map((clip, index) => (
                      <li key={clip.id} className="flex items-center gap-3 px-4 py-3">
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-bg-input)] text-[11px] font-bold text-[var(--color-text-muted)]">
                          {index + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-semibold">{clip.title}</div>
                          <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">{formatDuration(clip.durationSec)}</div>
                        </div>
                        <div className="flex items-center gap-0.5">
                          <Button size="xs" variant="ghost" aria-label="위로 이동" disabled={index === 0} onClick={() => move(clip.id, -1)}>
                            <ChevronUp className="size-3.5" />
                          </Button>
                          <Button size="xs" variant="ghost" aria-label="아래로 이동" disabled={index === selected.length - 1} onClick={() => move(clip.id, 1)}>
                            <ChevronDown className="size-3.5" />
                          </Button>
                          <Button size="xs" variant="ghost" aria-label="구성에서 제거" onClick={() => remove(clip.id)}>
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ol>
                  <div className="border-t border-[var(--color-border-subtle)] bg-muted/25 p-4">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-[var(--color-text-muted)]">클립 합산 길이</span>
                      <strong className="text-sm tabular-nums">{formatDuration(totalDuration)}</strong>
                    </div>
                    <Button className="mt-3 w-full" disabled title="하이라이트 저장·렌더 기능은 아직 연결되지 않았습니다.">
                      <ListPlus className="size-4" /> 하이라이트 저장·렌더 (준비 중)
                    </Button>
                  </div>
                </>
              ) : (
                <div className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
                  <ListPlus className="mb-3 size-7 text-[var(--color-text-muted)]" />
                  <div className="text-sm font-semibold">클립을 선택해 구성하세요.</div>
                  <p className="mt-1 max-w-xs text-xs leading-relaxed text-[var(--color-text-muted)]">
                    선택한 클립의 순서를 바꾸며 주요 장면의 흐름을 미리 설계할 수 있습니다.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

        {/* Footer */}
        <Footer />
      </main>
    </>
  );
}
