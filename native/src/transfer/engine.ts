import { randomUUID } from "node:crypto";
import path from "node:path";

import type {
  NativeUploadErrorCode,
  NativeUploadJob,
  NativeUploadRequest,
  NativeUploadStatus,
} from "../contract.js";
import {
  SessionExpiredError,
  TransferAbortedError,
  TransferError,
} from "./errors.js";
import { fingerprintFile, fingerprintsMatch } from "./fingerprint.js";
import { isTerminalJob, JobStore, toPublicJob, type StoredUploadJob } from "./job-store.js";
import { uploadContentType } from "./mime.js";
import { parseCommittedOffset, type ApiResult, type HttpResult, type TransferNetwork } from "./network.js";

const CHUNK_SMALL = 16 * 1024 * 1024;
const CHUNK_LARGE = 64 * 1024 * 1024;
const LARGE_THRESHOLD = 1024 * 1024 * 1024;
const MAX_RETRIES = 6;

type Listener = (jobs: NativeUploadJob[]) => void;

function now(): string {
  return new Date().toISOString();
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new TransferAbortedError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new TransferAbortedError());
    }, { once: true });
  });
}

function errorMessage(result: ApiResult): string {
  const body = result.json as { message?: string; error?: string } | null;
  return body?.message ?? body?.error ?? result.body ?? `HTTP ${result.status}`;
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * 사람에게 보여줄 오류 문구에서 **로컬 절대경로를 지우고 파일명만 남긴다.**
 *
 * 웹은 원격 콘텐츠다 — 로컬 경로를 돌려주지 않는 게 이 앱의 규칙이고, 그 규칙은
 * `webUtils.getPathForFile` 반환값뿐 아니라 **오류 메시지**에도 적용돼야 한다.
 * 파일명은 남긴다: 사용자가 어느 파일인지 알아야 '파일 다시 찾기' 를 할 수 있다.
 */
export function scrubPaths(message: string): string {
  return message
    // Windows 드라이브 경로(C:\a\b\c.mxf) · UNC(\\nas\share\c.mxf) → 마지막 조각만
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\s"']*?([^\\/\s"']+)(?=$|[\s"'])/g, "$1")
    // POSIX(개발 환경) — /a/b/c.mxf → c.mxf
    .replace(/\/(?:[^\s"'/]+\/)+([^\s"'/]+)/g, "$1");
}

export class TransferEngine {
  private readonly jobs = new Map<string, StoredUploadJob>();
  private readonly listeners = new Set<Listener>();
  private active: { jobId: string; controller: AbortController } | null = null;
  private pumping = false;
  private closing = false;

  constructor(
    private readonly store: JobStore,
    private readonly network: TransferNetwork,
  ) {}

  async init(): Promise<void> {
    let loaded = await this.store.list();
    for (const job of loaded) {
      if (["initializing", "uploading", "finalizing"].includes(job.status)) {
        job.status = "queued";
        job.speedBps = undefined;
        job.etaSec = undefined;
        job.updatedAt = now();
        await this.store.save(job);
      } else if (TransferEngine.bytesLanded(job) && !isTerminalJob(job)) {
        // 바이트는 올라갔는데 finalize 가 안 끝난 잡 — 앱을 다시 켠 것 자체가 복구 기회다.
        // 서버 finalize 는 멱등이라 다시 불러도 회차가 둘 생기지 않는다.
        job.status = "queued";
        job.updatedAt = now();
        await this.store.save(job);
      } else if (job.status === "needs_attention" && job.errorCode === "NETWORK") {
        job.status = "queued";
        job.updatedAt = now();
        await this.store.save(job);
      }
      this.jobs.set(job.id, job);
    }
    loaded = await this.store.pruneCompleted(loaded);
    this.jobs.clear();
    for (const job of loaded) this.jobs.set(job.id, job);
    this.emit();
    this.schedulePump();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.list());
    return () => this.listeners.delete(listener);
  }

  list(): NativeUploadJob[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(toPublicJob);
  }

  /**
   * **바이트는 GCS 에 있는데 회차·클립 행이 없는 상태.**
   *
   * 이 상태의 잡은 어떤 오류코드든 "끝난 것" 으로 세면 안 된다 — GCS 에 10GB 가 올라가 있고
   * DB 에는 아무것도 없는데 앱이 "전송 완료" 라고 알리며 종료하면, 그 영상은 사람이 직접
   * 앱을 열어 재시도를 누르기 전까지 사라진 것과 같다. 서버 finalize 는 멱등이라
   * **한 번만 더 부르면 복구되는데**, 재시도할 프로세스가 스스로 꺼지는 게 문제였다.
   */
  private static bytesLanded(job: StoredUploadJob): boolean {
    // ⚠️ `uploadedBytes >= size` 로 판단하지 않는다 — 그 값은 소켓에 써 넣은 바이트라
    // GCS 가 커밋하기 전에 이미 size 에 도달한다. job-store.ts `bytesComplete` 주석 참조.
    return Boolean(job.mediaId) && !job.result && job.bytesComplete === true && job.size > 0;
  }

  hasUnfinishedJobs(): boolean {
    return [...this.jobs.values()].some((job) => {
      if (isTerminalJob(job)) return false;
      // failed 라도 바이트가 이미 올라갔으면 **미완료다** — 자동 종료·자동기동 해제 대상이 아니다.
      if (job.status === "failed") return TransferEngine.bytesLanded(job);
      return true;
    });
  }

  async enqueue(filePath: string, request: NativeUploadRequest): Promise<string> {
    const fingerprint = await fingerprintFile(filePath);
    const timestamp = now();
    const id = randomUUID();
    const job: StoredUploadJob = {
      id,
      kind: request.kind,
      filename: path.basename(filePath),
      size: fingerprint.size,
      uploadedBytes: 0,
      progress: 0,
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
      request,
      filePath,
      fingerprint,
      contentType: uploadContentType(filePath),
    };
    this.jobs.set(id, job);
    await this.store.save(job);
    this.emit();
    this.schedulePump();
    return id;
  }

  async pause(jobId: string): Promise<void> {
    const job = this.requireJob(jobId);
    if (isTerminalJob(job) || job.status === "failed") return;
    await this.setStatus(job, "paused");
    if (this.active?.jobId === jobId) this.active.controller.abort();
  }

  async resume(jobId: string): Promise<void> {
    const job = this.requireJob(jobId);
    if (isTerminalJob(job)) return;
    job.errorCode = undefined;
    job.errorMessage = undefined;
    await this.setStatus(job, "queued");
    this.schedulePump();
  }

  async retry(jobId: string): Promise<void> {
    await this.resume(jobId);
  }

  async retryRecoverable(codes: NativeUploadErrorCode[]): Promise<void> {
    const wanted = new Set(codes);
    let changed = false;
    for (const job of this.jobs.values()) {
      if (job.status === "needs_attention" && job.errorCode && wanted.has(job.errorCode)) {
        job.status = "queued";
        job.errorCode = undefined;
        job.errorMessage = undefined;
        job.updatedAt = now();
        await this.store.save(job);
        changed = true;
      }
    }
    if (changed) {
      this.emit();
      this.schedulePump();
    }
  }

  async cancel(jobId: string): Promise<void> {
    const job = this.requireJob(jobId);
    if (isTerminalJob(job)) return;
    // ⚠️ finalize 중에는 취소할 수 없다. `controller.abort()` 는 **클라이언트 쪽만** 끊는다 —
    // 요청은 이미 서버에 도달해 회차·미디어 행을 만들고 분석까지 큐잉하므로(크레딧이 나간다),
    // 로컬만 canceled 로 지우면 사용자가 모르는 유령 회차가 남는다. 몇 초짜리 구간이니 기다린다.
    if (job.status === "finalizing") {
      throw new Error("서버에 등록하는 중이라 지금은 취소할 수 없습니다. 잠시 뒤 다시 시도해 주세요.");
    }
    job.status = "canceled";
    job.speedBps = undefined;
    job.etaSec = undefined;
    job.updatedAt = now();
    await this.store.save(job);
    if (this.active?.jobId === jobId) this.active.controller.abort();
    const sessionUrl = await this.sessionUrl(job).catch(() => undefined);
    if (sessionUrl) void this.network.cancelSession(sessionUrl);
    this.emit();
  }

  async relink(jobId: string, filePath: string): Promise<void> {
    const job = this.requireJob(jobId);
    if (isTerminalJob(job)) throw new Error("완료되거나 취소된 작업은 파일을 바꿀 수 없습니다.");
    const fingerprint = await fingerprintFile(filePath);
    const sameFile = fingerprintsMatch(job.fingerprint, fingerprint);
    if (!sameFile) {
      const sessionUrl = await this.sessionUrl(job).catch(() => undefined);
      if (sessionUrl) await this.network.cancelSession(sessionUrl);
      job.mediaId = undefined;
      job.objectPath = undefined;
      job.encryptedSessionUrl = undefined;
      job.sessionCreatedAt = undefined;
      job.uploadedBytes = 0;
      job.progress = 0;
      job.bytesComplete = false;   // 세션을 버렸으니 GCS 객체도 없다
    }
    job.filePath = filePath;
    job.filename = path.basename(filePath);
    job.size = fingerprint.size;
    job.fingerprint = fingerprint;
    job.contentType = uploadContentType(filePath);
    job.errorCode = undefined;
    job.errorMessage = sameFile ? undefined : "다른 파일로 바뀌어 처음부터 다시 전송합니다.";
    await this.setStatus(job, "queued");
    this.schedulePump();
  }

  async clearCompleted(): Promise<void> {
    for (const [id, job] of this.jobs) {
      if (isTerminalJob(job)) {
        await this.store.remove(id);
        this.jobs.delete(id);
      }
    }
    this.emit();
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    const activeId = this.active?.jobId;
    this.active?.controller.abort();
    // ⚠️ **끊고 나서 다 풀릴 때까지 기다린 뒤에 저장한다.** 먼저 저장하면 abort 직전에 이미
    // 걸려 있던 `store.save` 가 나중에 도착해 여기서 쓴 queued 스냅샷을 덮는다 — shutdown 이
    // "다 저장했다" 고 약속하고 지키지 않는 셈이다.
    await this.pumpDone?.catch(() => {});
    if (!activeId) return;
    const job = this.jobs.get(activeId);
    if (job && ["initializing", "uploading", "finalizing"].includes(job.status)) {
      job.status = "queued";
      job.speedBps = undefined;
      job.etaSec = undefined;
      job.updatedAt = now();
      await this.store.save(job);
    }
  }

  /** 진행 중인 `pump()` — `shutdown()` 이 이걸 기다려야 뒤늦은 저장이 안 새어 나온다. */
  private pumpDone: Promise<void> | null = null;

  private schedulePump(): void {
    if (this.closing || this.pumping) return;
    queueMicrotask(() => {
      if (this.closing || this.pumping) return;
      this.pumpDone = this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.closing) return;
    this.pumping = true;
    try {
      while (!this.closing) {
        const job = [...this.jobs.values()]
          .filter((item) => item.status === "queued")
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        if (!job) break;
        const controller = new AbortController();
        this.active = { jobId: job.id, controller };
        await this.runJob(job, controller.signal);
        this.active = null;
      }
    } finally {
      this.active = null;
      this.pumping = false;
    }
  }

  private async runJob(job: StoredUploadJob, signal: AbortSignal): Promise<void> {
    try {
      // ⚠️ 바이트가 이미 GCS 에 다 올라갔으면 **로컬 원본을 다시 보지 않는다.**
      // 업로드가 끝난 걸 보고 원본을 아카이브로 옮긴 편집자가 있으면 FILE_MISSING 이 되고,
      // '파일 다시 찾기' 는 mtime 이 달라졌다는 이유로 GCS 세션을 지우고 0바이트부터
      // 다시 올린다 — finalize 한 번이면 끝날 일에 10GB 를 다시 태우게 된다.
      if (TransferEngine.bytesLanded(job)) {
        await this.finalize(job, signal);
        return;
      }
      await this.verifyFile(job);
      let expiredRestarts = 0;
      while (true) {
        const sessionUrl = await this.ensureSession(job, signal);
        try {
          await this.upload(job, sessionUrl, signal);
          break;
        } catch (error) {
          if (!(error instanceof SessionExpiredError) || expiredRestarts >= 1) throw error;
          expiredRestarts += 1;
          job.status = "initializing";
          job.errorCode = "SESSION_EXPIRED";
          job.errorMessage = "재개 세션이 만료돼 처음부터 다시 전송합니다.";
          job.mediaId = undefined;
          job.objectPath = undefined;
          job.encryptedSessionUrl = undefined;
          job.sessionCreatedAt = undefined;
          job.uploadedBytes = 0;
          job.progress = 0;
          job.bytesComplete = false;   // 만료된 세션의 객체는 없다 — 처음부터 다시
          job.updatedAt = now();
          await this.store.save(job);
          this.emit();
        }
      }
      await this.finalize(job, signal);
    } catch (error) {
      if (error instanceof TransferAbortedError || signal.aborted) return;
      const transferError = error instanceof TransferError
        ? error
        // ⚠️ **원문을 그대로 쓰지 않는다.** Node 의 fs 오류는 메시지에 전체 경로를 담는다
        // (`ENOENT: … open 'C:\Users\…\master.mxf'`). 이 문자열은 job.errorMessage 로 렌더러에
        // 실려 전송 센터에 그대로 표시되므로, **원격 웹 콘텐츠에 로컬 경로를 넘기지 않는다**는
        // 이 앱의 규칙이 여기서 깨진다(규칙은 getPathForFile 반환값에만 있는 게 아니다).
        : new TransferError(
          "NETWORK",
          scrubPaths(error instanceof Error ? error.message : String(error)),
          true,
        );
      // ⚠️ **finalize 실패는 failed 가 아니라 needs_attention 이다.**
      // 프록시 502(Vercel thaw 후 ECONNRESET)·Cloud Run 콜드스타트 5xx 는 이 리포에서
      // 상시 재발하는 일시 장애다. 그런데 FINALIZE 를 failed 로 떨구면 ① 재시도 대상에서
      // 빠지고 ② hasUnfinishedJobs 가 "끝났다" 고 봐서 앱이 종료·자동기동 해제까지 한다.
      // 바이트가 이미 GCS 에 있으면 **코드와 무관하게** 사람이 볼 수 있는 상태로 남긴다.
      // ⚠️ 회차 번호 중복(409)만은 예외다. 같은 body 로 다시 finalize 해도 **영원히 같은 409** 라
      // 재시도가 성립하지 않는데, 바이트가 올라갔다는 이유로 needs_attention 에 두면 그 잡이
      // `hasUnfinishedJobs()` 를 계속 참으로 만들어 ① 창 X 가 앱을 못 끄고 ② 매 로그인마다
      // 앱이 몰래 뜬다. 사람이 취소하기 전까지 영구히 — 그래서 failed 로 떨군다.
      const deadEnd = transferError.code === "DUPLICATE_EPISODE";
      const attention = !deadEnd && (
        ["AUTH_REQUIRED", "FILE_MISSING", "FILE_CHANGED", "NETWORK", "FINALIZE"]
          .includes(transferError.code) || TransferEngine.bytesLanded(job)
      );
      job.status = attention ? "needs_attention" : "failed";
      job.errorCode = transferError.code;
      job.errorMessage = transferError.message;
      job.speedBps = undefined;
      job.etaSec = undefined;
      job.updatedAt = now();
      await this.store.save(job);
      this.emit();
    }
  }

  private async verifyFile(job: StoredUploadJob): Promise<void> {
    let fingerprint;
    try {
      fingerprint = await fingerprintFile(job.filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new TransferError("FILE_MISSING", "원본 파일을 찾을 수 없습니다. 파일을 다시 지정해 주세요.");
      }
      throw error;
    }
    if (!fingerprintsMatch(job.fingerprint, fingerprint)) {
      throw new TransferError("FILE_CHANGED", "선택한 파일이 전송 시작 후 변경됐습니다. 파일을 다시 확인해 주세요.");
    }
  }

  private async ensureSession(job: StoredUploadJob, signal: AbortSignal): Promise<string> {
    if (job.encryptedSessionUrl && job.mediaId && job.objectPath) return this.sessionUrl(job);
    await this.setStatus(job, "initializing");

    const initBody = job.request.kind === "episode"
      ? {
          filename: job.filename,
          contentType: job.contentType,
          programId: job.request.programId,
          title: job.request.title,
          episodeNumber: job.request.episodeNumber,
          broadDate: job.request.broadDate,
          track: job.request.track,
          hasSubtitle: job.request.hasSubtitle,
        }
      : {
          filename: job.filename,
          contentType: job.contentType,
          programId: job.request.programId,
        };
    const response = await this.apiWithRetries<{
      mode?: string; mediaId?: string; objectPath?: string; sessionUrl?: string;
    }>("/media/upload-init", initBody, signal);
    if (response.status === 401) throw new TransferError("AUTH_REQUIRED", "로그인이 필요합니다.");
    if (response.status === 409) {
      throw new TransferError("DUPLICATE_EPISODE", errorMessage(response));
    }
    if (response.status < 200 || response.status >= 300) {
      throw new TransferError("NETWORK", `업로드 세션 생성 실패: ${errorMessage(response)}`, true);
    }
    const data = response.json;
    if (!data || data.mode !== "resumable" || !data.mediaId || !data.objectPath || !data.sessionUrl) {
      throw new TransferError("FINALIZE", "네이티브 업로드는 GCS resumable 모드가 필요합니다.");
    }
    job.mediaId = data.mediaId;
    job.objectPath = data.objectPath;
    job.encryptedSessionUrl = await this.store.secrets.encrypt(data.sessionUrl);
    job.sessionCreatedAt = now();
    job.errorCode = undefined;
    job.errorMessage = undefined;
    job.updatedAt = now();
    await this.store.save(job);
    this.emit();
    return data.sessionUrl;
  }

  private async upload(job: StoredUploadJob, sessionUrl: string, signal: AbortSignal): Promise<void> {
    await this.setStatus(job, "uploading");
    let offset = await this.readCommittedOffset(sessionUrl, job.size, signal);
    job.uploadedBytes = offset;
    this.updateProgress(job);
    await this.store.save(job);

    const chunkSize = job.size >= LARGE_THRESHOLD ? CHUNK_LARGE : CHUNK_SMALL;
    let sampleAt = Date.now();
    let sampleBytes = offset;
    let lastProgressEmitAt = 0;

    while (offset < job.size) {
      const end = Math.min(offset + chunkSize, job.size) - 1;
      let accepted: HttpResult | null = null;
      let lastError: unknown;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
        try {
          const baseOffset = offset;
          const result = await this.network.putChunk({
            sessionUrl,
            filePath: job.filePath,
            start: offset,
            endInclusive: end,
            total: job.size,
            signal,
            onProgress: (chunkBytes) => {
              const current = Math.min(job.size, baseOffset + chunkBytes);
              const sampleNow = Date.now();
              if (sampleNow - sampleAt >= 500 && current > sampleBytes) {
                const instant = ((current - sampleBytes) * 1000) / (sampleNow - sampleAt);
                job.speedBps = job.speedBps ? job.speedBps * 0.6 + instant * 0.4 : instant;
                sampleAt = sampleNow;
                sampleBytes = current;
              }
              job.uploadedBytes = current;
              this.updateProgress(job);
              if (sampleNow - lastProgressEmitAt >= 250) {
                lastProgressEmitAt = sampleNow;
                this.emit();
              }
            },
          });
          if (result.status === 404 || result.status === 410) throw new SessionExpiredError();
          if (result.status === 200 || result.status === 201 || result.status === 308) {
            accepted = result;
            break;
          }
          if (!isTransientStatus(result.status)) {
            throw new TransferError("NETWORK", `GCS가 청크를 거부했습니다: HTTP ${result.status} ${result.body}`, false);
          }
          lastError = new Error(`HTTP ${result.status}`);
        } catch (error) {
          if (error instanceof TransferAbortedError || error instanceof SessionExpiredError || signal.aborted) throw error;
          if (error instanceof TransferError && !error.retryable) throw error;
          lastError = error;
        }

        const committed = await this.tryCommittedOffset(sessionUrl, job.size, signal);
        if (committed !== null) {
          offset = committed;
          job.uploadedBytes = committed;
          this.updateProgress(job);
          await this.store.save(job);
          this.emit();
          if (offset >= job.size) return;
          if (offset > end) {
            accepted = {
              status: 308,
              headers: { range: `bytes=0-${offset - 1}` },
              body: "",
            };
            break;
          }
        }
        if (attempt < MAX_RETRIES - 1) await delay(Math.min(8000, 600 * 2 ** attempt), signal);
      }

      if (!accepted) {
        throw new TransferError(
          "NETWORK",
          `청크 전송을 재시도했지만 완료하지 못했습니다: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
          true,
        );
      }
      const next = parseCommittedOffset(accepted.status, accepted.headers.range, job.size);
      offset = next ?? (end + 1);
      job.uploadedBytes = offset;
      this.updateProgress(job);
      job.updatedAt = now();
      await this.store.save(job);
      this.emit();
    }
  }

  private async finalize(job: StoredUploadJob, signal: AbortSignal): Promise<void> {
    if (!job.mediaId || !job.objectPath) throw new TransferError("FINALIZE", "업로드 식별자가 없습니다.");
    await this.setStatus(job, "finalizing");
    // 여기 도달했다는 건 `upload()` 가 모든 청크에 대해 GCS 의 커밋 응답(200/201/308 Range)을
    // 받고 정상 반환했거나, 이미 확인된 잡이라는 뜻이다 — **이 시점에만** 완료로 기록한다.
    job.bytesComplete = true;
    job.uploadedBytes = job.size;
    job.progress = 100;
    await this.store.save(job);
    this.emit();

    const common = {
      mediaId: job.mediaId,
      objectPath: job.objectPath,
      filename: job.filename,
      contentType: job.contentType,
      size: job.size,
      programId: job.request.programId,
      title: job.request.title,
    };
    const endpoint = job.request.kind === "episode" ? "/media/finalize" : "/media/clip-finalize";
    const body = job.request.kind === "episode"
      ? {
          ...common,
          episodeNumber: job.request.episodeNumber,
          broadDate: job.request.broadDate,
          track: job.request.track,
          hasSubtitle: job.request.hasSubtitle,
          ...(job.request.fast ? { fast: true } : {}),
        }
      : {
          ...common,
          episodeNumber: job.request.episodeNumber,
          editKind: job.request.editKind,
        };
    const response = await this.apiWithRetries<{
      episode?: { id?: string } | null;
      clip?: { id?: string } | null;
    }>(endpoint, body, signal);
    if (response.status === 401) throw new TransferError("AUTH_REQUIRED", "업로드 완료 처리를 위해 다시 로그인해 주세요.");
    // 재시도해도 같은 409 다 — 사용자가 실제로 할 수 있는 일을 문구에 담는다.
    if (response.status === 409) {
      throw new TransferError(
        "DUPLICATE_EPISODE",
        `${errorMessage(response)} 이미 등록된 회차라 이 전송은 더 진행할 수 없습니다.`
        + " 취소한 뒤 다른 회차 번호로 다시 올려 주세요.",
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new TransferError("FINALIZE", `업로드 완료 처리 실패: ${errorMessage(response)}`, true);
    }
    if (job.request.kind === "episode") {
      const episodeId = response.json?.episode?.id;
      if (!episodeId) throw new TransferError("FINALIZE", "완료 응답에 회차 ID가 없습니다.", true);
      job.result = { episodeId };
    } else {
      const clipId = response.json?.clip?.id;
      if (!clipId) throw new TransferError("FINALIZE", "완료 응답에 클립 ID가 없습니다.", true);
      job.result = { clipId };
    }
    job.status = "completed";
    job.errorCode = undefined;
    job.errorMessage = undefined;
    job.speedBps = undefined;
    job.etaSec = undefined;
    job.updatedAt = now();
    await this.store.save(job);
    this.emit();
    const retained = await this.store.pruneCompleted([...this.jobs.values()]);
    const retainedIds = new Set(retained.map((item) => item.id));
    for (const id of this.jobs.keys()) {
      if (!retainedIds.has(id)) this.jobs.delete(id);
    }
    this.emit();
  }

  private async apiWithRetries<T>(pathName: string, body: unknown, signal: AbortSignal): Promise<ApiResult<T>> {
    let lastError: unknown;
    let lastResult: ApiResult<T> | null = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      try {
        const result = await this.network.api<T>(pathName, body, signal);
        lastResult = result;
        if (!isTransientStatus(result.status)) return result;
      } catch (error) {
        if (error instanceof TransferAbortedError || signal.aborted) throw error;
        lastError = error;
      }
      if (attempt < MAX_RETRIES - 1) await delay(Math.min(8000, 600 * 2 ** attempt), signal);
    }
    if (lastResult) return lastResult;
    throw new TransferError("NETWORK", lastError instanceof Error ? lastError.message : String(lastError), true);
  }

  private async readCommittedOffset(sessionUrl: string, total: number, signal: AbortSignal): Promise<number> {
    const result = await this.network.queryOffset(sessionUrl, total, signal);
    if (result.status === 404 || result.status === 410) throw new SessionExpiredError();
    const offset = parseCommittedOffset(result.status, result.headers.range, total);
    if (offset === null) {
      throw new TransferError("NETWORK", `업로드 재개 위치를 확인하지 못했습니다: HTTP ${result.status}`, true);
    }
    return offset;
  }

  private async tryCommittedOffset(sessionUrl: string, total: number, signal: AbortSignal): Promise<number | null> {
    try {
      return await this.readCommittedOffset(sessionUrl, total, signal);
    } catch (error) {
      if (error instanceof SessionExpiredError || error instanceof TransferAbortedError) throw error;
      return null;
    }
  }

  private updateProgress(job: StoredUploadJob): void {
    job.progress = job.size > 0 ? Math.min(100, Math.round((job.uploadedBytes / job.size) * 100)) : 0;
    job.etaSec = job.speedBps && job.speedBps > 0
      ? Math.max(0, Math.round((job.size - job.uploadedBytes) / job.speedBps))
      : undefined;
    job.updatedAt = now();
  }

  private async sessionUrl(job: StoredUploadJob): Promise<string> {
    if (!job.encryptedSessionUrl) throw new Error("upload session missing");
    return this.store.secrets.decrypt(job.encryptedSessionUrl);
  }

  private requireJob(jobId: string): StoredUploadJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("전송 작업을 찾을 수 없습니다.");
    return job;
  }

  private async setStatus(job: StoredUploadJob, status: NativeUploadStatus): Promise<void> {
    job.status = status;
    job.updatedAt = now();
    if (status !== "uploading") {
      job.speedBps = undefined;
      job.etaSec = undefined;
    }
    await this.store.save(job);
    this.emit();
  }

  private emit(): void {
    const jobs = this.list();
    for (const listener of this.listeners) listener(jobs);
  }
}
