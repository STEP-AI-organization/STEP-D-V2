/**
 * 네이버 브라우저 세션(storageState) 보관/복원 — **머신 로컬 파일**.
 *
 * 네이버는 공개 업로드 API 가 없어서 브라우저 자동화가 유일한 경로다. 그런데 **진짜 과제는
 * 자동화가 아니라 세션 유지**다: 해외 데이터센터 IP 로 로그인하면 캡차·2차인증에 막힌다.
 * 그래서 네이버 잡은 Cloud Run 이 아니라 **사무실의 상시 PC 한 대**에서 돌린다
 * (GEBD 를 GPU VM 전용 레인으로 뺀 것과 같은 구조 · WORKER_JOBS=naver).
 *
 * 사람이 그 PC 에서 **최초 1회 수동 로그인**하고
 * (`pnpm --filter @stepd/server naver:login`), 그때 얻은 쿠키+localStorage 를 로컬에 저장해
 * 워커가 복원해 쓴다. 만료되면 다시 사람이 한 번. "전부 자동화"가 아니라 사람 몫을 남긴다.
 *
 * ⚠️ storageState 는 로그인 쿠키 그 자체다 — **자격증명으로 취급할 것.**
 * 클라우드로 올리지 않는다(그게 이 파일이 GCS 를 안 쓰는 이유다). 커밋 금지, 로그 출력 금지.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 세션 파일 경로. 기본값은 사용자 홈 아래 — 리포·스토리지 디렉토리와 떨어뜨려서
 * 실수로 커밋되거나 GCS 동기화에 쓸려 올라가지 않게 한다.
 */
export function naverSessionRoot(): string {
  const override = process.env.NAVER_SESSION_DIR?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".stepd", "naver");
}

/**
 * 계정별 세션 파일 경로.
 *
 * `accountKey` 는 **불투명 키**다 — 네이버 아이디를 쓰지 않는다. 파일 경로·로그에
 * 고객사 계정 아이디가 박히면 안 된다.
 *
 * accountKey 를 안 주면 단일 계정 시절의 레거시 경로를 쓴다(하위호환).
 */
export function naverSessionPath(accountKey?: string): string {
  const legacy = process.env.NAVER_SESSION_PATH?.trim();
  if (!accountKey) {
    return legacy ? path.resolve(legacy)
      : path.join(os.homedir(), ".stepd", "naver-storage-state.json");
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(accountKey)) {
    throw new Error(`잘못된 accountKey: ${accountKey}`);   // 경로 조작 방지
  }
  return path.join(naverSessionRoot(), accountKey, "storage-state.json");
}

export function saveNaverSession(state: unknown, accountKey?: string): void {
  const p = naverSessionPath(accountKey);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state), "utf-8");
  // POSIX 에서만 의미 있다. Windows 는 무시되지만 실패해도 무해.
  try { fs.chmodSync(p, 0o600); } catch { /* Windows */ }
}

/** 저장된 세션. 없으면 null — 호출부는 "로그인 필요" 로 처리하고 업로드를 시도하지 말 것. */
export function loadNaverSession(accountKey?: string): unknown | null {
  try {
    const p = naverSessionPath(accountKey);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    // 깨진 세션은 없는 것과 같게 다룬다 — 여기서 던지면 잡이 재시도로 무한 실패한다.
    return null;
  }
}

export function hasNaverSession(accountKey?: string): boolean {
  return loadNaverSession(accountKey) !== null;
}

/** 이 PC 에 세션이 있는 계정 키 목록 — 만료 점검·운영 화면용. */
export function listNaverSessionKeys(): string[] {
  const root = naverSessionRoot();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, "storage-state.json")))
    .map((e) => e.name);
}

/** 세션 나이(일). 만료 임박을 운영자에게 알릴 때 쓴다. 없으면 null. */
export function naverSessionAgeDays(accountKey?: string): number | null {
  try {
    const st = fs.statSync(naverSessionPath(accountKey));
    return (Date.now() - st.mtimeMs) / 86_400_000;
  } catch {
    return null;
  }
}
