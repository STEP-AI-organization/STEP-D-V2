/** Local filesystem storage layout (zero-infra). Everything lives under repo-root/storage. */
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url)); // apps/server/src
export const REPO_ROOT = path.resolve(here, "../../..");
export const STORAGE_DIR = process.env.STEPD_STORAGE_DIR
  ? path.resolve(process.env.STEPD_STORAGE_DIR)
  : path.join(REPO_ROOT, "storage");
export const UPLOAD_DIR = path.join(STORAGE_DIR, "uploads");
export const THUMB_DIR = path.join(STORAGE_DIR, "thumbs");
export const CLIP_DIR = path.join(STORAGE_DIR, "clips");
export const DB_PATH = path.join(STORAGE_DIR, "stepd.sqlite");

export function ensureStorage(): void {
  for (const d of [STORAGE_DIR, UPLOAD_DIR, THUMB_DIR, CLIP_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}
