export type NativeUploadRequest =
  | {
      kind: "episode";
      programId: string;
      title: string;
      episodeNumber: number;
      broadDate: string;
      track: "variety" | "drama";
      hasSubtitle: boolean;
      fast: boolean;
    }
  | {
      kind: "finished_clip";
      programId: string;
      title: string;
      episodeNumber?: number;
      editKind: "shorts" | "clip" | "highlight";
    };

export type NativeUploadStatus =
  | "queued"
  | "initializing"
  | "uploading"
  | "paused"
  | "finalizing"
  | "completed"
  | "needs_attention"
  | "failed"
  | "canceled";

export type NativeUploadErrorCode =
  | "AUTH_REQUIRED"
  | "FILE_MISSING"
  | "FILE_CHANGED"
  | "SESSION_EXPIRED"
  | "DUPLICATE_EPISODE"
  | "NETWORK"
  | "FINALIZE"
  /** OS 보안 저장소를 못 써서 업로드 세션을 안전하게 보관할 수 없다 — 재시도로 안 풀린다. */
  | "ENCRYPTION_UNAVAILABLE";

export interface NativeUploadJob {
  id: string;
  kind: NativeUploadRequest["kind"];
  filename: string;
  size: number;
  uploadedBytes: number;
  progress: number;
  speedBps?: number;
  etaSec?: number;
  status: NativeUploadStatus;
  errorCode?: NativeUploadErrorCode;
  errorMessage?: string;
  result?: { episodeId?: string; clipId?: string };
  createdAt: string;
  updatedAt: string;
}

export interface StepdNativeBridge {
  readonly version: 1;
  readonly platform: "win32";
  enqueueUpload(file: File, request: NativeUploadRequest): Promise<{ jobId: string }>;
  listUploads(): Promise<NativeUploadJob[]>;
  pauseUpload(jobId: string): Promise<void>;
  resumeUpload(jobId: string): Promise<void>;
  cancelUpload(jobId: string): Promise<void>;
  retryUpload(jobId: string): Promise<void>;
  relinkUpload(jobId: string, file: File): Promise<void>;
  clearCompleted(): Promise<void>;
  subscribeUploads(listener: (jobs: NativeUploadJob[]) => void): () => void;
}

export function isNativeUploadRequest(value: unknown): value is NativeUploadRequest {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.programId !== "string" || !v.programId.trim()) return false;
  if (typeof v.title !== "string" || v.title.length > 500) return false;
  if (v.kind === "episode") {
    return Number.isInteger(v.episodeNumber) && Number(v.episodeNumber) >= 1
      && typeof v.broadDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.broadDate)
      && (v.track === "variety" || v.track === "drama")
      && typeof v.hasSubtitle === "boolean"
      && typeof v.fast === "boolean";
  }
  if (v.kind === "finished_clip") {
    return (v.episodeNumber === undefined
      || (Number.isInteger(v.episodeNumber) && Number(v.episodeNumber) >= 1))
      && (v.editKind === "shorts" || v.editKind === "clip" || v.editKind === "highlight");
  }
  return false;
}

export function publicUploadJob(job: NativeUploadJob): NativeUploadJob {
  return { ...job, result: job.result ? { ...job.result } : undefined };
}
