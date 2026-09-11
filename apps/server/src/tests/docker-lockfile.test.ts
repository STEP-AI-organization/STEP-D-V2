/**
 * 이미지는 **리포의 lockfile 로** 의존성을 깐다.
 *
 * ## 왜 이 테스트가 있나 (2026-09-11)
 *
 * Dockerfile 이 이랬다:
 *
 *     COPY apps/server/package.json ./
 *     RUN pnpm install --no-frozen-lockfile --ignore-scripts && pnpm rebuild esbuild
 *
 * `pnpm-lock.yaml` 을 **복사조차 안 했다.** apps/server 의존성 16개는 전부 `^` 범위라
 * (정확히 핀된 것 0개) 매 빌드가 그날의 최신으로 새로 풀렸다. CI 는 `--frozen-lockfile` 로
 * 검증하는데 **배포되는 이미지는 그 lockfile 을 안 봤다.**
 *
 * 실측(2026-09-11 · 같은 커밋에서 두 방식을 나란히 설치): 10개 중 **7개가 달랐다.**
 *
 *     hono                 4.12.30 → 4.13.7      (마이너 한 칸)
 *     pg                   8.22.0  → 8.23.0
 *     tsx                  4.23.1  → 4.23.13
 *     nodemailer           9.0.5   → 9.1.1
 *     @google-cloud/storage 7.21.0 → 7.22.0
 *     @hono/node-server    1.19.14 → 1.19.17
 *     @napi-rs/canvas      1.0.7   → 1.0.9
 *
 * 같은 리포가 pnpm **자체**는 이미 못박아 뒀다([[docker-pnpm-pin.test.ts]]) — "빌드가 아니라
 * 복권이다" 라고 적으면서. 그 원칙이 정작 패키지 본체에는 적용이 안 돼 있었다.
 *
 * ## 특히 마지막 검사(워크스페이스 importer)를 지우지 말 것
 *
 * `--frozen-lockfile` 은 lockfile 의 importer 를 **전부** 대조한다. 그래서 나중에 누가
 * `packages/foo/package.json` 을 만들면 lockfile 에 importer 가 하나 늘고, Dockerfile 이
 * 그 package.json 을 안 복사하므로 **빌드가 ERR_PNPM_OUTDATED_LOCKFILE 로 죽는다.**
 * 그 사실을 배포하다가 알면 늦다 — 여기서 미리 빨개진다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";

const SERVER = path.join(import.meta.dirname, "..", "..");
const REPO = path.join(SERVER, "..", "..");

const DOCKERFILES = ["Dockerfile", "Dockerfile.worker"];

/**
 * 주석을 뺀 **실행 줄만** 본다 — 위 설명문에도 `--no-frozen-lockfile` 이 들어 있어서
 * 파일 전체를 훑으면 자기 주석에 걸린다(docker-pnpm-pin.test.ts 가 같은 이유로 그렇게 한다).
 */
function commands(name: string): string {
  return fs.readFileSync(path.join(SERVER, name), "utf8")
    .split(/\r?\n/)
    .filter((ln) => !ln.trimStart().startsWith("#"))
    .join("\n");
}

/** pnpm-lock.yaml 의 `importers:` 아래 최상위 키 = 워크스페이스 패키지 디렉토리. */
function lockfileImporters(): string[] {
  const lines = fs.readFileSync(path.join(REPO, "pnpm-lock.yaml"), "utf8").split(/\r?\n/);
  const start = lines.findIndex((l) => /^importers:/.test(l));
  assert.ok(start >= 0, "pnpm-lock.yaml 에 importers 절이 없다");
  const dirs: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break;                       // 다음 최상위 절
    const m = /^  ([^\s:][^:]*):/.exec(lines[i]);
    if (m) dirs.push(m[1].trim());
  }
  assert.ok(dirs.length > 0, "importers 를 하나도 못 읽었다");
  return dirs;
}

describe("이미지가 lockfile 로 깐다", () => {
  it("--no-frozen-lockfile 을 쓰지 않는다", () => {
    for (const name of DOCKERFILES) {
      assert.doesNotMatch(
        commands(name),
        /--no-frozen-lockfile/,
        `${name} 가 --no-frozen-lockfile 로 깐다 — 그날 npm 에 올라온 버전이 배포된다`,
      );
    }
  });

  it("pnpm install 이 --frozen-lockfile 을 쓴다", () => {
    for (const name of DOCKERFILES) {
      const install = commands(name).split("\n").find((l) => l.includes("pnpm install"));
      assert.ok(install, `${name} 에 pnpm install 줄이 없다`);
      assert.match(
        install, /--frozen-lockfile/,
        `${name} 의 pnpm install 이 --frozen-lockfile 을 안 쓴다: ${install.trim()}`,
      );
    }
  });

  it("lockfile 을 이미지로 복사한다", () => {
    for (const name of DOCKERFILES) {
      assert.match(
        commands(name), /COPY[^\n]*pnpm-lock\.yaml/,
        `${name} 가 pnpm-lock.yaml 을 복사하지 않는다 — 복사 안 하면 --frozen-lockfile 이 못 쓴다`,
      );
    }
  });

  it("node_modules 는 두 곳을 **같이** 가져온다", () => {
    // pnpm 워크스페이스는 실물을 /app/node_modules/.pnpm 에 두고 앱 폴더엔 상대 심링크만
    // 남긴다. 한 줄만 있으면 빌드는 통과하고 **런타임에** MODULE_NOT_FOUND 로 죽는다.
    for (const name of DOCKERFILES) {
      const cmds = commands(name);
      assert.match(
        cmds, /COPY --from=deps \/app\/node_modules \/app\/node_modules/,
        `${name} 가 /app/node_modules(.pnpm 실물)를 안 가져온다 — 심링크가 전부 깨진다`,
      );
      assert.match(
        cmds, /COPY --from=deps \/app\/apps\/server\/node_modules \/app\/apps\/server\/node_modules/,
        `${name} 가 앱 폴더 node_modules(심링크)를 안 가져온다`,
      );
    }
  });

  it("lockfile 의 워크스페이스 package.json 을 빠짐없이 복사한다", () => {
    const importers = lockfileImporters();
    for (const name of DOCKERFILES) {
      const cmds = commands(name);
      for (const dir of importers) {
        const expected = dir === "." ? "package.json" : `${dir}/package.json`;
        assert.ok(
          cmds.includes(`COPY ${expected}`) || cmds.includes(`COPY pnpm-lock.yaml pnpm-workspace.yaml ${expected}`),
          `${name} 가 \`${expected}\` 을 안 복사한다.\n` +
            `  --frozen-lockfile 은 lockfile importer 를 전부 대조하므로 하나만 빠져도\n` +
            `  ERR_PNPM_OUTDATED_LOCKFILE 로 **빌드가 죽는다**. 워크스페이스에 패키지를\n` +
            `  추가했다면 Dockerfile 두 개에 COPY 줄도 같이 넣을 것.\n` +
            `  현재 importer: ${importers.join(", ")}`,
        );
      }
    }
  });
});
