import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { NativeUploadJob, NativeUploadRequest } from "./contract.js";
import type { FileFingerprint } from "./fingerprint.js";

export interface SecretCodec {
  encrypt(value: string): Promise<string>;
  decrypt(value: string): Promise<string>;
}

export interface StoredUploadJob extends NativeUploadJob {
  request: NativeUploadRequest;
  filePath: string;
  fingerprint: FileFingerprint;
  contentType: string;
  mediaId?: string;
  objectPath?: string;
  encryptedSessionUrl?: string;
  sessionCreatedAt?: string;
}

const TERMINAL = new Set(["completed", "canceled"]);

export function isTerminalJob(job: Pick<NativeUploadJob, "status">): boolean {
  return TERMINAL.has(job.status);
}

export function toPublicJob(job: StoredUploadJob): NativeUploadJob {
  return {
    id: job.id,
    kind: job.kind,
    filename: job.filename,
    size: job.size,
    uploadedBytes: job.uploadedBytes,
    progress: job.progress,
    speedBps: job.speedBps,
    etaSec: job.etaSec,
    status: job.status,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    result: job.result ? { ...job.result } : undefined,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export class JobStore {
  constructor(
    private readonly directory: string,
    readonly secrets: SecretCodec,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }

  async list(): Promise<StoredUploadJob[]> {
    await this.init();
    const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json"));
    const jobs: StoredUploadJob[] = [];
    for (const name of names) {
      try {
        const parsed = JSON.parse(await readFile(path.join(this.directory, name), "utf8")) as StoredUploadJob;
        if (parsed && typeof parsed.id === "string" && parsed.request && parsed.filePath) jobs.push(parsed);
      } catch (error) {
        console.error(`[native] 전송 작업 파일을 읽지 못했습니다: ${name}`, error);
      }
    }
    return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async save(job: StoredUploadJob): Promise<void> {
    await this.init();
    const target = this.pathFor(job.id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }

  async remove(jobId: string): Promise<void> {
    await unlink(this.pathFor(jobId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async pruneCompleted(jobs: StoredUploadJob[], keep = 50): Promise<StoredUploadJob[]> {
    const terminal = jobs
      .filter(isTerminalJob)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const job of terminal.slice(keep)) await this.remove(job.id);
    const removed = new Set(terminal.slice(keep).map((job) => job.id));
    return jobs.filter((job) => !removed.has(job.id));
  }

  private pathFor(jobId: string): string {
    if (!/^[\w-]+$/.test(jobId)) throw new Error("invalid upload job id");
    return path.join(this.directory, `${jobId}.json`);
  }
}
