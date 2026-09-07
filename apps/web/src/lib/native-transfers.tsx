"use client";

import type {
  NativeUploadJob,
  NativeUploadRequest,
  StepdNativeBridge,
} from "stepaistudio/contract";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useToast } from "@/components/ui/toast";
import { useAppData } from "@/lib/data/store";

declare global {
  interface Window {
    stepdNative?: StepdNativeBridge;
  }
}

interface NativeTransferContextValue {
  available: boolean;
  jobs: NativeUploadJob[];
  activeCount: number;
  enqueueUpload(file: File, request: NativeUploadRequest): Promise<string>;
  pauseUpload(jobId: string): Promise<void>;
  resumeUpload(jobId: string): Promise<void>;
  cancelUpload(jobId: string): Promise<void>;
  retryUpload(jobId: string): Promise<void>;
  relinkUpload(jobId: string, file: File): Promise<void>;
  clearCompleted(): Promise<void>;
}

const NativeTransferContext = createContext<NativeTransferContextValue | null>(null);

export function NativeTransferProvider({ children }: { children: ReactNode }) {
  const { refresh, programs } = useAppData();
  const { toast } = useToast();
  const [available, setAvailable] = useState(false);
  const [jobs, setJobs] = useState<NativeUploadJob[]>([]);
  const previous = useRef(new Map<string, NativeUploadJob["status"]>());

  useEffect(() => {
    const bridge = window.stepdNative;
    if (!bridge || bridge.version !== 1) return;
    setAvailable(true);
    let alive = true;
    void bridge.listUploads().then((initial) => {
      if (!alive) return;
      setJobs(initial);
      previous.current = new Map(initial.map((job) => [job.id, job.status]));
    }).catch(() => setAvailable(false));
    const unsubscribe = bridge.subscribeUploads((next) => {
      if (!alive) return;
      for (const job of next) {
        const before = previous.current.get(job.id);
        if (before && before !== job.status && job.status === "completed") {
          toast({
            title: "업로드 완료",
            description: `${job.filename} 등록을 마쳤습니다.`,
            tone: "done",
          });
          void refresh();
        } else if (before && before !== job.status && ["failed", "needs_attention"].includes(job.status)) {
          toast({
            title: "업로드 실패",
            description: job.errorMessage ?? `${job.filename} 전송을 확인해 주세요.`,
            tone: "error",
            duration: 0,
          });
        }
      }
      previous.current = new Map(next.map((job) => [job.id, job.status]));
      setJobs(next);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [refresh, toast]);

  const call = useCallback(<T,>(fn: (bridge: StepdNativeBridge) => Promise<T>) => {
    const bridge = window.stepdNative;
    if (!bridge) return Promise.reject(new Error("STEP-D 데스크톱 전송 기능을 사용할 수 없습니다."));
    return fn(bridge);
  }, []);

  /**
   * **작업 공간을 거쳐 올린다** (관리형 작업 공간 3단계).
   *
   * 외부 파일(다운로드 폴더·바탕화면 등)은 앱이 작업 공간으로 **복사한 뒤** 그 경로로
   * 큐에 넣는다. 원본은 그대로 둔다. 이미 작업 공간 안이면 복사하지 않는다.
   *
   * ⚠️ **구버전 앱을 안 깨뜨린다.** `importToWorkspace` 가 없는 앱(아직 재설치 안 한 PC)
   * 에서는 예전처럼 파일을 바로 큐에 넣는다 — 계약 `version` 을 안 올린 이유가 이것이다.
   * 새 흐름은 앱을 먼저 깔아야 돈다(native/CLAUDE.md 의 배포 순서).
   *
   * ⚠️ 폴더 이름은 **프로그램 이름**이다(id 가 아니라). `p_37bd8872` 로 만들면 사람이
   * 탐색기에서 찾을 수 없고, 그러면 이 기능의 목적이 사라진다.
   */
  const enqueueViaWorkspace = useCallback(
    async (bridge: StepdNativeBridge, file: File, request: NativeUploadRequest): Promise<string> => {
      if (typeof bridge.importToWorkspace === "function") {
        const program = programs.find((p) => p.id === request.programId);
        const episode = request.kind === "episode" && request.episodeNumber
          ? `${request.episodeNumber}회`
          : undefined;
        // 회차 원본은 source/, 완성본은 delivery/ — 같은 폴더에 섞으면 무엇이 원본인지 모른다.
        const folder = request.kind === "episode" ? "source" : "delivery";
        await bridge.importToWorkspace(file, {
          program: program?.title || request.programId,
          episode,
          folder,
        });
      }
      const { jobId } = await bridge.enqueueUpload(file, request);
      return jobId;
    },
    [programs],
  );

  const value = useMemo<NativeTransferContextValue>(() => ({
    available,
    jobs,
    activeCount: jobs.filter((job) =>
      ["queued", "initializing", "uploading", "paused", "finalizing", "needs_attention"].includes(job.status)).length,
    enqueueUpload: (file, request) => call((bridge) => enqueueViaWorkspace(bridge, file, request)),
    pauseUpload: (id) => call((bridge) => bridge.pauseUpload(id)),
    resumeUpload: (id) => call((bridge) => bridge.resumeUpload(id)),
    cancelUpload: (id) => call((bridge) => bridge.cancelUpload(id)),
    retryUpload: (id) => call((bridge) => bridge.retryUpload(id)),
    relinkUpload: (id, file) => call((bridge) => bridge.relinkUpload(id, file)),
    clearCompleted: () => call((bridge) => bridge.clearCompleted()),
  }), [available, jobs, call, enqueueViaWorkspace]);

  return <NativeTransferContext.Provider value={value}>{children}</NativeTransferContext.Provider>;
}

export function useNativeTransfers(): NativeTransferContextValue {
  const value = useContext(NativeTransferContext);
  if (!value) throw new Error("useNativeTransfers must be used within NativeTransferProvider");
  return value;
}

export type { NativeUploadJob, NativeUploadRequest };
