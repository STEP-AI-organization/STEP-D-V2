import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";

import type { NativeUploadJob, NativeUploadRequest } from "../contract.js";
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
  /**
   * **GCS 가 객체 전체를 받았다고 확인해 준 경우에만 true.**
   *
   * ⚠️ `uploadedBytes` 로는 이걸 판단할 수 없다. 그 값은 진행률 표시용이라
   * **디스크에서 읽어 소켓에 써 넣은 바이트**를 센다(network.ts `putChunk` 의 `onProgress`) —
   * 마지막 청크를 다 읽은 순간 GCS 응답이 오기 전에도 `uploadedBytes === size` 가 된다.
   * 그 상태에서 회선이 끊기면 예외 경로가 **부풀려진 값을 그대로 저장**하고, 재기동 때
   * "바이트는 다 올라갔다" 고 오판해 업로드를 건너뛴 채 finalize 만 무한 반복하게 된다.
   * 실제 객체는 커밋되지 않았으므로 서버는 계속 "upload not found in storage" 를 준다.
   */
  bytesComplete?: boolean;
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
        // ⚠️ 조용히 건너뛰면 그 잡은 화면에서 사라지고, GCS 에 올라간 바이트는 주인을 잃는다.
        // 지우지 말고 옆으로 치워 둔다 — 사람이 열어봐야 무슨 일이 있었는지 알 수 있다.
        console.error(`[native] 전송 작업 파일이 손상됐습니다: ${name}`, error);
        await rename(path.join(this.directory, name), path.join(this.directory, `${name}.corrupt`))
          .catch(() => {});
      }
    }
    return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * 잡별 저장 직렬화.
   *
   * ⚠️ 같은 잡에 대한 `save()` 가 겹치면 **나중에 rename 된 쪽이 이긴다.** 각 호출은 서로 다른
   * 시점의 전체 스냅샷을 쓰기 때문에, 진행률 저장이 취소 저장을 덮으면 재기동 때 **취소한
   * 10GB 작업이 되살아난다.** 파일이 잡마다 하나라 잡 단위로 줄을 세우면 충분하다.
   */
  private readonly writeChain = new Map<string, Promise<void>>();

  async save(job: StoredUploadJob): Promise<void> {
    const snapshot = JSON.stringify(job, null, 2);
    const previous = this.writeChain.get(job.id) ?? Promise.resolve();
    const next = previous
      .catch(() => {})                       // 앞 저장이 실패해도 줄은 계속 선다
      .then(() => this.writeSnapshot(job.id, snapshot));
    this.writeChain.set(job.id, next);
    try {
      await next;
    } finally {
      if (this.writeChain.get(job.id) === next) this.writeChain.delete(job.id);
    }
  }

  /**
   * 임시 파일 → **fsync** → rename.
   *
   * ⚠️ fsync 가 없으면 rename 이 원자적이어도 **내용은 아니다.** 전원이 나가면 디렉토리
   * 엔트리는 새 파일을 가리키는데 그 안이 0바이트이거나 반만 쓰인 JSON 일 수 있다.
   * 그리고 `list()` 는 파싱 실패한 파일을 건너뛰므로, 그 잡은 화면에서 사라지고 GCS 에
   * 올라간 바이트는 주인을 잃는다. 10GB 짜리에 그러면 그대로 손실이다.
   */
  private async writeSnapshot(jobId: string, snapshot: string): Promise<void> {
    await this.init();
    const target = this.pathFor(jobId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(`${snapshot}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
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
