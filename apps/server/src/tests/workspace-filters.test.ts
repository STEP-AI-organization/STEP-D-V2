/**
 * `pnpm --filter <이름>` 의 대상이 **실재하는 워크스페이스 패키지**여야 한다.
 *
 * ## 왜 이 테스트가 있나 (2026-09-11 · CI 가 나흘간 거짓 초록)
 *
 * `ci.yml` 에 `pnpm --filter @stepd/native test` 라고 적혀 있었다. 그런 패키지는 없다 —
 * `native/package.json` 의 이름은 **`stepaistudio`** 다. 그런데 pnpm 은 이럴 때
 *
 *     No projects matched the filters in "…"
 *
 * 을 찍고 **exit 0** 으로 끝난다. 그래서 "네이티브 테스트" 단계는 아무것도 안 돌린 채
 * 초록이었고, 2026-09-07 CI 신설부터 09-11 까지 네이티브 테스트가 한 번도 안 돌았다.
 *
 * 이 리포가 제일 자주 당하는 실패 모드([[outputs-dont-reach-consumers]])의 CI 판이다 —
 * **관문은 있는데 관문을 안 지난다.** 그리고 빨강이 아니라 초록이라 아무도 모른다.
 *
 * ## 방어가 두 겹인 이유
 *
 * 1. `ci.yml` 은 `--fail-if-no-match` 를 단다 → pnpm 이 직접 exit 1 을 낸다.
 * 2. 이 테스트는 이름을 **미리** 검증한다.
 *
 * 왜 둘 다인가: **서버 테스트 필터 자체에 오타가 나면 이 테스트가 안 돈다.** 테스트가
 * 안 도니 오타를 못 잡고, 그래서 또 조용한 초록이다. 그 한 경우를 막는 게 ① 이고,
 * ① 이 실수로 지워지는 걸 막는 게 ② 의 마지막 검사다. 순환을 끊으려면 두 겹이어야 한다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";

const SERVER = path.join(import.meta.dirname, "..", "..");
const REPO = path.join(SERVER, "..", "..");

/**
 * `pnpm-workspace.yaml` 의 `packages:` 목록 → 실제 패키지 이름 집합.
 *
 * YAML 파서를 들이지 않는다. 이 파일의 목록은 `  - apps/web` 꼴 한 줄짜리뿐이고,
 * 의존성 하나를 테스트 때문에 늘리는 건 이 테스트가 지키려는 것과 반대다.
 */
function workspacePackageNames(): Map<string, string> {
  const yaml = fs.readFileSync(path.join(REPO, "pnpm-workspace.yaml"), "utf8");
  const globs: string[] = [];
  let inPackages = false;
  for (const raw of yaml.split(/\r?\n/)) {
    if (/^packages:/.test(raw)) { inPackages = true; continue; }
    // 다음 최상위 키(`onlyBuiltDependencies:` 등)를 만나면 목록 끝.
    if (inPackages && /^\S/.test(raw)) break;
    const m = /^\s+-\s+(\S+)/.exec(raw);
    if (inPackages && m) globs.push(m[1]);
  }
  assert.ok(globs.length > 0, "pnpm-workspace.yaml 에서 packages 목록을 못 읽었다");

  const dirs: string[] = [];
  for (const glob of globs) {
    if (!glob.includes("*")) { dirs.push(glob); continue; }
    const parent = glob.replace(/\/\*+$/, "");
    const abs = path.join(REPO, parent);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(`${parent}/${entry.name}`);
    }
  }

  const names = new Map<string, string>();
  for (const dir of dirs) {
    const pkgPath = path.join(REPO, dir, "package.json");
    if (!fs.existsSync(pkgPath)) continue;
    const name = JSON.parse(fs.readFileSync(pkgPath, "utf8")).name;
    if (typeof name === "string") names.set(name, dir);
  }
  return names;
}

/** `--filter <값>` 을 전부 뽑는다. 파일별로 어느 줄인지도 같이 — 오류 메시지에 쓴다. */
function filterTargets(text: string): { target: string; line: string }[] {
  const out: { target: string; line: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith("#")) continue;      // YAML 주석
    for (const m of line.matchAll(/--filter[= ]+(\S+)/g)) {
      out.push({ target: m[1].replace(/^["']|["',]+$/g, ""), line: line.trim() });
    }
  }
  return out;
}

/**
 * 이름이 아닌 필터는 검사 대상이 아니다:
 *   `./apps/web`(경로) · `@stepd/*`(글롭) · `...[origin/main]`(변경분) · `!@stepd/web`(제외)
 * 앞뒤 `...` 는 의존관계 확장이라 떼고 이름만 본다(`@stepd/server...`).
 */
function nameOf(target: string): string | null {
  const bare = target.replace(/^\.{3}/, "").replace(/\.{3}$/, "");
  if (!bare || bare.startsWith(".") || bare.startsWith("!")) return null;
  if (bare.includes("*") || bare.includes("[") || bare.includes("/")) {
    // `@scope/name` 은 `/` 를 갖지만 경로가 아니다 — 스코프 패키지만 통과시킨다.
    if (!/^@[^/]+\/[^/]+$/.test(bare)) return null;
  }
  return bare;
}

const SOURCES: { label: string; file: string }[] = [
  { label: "ci.yml", file: path.join(REPO, ".github", "workflows", "ci.yml") },
  { label: "루트 package.json", file: path.join(REPO, "package.json") },
];

describe("pnpm --filter 대상이 실재한다", () => {
  it("ci.yml · 루트 package.json 의 모든 --filter 가 워크스페이스 패키지를 가리킨다", () => {
    const known = workspacePackageNames();
    for (const { label, file } of SOURCES) {
      for (const { target, line } of filterTargets(fs.readFileSync(file, "utf8"))) {
        const name = nameOf(target);
        if (name === null) continue;
        assert.ok(
          known.has(name),
          `${label} 가 \`--filter ${target}\` 를 쓰는데 그런 패키지가 없다.\n` +
            `  줄: ${line}\n` +
            `  있는 이름: ${[...known.keys()].sort().join(", ")}\n` +
            `  ⚠️ pnpm 은 안 맞는 필터를 exit 0 으로 넘긴다 — 고치지 않으면 이 단계는 조용히 안 돈다.`,
        );
      }
    }
  });

  it("ci.yml 의 --filter 단계는 --fail-if-no-match 를 단다", () => {
    const text = fs.readFileSync(SOURCES[0].file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || !trimmed.includes("--filter")) continue;
      assert.match(
        trimmed,
        /--fail-if-no-match/,
        `ci.yml 의 이 줄에 --fail-if-no-match 가 없다 — 필터가 빗나가도 초록이 된다:\n  ${trimmed}`,
      );
    }
  });
});
