"use client";

import { useState } from "react";
import Link from "next/link";
import { Bookmark, X } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { useAppData } from "@/lib/data/store";
import { useSavedViews } from "@/lib/use-saved-views";
import {
  ASPECT_RATIOS,
  CLIP_TYPES,
  DISTRIBUTION_CHANNELS,
  targetAgeLabel,
  type ClipType,
  type StatusTone,
} from "@/lib/constants";
import { formatDuration } from "@/lib/utils";
import type { Clip } from "@/lib/types";

interface Filters {
  status: string;
  type: string;
  program: string;
  q: string;
}

const CLIP_STATUS_TONE: Record<Clip["status"], StatusTone> = {
  editing: "idle",
  encoding: "progress",
  ready: "done",
  published: "done",
};
const CLIP_STATUS_LABEL: Record<Clip["status"], string> = {
  editing: "편집 중",
  encoding: "인코딩 중",
  ready: "준비 완료",
  published: "배포됨",
};

export function ClipsView({ initial }: { initial: Filters }) {
  const { clips, programs, episodes, loading } = useAppData();
  const [filters, setFilters] = useState<Filters>(initial);
  const { views, save, remove } = useSavedViews<Filters>("stepd-clip-views");

  function update(patch: Partial<Filters>) {
    const next = { ...filters, ...patch };
    setFilters(next);
    const url = new URL(window.location.href);
    for (const [k, v] of Object.entries(next)) {
      if (v && v !== "all") url.searchParams.set(k, v);
      else url.searchParams.delete(k);
    }
    window.history.replaceState(null, "", url.toString());
  }

  const programOf = (clip: Clip) => episodes.find((e) => e.id === clip.episodeId)?.programId;

  const filtered = clips.filter((clip) => {
    if (filters.status !== "all" && clip.status !== filters.status) return false;
    if (filters.type !== "all" && clip.clipType !== filters.type) return false;
    if (filters.program !== "all" && programOf(clip) !== filters.program) return false;
    if (filters.q && !clip.title.toLowerCase().includes(filters.q.toLowerCase())) return false;
    return true;
  });

  const isDirty = filters.status !== "all" || filters.type !== "all" || filters.program !== "all" || filters.q !== "";

  function saveCurrentView() {
    const name = window.prompt("이 뷰의 이름:");
    if (name?.trim()) save(name.trim(), filters);
  }

  return (
    <>
      <PageHeader
        title="클립"
        description="완성된 클립·쇼츠 목록입니다. 필터는 URL에 동기화되고, 자주 쓰는 조합은 뷰로 저장됩니다."
      />

      {/* filter bar */}
      <Card className="mb-4 flex flex-wrap items-center gap-2 p-3">
        <input
          value={filters.q}
          onChange={(e) => update({ q: e.target.value })}
          placeholder="제목 검색…"
          className="h-8 w-40 rounded-md border border-border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <FilterSelect
          value={filters.status}
          onChange={(v) => update({ status: v })}
          options={[
            ["all", "모든 상태"],
            ["editing", "편집 중"],
            ["encoding", "인코딩 중"],
            ["ready", "준비 완료"],
            ["published", "배포됨"],
          ]}
        />
        <FilterSelect
          value={filters.type}
          onChange={(v) => update({ type: v })}
          options={[["all", "모든 유형"], ...(Object.entries(CLIP_TYPES) as [ClipType, string][])]}
        />
        <FilterSelect
          value={filters.program}
          onChange={(v) => update({ program: v })}
          options={[["all", "모든 프로그램"], ...programs.map((p) => [p.id, p.title] as [string, string])]}
        />

        <div className="ml-auto flex items-center gap-2">
          {isDirty && (
            <>
              <Button size="xs" variant="ghost" onClick={() => update({ status: "all", type: "all", program: "all", q: "" })}>
                초기화
              </Button>
              <Button size="xs" variant="outline" onClick={saveCurrentView}>
                <Bookmark className="size-3.5" /> 뷰 저장
              </Button>
            </>
          )}
        </div>
      </Card>

      {/* saved views */}
      {views.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">저장된 뷰:</span>
          {views.map((v) => (
            <span
              key={v.name}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-card py-0.5 pl-2.5 pr-1 text-xs"
            >
              <button className="font-medium hover:underline" onClick={() => update(v.filters)}>
                {v.name}
              </button>
              <button
                className="rounded-full p-0.5 text-muted-foreground hover:bg-accent"
                onClick={() => remove(v.name)}
                aria-label="뷰 삭제"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="mb-2 text-xs text-muted-foreground">{filtered.length}건</div>

      <Card className="overflow-hidden p-0">
        <Table>
          <THead>
            <tr>
              <TH>제목</TH>
              <TH>유형</TH>
              <TH>비율</TH>
              <TH numeric>길이</TH>
              <TH>연령</TH>
              <TH>상태</TH>
              <TH>배포</TH>
              <TH />
            </tr>
          </THead>
          <TBody>
            {filtered.map((clip) => (
              <TR key={clip.id} interactive>
                <TD>
                  <div className="font-medium">{clip.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {clip.programTitle}
                    {clip.thumbnailLabel && ` · 썸네일: ${clip.thumbnailLabel}`}
                  </div>
                </TD>
                <TD>{CLIP_TYPES[clip.clipType]}</TD>
                <TD className="text-xs text-muted-foreground">{ASPECT_RATIOS[clip.aspectRatio]}</TD>
                <TD numeric>{formatDuration(clip.durationSec)}</TD>
                <TD>{targetAgeLabel(clip.targetAge)}</TD>
                <TD>
                  <StatusBadge tone={CLIP_STATUS_TONE[clip.status]} pulse={clip.status === "encoding"}>
                    {CLIP_STATUS_LABEL[clip.status]}
                  </StatusBadge>
                </TD>
                <TD>
                  <div className="flex flex-wrap gap-1">
                    {clip.distributions.length === 0 && (
                      <span className="text-xs text-muted-foreground/50">—</span>
                    )}
                    {clip.distributions.map((d) => (
                      <StatusBadge
                        key={d.channel}
                        tone={d.status === "failed" ? "error" : d.status === "published" ? "done" : "warn"}
                      >
                        {DISTRIBUTION_CHANNELS[d.channel]}
                      </StatusBadge>
                    ))}
                  </div>
                </TD>
                <TD numeric>
                  <Link
                    href={`/editor/${clip.id}`}
                    className="text-xs font-medium text-primary underline-offset-2 hover:underline"
                  >
                    편집
                  </Link>
                </TD>
              </TR>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-sm text-muted-foreground">
                  {loading ? "클립을 불러오는 중…" : "조건에 맞는 클립이 없습니다."}
                </td>
              </tr>
            )}
          </TBody>
        </Table>
      </Card>
    </>
  );
}

function FilterSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {options.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  );
}
