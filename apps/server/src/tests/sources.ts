/**
 * 소스 스캔 테스트가 쓰는 **파일 목록** — `src/` 아래를 재귀로 훑는다.
 *
 * 왜 필요한가 (실측 2026-09-01): 소스를 도메인 폴더(`naver/`·`billing/`…)로 나누자
 * `readdirSync(SRC)` 로 최상위만 훑던 검사들이 **옮겨진 파일을 조용히 건너뛰었다.**
 * 테스트는 그대로 초록인데 검사 범위만 줄어든 것이다 — 이 리포에서 제일 위험한 실패 모드다
 * (테스트 수가 1264 → 1258 로 준 게 유일한 단서였다).
 *
 * 그래서 목록을 한 곳에서 만든다. 폴더를 또 나눠도 검사 범위는 따라온다.
 */
import fs from "node:fs";
import path from "node:path";

/** 스캔에서 빼는 하위 폴더 — 테스트 자신과 데이터 파일. */
const SKIP_DIRS = new Set(["tests", "data", "node_modules"]);

/**
 * `src/` 아래 모든 소스 파일을 **SRC 기준 상대 경로**로 돌려준다(`naver/naver-tv.ts` 꼴).
 * 상대 경로라 기존 호출부의 `path.join(SRC, f)` · `read(f)` 가 그대로 산다.
 */
export function sourceFiles(src: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      out.push(prefix ? `${prefix}/${entry.name}` : entry.name);
    }
  };
  walk(src, "");
  return out.sort();
}
