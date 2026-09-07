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

// ── 관리형 작업 공간 (2026-09-07 · 1~3단계) ─────────────────────────────────────
//
// ⚠️ **`version` 을 올리지 않는다.** 올리면 앱을 아직 안 깐 PC 가 전부 브라우저 업로드로
// 떨어져 네이티브 이점(영속 큐·재개)이 통째로 사라진다. 웹은 메서드 **존재 여부**로 본다:
//     if (typeof bridge.getWorkspaceInfo === "function") { ... }
// 그래서 구버전 앱에서도 지금 동작이 그대로 유지된다.

export const WORKSPACE_FOLDERS = ["source", "proxy", "project", "export", "delivery"] as const;
export type WorkspaceFolderName = (typeof WORKSPACE_FOLDERS)[number];

export interface NativeWorkspaceInfo {
  rootPath: string;
  /** 루트가 실제로 만들어져 있나. false 면 아직 아무것도 안 들였다는 뜻. */
  ready: boolean;
  policyVersion: number;
  folders: string[];
}

export interface NativeImportTarget {
  program: string;
  episode?: string;
  folder: WorkspaceFolderName;
}

export interface NativeImportResult {
  managedPath: string;
  filename: string;
  size: number;
  /** 이미 안에 있어서 복사를 건너뛴 경우 true. */
  reused: boolean;
}

export function isWorkspaceFolder(v: unknown): v is WorkspaceFolderName {
  return typeof v === "string" && (WORKSPACE_FOLDERS as readonly string[]).includes(v);
}

/**
 * 들여오기 대상 검증. **프로그램 이름은 필수**다 — 없으면 어느 폴더로 갈지 정할 수 없고,
 * 조용히 기본 폴더에 넣으면 나중에 아무도 못 찾는다.
 */
export function isNativeImportTarget(value: unknown): value is NativeImportTarget {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.program !== "string" || !v.program.trim() || v.program.length > 200) return false;
  if (v.episode !== undefined && (typeof v.episode !== "string" || v.episode.length > 200)) return false;
  return isWorkspaceFolder(v.folder);
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

  // ── 관리형 작업 공간 — **선택적**이다(구버전 앱에는 없다) ──
  /** 작업 공간 위치·준비 상태. 화면이 "어디에 저장되나" 를 말할 수 있게. */
  getWorkspaceInfo(): Promise<NativeWorkspaceInfo>;
  /**
   * 외부 파일을 작업 공간으로 복사해 들인다. **원본은 그대로 둔다.**
   * 이미 안에 있으면 복사하지 않고 그 경로를 돌려준다(`reused: true`).
   */
  importToWorkspace(file: File, target: NativeImportTarget): Promise<NativeImportResult>;
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
