import { spawn } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import path from "node:path";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  powerMonitor,
  safeStorage,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from "electron";

import type { NativeUploadJob } from "./contract.js";
import { JobStore, type SecretCodec } from "./transfer/job-store.js";
import { ElectronTransferNetwork } from "./transfer/network-electron.js";
import { EncryptionUnavailableError } from "./transfer/errors.js";
import { TransferEngine } from "./transfer/engine.js";
import { validateJobId, validateUploadInput, validateVideoPath } from "./transfer/validation.js";

const PRODUCT_URL = "https://stepd.stepai.kr";
const PARTITION = "persist:stepd";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let engine: TransferEngine | null = null;
let quitting = false;
let shutdownComplete = false;
let closeWhenIdle = false;
let loginItemEnabled: boolean | null = null;
let networkTimer: NodeJS.Timeout | null = null;
let previousStates = new Map<string, NativeUploadJob["status"]>();

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

function webUrl(): string {
  if (!app.isPackaged && process.env.STEPD_WEB_URL) return process.env.STEPD_WEB_URL.replace(/\/$/, "");
  return PRODUCT_URL;
}

function apiBase(): string {
  if (!app.isPackaged && process.env.STEPD_API_BASE) return process.env.STEPD_API_BASE.replace(/\/$/, "");
  return `${webUrl()}/api/proxy/api`;
}

function trustedOrigin(): string {
  return new URL(webUrl()).origin;
}

function assertTrusted(event: IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  let origin = "";
  try { origin = new URL(senderUrl).origin; } catch { /* rejected below */ }
  if (origin !== trustedOrigin()) throw new Error("untrusted native bridge origin");
}

class DpapiCodec implements SecretCodec {
  async encrypt(value: string): Promise<string> {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new EncryptionUnavailableError(
        "Windows 보안 저장소를 사용할 수 없어 업로드를 시작하지 않았습니다. 관리자에게 문의해 주세요.");
    }
    return (await safeStorage.encryptStringAsync(value)).toString("base64");
  }

  async decrypt(value: string): Promise<string> {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new EncryptionUnavailableError("Windows 보안 저장소를 사용할 수 없습니다.");
    }
    const decrypted = await safeStorage.decryptStringAsync(Buffer.from(value, "base64"));
    if (decrypted.shouldReEncrypt) {
      // The next normal save receives a freshly encrypted session. Decryption remains valid now.
      console.info("[native] DPAPI 키가 회전돼 업로드 세션을 다음 저장 때 다시 암호화합니다.");
    }
    return decrypted.result;
  }
}

function iconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icons", "stepd.png")
    : path.resolve(app.getAppPath(), "..", "apps", "web", "public", "brand", "stepd-icon-192.png");
}

function offlinePath(): string {
  return path.join(app.getAppPath(), "assets", "offline.html");
}

function allowedExternal(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    const suffixes = [
      "google.com", "youtube.com", "youtu.be", "facebook.com", "instagram.com",
      "tiktok.com", "tiktokapis.com", "portone.io", "iamport.co", "adobe.com", "stepai.kr",
    ];
    return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

async function loadWeb(route = ""): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const normalized = route && route.startsWith("/") ? route : "";
  await mainWindow.loadURL(`${webUrl()}${normalized}`).catch(async (error) => {
    console.error("[native] STEP-D 웹 로드 실패", error);
    if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadFile(offlinePath());
  });
}

async function openPremiere(): Promise<void> {
  const adobeRoot = "C:\\Program Files\\Adobe";
  try {
    const names = (await readdir(adobeRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("Adobe Premiere Pro "))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const name of names) {
      const executable = path.join(adobeRoot, name, "Adobe Premiere Pro.exe");
      await access(executable);
      const child = spawn(executable, [], { detached: true, stdio: "ignore", windowsHide: false });
      child.on("error", () => {});
      child.unref();
      return;
    }
  } catch {
    // The actionable dialog below is the user-facing failure.
  }
  const result = await dialog.showMessageBox({
    type: "warning",
    title: "STEP-D",
    message: "Adobe Premiere Pro가 이 PC에 없습니다.",
    detail: "STEP-D 패널은 Premiere Pro 25.6 이상에서 동작합니다. 설치 페이지를 열까요?",
    buttons: ["설치 페이지 열기", "취소"],
    defaultId: 0,
    cancelId: 1,
  });
  if (result.response === 0) await shell.openExternal("https://www.adobe.com/kr/products/premiere.html");
}

function handleProtocol(raw: string): void {
  let url: URL;
  try { url = new URL(raw); } catch { return; }
  if (url.protocol !== "stepd:") return;
  if (url.hostname === "open") {
    void openPremiere();
    return;
  }
  if (url.hostname !== "app") return;
  if (url.pathname === "/reload") {
    void loadWeb();
  } else if (/^\/[\w./-]*$/.test(url.pathname) && !url.pathname.includes("..")) {
    void loadWeb(url.pathname);
  }
  mainWindow?.show();
  mainWindow?.focus();
}

function protocolArg(argv: string[]): string | undefined {
  return argv.find((arg) => arg.toLowerCase().startsWith("stepd://"));
}

function createWindow(browserSession: Electron.Session): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: "#eceae5",
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      session: browserSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });
  win.removeMenu();
  win.once("ready-to-show", () => {
    if (!process.argv.includes("--background")) win.show();
  });
  // ⚠️ 트레이로 숨긴 창을 다시 열면 **자동 종료 예약을 반드시 푼다.**
  // 이 창은 전송 위젯이 아니라 제품 전체다. 예약이 남아 있으면 사용자가 메타데이터를
  // 편집하는 도중 마지막 업로드가 끝나는 순간 앱이 통째로 꺼지고 입력이 사라진다.
  win.on("show", () => { closeWhenIdle = false; });
  win.on("close", (event) => {
    if (!quitting && engine?.hasUnfinishedJobs()) {
      event.preventDefault();
      closeWhenIdle = true;
      win.hide();
      new Notification({
        title: "STEP-D 전송 계속 중",
        body: "창을 닫아도 업로드를 계속합니다. 완료되면 자동으로 종료합니다.",
      }).show();
    }
  });
  const guardNavigation = (event: { preventDefault(): void }, destination: string) => {
    if (destination.startsWith("stepd://")) {
      event.preventDefault();
      handleProtocol(destination);
      return;
    }
    try {
      if (new URL(destination).origin === trustedOrigin()) return;
    } catch { /* handled below */ }
    event.preventDefault();
    if (allowedExternal(destination)) void shell.openExternal(destination);
  };
  win.webContents.on("will-navigate", guardNavigation);
  win.webContents.on("will-redirect", guardNavigation);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (allowedExternal(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  void win.loadURL(webUrl()).catch(async (error) => {
    console.error("[native] STEP-D 웹 로드 실패", error);
    if (!win.isDestroyed()) await win.loadFile(offlinePath());
  });
  return win;
}

function createTray(): void {
  const image = nativeImage.createFromPath(iconPath()).resize({ width: 20, height: 20 });
  tray = new Tray(image);
  tray.setToolTip("STEP-D");
  tray.on("double-click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  rebuildTrayMenu();
}

function rebuildTrayMenu(): void {
  if (!tray || !engine) return;
  const jobs = engine.list();
  const active = jobs.filter((job) => ["queued", "initializing", "uploading", "finalizing"].includes(job.status));
  const paused = jobs.filter((job) => job.status === "paused");
  tray.setToolTip(active.length ? `STEP-D · 전송 ${active.length}건` : "STEP-D");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "STEP-D 열기", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: "separator" },
    {
      label: "모든 전송 일시정지",
      enabled: active.length > 0,
      click: () => void Promise.all(active.map((job) => engine!.pause(job.id))),
    },
    {
      label: "모든 전송 재개",
      enabled: paused.length > 0,
      click: () => void Promise.all(paused.map((job) => engine!.resume(job.id))),
    },
    { type: "separator" },
    { label: "완전 종료", click: () => { quitting = true; app.quit(); } },
  ]));
}

function syncLoginItem(): void {
  if (!engine) return;
  const enabled = engine.hasUnfinishedJobs();
  if (enabled === loginItemEnabled) return;
  loginItemEnabled = enabled;
  app.setLoginItemSettings({ openAtLogin: enabled, args: enabled ? ["--background"] : [] });
}

function handleJobChanges(jobs: NativeUploadJob[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("native:upload:changed", jobs);
  rebuildTrayMenu();
  syncLoginItem();
  for (const job of jobs) {
    const previous = previousStates.get(job.id);
    if (previous && previous !== job.status && job.status === "completed") {
      new Notification({ title: "STEP-D 업로드 완료", body: `${job.filename} 전송과 등록이 끝났습니다.` }).show();
    } else if (previous && previous !== job.status && ["failed", "needs_attention"].includes(job.status)) {
      new Notification({ title: "STEP-D 전송 확인 필요", body: job.errorMessage ?? `${job.filename} 전송을 확인해 주세요.` }).show();
    }
  }
  previousStates = new Map(jobs.map((job) => [job.id, job.status]));
  if (closeWhenIdle && engine && !engine.hasUnfinishedJobs()) {
    closeWhenIdle = false;
    new Notification({ title: "STEP-D 전송 완료", body: "대기 중인 전송을 모두 마쳐 앱을 종료합니다." }).show();
    quitting = true;
    app.quit();
  }
}

function registerIpc(): void {
  ipcMain.handle("native:upload:list", (event) => {
    assertTrusted(event);
    return engine!.list();
  });
  ipcMain.handle("native:upload:enqueue", async (event, input: unknown) => {
    assertTrusted(event);
    const value = input as { filePath?: unknown; request?: unknown };
    const validated = validateUploadInput(value?.filePath, value?.request);
    return { jobId: await engine!.enqueue(validated.filePath, validated.request) };
  });
  for (const [channel, action] of [
    ["pause", (id: string) => engine!.pause(id)],
    ["resume", (id: string) => engine!.resume(id)],
    ["cancel", (id: string) => engine!.cancel(id)],
    ["retry", (id: string) => engine!.retry(id)],
  ] as const) {
    ipcMain.handle(`native:upload:${channel}`, (event, rawId: unknown) => {
      assertTrusted(event);
      return action(validateJobId(rawId));
    });
  }
  ipcMain.handle("native:upload:relink", async (event, input: unknown) => {
    assertTrusted(event);
    const value = input as { jobId?: unknown; filePath?: unknown };
    const id = validateJobId(value?.jobId);
    if (typeof value?.filePath !== "string") throw new Error("파일을 다시 선택해 주세요.");
    return engine!.relink(id, validateVideoPath(value.filePath));
  });
  ipcMain.handle("native:upload:clear-completed", (event) => {
    assertTrusted(event);
    return engine!.clearCompleted();
  });
}

app.on("second-instance", (_event, argv) => {
  const deepLink = protocolArg(argv);
  if (deepLink) handleProtocol(deepLink);
  else {
    mainWindow?.show();
    mainWindow?.focus();
  }
});

app.on("before-quit", (event) => {
  if (shutdownComplete || !engine) return;
  event.preventDefault();
  quitting = true;
  void engine.shutdown().finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (!engine?.hasUnfinishedJobs()) app.quit();
});

void app.whenReady().then(async () => {
  if (process.platform !== "win32") {
    dialog.showErrorBox("STEP-D", "현재 데스크톱 앱은 Windows 10/11만 지원합니다.");
    app.quit();
    return;
  }
  app.setAppUserModelId("kr.stepai.stepd");
  if (app.isPackaged) app.setAsDefaultProtocolClient("stepd");

  const browserSession = session.fromPartition(PARTITION, { cache: true });
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);

  const store = new JobStore(path.join(app.getPath("userData"), "transfer-queue"), new DpapiCodec());
  engine = new TransferEngine(store, new ElectronTransferNetwork(browserSession, apiBase()));
  await engine.init();
  engine.subscribe(handleJobChanges);
  registerIpc();
  mainWindow = createWindow(browserSession);
  createTray();

  browserSession.cookies.on("changed", (_event, cookie, cause, removed) => {
    if (cookie.name === "stepd_session" && !removed && cause !== "expired") {
      void engine?.retryRecoverable(["AUTH_REQUIRED"]);
    }
  });
  // finalize 도 자동 복구 대상이다 — 프록시 502·콜드스타트 5xx 는 시간이 해결한다.
  powerMonitor.on("resume", () => void engine?.retryRecoverable(["NETWORK", "FINALIZE"]));
  // ⚠️ **온라인이라고 무조건 다시 큐에 넣으면 재시도 상한(6회)이 무력화된다.**
  // 15초마다 되살리면 영구 실패가 영원히 hot-loop 하고, 그 자체가 서버 부하이자
  // 사용자에게는 "계속 실패 토스트가 뜨는" 상태가 된다. 온라인으로 **바뀐 순간**에만 한 번 민다.
  let wasOnline = net.isOnline();
  networkTimer = setInterval(() => {
    const online = net.isOnline();
    if (online && !wasOnline) void engine?.retryRecoverable(["NETWORK", "FINALIZE"]);
    wasOnline = online;
  }, 15_000);
  networkTimer.unref();

  const initialDeepLink = protocolArg(process.argv);
  if (initialDeepLink) handleProtocol(initialDeepLink);
});
