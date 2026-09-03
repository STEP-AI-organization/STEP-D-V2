/**
 * **커밋 안 된 파일을 import 하고 있지 않은가** — 이번 사고를 자동으로 잡는 자리.
 *
 * ## 무슨 일이 있었나 (2026-09-03)
 *
 * `index.ts` 가 `./chatbot/agent.ts` 를 import 하도록 **커밋돼 푸시됐는데**, `src/chatbot/` 은
 * 커밋이 안 돼 있었다. 그런데도 **모든 관문이 초록이었다**:
 *   · `tsc --noEmit` 초록 — 워킹트리에 파일이 있으니까
 *   · `node --test` 초록 — 같은 이유
 *   · Cloud Run 배포 성공 — `gcloud builds submit` 은 **워킹트리**를 올린다
 *
 * 깨진 건 **git 에서 받아 도는 곳**뿐이었다 — 윈도우2 렌더 서버가 부팅에 실패했고,
 * 렌더 워커는 살아서 잡을 계속 집어 `fetch failed` 로 16건을 태웠다. 원인을 찾는 데
 * 프로덕션 로그·DB·SSH 를 다 뒤져야 했다.
 *
 * ## 그래서 이 테스트가 보는 것
 *
 * **워킹트리가 아니라 git 이 아는 것**을 본다. 커밋된 소스가 import 하는 상대 경로 파일이
 * 전부 `git ls-files` 에 있는지 확인한다. 사람이 "커밋했나?" 를 기억할 필요가 없어진다.
 *
 * ⚠️ 이 테스트는 **아직 커밋 안 한 새 파일을 만드는 중**에는 정상적으로 빨갛다.
 *    그게 의도다 — `git add` 하면 초록이 된다(커밋 전 staged 도 `ls-files` 에 잡힌다).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(SRC, "../../..");

/** git 이 아는 파일 전부 (커밋된 것 + staged). 워킹트리의 untracked 는 여기 없다. */
function trackedFiles(): Set<string> | null {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
    return new Set(out.toString("utf-8").split("\0").filter(Boolean).map((p) => p.replace(/\\/g, "/")));
  } catch {
    return null;   // git 이 없는 환경(배포 이미지 안 등) — 이 검사는 건너뛴다
  }
}

/** 검사 대상: 서버·워커가 **실행 시 실제로 읽는** 소스. 테스트 자신은 뺀다. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "tests" || e.name === "node_modules" || e.name === "data") continue;
      sourceFiles(p, out);
      continue;
    }
    if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const RELATIVE_IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s+["'](\.[^"']+)["']/g;

describe("커밋 안 된 파일을 import 하지 않는다", () => {
  const tracked = trackedFiles();

  it("git 이 아는 파일 목록을 읽을 수 있다", () => {
    // 못 읽으면 아래 검사가 조용히 통과한다 — 그건 검사가 없는 것과 같다.
    assert.ok(tracked === null || tracked.size > 100, "git ls-files 결과가 비정상이다");
  });

  it("**서버 소스가 import 하는 상대 경로 파일이 전부 git 에 있다**", () => {
    if (!tracked) return;   // git 없는 환경
    const missing: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = path.relative(REPO, file).replace(/\\/g, "/");
      // 이 파일 자체가 아직 git 에 없으면 그 import 는 볼 필요가 없다(작업 중인 새 파일).
      if (!tracked.has(rel)) continue;
      const text = fs.readFileSync(file, "utf-8");
      for (const m of text.matchAll(RELATIVE_IMPORT)) {
        const spec = m[1];
        const resolved = path.resolve(path.dirname(file), spec);
        const relTarget = path.relative(REPO, resolved).replace(/\\/g, "/");
        // 확장자가 붙은 경로만 본다(이 리포는 `.ts` 를 명시한다). 디렉터리 import 는 건너뛴다.
        if (!/\.tsx?$/.test(relTarget)) continue;
        if (!tracked.has(relTarget)) missing.push(`${rel} → ${spec}`);
      }
    }
    assert.deepEqual(missing, [],
      "커밋된 파일이 **git 에 없는 파일**을 import 한다 — 배포는 되는데(워킹트리 업로드) "
      + "git 에서 받아 도는 곳(윈도우2 워커·새 클론)은 부팅에 실패한다:\n" + missing.join("\n"));
  });

  it("**런타임에 읽는 자료 폴더**도 git 에 있다 — 코드만 있으면 조용히 빈손이 된다", () => {
    if (!tracked) return;
    // docs/help 는 도우미의 지식 **본체**다. 없으면 에러 없이 일반론으로 답한다 —
    // 제일 알아채기 어려운 실패다(Dockerfile 의 COPY 가 빠졌을 때와 같은 증상).
    const hasHelp = [...tracked].some((p) => p.startsWith("docs/help/") && p.endsWith(".md"));
    assert.ok(hasHelp, "docs/help/*.md 가 git 에 없다 — 도우미가 제품을 모른 채 답한다");
  });
});
