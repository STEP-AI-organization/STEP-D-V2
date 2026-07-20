"use client";

import { useEffect, useState } from "react";
import { getMediaAnalysis, type MediaAnalysis } from "@/lib/data/api";

interface Poller {
  subs: Set<(a: MediaAnalysis | null) => void>;
  timer: number | null;
  last: MediaAnalysis | null;
  loaded: boolean;
}

const pollers = new Map<string, Poller>();

function fetchOnce(mediaId: string, p: Poller) {
  getMediaAnalysis(mediaId)
    .then((a) => {
      p.last = a;
      p.loaded = true;
      p.subs.forEach((fn) => fn(a));
      // Decide settled-ness from THIS result, not the cached status at mount — after a
      // 재분석 the server flips back to pending and polling must self-restart.
      if (a.status === "done" || a.status === "failed") {
        if (p.timer != null) {
          clearInterval(p.timer);
          p.timer = null;
        }
      } else if (p.timer == null && p.subs.size > 0) {
        p.timer = window.setInterval(() => fetchOnce(mediaId, p), 20_000);
      }
    })
    .catch(() => {
      if (!p.loaded) {
        p.loaded = true;
        p.subs.forEach((fn) => fn(null));
      }
    });
}

/**
 * Polls a media's analysis every 20s until it settles (done/failed), sharing ONE interval
 * per mediaId across all mounted subscribers — panels showing the same analysis must not
 * each hit the API on their own timer.
 */
export function useMediaAnalysisPoll(mediaId: string | undefined): {
  analysis: MediaAnalysis | null;
  loading: boolean;
} {
  const [analysis, setAnalysis] = useState<MediaAnalysis | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!mediaId) return;
    let entry = pollers.get(mediaId);
    if (!entry) {
      entry = { subs: new Set(), timer: null, last: null, loaded: false };
      pollers.set(mediaId, entry);
    }
    const p = entry;
    const sub = (a: MediaAnalysis | null) => {
      setAnalysis(a);
      setLoading(false);
    };
    p.subs.add(sub);
    if (p.loaded) {
      setAnalysis(p.last);
      setLoading(false);
    } else {
      setLoading(true);
    }
    if (p.subs.size === 1) {
      const settled = p.last && (p.last.status === "done" || p.last.status === "failed");
      fetchOnce(mediaId, p);
      if (!settled && p.timer == null) {
        p.timer = window.setInterval(() => fetchOnce(mediaId, p), 20_000);
      }
    }
    return () => {
      p.subs.delete(sub);
      if (p.subs.size === 0 && p.timer != null) {
        clearInterval(p.timer);
        p.timer = null;
      }
    };
  }, [mediaId]);

  return { analysis, loading };
}
