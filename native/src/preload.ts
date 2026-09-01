import { contextBridge, ipcRenderer, webUtils } from "electron";

import type { NativeUploadJob, NativeUploadRequest, StepdNativeBridge } from "./contract.js";

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
    subscribeUploads(listener: (jobs: NativeUploadJob[]) => void) {
      const handler = (_event: Electron.IpcRendererEvent, jobs: NativeUploadJob[]) => listener(jobs);
      ipcRenderer.on("native:upload:changed", handler);
      return () => ipcRenderer.removeListener("native:upload:changed", handler);
    },
  };
  contextBridge.exposeInMainWorld("stepdNative", bridge);
}
