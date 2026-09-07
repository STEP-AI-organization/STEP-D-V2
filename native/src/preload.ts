import { contextBridge, ipcRenderer, webUtils } from "electron";

import type {
  NativeImportTarget, NativeUploadJob, NativeUploadRequest, StepdNativeBridge,
} from "./contract.js";

const origin = location.origin;
const trusted = origin === "https://stepd.stepai.kr"
  || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

if (trusted) {
  const bridge: StepdNativeBridge = {
    version: 1,
    platform: "win32",
    enqueueUpload(file: File, request: NativeUploadRequest) {
      const filePath = webUtils.getPathForFile(file);
      return ipcRenderer.invoke("native:upload:enqueue", { filePath, request });
    },
    listUploads() {
      return ipcRenderer.invoke("native:upload:list");
    },
    pauseUpload(jobId: string) {
      return ipcRenderer.invoke("native:upload:pause", jobId);
    },
    resumeUpload(jobId: string) {
      return ipcRenderer.invoke("native:upload:resume", jobId);
    },
    cancelUpload(jobId: string) {
      return ipcRenderer.invoke("native:upload:cancel", jobId);
    },
    retryUpload(jobId: string) {
      return ipcRenderer.invoke("native:upload:retry", jobId);
    },
    relinkUpload(jobId: string, file: File) {
      const filePath = webUtils.getPathForFile(file);
      return ipcRenderer.invoke("native:upload:relink", { jobId, filePath });
    },
    clearCompleted() {
      return ipcRenderer.invoke("native:upload:clear-completed");
    },
    // ⚠️ **여기서 경로를 판단하지 않는다.** preload 는 렌더러 문맥이라 웹이 ipcRenderer 를
    // 직접 쳐서 우회할 수 있다 — 관리형 경로 판정은 메인 프로세스에만 둔다(설계 문서 참조).
    getWorkspaceInfo() {
      return ipcRenderer.invoke("native:workspace:info");
    },
    importToWorkspace(file: File, target: NativeImportTarget) {
      const filePath = webUtils.getPathForFile(file);
      return ipcRenderer.invoke("native:workspace:import", { filePath, target });
    },
    subscribeUploads(listener: (jobs: NativeUploadJob[]) => void) {
      const handler = (_event: Electron.IpcRendererEvent, jobs: NativeUploadJob[]) => listener(jobs);
      ipcRenderer.on("native:upload:changed", handler);
      return () => ipcRenderer.removeListener("native:upload:changed", handler);
    },
  };
  contextBridge.exposeInMainWorld("stepdNative", bridge);
}
