/**
 * 자동 업데이트 — **언제 갈아끼워도 되나.**
 *
 * ## 이 기능의 위험은 "업데이트가 안 되는 것" 이 아니다
 *
 * 안 되면 편집자가 예전 버전을 쓸 뿐이고, 지금까지 계속 그래 왔다. 위험한 건
 * **하던 일 위에 덮어쓰는 것**이다. 설치는 앱을 종료시키므로:
 *
 *   · 전송 중이면 → 끊긴다. 다행히 큐가 영속이라 다시 켜면 이어받는다(그게 이 앱의 존재 이유다)
 *   · **굽는 중이면 → 통째로 날아간다.** 50~90초짜리 CPU 작업이고 이어받을 수 없다
 *
 * 그래서 판정을 여기 순수 함수로 뺐다. 이 파일은 Electron 도 electron-updater 도 모른다 —
 * 그래야 "굽는 중에 설치하지 않는다" 를 실제 업데이트 없이 테스트로 증명할 수 있다.
 *
 * ## 사용자가 눌러도 안 되는 경우가 있다
 *
 * 보통은 사용자 의사가 이긴다. 전송은 이어받으므로 눌렀으면 재시작한다. 하지만 **렌더는
 * 사용자가 눌러도 막는다** — 90초 뒤에 자동으로 재시작해 줄 수 있는데 지금 날릴 이유가 없다.
 * 대신 그 사실을 말해 준다("굽는 중입니다 — 끝나면 바로 재시작합니다").
 */

/** electron-updater 의 진행 상태를 우리 말로 좁힌 것. */
export type UpdateStage =
  | "idle"          // 아직 확인 전이거나, 확인했는데 최신이었다
  | "checking"
  | "available"     // 새 버전이 있다 (아직 안 받았다)
  | "downloading"
  | "ready"         // 다 받았다 — 재시작만 하면 갈아끼워진다
  | "error";

export interface UpdateState {
  stage: UpdateStage;
  /** 지금 깔린 버전. */
  currentVersion: string;
  /** 받아 둔/받을 수 있는 새 버전. 없으면 null. */
  newVersion: string | null;
  /** 0~1. downloading 일 때만 의미가 있다. */
  progress: number;
  /** 사람이 읽을 사유 — 오류이거나, 왜 아직 재시작 안 하는지. */
  message: string | null;
  /** 마지막으로 확인한 시각(ms). 한 번도 안 했으면 0. */
  lastCheckedAt: number;
}

export const IDLE_STATE: UpdateState = {
  stage: "idle", currentVersion: "0.0.0", newVersion: null,
  progress: 0, message: null, lastCheckedAt: 0,
};

/** 확인 주기 — 6시간. 편집자는 앱을 며칠씩 켜 두므로 기동 시 한 번으로는 부족하다. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * **안정 버전인가.**
 *
 * `1.2.3` 만 안정이다. `1.2.3-beta.1` · `1.2.3-rc1` 처럼 하이픈 뒤가 붙은 건 아니다.
 * 발행 스크립트가 이미 한 번 거르지만 앱도 본다 — 실수로 프리릴리스가 피드에 올라간 날,
 * 그게 **모든 편집자 PC 로 자동 배포되는** 것을 한쪽 실수로 만들지 않으려고.
 */
export function isStableVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(String(v ?? "").trim());
}

/** `a` 가 `b` 보다 높은 버전인가. 안정 버전끼리만 비교한다(프리릴리스는 애초에 안 받는다). */
export function isNewerVersion(a: string, b: string): boolean {
  const parse = (v: string) => String(v ?? "").trim().split(".").map((n) => Number(n) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** 이번 후보를 받을 것인가 — 안정 버전이고, 지금 것보다 높을 때만. */
export function shouldAccept(candidate: string, current: string): boolean {
  return isStableVersion(candidate) && isNewerVersion(candidate, current);
}

/** 지금 확인할 때가 됐나. */
export function shouldCheck(nowMs: number, lastCheckedAt: number, intervalMs = CHECK_INTERVAL_MS): boolean {
  if (!lastCheckedAt) return true;
  // 시계가 뒤로 간 경우(시간대 변경·수면 복귀)도 "확인할 때" 로 본다 — 안 그러면
  // lastCheckedAt 이 미래에 박혀 다시는 확인하지 않는다.
  return nowMs < lastCheckedAt || nowMs - lastCheckedAt >= intervalMs;
}

export interface BusyState {
  /** 미완료 전송이 있나 (engine.hasUnfinishedJobs). */
  transfers: boolean;
  /** 이 PC 가 지금 굽고 있나. */
  rendering: boolean;
}

export type InstallDecision =
  | { install: true; reason: "user" | "idle" }
  | { install: false; reason: "not_ready" | "rendering" | "transfers"; message: string };

/**
 * 지금 갈아끼울까.
 *
 * @param userAsked 사용자가 "지금 재시작" 을 직접 눌렀나. 눌렀으면 전송은 무시한다
 *                  (끊겨도 이어받는다). **렌더는 눌러도 안 무시한다.**
 */
export function installDecision(
  stage: UpdateStage, busy: BusyState, userAsked: boolean,
): InstallDecision {
  if (stage !== "ready") {
    return { install: false, reason: "not_ready", message: "아직 받는 중입니다." };
  }
  // 렌더가 먼저다 — 이어받을 수 없는 유일한 작업이라 사용자 의사보다 우선한다.
  if (busy.rendering) {
    return { install: false, reason: "rendering",
             message: "영상을 굽는 중입니다 — 끝나면 바로 재시작합니다." };
  }
  if (userAsked) return { install: true, reason: "user" };
  if (busy.transfers) {
    return { install: false, reason: "transfers",
             message: "전송이 끝나면 재시작합니다. 지금 재시작해도 이어받습니다." };
  }
  return { install: true, reason: "idle" };
}

/** 화면에 그대로 쓰는 한 줄. 상태마다 다른 문구를 화면에서 조립하지 않게 여기서 만든다. */
export function statusLine(s: UpdateState): string {
  switch (s.stage) {
    case "checking": return "새 버전을 확인하고 있습니다…";
    case "available": return `새 버전 ${s.newVersion} 이 있습니다.`;
    case "downloading": return `새 버전 ${s.newVersion} 을 받는 중 ${Math.round(s.progress * 100)}%`;
    case "ready": return `새 버전 ${s.newVersion} 준비됨 — 재시작하면 적용됩니다.`;
    case "error": return s.message ?? "업데이트를 확인하지 못했습니다.";
    default: return `최신 버전입니다 (${s.currentVersion}).`;
  }
}
