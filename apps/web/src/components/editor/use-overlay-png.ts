"use client";

/**
 * 서버 canvas 렌더러가 만든 **실제 최종 텍스트 PNG**를 제목·채널 레이어로
 * 나눠 가져온다. 두 레이어를 분리한 이유는 제목을 끌 때 채널 텍스트까지 같이
 * 움직이는 문제를 막기 위함이다.
 *
 * 중요한 불변식:
 *  - 입력이 바뀌어도 직전 PNG를 버리지 않는다. CSS 근사본으로 전환하면 폰트
 *    엔진·커닝·줄높이가 바뀌며 편집 순간에 텍스트가 튀기 때문이다.
 *  - 새 PNG는 GET 이미지까지 미리 로드한 뒤 교체한다. 네트워크 중간 빈 프레임이 없다.
 *  - 요청 순서 보호로 느린 이전 응답이 최신 편집을 덮어쓰지 못한다.
 */

import { useEffect, useRef, useState } from "react";
import { overlayPngSrc, renderClipOverlayPng } from "@/lib/data/api";
import type { EditorState } from "@/lib/editor/presets";

export type OverlayPngLayer = {
  hash: string | null;
  /** 이 PNG가 그려진 당시의 기하. 새 PNG 대기 중 즉시 이동을 계산한다. */
  x: number;
  y: number;
  aspect: string;
  sizes: number[];
  /**
   * 이 PNG에 **그려진 내용**(텍스트·크기·색·글꼴). 위치는 빼고 픽셀에 굽히는 것만 담는다.
   *
   * 소비처가 "지금 상태의 PNG 인가" 를 판정하는 데 쓴다. 이게 없으면 편집을 끝낸 직후
   * **옛 텍스트 PNG 를 현재 것처럼 보여준다** — 새 PNG 가 올 때까지 수백ms 동안
   * 지운 글자가 도로 보이는 "번쩍임" 의 정체였다(2026-09-07).
   * 위치를 빼는 이유: x/y 만 바뀐 건 transform 으로 즉시 따라가므로 PNG 를 숨길 이유가 없다.
   */
  contentKey: string;
};

export type OverlayPngLayers = {
  title: OverlayPngLayer;
  channel: OverlayPngLayer;
};

const EMPTY_LAYER: OverlayPngLayer = { hash: null, x: 0, y: 0, aspect: "", sizes: [], contentKey: "" };

/** PNG 픽셀에 구워지는 것만 — 위치(x/y)는 뺀다. 소비처의 "최신인가" 판정 기준. */
function titleContentKey(s: EditorState): string {
  return JSON.stringify({
    aspect: s.aspect,
    align: s.titleAlign,
    lines: (s.titleLines ?? []).map((l) => ({
      t: l.text, sz: l.size, c: l.color,
      f: l.font ?? null,
      st: l.stroke ? { c: l.stroke.color, w: l.stroke.width } : null,
      kf: (l.keyframes ?? []).length, ss: l.startSec ?? null, es: l.endSec ?? null,
    })),
    coordBasis: s.coordBasis,
  });
}

/** 재요청 트리거용 — 위치까지 포함한다(위치가 PNG 에 구워져 있어서 결국 다시 그려야 한다). */
function titleKey(s: EditorState): string {
  return JSON.stringify({ c: titleContentKey(s), x: s.titleX, y: s.titleY });
}

function channelContentKey(s: EditorState): string {
  return JSON.stringify({
    aspect: s.aspect,
    show: s.showChannel, name: s.channelName,
    labelSize: s.channelLabelSize, layout: s.channelLayout,
    iconSize: s.channelIconSize, iconOff: s.channelIconOff,
    extras: (s.channelExtraLines ?? []).map((l) => ({ t: l.text, sz: l.size })),
    coordBasis: s.coordBasis,
  });
}

function channelKey(s: EditorState): string {
  return JSON.stringify({ c: channelContentKey(s), y: s.channelY });
}

function layerBasis(layer: "title" | "channel", s: EditorState): Omit<OverlayPngLayer, "hash"> {
  return layer === "title"
    ? {
        x: s.titleX ?? 50,
        y: s.titleY ?? 0,
        aspect: String(s.aspect),
        sizes: (s.titleLines ?? []).map((l) => Number(l.size) || 0),
        contentKey: titleContentKey(s),
      }
    : {
        x: 50,
        y: s.channelY ?? 0,
        aspect: String(s.aspect),
        sizes: [Number(s.channelLabelSize) || 0, Number(s.channelIconSize) || 0],
        contentKey: channelContentKey(s),
      };
}

/** 이 PNG 가 **지금 상태의 내용**인가 — 소비처는 이게 true 일 때만 PNG 를 보여야 한다. */
export function pngMatchesContent(
  layer: OverlayPngLayer, which: "title" | "channel", s: EditorState,
): boolean {
  return !!layer.hash
    && layer.contentKey === (which === "title" ? titleContentKey(s) : channelContentKey(s));
}

function preload(src: string): Promise<void> {
  if (typeof Image === "undefined") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("overlay PNG preload failed"));
    img.src = src;
    if (img.complete && img.naturalWidth > 0) resolve();
  });
}

function useOverlayLayerPng(
  clipId: string | undefined,
  state: EditorState,
  layer: "title" | "channel",
  key: string,
  debounceMs: number,
): OverlayPngLayer {
  const [rendered, setRendered] = useState<OverlayPngLayer>(EMPTY_LAYER);
  const stateRef = useRef(state);
  const seq = useRef(0);
  stateRef.current = state;

  useEffect(() => {
    const requestSeq = ++seq.current;
    if (!clipId) {
      setRendered(EMPTY_LAYER);
      return;
    }

    const timer = setTimeout(async () => {
      const snapshot = stateRef.current;
      const basis = layerBasis(layer, snapshot);
      try {
        const res = await renderClipOverlayPng(clipId, snapshot, String(snapshot.aspect), layer);
        if (requestSeq !== seq.current) return;
        if (!res.hash) {
          setRendered({ hash: null, ...basis });
          return;
        }
        // 이미지를 받기 전에 hash만 교체하면 <img>가 순간 빈다.
        await preload(overlayPngSrc(clipId, res.hash));
        if (requestSeq === seq.current) setRendered({ hash: res.hash, ...basis });
      } catch {
        // 직전의 정확한 PNG를 유지한다. 일시 요청 실패로 CSS 근사본으로 튀지 않는다.
      }
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [clipId, debounceMs, key, layer]);

  return rendered;
}

export function useOverlayPng(
  clipId: string | undefined,
  state: EditorState,
  debounceMs = 90,
): OverlayPngLayers {
  const title = useOverlayLayerPng(clipId, state, "title", clipId ? titleKey(state) : "", debounceMs);
  const channel = useOverlayLayerPng(clipId, state, "channel", clipId ? channelKey(state) : "", debounceMs);
  return { title, channel };
}
