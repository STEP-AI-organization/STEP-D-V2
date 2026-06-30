"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PplAnalysis, PplProduct } from "@/lib/api";

const PPL_BOX_COLORS = ["#6C5CE7", "#27E0A0", "#5B8CFF", "#FFD400", "#FF49DB", "#15A088"];

type Box = [number, number, number, number];
type Keyframe = { t: number; box: Box };
type Track = {
  id: string;
  brand: string;
  product: string;
  confidence: number;
  start: number;
  end: number;
  kfs: Keyframe[];
  detectionTimes: number[];
};
type Segment = { start: number; end: number };

const PAD = 0.75;
const SEGMENT_PRE_ROLL = 0.45;
const SEGMENT_POST_ROLL = 0.75;
const SEGMENT_MERGE_GAP = 0.7;
const SKIP_COOLDOWN_MS = 280;

const lerp = (a: number, b: number, r: number) => a + (b - a) * r;
const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const smoothstep = (r: number) => r * r * (3 - 2 * r);

function clampBox(box: Box): Box {
  const x = clamp(box[0]);
  const y = clamp(box[1]);
  const w = clamp(box[2], 0.035, 0.94);
  const h = clamp(box[3], 0.025, 0.94);
  return [clamp(x, 0, 1 - w), clamp(y, 0, 1 - h), w, h];
}

function boxForDemoMotion(base: Box, ratio: number, seed: number): Box {
  const wave = Math.sin(ratio * Math.PI * 2 + seed);
  const lift = Math.cos(ratio * Math.PI * 1.65 + seed * 0.6);
  const pulse = 1 + Math.sin(ratio * Math.PI * 2.3 + seed) * 0.025;
  return clampBox([
    base[0] + wave * Math.min(0.022, base[2] * 0.055),
    base[1] + lift * Math.min(0.016, base[3] * 0.07),
    base[2] * pulse,
    base[3] * (1 + (pulse - 1) * 0.55),
  ]);
}

// Median spacing between sampled frame timestamps → adaptive gap threshold.
function gapThreshold(times: number[]): number {
  const diffs: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > 0.001) diffs.push(d);
  }
  if (!diffs.length) return 2.6;
  diffs.sort((a, b) => a - b);
  const median = diffs[Math.floor(diffs.length / 2)];
  return Math.min(12, Math.max(2.6, median * 1.6));
}

function detectionWindow(product: PplProduct, kfs: Keyframe[]): { start: number; end: number } {
  const detectedStart = kfs[0]?.t ?? Number.POSITIVE_INFINITY;
  const detectedEnd = kfs[kfs.length - 1]?.t ?? Number.NEGATIVE_INFINITY;
  const firstSeen = Number.isFinite(product.first_seen) ? product.first_seen : detectedStart;
  const lastSeen = Number.isFinite(product.last_seen) ? product.last_seen : detectedEnd;
  const exposureEnd = Number.isFinite(product.exposure_seconds) ? firstSeen + product.exposure_seconds : lastSeen;
  const start = Math.min(firstSeen, detectedStart);
  const end = Math.max(lastSeen, detectedEnd, exposureEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    const t = Number.isFinite(detectedStart) ? detectedStart : 0;
    return { start: t, end: t + 2.4 };
  }
  return { start, end };
}

function buildKeyframes(product: PplProduct, raw: Keyframe[]): Keyframe[] {
  const sorted = raw
    .map((kf) => ({ t: kf.t, box: clampBox(kf.box) }))
    .filter((kf) => Number.isFinite(kf.t))
    .sort((a, b) => a.t - b.t);
  const base = clampBox((product.best_box || sorted[0]?.box || [0.18, 0.22, 0.42, 0.2]) as Box);
  const { start, end } = detectionWindow(product, sorted);
  const duration = Math.max(0.8, end - start);

  if (sorted.length <= 1) {
    return [0, 0.28, 0.56, 0.82, 1].map((ratio, index) => ({
      t: start + duration * ratio,
      box: boxForDemoMotion(base, ratio, product.id.length + index),
    }));
  }

  if (sorted.length < 5 && duration > 2.8) {
    const byTime = new Map(sorted.map((kf) => [kf.t.toFixed(2), kf]));
    for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
      const t = start + duration * ratio;
      const key = t.toFixed(2);
      if (!byTime.has(key)) byTime.set(key, { t, box: boxForDemoMotion(base, ratio, product.id.length) });
    }
    return [...byTime.values()].sort((a, b) => a.t - b.t);
  }

  return sorted;
}

function sampleBox(track: Track, t: number, maxGap: number): Box | null {
  const kfs = track.kfs;
  if (!kfs.length || t < track.start - PAD || t > track.end + PAD) return null;
  const first = kfs[0];
  const last = kfs[kfs.length - 1];
  if (t <= first.t) return first.t - t <= PAD ? first.box : null;
  if (t >= last.t) return t - last.t <= PAD ? last.box : null;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (a.t <= t && t <= b.t) {
      if (b.t - a.t > maxGap) return null; // gap → product is off screen
      const r = b.t === a.t ? 0 : smoothstep((t - a.t) / (b.t - a.t));
      return [
        lerp(a.box[0], b.box[0], r),
        lerp(a.box[1], b.box[1], r),
        lerp(a.box[2], b.box[2], r),
        lerp(a.box[3], b.box[3], r),
      ];
    }
  }
  return null;
}

function segmentsForTrack(track: Track, maxGap: number): Segment[] {
  const times = [...track.detectionTimes]
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!times.length) {
    return [{ start: Math.max(0, track.start - SEGMENT_PRE_ROLL), end: track.start + 2.4 }];
  }

  const segments: Segment[] = [];
  let start = times[0];
  let end = times[0];
  const splitGap = Math.max(0.9, Math.min(maxGap, 2.8));
  for (let i = 1; i < times.length; i++) {
    const next = times[i];
    if (next - end <= splitGap) {
      end = next;
      continue;
    }
    segments.push({ start: Math.max(0, start - SEGMENT_PRE_ROLL), end: end + SEGMENT_POST_ROLL });
    start = next;
    end = next;
  }
  segments.push({ start: Math.max(0, start - SEGMENT_PRE_ROLL), end: end + SEGMENT_POST_ROLL });
  return segments;
}

function mergeSegments(tracks: Track[], maxGap: number): Segment[] {
  const source = tracks
    .flatMap((track) => segmentsForTrack(track, maxGap))
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start)
    .sort((a, b) => a.start - b.start);
  const merged: Segment[] = [];
  for (const segment of source) {
    const last = merged[merged.length - 1];
    if (last && segment.start <= last.end + SEGMENT_MERGE_GAP) {
      last.end = Math.max(last.end, segment.end);
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

function segmentAt(segments: Segment[], t: number): Segment | null {
  return segments.find((segment) => segment.start - 0.08 <= t && t <= segment.end + 0.08) || null;
}

function nextSegment(segments: Segment[], t: number): Segment | null {
  return segments.find((segment) => segment.start > t + 0.12) || segments[0] || null;
}

// 9:16 player that draws brand/product bounding boxes synced to playback.
// Boxes are normalized 0..1 of the rendered frame. The per-frame detections form
// a keyframe track per product; the box is interpolated between keyframes and
// hidden whenever the product is not on screen (no nearby detection).
export function PplOverlayPlayer({ analysis, videoUrl, poster, maxWidth = 300 }: { analysis: PplAnalysis; videoUrl?: string; poster?: string; maxWidth?: number }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastSkipRef = useRef(0);
  const [t, setT] = useState(0);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return undefined;
    let raf = 0;
    const sync = () => setT(v.currentTime);
    const tick = () => {
      sync();
      raf = window.requestAnimationFrame(tick);
    };
    const start = () => {
      window.cancelAnimationFrame(raf);
      tick();
    };
    const stop = () => {
      window.cancelAnimationFrame(raf);
      sync();
    };
    const onTime = () => sync();
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("seeked", onTime);
    v.addEventListener("play", start);
    v.addEventListener("pause", stop);
    v.addEventListener("ended", stop);
    if (!v.paused) start();
    return () => {
      window.cancelAnimationFrame(raf);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("seeked", onTime);
      v.removeEventListener("play", start);
      v.removeEventListener("pause", stop);
      v.removeEventListener("ended", stop);
    };
  }, [videoUrl]);

  const colorFor = (id: string) => {
    const idx = analysis.products.findIndex((p) => p.id === id);
    return PPL_BOX_COLORS[(idx < 0 ? 0 : idx) % PPL_BOX_COLORS.length];
  };

  const tracks = useMemo(() => {
    const raw = new Map<string, Keyframe[]>();
    const frames = [...(analysis.frames || [])].sort((a, b) => a.timestamp - b.timestamp);
    for (const f of frames) {
      for (const d of f.detections || []) {
        const list = raw.get(d.product_id) || [];
        list.push({ t: f.timestamp, box: d.box as Box });
        raw.set(d.product_id, list);
      }
    }
    return analysis.products.map((product) => {
      const detections = raw.get(product.id) || [];
      const kfs = buildKeyframes(product, detections);
      const { start, end } = detectionWindow(product, kfs);
      return {
        id: product.id,
        brand: product.brand,
        product: product.product,
        confidence: product.confidence,
        start,
        end,
        kfs,
        detectionTimes: detections.map((kf) => kf.t),
      };
    });
  }, [analysis]);

  const maxGap = useMemo(
    () => gapThreshold([...(analysis.frames || [])].map((f) => f.timestamp).sort((a, b) => a - b)),
    [analysis]
  );
  const cueStart = useMemo(() => {
    const starts = tracks.map((track) => track.start).filter((value) => Number.isFinite(value));
    return starts.length ? Math.min(...starts) : 0;
  }, [tracks]);
  const visibleSegments = useMemo(() => mergeSegments(tracks, maxGap), [tracks, maxGap]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !videoUrl) return undefined;
    const cue = () => {
      if (v.currentTime < 0.5 && cueStart > 1) {
        v.currentTime = Math.max(0, cueStart - 0.55);
        setT(v.currentTime);
      }
    };
    if (v.readyState >= 1) cue();
    else v.addEventListener("loadedmetadata", cue, { once: true });
    return () => v.removeEventListener("loadedmetadata", cue);
  }, [cueStart, videoUrl]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !videoUrl || v.paused || !visibleSegments.length) return;
    if (segmentAt(visibleSegments, t)) return;
    const now = Date.now();
    if (now - lastSkipRef.current < SKIP_COOLDOWN_MS) return;
    const target = nextSegment(visibleSegments, t);
    if (!target || Math.abs(v.currentTime - target.start) < 0.2) return;
    lastSkipRef.current = now;
    v.currentTime = target.start;
    setT(target.start);
  }, [t, videoUrl, visibleSegments]);

  // Boxes visible at the current playback time.
  const active = useMemo(() => {
    const out: { id: string; brand: string; product: string; confidence: number; box: Box }[] = [];
    tracks.forEach((tr) => {
      const box = sampleBox(tr, t, maxGap);
      if (box) out.push({ id: tr.id, brand: tr.brand, product: tr.product, confidence: tr.confidence, box });
    });
    return out;
  }, [tracks, t, maxGap]);

  return (
    <div style={{ position: "relative", width: "100%", maxWidth, margin: "0 auto", aspectRatio: "9 / 16", borderRadius: 12, overflow: "hidden", background: "#000", boxShadow: "0 10px 30px -16px rgba(0,0,0,.6)" }}>
      {videoUrl ? (
        <video ref={videoRef} src={videoUrl} controls playsInline preload="metadata" poster={poster} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", background: "#050505" }} />
      ) : poster ? (
        <div style={{ position: "absolute", inset: 0, backgroundImage: `url(${poster})`, backgroundSize: "cover", backgroundPosition: "center" }} />
      ) : null}
      {active.map((d) => {
        const color = colorFor(d.id);
        return (
          <div key={d.id} style={{ position: "absolute", left: `${d.box[0] * 100}%`, top: `${d.box[1] * 100}%`, width: `${d.box[2] * 100}%`, height: `${d.box[3] * 100}%`, border: `2px solid ${color}`, borderRadius: 7, boxShadow: `0 0 0 1px rgba(0,0,0,.5), 0 0 18px ${color}66, inset 0 0 18px rgba(255,255,255,.08)`, pointerEvents: "none", transition: "left .08s linear, top .08s linear, width .08s linear, height .08s linear" }}>
            <span style={{ position: "absolute", inset: -5, borderRadius: 10, border: `1px solid ${color}55`, opacity: 0.9 }} />
            <span style={{ position: "absolute", left: -2, top: d.box[1] < 0.08 ? "100%" : -24, whiteSpace: "nowrap", fontSize: 10.5, fontWeight: 850, color: "#fff", background: `linear-gradient(90deg, ${color}, rgba(16,18,24,.9))`, padding: "3px 7px", borderRadius: 5, boxShadow: "0 4px 12px rgba(0,0,0,.42)" }}>
              {d.brand} / {d.product}
              <span style={{ marginLeft: 6, opacity: 0.82, fontSize: 9 }}>{Math.round(d.confidence * 100)}%</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
