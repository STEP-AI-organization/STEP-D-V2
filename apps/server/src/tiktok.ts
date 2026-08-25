/**
 * TikTok Content Posting API — 드래프트(inbox) 업로드 + **다이렉트 게시(옵트인)**.
 *
 * 기본은 드래프트다(scope video.upload): 파일은 크리에이터 틱톡 앱의 받은함에 **초안**으로
 * 들어가고, 최종 게시는 본인이 앱에서 한다 — "실수로 공개 게시"가 원천적으로 불가능한 쪽.
 * 다이렉트 게시(video.publish · 채널에 바로 공개)는 `TIKTOK_DIRECT_POST` 게이트 뒤에 있다
 * (2026-08-25 사용자 "지금 바로 다이렉트 배포" — 단 **앱 심사 통과가 선행조건**이다:
 * 미심사 앱의 다이렉트 게시는 SELF_ONLY 로 강제된다 · upload-gate.ts 주석 참조).
 *
 * PULL_FROM_URL 이 아니라 FILE_UPLOAD 를 쓴다 — PULL 은 소스 도메인 검증(사이트 소유 확인)이
 * 필요해서 GCS signed URL 로는 통과할 수 없다.
 *
 * 토큰: access ~24h · refresh ~365d. refresh 응답이 **새 refresh_token 을 줄 수 있다**(회전)
 * — 갱신 시 네 값(access·refresh·만료 둘)을 전부 persist 해야 다음 갱신이 산다.
 */
import { assertTikTokUploadEnabled } from "./upload-gate.ts";

const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const INBOX_INIT_URL = "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/";
const DIRECT_INIT_URL = "https://open.tiktokapis.com/v2/post/publish/video/init/";
const STATUS_FETCH_URL = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";

/** refresh 가 영구히 죽었다(invalid_grant 급) — 재연결만이 해법. youtube TokenRevokedError 와 같은 축. */
export class TikTokTokenRevokedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TikTokTokenRevokedError";
  }
}

/** 요청 도중 만료되지 않게 이만큼 일찍 갱신한다 (youtube EXPIRY_SKEW_MS 와 동일). */
const EXPIRY_SKEW_MS = 5 * 60_000;

export interface TikTokAccountTokens {
  openId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
}

/** 갱신된 토큰 4종 전부를 받는다 — refresh 회전분을 버리면 다음 갱신이 실패한다. */
export type PersistTikTokTokens = (t: {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
}) => void | Promise<void>;

async function requestRefresh(
  clientKey: string,
  clientSecret: string,
  account: TikTokAccountTokens,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number; refreshExpiresAt: number }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: account.refreshToken,
    }),
  });
  // 에러 본문은 메시지에 싣는다(원인 추적) — 토큰은 본문에 없고, 싣지도 않는다.
  const body = await res.text();
  let data: {
    access_token?: string; refresh_token?: string;
    expires_in?: number; refresh_expires_in?: number;
    error?: string; error_description?: string;
  } = {};
  try { data = JSON.parse(body); } catch { /* 비 JSON 응답은 아래에서 본문째 실패 처리 */ }

  // TikTok 은 실패를 200 + error 필드로 줄 때도, HTTP 에러로 줄 때도 있다 — 둘 다 본다.
  if (!res.ok || data.error || !data.access_token) {
    if (body.includes("invalid_grant")) {
      throw new TikTokTokenRevokedError(`TikTok refresh token rejected: ${body}`);
    }
    throw new Error(`TikTok token refresh failed (${res.status}): ${body}`);
  }
  const now = Date.now();
  return {
    accessToken: data.access_token,
    // 회전 안 된 응답(같은 토큰 유지)도 있다 — 그때만 기존 값을 이어 쓴다.
    refreshToken: data.refresh_token || account.refreshToken,
    expiresAt: now + (data.expires_in ?? 24 * 3600) * 1000,
    refreshExpiresAt: data.refresh_expires_in
      ? now + data.refresh_expires_in * 1000
      : account.refreshExpiresAt,
  };
}

/**
 * 만료(5분 전)면 갱신·persist 후 호출한다. 갱신이 invalid_grant 로 죽으면
 * TikTokTokenRevokedError 가 나간다 — 호출부는 이걸 잡아 계정을 'disconnected' 로 파킹한다
 * (markTikTokAccountDisconnected · youtube markRevoked 패턴).
 */
export async function withTikTokToken<T>(
  account: TikTokAccountTokens,
  persist: PersistTikTokTokens,
  fn: (accessToken: string) => Promise<T>,
): Promise<T> {
  let token = account.accessToken;
  if (!token || Date.now() >= account.expiresAt - EXPIRY_SKEW_MS) {
    const clientKey = process.env.TIKTOK_CLIENT_KEY ?? "";
    const clientSecret = process.env.TIKTOK_CLIENT_SECRET ?? "";
    if (!clientKey || !clientSecret) {
      throw new Error("TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET 미설정 — 토큰을 갱신할 수 없습니다");
    }
    const fresh = await requestRefresh(clientKey, clientSecret, account);
    await persist(fresh);
    token = fresh.accessToken;
  }
  return fn(token);
}

// ── 청크 규칙 ─────────────────────────────────────────────────────────────────
// TikTok 규칙: 64MB 이하는 단일 청크로 통째로 보내야 하고, 그 이상은 5MB~64MB 청크.
// 마지막 청크는 5MB 이상이어야 한다 — 그래서 count 를 floor 로 세면 나머지(<10MB)가
// 항상 마지막 정규 청크에 병합되어(마지막 청크 10~20MB) 규칙을 못 어긴다.

const SINGLE_CHUNK_MAX = 64 * 1024 * 1024;
const CHUNK_SIZE = 10 * 1024 * 1024;

export function planChunks(videoSize: number): { chunkSize: number; totalChunkCount: number } {
  if (videoSize <= SINGLE_CHUNK_MAX) return { chunkSize: videoSize, totalChunkCount: 1 };
  return { chunkSize: CHUNK_SIZE, totalChunkCount: Math.floor(videoSize / CHUNK_SIZE) };
}

async function initInboxUpload(
  accessToken: string,
  videoSize: number,
): Promise<{ publishId: string; uploadUrl: string }> {
  const { chunkSize, totalChunkCount } = planChunks(videoSize);
  const res = await fetch(INBOX_INIT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({
      source_info: {
        source: "FILE_UPLOAD",
        video_size: videoSize,
        chunk_size: chunkSize,
        total_chunk_count: totalChunkCount,
      },
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`TikTok inbox init failed (${res.status}): ${body}`);
  const data = JSON.parse(body) as {
    data?: { publish_id?: string; upload_url?: string };
    error?: { code?: string; message?: string };
  };
  // 성공 응답도 error.code="ok" 를 달고 온다 — "ok" 외의 코드만 실패다.
  if (data.error?.code && data.error.code !== "ok") {
    throw new Error(`TikTok inbox init error: ${data.error.code} — ${data.error.message ?? body}`);
  }
  const publishId = data.data?.publish_id;
  const uploadUrl = data.data?.upload_url;
  if (!publishId || !uploadUrl) throw new Error(`TikTok inbox init: publish_id/upload_url 누락 — ${body}`);
  return { publishId, uploadUrl };
}

async function putChunks(
  uploadUrl: string,
  file: { body: Buffer; contentType?: string },
): Promise<void> {
  const videoSize = file.body.byteLength;
  const { chunkSize, totalChunkCount } = planChunks(videoSize);
  for (let i = 0; i < totalChunkCount; i++) {
    const start = i * chunkSize;
    // 마지막 청크가 나머지를 흡수한다 (planChunks 의 floor 규칙과 한 몸이다).
    const end = i === totalChunkCount - 1 ? videoSize - 1 : start + chunkSize - 1;
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": file.contentType || "video/mp4",
        "Content-Range": `bytes ${start}-${end}/${videoSize}`,
      },
      body: file.body.subarray(start, end + 1),
    });
    // 중간 청크는 206, 마지막은 201 이 정상 — ok(2xx) 로 묶어서 본다.
    if (!res.ok && res.status !== 206) {
      throw new Error(`TikTok chunk upload failed (${res.status}, bytes ${start}-${end}): ${await res.text()}`);
    }
  }
}

// 5초 간격 = 분당 12회 — status/fetch 의 사용자 토큰당 분당 30회 제한에 여유를 둔다
// (2초=30회는 한도에 정확히 걸쳐 429 가 성공을 실패로 둔갑시킬 수 있다).
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 3 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 받은함 도착까지 폴링. PUT 이 2xx 라도 서버측 처리(다운로드·검증)가 남아 있어서,
 * 여기서 끝을 봐야 "성공으로 기록했는데 초안이 없다" 가 안 생긴다.
 */
async function waitForInbox(accessToken: string, publishId: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last = "";
  for (;;) {
    const res = await fetch(STATUS_FETCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({ publish_id: publishId }),
    });
    const body = await res.text();
    // 429(레이트리밋)는 결과가 아니라 소음이다 — 처리는 서버측에서 계속되고 있으므로
    // 실패로 기록하지 말고 다음 턴에 다시 묻는다 (데드라인이 최종 방어).
    if (res.status === 429) {
      if (Date.now() >= deadline) {
        throw new Error(`TikTok 처리 대기 시간 초과(레이트리밋 지속) — 마지막 상태 ${last || "unknown"}`);
      }
      await sleep(POLL_INTERVAL_MS * 2);
      continue;
    }
    if (!res.ok) throw new Error(`TikTok status fetch failed (${res.status}): ${body}`);
    const data = JSON.parse(body) as {
      data?: { status?: string; fail_reason?: string };
      error?: { code?: string; message?: string };
    };
    if (data.error?.code && data.error.code !== "ok") {
      throw new Error(`TikTok status fetch error: ${data.error.code} — ${data.error.message ?? body}`);
    }
    last = String(data.data?.status ?? "");
    if (last === "SEND_TO_USER_INBOX") return; // 받은함 도착 — 초안 업로드의 성공 종단
    if (last === "FAILED") {
      throw new Error(`TikTok upload failed: ${data.data?.fail_reason ?? body}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`TikTok 처리 대기 시간 초과(${POLL_TIMEOUT_MS / 60_000}분) — 마지막 상태 ${last || "unknown"}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * 렌더된 클립 하나를 크리에이터 받은함에 초안으로 올린다. 성공 = SEND_TO_USER_INBOX.
 *
 * Gated: 게이트가 꺼져 있으면 네트워크에 닿기 전에 UploadDisabledError 를 던진다 —
 * uploadVideoResumable 과 같은 최내곽 방어라, 미래의 어떤 호출 경로도 공짜로 상속한다.
 */
export async function uploadDraftToTikTok(
  accessToken: string,
  file: { body: Buffer; contentType?: string },
): Promise<{ publishId: string }> {
  assertTikTokUploadEnabled();
  const { publishId, uploadUrl } = await initInboxUpload(accessToken, file.body.byteLength);
  await putChunks(uploadUrl, file);
  await waitForInbox(accessToken, publishId);
  return { publishId };
}

// ── 다이렉트 게시 (video.publish · TIKTOK_DIRECT_POST 게이트) ────────────────────

async function initDirectPost(
  accessToken: string,
  videoSize: number,
  post: { title: string; privacyLevel: string },
): Promise<{ publishId: string; uploadUrl: string }> {
  const { chunkSize, totalChunkCount } = planChunks(videoSize);
  const res = await fetch(DIRECT_INIT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({
      post_info: {
        // 틱톡 캡션 상한 2200자(해시태그 포함) — 넘치면 init 이 400 으로 통째 실패한다.
        title: post.title.slice(0, 2200),
        privacy_level: post.privacyLevel,
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
      },
      source_info: {
        source: "FILE_UPLOAD",
        video_size: videoSize,
        chunk_size: chunkSize,
        total_chunk_count: totalChunkCount,
      },
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`TikTok direct init failed (${res.status}): ${body}`);
  const data = JSON.parse(body) as {
    data?: { publish_id?: string; upload_url?: string };
    error?: { code?: string; message?: string };
  };
  if (data.error?.code && data.error.code !== "ok") {
    // 미심사 앱이 여기서 걸린다(unaudited_client_*) — 원문을 그대로 실어 운영자가 원인을 본다.
    throw new Error(`TikTok direct init error: ${data.error.code} — ${data.error.message ?? body}`);
  }
  const publishId = data.data?.publish_id;
  const uploadUrl = data.data?.upload_url;
  if (!publishId || !uploadUrl) throw new Error(`TikTok direct init: publish_id/upload_url 누락 — ${body}`);
  return { publishId, uploadUrl };
}

// 다이렉트 게시는 서버측 검수·발행까지 있어 받은함(3분)보다 길게 본다.
const DIRECT_POLL_TIMEOUT_MS = 5 * 60_000;

/** 발행 완료까지 폴링. 완료 시 공개 게시물 id(있으면)를 돌려준다 — 게시물 URL 조립용. */
async function waitForDirectPublish(accessToken: string, publishId: string): Promise<string | undefined> {
  const deadline = Date.now() + DIRECT_POLL_TIMEOUT_MS;
  let last = "";
  for (;;) {
    const res = await fetch(STATUS_FETCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({ publish_id: publishId }),
    });
    const body = await res.text();
    if (res.status === 429) { // 레이트리밋은 결과가 아니다 — waitForInbox 와 같은 처리.
      if (Date.now() >= deadline) {
        throw new Error(`TikTok 게시 대기 시간 초과(레이트리밋 지속) — 마지막 상태 ${last || "unknown"}`);
      }
      await sleep(POLL_INTERVAL_MS * 2);
      continue;
    }
    if (!res.ok) throw new Error(`TikTok status fetch failed (${res.status}): ${body}`);
    const data = JSON.parse(body) as {
      // 필드 철자는 틱톡 API 원문 그대로다(publicaly…) — 고치면 영원히 undefined 를 읽는다.
      data?: { status?: string; fail_reason?: string; publicaly_available_post_id?: Array<number | string> };
      error?: { code?: string; message?: string };
    };
    if (data.error?.code && data.error.code !== "ok") {
      throw new Error(`TikTok status fetch error: ${data.error.code} — ${data.error.message ?? body}`);
    }
    last = String(data.data?.status ?? "");
    if (last === "PUBLISH_COMPLETE") {
      const ids = data.data?.publicaly_available_post_id;
      return Array.isArray(ids) && ids.length ? String(ids[0]) : undefined;
    }
    if (last === "FAILED") {
      throw new Error(`TikTok direct post failed: ${data.data?.fail_reason ?? body}`);
    }
    if (Date.now() >= deadline) {
      // 처리 중 타임아웃 — 영상이 뒤늦게 게시될 수도 있다. 실패로 던지되 그 가능성을 남긴다.
      throw new Error(
        `TikTok 게시 대기 시간 초과(${DIRECT_POLL_TIMEOUT_MS / 60_000}분) — 마지막 상태 ${last || "unknown"}. `
        + "영상이 뒤늦게 게시될 수 있으니 채널을 확인한 뒤 재시도하세요.",
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * 렌더된 클립 하나를 채널에 **바로 게시**한다. 성공 = PUBLISH_COMPLETE.
 *
 * ⚠️ 미심사 앱은 여기 성공해도 SELF_ONLY(본인만 보기)로 강제된다 — 게이트 주석(upload-gate.ts)의
 * 선행조건(앱 심사 + 재연결)을 채운 뒤에만 TIKTOK_DIRECT_POST 를 켤 것.
 */
export async function uploadDirectPostToTikTok(
  accessToken: string,
  file: { body: Buffer; contentType?: string },
  post: { title: string; privacyLevel?: string },
): Promise<{ publishId: string; postId?: string }> {
  assertTikTokUploadEnabled();
  const { publishId, uploadUrl } = await initDirectPost(accessToken, file.body.byteLength, {
    title: post.title,
    privacyLevel: post.privacyLevel ?? "PUBLIC_TO_EVERYONE",
  });
  await putChunks(uploadUrl, file);
  const postId = await waitForDirectPublish(accessToken, publishId);
  return { publishId, postId };
}
