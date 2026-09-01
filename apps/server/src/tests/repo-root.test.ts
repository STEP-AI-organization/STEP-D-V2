/**
 * **런타임 경로**가 실제로 존재하는지 — 정적 검사가 못 잡는 자리다.
 *
 * 실측 2026-09-01: 소스를 도메인 폴더로 나누자 `../../..` 로 리포 루트를 잡던 코드가 한 단계씩
 * 어긋났다. tsc 도 테스트도 초록이었다 — 그 경로는 **실행할 때만** 쓰이기 때문이다. 증상은
 * 조용했다: 폰트를 못 찾아 글꼴만 바뀐 결과물이 나가고, core/ 를 못 찾아 분석이 실패한다.
 *
 * 그래서 "깊이"를 세는 곳을 repo-root.ts 하나로 모으고, 그 하나가 맞는지를 여기서 고정한다.
 * 파일이 옮겨지면 이 테스트가 **즉시** 빨간불을 켠다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { REPO_ROOT, assetPath } from "../repo-root.ts";

describe("리포 루트 — 실행 시 쓰는 경로가 실제로 있다", () => {
  it("REPO_ROOT 는 진짜 리포 루트다 (워크스페이스 파일이 거기 있다)", () => {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, "pnpm-workspace.yaml")),
      `REPO_ROOT 가 리포 루트가 아니다: ${REPO_ROOT}`);
    assert.ok(fs.existsSync(path.join(REPO_ROOT, "apps", "server", "package.json")));
  });

  it("core/ 를 가리킨다 — 여기가 어긋나면 **분석이 통째로 실패**한다", () => {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, "core")),
      "content-pipeline 이 python -m core.analyze 를 여기서 스폰한다");
  });

  it("자산 폴더가 있다 — 폰트가 없으면 글꼴만 다른 결과물이 조용히 나간다", () => {
    for (const dir of ["fonts", "invoice-fonts", "shorts-template"]) {
      assert.ok(fs.existsSync(assetPath(dir)), `assets/${dir} 를 못 찾는다: ${assetPath(dir)}`);
    }
  });

  it("실제 폰트 파일까지 확인 — 폴더만 있고 비면 같은 증상이다", () => {
    assert.ok(fs.existsSync(assetPath("invoice-fonts", "GmarketSansTTFBold.ttf")));
    assert.ok(fs.existsSync(assetPath("fonts", "Pretendard-ExtraBold.otf")));
  });

  it("깊이를 세는 코드는 repo-root.ts **하나**뿐이다", () => {
    // 다른 파일이 다시 `../../..` 로 루트를 잡기 시작하면 같은 사고가 되돌아온다.
    const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
          if (e.name === "tests" || e.name === "data" || e.name === "node_modules") continue;
          walk(path.join(dir, e.name));
          continue;
        }
        if (!e.name.endsWith(".ts") || e.name === "repo-root.ts") continue;
        const p = path.join(dir, e.name);
        const src = fs.readFileSync(p, "utf-8");
        // 주석은 뺀다 — 이 사고를 설명한 줄까지 위반으로 잡히면 설명을 못 쓴다.
        for (const line of src.split(/\r?\n/)) {
          if (/^\s*(\*|\/\/)/.test(line)) continue;
          if (/fileURLToPath\(import\.meta\.url\)[\s\S]{0,40}\.\.\/\.\.\//.test(line)) {
            offenders.push(`${path.relative(SRC, p)}: ${line.trim().slice(0, 70)}`);
          }
        }
      }
    };
    walk(SRC);
    assert.deepEqual(offenders, [],
      `리포 루트를 스스로 계산하는 파일이 있다 — repo-root.ts 를 쓸 것:\n${offenders.join("\n")}`);
  });
});
