/**
 * Google Cloud Storage adapter.
 *
 * Production: GCS_BUCKET env var → files stored in GCS.
 * Development (GCS_BUCKET unset): local fallback at repo-root/storage/.
 *
 * Files stored as: {bucket}/uploads/{id}.ext, /thumbs/{id}.jpg, /clips/{id}.mp4
 */
import { Storage } from "@google-cloud/storage";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

const BUCKET = process.env.GCS_BUCKET;
// 한국 사용자의 대용량 원본은 서울 리전 버킷으로 먼저 받는다. 비어 있으면 기존 단일
// 버킷 동작과 완전히 같다. 워커가 promoteUpload() 로 운영 버킷에 서버사이드 복사한 뒤
// 분석하므로, 사용자는 서울까지만 업로드하면 된다.
const UPLOAD_BUCKET = process.env.GCS_UPLOAD_BUCKET || BUCKET;
const DEV_STORAGE = process.env.STEPD_STORAGE_DIR
  ? path.resolve(process.env.STEPD_STORAGE_DIR)
  : path.resolve(process.cwd(), "storage");

let storage: Storage | null = null;
let bucket: ReturnType<Storage["bucket"]> | null = null;
let uploadBucket: ReturnType<Storage["bucket"]> | null = null;

function getStorage(): Storage {
  if (!storage) storage = new Storage();
  return storage;
}

function getBucket() {
  if (!BUCKET) return null;
  if (!bucket) bucket = getStorage().bucket(BUCKET);
  return bucket;
}

function getUploadBucket() {
  if (!UPLOAD_BUCKET) return null;
  if (!uploadBucket) uploadBucket = getStorage().bucket(UPLOAD_BUCKET);
  return uploadBucket;
}

// ── paths ──────────────────────────────────────────────────────────────────────

export function uploadPath(id: string, ext: string): string {
  return `uploads/${id}${ext}`;
}

export function thumbPath(id: string): string {
  return `thumbs/${id}.jpg`;
}

export function clipPath(id: string): string {
  return `clips/${id}.mp4`;
}

// ── write ──────────────────────────────────────────────────────────────────────

export async function writeFile(objectPath: string, buffer: Buffer): Promise<string> {
  const b = getBucket();
  if (b) {
    const file = b.file(objectPath);
    await file.save(buffer, { contentType: guessMime(objectPath) });
    return gcsUri(objectPath);
  }
  // Local fallback
  const local = path.join(DEV_STORAGE, objectPath);
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, buffer);
  return local;
}

/** Write from a local temp path (e.g. ffmpeg output) to GCS. */
export async function uploadFile(objectPath: string, localPath: string): Promise<string> {
  const b = getBucket();
  if (b) {
    // Streamed, NOT readFileSync: a 512 MB remux output would otherwise sit in tmpfs AND
    // as a heap Buffer at once — enough to OOM a 2 GB Cloud Run instance on its own.
    await b.upload(localPath, {
      destination: objectPath,
      contentType: guessMime(objectPath),
    });
    return gcsUri(objectPath);
  }
  // Local fallback: move file
  const local = path.join(DEV_STORAGE, objectPath);
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.cpSync(localPath, local, { force: true });
  return local;
}

// ── direct-to-GCS upload (large files bypass the server) ─────────────────────────

/**
 * Initiate a resumable upload session and return the session URI.
 * The browser PUTs the file in chunks straight to this URI — the bytes never pass
 * through Cloud Run, so there is no 32 MB request cap, no in-memory buffering, and
 * no request timeout. Multi-hour / multi-GB masters upload fine.
 *
 * Uses the runtime service account (ADC) to open the session — no signBlob needed
 * for this call. The bucket must allow the browser origin via CORS (PUT + Content-Range).
 */
export async function createResumableSession(
  objectPath: string,
  contentType: string,
  origin?: string,
): Promise<string> {
  const b = getUploadBucket();
  if (!b) throw new Error("resumable upload requires GCS mode (GCS_BUCKET unset)");
  const [uri] = await b.file(objectPath).createResumableUpload({
    metadata: { contentType: contentType || "application/octet-stream" },
    ...(origin ? { origin } : {}),
  });
  return uri;
}

/** URI of the object in the regional upload/staging bucket. */
export function uploadGcsUri(objectPath: string): string {
  return `gs://${UPLOAD_BUCKET}/${objectPath}`;
}

/** Metadata checks used by /finalize before the object has been promoted. */
export async function uploadFileSize(objectPath: string): Promise<number> {
  const b = getUploadBucket();
  if (b) {
    const [meta] = await b.file(objectPath).getMetadata();
    return Number(meta.size);
  }
  return fs.statSync(path.join(DEV_STORAGE, objectPath)).size;
}

export async function uploadFileExists(objectPath: string): Promise<boolean> {
  const b = getUploadBucket();
  if (b) {
    const [exists] = await b.file(objectPath).exists();
    return exists;
  }
  return fs.existsSync(path.join(DEV_STORAGE, objectPath));
}

/**
 * Promote a Seoul staging object into the primary processing bucket.
 *
 * GCS performs this as a server-side rewrite over Google's backbone; no video bytes pass
 * through Node. It is idempotent so a worker retry after a successful copy is safe.
 */
export async function promoteUpload(objectPath: string): Promise<string> {
  const source = getUploadBucket();
  const destination = getBucket();
  if (!source || !destination) return gcsUri(objectPath);
  if (UPLOAD_BUCKET === BUCKET) return gcsUri(objectPath);

  const sourceFile = source.file(objectPath);
  const destinationFile = destination.file(objectPath);
  const [sourceExists, destinationExists] = await Promise.all([
    sourceFile.exists().then(([v]) => v),
    destinationFile.exists().then(([v]) => v),
  ]);
  if (!sourceExists) {
    if (destinationExists) return gcsUri(objectPath);
    throw new Error(`staged upload not found: gs://${UPLOAD_BUCKET}/${objectPath}`);
  }

  await sourceFile.copy(destinationFile);
  await sourceFile.delete({ ignoreNotFound: true }).catch((err) => {
    // 복사는 끝났다. 정리 실패 때문에 분석 전체를 재시도할 이유는 없다.
    console.warn(`[gcs] promoted upload cleanup failed: ${String(err)}`);
  });
  return gcsUri(objectPath);
}

/**
 * Short-lived signed READ URL so ffmpeg/ffprobe can range-read a GCS object over
 * https without downloading it whole (probe reads the header; the thumbnail seeks to
 * one frame). Requires the runtime service account to have signBlob permission
 * (roles/iam.serviceAccountTokenCreator on itself) — Cloud Run ADC has no private key.
 */
export async function signedReadUrl(
  objectPath: string,
  ttlMs = 60 * 60 * 1000,
  /** 내려받을 때 쓸 파일명. 주면 Content-Disposition: attachment 로 그 이름이 강제된다.
   *  (네이버 로그인 도우미가 이 이름에 계정 키를 실어 보낸다 — index.ts /naver/login-tool) */
  downloadName?: string,
): Promise<string> {
  const b = getBucket();
  if (!b) throw new Error("signed URL requires GCS mode (GCS_BUCKET unset)");
  const [url] = await b.file(objectPath).getSignedUrl({
    version: "v4",
    action: "read",
    expires: Date.now() + ttlMs,
    ...(downloadName
      ? { responseDisposition: `attachment; filename="${downloadName.replace(/["\\]/g, "")}"` }
      : {}),
  });
  return url;
}

// ── read / stream ──────────────────────────────────────────────────────────────

export async function fileSize(objectPath: string): Promise<number> {
  const b = getBucket();
  if (b) {
    const [meta] = await b.file(objectPath).getMetadata();
    return Number(meta.size);
  }
  return fs.statSync(path.join(DEV_STORAGE, objectPath)).size;
}

export async function fileExists(objectPath: string): Promise<boolean> {
  const b = getBucket();
  if (b) {
    const [exists] = await b.file(objectPath).exists();
    return exists;
  }
  return fs.existsSync(path.join(DEV_STORAGE, objectPath));
}

/** Read a small object into memory. Analysis metadata JSON only — never use for video assets. */
export async function readFile(objectPath: string): Promise<Buffer> {
  const b = getBucket();
  if (b) {
    const [contents] = await b.file(objectPath).download();
    return contents;
  }
  return fs.promises.readFile(path.join(DEV_STORAGE, objectPath));
}

/**
 * Returns a ReadableStream for the file.
 * For GCS: returns a web ReadableStream (supports range).
 * For local: returns a Node Readable stream converted to web.
 */
export function createReadStream(objectPath: string, start?: number, end?: number): ReadableStream {
  const options: { start?: number; end?: number } = {};
  if (start !== undefined) options.start = start;
  if (end !== undefined) options.end = end;

  const b = getBucket();
  const nodeStream = b
    ? b.file(objectPath).createReadStream(options)
    : fs.createReadStream(path.join(DEV_STORAGE, objectPath), options);

  // Readable.toWeb wires up backpressure + client-abort (cancel → destroy) + error
  // propagation correctly. The hand-rolled version enqueued onto an already-closed
  // controller when the browser cancelled a Range request mid-stream → 500s
  // ("Controller is already closed") that broke video playback.
  return Readable.toWeb(nodeStream as unknown as Readable) as unknown as ReadableStream;
}

// ── delete ─────────────────────────────────────────────────────────────────────

/** Delete every object under a prefix (e.g. analysis/{mediaId}/). Best-effort. */
export async function deletePrefix(prefix: string): Promise<void> {
  const b = getBucket();
  if (b) {
    try {
      await b.deleteFiles({ prefix, force: true }); // force: keep going past per-file errors
    } catch {
      // ignore — orphan cleanup must never fail the caller
    }
    return;
  }
  try {
    fs.rmSync(path.join(DEV_STORAGE, prefix), { recursive: true, force: true });
  } catch {
    // ignore
  }
}

export async function deleteFile(objectPath: string): Promise<void> {
  const b = getBucket();
  if (b) {
    try {
      await b.file(objectPath).delete();
    } catch {
      // ignore if not found
    }
    return;
  }
  const local = path.join(DEV_STORAGE, objectPath);
  try {
    fs.unlinkSync(local);
  } catch {
    // ignore
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────

function gcsUri(objectPath: string): string {
  return `gs://${BUCKET}/${objectPath}`;
}

function guessMime(objectPath: string): string {
  const ext = path.extname(objectPath).toLowerCase();
  const map: Record<string, string> = {
    ".mp4": "video/mp4",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    // 방송 원본 컨테이너 — 브라우저가 못 여는 형식이라도 **정확한 타입**으로 저장한다.
    // mp4 로 잘못 붙이면 브라우저가 재생을 시도하다 깨지고, 나중에 원인 추적도 어렵다
    // (2026-08-27 MXF 대응 · 재생은 정규화된 .mp4 가 담당한다).
    ".mxf": "application/mxf",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".ts": "video/mp2t",
    ".m2ts": "video/mp2t",
    ".mpg": "video/mpeg",
    ".mpeg": "video/mpeg",
    ".wmv": "video/x-ms-wmv",
  };
  return map[ext] ?? "application/octet-stream";
}

/** Parse a gs:// URI or local path into the object path component. */
export function parseObjectPath(storedPath: string): string {
  // Strip gs://bucket/ prefix if present
  const gsMatch = storedPath.match(/^gs:\/\/[^/]+\/(.+)$/);
  if (gsMatch) return gsMatch[1];

  // Strip local DEV_STORAGE prefix
  const rel = path.relative(DEV_STORAGE, storedPath);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.replace(/\\/g, "/");

  // Already a relative object path
  return storedPath;
}

/** Whether GCS (prod) mode is active. */
export function useGcs(): boolean {
  return Boolean(BUCKET);
}

/**
 * prefix 아래 오브젝트 경로 목록. GCS·로컬 모두 같은 형태(prefix 포함 상대경로)로 돌려준다.
 * 썸네일 에셋(스타일 프로파일·출연자 사진)을 워커 디스크로 내려받을 때 쓴다.
 */
export async function listPrefix(prefix: string): Promise<string[]> {
  const b = getBucket();
  if (b) {
    const [files] = await b.getFiles({ prefix });
    return files.map((f) => f.name).filter((n) => !n.endsWith("/"));
  }
  const root = path.join(DEV_STORAGE, prefix);
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(DEV_STORAGE, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  return out;
}
