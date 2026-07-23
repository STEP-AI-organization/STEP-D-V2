'use client';

import type { ReactNode } from 'react';
import type { NarrativeData } from '@/lib/data/api';
import { useVideoSeek } from './episode/seek-context';

/** 초 단위 → MM:SS */
function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** "[00:12] 뒤통수..." 같은 key_moment에서 앞의 timecode 파싱 → 초. 없으면 null. */
function parseTimecodePrefix(km: string): number | null {
  const m = /^\[?(\d{1,2}):(\d{2})\]?\s*/.exec(km);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** `**bold**` + `[MM:SS]` 타임스탬프(클릭 시 seek) 인라인 파싱 → ReactNode[]. */
function renderInline(text: string, onSeek: ((sec: number) => void) | undefined): ReactNode[] {
  const out: ReactNode[] = [];
  // 하나의 정규식으로 볼드와 타임스탬프를 동시에 캡처 — 원문 순서로 방출.
  const re = /\*\*([^*]+)\*\*|\[(\d{1,2}):(\d{2})\]/g;
  let last = 0;
  let idx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] != null) {
      out.push(
        <strong key={idx++} className="font-semibold text-foreground">
          {m[1]}
        </strong>,
      );
    } else {
      const mm = Number(m[2]);
      const ss = Number(m[3]);
      const sec = mm * 60 + ss;
      out.push(
        <button
          key={idx++}
          type="button"
          className="tabular-nums text-status-warn hover:underline"
          onClick={onSeek ? () => onSeek(sec) : undefined}
          title={`▶ ${fmt(sec)}부터 재생`}
        >
          [{m[2]}:{m[3]}]
        </button>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * full_summary(마크다운 문자열)를 최소 구현으로 렌더.
 * 파이프라인이 실제로 뽑는 문법만 처리: `# / ## / ###` 헤딩, `*  ` `-` 불릿, `**볼드**`, `[MM:SS]` 타임스탬프.
 * 블록 사이 빈 줄은 문단 구분자.
 */
function SummaryMarkdown({
  text,
  onSeek,
}: {
  text: string;
  onSeek?: (sec: number) => void;
}) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const nodes: ReactNode[] = [];
  let listBuf: string[] = [];
  let paraBuf: string[] = [];
  let key = 0;

  const flushList = () => {
    if (!listBuf.length) return;
    const items = listBuf;
    listBuf = [];
    nodes.push(
      <ul key={key++} className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground">
        {items.map((it, i) => (
          <li key={i}>{renderInline(it, onSeek)}</li>
        ))}
      </ul>,
    );
  };
  const flushPara = () => {
    if (!paraBuf.length) return;
    const joined = paraBuf.join(' ');
    paraBuf = [];
    nodes.push(
      <p key={key++} className="text-sm leading-relaxed text-muted-foreground">
        {renderInline(joined, onSeek)}
      </p>,
    );
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushList();
      flushPara();
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flushList();
      flushPara();
      const level = h[1].length;
      const content = h[2];
      const cls =
        level === 1
          ? 'text-base font-semibold text-foreground'
          : level === 2
            ? 'text-sm font-semibold text-primary'
            : 'text-sm font-medium text-foreground';
      // 헤딩 태그를 동적으로 결정 (h1/h2/h3)
      const Tag = (`h${level}` as unknown) as keyof React.JSX.IntrinsicElements;
      nodes.push(
        <Tag key={key++} className={cls}>
          {renderInline(content, onSeek)}
        </Tag>,
      );
      continue;
    }
    const li = /^\s*[*\-]\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      listBuf.push(li[1]);
      continue;
    }
    flushList();
    paraBuf.push(line);
  }
  flushList();
  flushPara();

  return <div className="space-y-2">{nodes}</div>;
}

export function NarrativeView({ narrative }: { narrative: NarrativeData | null | undefined }) {
  const seek = useVideoSeek();

  if (!narrative) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
        서사 분석 데이터가 없습니다
      </div>
    );
  }

  const { full_summary, segments, characters, key_conflicts } = narrative;

  return (
    <div className="space-y-6 p-4">
      {/* ── 전체분석 ── */}
      <section>
        <h3 className="text-sm font-semibold text-primary mb-2">📖 전체 서사 요약</h3>
        <div className="bg-muted/50 rounded-lg p-4">
          {full_summary ? (
            <SummaryMarkdown text={full_summary} onSeek={(s) => seek?.seekTo(s)} />
          ) : (
            <p className="text-sm text-muted-foreground">전체 요약 정보가 없습니다.</p>
          )}
        </div>
      </section>

      {/* ── 구간별분석 ── */}
      {segments && segments.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-primary mb-3">📑 구간별 분석</h3>
          <div className="space-y-3">
            {segments.map((seg) => (
              <div key={seg.block_index} className="bg-muted/50 rounded-lg p-3">
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => seek?.seekTo(seg.start)}
                  title={`▶ ${fmt(seg.start)}부터 재생`}
                >
                  <div className="flex items-start justify-between mb-1">
                    <h4 className="text-sm font-medium text-foreground">{seg.title}</h4>
                    <span className="text-xs text-muted-foreground shrink-0 ml-2 tabular-nums">
                      {fmt(seg.start)} ~ {fmt(seg.end)}
                    </span>
                  </div>
                </button>
                <p className="text-xs text-muted-foreground mb-2">{seg.summary}</p>

                {/* Pass3 chip 라인: 정서 톤·장소·브랜드 */}
                {(seg.emotional_tone || (seg.locations && seg.locations.length > 0) || (seg.brands && seg.brands.length > 0)) && (
                  <div className="flex flex-wrap items-center gap-1 mb-2">
                    {seg.emotional_tone && (
                      <span className="px-1.5 py-0.5 bg-status-warn/15 rounded text-[10px] font-medium text-status-warn">
                        tone: {seg.emotional_tone}
                      </span>
                    )}
                    {seg.locations?.map((l) => (
                      <span key={l} className="px-1.5 py-0.5 bg-brand/15 rounded text-[10px] text-brand">📍 {l}</span>
                    ))}
                    {seg.brands?.map((b) => (
                      <span key={b} className="px-1.5 py-0.5 bg-status-done/15 rounded text-[10px] text-status-done">🏷 {b}</span>
                    ))}
                  </div>
                )}

                {seg.key_moments && seg.key_moments.length > 0 && (
                  <div className="space-y-0.5">
                    {seg.key_moments.map((km, i) => {
                      const t = parseTimecodePrefix(km);
                      return (
                        <button
                          key={i}
                          type="button"
                          className="block w-full text-left text-xs text-status-warn hover:underline"
                          onClick={() => seek?.seekTo(t ?? seg.start)}
                          title={t != null ? `▶ ${fmt(t)}` : `▶ ${fmt(seg.start)}`}
                        >
                          ▸ {km}
                        </button>
                      );
                    })}
                  </div>
                )}
                {seg.characters && seg.characters.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {seg.characters.map((c) => (
                      <span key={c} className="px-1.5 py-0.5 bg-muted rounded text-[10px] text-muted-foreground">
                        {c}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── 인물분석 ── */}
      {characters && characters.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-primary mb-3">👤 인물 분석</h3>
          <div className="grid gap-3">
            {characters.map((c) => (
              <div key={c.name} className="bg-muted/50 rounded-lg p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium text-foreground">{c.name}</span>
                  {c.role && <span className="text-[10px] text-muted-foreground">({c.role})</span>}
                  {c.total_screen_sec > 0 && (
                    <span className="text-[10px] text-muted-foreground ml-auto tabular-nums">
                      {fmt(c.total_screen_sec)}
                    </span>
                  )}
                </div>
                {c.personality_traits && c.personality_traits.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-1">
                    {c.personality_traits.map((t) => (
                      <span key={t} className="px-1.5 py-0.5 bg-muted rounded text-[10px] text-muted-foreground">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                {c.key_relationships && c.key_relationships.length > 0 && (
                  <div className="space-y-0.5">
                    {c.key_relationships.map((r) => (
                      <div key={r} className="text-[10px] text-muted-foreground">🔗 {r}</div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── 갈등분석 ── */}
      {key_conflicts && key_conflicts.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-primary mb-3">⚡ 주요 갈등 / 핵심 사건</h3>
          <div className="space-y-3">
            {key_conflicts.map((cf, i) => (
              <div key={i} className="bg-muted/50 rounded-lg p-3 border-l-2 border-status-warn/40">
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => cf.time_range && seek?.seekTo(cf.time_range.start)}
                  title={cf.time_range ? `▶ ${fmt(cf.time_range.start)}부터 재생` : ''}
                >
                  <div className="flex items-start justify-between mb-1">
                    <h4 className="text-sm font-medium text-foreground">{cf.title}</h4>
                    {cf.time_range && (
                      <span className="text-xs text-muted-foreground shrink-0 ml-2 tabular-nums">
                        {fmt(cf.time_range.start)} ~ {fmt(cf.time_range.end)}
                      </span>
                    )}
                  </div>
                </button>
                <p className="text-xs text-muted-foreground mb-1">{cf.description}</p>
                {cf.participants && cf.participants.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-1">
                    {cf.participants.map((p) => (
                      <span key={p} className="px-1.5 py-0.5 bg-status-error/10 rounded text-[10px] text-status-error">
                        {p}
                      </span>
                    ))}
                  </div>
                )}
                {cf.resolution && (
                  <div className="text-[10px] text-muted-foreground italic">{cf.resolution}</div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
