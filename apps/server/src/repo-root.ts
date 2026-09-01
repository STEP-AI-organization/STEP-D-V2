/**
 * 리포 루트 — **한 곳에서만 계산한다.**
 *
 * 왜 모았나 (실측 2026-09-01): 소스를 도메인 폴더로 나눴더니, 자기 파일 위치에서 `../../..`
 * 로 루트를 잡던 자리들이 **한 단계씩 어긋났다.** 그런데 타입체크도 테스트도 초록이었다 —
 * 그 경로는 실행할 때만 쓰이기 때문이다:
 *   · overlay-canvas 폰트 경로  → 폰트를 못 찾아 **조용히 폴백**(글꼴만 다른 결과물)
 *   · shorts-template 프레임    → 템플릿 없음으로 처리
 *   · content-pipeline REPO_ROOT → **core/ 파이썬을 못 찾아 분석 전체가 실패**
 *
 * 파일마다 깊이를 세는 한 이 사고는 폴더를 옮길 때마다 되돌아온다. 그래서 깊이를 아는 파일은
 * **이 파일 하나**이고, 나머지는 여기서 받아 쓴다. 이 파일이 옮겨지면 아래 상수 하나만 고친다
 * (그리고 tests/repo-root.test.ts 가 즉시 빨간불을 켠다).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

/** `<repo>` — 이 파일은 `<repo>/apps/server/src/` 에 있다. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** `<repo>/assets/…` — 폰트·프레임 템플릿 등 빌드에 함께 실리는 자산. */
export function assetPath(...segments: string[]): string {
  return path.join(REPO_ROOT, "assets", ...segments);
}
