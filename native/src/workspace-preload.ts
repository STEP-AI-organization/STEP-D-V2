/**
 * **내 작업공간 창 전용 브리지.** 웹뷰용 `preload.ts` 와 일부러 갈라 뒀다.
 *
 * ## 왜 따로인가
 *
 * `preload.ts` 는 **신뢰 origin(우리 웹)에서만** 브리지를 노출한다. 내 작업공간 창은
 * `file://` 로 뜨는 우리 로컬 페이지라 그 검사를 통과하지 못한다. 통과시키려고
 * origin 검사를 느슨하게 하면 **웹뷰 쪽 방어가 같이 약해진다** — 그건 맞바꿀 값이 아니다.
 *
 * 그래서 이 창에는 **읽기 전용 표면**만 따로 준다. 업로드를 걸거나 파일을 들여오는 능력은
 * 여기 없다 — 이 창은 "지금 내 PC 가 어떤 상태인가" 를 보여주는 자리다.
 */
import { contextBridge, ipcRenderer } from "electron";

import type { NativeUploadJob } from "./contract.js";

export interface WorkspaceOverview {
  /** 작업 공간 루트(실제 경로). */
  rootPath: string;
  ready: boolean;
  /** 왜 이 자리인가 — 화면이 사람 말로 설명할 근거. */
  reason: "env" | "remembered" | "drive" | "home";
  folders: string[];
  disk: { freeBytes: number; totalBytes: number } | null;
  /** 로컬 렌더가 가능한 상태인가(동봉 ffmpeg 이 있나). */
  canRender: boolean;
  ffmpeg: string | null;
}

export interface WorkspaceBridge {
  readonly version: 1;
  overview(): Promise<WorkspaceOverview>;
  uploads(): Promise<NativeUploadJob[]>;
  subscribeUploads(listener: (jobs: NativeUploadJob[]) => void): () => void;
  /** 탐색기에서 연다. 경로는 **메인 프로세스가 작업 공간 안인지 다시 본다.** */
  reveal(target: string): Promise<void>;
}

const bridge: WorkspaceBridge = {
  version: 1,
  overview: () => ipcRenderer.invoke("native:workspace:overview"),
  uploads: () => ipcRenderer.invoke("native:upload:list"),
  subscribeUploads(listener) {
    const handler = (_e: Electron.IpcRendererEvent, jobs: NativeUploadJob[]) => listener(jobs);
    ipcRenderer.on("native:upload:changed", handler);
    return () => ipcRenderer.removeListener("native:upload:changed", handler);
  },
  reveal: (target: string) => ipcRenderer.invoke("native:workspace:reveal", target),
};

contextBridge.exposeInMainWorld("stepdWorkspace", bridge);
