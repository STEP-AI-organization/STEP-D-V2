"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Decode a media URL's audio to downsampled peaks (client-side Web Audio) so the
 * operator can see speech boundaries while retrimming (opencut-integration-plan
 * Phase 1). Returns null while loading, on decode error, or when there is no audio.
 *
 * Note: fetches the whole file to decode, so this targets short adopted clips — not
 * full episode masters. A server-side peaks endpoint is the scale path (plan §7.4).
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
        const res = await fetch(url, { signal: ctrl.signal });
        const raw = await res.arrayBuffer();
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
