"use client";

import type {
  NativeUploadJob,
  NativeUploadRequest,
  StepdNativeBridge,
} from "@stepd/native/contract";
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
  const { refresh } = useAppData();
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

  const value = useMemo<NativeTransferContextValue>(() => ({
    available,
    jobs,
    activeCount: jobs.filter((job) =>
      ["queued", "initializing", "uploading", "paused", "finalizing", "needs_attention"].includes(job.status)).length,
    enqueueUpload: (file, request) => call((bridge) => bridge.enqueueUpload(file, request).then((r) => r.jobId)),
    pauseUpload: (id) => call((bridge) => bridge.pauseUpload(id)),
    resumeUpload: (id) => call((bridge) => bridge.resumeUpload(id)),
    cancelUpload: (id) => call((bridge) => bridge.cancelUpload(id)),
    retryUpload: (id) => call((bridge) => bridge.retryUpload(id)),
    relinkUpload: (id, file) => call((bridge) => bridge.relinkUpload(id, file)),
    clearCompleted: () => call((bridge) => bridge.clearCompleted()),
  }), [available, jobs, call]);

  return <NativeTransferContext.Provider value={value}>{children}</NativeTransferContext.Provider>;
}

export function useNativeTransfers(): NativeTransferContextValue {
  const value = useContext(NativeTransferContext);
  if (!value) throw new Error("useNativeTransfers must be used within NativeTransferProvider");
  return value;
}

export type { NativeUploadJob, NativeUploadRequest };
