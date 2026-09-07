/**
 * 자동 업데이트 배선 — electron-updater 를 우리 판정에 묶는다.
 *
 * ## 왜 electron-updater 를 그대로 안 쓰나
 *
 * 기본값이 이 앱과 안 맞는다. `autoDownload` 는 켜져 있고 `autoInstallOnAppQuit` 도 켜져
 * 있는데, 이 앱은 **트레이에 상주하며 며칠씩 안 꺼진다.** 종료 시 설치는 영영 안 온다.
 * 그리고 종료가 오는 순간이 하필 **전송·렌더가 끝나 앱이 스스로 꺼지는 때**라서, 그대로
 * 두면 가장 바쁜 순간에 설치가 걸린다.
 *
 * 그래서 다운로드만 맡기고 **설치 시점은 우리가 정한다**(`policy.ts` · 순수 함수).
 *
 * ## 피드
 *
 * `https://stepd.stepai.kr/api/desktop` — 서버가 서명 URL 로 302 한다. 같은 리포의
 * `/api/naver/login-tool` 과 같은 구조다: 버킷은 비공개로 두고(공개 객체 금지 정책),
 * **큰 파일은 Cloud Run 을 안 지난다**(302 라 바이트는 GCS→편집자 PC 직행).
 */
import { app } from "electron";
import { autoUpdater } from "electron-updater";

import {
  type BusyState, type UpdateStage, type UpdateState,
  IDLE_STATE, installDecision, shouldAccept, shouldCheck,
} from "./policy.js";

export interface UpdaterDeps {
  /** 지금 바쁜가 — 부르는 쪽(main.ts)이 전송 엔진·렌더 상태를 안다. */
  busy(): BusyState;
  /** 상태가 바뀌면 알린다(창·트레이 갱신). */
  onChange(state: UpdateState): void;
}

/** 업데이트 피드. 개발 중엔 `STEPD_UPDATE_URL` 로 다른 데를 보게 할 수 있다. */
function feedUrl(): string {
  const override = (process.env.STEPD_UPDATE_URL ?? "").trim();
  return override || "https://stepd.stepai.kr/api/desktop";
}

export class Updater {
  private state: UpdateState;
  private deps: UpdaterDeps;
  private timer: NodeJS.Timeout | null = null;
  /** 사용자가 "지금 재시작" 을 눌렀나. 눌러 두면 바쁜 게 풀리는 즉시 깐다. */
  private userAsked = false;
  private installing = false;

  constructor(deps: UpdaterDeps, currentVersion = app.getVersion()) {
    this.deps = deps;
    this.state = { ...IDLE_STATE, currentVersion };
  }

  get snapshot(): UpdateState { return { ...this.state }; }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.deps.onChange(this.snapshot);
  }

  private stage(stage: UpdateStage, patch: Partial<UpdateState> = {}): void {
    this.set({ stage, ...patch });
  }

  start(): void {
    // ⚠️ 개발 중(패키징 안 된 상태)에는 아예 켜지 않는다. electron-updater 가
    //    dev-app-update.yml 을 찾다가 요란하게 실패하고, 로그가 진짜 오류를 덮는다.
    if (!app.isPackaged) return;

    autoUpdater.autoDownload = true;
    // **여기가 핵심.** 종료 시 자동 설치를 끈다 — 이 앱의 종료는 "전송을 다 마쳐서"
    // 오는 경우가 많고, 그 순간에 설치가 걸리면 하필 제일 바쁜 때를 고른 셈이 된다.
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.setFeedURL({ provider: "generic", url: feedUrl() });

    autoUpdater.on("checking-for-update", () => this.stage("checking"));
    autoUpdater.on("update-available", (info) => {
      // electron-updater 도 버전을 보지만 한 번 더 본다 — 프리릴리스가 실수로 피드에
      // 올라간 날, 그게 전 편집자 PC 로 자동 배포되는 걸 한쪽 실수로 만들지 않는다.
      if (!shouldAccept(String(info.version), this.state.currentVersion)) {
        this.stage("idle", { newVersion: null, message: null });
        return;
      }
      this.stage("available", { newVersion: String(info.version), progress: 0, message: null });
    });
    autoUpdater.on("update-not-available", () => this.stage("idle", { newVersion: null, message: null }));
    autoUpdater.on("download-progress", (p) => {
      this.stage("downloading", { progress: Math.max(0, Math.min(1, (p.percent ?? 0) / 100)) });
    });
    autoUpdater.on("update-downloaded", (info) => {
      this.stage("ready", { newVersion: String(info.version), progress: 1, message: null });
      this.maybeInstall();          // 지금 놀고 있으면 바로 간다
    });
    autoUpdater.on("error", (err) => {
      // 업데이트 실패는 **조용해야 한다.** 앱은 멀쩡히 돌아가고, 편집자가 할 수 있는 일도
      // 없다. 화면에는 남기되 알림은 띄우지 않는다.
      this.stage("error", { message: String(err?.message ?? err).slice(0, 200) });
    });

    void this.check();
    // 편집자는 앱을 며칠씩 켜 둔다 — 기동 시 한 번으로는 새 버전을 영영 못 본다.
    this.timer = setInterval(() => void this.check(), 60 * 60 * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** 확인할 때가 됐으면 확인한다. `force` 면 주기를 무시한다(사용자가 눌렀을 때). */
  async check(force = false): Promise<void> {
    if (!app.isPackaged) return;
    if (!force && !shouldCheck(Date.now(), this.state.lastCheckedAt)) return;
    this.set({ lastCheckedAt: Date.now() });
    try { await autoUpdater.checkForUpdates(); }
    catch (e) { this.stage("error", { message: String((e as Error)?.message ?? e).slice(0, 200) }); }
  }

  /**
   * 사용자가 "지금 재시작" 을 눌렀다. 지금 못 깔면 **예약**된다 — 바쁜 게 풀리는 즉시
   * 깔린다. 눌렀는데 아무 일도 안 일어나면 버튼이 고장 난 것처럼 보이므로, 못 깔 땐
   * 사유를 상태에 남긴다.
   */
  requestInstall(): UpdateState {
    this.userAsked = true;
    this.maybeInstall();
    return this.snapshot;
  }

  /**
   * 바쁜 상태가 바뀔 때마다 부른다(전송 완료·렌더 종료). 예약해 둔 설치가 있으면
   * 여기서 걸린다 — "굽는 중이라 못 깝니다" 뒤에 자동으로 재시작되는 경로가 이것이다.
   */
  onBusyChanged(): void { this.maybeInstall(); }

  private maybeInstall(): void {
    if (this.installing) return;
    const d = installDecision(this.state.stage, this.deps.busy(), this.userAsked);
    if (!d.install) {
      // 사용자가 눌렀을 때만 사유를 화면에 띄운다 — 안 누른 사람에게는 소음이다.
      if (this.userAsked && this.state.stage === "ready") this.set({ message: d.message });
      return;
    }
    this.installing = true;
    this.set({ message: "재시작합니다…" });
    // isSilent=true, isForceRunAfter=true — 편집자가 설치 마법사를 보지 않고,
    // 설치 뒤 앱이 스스로 다시 뜬다. 트레이 앱이라 "꺼진 채로 남는" 게 제일 나쁘다.
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
  }
}
