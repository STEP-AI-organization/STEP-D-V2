"use client";

/**
 * 타임라인 프레임 파노라마 — 영상 장면이 썸네일로 쭉 늘어서 편집 시 어디가 어느 장면인지
 * 눈으로 보인다(Opus Clip·CapCut 식 필름스트립).
 *
 * ⚠️ **실제 프레임이다.** 서버 `/media/:id/frame?t=` 가 그 시각의 프레임을 뽑아
 * `analysis/{id}/frames/{t}.jpg` 로 **GCS 캐시**한다 — 한 번 뽑은 건 즉시 반환되고 새 것만
 * ffmpeg 1회. 그래서 파노라마로 여러 장을 깔아도 두 번째부터는 공짜다.
 *
 * 이 컴포넌트는 타임라인 스크롤 컨테이너(`width: zoom*100%`) **안**에 놓인다 — 그래서 폭·줌·
 * 스크롤이 눈금·트랙과 자동으로 같은 좌표를 쓴다. 각 썸네일은 자기 구간의 **중앙 시각**을
 * 대표로 보여준다.
 */
import { useMemo } from "react";

import { frameUrl } from "@/lib/data/api";

export function Filmstrip({
  mediaId,
  duration,
  apiBase,
  /** 썸네일 한 장이 대표할 시간 폭(초). 촘촘할수록 장면 파악이 쉽지만 첫 로드에 프레임을 더 뽑는다. */
  stepSec = 1.2,
  /** 스트립 높이(px). 9:16 세로 프레임 기준 가로폭이 정해진다. */
  height = 40,
}: {
  mediaId: string | undefined;
  duration: number;
  apiBase: string;
  stepSec?: number;
  height?: number;
}) {
  // 구간 중앙 시각들. 개수 상한을 둔다 — 아주 긴 원본에서 수백 장을 한 번에 요청하지 않게
  // (그래도 캐시되면 다음부턴 즉시). 상한에 걸리면 간격이 넓어질 뿐 정렬은 유지된다.
  const marks = useMemo(() => {
    if (!mediaId || !(duration > 0)) return [];
    const MAX = 120;
    const step = Math.max(stepSec, duration / MAX);
    const out: { t: number; leftPct: number; widPct: number }[] = [];
    for (let s = 0; s < duration; s += step) {
      const e = Math.min(duration, s + step);
      out.push({
        t: (s + e) / 2,
        leftPct: (s / duration) * 100,
        widPct: ((e - s) / duration) * 100,
      });
    }
    return out;
  }, [mediaId, duration, stepSec]);

  if (!mediaId || marks.length === 0) {
    // 원본이 없거나 길이를 모르면 스트립을 그리지 않는다(빈 회색 밭 대신 조용히 없음).
    return null;
  }

  return (
    <div className="relative overflow-hidden bg-zinc-950" style={{ height }}>
      {marks.map((m, i) => (
        <div
          key={i}
          className="absolute top-0 overflow-hidden border-r border-black/40"
          style={{ left: `${m.leftPct}%`, width: `${m.widPct}%`, height }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={frameUrl(apiBase, mediaId, m.t)}
            alt=""
            loading="lazy"
            draggable={false}
            className="h-full w-full object-cover"
            // 프레임 추출 실패(끝단 등)는 조용히 비운다 — 한 칸 회색이 낫지 스트립 전체가 깨지지 않게.
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }}
          />
        </div>
      ))}
    </div>
  );
}
