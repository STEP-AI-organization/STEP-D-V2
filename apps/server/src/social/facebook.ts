/**
 * Facebook Reels 게시 — 그래프 API 순수 함수 (사내 AENA meta-fb-reels-upload 이식).
 *
 * meta_accounts(1 Page = 1 row) 의 **pageId + pageAccessToken** 을 쓴다(장수명 토큰).
 * FB 는 **네이티브 예약**을 지원한다 → finish 단계에 `video_state=SCHEDULED` +
 * `scheduled_publish_time`(epoch sec)을 실으면 그 시각에 공개된다. 잡은 즉시 돈다.
 *
 * 3-phase resumable:
 *   1. POST /{page-id}/video_reels?upload_phase=start  → { video_id, upload_url }
 *   2. POST {upload_url}  (Authorization: OAuth {pageToken}, offset:0, file_size:N, body=바이너리)
 *   3. POST /{page-id}/video_reels?upload_phase=finish&video_id&video_state=PUBLISHED|SCHEDULED
 *        (+ scheduled_publish_time · title · description)
 */

const GRAPH_VERSION = "v21.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

export interface FbPublishInput {
  pageId: string;
  pageToken: string;
  /** 렌더된 클립 바이트. */
  video: Buffer;
  title?: string;
  description?: string;
  /** 예약 공개 시각(epoch **초**). 있으면 SCHEDULED 로 등록된다(미래 시각만 유효). */
  scheduledPublishSec?: number;
}

export interface FbPublishResult {
  videoId: string;
  scheduled: boolean;
  permalink?: string;
}

async function asJson(res: Response): Promise<any> {
  return res.json().catch(() => ({}));
}

/**
 * FB 릴 1건 게시. 실패는 던진다. **멱등은 호출부(잡)** 가 fbVideoId/완료플래그로 판정한다 —
 * start 단계에서 video_id 가 이미 생기므로 그것만으론 완료 판별 불가.
 */
export async function publishFacebookReel(input: FbPublishInput): Promise<FbPublishResult & { videoIdEarly?: string }> {
  const { pageId, pageToken, video, title, description, scheduledPublishSec } = input;
  const scheduled = typeof scheduledPublishSec === "number" && scheduledPublishSec > Math.floor(Date.now() / 1000);

  // 1) start
  const startRes = await fetch(
    `${GRAPH}/${pageId}/video_reels?upload_phase=start&access_token=${encodeURIComponent(pageToken)}`,
    { method: "POST" },
  );
  const startJson = await asJson(startRes);
  if (!startRes.ok || !startJson.video_id || !startJson.upload_url) {
    throw new Error(`FB Reels start 실패: ${JSON.stringify(startJson)}`);
  }
  const videoId = String(startJson.video_id);
  const uploadUrl = String(startJson.upload_url);

  // 2) transfer — rupload endpoint 에 바이너리
  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Authorization": `OAuth ${pageToken}`,
      "offset": "0",
      "file_size": String(video.byteLength),
      "Content-Type": "application/octet-stream",
    },
    body: video,
  });
  const uploadJson = await asJson(uploadRes);
  if (!uploadRes.ok || uploadJson?.success === false) {
    // video_id 는 이미 잡혔으니 호출부가 기록해 두면 재시도 시 중복 방지에 쓸 수 있다.
    const e = new Error(`FB Reels transfer 실패: ${uploadRes.status} ${JSON.stringify(uploadJson)}`);
    (e as any).videoIdEarly = videoId;
    throw e;
  }

  // 3) finish
  const finishParams = new URLSearchParams({
    upload_phase: "finish",
    video_id: videoId,
    video_state: scheduled ? "SCHEDULED" : "PUBLISHED",
    access_token: pageToken,
  });
  if (title) finishParams.set("title", title);
  if (description) finishParams.set("description", description);
  if (scheduled) finishParams.set("scheduled_publish_time", String(scheduledPublishSec));

  const finishRes = await fetch(`${GRAPH}/${pageId}/video_reels?${finishParams}`, { method: "POST" });
  const finishJson = await asJson(finishRes);
  if (!finishRes.ok || finishJson?.success === false) {
    const e = new Error(`FB Reels finish 실패: ${JSON.stringify(finishJson)}`);
    (e as any).videoIdEarly = videoId;
    throw e;
  }

  // permalink — 예약분은 아직 비공개라 게시 시점 전엔 없을 수 있다(즉시분만 조회). best-effort.
  let permalink: string | undefined;
  if (!scheduled) {
    try {
      const pr = await fetch(`${GRAPH}/${videoId}?fields=permalink_url&access_token=${encodeURIComponent(pageToken)}`);
      const pj = await asJson(pr);
      if (pr.ok && typeof pj.permalink_url === "string") {
        permalink = pj.permalink_url.startsWith("http") ? pj.permalink_url : `https://www.facebook.com${pj.permalink_url}`;
      }
    } catch { /* best-effort */ }
  }

  return { videoId, scheduled, permalink };
}
