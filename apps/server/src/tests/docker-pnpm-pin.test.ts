/**
 * 이미지의 pnpm 버전이 **리포가 선언한 것과 같아야 한다.**
 *
 * ## 왜 이 테스트가 있나 (2026-09-07 배포 전면 중단)
 *
 * Dockerfile 이 `npm install -g pnpm@latest` 였다. 리포는 `packageManager: pnpm@10.x` 를
 * 선언하는데 이미지는 **그날 npm 에 올라와 있는 것**을 깔았다는 뜻이다. pnpm 12 가 나오자
 * 빌드 스크립트 정책이 바뀌어(`ERR_PNPM_IGNORED_BUILDS`) `pnpm rebuild esbuild` 가 거절당했고,
 * 우리가 아무것도 안 바꾼 커밋에서 **서버·워커 배포가 통째로 실패**했다.
 *
 * 부동 버전은 빌드가 아니라 복권이다. 두 값을 묶어 두면 올릴 때 같이 올리게 된다.
 *
 * ⚠️ 올릴 때는 `package.json` 의 `packageManager` 와 Dockerfile 두 개를 **함께** 고칠 것.
 *    pnpm 12+ 로 갈 거면 `onlyBuiltDependencies` 승인 목록도 같이 넣어야 한다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";

const SERVER = path.join(import.meta.dirname, "..", "..");
const REPO = path.join(SERVER, "..", "..");

const DOCKERFILES = ["Dockerfile", "Dockerfile.worker"];

/** `packageManager: "pnpm@10.33.2"` → `10.33.2` */
function declaredPnpm(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")) as {
    packageManager?: string;
  };
  const m = /^pnpm@(\d+\.\d+\.\d+)/.exec(String(pkg.packageManager ?? ""));
  assert.ok(m, `루트 package.json 의 packageManager 가 pnpm@x.y.z 꼴이 아니다: ${pkg.packageManager}`);
  return m[1];
}

/**
 * 주석을 뺀 **실행 줄만** 본다. 이 테스트의 설명문에도 문제의 문자열이 들어 있어서,
 * 파일 전체를 검사하면 자기 주석에 걸린다(실제로 처음에 그렇게 걸렸다).
 */
function commands(name: string): string {
  return fs.readFileSync(path.join(SERVER, name), "utf8")
    .split(/\r?\n/)
    .filter((ln) => !ln.trimStart().startsWith("#"))
    .join("\n");
}

describe("이미지 pnpm 버전 고정", () => {
  it("Dockerfile 이 pnpm@latest 를 쓰지 않는다", () => {
    for (const name of DOCKERFILES) {
      assert.doesNotMatch(
        commands(name),
        /pnpm@latest/,
        `${name} 가 pnpm@latest 를 깐다 — 오늘 npm 에 올라온 것에 따라 빌드가 깨진다`,
      );
    }
  });

  it("Dockerfile 의 pnpm 버전이 package.json 선언과 같다", () => {
    const want = declaredPnpm();
    for (const name of DOCKERFILES) {
      const got = /npm install -g pnpm@(\d+\.\d+\.\d+)/.exec(commands(name))?.[1];
      assert.equal(
        got, want,
        `${name} 는 pnpm@${got} 를 까는데 리포는 ${want} 를 선언한다 — 둘을 같이 올릴 것`,
      );
    }
  });
});
