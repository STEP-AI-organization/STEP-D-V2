/**
 * 관리형 작업 공간 — **순수 판정부.** fs 도 Electron 도 모른다.
 *
 * ## 왜 순수한가
 *
 * 여기서 잘못 판단하면 **작업 공간 밖의 파일을 안에 있다고 착각**하거나, 반대로 멀쩡한
 * 파일을 거절한다. 앞은 이 설계 전체가 무의미해지는 것이고 뒤는 편집자가 일을 못 하는 것이다.
 * 둘 다 실제 디스크를 만들지 않고도 검증할 수 있어야 한다(`workspace-policy.test.ts`).
 *
 * 실제 fs 접근(realpath·복사·rename)은 `import.ts` 가 맡는다. 갈라 두는 이유는
 * `apps/server/src/pipeline/harvest.ts` 와 같다 — 판정을 확인하는 데 부수효과가 들면
 * 아무도 확인하지 않는다.
 */
import path from "node:path";

/** 표준 폴더. 순서가 곧 화면 표시 순서다. */
export const WORKSPACE_FOLDERS = ["source", "proxy", "project", "export", "delivery"] as const;
export type WorkspaceFolder = (typeof WORKSPACE_FOLDERS)[number];

/** 작업 공간 루트의 기본 이름. 정책이 없을 때 쓴다. */
export const DEFAULT_WORKSPACE_DIR = "STEP-D Workspace";

/**
 * 서버가 주는 회사별 정책. 4단계에서 API 를 붙이기 전까지는 기본값으로 돈다 —
 * 그래서 지금도 이 모양을 그대로 쓴다(나중에 출처만 바뀐다).
 */
export interface WorkspacePolicy {
  /** 정책이 바뀌면 올라간다. 앱은 이 값이 달라졌을 때만 폴더를 다시 만든다. */
  version: number;
  /** 루트 폴더 이름(사용자 프로필 기준). 절대경로를 서버가 주지 않는 이유는 PC 마다 다르기 때문. */
  rootDirName: string;
  folders: readonly WorkspaceFolder[];
  /** 허용 확장자(소문자·점 포함). 비면 `mime.ts` 의 영상 목록을 쓴다. */
  allowedExtensions: readonly string[];
  /** 작업 공간 밖 파일을 자동으로 복사해 들일지. false 면 사람이 직접 옮겨야 한다. */
  autoImportExternal: boolean;
}

export const DEFAULT_POLICY: WorkspacePolicy = {
  version: 1,
  rootDirName: DEFAULT_WORKSPACE_DIR,
  folders: WORKSPACE_FOLDERS,
  allowedExtensions: [],
  autoImportExternal: true,
};

// ── 파일·폴더 이름 ───────────────────────────────────────────────────────────

/**
 * Windows 예약 이름. 확장자가 붙어도 예약이다(`CON.mp4` 도 못 만든다).
 * 이걸 모르고 폴더를 만들면 프로그램 이름이 "NUL" 인 회사에서 앱이 통째로 막힌다.
 */
const RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/** Windows 가 파일명에 못 쓰는 문자. `/` 도 넣는다 — 경로 조각으로 새는 걸 막는다. */
const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/g;

/**
 * 한 조각(프로그램명·회차명·파일명)을 **경로에 쓸 수 있는 이름**으로 바꾼다.
 *
 * ⚠️ **NFC 정규화가 먼저다.** macOS 를 거친 한글 파일명은 자모가 분리(NFD)돼 온다 —
 * 같은 "회차1" 이 바이트로는 달라서, 정규화 없이 비교하면 같은 회차가 폴더 두 개가 된다.
 *
 * 빈 문자열은 만들지 않는다. 전부 걸러지면 `fallback` 을 쓴다 — 이름 없는 폴더를 만들면
 * 그 뒤 경로 조립이 조용히 어긋난다.
 */
export function safeSegment(raw: string, fallback = "무제"): string {
  const nfc = String(raw ?? "").normalize("NFC");
  let s = nfc.replace(FORBIDDEN, " ").replace(/\s+/g, " ").trim();
  // 후행 점·공백은 Windows 가 조용히 잘라낸다 — 우리가 먼저 자른다(안 그러면
  // 만든 이름과 실제 이름이 달라져 다음 조회가 못 찾는다).
  s = s.replace(/[. ]+$/, "");
  // 점만 남은 이름(`.` `..` `...`)은 이름이 아니다. 구분자를 이미 걷어냈으니 경로 이동은
  // 안 되지만, 폴더 이름이 ".." 인 것은 사람도 OS 도 헷갈린다.
  if (/^\.+$/.test(s)) return fallback;
  if (!s) return fallback;
  // 예약어는 확장자를 떼고 본다. `CON.mp4` 도 못 만든다.
  const stem = s.split(".")[0].toUpperCase();
  if (RESERVED.has(stem)) s = `_${s}`;
  return s;
}

/**
 * Windows 기본 경로 상한. 긴 경로 옵션(LongPathsEnabled)이 꺼진 PC 가 흔해서
 * **켜져 있다고 가정하지 않는다.** 넘치면 조용히 자르지 않고 거절한다 —
 * 잘라서 만들면 서로 다른 회차가 같은 폴더로 합쳐진다.
 */
export const MAX_PATH = 260;

/** 경로 조각을 이 길이로 자른다. 회차·프로그램 이름이 길어도 상한 안에 들어오게. */
export const MAX_SEGMENT = 60;

export function clampSegment(raw: string, max = MAX_SEGMENT): string {
  const s = safeSegment(raw);
  return s.length <= max ? s : s.slice(0, max).replace(/[. ]+$/, "");
}

// ── 경로 해석 ────────────────────────────────────────────────────────────────

export interface TargetRef {
  program: string;
  episode?: string;
  folder: WorkspaceFolder;
}

/**
 * 작업 공간 루트 + 대상 → **폴더 절대경로**. 파일명은 붙이지 않는다.
 *
 * 회차가 없으면 프로그램 바로 아래에 폴더를 둔다(회차가 아직 안 정해진 소재).
 */
export function resolveFolder(root: string, target: TargetRef): string {
  const parts = [root, clampSegment(target.program)];
  if (target.episode != null && String(target.episode).trim()) {
    parts.push(clampSegment(target.episode));
  }
  parts.push(target.folder);
  return path.join(...parts);
}

/** 경로가 상한을 넘는지 — 넘으면 사람이 읽을 수 있는 사유를 준다. */
export function pathTooLong(fullPath: string, max = MAX_PATH): boolean {
  return fullPath.length > max;
}

// ── 루트 안인가 ──────────────────────────────────────────────────────────────

/**
 * `child` 가 `root` **안**인가. 둘 다 **이미 realpath 로 정규화된** 절대경로여야 한다.
 *
 * ⚠️ 이 함수만으로는 심볼릭 링크·정션을 못 막는다. 그건 `import.ts` 가 `fs.realpath` 로
 * 풀어서 넣는 몫이다 — 여기는 **문자열 비교의 함정**만 책임진다:
 *
 *   · `C:\WS-evil` 이 `C:\WS` 의 하위로 읽히면 안 된다 (구분자까지 봐야 한다)
 *   · Windows 는 대소문자를 안 가린다 (`C:\ws` == `C:\WS`)
 *   · 같은 경로 자신은 "안" 이 아니다 (루트에 파일을 바로 두지 않는다)
 */
export function isInsideRoot(root: string, child: string, caseInsensitive = process.platform === "win32"): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return caseInsensitive ? r.toLowerCase() : r;
  };
  const r = norm(root);
  const c = norm(child);
  if (c === r) return false;
  // 구분자를 붙여 비교한다 — 안 붙이면 "C:\WS-evil" 이 "C:\WS" 로 시작해 통과한다.
  return c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** 허용 확장자인가. 정책이 비어 있으면 판정하지 않는다(호출부가 영상 목록을 본다). */
export function extensionAllowed(policy: WorkspacePolicy, filePath: string): boolean {
  if (!policy.allowedExtensions.length) return true;
  return policy.allowedExtensions.includes(path.extname(filePath).toLowerCase());
}
