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
 * **라우트가 살 수 있는 파일들** — `index.ts` + 도메인별 `<도메인>/routes.ts`.
 *
 * 2026-09-14 신설. 라우트 283개가 `index.ts` 한 파일에 있던 것을 도메인 폴더로 쪼개는 중인데,
 * 소스 스캔 테스트 **50개 파일 · 59곳**이 `index.ts` 를 직접 읽는다. 옮기는 순간 그것들이
 * **0건을 스캔하고 조용히 초록**이 된다 — 이 파일 맨 위 주석이 말하는 바로 그 실패 모드가
 * 훨씬 큰 규모로 재현되는 것이다.
 *
 * 그래서 라우트를 옮기기 **전에** 총개수를 세는 검사(`docs-drift`)를 이 목록으로 돌려 둔다.
 * 스캔이 따라오지 않은 채 라우트가 옮겨지면 개수가 떨어져 거기서 빨개진다 — 트립와이어 하나로
 * 전 범위를 덮는다. 나머지 58곳은 도메인을 실제로 옮길 때 그 도메인 것만 바꾸면 된다.
 */
export function routeFiles(src: string): string[] {
  return ["index.ts", ...sourceFiles(src).filter((f) => f.endsWith("/routes.ts"))];
}

/** 위 파일들을 이어 붙인 소스. 경로 문자열 grep·라우트 수 세기에 쓴다. */
export function routeSource(src: string): string {
  return routeFiles(src)
    .map((f) => fs.readFileSync(path.join(src, f), "utf-8"))
    .join("\n");
}

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
