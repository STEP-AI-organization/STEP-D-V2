/**
 * Tunables for the channel-analysis pipeline — kept here (not scattered as magic
 * numbers) because they are the levers that protect the YouTube quota. Each per-video
 * `video.analyze` run costs 4 Analytics API calls, so the caps below decide how much
 * quota one channel sweep can spend.
 */

/**
 * Shorts are classified by probing youtube.com/shorts/<id> (see youtube.ts:isShortVideo),
 * NOT by duration — YouTube raised the Shorts limit to 3 min, so length is unreliable.
 * One sync probes at most this many not-yet-classified uploads; the rest wait for the
 * next sync. Each verdict is cached forever (a video's Shorts status never changes).
 */
export const SHORTS_PROBE_MAX_PER_SYNC = 400;
/** Concurrent /shorts/ probes — modest so we don't hammer youtube.com from one IP. */
export const SHORTS_PROBE_CONCURRENCY = 8;

// Per-video analytics is fanned out for EVERY synced upload of a channel — no count cap.
// The staleness gates below (fresh daily / aged weekly) are what bound the Analytics
// quota now, so a re-run only re-pulls the videos actually due.

/** Under this age a video is "fresh": polled daily, and its comments are collected. */
export const FRESH_VIDEO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// ⚠️ **아래 간격들의 실효 상한은 채널 신선도 주기(VIDEO_SYNC_INTERVAL_MS, 기본 6시간)다.**
// 영상 잡을 큐잉하는 유일한 경로가 `enqueueDueVideoJobs` 이고, 그건 채널이 due 일 때만
// 돌기 때문이다(worker.ts `handleChannelAnalyze`). 여기 값을 6시간 밑으로 내리면 그 값이
// **조용히 안 지켜진다** — 그때는 채널 주기도 같이 내리거나 팬아웃 경로를 따로 만들 것.

/** Re-pull per-video analytics this often for fresh (<7d) videos. */
export const VIDEO_ANALYZE_FRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** …and this often once a video has aged past the fresh window. */
export const VIDEO_ANALYZE_AGED_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** Re-pull comments this often (fresh videos only). */
export const VIDEO_COMMENTS_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** One page only — 100 relevance-ranked threads is enough signal without paginating. */
export const VIDEO_COMMENTS_MAX_RESULTS = 100;

/** A newly discovered upload is polled at high density for this long after publish. */
export const HOTWATCH_WINDOW_MS = 48 * 60 * 60 * 1000;
/** …at this cadence (the job re-enqueues itself with this delay until the window closes). */
export const HOTWATCH_POLL_MS = 60 * 60 * 1000;
