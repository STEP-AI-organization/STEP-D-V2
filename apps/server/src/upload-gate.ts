/**
 * STEP-D — YouTube 실업로드 게이트 (기본값 OFF).
 *
 * The only thing this gate blocks is the moment bytes would leave for YouTube. Analysis,
 * recommendation, adopt, render/export, analytics collection, and the Meta status-only
 * stubs are all untouched — the boundary is the real upload, nothing else.
 *
 * SAFE BY DEFAULT: uploads are OFF unless `YOUTUBE_UPLOAD_ENABLED` is explicitly set to a
 * true value. An unset, empty, misspelled, or malformed variable means OFF. That direction
 * matters: the failure mode of a wrong env var must be "didn't upload", never "uploaded by
 * accident". Deploying this branch with no env change therefore cannot publish anything.
 *
 * Read at call time, not at module load, so the flag can be flipped by redeploying with a
 * new env var (Cloud Run revision / worker systemd restart) without a code change — and so
 * tests can toggle it. See docs/ops/youtube-upload-gate.md.
 */

/** Values that turn the gate ON. Everything else (incl. unset) is OFF — no fuzzy parsing. */
const TRUTHY = new Set(["true", "1", "on", "yes", "enabled"]);

/** True only when YOUTUBE_UPLOAD_ENABLED is explicitly one of TRUTHY. Default: false. */
export function youtubeUploadEnabled(): boolean {
  return TRUTHY.has(String(process.env.YOUTUBE_UPLOAD_ENABLED ?? "").trim().toLowerCase());
}

/** Machine-readable reason code for the API (route → web). */
export const UPLOAD_DISABLED_CODE = "upload_disabled";

/**
 * Operator-facing reason. Carries no secrets — just the flag name.
 * States only what is true in every case it's used (route 409 and worker block): the upload
 * did not happen. It must not imply anything was recorded — the route changes no state at all.
 */
export const UPLOAD_DISABLED_MESSAGE =
  "YouTube 실업로드가 비활성화되어 있습니다 (YOUTUBE_UPLOAD_ENABLED 미설정). 업로드는 수행되지 않았습니다.";

/**
 * The last line of defense, thrown from inside the upload boundary itself.
 * A distinct class so callers can tell "blocked on purpose" apart from "upload failed".
 */
export class UploadDisabledError extends Error {
  readonly code = UPLOAD_DISABLED_CODE;
  constructor(message: string = UPLOAD_DISABLED_MESSAGE) {
    super(message);
    this.name = "UploadDisabledError";
  }
}

/** Throw unless uploads are explicitly enabled. Call immediately before any upload API call. */
export function assertUploadEnabled(): void {
  if (!youtubeUploadEnabled()) throw new UploadDisabledError();
}

// ── TikTok — 같은 3중 방어, 별도 스위치 ────────────────────────────────────────
// 축이 다르다: YouTube 게이트를 켰다고 TikTok 까지 나가면 안 된다. 스위치는 플랫폼마다
// 하나씩이고, 실패 방향은 동일하다 — 오타·빈값·미설정 = OFF.

/** True only when TIKTOK_UPLOAD_ENABLED is explicitly one of TRUTHY. Default: false. */
export function tiktokUploadEnabled(): boolean {
  return TRUTHY.has(String(process.env.TIKTOK_UPLOAD_ENABLED ?? "").trim().toLowerCase());
}

export const TIKTOK_UPLOAD_DISABLED_MESSAGE =
  "TikTok 실업로드가 비활성화되어 있습니다 (TIKTOK_UPLOAD_ENABLED 미설정). 업로드는 수행되지 않았습니다.";

/** Throw unless TikTok uploads are explicitly enabled. Call immediately before the upload API. */
export function assertTikTokUploadEnabled(): void {
  // 같은 예외 클래스를 쓴다 — 호출부가 "막았다/실패했다"를 code 하나로 구분하는 구조를 유지.
  if (!tiktokUploadEnabled()) throw new UploadDisabledError(TIKTOK_UPLOAD_DISABLED_MESSAGE);
}

// ── Instagram · Facebook (Meta) — 같은 3중 방어, 플랫폼마다 별도 스위치 ─────────────
// 축이 다르다: YouTube/TikTok 을 켰다고 Meta 로 나가면 안 된다. IG(비즈니스 로그인)와
// FB(페이지)는 저장소·토큰이 달라 스위치도 따로 둔다. 실패 방향은 동일 — 오타·빈값·미설정 = OFF.

/** True only when INSTAGRAM_UPLOAD_ENABLED is explicitly one of TRUTHY. Default: false. */
export function instagramUploadEnabled(): boolean {
  return TRUTHY.has(String(process.env.INSTAGRAM_UPLOAD_ENABLED ?? "").trim().toLowerCase());
}

export const INSTAGRAM_UPLOAD_DISABLED_MESSAGE =
  "Instagram 실업로드가 비활성화되어 있습니다 (INSTAGRAM_UPLOAD_ENABLED 미설정). 업로드는 수행되지 않았습니다.";

/** True only when FACEBOOK_UPLOAD_ENABLED is explicitly one of TRUTHY. Default: false. */
export function facebookUploadEnabled(): boolean {
  return TRUTHY.has(String(process.env.FACEBOOK_UPLOAD_ENABLED ?? "").trim().toLowerCase());
}

export const FACEBOOK_UPLOAD_DISABLED_MESSAGE =
  "Facebook 실업로드가 비활성화되어 있습니다 (FACEBOOK_UPLOAD_ENABLED 미설정). 업로드는 수행되지 않았습니다.";
