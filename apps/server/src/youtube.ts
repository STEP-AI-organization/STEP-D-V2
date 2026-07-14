/**
 * YouTube Data API v3 helpers — upload list and video statistics.
 */
export interface YtVideoItem {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
  durationSec: number;
  thumbnail: string | null;
  viewCount: number;
  likeCount: number;
  commentCount: number;
}

/** Refresh an access token. Mirrors the refresh in index.ts (used by sync). */
async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ access_token: string; expires_in: number }> {
  const params = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  if (!res.ok) throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ access_token: string; expires_in: number }>;
}

/** Fetch the uploads playlist ID for a channel. */
async function getUploadsPlaylistId(accessToken: string, channelId: string): Promise<string> {
  const url = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${channelId}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Failed to get channel details (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as {
    items?: { contentDetails: { relatedPlaylists: { uploads: string } } }[];
  };
  if (!data.items?.length) throw new Error("No channel content details found");
  return data.items[0].contentDetails.relatedPlaylists.uploads;
}

/** Fetch all uploads from the uploads playlist (paginated, up to 500). */
async function fetchPlaylistItems(
  accessToken: string,
  playlistId: string,
  maxResults = 50,
): Promise<{ videoId: string; snippet: any }[]> {
  const items: { videoId: string; snippet: any }[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 10; i++) {
    // max 500 items (50 × 10 pages)
    const params = new URLSearchParams({
      part: "snippet",
      playlistId,
      maxResults: String(maxResults),
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Playlist items failed (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as {
      items?: { snippet: { resourceId: { videoId: string }; title: string; description: string; publishedAt: string; thumbnails?: { high?: { url: string }; default?: { url: string } } } }[];
      nextPageToken?: string;
    };
    if (!data.items?.length) break;
    for (const item of data.items) {
      items.push({
        videoId: item.snippet.resourceId.videoId,
        snippet: item.snippet,
      });
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return items;
}

/** Fetch video statistics + duration for a batch of video IDs (max 50 per call). */
async function fetchVideosBatch(
  accessToken: string,
  videoIds: string[],
): Promise<Map<string, { viewCount: number; likeCount: number; commentCount: number; durationSec: number }>> {
  const map = new Map<
    string,
    { viewCount: number; likeCount: number; commentCount: number; durationSec: number }
  >();
  // YouTube API accepts up to 50 ids per call
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const params = new URLSearchParams({
      part: "statistics,contentDetails",
      id: batch.join(","),
    });
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Video stats failed (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as {
      items?: {
        id: string;
        statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
        contentDetails?: { duration?: string };
      }[];
    };
    if (!data.items) continue;
    for (const item of data.items) {
      map.set(item.id, {
        viewCount: Number(item.statistics?.viewCount ?? 0),
        likeCount: Number(item.statistics?.likeCount ?? 0),
        commentCount: Number(item.statistics?.commentCount ?? 0),
        durationSec: parseIsoDuration(item.contentDetails?.duration ?? "PT0S"),
      });
    }
  }
  return map;
}

/** Parse ISO 8601 duration (PT1H2M3S) → seconds. */
function parseIsoDuration(iso: string): number {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] ?? "0", 10) * 3600 +
    parseInt(m[2] ?? "0", 10) * 60 +
    parseInt(m[3] ?? "0", 10));
}

export interface SyncResult {
  videos: YtVideoItem[];
  refreshedToken: string | null;
}

/**
 * Main sync function:
 * 1. Refresh access token if needed.
 * 2. Fetch uploads playlist → video IDs.
 * 3. Fetch statistics + duration for all videos.
 * 4. Return structured video items.
 */
export async function syncChannelVideos(
  clientId: string,
  clientSecret: string,
  channel: { channelId: string; accessToken: string | null; refreshToken: string; expiresAt: number | null },
): Promise<SyncResult> {
  let accessToken = channel.accessToken ?? "";

  // Refresh if token is expired or missing.
  if (!accessToken || (channel.expiresAt && Date.now() > channel.expiresAt - 300_000)) {
    const fresh = await refreshAccessToken(clientId, clientSecret, channel.refreshToken);
    accessToken = fresh.access_token;
  }

  const uploadsPlaylistId = await getUploadsPlaylistId(accessToken, channel.channelId);
  const playlistItems = await fetchPlaylistItems(accessToken, uploadsPlaylistId);

  if (playlistItems.length === 0) return { videos: [], refreshedToken: accessToken };

  const videoIds = playlistItems.map((p) => p.videoId);
  const statsMap = await fetchVideosBatch(accessToken, videoIds);

  const videos: YtVideoItem[] = playlistItems.map((p) => {
    const stats = statsMap.get(p.videoId);
    const thumb = p.snippet.thumbnails?.high?.url ?? p.snippet.thumbnails?.default?.url ?? null;
    return {
      videoId: p.videoId,
      title: p.snippet.title,
      description: p.snippet.description,
      publishedAt: p.snippet.publishedAt,
      durationSec: stats?.durationSec ?? 0,
      thumbnail: thumb,
      viewCount: stats?.viewCount ?? 0,
      likeCount: stats?.likeCount ?? 0,
      commentCount: stats?.commentCount ?? 0,
    };
  });

  return { videos, refreshedToken: accessToken };
}
