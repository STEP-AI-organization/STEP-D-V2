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
