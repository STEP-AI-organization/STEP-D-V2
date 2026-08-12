"use client";

/**
 * U15 · 영상 검색 (README §9 · FLOWS F9).
 *
 * 이 제품의 목적물은 영상 DB 다 — 쇼츠는 그 위의 질의 하나다.
 * 자연어 질의 + 날짜 필터 → 유튜브 트렌드식 카드 그리드(썸네일·길이·요약).
 * 카드 클릭 → 인라인 미리보기 모달(구간 재생·구간 다운로드·회차 열기).
 * 검색어 없이 들어와도 기본 목록(하이라이트 순)이 뜬다.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAppData } from "@/lib/data/store";
import {
  API_BASE,
  frameUrl,
  getStreamUrl,
  searchSegments,
  segmentDownloadUrl,
  type SearchResponse,
  type SearchResultCard,
} from "@/lib/data/api";
import { cn, fmtTime } from "@/lib/utils";

/** 서버 구간 다운로드 상한(초) — 넘으면 버튼 비활성. */
const MAX_DOWNLOAD_SEC = 300;

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
  const [active, setActive] = useState<SearchResultCard | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    // 빈 질의도 보낸다 — 서버가 하이라이트 순 기본 목록을 돌려준다.
    const query = q.trim();
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

  // 칩·프로그램·방영일을 바꾸면 곧바로 다시 질의한다. run 을 deps 에 넣으면 타자마다
  // 재질의하므로 최신 run 은 ref 로 읽는다. 첫 마운트에도 실행 — 기본 목록을 띄운다.
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });
  useEffect(() => {
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
        <button type="button" className="sd-btn sd-btn-primary" disabled={busy} onClick={run}>
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
            {res.count}건 · {res.parsed.empty
              ? "하이라이트 순 기본 목록 — 검색어를 입력하면 좁혀집니다"
              : res.embedded ? "의미+키워드" : "키워드 단독"}
          </span>
        )}
      </div>

      {/* 서버가 질의를 어떻게 쪼갰는지 — 결과가 이상할 때 여기부터 본다 */}
      {res && !res.parsed.empty && (res.parsed.characters.length > 0 || res.parsed.sceneType || res.parsed.airedFrom) && (
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

      {/* ── 결과 — 카드 그리드 ───────────────────────────────────────────── */}
      {!res ? (
        <div
          className="sd-ph grid min-h-[200px] place-items-center rounded-[6px] px-6 text-center"
          style={{ border: "1px dashed var(--sd-border)" }}
        >
          {busy
            ? "구간을 불러오는 중…"
            : "분석이 끝난 회차의 구간을 문장으로 찾습니다 — 종영작 아카이브도 여기서 뒤집니다"}
        </div>
      ) : res.results.length === 0 ? (
        <div
          className="sd-ph grid min-h-[160px] place-items-center rounded-[6px] px-6 text-center"
          style={{ border: "1px dashed var(--sd-border)" }}
        >
          조건에 맞는 구간이 없습니다 — 기간이나 프로그램을 넓혀 보세요
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {res.results.map((r) => {
            const m = media.find((x) => x.id === r.mediaId);
            return (
              <ResultCard
                key={r.segmentId}
                hit={r}
                episodeLabel={m?.title ?? r.mediaId}
                onOpen={() => setActive(r)}
              />
            );
          })}
        </div>
      )}

      {active && (
        <PreviewModal
          hit={active}
          episodeLabel={media.find((x) => x.id === active.mediaId)?.title ?? active.mediaId}
          episodeId={media.find((x) => x.id === active.mediaId)?.episodeId ?? null}
          onClose={() => setActive(null)}
        />
      )}
    </div>
  );
}

function durSec(hit: SearchResultCard): number {
  return hit.duration ?? hit.end - hit.start;
}

function ResultCard({
  hit,
  episodeLabel,
  onOpen,
}: {
  hit: SearchResultCard;
  episodeLabel: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="sd-card group flex flex-col overflow-hidden p-0 text-left"
      title="클릭해서 미리보기"
    >
      <div className="relative aspect-video w-full" style={{ background: "var(--sd-card-sub)" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={frameUrl(API_BASE, hit.mediaId, hit.start)}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
        />
        <span className="sd-mono absolute bottom-1.5 left-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white">
          {Math.round(durSec(hit))}초
        </span>
        <div className="absolute bottom-1.5 right-1.5 flex gap-1">
          {hit.isShort && (
            <span className="rounded bg-black/70 px-1.5 py-0.5 text-[10.5px] text-white">숏폼</span>
          )}
          {hit.sceneType && (
            <span className="rounded bg-black/70 px-1.5 py-0.5 text-[10.5px] text-white">{hit.sceneType}</span>
          )}
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-1.5 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="sd-mono text-[11px]" style={{ color: "var(--sd-fg)" }}>
            {fmtTime(hit.start)} – {fmtTime(hit.end)}
          </span>
          <span className="truncate text-[10.5px]" style={{ color: "var(--sd-mut)" }}>{episodeLabel}</span>
        </div>

        {hit.summary && (
          <div className="line-clamp-2 text-[12.5px] leading-snug" style={{ color: "var(--sd-fg)" }}>
            {hit.summary}
          </div>
        )}

        {hit.characters.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {hit.characters.slice(0, 4).map((name) => (
              <span key={name} className="sd-tag">{name}</span>
            ))}
          </div>
        )}

        <div className="sd-mono mt-auto text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
          적합도 {(hit.score * 100).toFixed(0)}
          {hit.highlightScore != null && ` · 하이라이트 ${hit.highlightScore}`}
        </div>
      </div>
    </button>
  );
}

/** 인라인 미리보기 — 모달이 열릴 때만 <video> 마운트 (그리드 N개 동시 로드 금지). */
function PreviewModal({
  hit,
  episodeLabel,
  episodeId,
  onClose,
}: {
  hit: SearchResultCard;
  episodeLabel: string;
  episodeId: string | null;
  onClose: () => void;
}) {
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [streamErr, setStreamErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setStreamUrl(null);
    setStreamErr(null);
    getStreamUrl(hit.mediaId)
      .then((url) => { if (alive) setStreamUrl(url); })
      .catch((err) => { if (alive) setStreamErr(err instanceof Error ? err.message : String(err)); });
    return () => { alive = false; };
  }, [hit.mediaId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const seconds = durSec(hit);
  const downloadable = seconds <= MAX_DOWNLOAD_SEC;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="sd-card flex w-full max-w-[900px] flex-col gap-3 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <span className="sd-mono text-[12px]" style={{ color: "var(--sd-fg)" }}>
            {fmtTime(hit.start)} – {fmtTime(hit.end)}
          </span>
          <span className="sd-tag sd-mono">{Math.round(seconds)}초</span>
          {hit.isShort && <span className="sd-tag">숏폼</span>}
          {hit.sceneType && <span className="sd-tag">{hit.sceneType}</span>}
          <span className="truncate text-[11px]" style={{ color: "var(--sd-mut)" }}>{episodeLabel}</span>
          <button type="button" className="sd-btn ml-auto" onClick={onClose}>닫기</button>
        </div>

        <div className="relative aspect-video w-full overflow-hidden rounded-[4px]" style={{ background: "#000" }}>
          {streamUrl ? (
            // 미디어 프래그먼트(#t=start,end) — 구간 시작에서 재생, 끝에서 정지.
            <video
              controls
              autoPlay
              src={`${streamUrl}#t=${hit.start},${hit.end}`}
              className="h-full w-full"
            />
          ) : streamErr ? (
            <div className="grid h-full place-items-center px-6 text-center text-[12px] text-white/80">
              재생 URL을 받지 못했습니다 ({streamErr})
            </div>
          ) : (
            <div className="grid h-full place-items-center">
              <div
                className="h-6 w-6 animate-spin rounded-full border-2 border-white/25"
                style={{ borderTopColor: "#fff" }}
                aria-label="스트림 로딩 중"
              />
            </div>
          )}
        </div>

        {hit.summary && (
          <div className="text-[12.5px] leading-snug" style={{ color: "var(--sd-fg)" }}>{hit.summary}</div>
        )}
        {hit.dialogue && (
          <div className="text-[11.5px] leading-snug" style={{ color: "var(--sd-mut)" }}>
            “{hit.dialogue}”
          </div>
        )}
        {hit.characters.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {hit.characters.map((name) => <span key={name} className="sd-tag">{name}</span>)}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {downloadable ? (
            <a
              href={segmentDownloadUrl(hit.mediaId, hit.start, hit.end)}
              download
              className="sd-btn sd-btn-primary"
            >
              구간 다운로드
            </a>
          ) : (
            <button type="button" className="sd-btn" disabled title="5분 초과 구간은 다운로드 불가">
              구간 다운로드
            </button>
          )}
          {!downloadable && (
            <span className="text-[11px]" style={{ color: "var(--sd-warn)" }}>
              5분 초과 구간은 다운로드 불가
            </span>
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
    </div>
  );
}
