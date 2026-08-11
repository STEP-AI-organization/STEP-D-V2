"use client";

/**
 * U15 · 영상 검색 (README §9 · FLOWS F9).
 *
 * 이 제품의 목적물은 영상 DB 다 — 쇼츠는 그 위의 질의 하나다.
 * 자연어 질의 + 날짜 필터 → 구간 카드(회차·시각·근거).
 *
 * 권리 배지는 **게이트 어휘로 통일**한다. 검색 결과의 `rightsStatus` 는 파이프라인이 붙인
 * 힌트지 판정이 아니다 — "확인 필요"라고 적고, 통과 여부를 말하지 않는다.
 * 게이트는 미디어가 된 뒤에 사람이 등록한 이슈로만 걸린다(F3).
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAppData } from "@/lib/data/store";
import { searchSegments, type SearchResponse, type SearchResultCard } from "@/lib/data/api";
import { fmtTime } from "@/lib/gate-ui";
import { cn } from "@/lib/utils";

export default function SearchPage() {
  const { programs, media } = useAppData();

  const [q, setQ] = useState("");
  const [programId, setProgramId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [onlyShorts, setOnlyShorts] = useState<boolean | null>(null);
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // 한 번이라도 검색했는지 — 첫 진입에 빈 질의로 쏘지 않기 위한 가드.
  const searchedRef = useRef(false);

  const run = useCallback(async () => {
    const query = q.trim();
    if (!query) return;
    searchedRef.current = true;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    try {
      const r = await searchSegments(
        {
          q: query,
          program: programId || undefined,
          airedFrom: from || undefined,
          airedTo: to || undefined,
          ...(onlyShorts != null ? { isShort: onlyShorts } : {}),
          topK: 30,
        },
        ac.signal,
      );
      setRes(r);
      setError(null);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      setRes(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [q, programId, from, to, onlyShorts]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // 칩·프로그램·방영일을 바꾸면 곧바로 다시 질의한다. 선택 상태만 켜지고 결과가 이전
  // 질의 그대로면 "적용됐다"는 거짓 피드백이 된다. run 을 deps 에 넣으면 타자마다
  // 재질의하므로 최신 run 은 ref 로 읽는다.
  // (ref 갱신은 렌더 중이 아니라 이펙트에서 — 렌더 중 ref 쓰기는 lint error 다.
  //  이 이펙트가 아래 재질의 이펙트보다 먼저 선언돼 있어야 최신 run 이 보인다.)
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });
  useEffect(() => {
    if (!searchedRef.current) return;
    void runRef.current();
  }, [programId, from, to, onlyShorts]);

  return (
    <div className="mx-auto flex max-w-[1240px] flex-col gap-[14px]">
      {/* ── 질의 ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-[9px]">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void run(); }}
          placeholder="찾고 싶은 장면을 문장으로 (예: 지난달 방송에서 출연자가 정색하며 판을 뒤집는 순간)"
          className="sd-input min-w-[320px] flex-1"
          aria-label="검색어"
        />
        <button type="button" className="sd-btn sd-btn-primary" disabled={busy || !q.trim()} onClick={run}>
          {busy ? "찾는 중…" : "검색"}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-[9px]">
        <select value={programId} onChange={(e) => setProgramId(e.target.value)} className="sd-input">
          <option value="">전 프로그램</option>
          {programs.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>

        <label className="flex items-center gap-1.5 text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
          방영일
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="sd-input" />
          <span>–</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="sd-input" />
        </label>

        <div className="flex gap-[3px]">
          {([[null, "전체"], [true, "숏폼"], [false, "롱폼"]] as const).map(([v, label]) => (
            <button
              key={String(v)}
              type="button"
              className={cn("sd-btn", onlyShorts === v && "sd-btn--on")}
              onClick={() => setOnlyShorts(v)}
            >
              {label}
            </button>
          ))}
        </div>

        {res && (
          <span className="sd-mono ml-auto text-[11px]" style={{ color: "var(--sd-mut)" }}>
            {res.count}건 · {res.embedded ? "의미+키워드" : "키워드 단독"}
          </span>
        )}
      </div>

      {/* 서버가 질의를 어떻게 쪼갰는지 — 결과가 이상할 때 여기부터 본다 */}
      {res && (res.parsed.characters.length > 0 || res.parsed.sceneType || res.parsed.airedFrom) && (
        <div
          className="rounded-[4px] px-3 py-2 text-[11px]"
          style={{ border: "1px solid var(--sd-border)", background: "var(--sd-card-sub)", color: "var(--sd-mut)" }}
        >
          질의 해석 —{" "}
          {res.parsed.characters.length > 0 && <>인물 {res.parsed.characters.join(", ")} · </>}
          {res.parsed.sceneType && <>장면 {res.parsed.sceneType} · </>}
          {res.parsed.airedFrom && <>기간 {res.parsed.airedFrom}~{res.parsed.airedTo ?? ""} · </>}
          의미 “{res.parsed.semantic || q}”
          {!res.embedded && (
            <> · <b style={{ color: "var(--sd-warn)" }}>임베딩 실패로 키워드만 사용했습니다</b></>
          )}
        </div>
      )}

      {error && (
        <div
          className="rounded-[4px] px-3 py-2 text-[11.5px]"
          style={{ border: "1px solid var(--sd-danger-border)", background: "var(--sd-danger-bg)", color: "var(--sd-danger-strong)" }}
        >
          검색에 실패했습니다 ({error}).
        </div>
      )}

      {/* ── 결과 ─────────────────────────────────────────────────────────── */}
      {!res ? (
        <div
          className="sd-ph grid min-h-[200px] place-items-center rounded-[6px] px-6 text-center"
          style={{ border: "1px dashed var(--sd-border)" }}
        >
          분석이 끝난 회차의 구간을 문장으로 찾습니다 — 종영작 아카이브도 여기서 뒤집니다
        </div>
      ) : res.results.length === 0 ? (
        <div
          className="sd-ph grid min-h-[160px] place-items-center rounded-[6px] px-6 text-center"
          style={{ border: "1px dashed var(--sd-border)" }}
        >
          조건에 맞는 구간이 없습니다 — 기간이나 프로그램을 넓혀 보세요
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {res.results.map((r) => {
            const m = media.find((x) => x.id === r.mediaId);
            return (
              <ResultCard
                key={r.segmentId}
                hit={r}
                episodeLabel={m?.title ?? r.mediaId}
                episodeId={m?.episodeId ?? null}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function ResultCard({
  hit,
  episodeLabel,
  episodeId,
}: {
  hit: SearchResultCard;
  episodeLabel: string;
  episodeId: string | null;
}) {
  // 파이프라인이 붙인 권리 주석은 **판정이 아니다.** 게이트 어휘로 "확인 필요"까지만 말한다.
  const rights = Object.values(hit.rightsStatus ?? {});

  return (
    <div className="sd-card flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="sd-mono text-[11.5px]" style={{ color: "var(--sd-fg)" }}>
          {fmtTime(hit.start)} – {fmtTime(hit.end)}
        </span>
        <span className="sd-tag sd-mono">{Math.round(hit.duration ?? hit.end - hit.start)}초</span>
        {hit.sceneType && <span className="sd-tag">{hit.sceneType}</span>}
        {hit.isShort && <span className="sd-tag">숏폼</span>}
        {hit.characters.length > 0 && <span className="sd-tag">{hit.characters.join(", ")}</span>}
        <span className="sd-mono ml-auto text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
          적합도 {(hit.score * 100).toFixed(0)}
          {hit.highlightScore != null && ` · 하이라이트 ${hit.highlightScore}`}
        </span>
      </div>

      <div className="truncate text-[10.5px]" style={{ color: "var(--sd-mut)" }}>{episodeLabel}</div>

      {hit.summary && (
        <div className="text-[12.5px] leading-snug" style={{ color: "var(--sd-fg)" }}>{hit.summary}</div>
      )}
      {hit.dialogue && (
        <div className="line-clamp-2 text-[11.5px] leading-snug" style={{ color: "var(--sd-mut)" }}>
          “{hit.dialogue}”
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {rights.length > 0 && (
          <>
            {rights.map((label, i) => (
              <span key={i} className="sd-tag sd-tag--warn">{label}</span>
            ))}
            <span className="text-[10px]" style={{ color: "var(--sd-mut)" }}>
              — 파이프라인이 붙인 참고 표시입니다. 실제 게이트는 미디어로 만든 뒤 사람이 등록한 이슈로 걸립니다.
            </span>
          </>
        )}
        {/* /media 는 채택된 클립 목록이라 검색 히트(원본 구간)를 못 연다 — 원본이 있는 회차로 보낸다. */}
        {episodeId ? (
          <Link href={`/episodes/${episodeId}?tab=analyze`} className="sd-btn ml-auto">
            회차에서 열기
          </Link>
        ) : (
          <button
            type="button"
            className="sd-btn ml-auto"
            disabled
            title="이 구간의 원본 영상이 회차에 연결돼 있지 않습니다"
          >
            회차에서 열기
          </button>
        )}
      </div>
    </div>
  );
}
