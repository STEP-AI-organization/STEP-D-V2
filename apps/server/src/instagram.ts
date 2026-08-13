/**
 * Instagram Reels 게시 — 그래프 API 순수 함수 (사내 AENA meta-ig-reels-upload 이식).
 *
 * STEP-D 는 **IG 비즈니스 로그인 직결**(instagram_accounts 에 igUserId + accessToken 직접)이라
 * AENA(FB 페이지 연동 · graph.facebook.com · page token)와 달리 **graph.instagram.com** + IG
 * 유저 토큰을 쓴다. 나머지 흐름(컨테이너→status 폴링→media_publish)은 동일하다.
 *
 * 그래프 흐름:
 *   1. POST /{ig-user-id}/media?media_type=REELS&video_url=…&caption=…  → creation_id(container)
 *   2. GET  /{creation_id}?fields=status_code,status  → IN_PROGRESS…→FINISHED (폴링)
 *   3. POST /{ig-user-id}/media_publish?creation_id=…  → media_id
 *
 * `video_url` 은 **Meta 서버가 직접 다운로드**하므로 퍼블릭 HTTPS(예: GCS signed URL)여야 한다.
 * 예약(스케줄) 파라미터가 없다 → 예약은 **잡을 그 시각에 디스패치**해서 맞춘다(우리쪽 발사).
 */

const GRAPH = "https://graph.instagram.com/v21.0";
const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_MS = 10 * 60 * 1000; // 10분

export interface IgPublishInput {
  igUserId: string;
  accessToken: string;
  /** 퍼블릭 HTTPS — Meta 가 직접 fetch 한다. */
  videoUrl: string;
  caption?: string;
  /** 릴을 피드에도 노출할지. 기본은 Meta 기본값(대개 true). */
  shareToFeed?: boolean;
}

export interface IgPublishResult {
  mediaId: string;
  creationId: string;
  permalink?: string;
}

async function asJson(res: Response): Promise<any> {
  return res.json().catch(() => ({}));
}

/**
 * IG 릴 1건 게시. 실패는 던진다(호출부가 배포 상태에 사유로 남긴다). 멱등은 호출부(잡)에서
 * media_id 존재로 판정한다 — 이 함수는 매번 컨테이너를 새로 만들므로 중복 호출 금지.
 */
export async function publishInstagramReel(input: IgPublishInput): Promise<IgPublishResult> {
  const { igUserId, accessToken, videoUrl, caption, shareToFeed } = input;
  const tok = encodeURIComponent(accessToken);

  // 1) 컨테이너 생성
  const createParams = new URLSearchParams({
    media_type: "REELS",
    video_url: videoUrl,
    access_token: accessToken,
  });
  if (caption) createParams.set("caption", caption);
  if (shareToFeed !== undefined) createParams.set("share_to_feed", String(shareToFeed));
  const createRes = await fetch(`${GRAPH}/${igUserId}/media?${createParams}`, { method: "POST" });
  const createJson = await asJson(createRes);
  if (!createRes.ok || !createJson.id) {
    throw new Error(`IG container create 실패: ${JSON.stringify(createJson)}`);
  }
  const creationId = String(createJson.id);

  // 2) status 폴링 — status_code(enum) + status(상세)를 함께 받아 실패 진단.
  const deadline = Date.now() + POLL_MAX_MS;
  let statusCode = "IN_PROGRESS";
  let last: any = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const sr = await fetch(`${GRAPH}/${creationId}?fields=status_code,status&access_token=${tok}`);
    const sj = await asJson(sr);
    if (!sr.ok) throw new Error(`IG status 폴링 실패: ${JSON.stringify(sj)}`);
    statusCode = String(sj.status_code ?? "");
    last = sj;
    if (statusCode === "FINISHED") break;
    if (statusCode === "ERROR" || statusCode === "EXPIRED") {
      throw new Error(`IG container ${statusCode}: ${sj.status ?? "(no detail)"} | ${JSON.stringify(sj)}`);
    }
  }
  if (statusCode !== "FINISHED") {
    throw new Error(`IG container 폴링 타임아웃 (last status_code=${statusCode}, status=${last?.status ?? "?"})`);
  }

  // 3) 게시
  const pubRes = await fetch(
    `${GRAPH}/${igUserId}/media_publish?creation_id=${encodeURIComponent(creationId)}&access_token=${tok}`,
    { method: "POST" },
  );
  const pubJson = await asJson(pubRes);
  if (!pubRes.ok || !pubJson.id) {
    throw new Error(`IG publish 실패: ${JSON.stringify(pubJson)}`);
  }
  const mediaId = String(pubJson.id);

  // permalink — reel URL 은 shortcode 라 media_id 로는 못 연다. Graph 의 permalink 가 정답.
  // 부가정보라 실패해도 게시는 성공으로 본다(best-effort).
  let permalink: string | undefined;
  try {
    const pr = await fetch(`${GRAPH}/${mediaId}?fields=permalink&access_token=${tok}`);
    const pj = await asJson(pr);
    if (pr.ok && typeof pj.permalink === "string") permalink = pj.permalink;
  } catch { /* best-effort */ }

  return { mediaId, creationId, permalink };
}
