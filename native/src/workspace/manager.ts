/**
 * 관리형 작업 공간 — **배선부.** 실제 디스크를 만진다(판정은 `policy.ts`).
 *
 * ## 이 파일이 지키는 것 셋
 *
 *  1. **작업 공간 밖은 안 받는다.** 판정은 `fs.realpath` 로 링크·정션을 푼 뒤에 한다 —
 *     문자열 비교만으로는 `mklink /J` 한 줄에 뚫린다.
 *  2. **불완전한 파일을 남기지 않는다.** 같은 볼륨의 임시 파일로 복사하고, 지문을 대조한
 *     뒤에야 정식 이름을 준다. 중간에 앱이 죽어도 정식 이름 파일은 안 생긴다.
 *  3. **원본을 안 건드린다.** 복사만 한다 — 편집자의 다운로드 폴더에서 파일이 사라지면
 *     그건 우리가 잃어버린 것으로 보인다.
 *
 * ⚠️ **여기 있는 검사는 메인 프로세스에서만 의미가 있다.** `preload.ts` 에서 부르면
 *    렌더러가 IPC 를 직접 쳐서 우회한다 — 설계 문서의 "신뢰 경계" 절 참조.
 */
import { constants, type Dirent } from "node:fs";
import {
  access, copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat, statfs, writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fingerprintFile, fingerprintsMatch, type FileFingerprint } from "../transfer/fingerprint.js";
import {
  DEFAULT_POLICY, MIN_WORKSPACE_FREE_BYTES, clampSegment, isInsideRoot, pathTooLong,
  pickWorkspaceDrive, resolveFolder,
  type DriveInfo, type TargetRef, type WorkspacePolicy,
} from "./policy.js";

/** 복사 중인 파일이 사는 곳. 이름으로 알아볼 수 있어야 기동 시 청소가 된다. */
const TMP_DIR = ".stepd-tmp";

/** 앱이 고른 자리를 적어 두는 파일. 사용자 프로필에 둔다(몇 바이트다). */
const CHOICE_FILE = path.join(".stepd", "workspace.json");

/**
 * 고정 디스크 목록. **PowerShell 로 종류까지 본다**(`DriveType=3` = 로컬 고정 디스크).
 *
 * 드라이브 문자를 A~Z 훑는 방법도 있지만 그러면 **USB·네트워크 드라이브가 섞인다** —
 * 거기에 작업 공간을 만들면 뽑는 순간 회차가 통째로 사라지고, 네트워크면 렌더가 기어간다.
 * 종류를 정확히 가르는 값이 필요해서 한 번의 PowerShell 호출을 감수한다(기동 시 1회).
 *
 * 실패하면 빈 배열 — 부르는 쪽이 홈으로 떨어진다. 조회 실패로 앱이 안 뜨면 안 된다.
 */
export async function listFixedDrives(): Promise<DriveInfo[]> {
  if (process.platform !== "win32") return [];
  try {
    const { execFile } = await import("node:child_process");
    const out = await new Promise<string>((resolve, reject) => {
      execFile("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'"
        + " | Select-Object DeviceID,FreeSpace,Size | ConvertTo-Json -Compress",
      ], { timeout: 10_000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    const raw = JSON.parse(out.trim() || "[]");
    const rows = Array.isArray(raw) ? raw : [raw];
    return rows
      .filter((r) => r && typeof r.DeviceID === "string")
      .map((r) => ({
        // `C:` → `C:\` — 루트 경로 꼴로 맞춘다(path.join 이 뒤를 이어 붙인다).
        root: path.join(String(r.DeviceID), path.sep),
        freeBytes: Number(r.FreeSpace ?? 0),
        totalBytes: Number(r.Size ?? 0),
      }))
      // 드라이브 문자 순 — 동률일 때 실행마다 자리가 바뀌지 않게(pickWorkspaceDrive 주석).
      .sort((a, b) => a.root.localeCompare(b.root));
  } catch {
    return [];
  }
}

export interface WorkspaceInfo {
  rootPath: string;
  ready: boolean;
  policyVersion: number;
  folders: string[];
}

export interface ImportResult {
  managedPath: string;
  filename: string;
  size: number;
  /** 이미 같은 파일이 있어서 복사를 건너뛰었나. */
  reused: boolean;
}

export class WorkspaceManager {
  private policy: WorkspacePolicy;
  private readonly rootBase: string;
  /** realpath 로 푼 루트. 판정의 기준점이라 한 번만 구해 캐시한다. */
  private realRoot: string | null = null;
  /** 고른(또는 기억한) 콘텐츠 디스크. null 이면 아직 안 골랐다 = 홈. */
  private chosenBase: string | null = null;
  /** 드라이브 조회 — 테스트가 갈아끼운다(실제 PowerShell 을 안 부르게). */
  private readonly drives: () => Promise<DriveInfo[]>;

  constructor(
    policy: WorkspacePolicy = DEFAULT_POLICY,
    homeDir = os.homedir(),
    drives: () => Promise<DriveInfo[]> = listFixedDrives,
  ) {
    this.policy = policy;
    this.rootBase = homeDir;
    this.drives = drives;
  }

  /** 루트 절대경로(아직 안 만들어졌을 수도 있다). */
  get rootPath(): string {
    return path.join(this.chosenBase ?? this.rootBase, this.policy.rootDirName);
  }

  /**
   * 콘텐츠를 둘 자리를 정한다. **한 번 정하면 기억한다.**
   *
   * ## 왜 기억하나
   *
   * 자리를 매번 다시 고르면, 나중에 더 큰 디스크를 꽂았을 때 작업 공간이 통째로 옮겨진
   * 것처럼 보인다 — 그런데 전송 큐는 **절대경로**를 들고 있어서(job-store) 전부 죽는다.
   * 편집자가 보기엔 "어제 올리던 게 다 사라졌다" 다. 그래서 첫 판단만 하고 적어 둔다.
   *
   * ## 순서
   *   1. env(`STEPD_WORKSPACE_ROOT`) — 사람이 정했으면 그게 이긴다
   *   2. 적어 둔 자리 — 있으면 그대로
   *   3. **여유가 가장 큰 고정 디스크** — 앱은 C: 에 깔리지만 영상은 아니다.
   *      실측(2026-09-07): C: 여유 72GB · D: 여유 3,678GB. 홈에 두면 회차 몇 개로
   *      시스템 디스크가 차고, 그러면 앱이 아니라 PC 가 망가진다.
   *   4. 아무것도 기준(50GB)을 못 넘으면 홈 — 그 사실은 화면이 말한다
   */
  async chooseBase(): Promise<{ base: string; reason: "env" | "remembered" | "drive" | "home" }> {
    const fromEnv = (process.env.STEPD_WORKSPACE_ROOT ?? "").trim();
    if (fromEnv) { this.chosenBase = fromEnv; return { base: fromEnv, reason: "env" }; }

    const memo = path.join(this.rootBase, CHOICE_FILE);
    try {
      const saved = JSON.parse(await readFile(memo, "utf8")) as { base?: string };
      if (saved?.base && typeof saved.base === "string") {
        this.chosenBase = saved.base;
        return { base: saved.base, reason: "remembered" };
      }
    } catch { /* 없으면 처음이다 */ }

    const best = pickWorkspaceDrive(await this.drives());
    const base = best?.root ?? this.rootBase;
    this.chosenBase = base;
    // 적어 둔다. 실패해도 계속 간다 — 다음 기동에 다시 고르면 되고, 그 사이 동작은 같다.
    try {
      await mkdir(path.dirname(memo), { recursive: true });
      await writeFile(memo, JSON.stringify({ base, chosenAt: new Date().toISOString() }, null, 2), "utf8");
    } catch { /* 기록 실패는 치명적이지 않다 */ }
    return { base, reason: best ? "drive" : "home" };
  }

  /**
   * 정책 교체. 4단계에서 서버가 준 것으로 갈아끼운다.
   * 루트 이름이 바뀌면 캐시한 realpath 를 버린다 — 안 그러면 옛 루트로 판정한다.
   */
  setPolicy(next: WorkspacePolicy): void {
    const rootChanged = next.rootDirName !== this.policy.rootDirName;
    this.policy = next;
    if (rootChanged) this.realRoot = null;
  }

  /**
   * 루트와 표준 폴더를 만든다. 이미 있으면 아무 일도 안 한다.
   *
   * 프로그램·회차 폴더는 **여기서 안 만든다** — 들여올 때 필요한 것만 만든다.
   * 미리 다 만들면 안 쓰는 빈 폴더가 회차 수만큼 쌓인다.
   */
  async ensureRoot(): Promise<WorkspaceInfo> {
    if (!this.chosenBase) await this.chooseBase();
    const root = this.rootPath;
    await mkdir(root, { recursive: true });
    this.realRoot = await realpath(root);
    await this.cleanupTemp(this.realRoot);
    return {
      rootPath: this.realRoot,
      ready: true,
      policyVersion: this.policy.version,
      folders: [...this.policy.folders],
    };
  }

  async info(): Promise<WorkspaceInfo> {
    try {
      const real = await realpath(this.rootPath);
      this.realRoot = real;
      return { rootPath: real, ready: true, policyVersion: this.policy.version, folders: [...this.policy.folders] };
    } catch {
      // 아직 안 만들어졌다 — 없는 것도 사실이라 그대로 알린다(만들지 않는다).
      return { rootPath: this.rootPath, ready: false, policyVersion: this.policy.version, folders: [...this.policy.folders] };
    }
  }

  /**
   * 이 경로가 **작업 공간 안**인가.
   *
   * ⚠️ 검사 순서가 중요하다. `realpath` 를 먼저 부르는 이유는 심볼릭 링크·정션·8.3 단축명·
   * `\\?\` 접두사·대소문자를 OS 가 한 번에 풀어 주기 때문이다. 문자열만 비교하면
   * `mklink /J C:\WS\link D:\secret` 한 줄로 뚫린다.
   *
   * ⚠️ **TOCTOU 는 남는다** — 검사 뒤 파일을 링크로 바꿔치기하면 통과한 경로가 밖을
   * 가리킬 수 있다. 완전한 해법은 열어 둔 핸들로만 다루는 것인데 전송 엔진이 경로를
   * 여러 번 다시 열어서 이번 범위 밖이다(설계 문서 "남는 위험" 참조).
   */
  async isManaged(filePath: string): Promise<boolean> {
    let real: string;
    let root: string;
    try {
      real = await realpath(filePath);
      root = this.realRoot ?? (this.realRoot = await realpath(this.rootPath));
    } catch {
      return false;   // 없는 경로거나 루트가 아직 없다 — 관리형이 아니다
    }
    return isInsideRoot(root, real);
  }

  /**
   * 외부 파일을 작업 공간으로 **복사해 들인다.** 원본은 그대로 둔다.
   *
   * 이미 관리형 경로면 복사하지 않고 그대로 돌려준다 — 같은 파일을 두 번 두지 않는다.
   */
  async importFile(filePath: string, target: TargetRef): Promise<ImportResult> {
    const source = await realpath(filePath).catch(() => {
      throw new Error("파일을 찾을 수 없습니다. 경로를 확인해 주세요.");
    });
    const info = await stat(source);
    if (!info.isFile()) throw new Error("선택한 경로가 파일이 아닙니다.");

    await this.ensureRoot();
    const root = this.realRoot!;

    // 이미 안에 있으면 그대로 쓴다.
    if (isInsideRoot(root, source)) {
      return { managedPath: source, filename: path.basename(source), size: info.size, reused: true };
    }
    if (!this.policy.autoImportExternal) {
      throw new Error("작업 공간 밖의 파일은 자동으로 들여오지 않도록 설정돼 있습니다. 파일을 작업 공간으로 옮긴 뒤 다시 선택해 주세요.");
    }

    const dir = resolveFolder(root, target);
    const filename = clampSegment(path.basename(source), 120);
    const dest = path.join(dir, filename);

    // 경로가 상한을 넘으면 **자르지 않고 거절한다.** 잘라서 만들면 서로 다른 회차가
    // 같은 파일명으로 겹친다.
    if (pathTooLong(dest)) {
      throw new Error(`경로가 너무 깁니다(${dest.length}자). 프로그램·회차 이름을 줄여 주세요.`);
    }

    await mkdir(dir, { recursive: true });

    // 같은 파일이 이미 있으면 다시 복사하지 않는다 — 지문으로 본다(같은 이름이라도
    // 내용이 다르면 새로 들인다).
    const sourcePrint = await fingerprintFile(source);
    const existing = await this.matchExisting(dest, sourcePrint);
    if (existing) return { managedPath: dest, filename, size: info.size, reused: true };

    await this.assertFreeSpace(dir, info.size);
    await this.copyAtomic(source, dest, dir, sourcePrint);
    return { managedPath: dest, filename, size: info.size, reused: false };
  }

  /** 같은 자리에 같은 내용의 파일이 이미 있나. */
  private async matchExisting(dest: string, want: FileFingerprint): Promise<boolean> {
    try {
      await access(dest, constants.F_OK);
    } catch {
      return false;
    }
    try {
      // mtime 은 복사하면서 달라진다 — 크기와 표본 해시만 본다.
      const have = await fingerprintFile(dest);
      return have.size === want.size && have.sampleSha256 === want.sampleSha256;
    } catch {
      return false;
    }
  }

  /**
   * **원자적 복사.** 임시 파일 → 지문 대조 → rename.
   *
   * ⚠️ 임시 파일은 **대상 폴더 안**(`.stepd-tmp/`)에 만든다. `%TEMP%` 에 두면 작업 공간이
   * 다른 드라이브일 때 `rename` 이 복사로 바뀌어 원자성이 깨진다 — 그러면 중간에 죽었을 때
   * 정식 이름의 반쪽 파일이 남고, 그게 이 설계의 완료 기준을 정면으로 어긴다.
   */
  private async copyAtomic(source: string, dest: string, dir: string, want: FileFingerprint): Promise<void> {
    const tmpDir = path.join(dir, TMP_DIR);
    await mkdir(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.part`);

    try {
      await copyFile(source, tmp);
      const copied = await fingerprintFile(tmp);
      // 크기·내용이 다르면 복사 중 원본이 바뀐 것이다. 정식 이름을 주지 않는다.
      if (copied.size !== want.size || copied.sampleSha256 !== want.sampleSha256) {
        throw new Error("복사 중 원본 파일이 바뀌었습니다. 다시 시도해 주세요.");
      }
      await rename(tmp, dest);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  /**
   * 복사 **전에** 여유 공간을 본다. 중간에 실패하면 임시 파일과 시간을 함께 버리고,
   * 몇 GB 짜리면 그 시간이 길다. 여유는 파일 크기 + 5% (파일시스템 오버헤드).
   *
   * `statfs` 를 못 쓰는 환경(구 Node·특수 볼륨)에서는 **막지 않는다** — 조회 실패로
   * 업로드를 세우는 건 과하다.
   */
  private async assertFreeSpace(dir: string, size: number): Promise<void> {
    try {
      const fs = await statfs(dir);
      const free = Number(fs.bavail) * Number(fs.bsize);
      const need = size * 1.05;
      if (Number.isFinite(free) && free < need) {
        const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)}GB`;
        throw new Error(`디스크 공간이 부족합니다. 필요 ${gb(need)} · 남은 공간 ${gb(free)}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("디스크 공간이")) throw err;
      // 조회 자체가 안 되는 환경 — 통과시킨다.
    }
  }

  /**
   * 기동 시 남은 임시 파일 청소. 앱이 복사 중에 죽으면 `.stepd-tmp` 에 `.part` 가 남는다.
   * 정식 이름이 아니라 업로드 대상이 될 수 없고, 그냥 두면 디스크만 먹는다.
   */
  private async cleanupTemp(root: string): Promise<number> {
    let removed = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 4) return;   // 루트/프로그램/회차/폴더/.stepd-tmp 까지면 충분하다
      // `Awaited<ReturnType<typeof readdir>>` 로 쓰면 오버로드 중 Buffer 판이 잡힌다 —
      // withFileTypes 를 쓰는 이 호출의 실제 타입만 적는다.
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (!e.isDirectory()) continue;
        if (e.name === TMP_DIR) {
          await rm(full, { recursive: true, force: true }).catch(() => {});
          removed += 1;
          continue;
        }
        await walk(full, depth + 1);
      }
    };
    await walk(root, 0);
    return removed;
  }
}
