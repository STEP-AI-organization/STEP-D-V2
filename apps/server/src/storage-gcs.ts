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

const BUCKET = process.env.GCS_BUCKET;
const DEV_STORAGE = process.env.STEPD_STORAGE_DIR
  ? path.resolve(process.env.STEPD_STORAGE_DIR)
  : path.resolve(process.cwd(), "storage");

let storage: Storage | null = null;
let bucket: ReturnType<Storage["bucket"]> | null = null;

function getStorage(): Storage {
  if (!storage) storage = new Storage();
  return storage;
}

function getBucket() {
  if (!BUCKET) return null;
  if (!bucket) bucket = getStorage().bucket(BUCKET);
  return bucket;
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
    const file = b.file(objectPath);
    await file.save(fs.readFileSync(localPath), { contentType: guessMime(objectPath) });
    return gcsUri(objectPath);
  }
  // Local fallback: move file
  const local = path.join(DEV_STORAGE, objectPath);
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.cpSync(localPath, local, { force: true });
  return local;
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

/**
 * Returns a ReadableStream for the file.
 * For GCS: returns a web ReadableStream (supports range).
 * For local: returns a Node Readable stream converted to web.
 */
export function createReadStream(objectPath: string, start?: number, end?: number): ReadableStream {
  const b = getBucket();
  if (b) {
    const file = b.file(objectPath);
    // GCS native streaming with range via createReadStream
    const options: { start?: number; end?: number } = {};
    if (start !== undefined) options.start = start;
    if (end !== undefined) options.end = end;
    const nodeStream = file.createReadStream(options);
    return new ReadableStream({
      start(controller) {
        nodeStream.on("data", (chunk) => controller.enqueue(chunk));
        nodeStream.on("end", () => controller.close());
        nodeStream.on("error", (err) => controller.error(err));
      },
    });
  }
  // Local fallback
  const localPath = path.join(DEV_STORAGE, objectPath);
  const options: { start?: number; end?: number } = {};
  if (start !== undefined) options.start = start;
  if (end !== undefined) options.end = end;
  const nodeStream = fs.createReadStream(localPath, options);
  return new ReadableStream({
    start(controller) {
      nodeStream.on("data", (chunk) => controller.enqueue(chunk));
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
  });
}

// ── delete ─────────────────────────────────────────────────────────────────────

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
