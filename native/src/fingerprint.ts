import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";

const SAMPLE_BYTES = 1024 * 1024;

export interface FileFingerprint {
  size: number;
  mtimeMs: number;
  sampleSha256: string;
}

export async function fingerprintFile(filePath: string): Promise<FileFingerprint> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error("선택한 경로가 파일이 아닙니다.");

  const handle = await open(filePath, "r");
  try {
    const hash = createHash("sha256");
    const firstLength = Math.min(SAMPLE_BYTES, info.size);
    if (firstLength > 0) {
      const first = Buffer.allocUnsafe(firstLength);
      const { bytesRead } = await handle.read(first, 0, firstLength, 0);
      hash.update(first.subarray(0, bytesRead));
    }
    if (info.size > SAMPLE_BYTES) {
      const lastLength = Math.min(SAMPLE_BYTES, info.size - SAMPLE_BYTES);
      const last = Buffer.allocUnsafe(lastLength);
      const position = Math.max(0, info.size - lastLength);
      const { bytesRead } = await handle.read(last, 0, lastLength, position);
      hash.update(last.subarray(0, bytesRead));
    }
    return { size: info.size, mtimeMs: info.mtimeMs, sampleSha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

export function fingerprintsMatch(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.size === b.size
    && Math.trunc(a.mtimeMs) === Math.trunc(b.mtimeMs)
    && a.sampleSha256 === b.sampleSha256;
}
