"use client";

/**
 * 트랜스크립트 편집 뷰 — Opus Clip 식 "자막을 읽으며 편집" 좌측 패널.
 *
 * 자막(STT)이 문단으로 흐르고, 클릭하면 그 시각으로 점프한다. 재생 중인 문장은 하이라이트된다.
 * 말이 끊긴 구간엔 pause 배지(`0.6s`)를, 장면이 바뀌는 지점엔 회색 장면 설명을 끼워 넣는다.
 *
 * ⚠️ **여기 있는 건 전부 실제로 동작한다.** 클릭 = 진짜 seek, 하이라이트 = 실제 재생 위치.
 * 데이터가 없는 기능(예: 문장 삭제 → 컷)은 아직 백엔드가 없어 **버튼을 만들지 않는다** —
 * 작동 안 하는 버튼은 화면이 거짓말하는 것이다(사용자 원칙 2026-08-12).
 *
 * 좌표: transcript.start/end 는 **원본(master) 절대초**다. 재생 좌표(클립이면 0부터) 변환은
 * 부모(editor-shell)가 안다 — 그래서 클릭은 절대초로 올려보내고, 현재 위치도 절대초로 받는다.
 */
import { useEffect, useMemo, useRef } from "react";

import type { AnalysisScene, AnalysisTranscriptSegment } from "@/lib/data/api";

/** 이 간격(초) 이상 말이 비면 pause 배지를 보여준다. 실측상 0.3s 미만은 자연스러운 호흡이다. */
const PAUSE_MIN = 0.35;

type Row =
  | { kind: "seg"; seg: AnalysisTranscriptSegment; gapBefore: number }
  | { kind: "scene"; text: string; start: number };

export function TranscriptView({
  segments,
  scenes,
  currentAbs,
  onSeekAbs,
  hookQuote,
}: {
  segments: AnalysisTranscriptSegment[] | undefined;
  scenes: AnalysisScene[] | undefined;
  /** 현재 재생 위치(원본 절대초). */
  currentAbs: number;
  /** 그 절대초로 이동 요청. 부모가 재생 좌표로 변환한다. */
  onSeekAbs: (absSec: number) => void;
  /** 훅 대사 — 있으면 그 문장을 노란색으로 강조(제목 재료라 눈에 띄게). */
  hookQuote?: string;
}) {
  // 세그먼트 + 장면 설명을 시각순으로 엮는다. 장면은 그 시작 시각 직전에 회색 줄로 끼운다.
  const rows = useMemo<Row[]>(() => {
    const segs = (segments ?? []).filter((s) => (s.text ?? "").trim());
    const out: Row[] = [];
    // 장면 설명 후보: vision_reason(장면 요약)이 있는 것만. 없으면 장면 줄을 안 만든다.
    const sceneRows = (scenes ?? [])
      .filter((sc) => (sc.vision_reason ?? "").trim())
      .map((sc) => ({ start: Number(sc.start ?? 0), text: String(sc.vision_reason).trim() }))
      .sort((a, b) => a.start - b.start);
    let si = 0;
    let prevEnd = segs.length ? Number(segs[0].start ?? 0) : 0;
    for (const seg of segs) {
      const start = Number(seg.start ?? 0);
      // 이 세그먼트 앞에 시작하는 장면 설명을 먼저 흘려보낸다.
      while (si < sceneRows.length && sceneRows[si].start <= start + 0.01) {
        out.push({ kind: "scene", text: sceneRows[si].text, start: sceneRows[si].start });
        si++;
      }
      out.push({ kind: "seg", seg, gapBefore: Math.max(0, start - prevEnd) });
      prevEnd = Number(seg.end ?? start);
    }
    // 남은 장면 설명(맨 끝)
    while (si < sceneRows.length) {
      out.push({ kind: "scene", text: sceneRows[si].text, start: sceneRows[si].start });
      si++;
    }
    return out;
  }, [segments, scenes]);

  // 현재 재생 중인 세그먼트 인덱스 — 하이라이트 + 자동 스크롤.
  const activeIdx = useMemo(() => {
    return rows.findIndex(
      (r) => r.kind === "seg"
        && currentAbs >= Number(r.seg.start ?? 0)
        && currentAbs < Number(r.seg.end ?? Number(r.seg.start ?? 0) + 3),
    );
  }, [rows, currentAbs]);

  // 재생을 따라 활성 문장을 화면 안으로. 사용자가 스크롤 중이면 방해하지 않게 부드럽게만.
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeIdx]);

  const hook = (hookQuote ?? "").trim();

  if (!segments) {
    return (
      <div className="p-3 text-[12px] text-zinc-500">자막(STT)을 불러오는 중…</div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="p-3 text-[12px] text-zinc-500">
        이 회차에는 자막 데이터가 없습니다. (STT 미생성)
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-[13px] leading-relaxed text-zinc-200">
      {rows.map((r, i) => {
        if (r.kind === "scene") {
          // 장면 설명 — Opus 의 회색 B-roll 설명 대응. 클릭하면 그 시각으로.
          return (
            <button
              key={`sc${i}`}
              onClick={() => onSeekAbs(r.start)}
              className="my-1 block w-full rounded bg-zinc-900/60 px-2 py-1 text-left text-[11px] italic text-zinc-500 hover:text-zinc-300"
              title={`${r.start.toFixed(1)}s 로 이동`}
            >
              {r.text}
            </button>
          );
        }
        const seg = r.seg;
        const active = i === activeIdx;
        const isHook = hook && (seg.text ?? "").includes(hook);
        return (
          <span key={`sg${i}`}>
            {/* 말이 끊긴 구간 — 얼마나 비었는지 배지로. Opus 의 `0.58s` 와 같은 표기. */}
            {r.gapBefore >= PAUSE_MIN && (
              <span className="mx-1 inline-block rounded bg-zinc-800 px-1 text-[10px] text-zinc-500 align-middle">
                {r.gapBefore.toFixed(2)}s
              </span>
            )}
            <button
              ref={active ? activeRef : undefined}
              onClick={() => onSeekAbs(Number(seg.start ?? 0))}
              className={
                "rounded px-0.5 text-left transition-colors " +
                (active
                  ? "bg-amber-400/25 text-white"
                  : isHook
                    ? "text-amber-300 hover:bg-zinc-800"
                    : "hover:bg-zinc-800")
              }
              title={`${Number(seg.start ?? 0).toFixed(1)}s${seg.speaker ? ` · ${seg.speaker}` : ""}`}
            >
              {seg.text}
            </button>{" "}
          </span>
        );
      })}
    </div>
  );
}
