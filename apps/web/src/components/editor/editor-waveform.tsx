"use client";

import { useEffect, useRef, useState } from "react";

/** 크기 상한 — 이보다 큰 미디어는 파형 스킵. 60분 마스터(GB급) 부주의 접근 시 탭 OOM 방지.
 *  50MB는 짧은 클립(3~5분 30fps mp4)의 상단쯤 — 우리 채택된 short 클립은 여기 안쪽. */
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

/**
 * Decode a media URL's audio to downsampled peaks (client-side Web Audio) so the
 * operator can see speech boundaries while retrimming (opencut-integration-plan
 * Phase 1). Returns null while loading, on decode error, or when there is no audio.
 *
 * Safety (2026-07-22 HIGH-4-1 fix): HEAD로 Content-Length를 미리 확인해 상한 초과 시
 * 파형을 즉시 포기(스킵)한다. 초과 파일을 그대로 arrayBuffer로 받으면 큰 회차 마스터
 * 선택 시 브라우저 탭이 잠기거나 OOM으로 죽는다. shell이 previewingMaster에서 undefined를
 * 넘겨 이 훅을 스킵시키지만, 이중 안전장치로 여기에도 상한을 둔다.
 */
export function useAudioPeaks(url: string | undefined, buckets = 900): Float32Array | null {
  const [peaks, setPeaks] = useState<Float32Array | null>(null);

  useEffect(() => {
    if (!url) {
      setPeaks(null);
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();

    (async () => {
      let ctx: AudioContext | undefined;
      try {
        // 1) HEAD로 크기 미리 확인 — 상한 초과면 즉시 스킵(다운로드 시작 안 함)
        let size = -1;
        try {
          const head = await fetch(url, { method: "HEAD", signal: ctrl.signal });
          const len = head.headers.get("Content-Length");
          if (len) size = Number.parseInt(len, 10);
        } catch {
          // HEAD 실패해도 GET은 시도 (Range 요청·CORS 등의 이유일 수 있음)
        }
        if (size > MAX_AUDIO_BYTES) {
          // 크기 초과 — 파형 스킵. shell의 previewingMaster 가드와 함께 이중 방어.
          if (!cancelled) setPeaks(null);
          return;
        }

        // 2) 상한 이내 → 정상 다운로드·디코드
        const res = await fetch(url, { signal: ctrl.signal });
        // HEAD 없이 왔을 때 대비 — 응답 헤더에서도 재확인
        const respLen = res.headers.get("Content-Length");
        if (respLen && Number.parseInt(respLen, 10) > MAX_AUDIO_BYTES) {
          if (!cancelled) setPeaks(null);
          return;
        }
        const raw = await res.arrayBuffer();
        if (raw.byteLength > MAX_AUDIO_BYTES) {
          if (!cancelled) setPeaks(null);
          return;
        }
        const AC: typeof AudioContext | undefined =
          window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        const audio = await ctx.decodeAudioData(raw);
        if (cancelled) return;

        const data = audio.getChannelData(0);
        const block = Math.floor(data.length / buckets) || 1;
        const out = new Float32Array(buckets);
        for (let i = 0; i < buckets; i++) {
          let peak = 0;
          const start = i * block;
          for (let j = 0; j < block; j++) {
            const v = Math.abs(data[start + j] || 0);
            if (v > peak) peak = v;
          }
          out[i] = peak;
        }
        let mx = 0;
        for (let i = 0; i < out.length; i++) if (out[i] > mx) mx = out[i];
        if (mx > 0) for (let i = 0; i < out.length; i++) out[i] /= mx;

        if (!cancelled) setPeaks(out);
      } catch {
        if (!cancelled) setPeaks(null);
      } finally {
        void ctx?.close().catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [url, buckets]);

  return peaks;
}

/** Renders peaks as a centered bar waveform filling its (positioned) parent. */
export function Waveform({ peaks, className }: { peaks: Float32Array | null; className?: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;

    const draw = () => {
      const w = parent.clientWidth || 600;
      const h = parent.clientHeight || 36;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      const g = canvas.getContext("2d");
      if (!g) return;
      g.scale(dpr, dpr);
      g.clearRect(0, 0, w, h);
      if (!peaks || peaks.length === 0) return;
      const mid = h / 2;
      const barW = w / peaks.length;
      g.fillStyle = "rgba(161,161,170,0.5)";
      for (let i = 0; i < peaks.length; i++) {
        const barH = Math.max(1, peaks[i] * h * 0.9);
        g.fillRect(i * barW, mid - barH / 2, Math.max(0.5, barW - 0.5), barH);
      }
    };

    draw();
    // ResizeObserver (not window resize): the timeline zoom changes the parent's
    // width without a window resize, and the canvas must redraw at the new width.
    const ro = new ResizeObserver(draw);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [peaks]);

  return <canvas ref={ref} className={className} />;
}
