"use client";

/**
 * useOverlayPng — 정적 오버레이(제목·채널명)를 서버가 canvas 로 그린 **실제 PNG** 의 hash 를
 * debounce 로 받아온다 (AENA use-overlay-render 이식). 에디터는 이 hash 로 `<img>` 를 띄워
 * CSS 근사 대신 **결과물과 같은 픽셀**을 보여준다(구조적 WYSIWYG).
 *
 *  - PNG 에 영향을 주는 정적 필드가 바뀌면: 즉시 hash=null(편집 중 stale PNG 숨김 → CSS 폴백)
 *    → debounce 후 서버 렌더 요청 → 새 hash 저장.
 *  - state 객체 ref 는 매 렌더 바뀌므로(재생 중 currentTime 등) **직렬화 key** 로만 effect 를
 *    재실행한다 — 안 그러면 debounce 타이머가 매 프레임 clear 돼 영영 안 뜬다.
 *  - clipId 가 없으면 항상 null(순수 CSS) — 무회귀.
 */

import { useEffect, useRef, useState } from "react";
import { renderClipOverlayPng } from "@/lib/data/api";
import type { EditorState } from "@/lib/editor/presets";

/** PNG 결과에 영향을 주는 정적 오버레이 입력만 직렬화 (이 값이 바뀔 때만 재요청). */
function overlayKey(s: EditorState): string {
  return JSON.stringify({
    aspect: s.aspect,
    titleX: s.titleX, titleY: s.titleY, titleAlign: s.titleAlign,
    titleLines: (s.titleLines ?? []).map((l) => ({
      t: l.text, sz: l.size, c: l.color,
      kf: (l.keyframes ?? []).length, ss: l.startSec ?? null, es: l.endSec ?? null,
    })),
    showChannel: s.showChannel, channelName: s.channelName, channelY: s.channelY,
    channelLabelSize: s.channelLabelSize, channelLayout: s.channelLayout,
    channelIconSize: s.channelIconSize,
    channelExtraLines: (s.channelExtraLines ?? []).map((l) => ({ t: l.text, sz: l.size })),
    stagePx: (s as { stagePx?: number }).stagePx,
  });
}

export function useOverlayPng(
  clipId: string | undefined,
  state: EditorState,
  debounceMs = 350,
): string | null {
  const [hash, setHash] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const key = clipId ? overlayKey(state) : "";

  useEffect(() => {
    if (!clipId) {
      setHash(null);
      return;
    }
    setHash(null); // 편집 중엔 CSS 로 폴백(직전 hash 의 stale 픽셀 플리커 제거)
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const s = stateRef.current;
        const res = await renderClipOverlayPng(clipId, s, s.aspect);
        setHash(res.hash);
      } catch {
        setHash(null); // 실패 시 CSS 유지
      }
    }, debounceMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key 가 정적 입력 변화를 대표한다
  }, [clipId, key, debounceMs]);

  return hash;
}
